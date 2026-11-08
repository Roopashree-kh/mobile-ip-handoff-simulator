"""Correspondent Node at 10.9.0.10, a video/chat server.

  * streams numbered UDP datagrams (port 5004 -> MN port 6000) at a configurable rate. Each
    payload carries a sequence number, the send time and a route tag so the dashboard can
    measure latency and path stretch per packet
  * receives the MN's periodic replies (which travel the reverse direction: triangle route
    or reverse tunnel) and measures the round trip
  * answers ICMP echo
  * route optimization: accepts authenticated Binding Updates from the home agent, keeps a
    Binding Cache with lifetimes, tunnels straight to the care-of address while an entry is
    valid, acknowledges updates and asks for a refresh (Binding Request) before expiry
"""
import argparse
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mip import auth, encap, ipv4  # noqa: E402
from mip import config as cfgmod  # noqa: E402
from mip import messages as m  # noqa: E402
from mip.node import Node  # noqa: E402


class Correspondent(Node):
    def __init__(self, topo):
        super().__init__("CN", topo)
        self.ip = self.ncfg["ip"]
        self.mn = topo.node("MN")
        self.ha = self.mn["home_agent"]
        self.ro_sa = (topo.security["ha_cn"]["spi"], bytes.fromhex(topo.security["ha_cn"]["key"]))
        self.rate = float(self.ncfg["stream_rate_pps"])
        self.streaming = False
        self.stream_timer = None
        self.reset_state()

    def reset_state(self):
        self.cache = {}           # home -> {coa, lifetime, expires_at, encap, last_used, requested}
        self.seq = 0
        self.stats = {"sent": 0, "sent_direct": 0, "replies": 0, "rtt_ms": None, "rtt_avg_ms": None,
                      "bu_rx": 0, "pings_answered": 0}
        self._rtt_sum = 0.0

    def start(self):
        self.every(lambda: 0.25, self.maintain_cache)

    # ---- stream ------------------------------------------------------------------
    def start_stream(self, rate=None):
        if rate:
            self.rate = max(1.0, min(200.0, float(rate)))
        if self.stream_timer:
            self.stream_timer.cancel()
        self.streaming = True
        self.stream_timer = self.call_later(0, self._stream_tick)
        self.tel.emit("stream", "CN starts streaming to %s at %.0f packets/s" % (self.mn["home_address"], self.rate))

    def stop_stream(self):
        self.streaming = False
        if self.stream_timer:
            self.stream_timer.cancel()
            self.stream_timer = None
        self.tel.emit("stream", "CN stream stopped after %d packets" % self.stats["sent"])

    def _stream_tick(self):
        if not self.streaming:
            return
        self.send_stream_packet()
        self.stream_timer = self.call_later(1.0 / self.rate, self._stream_tick)

    def send_stream_packet(self):
        home = self.mn["home_address"]
        entry = self.valid_entry(home)
        tag = 1 if entry else 0
        pad = max(0, int(self.ncfg["stream_payload_bytes"]) - 17)
        payload = b"MIPV" + struct.pack("!IdB", self.seq, self.now_ms(), tag) + bytes(pad)
        dg = ipv4.build_udp_datagram(self.ip, home, self.ncfg["stream_port"], self.ncfg["mn_port"], payload)
        self.seq += 1
        self.stats["sent"] += 1
        self.send_to_mn(dg, entry)

    def send_to_mn(self, dg, entry=None):
        """Plain routing to the home address, or a direct tunnel when the cache holds a binding."""
        if entry:
            try:
                dg = encap.encapsulate(entry["encap"], dg, self.ip, entry["coa"], forwarding=False)
            except encap.TunnelError as e:
                self.tel.emit("drop", "CN cannot tunnel: %s" % e)
                return
            entry["last_used"] = self.now()
            self.stats["sent_direct"] += 1
        self.send_routed(dg)

    def valid_entry(self, home):
        if not self.features.get("route_optimization"):
            return None
        e = self.cache.get(home)
        return e if e and e["expires_at"] > self.now() else None

    # ---- receive -----------------------------------------------------------------
    def on_frame(self, kind, src_id, payload):
        try:
            h, body = ipv4.parse_ipv4(payload)
        except ipv4.PacketError:
            return
        if h.dst != self.ip:
            return
        if h.proto == ipv4.PROTO_ICMP:
            t, _, rest, ok = ipv4.parse_icmp(body)
            if ok and t == ipv4.ICMP_ECHO and len(rest) >= 4:
                ident, seq = struct.unpack("!HH", rest[:4])
                self.stats["pings_answered"] += 1
                reply = ipv4.build_echo(self.ip, h.src, ident, seq, rest[4:], reply=True)
                if h.src == self.mn["home_address"]:
                    self.send_to_mn(reply, self.valid_entry(h.src))
                else:
                    self.send_routed(reply)
            return
        if h.proto != ipv4.PROTO_UDP:
            return
        try:
            sport, dport, data, ok = ipv4.parse_udp(body, h.src, h.dst)
        except ipv4.PacketError:
            return
        if dport == self.reg_port():
            return self.on_mip(h, sport, data)
        if dport == self.ncfg["stream_port"] and data[:4] == b"MIPR" and len(data) >= 16:
            seq, ts = struct.unpack("!Id", data[4:16])
            rtt = self.now_ms() - ts
            self.stats["replies"] += 1
            self._rtt_sum += rtt
            self.stats["rtt_ms"] = round(rtt, 2)
            self.stats["rtt_avg_ms"] = round(self._rtt_sum / self.stats["replies"], 2)
            self.tel.emit("reply_rx", "CN got reply for seq %d, RTT %.1f ms" % (seq, rtt), seq=seq, rtt_ms=round(rtt, 2))

    def on_mip(self, h, sport, data):
        try:
            msg = m.parse_mip_udp(data)
        except m.MalformedMessage:
            return
        if not isinstance(msg, m.BindingUpdate):
            return
        ext = m.find_ext(msg.extensions, m.EXT_RO_AUTH)
        if ext is None or m.auth_ext_spi(ext) != self.ro_sa[0] or not m.verify_auth(data, ext, self.ro_sa[1]):
            self.tel.emit("ro", "CN rejects Binding Update from %s: authentication failed" % h.src)
            if msg.flags & m.BU_A:
                self.send_routed(ipv4.build_udp_datagram(self.ip, h.src, self.reg_port(), sport,
                                                         m.BindingAck(msg.home_addr, msg.ident, True).pack()))
            return
        self.stats["bu_rx"] += 1
        if not self.features.get("route_optimization"):
            self.tel.emit("ro", "CN ignores Binding Update, route optimization is off")
            return
        if msg.lifetime == 0 or msg.coa == msg.home_addr:
            self.cache.pop(msg.home_addr, None)
            self.tel.emit("ro", "CN deletes binding cache entry for %s" % msg.home_addr,
                          rfc="Route Optimization draft, Binding Cache")
        else:
            old = self.cache.get(msg.home_addr)
            self.cache[msg.home_addr] = {"coa": msg.coa, "lifetime": msg.lifetime,
                                         "expires_at": self.now() + msg.lifetime, "encap": msg.encapsulation,
                                         "last_used": old["last_used"] if old else 0, "requested": False,
                                         "ident": "%016x" % msg.ident}
            self.tel.emit("ro", "CN binding cache: %s -> %s for %d s (%s)" % (
                msg.home_addr, msg.coa, msg.lifetime, encap.MODE_NAMES[msg.encapsulation]),
                coa=msg.coa, rfc="Route Optimization draft, Binding Cache",
                learn="The correspondent now tunnels directly to the care-of address. The home agent is no longer on "
                      "the path, which removes the triangle detour for CN -> MN traffic.")
        if msg.flags & m.BU_A:
            self.send_routed(ipv4.build_udp_datagram(self.ip, h.src, self.reg_port(), sport,
                                                     m.BindingAck(msg.home_addr, msg.ident).pack()))

    def maintain_cache(self):
        now = self.now()
        for home, e in list(self.cache.items()):
            if e["expires_at"] <= now:
                del self.cache[home]
                self.tel.emit("ro", "CN binding cache entry for %s expired" % home)
                continue
            left = e["expires_at"] - now
            if (self.features.get("route_optimization") and not e["requested"] and left < 0.25 * e["lifetime"]
                    and now - e["last_used"] < 2.0):
                e["requested"] = True
                self.send_routed(ipv4.build_udp_datagram(self.ip, self.ha, self.reg_port(), self.reg_port(),
                                                         m.BindingRequest(home, auth.ntp_ident()).pack()))
                self.tel.emit("ro", "CN sends Binding Request for %s (entry %.1f s from expiry and in use)" % (home, left),
                              rfc="Route Optimization draft, Binding Request",
                              learn="Before an entry in use expires, the correspondent asks the home agent for a "
                                    "fresh Binding Update so its direct path does not lapse.")

    # ---- control ---------------------------------------------------------------------
    def on_command(self, cmd, args):
        if cmd == "stream_start":
            self.start_stream(args.get("rate"))
        elif cmd == "stream_stop":
            self.stop_stream()
        elif cmd == "stream_rate":
            self.rate = max(1.0, min(200.0, float(args.get("rate", self.rate))))
        elif cmd == "reset":
            if self.streaming:
                self.stop_stream()
            self.reset_state()

    def on_features(self, changed):
        if "route_optimization" in changed and not changed["route_optimization"]:
            self.cache.clear()

    def snapshot(self):
        now = self.now()
        return {"ip": self.ip, "streaming": self.streaming, "rate": self.rate, "seq": self.seq, "stats": self.stats,
                "cache": [{"home": k, "coa": v["coa"], "lifetime": v["lifetime"], "encap": v["encap"],
                           "remaining": round(max(0, v["expires_at"] - now), 2), "expires_at": v["expires_at"] * 1000}
                          for k, v in self.cache.items()],
                "route_optimization": bool(self.features.get("route_optimization"))}


def main():
    ap = argparse.ArgumentParser(description="Correspondent node (stream server)")
    ap.add_argument("--config")
    a = ap.parse_args()
    Correspondent(cfgmod.load(a.config)).run()


if __name__ == "__main__":
    main()
