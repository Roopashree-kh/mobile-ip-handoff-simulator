// Interactive topology map, hand-built SVG, laid out in screen pixels.
//  * five subnet regions around the Internet cloud. Each region keeps its title in the
//    top-left corner and nothing else is placed there
//  * every device is a glyph with its name and address stacked underneath. In a foreign
//    subnet the FA sits in the left half and the mobile node has a reserved slot in the right
//  * links leave a region straight out of the agent (up for the bottom row, sideways for the
//    top row) and run to the cloud. Delay badges sit beside the midpoint of that run
//  * a placement pass measures every label with the real font and drops any badge that
//    would touch another label, glyph or badge
//  * each frame the router mirrors becomes a dot travelling along the drawn links
//  * tunnels are curves through the cloud, derived from the HA binding table and CN cache
//  * the mobile node can be dragged onto another network to trigger a real handoff
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { onPacket, useStore } from '../lib/store.js';
import { command } from '../lib/ws.js';
import { PTYPE_COLOR } from '../lib/util.js';
import { Icon } from './ui.jsx';

const MAX_DOTS = 180;
const MINW = 900;
const MINH = 620;
const RH = 220; // minimum region height
const M = 12;
const GAP = 16;
const G = 22; // half size of a device glyph
const NODE_LINK = { HA: 'home', CN: 'cnnet', 'FA-1': 'fa1', 'FA-2': 'fa2', 'FA-3': 'fa3' };
const ENCAP = { ipip: 'IP-in-IP', minimal: 'Minimal', gre: 'GRE' };
const PIPE = { ha: '#7b3fbf', cn: '#0f8798', rev: '#c45f12', smooth: '#9a7b00' };
const LEGEND_DOTS = [['adv', 'Advertisement'], ['reg', 'Registration'], ['tunnel', 'Tunneled'], ['data', 'Plain data'], ['bu', 'Binding update'], ['drop', 'Dropped']];
const LEGEND_PIPES = [['ha', 'HA tunnel'], ['cn', 'CN tunnel'], ['rev', 'Reverse tunnel']];
const SANS = 'Inter, "Segoe UI", system-ui, sans-serif';
const MONO = 'Consolas, "Cascadia Mono", monospace';
const INK = '#111111';
const DIM = '#5f6b7a';

// ---- text measurement and rectangles ----

