# Protocol notes: what is implemented and what is simplified

We built this on one laptop, on 127.0.0.1, with no administrator rights. Some things a real network does cannot be done that way, so they are emulated. This file lists every place where we followed the Request for Comments (RFC) documents exactly and every place where we took a shortcut, so nothing in the demo claims more than it does.

## Transport and links

| Area | Status | Notes |
|---|---|---|
| IPv4 datagrams | Exact | Version, Internet Header Length (IHL), Type of Service (TOS), total length, identification, DF and MF flags, TTL, protocol, header checksum (RFC 1071) and addresses are all real. The Packet Inspector recomputes and shows the checksum verdict. |
| UDP and ICMP | Exact | User Datagram Protocol (UDP) checksums use the pseudo-header. Internet Control Message Protocol (ICMP) checksums cover the whole message, including the Mobile IP extensions. |
| Physical links | Emulated | Raw sockets are blocked on Windows, so every virtual datagram travels inside a localhost UDP packet to the core router, which acts as the backbone router and as the shared medium of each access link. An 8-byte virtual link header stands in for Ethernet. It marks a frame as routed, link unicast, link broadcast, Address Resolution Protocol (ARP), attach or link-layer negative acknowledgement (NAK). |
| Delay and loss | Emulated | The router holds each frame for the configured link delay plus the backbone delay, multiplied by the speed setting in the top bar, and drops it with the configured loss probability. Windows rounds normal timer waits to 15.6 ms, so the agents use `perf_counter` and 1 ms sleeps when a timer is close. In our measurements the extra delay from Python scheduling is a few milliseconds, which is visible in the latency charts and is not removed. |
| Handoff | Emulated | Moving the MN means the MN asks the router to associate it with another link (the ATTACH frame). This is the layer 2 event. Everything above it is real Mobile IP signalling. |
| Link-layer acknowledgement | Emulated | When a station sends a link unicast to a node that is no longer on the link, the router returns an L2 NAK carrying the original frame, much as a Wi-Fi sender sees a missing ACK. The FA uses it to notice that the MN has left. |
| ARP | Real packets, simulated medium | Gratuitous and proxy ARP are sent as genuine RFC 826 packets on the virtual link and they update the router's per-link ARP cache. ARP requests and replies for ordinary resolution are not exchanged, because the router already knows every station. ARP frames are not in the pcap export, since LINKTYPE_RAW carries IPv4 only. |
| Fragmentation | Not implemented | No link has a small maximum transmission unit (MTU), so nothing is fragmented. Minimal encapsulation still refuses a fragment, as RFC 2004 requires. |
| ICMP errors | Partial | The router generates Time Exceeded when a TTL runs out. Destination Unreachable is not generated, and the FA codes 80 to 88 that depend on relayed ICMP errors are therefore never produced. |

## Agent discovery (RFC 3344 section 2)

| Area | Status | Notes |
|---|---|---|
| Agent Advertisement | Exact | ICMP Router Advertisement type 9 with the Mobility Agent Advertisement extension (type 16: sequence, registration lifetime, flags R B H F M G r T, care-of addresses) and the Prefix-Lengths extension (type 19). Sent to 255.255.255.255 with time to live (TTL) 1, every advertisement interval (1 s by default, adjustable). The ICMP Lifetime field is three intervals. |
| Who receives it | Emulated | Only stations attached to the agent's link receive the broadcast. |
| Agent Solicitation | Exact | ICMP type 10, sent by the MN right after it attaches to a link. Agents answer at once with an advertisement. |
| Sequence numbers | Exact | They roll from 0xffff to 256. A value below 256 that is lower than the last one means a reboot, and the MN registers again. The Reboot button resets an agent's state and sequence, and "Seq to 0xfffc" shows the rollover within a few seconds. |
| Busy flag | Exact | An FA sets B when its visitor list is full. |

## Movement detection (RFC 3344 section 2.4.2)

Both rules are implemented and selectable while the simulation runs.

