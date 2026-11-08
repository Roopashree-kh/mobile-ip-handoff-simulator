"""Home Agent on the Home Network 10.1.0.0/24 (RFC 3344 sections 3.8 and 4.2.3).

Responsibilities:
  * advertise on the home link with the H flag set
  * authenticate and accept or deny Registration Requests (codes 0, 1, 128-139)
  * keep the mobility binding table with live lifetimes, including simultaneous bindings
  * proxy ARP for an away mobile node, gratuitous ARP on its behalf when it returns
  * intercept datagrams for the home address and tunnel them to every registered CoA
  * terminate reverse tunnels (RFC 3024) after checking the tunnel source
  * route optimization: send Binding Updates to correspondents, answer Binding Requests and
    act on Binding Warnings (Perkins and Johnson draft)
"""
import argparse
import os
import sys
from ipaddress import ip_address

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mip import config as cfgmod  # noqa: E402
from mip import encap, ipv4, policy  # noqa: E402
from mip import messages as m  # noqa: E402
from mip.agentbase import MobilityAgent  # noqa: E402
from mip.auth import ReplayGuard  # noqa: E402


class HomeAgent(MobilityAgent):
    ROLE_FLAGS = m.AD_H

    def __init__(self, topo):
        super().__init__("HA", topo)
        sec = topo.security
        self.mh_sa = self.sa(sec["mn_ha"])
        self.fh_sas = {topo.node(fa)["ip"]: self.sa(e) for fa, e in sec["fa_ha"].items()}
        self.fa_by_ip = {topo.node(fa)["ip"]: fa for fa in sec["fa_ha"]}
        self.ro_sa = self.sa(sec["ha_cn"])
        self.mn_cfg = topo.node("MN")
        self.reset_state()

    def reset_state(self):
        self.bindings = policy.BindingTable(self.ncfg.get("max_bindings", 3))
        self.replay = ReplayGuard(self.features.get("replay_protection", "timestamp"),
                                  self.topo.security["replay_window_s"])
        self.correspondents = {}   # home address -> set of CN addresses told about the binding
        self.bu_last = {}          # (cn, home) -> time of last Binding Update
        self.tunnel_note = {}      # (home, coa) -> last learn event time
        self.proxy = set()
        self.counters = {"tunneled": 0, "reverse": 0, "dropped": 0, "accepted": 0, "denied": 0, "bu_sent": 0}
        self.last_reg = None

    def start(self):
        super().start()
        self.every(lambda: 0.25, self.expire_bindings)

    # ---- registration ---------------------------------------------------------------
    def on_mip(self, kind, src_id, h, sport, dport, data):
        try:
            msg = m.parse_mip_udp(data)
        except m.MalformedMessage as e:
            self.counters["denied"] += 1
            self.tel.emit("registration", "HA cannot parse a message from %s: %s" % (h.src, e), code=134)
            if len(data) >= 12 and data[0] == m.MSG_REG_REQUEST:
                rep = m.RegistrationReply(134, 0, ipv4.b2ip(data[4:8]), self.ip, 0)
                self.send_mip(h.src, rep.pack(), dport=sport)
            return
        if isinstance(msg, m.RegistrationRequest):
            self.handle_request(h, sport, msg, data)
        elif isinstance(msg, m.BindingWarning):
            self.tel.emit("ro", "Binding Warning from %s: %s holds a stale binding for %s" % (
                h.src, msg.target, msg.home_addr), rfc="Route Optimization draft, Binding Warning",
                learn="The previous foreign agent received a tunneled packet for a mobile node that has moved on. "
                      "It warns the home agent, which sends the correspondent a fresh Binding Update.")
            self.send_binding_update(msg.target, msg.home_addr, force=True)
        elif isinstance(msg, m.BindingRequest):
            self.tel.emit("ro", "Binding Request from %s for %s" % (h.src, msg.home_addr),
                          rfc="Route Optimization draft, Binding Request")
            self.send_binding_update(h.src, msg.home_addr, force=True)
        elif isinstance(msg, m.BindingAck):
            self.tel.emit("ro", "Binding Acknowledge from %s for %s%s" % (
                h.src, msg.home_addr, " (negative)" if msg.negative else ""))

    def handle_request(self, h, sport, req, raw):
        fh_sa = self.fh_sas.get(h.src)
        via = self.fa_by_ip.get(h.src, "direct")
        code, rid, why = policy.ha_validate(req, raw, self.ip, self.ncfg, self.mh_sa, fh_sa, self.replay)
        granted = 0
        dereg = req.lifetime == 0 or req.coa == req.home_addr
        mode = encap.mode_from_flags(req.flags & m.REQ_M, req.flags & m.REQ_G)
        if m.accepted(code):
            if dereg:
                self.bindings.remove(req.home_addr, None if req.coa == req.home_addr else req.coa)
                if req.coa == req.home_addr:
                    self.mn_returned_home(req.home_addr)
            else:
                granted = min(req.lifetime, self.ncfg["max_lifetime"])
                simultaneous = bool(req.flags & m.REQ_S) and self.ncfg.get("simultaneous_supported", True)
                try:
                    self.bindings.update(req.home_addr, req.coa, granted, req.ident, mode, bool(req.flags & m.REQ_T),
                                         via, simultaneous, colocated=bool(req.flags & m.REQ_D), now=self.now())
                except policy.TooManyBindings:
                    code, granted, why = 135, 0, "already %d bindings" % self.bindings.max_bindings
                else:
                    self.start_proxy(req.home_addr)
                    if self.features.get("route_optimization"):
                        for cn in sorted(self.correspondents.get(req.home_addr, ())):
                            self.send_binding_update(cn, req.home_addr, force=True)
        self.counters["accepted" if m.accepted(code) else "denied"] += 1
        rep = m.RegistrationReply(code, granted, req.home_addr, self.ip, rid).pack()
        rep = m.append_auth(rep, m.EXT_MH_AUTH, *self.mh_sa)
        if fh_sa:
            rep = m.append_auth(rep, m.EXT_FH_AUTH, *fh_sa)
        self.send_mip(h.src, rep, dport=sport)
        what = "deregistration" if dereg else "registration of CoA %s via %s" % (req.coa, via)
        self.last_reg = {"code": code, "text": m.code_text(code), "reason": why, "coa": req.coa, "ts": self.now_ms()}
        learn = {0: "The home agent checked the keyed-MD5 authenticator and the Identification, then recorded "
                    "the binding home address -> care-of address and will now tunnel traffic there.",
                 131: "The Mobile-Home authenticator did not verify. Without the shared key nobody can redirect "
                      "this mobile node's traffic, which is the whole point of registration authentication.",
                 133: "The Identification failed the replay check. A captured request cannot be replayed because "
                      "the timestamp is stale or not newer than the last one accepted (or the nonce is wrong)."}
        self.tel.emit("registration", "HA %s %s: %s (%s)" % ("accepted" if m.accepted(code) else "DENIED", what,
                                                              m.code_text(code), why),
                      code=code, home=req.home_addr, coa=req.coa, lifetime=granted, via=via, dereg=dereg,
                      ident="%016x" % req.ident, encap=mode, reverse=bool(req.flags & m.REQ_T),
                      rfc="RFC 3344 section 3.8.2" if code not in (131, 133) else "RFC 3344 section 5",
                      learn=learn.get(code, "Registration Reply code %d: %s." % (code, m.REPLY_CODES.get(code, ""))))

    def start_proxy(self, home):
        if home in self.proxy:
            return
        self.proxy.add(home)
        self.send_arp(m.gratuitous_arp(self.mac, home))
        self.tel.emit("arp", "HA proxy ARP: claims %s on the home link while the mobile node is away" % home,
                      rfc="RFC 3344 section 4.6")

    def mn_returned_home(self, home):
        self.proxy.discard(home)
        mn_mac = cfgmod.mac_for(self.mn_cfg["id"])
        self.send_arp(m.gratuitous_arp(mn_mac, home))
        self.tel.emit("arp", "HA stops proxy ARP and sends gratuitous ARP for %s on behalf of the mobile node" % home,
                      rfc="RFC 3344 section 4.6")
        for cn in sorted(self.correspondents.get(home, ())):
            self.send_binding_update(cn, home, force=True, lifetime=0)

    def expire_bindings(self):
        for b in self.bindings.expire(self.now()):
            self.tel.emit("binding", "binding %s -> %s expired (lifetime %d s ran out)" % (b.home, b.coa, b.lifetime),
                          home=b.home, coa=b.coa, rfc="RFC 3344 section 3.8.3")

    # ---- data plane ---------------------------------------------------------------------
    def on_datagram(self, kind, src_id, h, datagram):
        if h.dst == self.ip and encap.is_tunnel(h.proto):
            return self.reverse_tunnel_exit(h, datagram)
        if h.dst == self.ip or ip_address(h.dst) not in self.net:
            return
        bl = self.bindings.lookup(h.dst, self.now())
        if not bl:
            self.counters["dropped"] += 1
            self.tel.emit("drop", "HA has no binding for %s, datagram from %s discarded" % (h.dst, h.src))
            return
        if not self.features.get("simultaneous_bindings") and len(bl) > 1:
            bl = bl[-1:]
        for b in bl:
            try:
                out = encap.encapsulate(b.encap, datagram, self.ip, b.coa,
                                        max_nesting=self.topo.mip["max_tunnel_nesting"])
            except (encap.TunnelError, ipv4.PacketError) as e:
                self.counters["dropped"] += 1
                self.tel.emit("drop", "HA refused to tunnel to %s: %s" % (b.coa, e), rfc="RFC 2003 section 4")
                continue
            self.counters["tunneled"] += 1
            self.send_routed(out)
            key = (b.home, b.coa)
            if self.now() - self.tunnel_note.get(key, 0) > 5:
                self.tunnel_note[key] = self.now()
                self.tel.emit("tunnel", "HA intercepts %s -> %s and tunnels it to CoA %s using %s (+%d bytes)" % (
                    h.src, h.dst, b.coa, encap.MODE_NAMES[b.encap], encap.overhead(b.encap)),
                    coa=b.coa, encap=b.encap, rfc="RFC 3344 section 4.2.3, RFC %s" % {
                        "ipip": "2003", "minimal": "2004", "gre": "2784"}[b.encap],
                    learn="Packets for the home address reach the home network by normal routing. The home agent "
                          "captures them with proxy ARP and wraps each one in a new header addressed to the "
                          "care-of address.")
        if (self.features.get("route_optimization") and ip_address(h.src) not in self.net
                and h.src != self.ip):
            self.send_binding_update(h.src, h.dst)

    def reverse_tunnel_exit(self, h, datagram):
        try:
            mode, inner, outer = encap.decapsulate(datagram)
            ih, _ = ipv4.parse_ipv4(inner)
        except (encap.TunnelError, ipv4.PacketError) as e:
            self.counters["dropped"] += 1
            self.tel.emit("drop", "HA could not decapsulate packet from %s: %s" % (h.src, e))
            return
        ok = any(b.coa == outer.src and b.reverse for b in self.bindings.lookup(ih.src, self.now()))
        if not ok:
            self.counters["dropped"] += 1
            self.tel.emit("drop", "reverse tunnel from %s for %s rejected: no binding with T flag for that CoA" % (
                outer.src, ih.src), rfc="RFC 3024 section 5.2")
            return
        self.counters["reverse"] += 1
        self.send_routed(inner)

    # ---- route optimization ------------------------------------------------------------
    def send_binding_update(self, cn, home, force=False, lifetime=None):
        now = self.now()
        if not force and now - self.bu_last.get((cn, home), 0) < 1.0:
            return
        if lifetime != 0 and not self.features.get("route_optimization"):
            return
        self.bu_last[(cn, home)] = now
        bl = self.bindings.lookup(home, now)
        if lifetime is None:
            lifetime = int(min(bl[-1].remaining(now), self.topo.mip["binding_cache_lifetime_s"])) if bl else 0
        coa = bl[-1].coa if bl and lifetime else home
        flags = m.BU_A
        if bl and bl[-1].encap == encap.MINIMAL:
            flags |= m.BU_M
        elif bl and bl[-1].encap == encap.GRE:
            flags |= m.BU_G
        bu = m.BindingUpdate(flags, lifetime, home, coa, self.new_ident()).pack()
        self.send_mip(cn, self.ro_auth(bu, self.ro_sa))
        self.counters["bu_sent"] += 1
        if lifetime:
            self.correspondents.setdefault(home, set()).add(cn)
        else:
            self.correspondents.get(home, set()).discard(cn)
        self.tel.emit("ro", "HA sends Binding Update to %s: %s is at %s for %d s" % (cn, home, coa, lifetime),
                      cn=cn, coa=coa, lifetime=lifetime, rfc="Route Optimization draft, Binding Update",
                      learn="With route optimization the home agent tells the correspondent where the mobile node "
                            "is. The correspondent then tunnels straight to the care-of address and the packets stop "
                            "crossing the Internet twice." if lifetime else
                      "Lifetime 0 tells the correspondent to delete its binding cache entry.")

    # ---- control ------------------------------------------------------------------------
    def on_command(self, cmd, args):
        if cmd == "reset":
            self.reset_state()
            self.tel.emit("config", "HA state cleared")
        elif cmd == "reboot":
            self.reset_state()
            self.reboot()
        elif cmd == "jump_seq":
            self.jump_seq()

    def on_features(self, changed):
        super().on_features(changed)
        if "replay_protection" in changed:
            self.replay.set_mode(changed["replay_protection"])
            self.tel.emit("config", "HA replay protection: %s" % changed["replay_protection"], rfc="RFC 3344 section 5.7")

    def snapshot(self):
        return {"ip": self.ip, "bindings": self.bindings.snapshot(self.now()), "max_lifetime": self.ncfg["max_lifetime"],
                "replay": self.replay.mode, "seq": self.adv_seq, "proxy_arp": sorted(self.proxy),
                "correspondents": {k: sorted(v) for k, v in self.correspondents.items()},
                "counters": self.counters, "last_reg": self.last_reg}


def main():
    ap = argparse.ArgumentParser(description="Mobile IPv4 home agent")
    ap.add_argument("--config")
    a = ap.parse_args()
    HomeAgent(cfgmod.load(a.config)).run()


if __name__ == "__main__":
    main()
