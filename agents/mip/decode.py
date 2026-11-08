"""Packet dissector that produces the Wireshark-style protocol tree for the dashboard.

dissect(datagram) returns a dict with:
  layers    [{name, off, len, fields:[{name, value, off, len, desc?, bits?}]}]
            off/len are byte positions inside the datagram so the hex view can highlight them
  info      one-line summary for the packet list Info column
  protocol  short label for the Protocol column
  ptype     colour class for the topology animation: adv, reg, bu, tunnel, data, arp, icmp
  src, dst  outer IPv4 addresses
  flow      "src>dst#id/proto" of the innermost datagram, used to follow one datagram
            across every segment of its path
  encap     tunnel mode or None, overhead in bytes when tunneled
"""
import struct

from . import encap as enc
from . import messages as m
from .ipv4 import (PROTO_GRE, PROTO_ICMP, PROTO_IPIP, PROTO_MINENC, PROTO_NAMES, PROTO_UDP,
                   b2ip, checksum)

ICMP_TYPES = {0: "Echo Reply", 3: "Destination Unreachable", 8: "Echo Request",
              9: "Router Advertisement (Agent Advertisement)", 10: "Router Solicitation (Agent Solicitation)",
              11: "Time Exceeded"}


def _f(name, value, off, ln, desc=None, bits=None):
    d = {"name": name, "value": value, "off": off, "len": ln}
    if desc:
        d["desc"] = desc
    if bits is not None:
        d["bits"] = bits
    return d


def _bits(value, table):
    return [{"name": "%s (%s)" % (n, text), "set": bool(value & bit)} for n, bit, text in table]


def _hex(b):
    return b.hex()


class _Ctx:
    def __init__(self):
        self.layers = []
        self.info = ""
        self.protocol = ""
        self.ptype = "data"
        self.flow = None
        self.encap = None
        self.overhead = 0
        self.inner = None
        self.mip = None


def dissect(datagram: bytes):
    c = _Ctx()
    outer = _ipv4(datagram, 0, c, "Internet Protocol Version 4")
    if outer is None:
        return {"layers": c.layers, "info": "malformed IPv4", "protocol": "IPv4", "ptype": "data",
                "src": "?", "dst": "?", "flow": None, "encap": None, "overhead": 0}
    return {"layers": c.layers, "info": c.info, "protocol": c.protocol, "ptype": c.ptype,
            "src": outer[0], "dst": outer[1], "flow": c.flow, "encap": c.encap,
            "overhead": c.overhead, "inner": c.inner, "mip": c.mip}


