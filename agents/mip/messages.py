"""Codecs for every Mobile IPv4 control message used by the simulator.

RFC 3344:      Agent Advertisement (ICMP 9 + extension 16 + extension 19), Agent Solicitation
               (ICMP 10), Registration Request (UDP type 1), Registration Reply (UDP type 3),
               authentication extensions 32 / 33 / 34.
Route Optimization draft (Perkins and Johnson, draft-ietf-mobileip-optim): Binding Warning (16),
               Binding Request (17), Binding Update (18), Binding Acknowledge (19), the
               Route Optimization Authentication extension (35) and the Previous Foreign Agent
               Notification extension used for smooth handoff.
RFC 826:       ARP, used for gratuitous and proxy ARP on the virtual home link.

All pack() methods return the exact wire bytes. All unpack() methods raise MalformedMessage
when the bytes cannot be a valid message, which is what the agents turn into codes 70 / 134.
"""
import struct

from . import auth
from .ipv4 import b2ip, build_icmp, ip2b, parse_icmp, ICMP_ROUTER_ADV, ICMP_ROUTER_SOLICIT


class MalformedMessage(ValueError):
    pass


# ---- extension and message type numbers -----------------------------------
EXT_PAD = 0
EXT_MOBILITY_AGENT_ADV = 16
EXT_PREFIX_LENGTHS = 19
EXT_MH_AUTH = 32
EXT_MF_AUTH = 33
EXT_FH_AUTH = 34
EXT_RO_AUTH = 35            # Route Optimization Authentication (draft)
EXT_PREV_FA_NOTIFY = 100    # Previous Foreign Agent Notification (draft, see PROTOCOL_NOTES)

EXT_NAMES = {EXT_PAD: "Pad", EXT_MOBILITY_AGENT_ADV: "Mobility Agent Advertisement",
             EXT_PREFIX_LENGTHS: "Prefix-Lengths", EXT_MH_AUTH: "Mobile-Home Authentication",
             EXT_MF_AUTH: "Mobile-Foreign Authentication", EXT_FH_AUTH: "Foreign-Home Authentication",
             EXT_RO_AUTH: "Route Optimization Authentication",
             EXT_PREV_FA_NOTIFY: "Previous Foreign Agent Notification"}

MSG_REG_REQUEST = 1
MSG_REG_REPLY = 3
MSG_BINDING_WARNING = 16
MSG_BINDING_REQUEST = 17
MSG_BINDING_UPDATE = 18
MSG_BINDING_ACK = 19

MSG_NAMES = {MSG_REG_REQUEST: "Registration Request", MSG_REG_REPLY: "Registration Reply",
             MSG_BINDING_WARNING: "Binding Warning", MSG_BINDING_REQUEST: "Binding Request",
             MSG_BINDING_UPDATE: "Binding Update", MSG_BINDING_ACK: "Binding Acknowledge"}

# ---- flag bits --------------------------------------------------------------
# Mobility Agent Advertisement extension flags (RFC 3344 section 2.1.1)
AD_FLAGS = [("R", 0x80, "Registration required"), ("B", 0x40, "Busy"),
            ("H", 0x20, "Home agent"), ("F", 0x10, "Foreign agent"),
            ("M", 0x08, "Minimal encapsulation supported"), ("G", 0x04, "GRE encapsulation supported"),
            ("r", 0x02, "Reserved, sent as zero"), ("T", 0x01, "Reverse tunneling supported")]
AD_R, AD_B, AD_H, AD_F, AD_M, AD_G, AD_r, AD_T = [f[1] for f in AD_FLAGS]

# Registration Request flags (RFC 3344 section 3.3, RFC 3024 for T)
REQ_FLAGS = [("S", 0x80, "Simultaneous bindings"), ("B", 0x40, "Broadcast datagrams"),
             ("D", 0x20, "Decapsulation by mobile node (co-located care-of address)"),
             ("M", 0x10, "Minimal encapsulation"), ("G", 0x08, "GRE encapsulation"),
             ("r", 0x04, "Reserved, sent as zero"), ("T", 0x02, "Reverse tunneling requested"),
             ("x", 0x01, "Reserved, sent as zero")]
