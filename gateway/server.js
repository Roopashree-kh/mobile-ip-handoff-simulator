// Gateway between the Python agents and the browser dashboard.
//
//   agents --UDP JSON telemetry--> :telemetry_port --> ring buffer (last N events)
//                                                  --> metrics (latency, stretch, handoffs)
//                                                  --> WebSocket broadcast, batched every 50 ms
//   browser --WebSocket {type:"command"|"set"|"scenario"|...}--> UDP JSON to each agent's control port
//
//   GET /export.pcap   captured virtual IPv4 datagrams as libpcap, LINKTYPE_RAW
//   GET /api/state     topology, features, latest agent states and metrics as JSON
//   GET /*             the built dashboard (frontend/dist) in production mode
//
// All ports come from config/topology.json.
'use strict';

const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const pcap = require('./pcap');
const { Metrics } = require('./metrics');
const { loadScenarios, ScenarioRunner } = require('./scenarios');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = process.env.MIP_CONFIG || path.join(ROOT, 'config', 'topology.json');
const topo = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const HOST = topo.localhost || '127.0.0.1';
const G = topo.gateway;
const DIST = path.join(ROOT, 'frontend', 'dist');
const scenarios = loadScenarios(path.join(path.dirname(CONFIG), 'scenarios'));
const startedAt = Date.now();
let resetAt = startedAt; // the console clock shows time since the last Reset

// ---- state ----------------------------------------------------------------------
let ring = [];
let pcapRing = [];
let seqNo = 0;
let features = { ...topo.defaults };
const states = {};
let outbox = [];
const clients = new Set();

const metrics = new Metrics((ev) => ingest({ ts: Date.now(), ...ev }));

const ctl = dgram.createSocket('udp4');
ctl.on('error', (e) => console.error('[gateway] control socket:', e.message));

function sendCommand(target, cmd, args = {}) {
  const names = target === 'ALL' ? Object.keys(topo.nodes) : [target];
  const msg = Buffer.from(JSON.stringify({ cmd, args }));
  for (const n of names) {
    const node = topo.nodes[n];
    if (node) ctl.send(msg, node.control_port, HOST);
  }
}

function setFeatures(changes) {
  features = { ...features, ...changes };
  sendCommand('ALL', 'set', changes);
  queue({ type: 'features', features });
  ingest({ ts: Date.now(), node: 'GATEWAY', kind: 'config',
    summary: 'features: ' + Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(', ') });
}

function resetAll() {
  features = { ...topo.defaults };
  sendCommand('ALL', 'set', features);
  sendCommand('ALL', 'reset');
  ring = [];
  pcapRing = [];
  metrics.reset();
  resetAt = Date.now();
  queue({ type: 'reset', features, resetAt });
  ingest({ ts: Date.now(), node: 'GATEWAY', kind: 'config', summary: 'simulation reset to topology defaults' });
}

const runner = new ScenarioRunner({
  command: sendCommand,
  set: setFeatures,
  reset: resetAll,
  phase: (label) => {
    metrics.setPhase(label);
    queue({ type: 'phase', phase: label });
  },
  summary: () => ingest({ ts: Date.now(), node: 'GATEWAY', kind: 'metric', type: 'phases', summary: 'phase comparison',
    phases: metrics.phaseSummary() }),
  emit: (ev) => ingest({ ts: Date.now(), ...ev }),
});

// ---- telemetry ingest ---------------------------------------------------------------
function ingest(ev) {
  ev.no = ++seqNo;
  if (ev.kind === 'state') {
    states[ev.node] = ev.state;
    queue({ type: 'state', node: ev.node, state: ev.state, ts: ev.ts });
    return;
  }
  if (ev.kind === 'hello' && topo.nodes[ev.node]) {
    sendCommand(ev.node, 'set', features); // bring a (re)started agent in line with the UI
  }
  if (ev.kind === 'packet' && ev.ip && ev.hex) {
    pcapRing.push({ ts: ev.ts, data: Buffer.from(ev.hex, 'hex') });
    if (pcapRing.length > G.pcap_ring_size) pcapRing.splice(0, pcapRing.length - G.pcap_ring_size);
  }
  metrics.ingest(ev);
  ring.push(ev);
  if (ring.length > G.ring_size) ring.splice(0, ring.length - G.ring_size);
  queue({ type: 'event', ev });
}