def _ipv4(d, o, c, title, depth=0):
    if len(d) - o < 20:
        c.layers.append({"name": title + " (truncated)", "off": o, "len": len(d) - o, "fields": []})
        return None
    vihl, tos, tlen, ident, ff, ttl, proto, csum = struct.unpack("!BBHHHBBH", d[o:o + 12])
    ihl = (vihl & 0xF) * 4
    src, dst = b2ip(d[o + 12:o + 16]), b2ip(d[o + 16:o + 20])
    ok = checksum(d[o:o + ihl]) == 0
    flags = ff >> 13
    fields = [
        _f("Version", "4", o, 1), _f("Header Length", "%d bytes (%d)" % (ihl, ihl // 4), o, 1),
        _f("Type of Service", "0x%02x" % tos, o + 1, 1),
        _f("Total Length", str(tlen), o + 2, 2),
        _f("Identification", "0x%04x (%d)" % (ident, ident), o + 4, 2),
        _f("Flags", "0x%x" % flags, o + 6, 1, bits=[{"name": "DF (Don't Fragment)", "set": bool(flags & 2)},
                                                     {"name": "MF (More Fragments)", "set": bool(flags & 1)}]),
        _f("Fragment Offset", str(ff & 0x1FFF), o + 6, 2),
        _f("Time to Live", str(ttl), o + 8, 1),
        _f("Protocol", "%s (%d)" % (PROTO_NAMES.get(proto, "?"), proto), o + 9, 1),
        _f("Header Checksum", "0x%04x [%s]" % (csum, "correct" if ok else "INCORRECT"), o + 10, 2),
        _f("Source Address", src, o + 12, 4), _f("Destination Address", dst, o + 16, 4),
    ]
    c.layers.append({"name": "%s, Src: %s, Dst: %s" % (title, src, dst), "off": o, "len": ihl, "fields": fields})
    end = min(len(d), o + tlen)
    p = o + ihl
    if depth == 0:
        c.flow = "%s>%s#%d/%d" % (src, dst, ident, proto)
    if proto == PROTO_IPIP and depth < 4:
        c.encap = c.encap or "ipip"
        c.overhead += 20
        c.protocol += "IPIP|"
        c.ptype = "tunnel"
        c.layers.append({"name": "IP-in-IP encapsulation (RFC 2003), overhead 20 bytes", "off": o, "len": ihl,
                         "fields": [_f("Outer header", "%s -> %s" % (src, dst), o, ihl,
                                       "Tunnel entry and exit points. Inner TTL was decremented by the encapsulator.")]})
        inner = _ipv4(d, p, c, "Inner Internet Protocol Version 4", depth + 1)
        if inner:
            c.inner = c.inner or {"src": inner[0], "dst": inner[1]}
        return src, dst
    if proto == PROTO_GRE and depth < 4 and end - p >= 4:
        gflags, ptype = struct.unpack("!HH", d[p:p + 4])
        hl = 8 if gflags & 0x8000 else 4
        c.encap = c.encap or "gre"
        c.overhead += 20 + hl
        c.protocol += "GRE|"
        c.ptype = "tunnel"
        gf = [_f("Flags and Version", "0x%04x" % gflags, p, 2,
                 bits=[{"name": "C (Checksum present)", "set": bool(gflags & 0x8000)}]),
              _f("Protocol Type", "0x%04x (IPv4)" % ptype, p + 2, 2)]
        if hl == 8:
            gf.append(_f("Checksum", "0x%04x" % struct.unpack("!H", d[p + 4:p + 6])[0], p + 4, 2))
        c.layers.append({"name": "Generic Routing Encapsulation (RFC 2784), overhead %d bytes" % (20 + hl),
                         "off": p, "len": hl, "fields": gf})
        inner = _ipv4(d, p + hl, c, "Inner Internet Protocol Version 4", depth + 1)
        if inner:
            c.inner = c.inner or {"src": inner[0], "dst": inner[1]}
        return src, dst
    if proto == PROTO_MINENC and depth < 4 and end - p >= 8:
        iproto, sb = d[p], d[p + 1]
        s_bit = bool(sb & 0x80)
        fl = 12 if s_bit else 8
        mcs = struct.unpack("!H", d[p + 2:p + 4])[0]
        okm = checksum(d[p:p + fl]) == 0
        odst = b2ip(d[p + 4:p + 8])
        osrc = b2ip(d[p + 8:p + 12]) if s_bit else src
        c.encap = c.encap or "minimal"
        c.overhead += fl
        c.protocol += "MINENC|"
        c.ptype = "tunnel"
        mf = [_f("Protocol", "%s (%d)" % (PROTO_NAMES.get(iproto, "?"), iproto), p, 1),
              _f("S bit", "1 (original source present)" if s_bit else "0", p + 1, 1),
              _f("Header Checksum", "0x%04x [%s]" % (mcs, "correct" if okm else "INCORRECT"), p + 2, 2),
              _f("Original Destination Address", odst, p + 4, 4)]
        if s_bit:
            mf.append(_f("Original Source Address", osrc, p + 8, 4))
        c.layers.append({"name": "Minimal Forwarding Header (RFC 2004), overhead %d bytes" % fl,
                         "off": p, "len": fl, "fields": mf})
        c.inner = c.inner or {"src": osrc, "dst": odst}
        c.flow = "%s>%s#%d/%d" % (osrc, odst, ident, iproto)
        _transport(d, p + fl, end, iproto, osrc, odst, c)
        return src, dst
    if depth > 0:
        c.flow = "%s>%s#%d/%d" % (src, dst, ident, proto)
    _transport(d, p, end, proto, src, dst, c)
    return src, dst


def _transport(d, p, end, proto, src, dst, c):
    if proto == PROTO_UDP:
        _udp(d, p, end, src, dst, c)
    elif proto == PROTO_ICMP:
        _icmp(d, p, end, c)
    else:
        c.protocol += PROTO_NAMES.get(proto, str(proto))
        c.info = c.info or "IP protocol %d, %d bytes" % (proto, end - p)


def _udp(d, p, end, src, dst, c):
    if end - p < 8:
        c.protocol += "UDP"
        c.info = "truncated UDP"
        return
    sp, dp, ln, cs = struct.unpack("!HHHH", d[p:p + 8])
    c.layers.append({"name": "User Datagram Protocol, Src Port: %d, Dst Port: %d" % (sp, dp), "off": p, "len": 8,
                     "fields": [_f("Source Port", str(sp), p, 2), _f("Destination Port", str(dp), p + 2, 2),
                                _f("Length", str(ln), p + 4, 2), _f("Checksum", "0x%04x" % cs, p + 6, 2)]})
    body = d[p + 8:min(end, p + ln)]
    if sp == 434 or dp == 434:
        _mip(body, p + 8, c)
    elif body[:4] == b"MIPV":
        seq, ts, tag = struct.unpack("!IdB", body[4:17])
        route = "direct (binding cache)" if tag == 1 else "via home address"
        c.layers.append({"name": "Stream data (simulator application payload)", "off": p + 8, "len": len(body),
                         "fields": [_f("Magic", "MIPV", p + 8, 4), _f("Sequence", str(seq), p + 12, 4),
                                    _f("Send time (ms)", "%.1f" % ts, p + 16, 8),
                                    _f("CN route tag", "%d, %s" % (tag, route), p + 24, 1),
                                    _f("Padding", "%d bytes" % (len(body) - 17), p + 25, max(0, len(body) - 17))]})
        c.protocol += "UDP"
        c.info = "Stream seq=%d %d->%d len=%d (%s)" % (seq, sp, dp, len(body), route)
    elif body[:4] == b"MIPR":
        seq = struct.unpack("!I", body[4:8])[0]
        c.layers.append({"name": "Stream reply (simulator application payload)", "off": p + 8, "len": len(body),
                         "fields": [_f("Magic", "MIPR", p + 8, 4), _f("Echoed sequence", str(seq), p + 12, 4)]})
        c.protocol += "UDP"
        c.info = "Stream reply for seq=%d %d->%d" % (seq, sp, dp)
    else:
        c.protocol += "UDP"
        c.info = "%d -> %d len=%d" % (sp, dp, len(body))


def _icmp(d, p, end, c):
    body = d[p:end]
    if len(body) < 4:
        c.protocol += "ICMP"
        c.info = "truncated ICMP"
        return
    t, code, cs = struct.unpack("!BBH", body[:4])
    ok = checksum(body) == 0
    base = [_f("Type", "%d (%s)" % (t, ICMP_TYPES.get(t, "?")), p, 1), _f("Code", str(code), p + 1, 1),
            _f("Checksum", "0x%04x [%s]" % (cs, "correct" if ok else "INCORRECT"), p + 2, 2)]
    if t == 9:
        c.ptype = "adv"
        c.protocol += "MIP-Adv"
        try:
            adv = m.AgentAdvertisement.unpack(body)
        except m.MalformedMessage as e:
            c.info = "malformed Agent Advertisement: %s" % e
            c.layers.append({"name": "Internet Control Message Protocol", "off": p, "len": len(body), "fields": base})
            return
        n = len(adv.router_addrs)
        base += [_f("Number of Addresses", str(n), p + 4, 1), _f("Address Entry Size", "2", p + 5, 1),
                 _f("Lifetime", "%d s (movement detection timer)" % adv.lifetime, p + 6, 2)]
        for i, (a, pref) in enumerate(adv.router_addrs):
            base.append(_f("Router Address %d" % (i + 1), "%s, preference %d" % (a, pref), p + 8 + 8 * i, 8))
        c.layers.append({"name": "ICMP Router Advertisement (RFC 1256)", "off": p, "len": 8 + 8 * n, "fields": base})
        e = p + 8 + 8 * n
        ml = 6 + 4 * len(adv.coas)
        mf = [_f("Type", "16 (Mobility Agent Advertisement)", e, 1), _f("Length", str(ml), e + 1, 1),
              _f("Sequence Number", str(adv.seq), e + 2, 2,
                 "Rolls from 0xffff to 256. A value below 256 after a higher one means the agent rebooted."),
              _f("Registration Lifetime", "%d s" % adv.reg_lifetime, e + 4, 2),
              _f("Flags", m.flag_names(adv.flags, m.AD_FLAGS), e + 6, 1, bits=_bits(adv.flags, m.AD_FLAGS)),
              _f("Reserved", "0", e + 7, 1)]
        for i, coa in enumerate(adv.coas):
            mf.append(_f("Care-of Address %d" % (i + 1), coa, e + 8 + 4 * i, 4))
        c.layers.append({"name": "Mobility Agent Advertisement Extension (RFC 3344 section 2.1.1)",
                         "off": e, "len": 2 + ml, "fields": mf})
        if adv.prefix_lengths is not None:
            pe = e + 2 + ml
            c.layers.append({"name": "Prefix-Lengths Extension (RFC 3344 section 2.1.2)", "off": pe,
                             "len": 2 + len(adv.prefix_lengths),
                             "fields": [_f("Type", "19", pe, 1), _f("Length", str(len(adv.prefix_lengths)), pe + 1, 1)] +
                             [_f("Prefix Length %d" % (i + 1), "/%d" % v, pe + 2 + i, 1) for i, v in enumerate(adv.prefix_lengths)]})
        role = "HA" if adv.flags & m.AD_H else ""
        role += "+FA" if role and adv.flags & m.AD_F else ("FA" if adv.flags & m.AD_F else "")
        c.info = "Agent Advertisement %s seq=%d lifetime=%ds reg-lifetime=%ds flags=%s CoA=%s" % (
            role, adv.seq, adv.lifetime, adv.reg_lifetime, m.flag_names(adv.flags, m.AD_FLAGS),
            ",".join(adv.coas) or "-")
        c.mip = {"type": "adv", "seq": adv.seq}
        return
    if t == 10:
        c.ptype = "adv"
        c.protocol += "MIP-Sol"
        c.layers.append({"name": "ICMP Router Solicitation (Agent Solicitation, RFC 3344 section 2.2)",
                         "off": p, "len": len(body), "fields": base + [_f("Reserved", "0", p + 4, 4)]})
        c.info = "Agent Solicitation"
        return
    c.ptype = "icmp" if t not in (0, 8) else "data"
    c.protocol += "ICMP"
    extra = []
    if t in (0, 8) and len(body) >= 8:
        i, s = struct.unpack("!HH", body[4:8])
        extra = [_f("Identifier", str(i), p + 4, 2), _f("Sequence", str(s), p + 6, 2)]
        c.info = "Echo %s id=%d seq=%d" % ("reply" if t == 0 else "request", i, s)
    else:
        c.info = "%s code %d" % (ICMP_TYPES.get(t, "ICMP type %d" % t), code)
    c.layers.append({"name": "Internet Control Message Protocol", "off": p, "len": len(body), "fields": base + extra})


def _ext_fields(exts, base, raw):
    out = []
    for e in exts:
        o = base + e.offset
        fl = [_f("Type", "%d (%s)" % (e.type, e.name), o, 1)]
        if e.type != m.EXT_PAD:
            fl.append(_f("Length", str(len(e.body)), o + 1, 1))
        if e.type in (m.EXT_MH_AUTH, m.EXT_MF_AUTH, m.EXT_FH_AUTH, m.EXT_RO_AUTH) and len(e.body) >= 4:
            spi = struct.unpack("!I", e.body[:4])[0]
            fl += [_f("SPI", "%d (0x%08x)" % (spi, spi), o + 2, 4),
                   _f("Authenticator", _hex(e.body[4:]), o + 6, len(e.body) - 4,
                      "keyed-MD5 prefix+suffix: MD5(key | protected bytes | key), RFC 3344 section 3.5.1")]
        elif e.type == m.EXT_PREV_FA_NOTIFY and len(e.body) == 12:
            life, fa, coa = m.parse_prev_fa_ext(e)
            fl += [_f("Cache Lifetime", "%d s" % life, o + 2, 2), _f("Previous FA", fa, o + 6, 4),
                   _f("Previous CoA", coa, o + 10, 4)]
        out.append({"name": "%s Extension (type %d)" % (e.name, e.type), "off": o, "len": 1 + (0 if e.type == 0 else 1 + len(e.body)),
                    "fields": fl})
    return out


def _mip(body, o, c):
    c.protocol += "MIPv4"
    try:
        msg = m.parse_mip_udp(body)
    except m.MalformedMessage as e:
        c.ptype = "reg"
        c.info = "malformed Mobile IP message: %s" % e
        c.layers.append({"name": "Mobile IP (malformed)", "off": o, "len": len(body), "fields": []})
        return
    if isinstance(msg, m.RegistrationRequest):
        c.ptype = "reg"
        f = [_f("Type", "1 (Registration Request)", o, 1),
             _f("Flags", m.flag_names(msg.flags, m.REQ_FLAGS), o + 1, 1, bits=_bits(msg.flags, m.REQ_FLAGS)),
             _f("Lifetime", "%d s%s" % (msg.lifetime, " (deregistration)" if msg.lifetime == 0 else ""), o + 2, 2),
             _f("Home Address", msg.home_addr, o + 4, 4), _f("Home Agent", msg.home_agent, o + 8, 4),
             _f("Care-of Address", msg.coa, o + 12, 4),
             _f("Identification", "0x%016x" % msg.ident, o + 16, 8,
                "High 32 bits: NTP seconds (timestamp mode) or HA nonce (nonce mode).")]
        c.layers.append({"name": "Mobile IP Registration Request (RFC 3344 section 3.3)", "off": o, "len": 24, "fields": f})
        c.layers += _ext_fields(msg.extensions, o, body)
        c.info = "Registration Request HoA=%s HA=%s CoA=%s lifetime=%d flags=%s id=%016x" % (
            msg.home_addr, msg.home_agent, msg.coa, msg.lifetime, m.flag_names(msg.flags, m.REQ_FLAGS), msg.ident)
        c.mip = {"type": "reg_request", "home": msg.home_addr, "coa": msg.coa, "ident": "%016x" % msg.ident}
    elif isinstance(msg, m.RegistrationReply):
        c.ptype = "reg"
        f = [_f("Type", "3 (Registration Reply)", o, 1),
             _f("Code", m.code_text(msg.code), o + 1, 1),
             _f("Lifetime", "%d s" % msg.lifetime, o + 2, 2),
             _f("Home Address", msg.home_addr, o + 4, 4), _f("Home Agent", msg.home_agent, o + 8, 4),
             _f("Identification", "0x%016x" % msg.ident, o + 12, 8)]
        c.layers.append({"name": "Mobile IP Registration Reply (RFC 3344 section 3.4)", "off": o, "len": 20, "fields": f})
        c.layers += _ext_fields(msg.extensions, o, body)
        c.info = "Registration Reply code=%d (%s) HoA=%s lifetime=%d" % (
            msg.code, m.REPLY_CODES.get(msg.code, "?"), msg.home_addr, msg.lifetime)
        c.mip = {"type": "reg_reply", "home": msg.home_addr, "code": msg.code}
    elif isinstance(msg, m.BindingUpdate):
        c.ptype = "bu"
        f = [_f("Type", "18 (Binding Update)", o, 1),
             _f("Flags", m.flag_names(msg.flags, m.BU_FLAGS), o + 1, 1, bits=_bits(msg.flags, m.BU_FLAGS)),
             _f("Lifetime", "%d s" % msg.lifetime, o + 2, 2), _f("Mobile Node Home Address", msg.home_addr, o + 4, 4),
             _f("Care-of Address", msg.coa, o + 8, 4), _f("Identification", "0x%016x" % msg.ident, o + 12, 8)]
        c.layers.append({"name": "Binding Update (Mobile IPv4 Route Optimization draft)", "off": o, "len": 20, "fields": f})
        c.layers += _ext_fields(msg.extensions, o, body)
        c.info = "Binding Update HoA=%s CoA=%s lifetime=%d flags=%s" % (
            msg.home_addr, msg.coa, msg.lifetime, m.flag_names(msg.flags, m.BU_FLAGS))
    elif isinstance(msg, m.BindingAck):
        c.ptype = "bu"
        c.layers.append({"name": "Binding Acknowledge (Route Optimization draft)", "off": o, "len": 16,
                         "fields": [_f("Type", "19 (Binding Acknowledge)", o, 1),
                                    _f("N flag", "negative" if msg.negative else "positive", o + 1, 1),
                                    _f("Mobile Node Home Address", msg.home_addr, o + 4, 4),
                                    _f("Identification", "0x%016x" % msg.ident, o + 8, 8)]})
        c.info = "Binding Acknowledge HoA=%s%s" % (msg.home_addr, " NEGATIVE" if msg.negative else "")
    elif isinstance(msg, m.BindingWarning):
        c.ptype = "bu"
        c.layers.append({"name": "Binding Warning (Route Optimization draft)", "off": o, "len": 12,
                         "fields": [_f("Type", "16 (Binding Warning)", o, 1),
                                    _f("Mobile Node Home Address", msg.home_addr, o + 4, 4),
                                    _f("Target Node Address", msg.target, o + 8, 4,
                                       "Correspondent that is using a stale or missing binding")]})
        c.info = "Binding Warning HoA=%s target=%s" % (msg.home_addr, msg.target)
    elif isinstance(msg, m.BindingRequest):
        c.ptype = "bu"
        c.layers.append({"name": "Binding Request (Route Optimization draft)", "off": o, "len": 16,
                         "fields": [_f("Type", "17 (Binding Request)", o, 1),
                                    _f("Mobile Node Home Address", msg.home_addr, o + 4, 4),
                                    _f("Identification", "0x%016x" % msg.ident, o + 8, 8)]})
        c.info = "Binding Request HoA=%s" % msg.home_addr


def dissect_arp(data: bytes):
    a = m.parse_arp(data)
    grat = a["spa"] == a["tpa"]
    fields = [_f("Hardware type", "Ethernet (1)", 0, 2), _f("Protocol type", "IPv4 (0x0800)", 2, 2),
              _f("Hardware size", "6", 4, 1), _f("Protocol size", "4", 5, 1),
              _f("Opcode", "%s (%d)" % ("request" if a["op"] == 1 else "reply", a["op"]), 6, 2),
              _f("Sender MAC", ":".join("%02x" % x for x in a["sha"]), 8, 6), _f("Sender IP", a["spa"], 14, 4),
              _f("Target MAC", ":".join("%02x" % x for x in a["tha"]), 18, 6), _f("Target IP", a["tpa"], 24, 4)]
    info = ("Gratuitous ARP for %s is-at %s" if grat else "ARP %s is-at %s") % (
        a["spa"], ":".join("%02x" % x for x in a["sha"]))
    return {"layers": [{"name": "Address Resolution Protocol (%s)" % ("gratuitous" if grat else "request"),
                        "off": 0, "len": 28, "fields": fields}],
            "info": info, "protocol": "ARP", "ptype": "arp", "src": a["spa"], "dst": a["tpa"],
            "flow": None, "encap": None, "overhead": 0}