- Lifetime-based: the MN keeps its current agent until that agent's advertisement Lifetime expires, then moves to the freshest other agent it has heard.
- Prefix-based: an advertisement whose prefix (router address plus Prefix-Lengths extension) differs from the current one triggers a move immediately.

The layer 2 attach event is used only to send the solicitation, which the RFC allows. The move itself is always decided at layer 3. Detection time is measured from the attach to the decision and reported per handoff.

## Registration (RFC 3344 section 3)

| Area | Status | Notes |
|---|---|---|
| Registration Request and Reply | Exact | Type 1 (24-byte fixed part with flags S B D M G r T x, lifetime, home address, home agent, care-of address and 64-bit identification) and type 3 (20-byte fixed part). Extensions are type-length-value. Reserved bits must be zero, or the request is malformed. |
| Relay through the FA | Exact | MN to FA to HA to FA to MN. The FA keeps a pending list and a visitor list, strips the extensions meant only for itself, and adds a Foreign-Home authenticator before relaying. |
| FA denial codes | Implemented: 66, 67, 68, 69, 70, 72, 74, 77, 78 | 66 visitor list full, 67 MN-FA authentication, 68 HA-FA authentication on the reply, 69 lifetime too long, 70 poorly formed, 72 encapsulation unavailable, 74 reverse tunnel unavailable, 77 invalid care-of address, 78 HA did not reply within 7 s. Codes 64, 65, 71, 73, 75 and 80 to 88 have text in the decoder but no agent produces them. |
| HA codes | Implemented: 0, 1, 131, 132, 133, 134, 135, 136, 137, 139 | 128 to 130 are decoded but never produced. |
| Authentication | Exact for RFC 3344 | Mobile-Home extension (32) with keyed-MD5 in prefix+suffix mode, MD5(key, protected bytes, key), as RFC 3344 section 3.5.1 defines it. The protected bytes run up to and including the SPI. Security Parameter Index (SPI) values start at 256 because 0 to 255 are reserved. Foreign-Home (34) is used between every FA and the HA. Mobile-Foreign (33) is supported but switched off by default. RFC 5944 later replaced prefix+suffix MD5 with HMAC-MD5, but the course specification asks for RFC 3344, so we kept the older algorithm. |
| Replay protection | Exact | Timestamp mode: the high 32 bits of the identification are Network Time Protocol (NTP) seconds, which must lie within 7 s of the HA clock, and the whole identification must be newer than the last one accepted. A 133 reply carries the HA time so the MN can resynchronise. Nonce mode: the high 32 bits must echo the nonce from the HA's previous reply, and the MN learns the new nonce from every reply. A rejected request does not rotate the nonce, so a replayed packet cannot knock the genuine MN out of step. |
| Renewal and retransmission | Exact | Renewal at 80 per cent of the granted lifetime. Retransmission starts at 1 s and doubles to a maximum of 8 s, with a fresh identification each time, for up to 5 attempts. After code 133 the MN resynchronises and retries. After 72 or 139 it falls back to IP-in-IP, after 74 or 137 it drops the T flag, and after 69 it asks for a shorter lifetime. |
| Deregistration | Exact | On returning home the MN sends a gratuitous ARP for its home address, then a request with lifetime 0 and care-of address equal to the home address. The HA removes the bindings and sends its own gratuitous ARP for the MN. |
| Binding table | Exact | Home address, care-of address, identification, encapsulation, T flag, granted lifetime and expiry. The dashboard counts the lifetime down live. Expired bindings are removed. |
| Simultaneous bindings | Exact | With S set, the HA keeps up to 3 bindings and tunnels a copy to each. |

### Scenarios 3 and 4, wrong key and replay

These two scenarios are demo buttons that make the mobile node's own registration fail on purpose. There is no separate rogue node.

- Wrong shared key: the MN builds a normal Registration Request for its current care-of address and signs it with a key that differs from the configured MN-HA key, under the correct SPI. The FA relays it and the HA answers 131, mobile node failed authentication.
- Re-send old request: the MN re-sends its previous Registration Request byte for byte. The authenticator is valid, but the identification is not newer than the last accepted one (timestamp mode), or carries a nonce the HA no longer expects (nonce mode). The HA answers 133, identification mismatch.

