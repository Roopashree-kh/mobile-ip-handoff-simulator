"""Behaviour shared by the home agent and the foreign agents.

Agent Discovery (RFC 3344 section 2): periodic Agent Advertisements broadcast on the agent's
own link, an immediate advertisement in answer to an Agent Solicitation, and the sequence
number that rolls over from 0xffff to 256 and restarts at 0 after a reboot.
"""
import ipaddress
import struct

from . import auth, ipv4, link
from . import messages as m
from .node import Node


class MobilityAgent(Node):
    ROLE_FLAGS = 0

    def __init__(self, name, topo):
        super().__init__(name, topo)
        self.ip = self.ncfg["ip"]
        self.link = self.ncfg["link"]
        self.net = ipaddress.ip_network(topo.links[self.link]["prefix"])
        self.adv_seq = 0
        self.adv_timer = None
        self.ro_sa = None

    # ---- discovery -------------------------------------------------------------
    def start(self):
        self._schedule_adv(0.2)

    def adv_interval(self):
        return max(0.1, float(self.features.get("adv_interval_ms", 1000)) / 1000.0)

    def _schedule_adv(self, delay=None):
        if self.adv_timer:
            self.adv_timer.cancel()
        self.adv_timer = self.call_later(self.adv_interval() if delay is None else delay, self._adv_tick)

    def _adv_tick(self):
        self.advertise()
        self._schedule_adv()

    def adv_flags(self):
        encs = self.ncfg.get("encapsulations", [])
        f = self.ROLE_FLAGS
        if "minimal" in encs:
            f |= m.AD_M
        if "gre" in encs:
            f |= m.AD_G
        if self.ncfg.get("reverse_tunnel"):
            f |= m.AD_T
        return f

    def adv_coas(self):
        return []

    def advertise(self, solicited=False):
        """Broadcast one Agent Advertisement on our link."""
        lifetime = int(round(self.adv_interval() * self.topo.mip["adv_lifetime_factor"])) or 1
        adv = m.AgentAdvertisement([(self.ip, 0)], lifetime, self.adv_seq, self.ncfg["max_lifetime"],
                                   self.adv_flags(), self.adv_coas(), [self.net.prefixlen])
        dg = ipv4.build_ipv4(self.ip, ipv4.BROADCAST, ipv4.PROTO_ICMP, adv.pack(), ttl=1)
        self.send_broadcast(dg)
        self.adv_seq = m.next_adv_seq(self.adv_seq)

    def on_features(self, changed):
        if "adv_interval_ms" in changed:
            self._schedule_adv(0.05)

    # ---- helpers -----------------------------------------------------------------
    def send_mip(self, dst_ip, payload, sport=None, dport=None, link_node=None):
        """Send a Mobile IP control message (UDP port 434) from our own address."""
        port = self.reg_port()
        dg = ipv4.build_udp_datagram(self.ip, dst_ip, sport or port, dport or port, payload)
        if link_node is not None:
            self.send_link(link_node, dg)
        else:
            self.send_routed(dg)
        return dg

    def on_frame(self, kind, src_id, payload):
        if kind == link.L2_NAK:
            return self.on_l2_nak(src_id, payload)
        try:
            h, body = ipv4.parse_ipv4(payload)
        except ipv4.PacketError:
            return
        if h.proto == ipv4.PROTO_ICMP:
            t, _, _, ok = ipv4.parse_icmp(body)
            if ok and t == ipv4.ICMP_ROUTER_SOLICIT and kind in (link.LINK_BROADCAST, link.LINK_UNICAST):
                self.tel.emit("discovery", "Agent Solicitation from %s, answering at once" %
                              self.topo.node_name(src_id), rfc="RFC 3344 section 2.4",
                              learn="A mobile node that has just attached asks for an advertisement instead of "
                                    "waiting for the next periodic one. This shortens movement detection.")
                self.advertise(solicited=True)
            elif ok and t == ipv4.ICMP_ECHO:
                ident, seq = struct.unpack("!HH", body[4:8])
                self.send_routed(ipv4.build_echo(self.ip, h.src, ident, seq, payload=body[8:], reply=True))
            return
        if h.proto == ipv4.PROTO_UDP:
            try:
                sport, dport, data, ok = ipv4.parse_udp(body, h.src, h.dst)
            except ipv4.PacketError:
                return
            if dport == self.reg_port() or sport == self.reg_port():
                return self.on_mip(kind, src_id, h, sport, dport, data)
        self.on_datagram(kind, src_id, h, payload)

    def on_mip(self, kind, src_id, h, sport, dport, data):
        pass

    def on_datagram(self, kind, src_id, h, datagram):
        pass

    def on_l2_nak(self, target_id, datagram):
        pass

    def ro_auth(self, msg_bytes, sa):
        spi, key = sa
        return m.append_auth(msg_bytes, m.EXT_RO_AUTH, spi, key)

    def ro_verify(self, raw, msg, sa):
        ext = m.find_ext(msg.extensions, m.EXT_RO_AUTH)
        return ext is not None and m.auth_ext_spi(ext) == sa[0] and m.verify_auth(raw, ext, sa[1])

    def reboot(self):
        """Simulated restart: the sequence number starts again at 0 (RFC 3344 section 2.3.1)."""
        self.adv_seq = 0
        self.tel.emit("reboot", "%s rebooted: state cleared, advertisement sequence restarts at 0" % self.name,
                      rfc="RFC 3344 section 2.3.1",
                      learn="Sequence numbers wrap from 0xffff to 256, never below. A value under 256 after a "
                            "higher one tells mobile nodes that the agent rebooted and lost its bindings, so they "
                            "register again.")

    def jump_seq(self):
        self.adv_seq = 0xFFFC
        self.tel.emit("config", "%s advertisement sequence set to 0xfffc to show the rollover to 256" % self.name,
                      rfc="RFC 3344 section 2.3.1")

    def sa(self, entry):
        return (entry["spi"], bytes.fromhex(entry["key"]))

    def new_ident(self):
        return auth.ntp_ident()