let measureCtx = null;
function tw(text, px, mono = false, weight = 400) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${weight} ${px}px ${mono ? MONO : SANS}`;
  return measureCtx.measureText(String(text ?? '')).width;
}
const rect = (x, y, w, h) => ({ x, y, w, h });
const hits = (a, b, pad = 3) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
const free = (r, used) => used.every((u) => !hits(r, u));

/** A text line centred on x with its baseline at y, plus the box it occupies. */
function line(text, x, y, px, opts = {}) {
  const w = tw(text, px, opts.mono, opts.weight || 400);
  return { text, x, y, px, ...opts, box: rect(x - w / 2 - 1, y - px * 0.8, w + 2, px * 1.05) };
}

/**
 * Glyph plus its label stack. Spacing is fixed: name 16 px under the glyph, then 15 px
 * per line. An optional pill (visitor or binding count) closes the stack.
 */
function stack(cx, cy, lines, pill) {
  const out = { glyph: rect(cx - G, cy - G, 2 * G, 2 * G), lines: [], pill: null };
  let y = cy + G + 16;
  lines.forEach(([text, px, opts], i) => {
    if (!text) return;
    if (i) y += 15;
    out.lines.push(line(text, cx, y, px, opts));
  });
  if (pill) {
    const w = tw(pill, 11, false, 500) + 14;
    out.pill = { text: pill, x: cx, y: y + 15, w, box: rect(cx - w / 2, y + 6, w, 18) };
  }
  out.boxes = [out.glyph, ...out.lines.map((l) => l.box), ...(out.pill ? [out.pill.box] : [])];
  return out;
}

// ---- geometry ----

/** Region frames, device slots and link exit points for a W x H canvas. */
function layout(W, H, titles) {
  const rh = Math.max(RH, Math.min(280, (H - 2 * M - 150) / 2));
  const band = H - 2 * M - 2 * rh;
  const topW = Math.min(480, W * 0.36);
  const bw = (W - 2 * M - 2 * GAP) / 3;
  const C = [W / 2, M + rh + band / 2];
  const rx = Math.min(180, W * 0.15);
  const ry = Math.max(34, Math.min(58, band * 0.36));
  const frame = (k, x, y, w) => {
    const t = titles[k] || {};
    const lw = Math.max(tw(t.label, 13, false, 600), tw(t.prefix, 11, true));
    const r = { k, x, y, w, h: rh, label: t.label, prefix: t.prefix };
    r.title = rect(x + 10, y + 10, lw + 6, 38);
    r.cy = y + 52 + (rh - 52 - 10 - 98) / 2 + G;
    return r;
  };
  const R = {
    home: frame('home', M, M, topW),
    cnnet: frame('cnnet', W - M - topW, M, topW),
    fa1: frame('fa1', M, H - M - rh, bw),
    fa2: frame('fa2', M + bw + GAP, H - M - rh, bw),
    fa3: frame('fa3', M + 2 * (bw + GAP), H - M - rh, bw),
  };
  const h = R.home;
  h.agent = 'HA';
  h.mn = [h.x + h.w * 0.28, h.cy];
  h.a = [h.x + h.w * 0.7, h.cy];
  h.gw = [h.x + h.w, h.cy];
  const c = R.cnnet;
  c.agent = 'CN';
  c.mn = null;
  c.a = [c.x + c.w * 0.55, c.cy];
  c.gw = [c.x, c.cy];
  ['fa1', 'fa2', 'fa3'].forEach((k, i) => {
    const r = R[k];
    r.agent = `FA-${i + 1}`;
    // the uplink rises straight from the FA, so the FA must sit clear of the title
    const ax = Math.max(r.x + r.w * 0.28, r.title.x + r.title.w + 18);
    r.a = [ax, r.cy];
    r.gw = [ax, r.y];
    r.mn = [r.x + r.w * 0.72, r.cy];
    r.mnGw = [r.mn[0], r.y];
  });
  return { W, H, C, rx, ry, R };
}

function ellipseEdge(C, rx, ry, p) {
  const dx = p[0] - C[0];
  const dy = p[1] - C[1];
  const t = 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
  return [C[0] + dx * t, C[1] + dy * t];
}
const inEllipse = (C, rx, ry, p) => ((p[0] - C[0]) / rx) ** 2 + ((p[1] - C[1]) / ry) ** 2 < 1;

function cloudPath(C, rx, ry) {
  const angles = [0, 32, 66, 98, 128, 160, 196, 230, 262, 292, 326];
  const pts = angles.map((d) => {
    const a = (d * Math.PI) / 180;
    return [C[0] + rx * Math.cos(a), C[1] + ry * Math.sin(a)];
  });
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i <= pts.length; i += 1) {
    const p = pts[i % pts.length];
    const q = pts[i - 1];
    const r = Math.hypot(p[0] - q[0], p[1] - q[1]) * 0.6;
    d += ` A${r},${r} 0 0 1 ${p[0]},${p[1]}`;
  }
  return `${d} Z`;
}

function lerp(pts, t) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let want = t * total;
  for (let i = 0; i < seg.length; i += 1) {
    if (want <= seg[i] || i === seg.length - 1) {
      const f = seg[i] ? Math.min(1, want / seg[i]) : 1;
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
    }
    want -= seg[i];
  }
  return pts[pts.length - 1];
}

const normal = (a, b) => {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
};
const shift = (p, n, s) => [p[0] + n[0] * s, p[1] + n[1] * s];

/**
 * Tunnel route: straight along the source's uplink, a curve through the cloud, straight
 * down the destination's uplink. side moves the rails off the link line, bow moves the
 * curve sideways so parallel tunnels stay apart.
 */
function tunnel(A, B, C, side, bow) {
  const nA = normal(A.p, A.g);
  const nB = normal(B.g, B.p);
  const a0 = shift(A.p, nA, side);
  const a1 = shift(A.g, nA, side);
  const b1 = shift(B.g, nB, side);
  const b0 = shift(B.p, nB, side);
  const n = normal(a1, b1);
  const p1 = [a1[0] + (C[0] - a1[0]) * 0.8 + n[0] * bow, a1[1] + (C[1] - a1[1]) * 0.8 + n[1] * bow];
  const p2 = [b1[0] + (C[0] - b1[0]) * 0.8 + n[0] * bow, b1[1] + (C[1] - b1[1]) * 0.8 + n[1] * bow];
  const at = (t) => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * a1[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * b1[k]);
  };
  return { d: `M${a0[0]},${a0[1]} L${a1[0]},${a1[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${b1[0]},${b1[1]} L${b0[0]},${b0[1]}`, at };
}

// ---- device glyphs (drawn around 0,0) ----

function RouterGlyph({ active }) {
  const ring = active ? '#2457a6' : '#4d5b6c';
  const arrow = active ? '#2457a6' : '#3d4a5a';
  const arr = (rot, inward) => (
    <g transform={`rotate(${rot})`}>
      <path d={inward ? 'M0,-13 L0,-5 M-3,-8 L0,-5 L3,-8' : 'M0,-5 L0,-13 M-3,-10 L0,-13 L3,-10'}
        fill="none" stroke={arrow} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
  return (
    <g data-box="glyph">
      <circle r="19" fill={active ? '#e6edf8' : '#eef1f5'} stroke={ring} strokeWidth="1.6" />
      {arr(45, true)}{arr(225, true)}{arr(135, false)}{arr(315, false)}
    </g>
  );
}

function ServerGlyph() {
  return (
    <g data-box="glyph">
      <rect x="-15" y="-21" width="30" height="42" rx="3" fill="#eef1f5" stroke="#4d5b6c" strokeWidth="1.6" />
      {[-13, -2, 9].map((y) => (
        <g key={y}>
          <rect x="-10" y={y} width="20" height="7" rx="1" fill="#d5dbe3" />
          <circle cx="6" cy={y + 3.5} r="1.4" fill="#2f9e44" />
          <line x1="-7" y1={y + 3.5} x2="1" y2={y + 3.5} stroke="#7b8794" strokeWidth="1.2" />
        </g>
      ))}
    </g>
  );
}

function PhoneGlyph() {
  return (
    <g data-box="glyph">
      <rect x="-13" y="-21" width="26" height="42" rx="4" fill="#2457a6" stroke="#1c4787" strokeWidth="1.6" />
      <rect x="-9" y="-15" width="18" height="26" rx="1" fill="#ffffff" />
      <path d="M-5,-5 a7,7 0 0 1 10,0 M-2.5,-2 a3.5,3.5 0 0 1 5,0" fill="none" stroke="#2457a6" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="0" cy="2" r="1.2" fill="#2457a6" />
      <rect x="-3" y="15" width="6" height="1.6" rx="0.8" fill="#c9d8f0" />
    </g>
  );
}

function Pill({ p, color = DIM, border = '#c3c9d1', weight = 400, mono = true }) {
  return (
    <g pointerEvents="none" data-box="pill">
      <rect x={p.box.x} y={p.box.y} width={p.box.w} height={p.box.h} rx="3" fill="#ffffff" stroke={border} strokeWidth="1" />
      <text x={p.x} y={p.box.y + 13} textAnchor="middle" fill={color} fontSize="11" fontWeight={weight}
        fontFamily={mono ? MONO : undefined} stroke="none">{p.text}</text>
    </g>
  );
}

function Stack({ s }) {
  return (
    <>
      {s.lines.map((l, i) => (
        <text key={i} x={l.x} y={l.y} textAnchor="middle" fill={l.fill || INK} fontSize={l.px}
          fontWeight={l.weight || 400} fontFamily={l.mono ? MONO : undefined}>{l.text}</text>
      ))}
      {s.pill && <Pill p={s.pill} color="#2457a6" border="#9db4da" weight={500} mono={false} />}
    </>
  );
}

export default function TopologyMap() {
  const topology = useStore((s) => s.topology);
  const states = useStore((s) => s.states);
  const scenario = useStore((s) => s.scenario);
  const scenarios = useStore((s) => s.scenarios);
  const features = useStore((s) => s.features);
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const dots = useRef([]);
  const [, setTick] = useState(0);
  const [drag, setDrag] = useState(null);
  const [box, setBox] = useState({ w: 1100, h: 640 });
  const [hint, setHint] = useState(() => !localStorage.getItem('mip.hint.drag'));
  useEffect(() => {
    if (!hint) return undefined;
    const t = setTimeout(() => setHint(false), 20000);
    return () => clearTimeout(t);
  }, [hint]);

  useEffect(() => {
    const el = wrapRef.current;
    const measure = () => {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) setBox((o) => (Math.abs(o.w - b.width) < 1 && Math.abs(o.h - b.height) < 1 ? o : { w: b.width, h: b.height }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    const raf = requestAnimationFrame(measure);
    const late = setTimeout(measure, 400); // panel sizes settle after the first layout pass
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); cancelAnimationFrame(raf); clearTimeout(late); };
  }, []);

  // one canvas unit is one screen pixel. A panel smaller than MINW x MINH scales the whole
  // drawing down uniformly, so the layout (and its no-overlap guarantee) never changes
  const W = Math.max(MINW, Math.round(box.w));
  const H = Math.max(MINH, Math.round(box.h));
  const scale = Math.min(box.w / W, box.h / H);
  const titleKey = topology ? JSON.stringify(Object.entries(topology.links).map(([k, l]) => [k, l.label, l.prefix])) : '';
  const L = useMemo(() => layout(W, H, topology?.links || {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [W, H, titleKey]);

  const mnLink = states.ROUTER?.attach?.MN || states.MN?.link || 'home';
  const posRef = useRef({});

  const pos = (node, link) => {
    if (node === 'ROUTER') return L.C;
    if (node === 'MN') return L.R[link || mnLink]?.mn || L.C;
    const l = NODE_LINK[node];
    return l ? L.R[l].a : L.C;
  };
  // points from a node out to the cloud centre, following the drawn lines
  const chain = (node, link) => {
    if (node === 'ROUTER' || !node) return [];
    if (node === 'MN') {
      const r = L.R[link || mnLink];
      return r ? [r.mn, r.a, r.gw] : [];
    }
    const r = L.R[NODE_LINK[node]];
    return r ? [r.a, r.gw] : [];
  };
  posRef.current = { pos, chain, mnLink, L };

  // Packet animation loop
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const now = performance.now();
      dots.current = dots.current.filter((d) => now - d.start < d.dur + (d.dropped ? 900 : 0));
      setTick((t) => (t + 1) % 1e6);
      raf = dots.current.length ? requestAnimationFrame(loop) : 0;
    };
    const off = onPacket((list) => {
      const { pos: p, chain: ch, mnLink: cur, L: lay } = posRef.current;
      const now = performance.now();
      for (const ev of list) {
        if (dots.current.length >= MAX_DOTS && ev.ptype !== 'reg' && ev.ptype !== 'bu') continue;
        const from = p(ev.frm, ev.frm === 'MN' ? cur : undefined);
        let pts;
        if (ev.lkind === 'arp') pts = [from, from];
        else if (ev.lkind === 'routed') {
          const out = ch(ev.frm, ev.frm === 'MN' ? cur : undefined);
          const back = ev.to ? ch(ev.to, ev.to === 'MN' ? (ev.dst_link || cur) : undefined).reverse() : [];
          pts = [...(out.length ? out : [from]), lay.C, ...back];
        } else {
          const to = ev.to === 'MN' && ev.verdict === 'dropped' ? (lay.R[ev.link]?.mn || from) : p(ev.to, ev.to === 'MN' ? cur : undefined);
          pts = [from, to];
        }
        const dur = Math.min(2600, Math.max(420, 320 + (ev.delay_ms || 0) * 10));
        dots.current.push({
          pts, start: now, dur, key: ev.no,
          color: ev.verdict === 'dropped' ? PTYPE_COLOR.drop : (PTYPE_COLOR[ev.ptype] || '#555'),
          dropped: ev.verdict === 'dropped', arp: ev.lkind === 'arp',
        });
      }
      if (!raf) raf = requestAnimationFrame(loop);
    });
    return () => { off(); cancelAnimationFrame(raf); };
  }, []);

  const mn = states.MN;
  const r = states.ROUTER;
  const activeAgent = L.R[mnLink]?.agent;

  // Fixed labels: region titles, device stacks, the cloud caption. These are laid out first
  // and reserve their boxes. Badges are placed afterwards, only into free space.
  const fixed = useMemo(() => {
    const ip = (n) => topology?.nodes?.[n]?.ip;
    const stacks = {};
    for (const g of Object.values(L.R)) {
      const st = states[g.agent];
      const visitors = st?.visitors?.length || 0;
      const bindings = g.agent === 'HA' ? (states.HA?.bindings?.length || 0) : 0;
      const pill = visitors ? `${visitors} visitor${visitors > 1 ? 's' : ''}` : bindings ? `${bindings} binding${bindings > 1 ? 's' : ''}` : '';
      stacks[g.agent] = stack(g.a[0], g.a[1], [[g.agent, 13, { weight: 600 }], [ip(g.agent), 11, { mono: true, fill: DIM }]], pill);
    }
    const slot = L.R[mnLink]?.mn;
    const mnStack = slot ? stack(slot[0], slot[1], [['MN', 13, { weight: 600 }], [mn?.home, 11, { mono: true, fill: DIM }],
      [mn?.binding?.coa ? `CoA ${mn.binding.coa}` : '', 11, { mono: true, fill: '#2457a6' }]]) : null;
    const bb = r?.backbone?.delay_ms ?? topology?.backbone?.delay_ms ?? '-';
    const cap = [line('Internet', L.C[0], L.C[1] - 3, 15, { weight: 600 }), line(`10.0.0.1, backbone ${bb} ms`, L.C[0], L.C[1] + 14, 11, { mono: true, fill: DIM })];
    const plate = rect(Math.min(...cap.map((c) => c.box.x)) - 8, cap[0].box.y - 5, Math.max(...cap.map((c) => c.box.w)) + 16, cap[1].box.y + cap[1].box.h - cap[0].box.y + 10);
    const used = [
      ...Object.values(L.R).map((g) => g.title),
      ...Object.values(stacks).flatMap((s) => s.boxes),
      ...(mnStack ? mnStack.boxes : []),
      plate,
    ];
    return { stacks, mnStack, cap, plate, used };
  }, [L, states, topology, mnLink, mn, r]);

  // Tunnel pipes from the live tables, then their badges near the cloud
  const pipes = useMemo(() => {
    const out = [];
    const byIp = {};
    if (topology) for (const [n, v] of Object.entries(topology.nodes)) if (v.ip) byIp[v.ip] = n;
    const end = (node) => {
      if (node === 'MN') {
        const g = L.R[mnLink];
        return g?.mnGw ? { p: g.mn, g: g.mnGw } : null;
      }
      const g = L.R[NODE_LINK[node]];
      return g ? { p: g.a, g: g.gw } : null;
    };
    const endFor = (coa, colocated) => end(colocated ? 'MN' : byIp[coa]);
    const HA = end('HA');
    for (const b of states.HA?.bindings || []) {
      const e = endFor(b.coa, b.colocated);
      if (!e) continue;
      out.push({ key: `ha${b.coa}`, ...tunnel(HA, e, L.C, 4, 0), color: PIPE.ha, label: ENCAP[b.encap] || b.encap, side: 'a' });
      if (b.reverse) out.push({ key: `rev${b.coa}`, ...tunnel(e, HA, L.C, 10, 28), color: PIPE.rev, label: 'Reverse', side: 'b' });
    }
    for (const c of states.CN?.cache || []) {
      const e = endFor(c.coa, !byIp[c.coa]);
      if (e) out.push({ key: `cn${c.coa}`, ...tunnel(end('CN'), e, L.C, -4, 0), color: PIPE.cn, label: ENCAP[c.encap] || 'IP-in-IP', side: 'a' });
    }
    for (const fa of ['FA-1', 'FA-2', 'FA-3']) {
      for (const f of states[fa]?.forward || []) {
        const e = end(byIp[f.coa]);
        if (e) out.push({ key: `sm${fa}`, ...tunnel(end(fa), e, L.C, 8, -24), color: PIPE.smooth, label: 'Smooth forward', side: 'a' });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states.HA, states.CN, states['FA-1'], states['FA-2'], states['FA-3'], mnLink, topology, L]);

  const badges = useMemo(() => {
    const used = fixed.used.slice();
    const tunnelPills = [];
    for (const p of pipes) {
      // candidate spots walk outwards from where the curve meets the cloud, source side first
      const ts = [];
      for (let i = 0; i <= 80; i += 1) ts.push(i / 80);
      const inside = ts.filter((t) => inEllipse(L.C, L.rx * 1.05, L.ry * 1.05, p.at(t)));
      const tIn = inside.length ? inside[0] : 0.35;
      const tOut = inside.length ? inside[inside.length - 1] : 0.65;
      const near = [];
      for (let k = 1; k <= 14; k += 1) near.push(tIn - k * 0.02, tOut + k * 0.02);
      if (p.side === 'b') near.sort((x, y) => Math.abs(x - tOut) - Math.abs(y - tOut));
      const w = tw(p.label, 11, false, 600) + 14;
      for (const t of near.filter((v) => v > 0.04 && v < 0.96)) {
        const [x, y] = p.at(t);
        const b = rect(x - w / 2, y - 9, w, 18);
        if (free(b, used)) {
          used.push(b);
          tunnelPills.push({ key: p.key, color: p.color, pill: { text: p.label, x, w, box: b } });
          break;
        }
      }
    }
    // delay badges: midpoint of the visible link run, 10 px off the line, either side.
    // They also keep off the tunnel curves so a badge never hides a pipe
    const regionBoxes = Object.values(L.R).map((g) => rect(g.x, g.y, g.w, g.h));
    for (const p of pipes) for (let i = 0; i <= 48; i += 1) { const [x, y] = p.at(i / 48); regionBoxes.push(rect(x - 2, y - 2, 4, 4)); }
    const delayPills = [];
    for (const [k, g] of Object.entries(L.R)) {
      const lc = r?.links?.[k];
      const delay = lc?.delay_ms ?? topology?.links?.[k]?.delay_ms;
      if (delay === undefined) continue;
      const loss = lc?.loss_pct || 0;
      const text = `${delay} ms${loss ? `, ${loss}% loss` : ''}`;
      const e = ellipseEdge(L.C, L.rx, L.ry, g.gw);
      const mid = [(g.gw[0] + e[0]) / 2, (g.gw[1] + e[1]) / 2];
      const n = normal(g.gw, e);
      const w = tw(text, 11, true) + 14;
      const reach = 10 + Math.abs(n[0]) * (w / 2) + Math.abs(n[1]) * 9;
      for (const s of [1, -1]) {
        const c = shift(mid, n, s * reach);
        const b = rect(c[0] - w / 2, c[1] - 9, w, 18);
        if (free(b, used) && free(b, regionBoxes)) {
          used.push(b);
          delayPills.push({ key: k, loss, pill: { text, x: c[0], w, box: b } });
          break;
        }
      }
    }
    return { tunnelPills, delayPills };
  }, [fixed, pipes, L, r, topology]);

  // Dragging the mobile node
  const toSvg = (e) => {
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svgRef.current.getScreenCTM().inverse());
    return [p.x, p.y];
  };
  const regionAt = ([x, y]) => Object.entries(L.R).find(([, g]) => g.mn && x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h)?.[0];
  const onDown = (e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(toSvg(e)); };
  const onMove = (e) => { if (drag) setDrag(toSvg(e)); };
  const onUp = (e) => {
    if (!drag) return;
    const target = regionAt(toSvg(e));
    setDrag(null);
    if (target && target !== mnLink) {
      command('MN', 'handoff', { link: target });
      localStorage.setItem('mip.hint.drag', '1');
      setHint(false);
    }
  };

  const slot = L.R[mnLink]?.mn || L.C;
  const mnPos = drag || slot;
  const hover = drag ? regionAt(drag) : null;
  const now = performance.now();
  const scTitle = scenario ? (scenarios.find((s) => s.id === scenario.id)?.title || scenario.id) : null;
  const dx = mnPos[0] - slot[0];
  const dy = mnPos[1] - slot[1];

  return (
    <div className="panel h-full flex flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">Topology</span>
        {features.ingress_filtering && <span className="badge border-warn-line bg-warn-soft text-warn">Ingress filter on</span>}
        {scenario && (
          <span className="flex items-center gap-2 min-w-0 ml-2 text-sm">
            <span className="font-semibold text-acc whitespace-nowrap">{scTitle}</span>
            {scenario.total ? <span className="font-mono text-xs text-noc-dim whitespace-nowrap">step {scenario.step || 0}/{scenario.total}</span> : null}
            <span className="text-noc-dim truncate">{scenario.note}</span>
          </span>
        )}
        {hint && !scenario && (
          <span className="ml-auto flex items-center gap-1.5 h-7 pl-2 pr-1 rounded-[3px] border border-acc-line bg-acc-soft text-xs text-noc-ink whitespace-nowrap fade-in">
            <Icon name="info" size={14} className="text-acc" />
            Drag the MN onto another network to hand off
            <button className="icon-btn btn-ghost w-6 h-6" aria-label="Dismiss hint"
              onClick={() => { localStorage.setItem('mip.hint.drag', '1'); setHint(false); }}><Icon name="close" size={12} /></button>
          </span>
        )}
      </div>

      <div ref={wrapRef} className="relative flex-1 min-h-0 bg-white">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
          className="topo absolute inset-0 w-full h-full select-none" style={{ fontFamily: SANS }} data-scale={scale.toFixed(3)}>

          {/* subnet regions, title in the top-left corner */}
          {Object.entries(L.R).map(([k, g]) => {
            const isHover = hover === k && k !== mnLink;
            const here = mnLink === k;
            return (
              <g key={k}>
                <rect x={g.x} y={g.y} width={g.w} height={g.h} rx="4"
                  fill={isHover ? '#e6edf8' : '#fafbfc'} stroke={isHover || here ? '#2457a6' : '#c3c9d1'}
                  strokeWidth={isHover || here ? 1.5 : 1} strokeDasharray={isHover ? '6 4' : undefined} />
                <text x={g.title.x + 2} y={g.y + 26} fill={INK} fontSize="13" fontWeight="600">{g.label}</text>
                <text x={g.title.x + 2} y={g.y + 43} fill={DIM} fontSize="11" fontFamily={MONO}>{g.prefix}</text>
              </g>
            );
          })}

          {/* links: agent, straight out of its region, then to the Internet */}
          {Object.entries(L.R).map(([k, g]) => {
            const loss = r?.links?.[k]?.loss_pct || 0;
            return (
              <polyline key={`l${k}`} points={`${g.a[0]},${g.a[1]} ${g.gw[0]},${g.gw[1]} ${L.C[0]},${L.C[1]}`} fill="none"
                stroke={loss ? '#c98500' : '#8d96a3'} strokeWidth="1.5" strokeDasharray={loss ? '5 3' : undefined} />
            );
          })}

          {/* attachment of the MN to the agent on its link */}
          {!drag && L.R[mnLink]?.mn && (
            <line x1={L.R[mnLink].mn[0]} y1={L.R[mnLink].mn[1]} x2={L.R[mnLink].a[0]} y2={L.R[mnLink].a[1]}
              stroke="#2457a6" strokeOpacity="0.7" strokeWidth="1.5" strokeDasharray="3 4" strokeLinecap="round" />
          )}

          {/* the Internet */}
          <path d={cloudPath(L.C, L.rx, L.ry)} fill="#eef1f5" stroke="#9aa3ae" strokeWidth="1.2" />

          {/* tunnels */}
          {pipes.map((p) => (
            <g key={p.key}>
              <path d={p.d} fill="none" stroke={p.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><title>{p.label}</title></path>
              <path d={p.d} fill="none" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="0.5 14.5" className="pipe-flow" />
            </g>
          ))}

          {/* cloud caption on a plate above the pipes */}
          <rect x={fixed.plate.x} y={fixed.plate.y} width={fixed.plate.w} height={fixed.plate.h} rx="3" fill="#eef1f5" />
          {fixed.cap.map((c, i) => (
            <text key={i} x={c.x} y={c.y} textAnchor="middle" fill={c.fill || INK} fontSize={c.px} fontWeight={c.weight || 400}
              fontFamily={c.mono ? MONO : undefined} stroke="#eef1f5">{c.text}</text>
          ))}

          {badges.delayPills.map((d) => <Pill key={`d${d.key}`} p={d.pill} color={d.loss ? '#8a5a00' : DIM} border={d.loss ? '#e3c27a' : '#c3c9d1'} />)}
          {badges.tunnelPills.map((t) => <Pill key={`p${t.key}`} p={t.pill} color={t.color} border={t.color} weight={600} mono={false} />)}

          {/* agents and the correspondent */}
          {Object.values(L.R).map((g) => (
            <g key={`a${g.k}`}>
              <g transform={`translate(${g.a[0]},${g.a[1]})`}>
                {g.agent === 'CN' ? <ServerGlyph /> : <RouterGlyph active={activeAgent === g.agent} />}
              </g>
              <Stack s={fixed.stacks[g.agent]} />
            </g>
          ))}

          {/* packets */}
          {dots.current.map((d) => {
            const t = Math.min(1, (now - d.start) / d.dur);
            const [x, y] = lerp(d.pts, t);
            if (d.arp) return <circle key={d.key} cx={x} cy={y} r={10 + t * 36} fill="none" stroke={d.color} strokeOpacity={(1 - t) * 0.8} strokeWidth="1.5" />;
            if (d.dropped && t >= 1) {
              const fade = 1 - Math.min(1, (now - d.start - d.dur) / 900);
              return (
                <g key={d.key} opacity={fade} stroke={d.color} strokeWidth="3" strokeLinecap="round">
                  <line x1={x - 6} y1={y - 6} x2={x + 6} y2={y + 6} /><line x1={x - 6} y1={y + 6} x2={x + 6} y2={y - 6} />
                </g>
              );
            }
            return <circle key={d.key} cx={x} cy={y} r="5" fill={d.color} stroke="#ffffff" strokeWidth="1.5" />;
          })}

          {/* mobile node in its reserved slot */}
          <g style={{ cursor: drag ? 'grabbing' : 'grab' }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
            <title>Drag onto another network to hand off</title>
            <g transform={`translate(${mnPos[0]},${mnPos[1]})`}>
              <rect x="-26" y="-26" width="52" height="52" fill="transparent" />
              <PhoneGlyph />
            </g>
            {fixed.mnStack && <g transform={`translate(${dx},${dy})`}><Stack s={fixed.mnStack} /></g>}
          </g>
        </svg>
      </div>

      <div className="h-8 shrink-0 flex items-center gap-4 px-4 border-t border-noc-line text-xs text-noc-dim overflow-hidden whitespace-nowrap">
        {LEGEND_DOTS.map(([k, label]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: PTYPE_COLOR[k] }} />{label}
          </span>
        ))}
        <span className="w-px h-4 bg-noc-line" />
        {LEGEND_PIPES.map(([k, label]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="w-4 h-[3px]" style={{ background: PIPE[k] }} />{label}
          </span>
        ))}
      </div>
    </div>
  );
}
