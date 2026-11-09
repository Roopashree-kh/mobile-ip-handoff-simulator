# Viva guide

## Ten-minute demo script

Start with `start.bat`, open http://localhost:5173 and press Reset once. Set the speed to 5x for the first two minutes so the examiners can follow single packets, then set it back to real time.

| Time | Who | What to do | What to point at |
|---|---|---|---|
| 0:00 to 1:00 | Member 3 | Walk the screen: top bar, map, controls, agent tables, inspector. | Five networks, the backbone cloud, the MN at home, advertisements arriving on the home link. |
| 1:00 to 2:30 | Member 1 | Start the CN stream. Drag the MN onto Metro LTE. | Solicitation, the FA-2 advertisement, the prefix rule firing, Registration Request and Reply in amber, the HA binding with its countdown, the purple tunnel pipe, the state machine moving to REGISTERED_AWAY. In the inspector, filter `reg`, open the request and hover the flags and the Mobile-Home authenticator. MN is the mobile node, CN the correspondent node, FA the foreign agent, HA the home agent. |
| 2:30 to 3:30 | Member 2 | Click a tunneled packet. Switch the encapsulation to Minimal, then GRE. | Outer header, IP-in-IP or forwarding header, inner header. Overhead 20, 12 and 24 bytes in the Analytics table. |
| 3:30 to 4:30 | Member 1 | Switch movement detection to Advertisement lifetime and drag the MN to Campus Wi-Fi. Then back to prefix and drag to the Airport. | Detection about 3 s against about 20 ms in the handoff timeline, and the losses that go with it. |
| 4:30 to 5:45 | Member 2 | Run the Ingress filter scenario. | Replies dropped with a red X at the backbone and the drop reason in the inspector. With T on, the orange reverse tunnel appears and replies reach the CN again. |
| 5:45 to 7:00 | Member 2 | Run Triangle vs optimized, then open Analytics. | Binding Update, Acknowledge, the CN binding cache and the cyan pipe. The phase table, about 84 ms and stretch 1.5 against 58 ms and stretch 1.0. |
| 7:00 to 8:00 | Member 2 | Turn on Smooth handoff and move the MN between FA-1 and FA-2 with the stream on. | The previous FA buffers and forwards, the yellow forwarding pipe, and lost against rescued per handoff. |
| 8:00 to 9:00 | Member 1 | Press Wrong shared key, then Re-send old request. | HA 131 and HA 133 in the event log and the inspector, with the existing binding untouched. |
| 9:00 to 10:00 | Member 3 | Switch on Learn mode, run Commuter for a few steps, press Download .pcap and open the file in Wireshark. | RFC references on each step. Wireshark decodes the same packets because the file uses LINKTYPE_RAW. |

If something goes wrong, press Reset. It restores the topology defaults and sends the MN home.

## Likely viva questions

1. **What problem does Mobile IP solve?** An Internet Protocol (IP) address names a location as well as a host. When a host moves to another network its address no longer routes to it, and changing the address breaks every open connection. Mobile IP keeps a permanent home address for identification and adds a temporary care-of address for routing, with the home agent joining the two.

2. **What is triangle routing?** Packets from the correspondent go to the home network, get tunneled by the home agent to the care-of address, and replies go straight back from the mobile node to the correspondent. The three legs form a triangle. The forward path crosses the Internet twice. In our scenario 6 it costs 3 segments instead of 2 and about 26 ms extra.

3. **Why use a foreign agent care-of address rather than a co-located one?** One FA address serves every visitor, so the visited network does not need to hand out an address per mobile node. The FA can enforce local policy and refuse a registration itself. The tunnel ends at the FA, so the mobile node needs no decapsulation code. The cost is that the FA must be present and trusted.

4. **How does a mobile node discover agents?** Agents broadcast Internet Control Message Protocol (ICMP) Router Advertisements carrying the Mobility Agent Advertisement extension. A mobile node that cannot wait sends an Agent Solicitation and gets an immediate advertisement.

5. **Compare the two movement detection methods.** The lifetime method waits for the current agent's advertisement Lifetime to run out, which is safe but slow, about 3 s with our settings. The prefix method moves as soon as an advertisement with a different prefix arrives, which takes tens of milliseconds, but it needs the Prefix-Lengths extension and can be fooled by an agent that serves several prefixes.

6. **What happens when the sequence number wraps?** It goes from 0xffff to 256, never to 0. Values 0 to 255 are kept for a freshly booted agent, so a mobile node seeing a value below 256 that is lower than the last one knows the agent rebooted and lost its visitor list, and registers again.

7. **Walk through a registration via an FA.** The MN sends a Registration Request to the FA. The FA checks lifetime, care-of address, encapsulation and reverse tunnel support, records it as pending and relays it to the HA with a Foreign-Home authenticator. The HA checks the Mobile-Home authenticator and the identification, creates the binding, starts proxy ARP and replies. The FA adds a visitor entry and relays the reply to the MN.

