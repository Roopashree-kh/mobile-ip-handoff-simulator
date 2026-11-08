"""Virtual link-layer framing between the agents and the core router.

Every localhost UDP packet exchanged with the router starts with this 8-byte header and is
followed by a real IPv4 datagram (or a real ARP packet). The header plays the role Ethernet
plays on a real LAN: it says whether the frame is for the backbone router, for one station
on the same link, or for every station on the link.

  0  magic 0xA5
  1  version 1
  2  kind (see below)
  3  destination node id (LINK_UNICAST only)
  4  source node id
  5  reserved
  6  payload length (16 bits)
"""
import struct

MAGIC = 0xA5
VERSION = 1
HDR = struct.Struct("!BBBBBBH")

ROUTED = 0         # give the IP datagram to the backbone router
LINK_UNICAST = 1   # deliver to one station on the sender's link (like a unicast MAC frame)
LINK_BROADCAST = 2 # deliver to every station on the sender's link
ARP = 3            # payload is an ARP packet, broadcast on the sender's link
L2_NAK = 4         # router to sender: the unicast target was not on the link (missed 802.11 ACK)
ATTACH = 5         # station to router: associate with the link named in the payload
SNIFFED = 6        # router to a promiscuous station: copy of a frame seen on its link

KIND_NAMES = {ROUTED: "routed", LINK_UNICAST: "unicast", LINK_BROADCAST: "broadcast",
              ARP: "arp", L2_NAK: "l2-nak", ATTACH: "attach", SNIFFED: "sniffed"}


def frame(kind, src_id, payload: bytes, dst_id=0) -> bytes:
    return HDR.pack(MAGIC, VERSION, kind, dst_id, src_id, 0, len(payload)) + payload


def unframe(data: bytes):
    """Return (kind, dst_id, src_id, payload) or None for anything that is not our frame."""
    if len(data) < HDR.size:
        return None
    magic, ver, kind, dst, src, _, ln = HDR.unpack(data[:HDR.size])
    if magic != MAGIC or ver != VERSION:
        return None
    return kind, dst, src, data[HDR.size:HDR.size + ln]