In both cases the MN tracks the demo request separately from its real registration state, so the existing binding and the data flow are not disturbed. This shows exactly the checks an attacker would hit. It does not model how an attacker would capture traffic in the first place.

## Tunneling

| Area | Status | Notes |
|---|---|---|
| IP-in-IP (RFC 2003) | Exact | Protocol 4, 20 bytes overhead. TOS and DF are copied to the outer header. |
| Minimal Encapsulation (RFC 2004) | Exact | Protocol 55. The original header is rewritten and a forwarding header with its own checksum is inserted. It is 12 bytes when the encapsulator is not the original source (S bit set, which is the HA case) and 8 bytes otherwise. |
| GRE (RFC 1701 and 2784) | Exact for the base header | Protocol 47, 4-byte header with protocol type 0x0800, 24 bytes overhead. The optional checksum is supported by the library (28 bytes). The key and sequence fields of RFC 2890 are not implemented. |
| TTL | Exact | The encapsulator decrements the inner TTL once, so to the inner datagram the tunnel looks like a single hop. The decapsulating FA delivers it on the link without a further decrement. |
| Tunnel loop guard | Exact | No tunnel to an exit point that equals the inner source, a nesting limit of 3, and no tunnel when the inner TTL would expire. |
| FA care-of address | Exact, the default | The FA decapsulates and delivers to the MN on its link. |
| Co-located care-of address | Simplified | The MN takes host .100 on the visited prefix, as if from the Dynamic Host Configuration Protocol (DHCP), announces it with gratuitous ARP and registers directly with the HA, decapsulating itself. We do not enforce the rule that an R bit in the advertisement forces registration through the FA. |
| Reverse tunneling (RFC 3024) | Direct delivery style | The MN sends plain packets to the FA and the FA tunnels them to the HA when the T flag was granted. The encapsulating delivery style, where the MN tunnels to the FA, is not implemented. The HA accepts a reverse-tunneled packet only if the outer source is a registered care-of address of that MN with T set. |
| Ingress filtering | Emulated | The core router drops a routed packet whose source address does not belong to the access link it came from, in the spirit of RFC 2827. |

## Route optimization and smooth handoff (Perkins and Johnson draft)

| Area | Status | Notes |
|---|---|---|
| Binding Update, Acknowledge, Warning, Request | Implemented | UDP port 434, types 18, 19, 16 and 17. Field layouts follow our reading of draft-ietf-mobileip-optim. If a numbering detail differs between draft revisions, treat ours as a simulator choice. |
| Extension numbers | Simulator choice where unsure | Route Optimization Authentication is type 35. Previous Foreign Agent Notification is type 100. We could not confirm the second number against a final RFC, because the draft never became one, so it may differ from other implementations. |
| Binding cache at the CN | Implemented | Entries have lifetimes. The CN tunnels straight to the care-of address while an entry is valid, acknowledges updates that ask for it, and sends a Binding Request when an entry in use is within 25 per cent of expiry. |
| HA behaviour | Implemented | When the HA tunnels a packet from a correspondent, it sends that correspondent a Binding Update, rate-limited to one per second. It refreshes known correspondents after each new registration and sends lifetime 0 when the MN returns home. |
| Binding Warning | Implemented | The previous FA warns the HA when a correspondent still tunnels to the old care-of address. |
| Smooth handoff | Implemented with a simplification | The MN adds the Previous FA Notification extension to its request. After the HA accepts, the new FA sends a Binding Update to the previous FA, which forwards later packets and its buffer to the new care-of address. The previous FA buffers what it could not deliver (detected through the L2 NAK) for up to 3 s and 64 packets. In the draft, the key protecting this Binding Update is set up during registration. Here it is the static MN-FA key from the config file. |
| Key distribution | Not implemented | All security associations are static keys in `config/topology.json`. The gateway removes the `security` block before it sends the topology to the browser. |

## Metrics