REQ_S, REQ_B, REQ_D, REQ_M, REQ_G, REQ_r, REQ_T, REQ_x = [f[1] for f in REQ_FLAGS]

# Binding Update flags (route optimization draft)
BU_FLAGS = [("A", 0x80, "Acknowledge requested"), ("I", 0x40, "Identification present"),
            ("M", 0x20, "Minimal encapsulation"), ("G", 0x10, "GRE encapsulation")]
BU_A, BU_I, BU_M, BU_G = [f[1] for f in BU_FLAGS]
BACK_N = 0x80  # Binding Acknowledge negative flag


def flag_names(value, table):
    return "".join(n if value & bit else "." for n, bit, _ in table)


# ---- registration reply codes ----------------------------------------------
REPLY_CODES = {
    0: "registration accepted",
    1: "registration accepted, but simultaneous mobility bindings unsupported",
    # foreign agent denials (RFC 3344 section 3.4, RFC 3024)
    64: "reason unspecified", 65: "administratively prohibited", 66: "insufficient resources",
    67: "mobile node failed authentication", 68: "home agent failed authentication",
    69: "requested Lifetime too long", 70: "poorly formed Request", 71: "poorly formed Reply",
    72: "requested encapsulation unavailable", 73: "reserved and unavailable",
    74: "requested reverse tunnel unavailable", 75: "reverse tunnel is mandatory and T bit not set",
    77: "invalid care-of address", 78: "registration timeout",
    80: "home network unreachable", 81: "home agent host unreachable",
    82: "home agent port unreachable", 88: "home agent unreachable",
    # home agent denials
    128: "reason unspecified", 129: "administratively prohibited", 130: "insufficient resources",
    131: "mobile node failed authentication", 132: "foreign agent failed authentication",
    133: "registration Identification mismatch", 134: "poorly formed Request",
    135: "too many simultaneous mobility bindings", 136: "unknown home agent address",
    137: "requested reverse tunnel unavailable", 139: "requested encapsulation unavailable",
}


def code_text(code):
    who = "FA" if 64 <= code < 128 else ("HA" if code >= 128 else "")
    return ("%s %d: %s" % (who, code, REPLY_CODES.get(code, "unknown"))).strip()


def accepted(code):
    return code in (0, 1)


# ---- extensions -------------------------------------------------------------
class Extension:
    """One type-length-value extension. offset is relative to the message start."""

    __slots__ = ("type", "body", "offset")

    def __init__(self, etype, body=b"", offset=None):
        self.type = etype
        self.body = body
        self.offset = offset

    def pack(self):
        if self.type == EXT_PAD:
            return b"\x00"
        if len(self.body) > 255:
            raise MalformedMessage("extension too long")
        return bytes([self.type, len(self.body)]) + self.body

    @property
    def name(self):
        return EXT_NAMES.get(self.type, "Unknown(%d)" % self.type)

    def __repr__(self):
        return "Ext(%s,%d bytes)" % (self.name, len(self.body))


def parse_extensions(data: bytes, base_offset: int):
    exts, i = [], 0
    while i < len(data):
        t = data[i]
        if t == EXT_PAD:
            exts.append(Extension(EXT_PAD, b"", base_offset + i))
            i += 1
            continue
        if i + 2 > len(data):
            raise MalformedMessage("truncated extension header")
        ln = data[i + 1]
        if i + 2 + ln > len(data):
            raise MalformedMessage("extension %d overruns message" % t)
        exts.append(Extension(t, data[i + 2:i + 2 + ln], base_offset + i))
        i += 2 + ln
    return exts


def auth_ext_spi(ext):
    if len(ext.body) < 4:
        raise MalformedMessage("authentication extension shorter than its SPI")
    return struct.unpack("!I", ext.body[:4])[0]


def append_auth(message: bytes, ext_type: int, spi: int, key: bytes) -> bytes:
    """Append an authentication extension computed over everything before it."""
    prefix = message + bytes([ext_type, 4 + 16]) + struct.pack("!I", spi)
    return prefix + auth.keyed_md5(key, prefix)


