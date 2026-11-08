"""Keyed-MD5 authentication and replay protection."""
import hashlib
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mip import auth, messages as m, policy  # noqa: E402

KEY = bytes.fromhex("4d6f62696c6549507634486f6d654b31")
HA_CFG = {"encapsulations": ["ipip", "minimal", "gre"], "reverse_tunnel": True, "simultaneous_supported": True}


def signed_request(key=KEY, ident=None, spi=256, flags=0, ha="10.1.0.1"):
    ident = ident if ident is not None else auth.ntp_ident()
    base = m.RegistrationRequest(flags, 30, "10.1.0.50", ha, "10.3.0.1", ident).pack()
    raw = m.append_auth(base, m.EXT_MH_AUTH, spi, key)
    return m.RegistrationRequest.unpack(raw), raw


def validate(req, raw, guard=None, fh=None):
    return policy.ha_validate(req, raw, "10.1.0.1", HA_CFG, (256, KEY), fh, guard or auth.ReplayGuard())


class KeyedMd5Tests(unittest.TestCase):
    def test_prefix_suffix_definition(self):
        self.assertEqual(auth.keyed_md5(b"k", b"data"), hashlib.md5(b"kdatak").digest())

    def test_authenticator_covers_spi(self):
        req, raw = signed_request()
        ext = m.find_ext(req.extensions, m.EXT_MH_AUTH)
        protected = raw[:ext.offset + 6]
        self.assertEqual(ext.body[4:], hashlib.md5(KEY + protected + KEY).digest())

    def test_accept_and_reject(self):
        req, raw = signed_request()
        self.assertEqual(validate(req, raw)[0], 0)
        req2, raw2 = signed_request(key=bytes(16))
        self.assertEqual(validate(req2, raw2)[0], 131)

    def test_tampered_message_rejected(self):
        req, raw = signed_request()
        bad = bytearray(raw)
        bad[12:16] = bytes([10, 4, 0, 1])          # attacker rewrites the care-of address
        req2 = m.RegistrationRequest.unpack(bytes(bad))
        self.assertEqual(validate(req2, bytes(bad))[0], 131)

    def test_unknown_spi_and_wrong_ha(self):
        req, raw = signed_request(spi=999)
        self.assertEqual(validate(req, raw)[0], 131)
        req, raw = signed_request(ha="10.1.0.9")
        self.assertEqual(validate(req, raw)[0], 136)

    def test_foreign_home_auth(self):
        req, raw = signed_request()
        fh_key = b"F" * 16
        raw_fh = m.append_auth(raw, m.EXT_FH_AUTH, 301, fh_key)
        req_fh = m.RegistrationRequest.unpack(raw_fh)
        self.assertEqual(validate(req_fh, raw_fh, fh=(301, fh_key))[0], 0)
        self.assertEqual(validate(req, raw, fh=(301, fh_key))[0], 132)


class ReplayTests(unittest.TestCase):
    def test_timestamp_replay_rejected_133(self):
        guard = auth.ReplayGuard("timestamp", 7)
        req, raw = signed_request()
        self.assertEqual(validate(req, raw, guard)[0], 0)
        code, reply_ident, why = validate(req, raw, guard)
        self.assertEqual(code, 133, why)
        self.assertEqual(auth.ident_low(reply_ident), auth.ident_low(req.ident))

    def test_timestamp_outside_window(self):
        req, raw = signed_request(ident=auth.ntp_ident(skew_s=-60))
        code, reply_ident, _ = validate(req, raw, auth.ReplayGuard("timestamp", 7))
        self.assertEqual(code, 133)
        # the reply carries the HA clock so the MN can resynchronise
        self.assertLess(abs(auth.ident_high(reply_ident) - int(auth.ntp_now())), 2)

    def test_mobile_resyncs_after_133(self):
        guard = auth.ReplayGuard("timestamp", 7)
        mn = auth.MobileIdent("timestamp", skew_s=-120)
        ok, rid, _ = guard.check("10.1.0.50", mn.next())
        self.assertFalse(ok)
        mn.learn_from_reply(rid, False)
        ok, _, _ = guard.check("10.1.0.50", mn.next())
        self.assertTrue(ok)

    def test_nonce_mode(self):
        guard = auth.ReplayGuard("nonce")
        mn = auth.MobileIdent("nonce")
        ok, rid, _ = guard.check("10.1.0.50", mn.next())
        self.assertFalse(ok)                    # MN does not know the HA nonce yet
        mn.learn_from_reply(rid, False)
        second = mn.next()
        ok, rid2, _ = guard.check("10.1.0.50", second)
        self.assertTrue(ok)
        mn.learn_from_reply(rid2, True)
        ok, _, _ = guard.check("10.1.0.50", second)   # replay of an accepted request
        self.assertFalse(ok)
        ok, _, _ = guard.check("10.1.0.50", mn.next())
        self.assertTrue(ok)


if __name__ == "__main__":
    unittest.main()
