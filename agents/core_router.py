"""Core router: the virtual Internet backbone and every access link.

All frames between agents pass through this process, which is what lets it play the role of
both the backbone router and the shared medium of each access link:

  ROUTED frames      longest-prefix lookup on the destination, TTL decrement, optional
                     ingress filtering (RFC 2827 style source check), ARP resolution on the
                     destination link, then delivery after link + backbone delay.
  LINK_UNICAST       one hop on the sender's own link. If the target is not associated with
                     that link any more, the sender gets an L2_NAK, just as an 802.11 station
                     sees a missing ACK.
  LINK_BROADCAST     every station on the sender's link (agent advertisements, solicitations).
  ARP                gratuitous and proxy ARP update the per-link ARP cache.
  ATTACH             a station associates with another link. This is the physical handoff.

Every frame accepted or dropped is mirrored to telemetry with a decoded protocol tree and
the raw IPv4 bytes, which the gateway turns into the Packet Inspector and the .pcap export.
"""
import argparse
import ipaddress
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from mip import config as cfgmod  # noqa: E402
from mip import decode, ipv4, link  # noqa: E402
from mip import messages as m  # noqa: E402
from mip.node import Node  # noqa: E402

RFC_INGRESS = "RFC 2827 (ingress filtering), RFC 3024 section 1"