def verify_auth(raw: bytes, ext: Extension, key: bytes) -> bool:
    """Check an authentication extension found inside raw (the full message bytes)."""
    if len(ext.body) != 20:
        return False
    protected = raw[:ext.offset + 2 + 4]
    return auth.constant_time_equal(auth.keyed_md5(key, protected), ext.body[4:])


def find_ext(exts, etype):
    for e in exts:
        if e.type == etype:
            return e
    return None


def strip_after(raw: bytes, ext: Extension) -> bytes:
    """Bytes of the message up to and including ext (used to drop MN-FA only extensions)."""
    return raw[:ext.offset + 2 + len(ext.body)]


# ---- Agent Advertisement / Solicitation ------------------------------------
class AgentAdvertisement:
    """ICMP Router Advertisement (type 9) with the Mobility Agent Advertisement extension."""

    def __init__(self, router_addrs, lifetime, seq, reg_lifetime, flags, coas,
                 prefix_lengths=None, code=0):
        self.router_addrs = list(router_addrs)     # [(address, preference)]
        self.lifetime = lifetime                   # ICMP lifetime, used for movement detection
        self.seq = seq
        self.reg_lifetime = reg_lifetime
        self.flags = flags
        self.coas = list(coas)
        self.prefix_lengths = prefix_lengths
        self.code = code

    def pack(self) -> bytes:
        body = struct.pack("!BBH", len(self.router_addrs), 2, self.lifetime)
        for addr, pref in self.router_addrs:
            body += ip2b(addr) + struct.pack("!i", pref)
        ext = struct.pack("!HHBB", self.seq, self.reg_lifetime, self.flags, 0)
        ext += b"".join(ip2b(c) for c in self.coas)
        body += bytes([EXT_MOBILITY_AGENT_ADV, len(ext)]) + ext
        if self.prefix_lengths is not None:
            body += bytes([EXT_PREFIX_LENGTHS, len(self.prefix_lengths)]) + bytes(self.prefix_lengths)
        return build_icmp(ICMP_ROUTER_ADV, self.code, body)

    @classmethod
    def unpack(cls, icmp: bytes):
        t, code, body, ok = parse_icmp(icmp)
        if t != ICMP_ROUTER_ADV or not ok:
            raise MalformedMessage("not a valid ICMP router advertisement")
        if len(body) < 4:
            raise MalformedMessage("short router advertisement")
        n, size, lifetime = struct.unpack("!BBH", body[:4])
        if size != 2:
            raise MalformedMessage("address entry size %d != 2" % size)
        i = 4
        addrs = []
        for _ in range(n):
            addrs.append((b2ip(body[i:i + 4]), struct.unpack("!i", body[i + 4:i + 8])[0]))
            i += 8
        exts = parse_extensions(body[i:], 4 + i)
        ma = find_ext(exts, EXT_MOBILITY_AGENT_ADV)
        if ma is None or len(ma.body) < 6 or (len(ma.body) - 6) % 4:
            raise MalformedMessage("missing or bad Mobility Agent Advertisement extension")
        seq, reg_life, flags, _ = struct.unpack("!HHBB", ma.body[:6])
        coas = [b2ip(ma.body[j:j + 4]) for j in range(6, len(ma.body), 4)]
        pl = find_ext(exts, EXT_PREFIX_LENGTHS)
        return cls(addrs, lifetime, seq, reg_life, flags, coas,
                   list(pl.body) if pl else None, code)


def build_solicitation() -> bytes:
    """ICMP Router Solicitation (type 10), used as the Agent Solicitation."""
    return build_icmp(ICMP_ROUTER_SOLICIT, 0, b"\x00" * 4)


# Advertisement sequence numbers (RFC 3344 section 2.3.1): after 0xffff the agent wraps to
# 256, so a value below 256 can only mean the agent has rebooted.
SEQ_MAX = 0xFFFF
SEQ_ROLLOVER_TO = 256


def next_adv_seq(seq: int) -> int:
    return SEQ_ROLLOVER_TO if seq >= SEQ_MAX else seq + 1


