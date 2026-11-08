"""IPv4, UDP and ICMP codec tests."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mip import ipv4  # noqa: E402


class ChecksumTests(unittest.TestCase):
    def test_rfc1071_example(self):
        # Worked example from RFC 1071 section 3: words 0001 f203 f4f5 f6f7 sum to ddf2.
        data = bytes.fromhex("0001f203f4f5f6f7")
        self.assertEqual(ipv4.checksum(data), (~0xDDF2) & 0xFFFF)

    def test_known_header(self):
        # Classic textbook header, expected checksum 0xb861.
        hdr = bytes.fromhex("450000730000400040110000c0a80001c0a800c7")
        self.assertEqual(ipv4.checksum(hdr), 0xB861)

    def test_built_header_verifies_to_zero(self):
        d = ipv4.build_ipv4("10.1.0.50", "10.9.0.10", ipv4.PROTO_UDP, b"x" * 13, ttl=17, df=True)
        self.assertEqual(ipv4.checksum(d[:20]), 0)
        h, payload = ipv4.parse_ipv4(d)
        self.assertTrue(h.checksum_ok)
        self.assertEqual((h.src, h.dst, h.ttl, h.df, payload), ("10.1.0.50", "10.9.0.10", 17, True, b"x" * 13))

    def test_odd_length(self):
        self.assertEqual(ipv4.checksum(b"\x01"), (~0x0100) & 0xFFFF)

    def test_ttl_decrement_keeps_checksum_valid(self):
        d = ipv4.build_ipv4("10.0.0.1", "10.0.0.2", 17, b"abc", ttl=2)
        d2, ttl = ipv4.decrement_ttl(d)
        self.assertEqual(ttl, 1)
        self.assertEqual(ipv4.checksum(d2[:20]), 0)
        _, ttl0 = ipv4.decrement_ttl(d2)
        self.assertEqual(ttl0, 0)


class UdpIcmpTests(unittest.TestCase):
    def test_udp_round_trip_and_checksum(self):
        d = ipv4.build_udp_datagram("10.2.0.1", "10.1.0.1", 434, 434, b"hello")
        h, seg = ipv4.parse_ipv4(d)
        sp, dp, body, ok = ipv4.parse_udp(seg, h.src, h.dst)
        self.assertEqual((sp, dp, body, ok), (434, 434, b"hello", True))
        bad = bytearray(seg)
        bad[-1] ^= 0xFF
        self.assertFalse(ipv4.parse_udp(bytes(bad), h.src, h.dst)[3])

    def test_icmp_echo(self):
        d = ipv4.build_echo("10.1.0.50", "10.9.0.10", 7, 3, b"ping")
        h, icmp = ipv4.parse_ipv4(d)
        t, c, body, ok = ipv4.parse_icmp(icmp)
        self.assertEqual((t, c, ok), (8, 0, True))
        self.assertEqual(body[4:], b"ping")

    def test_rejects_short_header(self):
        with self.assertRaises(ipv4.PacketError):
            ipv4.parse_ipv4(b"\x45\x00")


if __name__ == "__main__":
    unittest.main()
