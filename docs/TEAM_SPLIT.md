# Team split

Three members, each owning one layer end to end, from code to the part of the demo that shows it. Ownership means you can explain every line in the viva. It does not mean nobody else may touch the file.

## Member 1: agents and protocol

The mobility agents, the Mobile IP messages and the security around registration.

| File | What it holds |
|---|---|
| `agents/home_agent.py` | HA: registration processing, binding table, proxy and gratuitous ARP, interception, reverse tunnel exit |
| `agents/foreign_agent.py` | FA: advertisement, request checks and denial codes, pending and visitor lists, relay, delivery |
| `agents/mobile_node.py` | MN: state machine, movement detection, registration with backoff, deregistration, demo buttons for 131 and 133 |
| `agents/mip/messages.py` | Codecs for advertisements, solicitations, requests, replies, extensions and ARP |
| `agents/mip/auth.py` | Keyed-MD5 prefix+suffix, timestamp and nonce replay protection |
| `agents/mip/policy.py` | FA and HA decision logic, binding table with expiry |
| `agents/mip/agentbase.py` | Advertisement timer, solicitation replies, sequence rollover and reboot |
| `agents/mip/node.py`, `clock.py`, `config.py` | Agent runtime, high-resolution clock, topology and extra config loader |
| `agents/mip/radio.py` | The mobile node's radio logic: baseline strongest-network rule, Smart handoff with hysteresis, Two networks at once (S flag), Fast re-registration, outage start and end |
| Hold and forward in `agents/home_agent.py`, link-layer notices in `agents/foreign_agent.py`, `DeliveryNotice` in `messages.py` | Our extension: the foreign agent reports an unreachable visitor, the home agent keeps the packets per type and releases them |

Demo responsibility: discovery, both movement detection rules, registration, the scenarios Ping-pong edge, Wrong shared key and Replayed request, and in the Metro ride the S flag, hold and forward and fast re-registration (what is RFC 3344 and what is our extension).

## Member 2: core router, tunneling, route optimization, gateway, pcap

Everything that moves packets and everything that carries them to the browser.

| File | What it holds |
|---|---|
| `agents/core_router.py` | Backbone router and access links: routing, TTL, delay and loss, ARP cache, ingress filter, telemetry mirror |
| `agents/correspondent.py` | CN: stream server, ping replies, binding cache, Binding Request, voice, video and chat flows, receiver feedback |
| `agents/mip/traffic.py` | The three sources: voice every 20 ms, video frames with key frames and fragments, chat with acknowledgement and retransmission, adaptive video levels |
| `agents/mip/radiomodel.py`, `config/coverage.json` | Signal strength along the route, dead zones, the repeatable fade |
| Coverage in `agents/core_router.py` | Train position, signal reports to the mobile node, dropping all traffic below the usable level, link-layer NAK, the extra association used by the S flag, inspector sampling of the 100 packets a second |
| `agents/mip/ipv4.py` | IPv4, UDP and ICMP packing with checksums |
| `agents/mip/encap.py` | IP-in-IP, Minimal and GRE encapsulation, loop guard |
| `agents/mip/link.py` | Virtual link header |
| `agents/mip/decode.py` | Dissector that builds the protocol tree for the inspector |
| `agents/mip/telemetry.py` | JSON telemetry over UDP |
| Route optimization and smooth handoff code paths in `home_agent.py` and `foreign_agent.py` | Binding Update, Acknowledge, Warning, buffering and forwarding |
| `gateway/server.js` | WebSocket gateway, ring buffer, commands, HTTP, QoS timeline and CSV export, finished runs |
| `gateway/metrics.js` | Segments, stretch, handoff and loss metrics, phase summary |
| `gateway/pcap.js` | libpcap writer, LINKTYPE_RAW |

Demo responsibility: tunneling and encapsulation overhead, reverse tunneling with the ingress filter, triangle against optimized routing, smooth handoff, opening the exported pcap in Wireshark, and in the Metro ride the coverage model, the tunnel and the adaptive video sender.

## Member 3: dashboard, analytics, scenarios, docs

The console, the scenarios that drive it and the written material.

| File | What it holds |
|---|---|
| `frontend/src/App.jsx` | Resizable single-screen layout |
| `frontend/src/components/TopBar.jsx` | Connection, clock, Play, Pause, Step, Reset, speed, scenarios, Learn mode |
| `frontend/src/components/TopologyMap.jsx` | SVG map, draggable MN, packet animation, tunnel pipes |
| `frontend/src/components/ControlPanel.jsx` | Handoffs, feature switches, link settings, stream, demos, agent tools |
| `frontend/src/components/AgentPanel.jsx` | MN state machine, HA bindings, FA visitor lists, CN cache |
| `frontend/src/components/PacketInspector.jsx` | Packet list, filter, protocol tree, hex dump, event log, Learn mode walkthrough |
| `frontend/src/components/story/*.jsx`, `frontend/src/lib/story.js` | Story mode: scene, the Metro ride scene, the three-app phone, the quality badge, narrator, tour controls, plain-English captions |
| `frontend/src/components/AnalyticsDrawer.jsx` | Recharts graphs, tables, CSV export |
| `frontend/src/components/QualityDrawer.jsx`, `CoverageSection.jsx`, `ResultsSection.jsx`, `RescueSwitches.jsx` | Quality of service drawer: live numbers, compliance table, charts, coverage, the five switches, the side by side Metro ride result |
| `agents/mip/qos.py`, `qosmgr.py` | The measurement: delay, RFC 3550 jitter, loss, late loss, bursts, interruptions, playout buffer, E-model MOS, freeze, verdicts, run summary |
| `config/qos_targets.json`, `config/traffic.json`, `config/resilience.json` | Every target with its source, the flow profiles and ports, the rescue feature settings |
| `frontend/src/lib/*.js` | Store, WebSocket client, filter language, helpers |
| `gateway/scenarios.js`, `config/scenarios/*.json` | Scenario runner and the nine scenario files: six walkthroughs, the Story tour and two Metro rides |
| `run_all.py`, `start.bat`, `start.sh`, `tools/` | Launcher and debugging tools |
| `README.md`, `docs/*.md` | Documentation and viva guide |

Demo responsibility: the console walkthrough, the Commuter scenario, Analytics and the CSV export, and for the Metro ride the Story mode view, the Quality drawer, the standards behind every target and the side by side result.

## Shared

`config/topology.json` and the new `config/*.json` files belong to everyone. Agree on a change before making it, because every process reads it.
