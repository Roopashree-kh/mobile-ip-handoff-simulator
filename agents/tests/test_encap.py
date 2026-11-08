"""IP-in-IP, Minimal and GRE encapsulation round trips and the loop guard."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mip import encap, ipv4  # noqa: E402

INNER = ipv4.build_udp_datagram("10.9.0.10", "10.1.0.50", 5004, 6000, b"video-frame" * 5, ttl=60, df=True)


class EncapTests(unittest.TestCase):
    def check_round_trip(self, mode, expected_overhead, **kw):
        outer = encap.encapsulate(mode, INNER, "10.1.0.1", "10.3.0.1", **kw)
        self.assertEqual(len(outer) - len(INNER), expected_overhead)
        h, _ = ipv4.parse_ipv4(outer)
        self.assertTrue(h.checksum_ok)
        self.assertEqual((h.src, h.dst), ("10.1.0.1", "10.3.0.1"))
        self.assertTrue(h.df, "DF must be copied to the outer header")
        got_mode, inner, _ = encap.decapsulate(outer)
        self.assertEqual(got_mode, mode)
        ih, payload = ipv4.parse_ipv4(inner)
        oh, opayload = ipv4.parse_ipv4(INNER)
        self.assertEqual((ih.src, ih.dst, ih.proto, ih.ident, payload), (oh.src, oh.dst, oh.proto, oh.ident, opayload))
        self.assertEqual(ih.ttl, 59, "inner TTL decremented once by the encapsulator")
        self.assertTrue(ih.checksum_ok)
        return outer

    def test_ipip(self):
        self.assertEqual(self.check_round_trip(encap.IPIP, 20)[9], 4)

    def test_minimal_with_s_bit(self):
        outer = self.check_round_trip(encap.MINIMAL, 12)
        self.assertEqual(outer[9], 55)
        self.assertEqual(outer[21] & 0x80, 0x80)

    def test_minimal_without_s_bit(self):
        inner = ipv4.build_udp_datagram("10.1.0.1", "10.1.0.50", 1, 2, b"x")
        outer = encap.encapsulate(encap.MINIMAL, inner, "10.1.0.1", "10.3.0.1")
        self.assertEqual(len(outer) - len(inner), 8)
        _, back, _ = encap.decapsulate(outer)
        self.assertEqual(ipv4.parse_ipv4(back)[0].src, "10.1.0.1")

    def test_gre_plain_and_checksum(self):
        self.assertEqual(self.check_round_trip(encap.GRE, 24)[9], 47)
        self.check_round_trip(encap.GRE, 28, gre_checksum=True)

    def test_overhead_table(self):
        self.assertEqual([encap.overhead(x) for x in encap.MODES], [20, 12, 24])

    def test_loop_guard_source_is_exit(self):
        inner = ipv4.build_udp_datagram("10.3.0.1", "10.1.0.50", 1, 2, b"x")
        with self.assertRaises(encap.TunnelError):
            encap.encapsulate(encap.IPIP, inner, "10.1.0.1", "10.3.0.1")

    def test_loop_guard_nesting(self):
        d = INNER
        for i in range(3):
            d = encap.encapsulate(encap.IPIP, d, "10.1.0.%d" % (i + 2), "10.2.0.%d" % (i + 2))
        self.assertEqual(encap.nesting_depth(d), 3)
        with self.assertRaises(encap.TunnelError):
            encap.encapsulate(encap.IPIP, d, "10.1.0.9", "10.2.0.9", max_nesting=3)

    def test_ttl_expired(self):
        inner = ipv4.build_udp_datagram("10.9.0.10", "10.1.0.50", 1, 2, b"x", ttl=1)
        with self.assertRaises(encap.TunnelError):
            encap.encapsulate(encap.IPIP, inner, "10.1.0.1", "10.3.0.1")

    def test_minimal_refuses_fragment(self):
        h = ipv4.IPv4Header("10.9.0.10", "10.1.0.50", 17, flags=ipv4.FLAG_MF)
        frag = h.pack(8) + b"\x00" * 8
        with self.assertRaises(encap.TunnelError):
            encap.encapsulate(encap.MINIMAL, frag, "10.1.0.1", "10.3.0.1")


if __name__ == "__main__":
    unittest.main()
