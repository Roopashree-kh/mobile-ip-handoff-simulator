"""Mobile Node with permanent home address 10.1.0.50 (RFC 3344 sections 2.4 and 3.6).

State machine shown on the dashboard:
  AT_HOME -> DISCOVERING -> REGISTERING -> REGISTERED_AWAY -> RENEWING -> REGISTERED_AWAY ...
                  ^                                 |
                  +------ link change --------------+-> DEREGISTERING -> AT_HOME

Movement detection (RFC 3344 section 2.4.2), selectable:
  lifetime  the current agent's advertisement Lifetime runs out, then switch to another agent
  prefix    an advertisement arrives whose network prefix differs from the current CoA prefix

A "handoff" here is the MN associating with another link through the core router (ATTACH).
The MN then solicits, detects the move at layer 3, and registers. Detection time, registration
time and packets lost are measured for every handoff and sent to the dashboard.
"""
import argparse
import ipaddress
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mip import auth, encap, ipv4, link  # noqa: E402
from mip import config as cfgmod  # noqa: E402
from mip import messages as m  # noqa: E402
from mip.node import Node  # noqa: E402

AT_HOME, DISCOVERING, REGISTERING, REGISTERED_AWAY, RENEWING, DEREGISTERING = (
    "AT_HOME", "DISCOVERING", "REGISTERING", "REGISTERED_AWAY", "RENEWING", "DEREGISTERING")


