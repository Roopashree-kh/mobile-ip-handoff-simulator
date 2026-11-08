"""The three tunnel encapsulations Mobile IPv4 can negotiate.

  ipip    RFC 2003  IP in IP, protocol 4. New 20-byte outer header in front of the datagram.
  minimal RFC 2004  Minimal encapsulation, protocol 55. The original header is rewritten in
                    place and an 8 or 12 byte forwarding header carries the original
                    destination (and source, when the encapsulator is not the source).
  gre     RFC 2784  Generic Routing Encapsulation, protocol 47. 20-byte outer header plus a
                    4-byte GRE header (8 with the optional checksum).

TTL rule (RFC 2003 section 3.1): when encapsulating as part of forwarding, the inner TTL is
decremented by one. The tunnel then counts as a single hop to the inner datagram.
DF rule: the outer DF bit is copied from the inner header.
Loop guard (RFC 2003 section 4): never tunnel a datagram whose source is the tunnel exit
point, and refuse when the nesting depth would exceed the configured limit.
"""
import struct

from .ipv4 import (FLAG_DF, PROTO_GRE, PROTO_IPIP, PROTO_MINENC, PacketError, build_ipv4,
                   checksum, ip2b, b2ip, parse_ipv4, IPv4Header, set_ttl)

IPIP, MINIMAL, GRE = "ipip", "minimal", "gre"
MODES = (IPIP, MINIMAL, GRE)
MODE_NAMES = {IPIP: "IP-in-IP (RFC 2003)", MINIMAL: "Minimal Encapsulation (RFC 2004)",
              GRE: "GRE (RFC 2784)"}

GRE_PROTO_IPV4 = 0x0800
GRE_C = 0x8000


class TunnelError(Exception):
    """Encapsulation refused. reason is a short human readable string."""


def overhead(mode, source_is_encapsulator=False, gre_checksum=False):
    """Bytes added on the wire by each encapsulation."""
    if mode == IPIP:
        return 20
    if mode == MINIMAL:
        return 8 if source_is_encapsulator else 12
    return 24 + (4 if gre_checksum else 0)


def is_tunnel(proto):
    return proto in (PROTO_IPIP, PROTO_MINENC, PROTO_GRE)


def nesting_depth(datagram: bytes) -> int:
    """How many tunnel headers are stacked on this datagram."""
    depth = 0
    while True:
        try:
            h, payload = parse_ipv4(datagram)
        except PacketError:
            return depth
        if not is_tunnel(h.proto):
            return depth
        depth += 1
        try:
            _, datagram, _ = decapsulate(datagram)
        except (TunnelError, PacketError):
            return depth


def encapsulate(mode, inner: bytes, tun_src: str, tun_dst: str, forwarding=True,
                gre_checksum=False, max_nesting=3) -> bytes:
    """Wrap inner for transport from tun_src to tun_dst. Raises TunnelError when refused."""
    h, _ = parse_ipv4(inner)
    if h.src == tun_dst:
        raise TunnelError("loop guard: inner source %s is the tunnel exit point" % h.src)
    if nesting_depth(inner) + 1 > max_nesting:
        raise TunnelError("loop guard: nesting depth would exceed %d" % max_nesting)
    if forwarding:
        if h.ttl <= 1:
            raise TunnelError("inner TTL expired")
        inner = set_ttl(inner, h.ttl - 1)
        h.ttl -= 1
    if mode == IPIP:
        return build_ipv4(tun_src, tun_dst, PROTO_IPIP, inner, tos=h.tos, df=h.df)
    if mode == GRE:
        if gre_checksum:
            body = struct.pack("!HHHH", GRE_C, GRE_PROTO_IPV4, 0, 0) + inner
            body = body[:4] + struct.pack("!H", checksum(body)) + body[6:]
        else:
            body = struct.pack("!HH", 0, GRE_PROTO_IPV4) + inner
        return build_ipv4(tun_src, tun_dst, PROTO_GRE, body, tos=h.tos, df=h.df)
    if mode == MINIMAL:
        if h.fragmented:
            raise TunnelError("minimal encapsulation cannot carry a fragment (RFC 2004 section 3)")
        s_bit = h.src != tun_src
        payload = inner[h.header_len:h.total_length]
        fwd = struct.pack("!BBH4s", h.proto, 0x80 if s_bit else 0, 0, ip2b(h.dst))
        if s_bit:
            fwd += ip2b(h.src)
        fwd = fwd[:2] + struct.pack("!H", checksum(fwd)) + fwd[4:]
        outer = IPv4Header(tun_src, tun_dst, PROTO_MINENC, ttl=h.ttl, tos=h.tos, ident=h.ident,
                           flags=h.flags)
        return outer.pack(len(fwd) + len(payload)) + fwd + payload
    raise TunnelError("unknown encapsulation %r" % mode)


def decapsulate(outer: bytes):
    """Return (mode, inner_datagram, outer_header). Raises TunnelError on a bad header."""
    h, payload = parse_ipv4(outer)
    if h.proto == PROTO_IPIP:
        parse_ipv4(payload)
        return IPIP, payload, h
    if h.proto == PROTO_GRE:
        if len(payload) < 4:
            raise TunnelError("short GRE header")
        flags, ptype = struct.unpack("!HH", payload[:4])
        if flags & 0x7 != 0:
            raise TunnelError("GRE version %d not supported" % (flags & 0x7))
        if ptype != GRE_PROTO_IPV4:
            raise TunnelError("GRE protocol type 0x%04x is not IPv4" % ptype)
        hlen = 8 if flags & GRE_C else 4
        if flags & GRE_C and checksum(payload) != 0:
            raise TunnelError("GRE checksum failed")
        return GRE, payload[hlen:], h
    if h.proto == PROTO_MINENC:
        if len(payload) < 8:
            raise TunnelError("short minimal forwarding header")
        s_bit = payload[1] & 0x80
        flen = 12 if s_bit else 8
        if len(payload) < flen or checksum(payload[:flen]) != 0:
            raise TunnelError("minimal forwarding header checksum failed")
        proto = payload[0]
        orig_dst = b2ip(payload[4:8])
        orig_src = b2ip(payload[8:12]) if s_bit else h.src
        inner_hdr = IPv4Header(orig_src, orig_dst, proto, ttl=h.ttl, tos=h.tos, ident=h.ident,
                               flags=h.flags, frag_off=h.frag_off)
        body = payload[flen:]
        return MINIMAL, inner_hdr.pack(len(body)) + body, h
    raise TunnelError("protocol %d is not a tunnel" % h.proto)


def mode_from_flags(m_flag, g_flag):
    return MINIMAL if m_flag else (GRE if g_flag else IPIP)
