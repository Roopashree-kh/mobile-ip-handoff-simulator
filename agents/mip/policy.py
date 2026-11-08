"""Pure decision logic for the mobility agents, kept free of sockets so it can be unit tested.

fa_validate  - the checks a foreign agent makes before relaying a Registration Request
               (RFC 3344 section 3.7.1, RFC 3024 section 4) and the denial code for each.
ha_validate  - the home agent checks (RFC 3344 section 3.8.2) in the order we apply them:
               malformed, wrong HA, MN-HA auth, FA-HA auth, identification, encapsulation,
               reverse tunnel.
BindingTable - the home agent mobility binding list, with simultaneous bindings and expiry.
"""
import time

from . import messages as m
from .auth import ReplayGuard


# ---- foreign agent ---------------------------------------------------------
def fa_validate(req, raw, fa_cfg, my_coas, visitor_count, mn_fa_sa=None):
    """Return (code, reason) for a denial, or (None, None) when the request may be relayed."""
    if req.flags & (m.REQ_r | m.REQ_x):
        return 70, "reserved flag bits are not zero"
    if m.find_ext(req.extensions, m.EXT_MH_AUTH) is None:
        return 70, "no Mobile-Home Authentication extension"
    if req.lifetime > fa_cfg["max_lifetime"]:
        return 69, "requested lifetime %d s exceeds FA maximum %d s" % (req.lifetime, fa_cfg["max_lifetime"])
    if req.coa not in my_coas:
        return 77, "care-of address %s is not one this FA advertises" % req.coa
    encs = fa_cfg.get("encapsulations", ["ipip"])
    if (req.flags & m.REQ_M and "minimal" not in encs) or (req.flags & m.REQ_G and "gre" not in encs):
        return 72, "requested encapsulation is not supported here (supported: %s)" % ", ".join(encs)
    if req.flags & m.REQ_T and not fa_cfg.get("reverse_tunnel"):
        return 74, "reverse tunneling requested but not offered"
    if fa_cfg.get("require_mf_auth"):
        ext = m.find_ext(req.extensions, m.EXT_MF_AUTH)
        if ext is None or mn_fa_sa is None:
            return 67, "Mobile-Foreign Authentication extension missing"
        spi, key = mn_fa_sa
        if m.auth_ext_spi(ext) != spi or not m.verify_auth(raw, ext, key):
            return 67, "Mobile-Foreign authenticator does not verify"
    if visitor_count >= fa_cfg.get("max_visitors", 8):
        return 66, "visitor list full"
    return None, None


# ---- home agent -------------------------------------------------------------
def ha_validate(req, raw, ha_ip, ha_cfg, mh_sa, fh_sa, replay: ReplayGuard, now_ntp=None):
    """Return (code, reply_ident, reason). Code 0 or 1 means accepted.

    mh_sa = (spi, key) for this mobile node. fh_sa = (spi, key) for the relaying FA, or None
    when the request did not come through an FA with a configured security association.
    """
    if req.flags & (m.REQ_r | m.REQ_x):
        return 134, req.ident, "reserved flag bits are not zero"
    if req.home_agent != ha_ip:
        return 136, req.ident, "Home Agent field %s is not this HA (%s)" % (req.home_agent, ha_ip)
    mh = m.find_ext(req.extensions, m.EXT_MH_AUTH)
    if mh is None:
        return 131, req.ident, "Mobile-Home Authentication extension missing"
    if mh_sa is None or m.auth_ext_spi(mh) != mh_sa[0]:
        return 131, req.ident, "unknown SPI %d" % m.auth_ext_spi(mh)
    if not m.verify_auth(raw, mh, mh_sa[1]):
        return 131, req.ident, "keyed-MD5 authenticator does not verify (wrong key or altered message)"
    if fh_sa is not None:
        fh = m.find_ext(req.extensions, m.EXT_FH_AUTH)
        if fh is None or m.auth_ext_spi(fh) != fh_sa[0] or not m.verify_auth(raw, fh, fh_sa[1]):
            return 132, req.ident, "Foreign-Home authenticator missing or invalid"
    ok, reply_ident, why = replay.check(req.home_addr, req.ident, now_ntp)
    if not ok:
        return 133, reply_ident, why
    encs = ha_cfg.get("encapsulations", ["ipip"])
    if (req.flags & m.REQ_M and "minimal" not in encs) or (req.flags & m.REQ_G and "gre" not in encs):
        return 139, reply_ident, "requested encapsulation not supported by HA"
    if req.flags & m.REQ_T and not ha_cfg.get("reverse_tunnel"):
        return 137, reply_ident, "reverse tunnel not supported by HA"
    if req.flags & m.REQ_S and not ha_cfg.get("simultaneous_supported", True):
        return 1, reply_ident, "accepted, simultaneous bindings not supported"
    return 0, reply_ident, why


class TooManyBindings(Exception):
    pass


class Binding:
    __slots__ = ("home", "coa", "lifetime", "granted_at", "expires_at", "ident", "encap",
                 "reverse", "via", "colocated")

    def __init__(self, home, coa, lifetime, now, ident, encap, reverse, via, colocated=False):
        self.home, self.coa, self.lifetime = home, coa, lifetime
        self.granted_at, self.expires_at = now, now + lifetime
        self.ident, self.encap, self.reverse, self.via, self.colocated = ident, encap, reverse, via, colocated

    def remaining(self, now):
        return max(0.0, self.expires_at - now)

    def as_dict(self, now):
        return {"home": self.home, "coa": self.coa, "lifetime": self.lifetime,
                "remaining": round(self.remaining(now), 2), "expires_at": self.expires_at * 1000,
                "ident": "%016x" % self.ident, "encap": self.encap, "reverse": self.reverse,
                "via": self.via, "colocated": self.colocated}


class BindingTable:
    """Mobility binding list. Times are seconds from time.time() so the UI can count down."""

    def __init__(self, max_bindings=3):
        self.max_bindings = max_bindings
        self.table = {}

    def update(self, home, coa, lifetime, ident, encap, reverse, via, simultaneous, colocated=False, now=None):
        now = time.time() if now is None else now
        b = Binding(home, coa, lifetime, now, ident, encap, reverse, via, colocated)
        if not simultaneous:
            self.table[home] = [b]
            return b
        lst = [x for x in self.table.get(home, []) if x.coa != coa]
        if len(lst) + 1 > self.max_bindings:
            raise TooManyBindings()
        lst.append(b)
        self.table[home] = lst
        return b

    def remove(self, home, coa=None):
        if coa is None:
            return self.table.pop(home, [])
        lst = self.table.get(home, [])
        gone = [x for x in lst if x.coa == coa]
        self.table[home] = [x for x in lst if x.coa != coa]
        if not self.table[home]:
            del self.table[home]
        return gone

    def lookup(self, home, now=None):
        now = time.time() if now is None else now
        return [b for b in self.table.get(home, []) if b.expires_at > now]

    def expire(self, now=None):
        now = time.time() if now is None else now
        gone = []
        for home in list(self.table):
            keep = [b for b in self.table[home] if b.expires_at > now]
            gone += [b for b in self.table[home] if b.expires_at <= now]
            if keep:
                self.table[home] = keep
            else:
                del self.table[home]
        return gone

    def snapshot(self, now=None):
        now = time.time() if now is None else now
        return [b.as_dict(now) for lst in self.table.values() for b in lst]