8. **Why does the FA deny some requests itself?** It knows things the HA does not, such as its own maximum lifetime, which encapsulations it supports and whether it has room. Code 69 for too long a lifetime and 72 for an unavailable encapsulation are examples. FA codes are 64 to 127, HA codes 128 and up.

9. **How is registration authenticated?** With the Mobile-Home Authentication extension. RFC 3344 uses keyed-MD5 in prefix+suffix mode: MD5 over the key, then the request up to the Security Parameter Index (SPI), then the key again. Without the shared key nobody can redirect the mobile node's traffic. Our wrong-key demo gets code 131.

10. **What is replay protection and why is it needed?** A valid, signed request could be captured and sent again later to pull the traffic back to an old location. The 64-bit identification stops that. In timestamp mode it must be close to the HA clock and newer than the last accepted one. In nonce mode it must carry the nonce the HA handed out last time. A replay gets code 133.

11. **Timestamp or nonce, which is better?** Timestamps need loosely synchronised clocks, but a single message proves freshness. Nonces need no clock, but the mobile node must have seen the HA's previous reply first, so the first request after a nonce change is always rejected once. Our nonce run shows exactly that 133 followed by an accepted retry.

12. **How does the HA capture packets for an away mobile node?** It sends a gratuitous ARP that binds the home address to its own hardware address (proxy ARP). Neighbours on the home link then hand it every packet for that address.

13. **What happens when the mobile node returns home?** It sends a gratuitous ARP to reclaim its address, then a Registration Request with lifetime 0 and care-of address equal to its home address. The HA deletes the bindings and also announces the MN's own hardware address.

14. **Compare the three encapsulations.** IP-in-IP adds a complete 20-byte header and works for anything. Minimal encapsulation rewrites the original header and adds 8 or 12 bytes, but cannot carry fragments. GRE adds 24 bytes, carries a protocol type and can carry non-IP payloads, keys and sequence numbers.

15. **Why is minimal encapsulation 12 bytes in your demo and not 8?** The HA is not the original source of the packet, so the forwarding header must carry the original source address as well, with the S bit set. Only when the encapsulator is the source does it shrink to 8 bytes.

16. **How do you stop a tunnel loop?** The encapsulator refuses to tunnel a packet whose source is the tunnel exit point, limits nesting depth, and decrements the inner TTL once per encapsulation so a looping packet eventually dies.

17. **What is ingress filtering and how does it break Mobile IP?** Routers at the edge of a network drop packets whose source address does not belong to that network, to stop address spoofing. A mobile node away from home sends with its home address as source, so its triangle-routed replies look spoofed and are dropped.

18. **How does reverse tunneling fix that?** With the T flag the FA wraps the mobile node's outgoing packets and sends them to the HA. The outer source is the care-of address, which is topologically correct. The HA unwraps them and sends them on from the home network, where the home address is a valid source. The price is a longer return path.

19. **How does route optimization remove the triangle?** The HA sends the correspondent a Binding Update with the current care-of address. The correspondent keeps it in a binding cache and tunnels directly to the care-of address until the entry expires. Binding Requests refresh it, and Binding Warnings from an old FA correct a stale one.

20. **Why does route optimization need authentication too?** A forged Binding Update would let anyone redirect a correspondent's traffic. Our HA signs updates with a key shared with the correspondent.

21. **What is smooth handoff?** When the mobile node registers with a new FA it asks that FA to send a Binding Update to the previous FA. The previous FA then forwards packets that still arrive at the old care-of address, including the ones it buffered after the mobile node left, instead of dropping them. In our runs losses during a handoff fall from a few packets to zero.

22. **What is handoff latency made of?** Movement detection time plus registration time. Detection depends on the rule and the advertisement interval. Registration depends on the round trip from the visited network to the home agent, which is why the Metro LTE cell, with a 15 ms access link, registers more slowly than Campus Wi-Fi.

23. **What does path stretch mean here?** The number of link segments a packet actually crossed divided by the minimum possible. Behind an FA the minimum is 2 (CN to FA, FA to MN). Triangle routing takes 3, so the stretch is 1.5.

24. **What do simultaneous bindings give you?** With the S flag the HA keeps several care-of addresses and sends a copy to each. That helps when the mobile node is at the edge of two cells and is unsure which one it will stay in, at the cost of duplicate traffic.

25. **What did you simplify, and why?** The links are emulated over localhost UDP because raw sockets need privileges on Windows. ARP is real packets on a simulated medium. Keys are static. The smooth handoff Binding Update uses a static key rather than one set up during registration. Everything is listed in `docs/PROTOCOL_NOTES.md`, and the IPv4 datagrams themselves are byte accurate, which is why the pcap opens in Wireshark.