- Latency: CN send time to MN receive time. Both run on the same machine and share a calibrated high-resolution clock, so no clock offset needs correcting.
- Segments: the number of link segments the datagram crossed, counted from the router mirror events that carry its flow key (innermost source, destination, IP identification and protocol). Triangle routing via an FA takes 3 segments (CN to HA, HA to FA, FA to MN), route optimization takes 2, at home it is 1, and a packet rescued by smooth handoff takes 4.
- Path stretch: segments divided by the optimal segment count for the MN's current attachment (1 at home or with a co-located address, 2 behind an FA).
- Handoff latency: detection time plus registration time, where registration time runs from the first request sent to the accepted reply.
- Packets lost per handoff: stream sequence numbers missing between the last one received before the handoff and the highest one received 2 s after registration completed.

One limitation: the loss count only means something while the CN stream is running, and a handoff that starts before the previous one has been evaluated closes the earlier window early.

## Application flows and quality measurement

This part is ours. Mobile IP does not define it. We measure the way the ITU-T and IETF documents say to measure, and we say below where we simplified. Every target number lives in `config/qos_targets.json` with a `source` and a `verified` flag. `verified: true` means we read the number in the document itself. `verified: false` means it is project policy or we could not read it.

### The three flows

| Flow | What the correspondent sends | Config |
|---|---|---|
| Voice | G.711-like, one packet every 20 ms, 160 bytes of media, 50 packets per second | `config/traffic.json`, flows.voice |
| Video | A frame every 1/fps seconds (25, 15 or 10 fps by level), a larger key frame every second, each frame split into packets of at most 1000 bytes | flows.video |
| Chat | One short message every 3 to 5 s. The receiver acknowledges each one. The sender retransmits with a timeout that grows from 1 s to 4 s, up to 14 times | flows.text |

Every packet starts with a 28-byte flow header (magic MIPQ, flow id, type, flags, route tag, sequence, send time in ms, packet interval, frame id, fragment index and count). It stands in for the 12-byte RTP header plus the extra fields we need. The media payload follows it, so a voice packet is 188 bytes of UDP payload. The older single stream on port 5004 is unchanged and the first six scenarios still use it.

### What is measured, and against what

| Measure | How we compute it | Reference |
|---|---|---|
| One-way delay | Arrival time minus the stamped send time. Both ends share one calibrated clock because everything runs on one machine | ITU-T G.114 clause 4, ITU-T Y.1541 Table 1 (IPTD) |
| Jitter | The smoothed estimate J = J + (|D| - J) / 16 on consecutive in-order arrivals, where D is the change in one-way delay | RFC 3550 section 6.4.1 and appendix A.8 |
| Packet loss | Gaps in the sequence numbers, plus packets that arrive after their playout deadline (late loss). A packet that turns up out of order after a gap was declared is taken back out of the loss count | ITU-T Y.1541 Table 1 (IPLR), ITU-T G.1010 Table I.1 |
| Longest loss burst, out-of-order, duplicates | Counted from the same sequence record | none |
| Interruption time | Gap between the last in-order packet before a link change or loss and the first one after it, when it is at least `interruption_min_ms` | none |
| Video freeze | A frame is shown only if all its fragments arrived before its deadline and the decoder has a good reference. After any failed frame the picture stays stuck until the next key frame. A freeze is a gap between two shown frames of more than 3 frame intervals and at least 200 ms | none, project policy |
| Chat delivery time | Arrival of the first copy of a message minus the time the sender first sent it. Retransmitted copies are acknowledged again and discarded | ITU-T G.1010 Table I.2, nearest row |

Each number is kept over a sliding window (5 s by default) and over the whole run.

### Playout buffer

A packet that arrives after the moment a player would have needed it is late, and it counts as lost, exactly as in a real player. The buffer is adaptive by default. The playout offset is the running mean delay d plus a buffer of k times the running deviation v, held between a minimum and a maximum, with d and v exponential averages (alpha 0.9). This is algorithm 1 of Ramjee, Kurose, Towsley and Schulzrinne (INFOCOM 1994), so the buffer follows the measured jitter. Two simplifications: we adapt on every packet and not only at talkspurt boundaries, and a delay that is more than a clamp above the average is clamped before it enters the average. A fixed buffer is available with `mode: fixed` in the flow's playout block.

