"""Authentication and replay protection for Mobile IPv4 (RFC 3344 sections 3.5 and 5.4-5.7).

The default algorithm in RFC 3344 is keyed-MD5 in "prefix+suffix" mode:
    authenticator = MD5(key || protected data || key)
where the protected data is the UDP payload of the registration message up to and including
the Type, Length and SPI fields of the authentication extension itself.

Replay protection is selectable:
  * timestamp - the high 32 bits of the 64-bit Identification are NTP seconds. The HA rejects
    a request that is more than replay_window_s away from its own clock, and also any request
    whose Identification is not strictly greater than the last one it accepted.
  * nonce     - the high 32 bits must echo the nonce the HA handed out in its previous reply.
    The low 32 bits are the MN's own nonce, which the HA copies back so the MN can match.
"""
import hashlib
import hmac
import random
import time

NTP_UNIX_OFFSET = 2208988800  # seconds between 1900-01-01 and 1970-01-01


def keyed_md5(key: bytes, data: bytes) -> bytes:
    """RFC 3344 section 3.5.1 prefix+suffix keyed MD5."""
    return hashlib.md5(key + data + key).digest()


def constant_time_equal(a: bytes, b: bytes) -> bool:
    return hmac.compare_digest(a, b)


def ntp_now(skew_s: float = 0.0) -> float:
    return time.time() + NTP_UNIX_OFFSET + skew_s


def ntp_ident(skew_s: float = 0.0, last: int = 0) -> int:
    """64-bit NTP-format timestamp identification, forced to be strictly increasing."""
    t = ntp_now(skew_s)
    ident = (int(t) << 32) | int((t - int(t)) * (1 << 32))
    return max(ident, last + 1) & 0xFFFFFFFFFFFFFFFF


def ident_high(ident):
    return (ident >> 32) & 0xFFFFFFFF


def ident_low(ident):
    return ident & 0xFFFFFFFF


class ReplayGuard:
    """Home agent side replay check, one record per mobile node home address."""

    def __init__(self, mode="timestamp", window_s=7):
        self.mode = mode
        self.window_s = window_s
        self.last_accepted = {}   # home address -> last accepted identification
        self.nonces = {}          # home address -> nonce the HA expects next

    def set_mode(self, mode):
        if mode != self.mode:
            self.mode = mode
            self.last_accepted.clear()
            self.nonces.clear()

    def check(self, home, ident, now_ntp=None):
        """Return (accepted, reply_identification, reason)."""
        lo = ident_low(ident)
        if self.mode == "nonce":
            expected = self.nonces.get(home)
            if expected is None or ident_high(ident) != expected:
                # Hand out the current nonce rather than a new one, so a replayed request
                # cannot push the genuine mobile node out of step.
                if expected is None:
                    expected = self.nonces[home] = random.getrandbits(32)
                return False, (expected << 32) | lo, "nonce mismatch (HA expects 0x%08x)" % expected
            fresh = random.getrandbits(32)
            self.nonces[home] = fresh
            self.last_accepted[home] = ident
            return True, (fresh << 32) | lo, "nonce matched"
        now = int(now_ntp if now_ntp is not None else ntp_now())
        hi = ident_high(ident)
        if abs(hi - now) > self.window_s:
            return False, (now << 32) | lo, "timestamp off by %d s (window %d s)" % (hi - now, self.window_s)
        last = self.last_accepted.get(home)
        if last is not None and ident <= last:
            return False, (now << 32) | lo, "identification not newer than last accepted (replay)"
        self.last_accepted[home] = ident
        return True, ident, "timestamp fresh"


class MobileIdent:
    """Mobile node side identification generator that follows the HA's corrections."""

    def __init__(self, mode="timestamp", skew_s=0.0):
        self.mode = mode
        self.skew_s = skew_s
        self.offset_s = 0.0          # learned correction from a code 133 reply
        self.ha_nonce = None
        self.last = 0

    def next(self):
        if self.mode == "nonce":
            hi = self.ha_nonce if self.ha_nonce is not None else random.getrandbits(32)
            ident = (hi << 32) | random.getrandbits(32)
        else:
            ident = ntp_ident(self.skew_s + self.offset_s, self.last)
        self.last = ident
        return ident

    def learn_from_reply(self, reply_ident, accepted):
        """Adopt the HA nonce, or resynchronise the clock after a 133 in timestamp mode."""
        if self.mode == "nonce":
            self.ha_nonce = ident_high(reply_ident)
        elif not accepted:
            self.offset_s += ident_high(reply_ident) - int(ntp_now(self.skew_s + self.offset_s))

    def reply_matches(self, request_ident, reply_ident):
        # In both modes the HA copies the low-order 32 bits back unchanged.
        return ident_low(request_ident) == ident_low(reply_ident)
