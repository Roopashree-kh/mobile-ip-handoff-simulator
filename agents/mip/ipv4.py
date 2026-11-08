"""Byte-accurate IPv4, UDP and ICMP packing and parsing.

Everything here produces real wire-format bytes: a datagram built here can be written
straight into a libpcap file with LINKTYPE_RAW and Wireshark decodes it.
"""
import itertools
import random
import socket
import struct

PROTO_ICMP = 1
PROTO_IPIP = 4
PROTO_UDP = 17
PROTO_GRE = 47
PROTO_MINENC = 55

PROTO_NAMES = {PROTO_ICMP: "ICMP", PROTO_IPIP: "IP-in-IP", PROTO_UDP: "UDP",
               PROTO_GRE: "GRE", PROTO_MINENC: "MinEnc"}

FLAG_DF = 0x2
FLAG_MF = 0x1

BROADCAST = "255.255.255.255"
ALL_SYSTEMS = "224.0.0.1"

_ident = itertools.count(random.randint(1, 0x7FFF))


class PacketError(ValueError):
    """Raised when bytes on the wire do not form a valid header."""


def checksum(data: bytes) -> int:
    """RFC 1071 Internet checksum: one's complement of the one's complement sum."""
    if len(data) % 2:
        data += b"\x00"
    total = sum(struct.unpack("!%dH" % (len(data) // 2), data))
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def ip2b(ip: str) -> bytes:
    return socket.inet_aton(ip)


def b2ip(b: bytes) -> str:
    return socket.inet_ntoa(b)


def next_ident() -> int:
    return next(_ident) & 0xFFFF


class IPv4Header:
    """A parsed or to-be-built IPv4 header (RFC 791)."""

    __slots__ = ("version", "ihl", "tos", "total_length", "ident", "flags", "frag_off",
                 "ttl", "proto", "checksum", "src", "dst", "options", "checksum_ok")

    def __init__(self, src, dst, proto, ttl=64, tos=0, ident=None, flags=0, frag_off=0,
                 options=b""):
        self.version = 4
        self.ihl = 5 + len(options) // 4
        self.tos = tos
        self.total_length = 0
        self.ident = next_ident() if ident is None else ident
        self.flags = flags
        self.frag_off = frag_off
        self.ttl = ttl
        self.proto = proto
        self.checksum = 0
        self.src = src
        self.dst = dst
        self.options = options
        self.checksum_ok = True

    @property
    def df(self):
        return bool(self.flags & FLAG_DF)

    @property
    def fragmented(self):
        return bool(self.flags & FLAG_MF) or self.frag_off != 0

    @property
    def header_len(self):
        return self.ihl * 4

    def pack(self, payload_len: int) -> bytes:
        """Pack the header for a payload of payload_len bytes, filling length and checksum."""
        self.total_length = self.header_len + payload_len
        hdr = struct.pack("!BBHHHBBH4s4s", (4 << 4) | self.ihl, self.tos, self.total_length,
                          self.ident, (self.flags << 13) | self.frag_off, self.ttl, self.proto,
                          0, ip2b(self.src), ip2b(self.dst)) + self.options
        self.checksum = checksum(hdr)
        return hdr[:10] + struct.pack("!H", self.checksum) + hdr[12:]

    @classmethod
    def unpack(cls, data: bytes):
        if len(data) < 20:
            raise PacketError("IPv4 header shorter than 20 bytes")
        vihl, tos, tlen, ident, ff, ttl, proto, csum, s, d = struct.unpack("!BBHHHBBH4s4s", data[:20])
        if vihl >> 4 != 4:
            raise PacketError("not IPv4 (version %d)" % (vihl >> 4))
        ihl = vihl & 0x0F
        if ihl < 5 or len(data) < ihl * 4:
            raise PacketError("bad IHL %d" % ihl)
        h = cls(b2ip(s), b2ip(d), proto, ttl=ttl, tos=tos, ident=ident, flags=ff >> 13,
                frag_off=ff & 0x1FFF, options=data[20:ihl * 4])
        h.ihl = ihl
        h.total_length = tlen
        h.checksum = csum
        h.checksum_ok = checksum(data[:ihl * 4]) == 0
        return h


def build_ipv4(src, dst, proto, payload: bytes, ttl=64, tos=0, ident=None, df=False) -> bytes:
    hdr = IPv4Header(src, dst, proto, ttl=ttl, tos=tos, ident=ident, flags=FLAG_DF if df else 0)
    return hdr.pack(len(payload)) + payload


def parse_ipv4(datagram: bytes):
    """Return (header, payload). Payload is trimmed to the header's total length."""
    h = IPv4Header.unpack(datagram)
    if h.total_length > len(datagram) or h.total_length < h.header_len:
        raise PacketError("total length %d does not match %d bytes" % (h.total_length, len(datagram)))
    return h, datagram[h.header_len:h.total_length]


def set_ttl(datagram: bytes, ttl: int) -> bytes:
    """Rewrite the TTL and recompute the header checksum in place."""
    ihl = (datagram[0] & 0x0F) * 4
    hdr = bytearray(datagram[:ihl])
    hdr[8] = ttl & 0xFF
    hdr[10:12] = b"\x00\x00"
    hdr[10:12] = struct.pack("!H", checksum(bytes(hdr)))
    return bytes(hdr) + datagram[ihl:]


def decrement_ttl(datagram: bytes):
    """Forwarding step: returns (new_datagram, new_ttl). new_ttl 0 means drop."""
    ttl = datagram[8]
    if ttl <= 1:
        return datagram, 0
    return set_ttl(datagram, ttl - 1), ttl - 1


# ---- UDP (RFC 768) --------------------------------------------------------

def build_udp(src_ip, dst_ip, sport, dport, payload: bytes) -> bytes:
    length = 8 + len(payload)
    pseudo = ip2b(src_ip) + ip2b(dst_ip) + struct.pack("!BBH", 0, PROTO_UDP, length)
    seg = struct.pack("!HHHH", sport, dport, length, 0) + payload
    csum = checksum(pseudo + seg) or 0xFFFF
    return seg[:6] + struct.pack("!H", csum) + seg[8:]


def parse_udp(segment: bytes, src_ip=None, dst_ip=None):
    """Return (sport, dport, payload, checksum_ok)."""
    if len(segment) < 8:
        raise PacketError("UDP header shorter than 8 bytes")
    sport, dport, length, csum = struct.unpack("!HHHH", segment[:8])
    if length < 8 or length > len(segment):
        raise PacketError("bad UDP length %d" % length)
    ok = True
    if csum and src_ip and dst_ip:
        pseudo = ip2b(src_ip) + ip2b(dst_ip) + struct.pack("!BBH", 0, PROTO_UDP, length)
        ok = checksum(pseudo + segment[:length]) == 0
    return sport, dport, segment[8:length], ok


def build_udp_datagram(src, dst, sport, dport, payload, ttl=64, df=False) -> bytes:
    return build_ipv4(src, dst, PROTO_UDP, build_udp(src, dst, sport, dport, payload), ttl=ttl, df=df)


# ---- ICMP (RFC 792) -------------------------------------------------------

ICMP_ECHO_REPLY = 0
ICMP_DEST_UNREACH = 3
ICMP_ECHO = 8
ICMP_ROUTER_ADV = 9
ICMP_ROUTER_SOLICIT = 10
ICMP_TIME_EXCEEDED = 11


def build_icmp(icmp_type, code, body: bytes) -> bytes:
    """body is everything after the 4-byte type/code/checksum prefix."""
    msg = struct.pack("!BBH", icmp_type, code, 0) + body
    return msg[:2] + struct.pack("!H", checksum(msg)) + msg[4:]


def parse_icmp(data: bytes):
    """Return (type, code, body, checksum_ok)."""
    if len(data) < 4:
        raise PacketError("ICMP shorter than 4 bytes")
    t, c, _ = struct.unpack("!BBH", data[:4])
    return t, c, data[4:], checksum(data) == 0


def build_echo(src, dst, ident, seq, payload=b"", reply=False, ttl=64) -> bytes:
    body = struct.pack("!HH", ident, seq) + payload
    return build_ipv4(src, dst, PROTO_ICMP,
                      build_icmp(ICMP_ECHO_REPLY if reply else ICMP_ECHO, 0, body), ttl=ttl)


def build_icmp_error(router_ip, offending: bytes, icmp_type, code) -> bytes:
    """ICMP error quoting the offending IP header plus the first 8 payload bytes."""
    h = IPv4Header.unpack(offending)
    quote = offending[:h.header_len + 8]
    return build_ipv4(router_ip, h.src, PROTO_ICMP, build_icmp(icmp_type, code, b"\x00" * 4 + quote))