class MobileNode(Node):
    def __init__(self, topo):
        super().__init__("MN", topo)
        self.home = self.ncfg["home_address"]
        self.ha = self.ncfg["home_agent"]
        self.home_link = topo.link_of_ip(self.home)
        self.home_net = ipaddress.ip_network(topo.links[self.home_link]["prefix"])
        self.my_port = self.ncfg["reg_port"]
        self.mh_sa = (topo.security["mn_ha"]["spi"], bytes.fromhex(topo.security["mn_ha"]["key"]))
        self.cn = topo.node("CN")
        self.idgen = auth.MobileIdent(self.features.get("replay_protection", "timestamp"), self.ncfg.get("clock_skew_s", 0))
        self.link = None
        self.state = AT_HOME
        self.agents = {}
        self.current = None
        self.reg = None
        self.binding = None
        self.prev_fa = None
        self.renew_timer = None
        self.handoff = None
        self.handoff_seq = 0
        self.last_handoff = None
        self.encap_override = None
        self.reverse_override = None
        self.lifetime_override = None
        self.last_solicit = 0
        self.last_request = None
        self.demo = None
        self.reset_stats()

    def reset_stats(self):
        self.rx = set()
        self.max_seq = -1
        self.stats = {"rx": 0, "dup": 0, "lost_total": 0, "replies_sent": 0, "last_latency_ms": None}
        self.pings = {}

    # ---- lifecycle -------------------------------------------------------------------
    def start(self):
        self.attach(self.ncfg["initial_link"], initial=True)
        self.every(lambda: 0.1, self.lifetime_check)

    def attach(self, link_name, initial=False):
        """Associate with a link: the physical part of a handoff."""
        if link_name not in self.topo.links:
            return
        prev = self.link
        self.link = link_name
        self.send_raw(link.ATTACH, link_name.encode())
        self.cancel_reg()
        if initial and link_name == self.home_link:
            self.state = AT_HOME
            self.send_arp(m.gratuitous_arp(self.mac, self.home))
            return
        self.close_handoff_loss()
        self.handoff_seq += 1
        self.handoff = {"id": self.handoff_seq, "from": prev, "to": link_name, "t_attach": self.now(),
                        "t_detect": None, "algorithm": None, "t_reg_first": None, "seq_before": self.max_seq,
                        "attempts": 0, "smooth": bool(self.features.get("smooth_handoff")),
                        "encap": self.features.get("encapsulation")}
        self.state = DISCOVERING
        self.tel.emit("handoff_start", "MN moves from %s to %s" % (self.label(prev), self.label(link_name)),
                      id=self.handoff_seq, from_link=prev, to_link=link_name,
                      rfc="RFC 3344 section 2.4",
                      learn="The mobile node has associated with a new link. It sends an Agent Solicitation at "
                            "once rather than wait up to one advertisement interval.")
        self.solicit()

    def label(self, ln):
        return self.topo.links[ln]["label"] if ln in self.topo.links else "nowhere"

    def solicit(self):
        self.last_solicit = self.now()
        self.send_broadcast(ipv4.build_ipv4(self.home, ipv4.BROADCAST, ipv4.PROTO_ICMP, m.build_solicitation(), ttl=1))

    def at_home_link(self):
        return self.link == self.home_link

    # ---- agent discovery and movement detection -------------------------------------------
    def on_frame(self, kind, src_id, payload):
        if kind == link.L2_NAK:
            return
        try:
            h, body = ipv4.parse_ipv4(payload)
        except ipv4.PacketError:
            return
        if not h.checksum_ok:
            return
        if h.proto == ipv4.PROTO_ICMP:
            return self.on_icmp(kind, src_id, h, body)
        if encap.is_tunnel(h.proto) and self.binding and h.dst == self.binding.get("coa") and self.binding.get("ccoa"):
            try:
                _, inner, _ = encap.decapsulate(payload)
            except (encap.TunnelError, ipv4.PacketError):
                return
            return self.on_frame(link.ROUTED, src_id, inner)
        if h.proto == ipv4.PROTO_UDP:
            try:
                sport, dport, data, ok = ipv4.parse_udp(body, h.src, h.dst)
            except ipv4.PacketError:
                return
            if dport == self.my_port:
                return self.on_reply(h, data)
            if dport == self.cn["mn_port"] and h.dst == self.home:
                return self.on_stream(h, sport, data, payload)

    def on_icmp(self, kind, src_id, h, body):
        t, code, rest, ok = ipv4.parse_icmp(body)
        if not ok:
            return
        if t == ipv4.ICMP_ROUTER_ADV and kind == link.LINK_BROADCAST:
            try:
                adv = m.AgentAdvertisement.unpack(body)
            except m.MalformedMessage:
                return
            return self.on_advertisement(src_id, h.src, adv)
        if t == ipv4.ICMP_ECHO_REPLY and len(rest) >= 4:
            ident, seq = struct.unpack("!HH", rest[:4])
            sent = self.pings.pop(seq, None)
            if sent is not None:
                self.tel.emit("ping", "reply from %s seq=%d time=%.1f ms" % (h.src, seq, (self.now() - sent) * 1000),
                              seq=seq, rtt_ms=round((self.now() - sent) * 1000, 2))
        elif t == ipv4.ICMP_ECHO and h.dst == self.home:
            ident, seq = struct.unpack("!HH", rest[:4])
            self.send_out(ipv4.build_echo(self.home, h.src, ident, seq, rest[4:], reply=True))

    def on_advertisement(self, src_id, src_ip, adv):
        plen = adv.prefix_lengths[0] if adv.prefix_lengths else 24
        net = str(ipaddress.ip_network("%s/%d" % (adv.router_addrs[0][0] if adv.router_addrs else src_ip, plen),
                                       strict=False))
        now = self.now()
        a = self.agents.get(src_ip)
        is_home = bool(adv.flags & m.AD_H) and ipaddress.ip_address(self.home) in ipaddress.ip_network(net)
        if a and m.agent_rebooted(a["seq"], adv.seq):
            self.tel.emit("discovery", "agent %s sequence went %d -> %d: it rebooted" % (src_ip, a["seq"], adv.seq),
                          rfc="RFC 3344 section 2.4.2",
                          learn="A sequence number below 256 after a higher one means the agent restarted and has "
                                "lost its visitor list, so the mobile node must register again.")
            if self.current == src_ip and self.state in (REGISTERED_AWAY, RENEWING) and not is_home:
                a.update(seq=adv.seq)
                self.register(a, reason="agent reboot")
        elif a and a["seq"] == 0xFFFF and adv.seq == 256:
            self.tel.emit("discovery", "agent %s sequence rolled over 0xffff -> 256 (normal)" % src_ip,
                          rfc="RFC 3344 section 2.3.1")
        a = self.agents.setdefault(src_ip, {})
        a.update(ip=src_ip, node_id=src_id, node=self.topo.node_name(src_id), flags=adv.flags, coas=adv.coas,
                 prefix=net, lifetime=adv.lifetime, last=now, expires=now + adv.lifetime, seq=adv.seq,
                 reg_lifetime=adv.reg_lifetime, is_home=is_home)
        self.evaluate(a)

    def evaluate(self, a):
        algo = self.features.get("movement_detection", "prefix")
        cur = self.agents.get(self.current) if self.current else None
        if cur and cur["expires"] < self.now():
            cur = None
        if a["is_home"]:
            if self.state in (AT_HOME, DEREGISTERING):
                self.current = a["ip"]
                if self.state == AT_HOME and self.handoff and self.handoff["to"] == self.home_link \
                        and self.handoff["t_detect"] is None:
                    self.finish_handoff()
                return
            if cur is None or (algo == "prefix" and cur["prefix"] != a["prefix"]):
                return self.moved(a, "lifetime" if cur is None and algo == "lifetime" else algo)
            return
        if cur is None:
            if self.state == DISCOVERING or self.state == AT_HOME or self.current is None:
                return self.moved(a, "lifetime" if algo == "lifetime" and self.current else "first advertisement")
            return
        if a["ip"] == cur["ip"]:
            if self.state == DISCOVERING and self.binding and self.binding["agent"] == a["ip"]:
                # we re-associated with the same cell: nothing to register
                self.state = REGISTERED_AWAY
                self.tel.emit("movement", "same agent %s heard again, no movement" % a["ip"])
                self.handoff = None
            return
        if algo == "prefix" and cur["prefix"] != a["prefix"]:
            return self.moved(a, "prefix")

    def lifetime_check(self):
        """Lifetime-based detection: the current agent's advertisement Lifetime has run out."""
        if not self.current:
            if self.state == DISCOVERING and self.now() - self.last_solicit > 1.0:
                self.solicit()
            return
        cur = self.agents.get(self.current)
        if cur is None or cur["expires"] >= self.now():
            return
        candidates = [a for a in self.agents.values() if a["ip"] != self.current and a["expires"] > self.now()]
        self.tel.emit("movement", "advertisement lifetime of %s expired" % self.current)
        self.current = None
        if candidates:
            best = max(candidates, key=lambda a: a["last"])
            self.moved(best, "lifetime")
        else:
            if self.state not in (AT_HOME,):
                self.state = DISCOVERING
            self.solicit()

    def moved(self, a, algorithm):
        now = self.now()
        ho = self.handoff
        if ho and ho["t_detect"] is None:
            ho["t_detect"] = now
            ho["algorithm"] = algorithm
            ho["agent"] = a["node"]
            det = (now - ho["t_attach"]) * 1000
            self.tel.emit("movement", "movement detected by %s rule: new agent %s (%s) after %.1f ms" % (
                algorithm, a["node"], a["prefix"], det), id=ho["id"], algorithm=algorithm, detection_ms=round(det, 2),
                rfc="RFC 3344 section 2.4.2.%d" % (1 if algorithm == "lifetime" else 2),
                learn=("Lifetime rule: the mobile node waited until the old agent's advertisement Lifetime ran out. "
                       "It is safe but slow.") if algorithm == "lifetime" else
                      ("Prefix rule: an advertisement with a different network prefix proves the node is on another "
                       "network, so it can register at once."))
        self.current = a["ip"]
        if a["is_home"]:
            self.go_home(a)
        else:
            self.register(a, reason="movement")

    # ---- registration ---------------------------------------------------------------
    def colocated(self):
        return bool(self.features.get("colocated_coa"))

    def ccoa_for(self, a):
        net = ipaddress.ip_network(a["prefix"])
        return str(net.network_address + self.ncfg.get("colocated_host_octet", 100))

    def build_flags(self, a):
        f = 0
        notes = []
        if self.features.get("simultaneous_bindings"):
            f |= m.REQ_S
        mode = self.encap_override or self.features.get("encapsulation", "ipip")
        if mode == "minimal":
            if a["flags"] & m.AD_M or self.colocated():
                f |= m.REQ_M
            else:
                notes.append("agent does not advertise M, using IP-in-IP")
        elif mode == "gre":
            if a["flags"] & m.AD_G or self.colocated():
                f |= m.REQ_G
            else:
                notes.append("agent does not advertise G, using IP-in-IP")
        rev = self.features.get("reverse_tunneling") if self.reverse_override is None else self.reverse_override
        if rev:
            if a["flags"] & m.AD_T or self.colocated():
                f |= m.REQ_T
            else:
                notes.append("agent does not advertise T")
        if self.colocated():
            f |= m.REQ_D
        return f, notes

    def register(self, a, reason="", renewal=False, attempts=0, first_sent=None):
        self.cancel_reg()
        flags, notes = self.build_flags(a)
        want = int(self.lifetime_override or self.ncfg.get("requested_lifetime", 30))
        forced = self.features.get("request_lifetime")
        lifetime = int(forced) if forced else min(want, a["reg_lifetime"])
        ccoa = self.ccoa_for(a) if self.colocated() else None
        coa = ccoa or a["coas"][0]
        ident = self.idgen.next()
        raw = m.append_auth(m.RegistrationRequest(flags, lifetime, self.home, self.ha, coa, ident).pack(),
                            m.EXT_MH_AUTH, *self.mh_sa)
        smooth_from = None
        if (self.features.get("smooth_handoff") and not renewal and not ccoa and self.prev_fa
                and self.prev_fa["ip"] != a["ip"]):
            smooth_from = self.prev_fa
            raw += m.prev_fa_ext(self.topo.mip["smooth_cache_lifetime_s"], self.prev_fa["ip"],
                                 self.prev_fa["coa"]).pack()
        if ccoa:
            self.send_arp(m.gratuitous_arp(self.mac, ccoa))
            dg = ipv4.build_udp_datagram(ccoa, self.ha, self.my_port, self.reg_port(), raw)
            self.send_routed(dg)
            self.last_request = {"dg": dg, "via": None, "ident": ident, "coa": coa}
        else:
            dg = ipv4.build_udp_datagram(self.home, a["ip"], self.my_port, self.reg_port(), raw)
            self.send_link(a["node_id"], dg)
            self.last_request = {"dg": dg, "via": a["node_id"], "ident": ident, "coa": coa}
        now = self.now()
        backoff = min(self.topo.mip["retransmit_initial_ms"] * (2 ** attempts), self.topo.mip["retransmit_max_ms"]) / 1000.0
        self.reg = {"ident": ident, "agent": a["ip"], "coa": coa, "ccoa": bool(ccoa), "lifetime": lifetime,
                    "flags": flags, "sent": now, "first_sent": first_sent or now, "attempts": attempts,
                    "renewal": renewal, "dereg": False, "timer": self.call_later(backoff, self.retransmit),
                    "backoff": backoff}
        if self.handoff and self.handoff["t_reg_first"] is None and not renewal:
            self.handoff["t_reg_first"] = now
        if self.handoff:
            self.handoff["attempts"] = attempts + 1
        self.state = RENEWING if renewal else REGISTERING
        self.tel.emit("registration", "MN sends Registration Request via %s: CoA %s lifetime %d s flags %s%s%s" % (
            "HA directly (co-located CoA)" if ccoa else a["node"], coa, lifetime, m.flag_names(flags, m.REQ_FLAGS),
            " attempt %d" % (attempts + 1) if attempts else "", "; " + "; ".join(notes) if notes else ""),
            reason=reason, coa=coa, attempt=attempts + 1, smooth_from=smooth_from and smooth_from["ip"],
            rfc="RFC 3344 section 3.6.1",
            learn="The Registration Request carries home address, home agent, care-of address, the requested "
                  "lifetime and a 64-bit Identification, protected by the Mobile-Home keyed-MD5 authenticator.")

    def go_home(self, ha_agent):
        """Returned to the home link: reclaim the address with gratuitous ARP, then deregister."""
        self.cancel_reg()
        self.send_arp(m.gratuitous_arp(self.mac, self.home))
        if self.binding is None and self.state == AT_HOME:
            return
        ident = self.idgen.next()
        raw = m.append_auth(m.RegistrationRequest(0, 0, self.home, self.ha, self.home, ident).pack(),
                            m.EXT_MH_AUTH, *self.mh_sa)
        self.send_link(ha_agent["node_id"], ipv4.build_udp_datagram(self.home, self.ha, self.my_port, self.reg_port(), raw))
        now = self.now()
        if self.handoff and self.handoff["t_reg_first"] is None:
            self.handoff["t_reg_first"] = now
        self.reg = {"ident": ident, "agent": ha_agent["ip"], "coa": self.home, "ccoa": False, "lifetime": 0,
                    "flags": 0, "sent": now, "first_sent": now, "attempts": 0, "renewal": False, "dereg": True,
                    "timer": self.call_later(1.0, self.retransmit), "backoff": 1.0}
        self.state = DEREGISTERING
        self.tel.emit("registration", "MN is home: gratuitous ARP for %s, then deregistration (lifetime 0, CoA = home "
                                      "address)" % self.home, rfc="RFC 3344 section 3.6.1.1",
                      learn="On returning home the mobile node takes its address back with a gratuitous ARP and sends "
                            "a Registration Request with lifetime 0 so the home agent stops tunneling.")

    def cancel_reg(self):
        if self.reg and self.reg.get("timer"):
            self.reg["timer"].cancel()
        self.reg = None

    def retransmit(self):
        r = self.reg
        if not r:
            return
        a = self.agents.get(r["agent"])
        if r["attempts"] + 1 >= self.topo.mip["retransmit_max_attempts"] or a is None:
            self.tel.emit("registration", "MN gives up after %d attempts, back to discovery" % (r["attempts"] + 1))
            self.reg = None
            self.state = DISCOVERING
            self.current = None
            self.solicit()
            return
        self.tel.emit("registration", "no reply in %.1f s, retransmitting with a new Identification (backoff x2)" %
                      r["backoff"], rfc="RFC 3344 section 3.6.3")
        if r["dereg"]:
            self.reg = None
            self.state = AT_HOME
            self.binding = None
            return self.go_home(a) if a else None
        self.register(a, reason="retransmission", renewal=r["renewal"], attempts=r["attempts"] + 1,
                      first_sent=r["first_sent"])

    def on_reply(self, h, data):
        try:
            rep = m.RegistrationReply.unpack(data)
        except m.MalformedMessage:
            return
        d = self.demo
        if d and self.idgen.reply_matches(d["ident"], rep.ident) and not (self.reg and self.reg["ident"] == d["ident"]):
            self.demo = None
            d["timer"].cancel()
            expected = {"wrong_key": 131, "replay": 133}[d["kind"]]
            self.tel.emit("demo", "demo %s: HA answered %s%s" % (
                d["kind"], m.code_text(rep.code), "" if rep.code == expected else " (expected %d)" % expected),
                demo=d["kind"], code=rep.code, expected=expected,
                rfc="RFC 3344 section 3.5" if d["kind"] == "wrong_key" else "RFC 3344 section 5.7",
                learn="The home agent recomputed the keyed-MD5 authenticator with the real shared key. It did not "
                      "match, so the request was refused with 131 and the existing binding was left alone."
                      if d["kind"] == "wrong_key" else
                      "The old request still carries a valid authenticator, but its Identification is not newer than "
                      "the last one accepted (or its nonce is stale). The home agent refuses it with 133, so a "
                      "captured request cannot be used again.")
            return
        r = self.reg
        if not r or not self.idgen.reply_matches(r["ident"], rep.ident):
            self.tel.emit("registration", "MN ignores a Registration Reply that matches no pending request")
            return
        mh = m.find_ext(rep.extensions, m.EXT_MH_AUTH)
        if mh is not None and not m.verify_auth(data, mh, self.mh_sa[1]):
            self.tel.emit("registration", "MN ignores a reply with a bad Mobile-Home authenticator")
            return
        if mh is None and rep.code >= 128:
            self.tel.emit("registration", "MN ignores an unauthenticated home agent reply")
            return
        r["timer"].cancel()
        ok = m.accepted(rep.code)
        self.idgen.learn_from_reply(rep.ident, ok)
        now = self.now()
        a = self.agents.get(r["agent"])
        rtt = (now - r["sent"]) * 1000
        if ok:
            self.reg = None
            if r["dereg"]:
                self.state = AT_HOME
                self.binding = None
                self.prev_fa = None
            else:
                self.state = REGISTERED_AWAY
                self.binding = {"coa": r["coa"], "agent": r["agent"], "node": a["node"] if a else "?",
                                "lifetime": rep.lifetime, "granted_at": now, "expires_at": (now + rep.lifetime) * 1000,
                                "ccoa": r["ccoa"], "flags": r["flags"],
                                "encap": encap.mode_from_flags(r["flags"] & m.REQ_M, r["flags"] & m.REQ_G),
                                "reverse": bool(r["flags"] & m.REQ_T)}
                if not r["ccoa"]:
                    self.prev_fa = {"ip": r["agent"], "coa": r["coa"]}
                if self.renew_timer:
                    self.renew_timer.cancel()
                self.renew_timer = self.call_later(max(1.0, rep.lifetime * self.topo.mip["renew_at_fraction"]),
                                                   self.renew)
            self.tel.emit("registration", "MN %s: %s, lifetime %d s (round trip %.1f ms)" % (
                "deregistered" if r["dereg"] else ("renewed" if r["renewal"] else "registered"),
                m.code_text(rep.code), rep.lifetime, rtt), code=rep.code, lifetime=rep.lifetime,
                rfc="RFC 3344 section 3.6.2")
            if not r["renewal"]:
                self.finish_handoff()
            return
        code = rep.code
        self.tel.emit("registration", "MN registration denied: %s" % m.code_text(code), code=code,
                      rfc="RFC 3344 section 3.6.2.1")
        if a is None:
            return
        if code == 133 and r["attempts"] < 3:
            return self.register(a, reason="resynchronised Identification after 133", renewal=r["renewal"],
                                 attempts=r["attempts"] + 1, first_sent=r["first_sent"])
        if code in (72, 139):
            self.encap_override = "ipip"
            return self.register(a, reason="fallback to IP-in-IP after %d" % code, attempts=r["attempts"] + 1,
                                 first_sent=r["first_sent"])
        if code in (74, 137):
            self.reverse_override = False
            return self.register(a, reason="retry without reverse tunneling", attempts=r["attempts"] + 1,
                                 first_sent=r["first_sent"])
        if code == 69 and not self.features.get("request_lifetime"):
            self.lifetime_override = max(1, a["reg_lifetime"] // 2)
            return self.register(a, reason="shorter lifetime after 69", attempts=r["attempts"] + 1,
                                 first_sent=r["first_sent"])
        self.reg = None
        self.state = DISCOVERING
        backoff = min(self.topo.mip["retransmit_initial_ms"] * 2 ** r["attempts"], self.topo.mip["retransmit_max_ms"])
        if r["attempts"] + 1 < self.topo.mip["retransmit_max_attempts"]:
            self.call_later(backoff / 1000.0, self._retry_after_denial, r["agent"], r["attempts"] + 1)

    def _retry_after_denial(self, agent_ip, attempts):
        a = self.agents.get(agent_ip)
        if self.state == DISCOVERING and a and self.current == agent_ip and a["expires"] > self.now():
            self.register(a, reason="retry after denial", attempts=attempts)

    def renew(self):
        if self.state != REGISTERED_AWAY or not self.binding:
            return
        a = self.agents.get(self.binding["agent"])
        if a and a["expires"] > self.now():
            self.register(a, reason="lifetime renewal at %d%%" % int(self.topo.mip["renew_at_fraction"] * 100),
                          renewal=True)

    def finish_handoff(self):
        ho = self.handoff
        if not ho:
            return
        now = self.now()
        det = ((ho["t_detect"] or now) - ho["t_attach"]) * 1000
        reg = (now - (ho["t_reg_first"] or now)) * 1000
        ho["t_done"] = now
        rec = {"id": ho["id"], "from_link": ho["from"], "to_link": ho["to"], "algorithm": ho["algorithm"] or "-",
               "detection_ms": round(det, 2), "registration_ms": round(reg, 2), "total_ms": round(det + reg, 2),
               "smooth": ho["smooth"], "encap": (self.binding or {}).get("encap", "-"),
               "attempts": ho["attempts"], "agent": ho.get("agent")}
        self.last_handoff = rec
        self.tel.emit("handoff", "handoff %d to %s done: detection %.1f ms + registration %.1f ms = %.1f ms" % (
            ho["id"], self.label(ho["to"]), det, reg, det + reg), **rec)
        ho["done"] = True
        self.call_later(2.0, self.close_handoff_loss, ho["id"])

    def close_handoff_loss(self, hid=None):
        """Count stream sequence numbers that never arrived during the handoff window."""
        ho = self.handoff
        if not ho or (hid is not None and ho["id"] != hid) or ho.get("loss_done"):
            return
        ho["loss_done"] = True
        lo, hi = ho["seq_before"], self.max_seq
        lost = sum(1 for s in range(lo + 1, hi + 1) if s not in self.rx) if hi > lo >= -1 else 0
        self.stats["lost_total"] += lost
        self.tel.emit("handoff_loss", "handoff %d: %d stream packets lost (seq %d..%d)%s" % (
            ho["id"], lost, lo + 1, hi, "" if ho.get("done") else ", handoff interrupted"),
            id=ho["id"], lost=lost, smooth=ho["smooth"], seq_from=lo + 1, seq_to=hi, completed=bool(ho.get("done")))

    # ---- data plane ------------------------------------------------------------------
    def on_stream(self, h, sport, data, datagram):
        if len(data) < 17 or data[:4] != b"MIPV":
            return
        seq, ts, tag = struct.unpack("!IdB", data[4:17])
        if seq in self.rx:
            self.stats["dup"] += 1
            return
        self.rx.add(seq)
        if seq > self.max_seq:
            self.max_seq = seq
        if len(self.rx) > 6000:
            floor = self.max_seq - 4000
            self.rx = {s for s in self.rx if s > floor}
        self.stats["rx"] += 1
        lat = self.now_ms() - ts
        self.stats["last_latency_ms"] = round(lat, 2)
        self.tel.emit("data_rx", "stream seq %d %.1f ms" % (seq, lat), seq=seq, latency_ms=round(lat, 3),
                      route_tag=tag, flow="%s>%s#%d/%d" % (h.src, h.dst, h.ident, h.proto),
                      at_home=self.state == AT_HOME and self.at_home_link(), ccoa=self.colocated(),
                      handoff_id=self.handoff["id"] if self.handoff else 0, ttl=h.ttl)
        every = int(self.ncfg.get("echo_every", 5))
        if every and seq % every == 0:
            reply = b"MIPR" + struct.pack("!Id", seq, ts)
            self.send_out(ipv4.build_udp_datagram(self.home, h.src, self.cn["mn_port"], sport, reply))
            self.stats["replies_sent"] += 1

    def send_out(self, datagram):
        """Outbound path from the mobile node, which depends on where it is."""
        if self.at_home_link() and self.state in (AT_HOME, DEREGISTERING):
            return self.send_routed(datagram)
        b = self.binding
        if not b:
            return
        if b["ccoa"]:
            if b["reverse"]:
                try:
                    datagram = encap.encapsulate(b["encap"], datagram, b["coa"], self.ha, forwarding=False)
                except encap.TunnelError:
                    return
            return self.send_routed(datagram)
        a = self.agents.get(b["agent"])
        if a:
            self.send_link(a["node_id"], datagram)

    def ping(self, count):
        for i in range(int(count)):
            self.call_later(0.2 * i, self._ping_one)

    def _ping_one(self):
        seq = (max(self.pings) + 1 if self.pings else 1) & 0xFFFF
        self.pings[seq] = self.now()
        self.send_out(ipv4.build_echo(self.home, self.cn["ip"], 0x4D4E, seq, b"mobile-ip-ping"))

    # ---- control -------------------------------------------------------------------
    def on_command(self, cmd, args):
        if cmd == "handoff":
            self.encap_override = self.reverse_override = self.lifetime_override = None
            self.attach(args.get("link"))
        elif cmd == "ping":
            self.ping(args.get("count", 4))
        elif cmd == "reregister":
            a = self.agents.get(self.current) if self.current else None
            if a and not a["is_home"]:
                self.register(a, reason="manual re-registration")
        elif cmd in ("demo_wrong_key", "demo_replay"):
            self.run_demo(cmd[5:])
        elif cmd == "clock_skew":
            self.idgen.skew_s = float(args.get("seconds", 0))
            self.tel.emit("config", "MN clock skew set to %.0f s" % self.idgen.skew_s)
        elif cmd == "reset":
            self.reset_stats()
            self.handoff = None
            self.last_handoff = None
            if self.link != self.home_link:
                self.attach(self.home_link)
            else:
                self.tel.emit("config", "MN statistics cleared")

    def run_demo(self, kind):
        """Scenario 3 and 4: make one of the MN's own registrations fail on purpose.

        wrong_key  a fresh request for the current CoA, signed with a key that is not the MN-HA key
        replay     the previous Registration Request re-sent byte for byte
        The real binding is not touched, so the MN keeps working afterwards.
        """
        if self.state not in (REGISTERED_AWAY, RENEWING) or not self.binding:
            self.tel.emit("demo", "demo %s needs the MN registered away from home; move it to a foreign network "
                                  "first" % kind, demo=kind, code=None)
            return
        a = self.agents.get(self.binding["agent"])
        if kind == "replay":
            old = self.last_request
            if not old:
                self.tel.emit("demo", "demo replay: no earlier request to re-send yet", demo=kind, code=None)
                return
            ident = old["ident"]
            if old["via"] is None:
                self.send_routed(old["dg"])
            else:
                self.send_link(old["via"], old["dg"])
            what = "re-sent the previous Registration Request unchanged (Identification %016x)" % ident
        else:
            flags, _ = self.build_flags(a)
            ident = self.idgen.next()
            coa = self.binding["coa"]
            wrong = bytes(b ^ 0x5A for b in self.mh_sa[1])
            raw = m.append_auth(m.RegistrationRequest(flags, self.binding["lifetime"], self.home, self.ha, coa,
                                                      ident).pack(), m.EXT_MH_AUTH, self.mh_sa[0], wrong)
            if self.binding["ccoa"]:
                self.send_routed(ipv4.build_udp_datagram(coa, self.ha, self.my_port, self.reg_port(), raw))
            else:
                self.send_link(a["node_id"], ipv4.build_udp_datagram(self.home, a["ip"], self.my_port,
                                                                     self.reg_port(), raw))
            what = "sent a Registration Request signed with the wrong shared key (SPI %d)" % self.mh_sa[0]
        if self.demo:
            self.demo["timer"].cancel()
        self.demo = {"kind": kind, "ident": ident, "timer": self.call_later(8.0, self._demo_timeout, kind)}
        self.tel.emit("demo", "demo %s: MN %s" % (kind, what), demo=kind, code=None)

    def _demo_timeout(self, kind):
        if self.demo and self.demo["kind"] == kind:
            self.demo = None
            self.tel.emit("demo", "demo %s: no reply within 8 s" % kind, demo=kind, code=None)

    def on_features(self, changed):
        if "replay_protection" in changed:
            self.idgen = auth.MobileIdent(changed["replay_protection"], self.idgen.skew_s)
        if "encapsulation" in changed:
            self.encap_override = None
        if "reverse_tunneling" in changed:
            self.reverse_override = None
        relevant = {"encapsulation", "reverse_tunneling", "simultaneous_bindings", "colocated_coa", "request_lifetime",
                    "replay_protection"}
        if relevant & set(changed) and self.state == REGISTERED_AWAY and self.binding:
            a = self.agents.get(self.binding["agent"])
            if a and a["expires"] > self.now():
                self.register(a, reason="re-register to apply %s" % ", ".join(sorted(relevant & set(changed))),
                              renewal=True)

    def snapshot(self):
        now = self.now()
        heard = [{"ip": a["ip"], "node": a["node"], "prefix": a["prefix"], "seq": a["seq"],
                  "flags": m.flag_names(a["flags"], m.AD_FLAGS), "remaining": round(max(0, a["expires"] - now), 2),
                  "home": a["is_home"]} for a in self.agents.values()]
        return {"state": self.state, "link": self.link, "link_label": self.label(self.link), "home": self.home,
                "ha": self.ha, "current_agent": self.current,
                "current_node": self.agents[self.current]["node"] if self.current in self.agents else None,
                "binding": self.binding, "heard": heard, "last_handoff": self.last_handoff,
                "pending": {"attempts": self.reg["attempts"] + 1, "coa": self.reg["coa"], "dereg": self.reg["dereg"]}
                if self.reg else None, "stats": self.stats, "max_seq": self.max_seq,
                "replay": self.idgen.mode, "algorithm": self.features.get("movement_detection"),
                "colocated": self.colocated(), "prev_fa": self.prev_fa}


def main():
    ap = argparse.ArgumentParser(description="Mobile IPv4 mobile node")
    ap.add_argument("--config")
    a = ap.parse_args()
    MobileNode(cfgmod.load(a.config)).run()


if __name__ == "__main__":
    main()
