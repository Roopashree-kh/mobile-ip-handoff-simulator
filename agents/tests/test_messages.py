"""Encode/decode round trips for every Mobile IPv4 message type."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mip import ipv4, messages as m  # noqa: E402


class AdvertisementTests(unittest.TestCase):
    def test_round_trip(self):
        adv = m.AgentAdvertisement([("10.3.0.1", 0)], 3, 4242, 30,
                                   m.AD_R | m.AD_F | m.AD_M | m.AD_G | m.AD_T, ["10.3.0.1"], [24])
        raw = adv.pack()
        self.assertEqual(raw[0], 9)
        self.assertEqual(ipv4.checksum(raw), 0)
        back = m.AgentAdvertisement.unpack(raw)
        self.assertEqual((back.lifetime, back.seq, back.reg_lifetime, back.flags, back.coas, back.prefix_lengths),
                         (3, 4242, 30, adv.flags, ["10.3.0.1"], [24]))
        # extension 16 length = 6 + 4 * number of CoAs
        self.assertEqual(raw[16:18], bytes([16, 10]))

    def test_home_agent_with_no_coa(self):
        adv = m.AgentAdvertisement([("10.1.0.1", 0)], 3, 1, 60, m.AD_H, [], [24])
        self.assertEqual(m.AgentAdvertisement.unpack(adv.pack()).coas, [])

    def test_corrupt_checksum_rejected(self):
        raw = bytearray(m.AgentAdvertisement([("10.2.0.1", 0)], 3, 1, 30, m.AD_F, ["10.2.0.1"]).pack())
        raw[-1] ^= 1
        with self.assertRaises(m.MalformedMessage):
            m.AgentAdvertisement.unpack(bytes(raw))

    def test_solicitation(self):
        t, c, body, ok = ipv4.parse_icmp(m.build_solicitation())
        self.assertEqual((t, c, ok, len(body)), (10, 0, True, 4))


class SequenceTests(unittest.TestCase):
    def test_rollover_goes_to_256(self):
        self.assertEqual(m.next_adv_seq(0xFFFE), 0xFFFF)
        self.assertEqual(m.next_adv_seq(0xFFFF), 256)
        self.assertEqual(m.next_adv_seq(0), 1)

    def test_rollover_is_not_a_reboot(self):
        self.assertFalse(m.agent_rebooted(0xFFFF, 256))
        self.assertFalse(m.agent_rebooted(10, 11))
        self.assertFalse(m.agent_rebooted(None, 0))

    def test_reboot_detected(self):
        self.assertTrue(m.agent_rebooted(5000, 0))
        self.assertTrue(m.agent_rebooted(0xFFFF, 3))
        self.assertTrue(m.agent_rebooted(40, 1))
        self.assertFalse(m.agent_rebooted(5000, 300))  # out of order, not a reboot


class RegistrationTests(unittest.TestCase):
    def test_request_layout_and_round_trip(self):
        req = m.RegistrationRequest(m.REQ_S | m.REQ_G | m.REQ_T, 30, "10.1.0.50", "10.1.0.1", "10.3.0.1",
                                    0x1122334455667788)
        raw = req.pack()
        self.assertEqual(len(raw), 24)
        self.assertEqual(raw[:4], bytes([1, 0x80 | 0x08 | 0x02, 0, 30]))
        self.assertEqual(raw[16:24], bytes.fromhex("1122334455667788"))
        back = m.RegistrationRequest.unpack(raw)
        self.assertEqual((back.flags, back.lifetime, back.home_addr, back.home_agent, back.coa, back.ident),
                         (req.flags, 30, "10.1.0.50", "10.1.0.1", "10.3.0.1", req.ident))

    def test_request_with_auth_and_prev_fa(self):
        key = bytes(16)
        base = m.RegistrationRequest(0, 20, "10.1.0.50", "10.1.0.1", "10.2.0.1", 99).pack()
        raw = m.append_auth(base, m.EXT_MH_AUTH, 256, key) + m.prev_fa_ext(10, "10.4.0.1", "10.4.0.1").pack()
        req = m.RegistrationRequest.unpack(raw)
        self.assertEqual([e.type for e in req.extensions], [m.EXT_MH_AUTH, m.EXT_PREV_FA_NOTIFY])
        mh = req.extensions[0]
        self.assertEqual(m.auth_ext_spi(mh), 256)
        self.assertTrue(m.verify_auth(raw, mh, key))
        self.assertEqual(m.parse_prev_fa_ext(req.extensions[1]), (10, "10.4.0.1", "10.4.0.1"))

    def test_reply_round_trip(self):
        rep = m.RegistrationReply(133, 0, "10.1.0.50", "10.1.0.1", 0xAABBCCDD00112233)
        raw = rep.pack()
        self.assertEqual(len(raw), 20)
        back = m.RegistrationReply.unpack(raw)
        self.assertEqual((back.code, back.lifetime, back.ident), (133, 0, rep.ident))
        self.assertIn("Identification mismatch", m.code_text(133))

    def test_truncated_request_is_malformed(self):
        raw = m.RegistrationRequest(0, 20, "10.1.0.50", "10.1.0.1", "10.2.0.1", 1).pack()
        with self.assertRaises(m.MalformedMessage):
            m.RegistrationRequest.unpack(raw[:20])
        with self.assertRaises(m.MalformedMessage):
            m.RegistrationRequest.unpack(raw + bytes([32, 20, 0]))  # extension overruns


class RouteOptimizationTests(unittest.TestCase):
    def test_binding_update(self):
        bu = m.BindingUpdate(m.BU_A | m.BU_M, 20, "10.1.0.50", "10.3.0.1", 7)
        back = m.parse_mip_udp(bu.pack())
        self.assertIsInstance(back, m.BindingUpdate)
        self.assertEqual((back.lifetime, back.home_addr, back.coa, back.ident, back.encapsulation),
                         (20, "10.1.0.50", "10.3.0.1", 7, "minimal"))
        self.assertTrue(back.flags & m.BU_A)

    def test_ack_warning_request(self):
        a = m.parse_mip_udp(m.BindingAck("10.1.0.50", 5, negative=True).pack())
        self.assertTrue(a.negative)
        w = m.parse_mip_udp(m.BindingWarning("10.1.0.50", "10.9.0.10").pack())
        self.assertEqual((w.home_addr, w.target), ("10.1.0.50", "10.9.0.10"))
        r = m.parse_mip_udp(m.BindingRequest("10.1.0.50", 77).pack())
        self.assertEqual(r.ident, 77)


class ArpTests(unittest.TestCase):
    def test_gratuitous(self):
        a = m.parse_arp(m.gratuitous_arp(b"\x02\x00\x5e\x00\x00\x02", "10.1.0.50"))
        self.assertEqual((a["op"], a["spa"], a["tpa"]), (1, "10.1.0.50", "10.1.0.50"))


if __name__ == "__main__":
    unittest.main()