function queue(msg) {
  outbox.push(msg);
}

setInterval(() => {
  if (!outbox.length) return;
  const batch = JSON.stringify({ type: 'batch', items: outbox });
  outbox = [];
  for (const ws of clients) if (ws.readyState === 1) ws.send(batch);
}, 50);

const tel = dgram.createSocket('udp4');
tel.on('message', (buf) => {
  try {
    ingest(JSON.parse(buf.toString('utf8')));
  } catch (e) {
    console.error('[gateway] bad telemetry datagram:', e.message);
  }
});
tel.on('error', (e) => {
  console.error(`[gateway] telemetry socket error: ${e.message}`);
  process.exit(1);
});
tel.bind(G.telemetry_port, HOST, () => console.log(`[gateway] telemetry on udp://${HOST}:${G.telemetry_port}`));

// ---- HTTP -----------------------------------------------------------------------------
function publicTopology() {
  const t = JSON.parse(JSON.stringify(topo));
  delete t.security; // keys never leave the gateway
  return t;
}

function hello() {
  return {
    type: 'hello', startedAt, resetAt, topology: publicTopology(), features, states,
    scenarios: scenarios.map(({ id, title, description }) => ({ id, title, description })),
    scenario: runner.status(), events: ring.slice(-1500), metrics: metrics.snapshot(),
  };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function handleHttp(req, res) {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/export.pcap') {
    const body = pcap.build(pcapRing);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.writeHead(200, { 'Content-Type': 'application/vnd.tcpdump.pcap',
      'Content-Disposition': `attachment; filename="mobileip-${stamp}.pcap"`, 'Content-Length': body.length });
    return res.end(body);
  }
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ...hello(), events: undefined, packets_captured: pcapRing.length }));
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end();
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(`Gateway running. Dashboard not built: use the Vite dev server on port ${topo.frontend.dev_port}, ` +
      'or run "npm run build" in frontend/.');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify(hello()));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'command') sendCommand(m.target, m.cmd, m.args || {});
    else if (m.type === 'set') setFeatures(m.features || {});
    else if (m.type === 'reset') { runner.stop('stopped by reset'); resetAll(); }
    else if (m.type === 'scenario') {
      const s = scenarios.find((x) => x.id === m.id);
      if (s) runner.run(s).catch((e) => console.error('[gateway] scenario error', e));
    } else if (m.type === 'scenario_stop') runner.stop('stopped by user');
    else if (m.type === 'clear') { ring = []; pcapRing = []; metrics.reset(); queue({ type: 'cleared' }); }
  });
});

// Listen on both loopback addresses: browsers and Node may resolve "localhost" to ::1 first.
// Nothing listens on a LAN interface.
let listening = 0;
for (const addr of [HOST, '::1']) {
  const srv = http.createServer(handleHttp);
  srv.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  srv.on('error', (e) => {
    if (addr === HOST) {
      console.error(`[gateway] cannot listen on ${addr}:${G.http_port}: ${e.message}`);
      process.exit(1);
    }
  });
  srv.listen(G.http_port, addr, () => {
    listening += 1;
    if (listening === 1) {
      console.log(`[gateway] WebSocket and HTTP on http://localhost:${G.http_port}  (pcap: /export.pcap)`);
      console.log(`[gateway] ${scenarios.length} scenarios loaded from config/scenarios`);
      sendCommand('ALL', 'set', features);
      sendCommand('ALL', 'ping_agent');
    }
  });
}