### E-model score for voice (ITU-T G.107)

R = 93.2 - Id - Ie_eff, and MOS = 1 + 0.035 R + R (R - 60) (100 - R) x 7e-6, clamped to 1 to 4.5. Id is the delay impairment Idd of equation 7-27 with the default delay sensitivity (mT 100 ms, sT 1). Ie_eff = Ie + (95 - Ie) x Ppl / (Ppl / BurstR + Bpl) with the G.711 values Ie 0 and Bpl 25.1 (G.113 Appendix I, with packet loss concealment). The simplifications, all of them:

- The default R of 93.2 already contains the default values of Ro, Is and A, so we do not model those terms separately.
- The echo terms Idte and Idle are taken as zero. That assumes good echo control.
- Delay is the playout offset plus 20 ms of codec packetisation. The 20 ms is our own figure, not a table value.
- Ppl is the loss over the window, network loss plus late packets. BurstR is the mean observed burst length divided by the length expected for random loss, and we hold it at 1 or above so a total blackout cannot divide by zero.
- The formula for MOS dips just under 1 for very small R, so the result is clamped to 1.
- The bands "satisfied" and "many users dissatisfied" are read from G.107 Table B.1 (R 80 gives MOS 4.03, R 60 gives MOS 3.10). We use 4.0 and 3.1 as the pass and limit values.

### Verdicts

Each check has a pass value and, where a standard gives one, a hard limit. Inside the pass value is Pass. Past the pass value but inside the limit, or where no limit exists, is Fair. Past the hard limit is Poor. A flow with no packets for 1 s is Poor whatever else it shows. The reason is the first failing check in words, for example "jitter 62 ms is above the 50 ms limit".

| Check | Pass | Hard limit | Source |
|---|---|---|---|
| Voice delay, mouth to ear | 150 ms | 400 ms | G.114 clause 4, G.1010 Table I.1 |
| Voice network delay (mean) | 100 ms | none | Y.1541 Table 1 class 0 |
| Jitter, voice and video | 50 ms | none | Y.1541 Table 1 class 0 and class 1 |
| Voice loss | 0.1 per cent | 3 per cent | Y.1541 class 0 IPLR 1e-3, G.1010 Table I.1 |
| Voice MOS | 4.0 | 3.1 | G.107 Table B.1 |
| Video delay incl. buffer | 150 ms | 400 ms | G.1010 Table I.1, videophone |
| Video network delay (mean) | 400 ms | none | Y.1541 Table 1 class 1 |
| Video loss | 0.1 per cent | 1 per cent | Y.1541 class 1, G.1010 Table I.1 videophone |
| Video frozen time in the window | 0 | 1000 ms | project policy |
| Chat delivery time | 2 s | 4 s | G.1010 Table I.2, e-mail server access, nearest row |
| Chat messages lost | 0 | 0 | project policy |

Two comparisons are not like for like and the file says so. Y.1541 defines IPDV as the 1 - 10^-3 quantile of delay minus the minimum delay, and we compare RFC 3550 interarrival jitter with its 50 ms. And G.1010 Table I.1 gives conversational voice a delay variation target of under 1 ms, which we do not use, because a playout buffer removes that variation and Y.1541 gives the network figure we apply. That reasoning is ours.

### What we could not verify from the documents

- G.1010 has no instant messaging row. We used the e-mail server access row of Table I.2 as the nearest one. The zero-loss cell for that row was not read, so lost messages is project policy.
- G.114 (05/2003) states the 150 ms and 400 ms figures in clause 4. A three-band table of 0 to 150, 150 to 400 and over 400 ms was not found in that edition.
- The Y.1541 class values were read from the PDF text, whose table layout was scrambled. The class to column assignment matches the published table and the worked example in Note 2, but it was not read cell by cell. Classes 6 and 7 are provisional (Table 3).
- Y.1540, which defines IPDV, was not fetched. Only the restatement in Y.1541 was read.
- The exact symbols of G.107 equation 7-30 (BurstR from a two-state model) were lost in the PDF text. We do not use that equation.
- The G.113 table number for the G.711 Bpl value of 4.8 in the burst-loss part was not captured. We use the 25.1 value of the PLC row.

