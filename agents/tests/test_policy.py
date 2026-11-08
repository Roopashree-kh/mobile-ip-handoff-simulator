"""Foreign agent denial codes and home agent binding expiry."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mip import decode, messages as m, policy  # noqa: E402
from mip import ipv4  # noqa: E402

FA = {"max_lifetime": 30, "max_visitors": 2, "encapsulations": ["ipip", "minimal"], "reverse_tunnel": False,
      "require_mf_auth": False}
KEY = bytes(16)


def request(flags=0, lifetime=20, coa="10.4.0.1", auth=True, mf_key=None):
    raw = m.RegistrationRequest(flags, lifetime, "10.1.0.50", "10.1.0.1", coa, 1).pack()
    if auth:
        raw = m.append_auth(raw, m.EXT_MH_AUTH, 256, KEY)
    if mf_key:
        raw = m.append_auth(raw, m.EXT_MF_AUTH, 257, mf_key)
    return m.RegistrationRequest.unpack(raw), raw


class ForeignAgentDenialTests(unittest.TestCase):
    def code(self, req_raw, cfg=FA, visitors=0, sa=None):
        return policy.fa_validate(req_raw[0], req_raw[1], cfg, ["10.4.0.1"], visitors, sa)[0]

    def test_accept(self):
        self.assertIsNone(self.code(request()))

    def test_69_lifetime_too_long(self):
        self.assertEqual(self.code(request(lifetime=31)), 69)

    def test_70_poorly_formed(self):
        self.assertEqual(self.code(request(flags=m.REQ_x)), 70)
        self.assertEqual(self.code(request(auth=False)), 70)

    def test_72_encapsulation_unavailable(self):
        self.assertEqual(self.code(request(flags=m.REQ_G)), 72)
        self.assertIsNone(self.code(request(flags=m.REQ_M)))

    def test_74_reverse_tunnel_unavailable(self):
        self.assertEqual(self.code(request(flags=m.REQ_T)), 74)

    def test_77_invalid_coa(self):
        self.assertEqual(self.code(request(coa="10.4.0.99")), 77)

    def test_66_insufficient_resources(self):
        self.assertEqual(self.code(request(), visitors=2), 66)

    def test_67_mobile_foreign_auth(self):
        cfg = dict(FA, require_mf_auth=True)
        self.assertEqual(self.code(request(), cfg, sa=(257, b"k" * 16)), 67)
        self.assertEqual(self.code(request(mf_key=b"x" * 16), cfg, sa=(257, b"k" * 16)), 67)
        self.assertIsNone(self.code(request(mf_key=b"k" * 16), cfg, sa=(257, b"k" * 16)))

    def test_every_code_has_text(self):
        for c in (64, 65, 66, 67, 68, 69, 70, 71, 72, 77, 78, 80, 88, 128, 131, 133, 136):
            self.assertIn(str(c), m.code_text(c))


class BindingTableTests(unittest.TestCase):
    def test_replace_and_expire(self):
        t = policy.BindingTable()
        t.update("10.1.0.50", "10.2.0.1", 10, 1, "ipip", False, "FA-1", simultaneous=False, now=100)
        t.update("10.1.0.50", "10.3.0.1", 10, 2, "ipip", False, "FA-2", simultaneous=False, now=101)
        self.assertEqual([b.coa for b in t.lookup("10.1.0.50", now=105)], ["10.3.0.1"])
        self.assertEqual(t.lookup("10.1.0.50", now=111.5), [])
        self.assertEqual([b.coa for b in t.expire(now=111.5)], ["10.3.0.1"])
        self.assertEqual(t.snapshot(now=112), [])

    def test_simultaneous_bindings(self):
        t = policy.BindingTable(max_bindings=2)
        t.update("h", "c1", 10, 1, "ipip", False, "FA-1", simultaneous=True, now=0)
        t.update("h", "c2", 5, 2, "ipip", False, "FA-2", simultaneous=True, now=0)
        self.assertEqual(sorted(b.coa for b in t.lookup("h", now=1)), ["c1", "c2"])
        with self.assertRaises(policy.TooManyBindings):
            t.update("h", "c3", 10, 3, "ipip", False, "FA-3", simultaneous=True, now=0)
        t.expire(now=6)
        self.assertEqual([b.coa for b in t.lookup("h", now=6)], ["c1"])

    def test_deregistration_removes_all(self):
        t = policy.BindingTable()
        t.update("h", "c1", 10, 1, "ipip", False, "FA-1", simultaneous=True, now=0)
        t.update("h", "c2", 10, 1, "ipip", False, "FA-2", simultaneous=True, now=0)
        t.remove("h")
        self.assertEqual(t.lookup("h", now=1), [])


class DissectorTests(unittest.TestCase):
    """The dashboard tree must decode every message the agents send."""

    def test_registration_request_tree(self):
        _, raw = request(flags=m.REQ_T)
        d = decode.dissect(ipv4.build_udp_datagram("10.1.0.50", "10.4.0.1", 49434, 434, raw))
        self.assertEqual(d["ptype"], "reg")
        names = [layer["name"] for layer in d["layers"]]
        self.assertTrue(any("Registration Request" in n for n in names))
        self.assertTrue(any("Mobile-Home Authentication" in n for n in names))

    def test_tunneled_stream_flow_key_matches_inner(self):
        from mip import encap
        inner = ipv4.build_udp_datagram("10.9.0.10", "10.1.0.50", 5004, 6000, b"MIPV" + bytes(20))
        plain = decode.dissect(inner)
        for mode in encap.MODES:
            t = decode.dissect(encap.encapsulate(mode, inner, "10.1.0.1", "10.3.0.1"))
            self.assertEqual(t["ptype"], "tunnel")
            self.assertEqual(t["flow"], plain["flow"], mode)
            self.assertEqual(t["overhead"], encap.overhead(mode))


if __name__ == "__main__":
    unittest.main()