class CoreRouter(Node):
    def __init__(self, topo):
        super().__init__("ROUTER", topo)
        self.port_to_node = {v["data_port"]: n for n, v in topo.nodes.items()}
        self.reset_state()

    def reset_state(self):
        t = self.topo
        self.links = {n: {"label": l["label"], "net": ipaddress.ip_network(l["prefix"]), "prefix": l["prefix"],
                          "delay_ms": float(l["delay_ms"]), "loss_pct": float(l["loss_pct"])}
                      for n, l in t.links.items()}
        self.backbone = {"delay_ms": float(t.backbone["delay_ms"]), "loss_pct": float(t.backbone["loss_pct"])}
        self.attach = {}
        self.arp = {n: {} for n in self.links}
        self.promisc = set()
        for n, v in t.nodes.items():
            if v["role"] == "router":
                continue
            ln = v.get("link") or v.get("initial_link")
            self.attach[n] = ln
            if "ip" in v:
                self.arp[ln][v["ip"]] = n
            if v.get("promiscuous"):
                self.promisc.add(n)
        mn = t.node("MN")
        self.arp[t.link_of_ip(mn["home_address"])][mn["home_address"]] = "MN"
        self.counters = {"forwarded": 0, "dropped": 0, "by_reason": {}}

    # ---- input --------------------------------------------------------------
    def _dispatch(self, tag, data, addr):
        if tag != "frame":
            return super()._dispatch(tag, data, addr)
        sender = self.port_to_node.get(addr[1])
        fr = link.unframe(data)
        if sender is None or fr is None:
            return
        kind, dst_id, _src_id, payload = fr
        self._safe(self.handle, sender, kind, dst_id, payload)

    def handle(self, sender, kind, dst_id, payload):
        if kind == link.ROUTED:
            self.route(sender, payload)
        elif kind == link.LINK_UNICAST:
            self.unicast(sender, self.topo.node_name(dst_id), payload)
        elif kind == link.LINK_BROADCAST:
            self.broadcast(sender, payload)
        elif kind == link.ARP:
            self.handle_arp(sender, payload)
        elif kind == link.ATTACH:
            self.handle_attach(sender, payload.decode(errors="replace"))

    # ---- delay and loss model ---------------------------------------------------
    def _scale(self):
        return max(0.1, float(self.features.get("time_scale", 1) or 1))

    def _lost(self, *pcts):
        keep = 1.0
        for p in pcts:
            keep *= 1.0 - max(0.0, min(100.0, p)) / 100.0
        return random.random() > keep

    def _deliver(self, node, kind, payload, delay_ms, src_id=None):
        frame = link.frame(kind, src_id if src_id is not None else self.node_id, payload)
        addr = self.topo.data_addr(node)
        self.call_later(delay_ms / 1000.0, self._send, frame, addr)

    def _send(self, frame, addr):
        try:
            self.sock.sendto(frame, addr)
        except OSError:
            pass

    def _sniff(self, link_name, payload, exclude, delay_ms, kind):
        """Copy a frame to promiscuous stations on the link (the open hotspot eavesdropper)."""
        for n in self.promisc:
            if self.attach.get(n) == link_name and n not in exclude:
                self._deliver(n, link.SNIFFED, payload, delay_ms)

    # ---- routed forwarding --------------------------------------------------------
    def route(self, sender, datagram, origin_link=None):
        src_link = origin_link or self.attach.get(sender)
        try:
            h, _ = ipv4.parse_ipv4(datagram)
        except ipv4.PacketError as e:
            return self.mirror(sender, None, datagram, "routed", "dropped", "malformed IPv4: %s" % e, src_link)
        if not h.checksum_ok:
            return self.mirror(sender, None, datagram, "routed", "dropped", "bad IPv4 header checksum", src_link)
        if self.features.get("ingress_filtering") and src_link and sender != "ROUTER":
            if ipaddress.ip_address(h.src) not in self.links[src_link]["net"]:
                return self.mirror(sender, None, datagram, "routed", "dropped",
                                   "ingress filter: source %s is not inside %s (%s)" % (
                                       h.src, self.links[src_link]["prefix"], self.links[src_link]["label"]),
                                   src_link, rfc=RFC_INGRESS,
                                   learn="The backbone dropped a packet whose source address does not belong to "
                                         "the network it came from. Triangle routing from a foreign network breaks "
                                         "here. Reverse tunneling (T flag) sends it via the home agent instead.")
        fwd, ttl = ipv4.decrement_ttl(datagram)
        if ttl == 0:
            self.mirror(sender, None, datagram, "routed", "dropped", "TTL expired in transit", src_link)
            if h.proto != ipv4.PROTO_ICMP:
                self.route("ROUTER", ipv4.build_icmp_error(self.topo.backbone["router_ip"], datagram,
                                                           ipv4.ICMP_TIME_EXCEEDED, 0), origin_link=None)
            return
        dst_link = self.topo.link_of_ip(h.dst)
        if dst_link is None:
            return self.mirror(sender, None, datagram, "routed", "dropped", "no route to %s" % h.dst, src_link)
        target = self.arp[dst_link].get(h.dst)
        if target is None:
            return self.mirror(sender, None, datagram, "routed", "dropped",
                               "no ARP entry for %s on %s" % (h.dst, self.links[dst_link]["label"]), src_link, dst_link)
        if self.attach.get(target) != dst_link:
            return self.mirror(sender, target, datagram, "routed", "dropped",
                               "%s is not attached to %s (stale ARP entry)" % (target, self.links[dst_link]["label"]),
                               src_link, dst_link)
        if src_link == dst_link:
            delay = 2 * self.links[dst_link]["delay_ms"]
            loss = (self.links[dst_link]["loss_pct"],)
        else:
            delay = self.backbone["delay_ms"] + self.links[dst_link]["delay_ms"]
            loss = [self.backbone["loss_pct"], self.links[dst_link]["loss_pct"]]
            if src_link:
                delay += self.links[src_link]["delay_ms"]
                loss.append(self.links[src_link]["loss_pct"])
        delay *= self._scale()
        if self._lost(*loss):
            return self.mirror(sender, target, fwd, "routed", "dropped", "lost on the wire (loss model)",
                               src_link, dst_link, delay_ms=delay)
        self.mirror(sender, target, fwd, "routed", "forwarded", None, src_link, dst_link, delay_ms=delay)
        self._deliver(target, link.ROUTED, fwd, delay)
        for ln in {src_link, dst_link}:
            if ln:
                self._sniff(ln, fwd, {sender, target}, delay, "routed")

    # ---- link-local delivery --------------------------------------------------------
    def unicast(self, sender, target, datagram):
        ln = self.attach.get(sender)
        delay = self.links[ln]["delay_ms"] * self._scale() if ln else 0
        if target not in self.attach or self.attach.get(target) != ln:
            self.mirror(sender, target, datagram, "unicast", "dropped",
                        "%s is not on %s (no link-layer ACK)" % (target, self.links[ln]["label"] if ln else "?"),
                        ln, ln, delay_ms=delay)
            self._deliver(sender, link.L2_NAK, datagram, delay, src_id=self.topo.node_id(target)
                          if target in self.topo.nodes else 0)
            return
        if self._lost(self.links[ln]["loss_pct"]):
            return self.mirror(sender, target, datagram, "unicast", "dropped", "lost on the wire (loss model)",
                               ln, ln, delay_ms=delay)
        self.mirror(sender, target, datagram, "unicast", "forwarded", None, ln, ln, delay_ms=delay)
        self._deliver(target, link.LINK_UNICAST, datagram, delay, src_id=self.topo.node_id(sender))
        self._sniff(ln, datagram, {sender, target}, delay, "unicast")

    def broadcast(self, sender, datagram):
        ln = self.attach.get(sender)
        if not ln:
            return
        delay = self.links[ln]["delay_ms"] * self._scale()
        receivers = [n for n, l in self.attach.items() if l == ln and n != sender and n not in self.promisc]
        self._sniff(ln, datagram, {sender}, delay, "broadcast")
        if not receivers:
            return   # nobody listening; not worth a telemetry event every second
        for r in receivers:
            if not self._lost(self.links[ln]["loss_pct"]):
                self._deliver(r, link.LINK_BROADCAST, datagram, delay, src_id=self.topo.node_id(sender))
        self.mirror(sender, receivers[0], datagram, "broadcast", "forwarded", None, ln, ln, delay_ms=delay,
                    receivers=receivers)

    # ---- ARP and association ------------------------------------------------------------
    def handle_arp(self, sender, payload):
        ln = self.attach.get(sender)
        try:
            a = m.parse_arp(payload)
        except m.MalformedMessage:
            return
        owner = self.topo.node_name(a["sha"][5])
        info = decode.dissect_arp(payload)
        note = ""
        if a["spa"] == a["tpa"] and ln:
            prev = self.arp[ln].get(a["spa"])
            self.arp[ln][a["spa"]] = owner
            note = "ARP cache on %s: %s now resolves to %s%s" % (
                self.links[ln]["label"], a["spa"], owner, " (proxy ARP by the home agent)" if owner != "MN" and
                a["spa"] == self.topo.node("MN")["home_address"] else "")
            if prev != owner:
                self.tel.emit("arp", note, link=ln, ip=a["spa"], owner=owner, previous=prev,
                              rfc="RFC 3344 section 4.6",
                              learn="Gratuitous ARP rewrites every neighbour's cache. The home agent uses it to "
                                    "capture packets for an absent mobile node (proxy ARP). The mobile node uses it "
                                    "to take its address back when it returns home.")
        self.tel.emit("packet", info["info"], frm=sender, to="*", link=ln, dst_link=ln, lkind="arp",
                      verdict="forwarded", reason=note or None, delay_ms=0, length=len(payload),
                      hex=payload.hex(), ip=False, **{k: info[k] for k in ("layers", "protocol", "ptype", "src", "dst",
                                                                          "flow", "encap", "overhead")},
                      info=info["info"])

    def handle_attach(self, sender, link_name):
        if link_name not in self.links and link_name != "none":
            return
        old = self.attach.get(sender)
        if old == link_name:
            return
        if link_name == "none":
            self.attach.pop(sender, None)
        else:
            self.attach[sender] = link_name
        self.tel.emit("l2", "%s left %s and associated with %s" % (
            sender, self.links[old]["label"] if old in self.links else "nothing",
            self.links[link_name]["label"] if link_name in self.links else "nothing"),
            station=sender, old=old, new=link_name)

    # ---- telemetry mirror ----------------------------------------------------------------
    def mirror(self, sender, target, datagram, lkind, verdict, reason, src_link, dst_link=None, delay_ms=0.0, **extra):
        if verdict == "forwarded":
            self.counters["forwarded"] += 1
        else:
            self.counters["dropped"] += 1
            key = (reason or "?").split(":")[0]
            self.counters["by_reason"][key] = self.counters["by_reason"].get(key, 0) + 1
        try:
            d = decode.dissect(datagram)
        except Exception as e:  # never let the dissector break forwarding
            d = {"layers": [], "info": "dissector error: %s" % e, "protocol": "?", "ptype": "data",
                 "src": "?", "dst": "?", "flow": None, "encap": None, "overhead": 0}
        summary = d["info"] if verdict == "forwarded" else "DROPPED %s (%s)" % (d["info"], reason)
        ttl = datagram[8] if len(datagram) > 8 else None
        self.tel.emit("packet", summary, frm=sender, to=target, link=src_link, dst_link=dst_link, lkind=lkind,
                      verdict=verdict, reason=reason, delay_ms=round(delay_ms, 2), length=len(datagram),
                      ttl=ttl, hex=datagram.hex(), ip=True, layers=d["layers"], info=d["info"],
                      protocol=d["protocol"].rstrip("|"), ptype=d["ptype"], src=d["src"], dst=d["dst"],
                      flow=d["flow"], encap=d["encap"], overhead=d["overhead"], mip=d.get("mip"), **extra)

    # ---- control --------------------------------------------------------------------
    def on_command(self, cmd, args):
        if cmd == "set_link":
            ln = args.get("link")
            target = self.backbone if ln == "backbone" else self.links.get(ln)
            if target is None:
                return
            for k in ("delay_ms", "loss_pct"):
                if k in args:
                    target[k] = float(args[k])
            self.tel.emit("config", "%s delay %.0f ms, loss %.1f%%" % (ln, target["delay_ms"], target["loss_pct"]))
        elif cmd == "reset":
            self.reset_state()
            self.tel.emit("config", "router reset to topology defaults")

    def on_features(self, changed):
        if "ingress_filtering" in changed:
            self.tel.emit("config", "ingress filtering %s" % ("ON" if changed["ingress_filtering"] else "OFF"),
                          rfc=RFC_INGRESS)
        if "time_scale" in changed:
            self.tel.emit("config", "time scale x%s (all link delays multiplied)" % changed["time_scale"])

    def snapshot(self):
        return {"links": {n: {"label": l["label"], "prefix": l["prefix"], "delay_ms": l["delay_ms"],
                              "loss_pct": l["loss_pct"]} for n, l in self.links.items()},
                "backbone": self.backbone, "attach": self.attach,
                "arp": self.arp, "counters": self.counters,
                "ingress_filtering": bool(self.features.get("ingress_filtering")),
                "time_scale": self._scale()}


def main():
    ap = argparse.ArgumentParser(description="Virtual Internet backbone router")
    ap.add_argument("--config", help="path to topology.json")
    a = ap.parse_args()
    CoreRouter(cfgmod.load(a.config)).run()


if __name__ == "__main__":
    main()