## Coverage and the Metro ride

This part is ours. The signal model is not from a standard.

Each network has one or more cells at positions along a route. The signal in dBm is the reference level at 1 m minus 10 x n x log10 of the distance, with the distance never below 20 m, plus a small fade that depends only on position, so two rides see exactly the same signal. A dead zone subtracts a large extra loss from every network, which is how a tunnel is modelled. Below the usable threshold (-100 dBm) the core router drops every frame to and from the mobile node on that link and returns a link-layer NAK to the sender, like a missing Wi-Fi acknowledgement. All values are in `config/coverage.json`.

The core router holds the train's position and moves it along the route. It sends the mobile node a measurement frame (kind SIGNAL) a few times a second. That frame is a reading, not a radio frame, so it is delivered even when there is no signal.

The mobile node can be associated with two links at once during an overlap (frames ATTACH_EXTRA and DETACH_EXTRA). That is an emulation of a node with two radios. It exists only so the S flag has something to do.

### What the baseline does

With every feature off, the node does what a naive implementation does: it moves to whichever network is strongest right now, with no margin, no waiting time and no averaging. This is deliberately simple, and it ping-pongs where two cells cross. A real phone has more sense than that, so read the baseline as a lower bound.

### The five switchable features

| Feature | In RFC 3344? | What is ours |
|---|---|---|
| Smart handoff | No. Mobile IP does not say when to hand off | The whole policy: average the readings, switch only when the current signal is below -85 dBm and another network is stronger by 5 dB for 600 ms, and not within 4 s of the last switch. A current network that is already unusable skips the waiting |
| Two networks at once | Yes, the S flag. RFC 3344 section 3.3 defines the bit. Section 3.6.1.2 says the home agent then keeps the prior bindings and tunnels a separate copy to each care-of address, and the mobile node receives multiple copies. Section 3.8.2.2 covers the home agent side and 4.2.3 the forwarding | When to use it (only while two networks overlap), the dual association in the router, dropping the duplicate by sequence number at the application, and releasing the old link when its signal is gone. The old binding is not deregistered. It is left to expire, and the foreign agent notice below stops the copies to it |
| Hold and forward | No. This is our own extension | Everything. The foreign agent tells the home agent a visitor is unreachable (a link-layer NAK) or reachable again (it hears the node). The home agent then keeps the packets instead of tunneling them and releases them when the node is reachable or re-registers. Per type, voice older than 150 ms is dropped, video older than 2 s is dropped, chat is kept. The buffer holds 600 packets and drops the least valuable first. The message is our own type 0xE0 over UDP port 434, authenticated with the Foreign-Home extension. A binding whose renewal is 2 s overdue is also treated as unreachable |
| Adaptive video | No | The receiver reports loss and signal to the sender every 500 ms over the existing reverse path. The sender steps the video down a level when loss is above 4 per cent or the signal is under -92 dBm, steps up after 4 s of good reports, and steps down when it hears nothing for 2 s |
| Fast re-registration | The pieces are. Section 2.4 lets a node send an Agent Solicitation at any time, and section 3.6.1 lets it register at any time | The trigger. When the signal returns the node solicits and re-registers at once. Without it the node waits for its normal 1 s discovery loop |

### One change to existing behaviour

The foreign agent used to mark a visitor as unreachable after a link-layer NAK and keep it that way until the next registration. That is harsh when the cause is a short loss of signal. It now clears the mark when it hears any frame from the visitor, such as the receiver feedback every 500 ms. Nothing else in the first six scenarios depends on this.

## Out of scope

Mobile IPv6, the Network Access Identifier, broadcast datagram delivery to the MN (the B flag is decoded but not acted on), FA challenge and response (RFC 3012), and authentication, authorisation and accounting (AAA) integration are not implemented.