def agent_rebooted(last_seq, new_seq) -> bool:
    """True when new_seq shows the agent restarted (not a normal rollover)."""
    return last_seq is not None and new_seq < SEQ_ROLLOVER_TO and new_seq < last_seq


# ---- Registration Request / Reply -----------------------------------------
class RegistrationRequest:
    TYPE = MSG_REG_REQUEST
    FIXED = 24

    def __init__(self, flags, lifetime, home_addr, home_agent, coa, ident, extensions=None):
        self.flags = flags
        self.lifetime = lifetime
        self.home_addr = home_addr
        self.home_agent = home_agent
        self.coa = coa
        self.ident = ident
        self.extensions = extensions or []
        self.raw = None

    def fixed(self) -> bytes:
        return struct.pack("!BBH4s4s4sQ", self.TYPE, self.flags, self.lifetime, ip2b(self.home_addr),
                           ip2b(self.home_agent), ip2b(self.coa), self.ident)

    def pack(self) -> bytes:
        return self.fixed() + b"".join(e.pack() for e in self.extensions)

    @classmethod
    def unpack(cls, data: bytes):
        if len(data) < cls.FIXED or data[0] != cls.TYPE:
            raise MalformedMessage("Registration Request shorter than 24 bytes or wrong type")
        _, flags, life, h, ha, coa, ident = struct.unpack("!BBH4s4s4sQ", data[:24])
        m = cls(flags, life, b2ip(h), b2ip(ha), b2ip(coa), ident, parse_extensions(data[24:], 24))
        m.raw = data
        return m


class RegistrationReply:
    TYPE = MSG_REG_REPLY
    FIXED = 20

    def __init__(self, code, lifetime, home_addr, home_agent, ident, extensions=None):
        self.code = code
        self.lifetime = lifetime
        self.home_addr = home_addr
        self.home_agent = home_agent
        self.ident = ident
        self.extensions = extensions or []
        self.raw = None

    def fixed(self) -> bytes:
        return struct.pack("!BBH4s4sQ", self.TYPE, self.code, self.lifetime, ip2b(self.home_addr),
                           ip2b(self.home_agent), self.ident)

    def pack(self) -> bytes:
        return self.fixed() + b"".join(e.pack() for e in self.extensions)

    @classmethod
    def unpack(cls, data: bytes):
        if len(data) < cls.FIXED or data[0] != cls.TYPE:
            raise MalformedMessage("Registration Reply shorter than 20 bytes or wrong type")
        _, code, life, h, ha, ident = struct.unpack("!BBH4s4sQ", data[:20])
        m = cls(code, life, b2ip(h), b2ip(ha), ident, parse_extensions(data[20:], 20))
        m.raw = data
        return m


def prev_fa_ext(cache_lifetime: int, prev_fa: str, prev_coa: str) -> Extension:
    """Previous Foreign Agent Notification: asks the new FA to send a Binding Update."""
    return Extension(EXT_PREV_FA_NOTIFY, struct.pack("!H2x4s4s", cache_lifetime, ip2b(prev_fa), ip2b(prev_coa)))


def parse_prev_fa_ext(ext: Extension):
    if len(ext.body) != 12:
        raise MalformedMessage("bad Previous FA Notification extension")
    life, fa, coa = struct.unpack("!H2x4s4s", ext.body)
    return life, b2ip(fa), b2ip(coa)


# ---- Route optimization messages (draft) -----------------------------------
class BindingUpdate:
    TYPE = MSG_BINDING_UPDATE

    def __init__(self, flags, lifetime, home_addr, coa, ident, extensions=None):
        self.flags = flags | BU_I
        self.lifetime = lifetime
        self.home_addr = home_addr
        self.coa = coa
        self.ident = ident
        self.extensions = extensions or []
        self.raw = None

    def pack(self) -> bytes:
        return struct.pack("!BBH4s4sQ", self.TYPE, self.flags, self.lifetime, ip2b(self.home_addr),
                           ip2b(self.coa), self.ident) + b"".join(e.pack() for e in self.extensions)

    @classmethod
    def unpack(cls, data: bytes):
        if len(data) < 20 or data[0] != cls.TYPE:
            raise MalformedMessage("bad Binding Update")
        _, flags, life, h, coa, ident = struct.unpack("!BBH4s4sQ", data[:20])
        m = cls(flags, life, b2ip(h), b2ip(coa), ident, parse_extensions(data[20:], 20))
        m.raw = data
        return m

    @property
    def encapsulation(self):
        return "minimal" if self.flags & BU_M else ("gre" if self.flags & BU_G else "ipip")


