"""Foreign Agent (RFC 3344 sections 3.7 and 4.2.2). Three instances run:
FA-1 Campus Wi-Fi 10.2.0.0/24, FA-2 Metro LTE cell 10.3.0.0/24, FA-3 Airport hotspot 10.4.0.0/24.

The FA is the centre of this simulator:
  * advertises itself (R and F flags) with its own address as the care-of address
  * checks every Registration Request and denies it locally with codes 64-88 when needed
  * relays accepted requests to the home agent, keeps a pending list and a visitor list
  * times out a silent home agent with code 78
  * decapsulates tunneled traffic (IP-in-IP, Minimal, GRE) and delivers it on the link
  * reverse tunnels the mobile node's outbound traffic when the T flag was granted
  * smooth handoff: buffers what it cannot deliver after the mobile node leaves, and on a
    Binding Update from the new FA forwards the buffer and later packets to the new CoA
  * route optimization: warns the home agent when a correspondent uses a stale binding
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mip import auth, encap, ipv4, link, policy  # noqa: E402
from mip import config as cfgmod  # noqa: E402
from mip import messages as m  # noqa: E402
from mip.agentbase import MobilityAgent  # noqa: E402


class ForeignAgent(MobilityAgent):
    ROLE_FLAGS = m.AD_R | m.AD_F

    def __init__(self, name, topo):
        super().__init__(name, topo)
        sec = topo.security
        self.fh_sa = self.sa(sec["fa_ha"][name]) if name in sec["fa_ha"] else None
        self.mn_fa_sa = self.sa(sec["mn_fa"])
        self.reset_state()

    def reset_state(self):
        self.visitors = {}
        self.pending = {}
        self.forward = {}     # smooth handoff: home -> {"coa", "expires_at"}
        self.buffer = {}      # home -> [(time, inner datagram)]
        self.former_ha = {}   # home -> HA address, remembered after a visitor leaves
        self.note_t = {}
        self.counters = {"relayed": 0, "denied": 0, "delivered": 0, "reverse": 0, "triangle_out": 0,
                         "dropped": 0, "buffered": 0, "smooth_forwarded": 0, "warnings": 0}
        self.last_denial = None

    def start(self):
        super().start()
        self.every(lambda: 0.25, self.expire)

    def adv_flags(self):
        f = super().adv_flags()
        if len(self.visitors) >= self.ncfg.get("max_visitors", 8):
            f |= m.AD_B
        return f

    def adv_coas(self):
        return [self.ip]

    def _rate(self, key, every=2.0):
        """True at most once per `every` seconds for a key. Keeps telemetry readable."""
        now = self.now()
        if now - self.note_t.get(key, 0) >= every:
            self.note_t[key] = now
            return True
        return False

    # ---- registration relay ------------------------------------------------------------
    def on_mip(self, kind, src_id, h, sport, dport, data):
        if not data:
            return
        t = data[0]
        if t == m.MSG_REG_REQUEST and kind in (link.LINK_UNICAST, link.LINK_BROADCAST):
            return self.mn_request(src_id, h, sport, data)
        if t == m.MSG_REG_REPLY and kind == link.ROUTED:
            return self.ha_reply(h, data)
        if t == m.MSG_BINDING_UPDATE and kind == link.ROUTED:
            return self.smooth_bu(h, data)
        if t == m.MSG_BINDING_ACK:
            ack = m.BindingAck.unpack(data)
            self.tel.emit("smooth", "%s got Binding Acknowledge from %s for %s%s" % (
                self.name, h.src, ack.home_addr, " (negative)" if ack.negative else ""),
                rfc="Route Optimization draft, smooth handoff")

    def mn_request(self, src_id, h, sport, data):
        try:
            req = m.RegistrationRequest.unpack(data)
        except m.MalformedMessage as e:
            home = ipv4.b2ip(data[4:8]) if len(data) >= 8 else h.src
            ha = ipv4.b2ip(data[8:12]) if len(data) >= 12 else "0.0.0.0"
            ident = int.from_bytes(data[16:24], "big") if len(data) >= 24 else 0
            return self.deny(src_id, sport, home, ha, ident, 70, "cannot parse: %s" % e)
        others = len([v for v in self.visitors if v != req.home_addr])
        code, why = policy.fa_validate(req, data, self.ncfg, [self.ip], others, self.mn_fa_sa)
        if code is not None:
            return self.deny(src_id, sport, req.home_addr, req.home_agent, req.ident, code, why)
        mh = m.find_ext(req.extensions, m.EXT_MH_AUTH)
        relay = m.strip_after(data, mh)                # MF auth and the Previous FA extension stay here
        prev_ext = m.find_ext(req.extensions, m.EXT_PREV_FA_NOTIFY)
        prev = None
        if prev_ext is not None:
            try:
                prev = m.parse_prev_fa_ext(prev_ext)
            except m.MalformedMessage:
                prev = None
        if self.fh_sa:
            relay = m.append_auth(relay, m.EXT_FH_AUTH, *self.fh_sa)
        key = (req.home_addr, auth.ident_low(req.ident))
        old = self.pending.pop(key, None)
        if old:
            old["timer"].cancel()
        timer = self.call_later(self.ncfg.get("pending_timeout_s", 7), self.pending_timeout, key)
        self.pending[key] = {"home": req.home_addr, "ha": req.home_agent, "node_id": src_id, "sport": sport,
                             "ident": req.ident, "flags": req.flags, "lifetime": req.lifetime, "prev": prev,
                             "since": self.now(), "timer": timer}
        self.send_mip(req.home_agent, relay)
        self.counters["relayed"] += 1
        self.tel.emit("registration", "%s relays Registration Request for %s to HA %s%s" % (
            self.name, req.home_addr, req.home_agent, " (asks for smooth handoff from %s)" % prev[1] if prev else ""),
            home=req.home_addr, rfc="RFC 3344 section 3.7.2",
            learn="The foreign agent checked lifetime, care-of address, encapsulation and reverse tunnel support. "
                  "It keeps the request in its pending list, adds a Foreign-Home authenticator and forwards it "
                  "to the home agent.")

    def deny(self, node_id, sport, home, ha, ident, code, why):
        rep = m.RegistrationReply(code, 0, home, ha, ident).pack()
        dg = ipv4.build_udp_datagram(self.ip, home, self.reg_port(), sport, rep)
        self.send_link(node_id, dg)
        self.counters["denied"] += 1
        self.last_denial = {"code": code, "text": m.code_text(code), "reason": why, "home": home, "ts": self.now_ms()}
        self.tel.emit("registration", "%s DENIED request from %s: %s (%s)" % (self.name, home, m.code_text(code), why),
                      code=code, home=home, rfc="RFC 3344 section 3.7.1",
                      learn="A foreign agent may refuse a registration itself, without asking the home agent. "
                            "Codes 64 to 88 come from the foreign agent, 128 and above from the home agent.")

    def pending_timeout(self, key):
        p = self.pending.pop(key, None)
        if p:
            self.deny(p["node_id"], p["sport"], p["home"], p["ha"], p["ident"], 78,
                      "no reply from home agent within %d s" % self.ncfg.get("pending_timeout_s", 7))

    def ha_reply(self, h, data):
        try:
            rep = m.RegistrationReply.unpack(data)
        except m.MalformedMessage as e:
            self.tel.emit("registration", "%s got a malformed reply from %s: %s" % (self.name, h.src, e))
            return
        key = (rep.home_addr, auth.ident_low(rep.ident))
        p = self.pending.pop(key, None)
        if p is None:
            self.tel.emit("registration", "%s discards an unexpected Registration Reply for %s" % (self.name, rep.home_addr))
            return
        p["timer"].cancel()
        if self.fh_sa:
            fh = m.find_ext(rep.extensions, m.EXT_FH_AUTH)
            if fh is None or m.auth_ext_spi(fh) != self.fh_sa[0] or not m.verify_auth(data, fh, self.fh_sa[1]):
                return self.deny(p["node_id"], p["sport"], p["home"], p["ha"], rep.ident, 68,
                                 "Foreign-Home authenticator on the reply did not verify")
        if m.accepted(rep.code):
            if rep.lifetime > 0:
                mode = encap.mode_from_flags(p["flags"] & m.REQ_M, p["flags"] & m.REQ_G)
                self.visitors[rep.home_addr] = {
                    "home": rep.home_addr, "ha": p["ha"], "node_id": p["node_id"],
                    "node": self.topo.node_name(p["node_id"]), "ident": "%016x" % rep.ident,
                    "lifetime": rep.lifetime, "expires_at": self.now() + rep.lifetime, "encap": mode,
                    "reverse": bool(p["flags"] & m.REQ_T), "sport": p["sport"], "reachable": True}
                self.former_ha[rep.home_addr] = p["ha"]
                self.forward.pop(rep.home_addr, None)
                self.buffer.pop(rep.home_addr, None)
                if p["prev"] and self.features.get("smooth_handoff") and p["prev"][1] != self.ip:
                    self.send_smooth_bu(p["prev"], rep.home_addr, mode)
            else:
                self.visitors.pop(rep.home_addr, None)
        mh = m.find_ext(rep.extensions, m.EXT_MH_AUTH)
        relay = m.strip_after(data, mh) if mh else data
        self.send_link(p["node_id"], ipv4.build_udp_datagram(self.ip, rep.home_addr, self.reg_port(), p["sport"], relay))
        self.tel.emit("registration", "%s relays Registration Reply (%s) to %s" % (
            self.name, m.code_text(rep.code), rep.home_addr), code=rep.code, home=rep.home_addr,
            rfc="RFC 3344 section 3.7.3")

    # ---- smooth handoff ------------------------------------------------------------------
    def send_smooth_bu(self, prev, home, mode):
        life, prev_fa, _prev_coa = prev
        flags = m.BU_A | (m.BU_M if mode == encap.MINIMAL else m.BU_G if mode == encap.GRE else 0)
        bu = m.BindingUpdate(flags, life, home, self.ip, auth.ntp_ident()).pack()
        self.send_mip(prev_fa, self.ro_auth(bu, self.mn_fa_sa))
        self.tel.emit("smooth", "%s sends Binding Update to previous FA %s: forward %s to %s for %d s" % (
            self.name, prev_fa, home, self.ip, life), rfc="Route Optimization draft, smooth handoff",
            learn="Smooth handoff: the new foreign agent tells the previous one where the mobile node went. "
                  "Packets still arriving at the old care-of address are forwarded instead of lost.")

    def smooth_bu(self, h, data):
        try:
            bu = m.BindingUpdate.unpack(data)
        except m.MalformedMessage:
            return
        ok = self.ro_verify(data, bu, self.mn_fa_sa)
        if not ok or not self.features.get("smooth_handoff"):
            self.send_mip(h.src, m.BindingAck(bu.home_addr, bu.ident, negative=True).pack())
            self.tel.emit("smooth", "%s rejects Binding Update from %s (%s)" % (
                self.name, h.src, "bad authenticator" if not ok else "smooth handoff disabled"))
            return
        self.visitors.pop(bu.home_addr, None)
        if bu.lifetime == 0:
            self.forward.pop(bu.home_addr, None)
        else:
            self.forward[bu.home_addr] = {"coa": bu.coa, "expires_at": self.now() + bu.lifetime,
                                          "lifetime": bu.lifetime, "encap": encap.IPIP}
        if bu.flags & m.BU_A:
            self.send_mip(h.src, m.BindingAck(bu.home_addr, bu.ident).pack())
        queued = self.buffer.pop(bu.home_addr, [])
        horizon = self.now() - self.topo.mip["smooth_buffer_age_ms"] / 1000.0
        sent = 0
        for t, inner in queued:
            if t >= horizon and self.forward_smooth(bu.home_addr, inner, None):
                sent += 1
        self.tel.emit("smooth", "%s now forwards %s to %s, flushed %d buffered packets" % (
            self.name, bu.home_addr, bu.coa, sent), flushed=sent, home=bu.home_addr, coa=bu.coa,
            rfc="Route Optimization draft, smooth handoff")

    def forward_smooth(self, home, inner, outer_src):
        fb = self.forward.get(home)
        if not fb or fb["expires_at"] < self.now():
            return False
        try:
            out = encap.encapsulate(encap.IPIP, inner, self.ip, fb["coa"], max_nesting=self.topo.mip["max_tunnel_nesting"])
        except (encap.TunnelError, ipv4.PacketError) as e:
            self.tel.emit("drop", "%s cannot forward to %s: %s" % (self.name, fb["coa"], e))
            return False
        self.send_routed(out)
        self.counters["smooth_forwarded"] += 1
        self.tel.emit("smooth_forward", "%s forwards a packet for %s to new CoA %s" % (self.name, home, fb["coa"]),
                      home=home, coa=fb["coa"])
        self.maybe_warn(home, outer_src)
        return True

    def undeliverable(self, home, inner, outer_src, why):
        if self.features.get("smooth_handoff"):
            q = self.buffer.setdefault(home, [])
            q.append((self.now(), inner))
            del q[:-self.topo.mip["smooth_buffer_packets"]]
            self.counters["buffered"] += 1
            if self._rate(("buf", home)):
                self.tel.emit("smooth", "%s buffers packets for %s (%s) until the new FA sends a Binding Update" % (
                    self.name, home, why), home=home)
        else:
            self.counters["dropped"] += 1
            self.tel.emit("drop", "%s drops a packet for %s: %s" % (self.name, home, why), home=home, lost=True)
        self.maybe_warn(home, outer_src)

    def maybe_warn(self, home, outer_src):
        """Tell the home agent a correspondent tunnels to an out-of-date care-of address."""
        ha = self.former_ha.get(home)
        if (not self.features.get("route_optimization") or not outer_src or not ha or outer_src == ha
                or not self._rate(("warn", home, outer_src), 1.0)):
            return
        self.send_mip(ha, m.BindingWarning(home, outer_src).pack())
        self.counters["warnings"] += 1
        self.tel.emit("ro", "%s sends Binding Warning to HA: %s still tunnels to the old CoA" % (self.name, outer_src),
                      rfc="Route Optimization draft, Binding Warning")

    # ---- data plane ---------------------------------------------------------------------
    def on_datagram(self, kind, src_id, h, datagram):
        if h.dst == self.ip and encap.is_tunnel(h.proto):
            return self.tunnel_exit(h, datagram)
        v = self.visitors.get(h.src)
        if kind == link.LINK_UNICAST and v and v["node_id"] == src_id and h.dst != self.ip:
            return self.outbound(v, h, datagram)

    def tunnel_exit(self, h, datagram):
        try:
            mode, inner, outer = encap.decapsulate(datagram)
            ih, _ = ipv4.parse_ipv4(inner)
        except (encap.TunnelError, ipv4.PacketError) as e:
            self.counters["dropped"] += 1
            self.tel.emit("drop", "%s could not decapsulate: %s" % (self.name, e))
            return
        home = ih.dst
        v = self.visitors.get(home)
        if v and v["expires_at"] > self.now():
            if v["reachable"]:
                self.send_link(v["node_id"], inner)
                self.counters["delivered"] += 1
            else:
                self.undeliverable(home, inner, outer.src, "mobile node left this link")
            return
        if self.forward_smooth(home, inner, outer.src):
            return
        self.undeliverable(home, inner, outer.src, "no visitor list entry")

    def outbound(self, v, h, datagram):
        if v["reverse"]:
            try:
                out = encap.encapsulate(v["encap"], datagram, self.ip, v["ha"],
                                        max_nesting=self.topo.mip["max_tunnel_nesting"])
            except (encap.TunnelError, ipv4.PacketError) as e:
                self.tel.emit("drop", "%s reverse tunnel refused: %s" % (self.name, e))
                return
            self.counters["reverse"] += 1
            self.send_routed(out)
            if self._rate(("rev", v["home"]), 5):
                self.tel.emit("tunnel", "%s reverse tunnels %s -> %s to HA %s" % (self.name, h.src, h.dst, v["ha"]),
                              rfc="RFC 3024 section 5",
                              learn="With the T flag the foreign agent wraps the mobile node's outgoing packets and "
                                    "sends them to the home agent. Their outer source is the care-of address, so "
                                    "ingress filters along the way accept them.")
        else:
            self.counters["triangle_out"] += 1
            self.send_routed(datagram)

    def on_l2_nak(self, target_id, datagram):
        try:
            h, _ = ipv4.parse_ipv4(datagram)
        except ipv4.PacketError:
            return
        v = self.visitors.get(h.dst)
        if not v or v["node_id"] != target_id:
            return
        if v["reachable"]:
            v["reachable"] = False
            self.tel.emit("l2", "%s: link-layer delivery to %s failed, the mobile node has left the cell" % (
                self.name, v["node"]), home=v["home"])
        if h.proto != ipv4.PROTO_UDP or not self._is_reg(datagram):
            self.undeliverable(h.dst, datagram, None, "mobile node left this link")

    def _is_reg(self, datagram):
        try:
            h, body = ipv4.parse_ipv4(datagram)
            sp, dp, _, _ = ipv4.parse_udp(body)
            return sp == self.reg_port() or dp == self.reg_port()
        except ipv4.PacketError:
            return False

    def expire(self):
        now = self.now()
        for home in [k for k, v in self.visitors.items() if v["expires_at"] <= now]:
            self.visitors.pop(home)
            self.tel.emit("binding", "%s visitor entry for %s expired" % (self.name, home), home=home,
                          rfc="RFC 3344 section 3.7.1")
        for home in [k for k, v in self.forward.items() if v["expires_at"] <= now]:
            self.forward.pop(home)
            self.buffer.pop(home, None)
        horizon = now - self.topo.mip["smooth_buffer_age_ms"] / 1000.0
        for home in list(self.buffer):
            q = [x for x in self.buffer[home] if x[0] >= horizon]
            dropped = len(self.buffer[home]) - len(q)
            if dropped:
                self.counters["dropped"] += dropped
                self.tel.emit("drop", "%s: %d buffered packets for %s aged out" % (self.name, dropped, home),
                              home=home, lost=True, count=dropped)
            if q:
                self.buffer[home] = q
            else:
                del self.buffer[home]

    # ---- control --------------------------------------------------------------------
    def on_command(self, cmd, args):
        if cmd == "reset":
            for p in self.pending.values():
                p["timer"].cancel()
            self.reset_state()
            self.tel.emit("config", "%s state cleared" % self.name)
        elif cmd == "reboot":
            for p in self.pending.values():
                p["timer"].cancel()
            self.reset_state()
            self.reboot()
        elif cmd == "jump_seq":
            self.jump_seq()

    def snapshot(self):
        now = self.now()
        vis = []
        for v in self.visitors.values():
            d = {k: v[k] for k in ("home", "ha", "node", "ident", "lifetime", "encap", "reverse", "reachable")}
            d["remaining"] = round(max(0, v["expires_at"] - now), 2)
            d["expires_at"] = v["expires_at"] * 1000
            vis.append(d)
        return {"ip": self.ip, "link": self.link, "label": self.topo.links[self.link]["label"], "visitors": vis,
                "pending": [{"home": p["home"], "ident": "%016x" % p["ident"], "age": round(now - p["since"], 2)}
                            for p in self.pending.values()],
                "forward": [{"home": k, "coa": v["coa"], "remaining": round(max(0, v["expires_at"] - now), 2),
                             "expires_at": v["expires_at"] * 1000, "lifetime": v["lifetime"]}
                            for k, v in self.forward.items()],
                "buffered": sum(len(q) for q in self.buffer.values()), "seq": self.adv_seq,
                "max_lifetime": self.ncfg["max_lifetime"], "encapsulations": self.ncfg.get("encapsulations"),
                "counters": self.counters, "last_denial": self.last_denial}


def main():
    ap = argparse.ArgumentParser(description="Mobile IPv4 foreign agent")
    ap.add_argument("--id", required=True, help="FA-1, FA-2 or FA-3")
    ap.add_argument("--subnet", help="must match the topology file, e.g. 10.3.0.0/24")
    ap.add_argument("--port", type=int, help="data port, must match the topology file")
    ap.add_argument("--config")
    a = ap.parse_args()
    topo = cfgmod.load(a.config)
    node = topo.node(a.id)
    if a.subnet and a.subnet != topo.links[node["link"]]["prefix"]:
        sys.exit("--subnet %s does not match %s in %s" % (a.subnet, topo.links[node["link"]]["prefix"], topo.path))
    if a.port and a.port != node["data_port"]:
        sys.exit("--port %d does not match data_port %d in %s" % (a.port, node["data_port"], topo.path))
    ForeignAgent(a.id, topo).run()


if __name__ == "__main__":
    main()