class BindingAck:
    TYPE = MSG_BINDING_ACK

    def __init__(self, home_addr, ident, negative=False):
        self.home_addr = home_addr
        self.ident = ident
        self.negative = negative

    def pack(self) -> bytes:
        return struct.pack("!BBH4sQ", self.TYPE, BACK_N if self.negative else 0, 0,
                           ip2b(self.home_addr), self.ident)

    @classmethod
    def unpack(cls, data: bytes):
        if len(data) < 16 or data[0] != cls.TYPE:
            raise MalformedMessage("bad Binding Acknowledge")
        _, flags, _, h, ident = struct.unpack("!BBH4sQ", data[:16])
        return cls(b2ip(h), ident, bool(flags & BACK_N))


class BindingWarning:
    TYPE = MSG_BINDING_WARNING

    def __init__(self, home_addr, target):
        self.home_addr = home_addr
        self.target = target          # the correspondent that holds a stale binding

    def pack(self) -> bytes:
        return struct.pack("!B3x4s4s", self.TYPE, ip2b(self.home_addr), ip2b(self.target))

    @classmethod
    def unpack(cls, data: bytes):
        if len(data) < 12 or data[0] != cls.TYPE:
            raise MalformedMessage("bad Binding Warning")
        _, h, t = struct.unpack("!B3x4s4s", data[:12])
        return cls(b2ip(h), b2ip(t))


class BindingRequest:
    TYPE = MSG_BINDING_REQUEST

    def __init__(self, home_addr, ident):
        self.home_addr = home_addr
        self.ident = ident

    def pack(self) -> bytes:
        return struct.pack("!B3x4sQ", self.TYPE, ip2b(self.home_addr), self.ident)

    @classmethod
    def unpack(cls, data: bytes):
        if len(data) < 16 or data[0] != cls.TYPE:
            raise MalformedMessage("bad Binding Request")
        _, h, ident = struct.unpack("!B3x4sQ", data[:16])
        return cls(b2ip(h), ident)


def parse_mip_udp(payload: bytes):
    """Decode any UDP port 434 payload into its message object."""
    if not payload:
        raise MalformedMessage("empty Mobile IP message")
    cls = {MSG_REG_REQUEST: RegistrationRequest, MSG_REG_REPLY: RegistrationReply,
           MSG_BINDING_UPDATE: BindingUpdate, MSG_BINDING_ACK: BindingAck,
           MSG_BINDING_WARNING: BindingWarning, MSG_BINDING_REQUEST: BindingRequest}.get(payload[0])
    if cls is None:
        raise MalformedMessage("unknown Mobile IP message type %d" % payload[0])
    return cls.unpack(payload)


# ---- ARP (RFC 826) ----------------------------------------------------------
ARP_REQUEST = 1
ARP_REPLY = 2


def build_arp(op, sha: bytes, spa: str, tha: bytes, tpa: str) -> bytes:
    return struct.pack("!HHBBH6s4s6s4s", 1, 0x0800, 6, 4, op, sha, ip2b(spa), tha, ip2b(tpa))


def parse_arp(data: bytes):
    if len(data) < 28:
        raise MalformedMessage("short ARP packet")
    ht, pt, hl, pl, op, sha, spa, tha, tpa = struct.unpack("!HHBBH6s4s6s4s", data[:28])
    return {"op": op, "sha": sha, "spa": b2ip(spa), "tha": tha, "tpa": b2ip(tpa)}


def gratuitous_arp(mac: bytes, ip: str) -> bytes:
    """Gratuitous ARP: sender and target protocol address are both ip, sent as a request."""
    return build_arp(ARP_REQUEST, mac, ip, b"\xff" * 6, ip)
