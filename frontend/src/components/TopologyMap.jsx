// Interactive topology map, hand-built SVG.
//  * the layout is computed from the panel's aspect ratio, so the diagram always fills it
//  * text is counter-scaled so labels render at true 11 / 13 / 15 px whatever the zoom
//  * every frame the router mirrors becomes a dot travelling along the drawn links
//    (node -> its subnet edge -> Internet -> far subnet edge -> node); drops end in a red X
//  * tunnels are smooth curved pipes derived from the HA binding table and the CN cache
//  * the mobile node can be dragged onto another network to trigger a real handoff
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { onPacket, useStore } from '../lib/store.js';
import { command } from '../lib/ws.js';
import { PTYPE_COLOR } from '../lib/util.js';
import { Icon } from './ui.jsx';

const MAX_DOTS = 180;
const NODE_LINK = { HA: 'home', CN: 'cnnet', 'FA-1': 'fa1', 'FA-2': 'fa2', 'FA-3': 'fa3' };
const ENCAP = { ipip: 'IP-in-IP', minimal: 'Minimal', gre: 'GRE' };
const PIPE = { ha: '#a855f7', cn: '#06b6d4', rev: '#fb923c', smooth: '#facc15' };
const LEGEND_DOTS = [['adv', 'Advertisement'], ['reg', 'Registration'], ['tunnel', 'Tunneled'], ['data', 'Plain data'], ['bu', 'Binding update'], ['drop', 'Dropped']];
const LEGEND_PIPES = [['ha', 'HA tunnel'], ['cn', 'CN tunnel'], ['rev', 'Reverse']];

/**
 * Region and node positions for a canvas W x H in (roughly) screen pixels. fs converts a
 * pixel size to canvas units, so label offsets keep clear of glyphs at any zoom.
 */
function layout(W, H, fs) {
  const T = (px) => px * fs;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const m = 14;
  const g = 22;
  const topW = Math.min(420, W * 0.34);
  const topH = clamp(H * 0.31, 150, 230);
  const bw = (W - 2 * m - 2 * g) / 3;
  const bh = clamp(H * 0.35, 176, 250);
  const by = H - m - bh;
  const gap = by - (m + topH);
  const C = [W / 2, m + topH + gap / 2];
  const topAgentY = m + topH - 26 - T(50);
  const mnY = (y, h) => y + h - 30 - T(44);
  const R = {
    home: { x: m, y: m, w: topW, h: topH, agent: 'HA', a: [m + topW - 84, topAgentY], mn: [m + 96, mnY(m, topH)], lab: 'tl' },
    cnnet: { x: W - m - topW, y: m, w: topW, h: topH, agent: 'CN', a: [W - m - topW + 84, topAgentY], mn: null, lab: 'tr' },
    fa1: { x: m, y: by, w: bw, h: bh, agent: 'FA-1', a: [m + bw * 0.7, by + 36], mn: [m + bw * 0.42, mnY(by, bh)], lab: 'bl' },
    fa2: { x: m + bw + g, y: by, w: bw, h: bh, agent: 'FA-2', a: [m + bw + g + bw * 0.5, by + 36], mn: [m + bw + g + bw * 0.76, mnY(by, bh)], lab: 'bl' },
    fa3: { x: m + 2 * (bw + g), y: by, w: bw, h: bh, agent: 'FA-3', a: [m + 2 * (bw + g) + bw * 0.3, by + 36], mn: [m + 2 * (bw + g) + bw * 0.64, mnY(by, bh)], lab: 'br' },
  };
  const rx = Math.min(200, W * 0.15);
  const ry = Math.max(40, Math.min(66, gap * 0.4));
  for (const r of Object.values(R)) r.gw = exitPoint(r, r.a, C);
  return { W, H, C, rx, ry, R };
}

function exitPoint(r, a, c) {
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  let t = 1;
  if (dx > 0) t = Math.min(t, (r.x + r.w - a[0]) / dx);
  if (dx < 0) t = Math.min(t, (r.x - a[0]) / dx);
  if (dy > 0) t = Math.min(t, (r.y + r.h - a[1]) / dy);
  if (dy < 0) t = Math.min(t, (r.y - a[1]) / dy);
  return [a[0] + dx * t, a[1] + dy * t];
}

function ellipseEdge(C, rx, ry, p) {
  const dx = p[0] - C[0];
  const dy = p[1] - C[1];
  const t = 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
  return [C[0] + dx * t, C[1] + dy * t];
}

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

/** Cubic curve from a to b that bows through the cloud, shifted sideways by off units. */
function curve(a, b, C, off = 0) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const p1 = [a[0] + (C[0] - a[0]) * 0.7 + nx * off, a[1] + (C[1] - a[1]) * 0.7 + ny * off];
  const p2 = [b[0] + (C[0] - b[0]) * 0.7 + nx * off, b[1] + (C[1] - b[1]) * 0.7 + ny * off];
  const at = (t) => {
    const u = 1 - t;
    return [0, 1].map((k) => u * u * u * a[k] + 3 * u * u * t * p1[k] + 3 * u * t * t * p2[k] + t * t * t * b[k]);
  };
  return { d: `M${a[0]},${a[1]} C${p1[0]},${p1[1]} ${p2[0]},${p2[1]} ${b[0]},${b[1]}`, at };
}

// ---- device glyphs (drawn around 0,0) ----

function RouterGlyph({ active }) {
  const ring = active ? '#38bdf8' : '#4b5a70';
  const arrow = active ? '#bae6fd' : '#cbd5e1';
  const arr = (rot, inward) => (
    <g transform={`rotate(${rot})`}>
      <path d={inward ? 'M0,-13 L0,-5 M-3,-8 L0,-5 L3,-8' : 'M0,-5 L0,-13 M-3,-10 L0,-13 L3,-10'}
        fill="none" stroke={arrow} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  );
  return (
    <g>
      {active && <circle r="27" fill="#38bdf8" opacity="0.12" />}
      <circle r="19" fill="#1a2332" stroke={ring} strokeWidth="1.6" />
      {arr(45, true)}{arr(225, true)}{arr(135, false)}{arr(315, false)}
    </g>
  );
}

function ServerGlyph() {
  return (
    <g>
      <rect x="-15" y="-21" width="30" height="42" rx="4" fill="#1a2332" stroke="#4b5a70" strokeWidth="1.6" />
      {[-13, -2, 9].map((y) => (
        <g key={y}>
          <rect x="-10" y={y} width="20" height="7" rx="1.5" fill="#243042" />
          <circle cx="6" cy={y + 3.5} r="1.4" fill="#22c55e" />
          <line x1="-7" y1={y + 3.5} x2="1" y2={y + 3.5} stroke="#64748b" strokeWidth="1.2" />
        </g>
      ))}
    </g>
  );
}

function PhoneGlyph({ dragging }) {
  return (
    <g>
      <circle r="30" fill="#38bdf8" opacity={dragging ? 0.22 : 0.12} />
      <rect x="-13" y="-21" width="26" height="42" rx="5" fill="#0c4a6e" stroke="#38bdf8" strokeWidth="1.8" />
      <rect x="-9" y="-15" width="18" height="26" rx="1.5" fill="#0b1018" />
      <path d="M-5,-5 a7,7 0 0 1 10,0 M-2.5,-2 a3.5,3.5 0 0 1 5,0" fill="none" stroke="#7dd3fc" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="0" cy="2" r="1.2" fill="#e0f2fe" />
      <rect x="-3" y="15" width="6" height="1.6" rx="0.8" fill="#7dd3fc" />
    </g>
  );
}

function Pill({ x, y, text, fs, color = '#9ca3af', border = '#2b3646', bg = '#0d141f', mono = true, size = 11 }) {
  const w = (text.length * (mono ? 0.62 : 0.58) * size + 12) * fs;
  const h = (size + 7) * fs;
  return (
    <g transform={`translate(${x},${y})`} pointerEvents="none">
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} fill={bg} stroke={border} strokeWidth={fs} />
      <text y={size * 0.36 * fs} textAnchor="middle" fill={color} fontSize={size * fs}
        fontFamily={mono ? 'var(--mono)' : undefined} fontWeight={mono ? 400 : 500}>{text}</text>
    </g>
  );
}

export default function TopologyMap() {
  const topology = useStore((s) => s.topology);
  const states = useStore((s) => s.states);
  const scenario = useStore((s) => s.scenario);
  const scenarios = useStore((s) => s.scenarios);
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const dots = useRef([]);
  const [, setTick] = useState(0);
  const [drag, setDrag] = useState(null);
  const [box, setBox] = useState({ w: 1100, h: 640 });
  const [legend, setLegend] = useState(false);
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

  // canvas in screen pixels, scaled down only when the panel is smaller than 760 x 440
  const W = Math.max(760, Math.round(box.w));
  const H = Math.max(440, Math.round(box.h));
  const scale = Math.min(box.w / W, box.h / H);
  const fs = 1 / scale; // multiply a pixel size by fs to get canvas units
  const L = useMemo(() => layout(W, H, fs), [W, H, fs]);

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
          color: ev.verdict === 'dropped' ? PTYPE_COLOR.drop : (PTYPE_COLOR[ev.ptype] || '#fff'),
          dropped: ev.verdict === 'dropped', arp: ev.lkind === 'arp',
        });
      }
      if (!raf) raf = requestAnimationFrame(loop);
    });
    return () => { off(); cancelAnimationFrame(raf); };
  }, []);

  // Tunnel pipes from the live tables
  const pipes = useMemo(() => {
    const out = [];
    const byIp = {};
    if (topology) for (const [n, v] of Object.entries(topology.nodes)) if (v.ip) byIp[v.ip] = n;
    const endFor = (coa, colocated) => (colocated ? L.R[mnLink]?.mn : (byIp[coa] && pos(byIp[coa])));
    for (const b of states.HA?.bindings || []) {
      const end = endFor(b.coa, b.colocated);
      if (!end) continue;
      out.push({ key: `ha${b.coa}`, ...curve(L.R.home.a, end, L.C, 0), color: PIPE.ha, label: ENCAP[b.encap] || b.encap, labelAt: 0.36 });
      if (b.reverse) out.push({ key: `rev${b.coa}`, ...curve(end, L.R.home.a, L.C, 44), color: PIPE.rev, label: 'Reverse', labelAt: 0.22 });
    }
    for (const e of states.CN?.cache || []) {
      const end = byIp[e.coa] ? pos(byIp[e.coa]) : L.R[mnLink]?.mn;
      if (end) out.push({ key: `cn${e.coa}`, ...curve(L.R.cnnet.a, end, L.C, 0), color: PIPE.cn, label: ENCAP[e.encap] || 'IP-in-IP', labelAt: 0.36 });
    }
    for (const fa of ['FA-1', 'FA-2', 'FA-3']) {
      for (const f of states[fa]?.forward || []) {
        if (byIp[f.coa]) out.push({ key: `sm${fa}`, ...curve(pos(fa), pos(byIp[f.coa]), L.C, -30), color: PIPE.smooth, label: 'Smooth forward', labelAt: 0.5 });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states.HA, states.CN, states['FA-1'], states['FA-2'], states['FA-3'], mnLink, topology, L]);

  // Dragging the mobile node
  const toSvg = (e) => {
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svgRef.current.getScreenCTM().inverse());
    return [p.x, p.y];
  };
  const regionAt = ([x, y]) => Object.entries(L.R).find(([, r]) => r.mn && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)?.[0];
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

  const mn = states.MN;
  const mnPos = drag || L.R[mnLink]?.mn || L.C;
  const hover = drag ? regionAt(drag) : null;
  const now = performance.now();
  const r = states.ROUTER;
  const activeAgent = L.R[mnLink]?.agent;
  const T = (px) => px * fs;
  const scTitle = scenario ? (scenarios.find((s) => s.id === scenario.id)?.title || scenario.id) : null;

  return (
    <div className="panel h-full flex flex-col overflow-hidden">
      <div className="panel-head">
        <span className="panel-title">Topology</span>
        {r?.ingress_filtering && <span className="badge border-amber-500/40 bg-amber-500/10 text-amber-300">Ingress filter on</span>}
        {box.w < 1060 ? (
          <div className="ml-auto relative">
            <button className="btn h-6 px-2 text-2xs" onClick={() => setLegend(!legend)} aria-expanded={legend}>
              <span className="flex -space-x-0.5">{['adv', 'reg', 'tunnel', 'data'].map((k) => <span key={k} className="w-2 h-2 rounded-full ring-1 ring-noc-panel" style={{ background: PTYPE_COLOR[k] }} />)}</span>
              Legend
            </button>
            {legend && (
              <div className="absolute right-0 top-8 z-30 w-48 p-3 rounded-lg border border-noc-edge bg-noc-raised shadow-xl shadow-black/50 grid gap-1.5 text-2xs text-noc-dim fade-in">
                {LEGEND_DOTS.map(([k, label]) => (
                  <span key={k} className="flex items-center gap-2"><span className="w-2 h-2 rounded-full" style={{ background: PTYPE_COLOR[k] }} />{label}</span>
                ))}
                <span className="h-px bg-noc-line my-0.5" />
                {LEGEND_PIPES.map(([k, label]) => (
                  <span key={k} className="flex items-center gap-2"><span className="w-4 h-[3px] rounded-full" style={{ background: PIPE[k] }} />{label}</span>
                ))}
              </div>
            )}
          </div>
        ) : (
        <div className="ml-auto flex items-center gap-3 text-2xs text-noc-dim overflow-hidden whitespace-nowrap">
          {LEGEND_DOTS.map(([k, label]) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: PTYPE_COLOR[k], boxShadow: `0 0 6px ${PTYPE_COLOR[k]}` }} />{label}
            </span>
          ))}
          <span className="w-px h-4 bg-noc-line" />
          {LEGEND_PIPES.map(([k, label]) => (
            <span key={k} className="flex items-center gap-1.5">
              <span className="w-4 h-[3px] rounded-full" style={{ background: PIPE[k] }} />{label}
            </span>
          ))}
        </div>
        )}
      </div>

      <div ref={wrapRef} className="relative flex-1 min-h-0">
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet"
          className="topo absolute inset-0 w-full h-full select-none" style={{ '--mono': '"Cascadia Mono", Consolas, monospace' }}>
          <defs>
            <filter id="soft-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9" /></filter>
            <filter id="dot-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.5" /></filter>
            <radialGradient id="cloud-fill" cx="50%" cy="40%" r="70%">
              <stop offset="0%" stopColor="#1a2536" /><stop offset="100%" stopColor="#121b29" />
            </radialGradient>
          </defs>

          {/* subnet regions */}
          {Object.entries(L.R).map(([k, g]) => {
            const l = topology?.links?.[k];
            const isHover = hover === k && k !== mnLink;
            const here = mnLink === k;
            const tx = g.lab.endsWith('r') ? g.x + g.w - 16 : g.x + 16;
            const anchor = g.lab.endsWith('r') ? 'end' : 'start';
            const ty = g.lab.startsWith('t') ? g.y + 16 + T(15) : g.y + g.h - 16 - T(16);
            return (
              <g key={k}>
                {isHover && <rect x={g.x} y={g.y} width={g.w} height={g.h} rx="14" fill="none" stroke="#38bdf8" strokeWidth="10" opacity="0.55" filter="url(#soft-glow)" />}
                <rect x={g.x} y={g.y} width={g.w} height={g.h} rx="14"
                  fill={isHover ? '#0f2233' : '#0d141f'} stroke={here ? '#38bdf8' : '#1f2937'} strokeOpacity={here ? 0.35 : 1} strokeWidth="1.2" />
                <text x={tx} y={ty} textAnchor={anchor} fill="#e5e7eb" fontSize={T(13)} fontWeight="600">{l?.label}</text>
                <text x={tx} y={ty + T(16)} textAnchor={anchor} fill="#6b7280" fontSize={T(11)} fontFamily="var(--mono)">{l?.prefix}</text>
              </g>
            );
          })}

          {/* links: agent to subnet edge to the Internet, delay label on the line */}
          {Object.entries(L.R).map(([k, g]) => {
            const loss = r?.links?.[k]?.loss_pct || 0;
            return (
              <g key={`l${k}`}>
                <line x1={g.a[0]} y1={g.a[1]} x2={L.C[0]} y2={L.C[1]} stroke={loss ? '#8a6a2a' : '#3b4757'} strokeWidth="1.5" />
              </g>
            );
          })}

          {/* wireless or LAN attachment of the MN to the agent on its link */}
          {!drag && L.R[mnLink]?.mn && (
            <line x1={L.R[mnLink].mn[0]} y1={L.R[mnLink].mn[1]} x2={L.R[mnLink].a[0]} y2={L.R[mnLink].a[1]}
              stroke="#38bdf8" strokeOpacity="0.5" strokeWidth="1.5" strokeDasharray="3 5" strokeLinecap="round" />
          )}

          {/* the Internet */}
          <g>
            <path d={cloudPath(L.C, L.rx, L.ry)} fill="url(#cloud-fill)" stroke="#3b4757" strokeWidth="1.5" />
          </g>

          {/* tunnels */}
          {pipes.map((p) => (
            <g key={p.key}>
              <path d={p.d} fill="none" stroke={p.color} strokeOpacity="0.16" strokeWidth="10" strokeLinecap="round" />
              <path d={p.d} fill="none" stroke={p.color} strokeOpacity="0.9" strokeWidth="2.2" strokeLinecap="round"><title>{p.label}</title></path>
              <path d={p.d} fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="0.5 14.5" className="pipe-flow" />
            </g>
          ))}

          {/* labels that must stay readable above the pipes: cloud text, link delays, pipe names */}
          <g className="halo">
            {(() => {
              const bb = r?.backbone?.delay_ms ?? topology?.backbone?.delay_ms ?? '-';
              const l2 = `10.0.0.1, backbone ${bb} ms`;
              const l3 = r ? `${r.counters.forwarded} forwarded, ${r.counters.dropped} dropped` : '';
              const w = (Math.max(l2.length, l3.length) * 6.9 + 24) * fs;
              const h = (r ? 62 : 46) * fs;
              return (
                <>
                  <rect x={L.C[0] - w / 2} y={L.C[1] - T(28)} width={w} height={h} rx={T(8)} fill="#141e2d" fillOpacity="0.94" />
                  <text x={L.C[0]} y={L.C[1] - T(9)} textAnchor="middle" fill="#e5e7eb" fontSize={T(15)} fontWeight="600">Internet</text>
                  <text x={L.C[0]} y={L.C[1] + T(9)} textAnchor="middle" fill="#9ca3af" fontSize={T(11)} fontFamily="var(--mono)">{l2}</text>
                  {r && <text x={L.C[0]} y={L.C[1] + T(25)} textAnchor="middle" fill="#6b7280" fontSize={T(11)} fontFamily="var(--mono)">{l3}</text>}
                </>
              );
            })()}
          </g>

          {Object.entries(L.R).map(([k, g]) => {
            const pipeLabels = pipes.map((p) => p.at(p.labelAt ?? 0.3));
            const lc = r?.links?.[k];
            const delay = lc?.delay_ms ?? topology?.links?.[k]?.delay_ms;
            if (delay === undefined) return null;
            const loss = lc?.loss_pct || 0;
            const edge = ellipseEdge(L.C, L.rx * 0.95, L.ry * 0.95, g.a);
            const run = Math.hypot(edge[0] - g.gw[0], edge[1] - g.gw[1]);
            const along = (f) => [g.gw[0] + (edge[0] - g.gw[0]) * f, g.gw[1] + (edge[1] - g.gw[1]) * f];
            const clear = (q) => pipeLabels.every(([x, y]) => Math.abs(x - q[0]) > 78 * fs || Math.abs(y - q[1]) > 22 * fs)
              && Object.values(L.R).every((o) => Math.abs(o.a[0] - q[0]) > 70 * fs || q[1] < o.a[1] - 26 || q[1] > o.a[1] + 30 + 52 * fs);
            let at = [0.3, 0.05, 0.6, 0.85].map(along).find(clear);
            if (run < 70) {
              // short hop (the subnet right under the cloud): park the label beside the line
              const mid = [(g.a[0] + edge[0]) / 2, (g.a[1] + edge[1]) / 2];
              at = [mid[0] - 46 * fs, mid[1]];
            }
            if (!at) return null; // no free spot on a cramped canvas: the delay is still under Link conditions
            return <Pill key={`d${k}`} x={at[0]} y={at[1]} fs={fs} text={`${delay} ms${loss ? `, ${loss}% loss` : ''}`} color={loss ? '#fbbf24' : '#9ca3af'} />;
          })}
          {pipes.map((p) => {
            const [x, y] = p.at(p.labelAt ?? 0.3);
            return <Pill key={`p${p.key}`} x={x} y={y} fs={fs} text={p.label} color={p.color} border={p.color} bg="#0d141f" mono={false} />;
          })}

          {/* agents and the correspondent */}
          {Object.entries(L.R).map(([k, g]) => {
            const st = states[g.agent];
            const isCn = g.agent === 'CN';
            const visitors = st?.visitors?.length || 0;
            const bindings = g.agent === 'HA' ? (states.HA?.bindings?.length || 0) : 0;
            const extra = visitors ? `${visitors} visitor${visitors > 1 ? 's' : ''}` : bindings ? `${bindings} binding${bindings > 1 ? 's' : ''}` : '';
            return (
              <g key={`a${k}`} transform={`translate(${g.a[0]},${g.a[1]})`}>
                {isCn ? <ServerGlyph /> : <RouterGlyph active={activeAgent === g.agent} />}
                <text y={24 + T(14)} textAnchor="middle" fill="#e5e7eb" fontSize={T(13)} fontWeight="600">{g.agent}</text>
                <text y={24 + T(28)} textAnchor="middle" fill="#9ca3af" fontSize={T(11)} fontFamily="var(--mono)">{topology?.nodes?.[g.agent]?.ip}</text>
                {extra && <Pill x={0} y={24 + T(44)} fs={fs} text={extra} color="#7dd3fc" border="#0c4a6e" bg="#0b1a29" mono={false} />}
              </g>
            );
          })}

          {/* packets */}
          {dots.current.map((d) => {
            const t = Math.min(1, (now - d.start) / d.dur);
            const [x, y] = lerp(d.pts, t);
            if (d.arp) return <circle key={d.key} cx={x} cy={y} r={10 + t * 36} fill="none" stroke={d.color} strokeOpacity={(1 - t) * 0.8} strokeWidth="1.5" />;
            if (d.dropped && t >= 1) {
              const fade = 1 - Math.min(1, (now - d.start - d.dur) / 900);
              return (
                <g key={d.key} opacity={fade} stroke={d.color} strokeWidth="3" strokeLinecap="round">
                  <circle cx={x} cy={y} r="11" fill={d.color} fillOpacity="0.15" stroke="none" />
                  <line x1={x - 6} y1={y - 6} x2={x + 6} y2={y + 6} /><line x1={x - 6} y1={y + 6} x2={x + 6} y2={y - 6} />
                </g>
              );
            }
            return (
              <g key={d.key}>
                <circle cx={x} cy={y} r="8" fill={d.color} opacity="0.45" filter="url(#dot-glow)" />
                <circle cx={x} cy={y} r="5.5" fill={d.color} stroke="#0b1018" strokeWidth="1" />
              </g>
            );
          })}

          {/* mobile node */}
          <g transform={`translate(${mnPos[0]},${mnPos[1]})`} style={{ cursor: drag ? 'grabbing' : 'grab' }}
            onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
            <title>Drag onto another network to hand off</title>
            <PhoneGlyph dragging={!!drag} />
            <text y={26 + T(14)} textAnchor="middle" fill="#e0f2fe" fontSize={T(13)} fontWeight="600">MN</text>
            <text y={26 + T(28)} textAnchor="middle" fill="#9ca3af" fontSize={T(11)} fontFamily="var(--mono)">{mn?.home}</text>
            {mn?.binding?.coa && (
              <text y={26 + T(42)} textAnchor="middle" fill="#7dd3fc" fontSize={T(11)} fontFamily="var(--mono)">CoA {mn.binding.coa}</text>
            )}
          </g>
        </svg>

        {scenario && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 max-w-[70%] fade-in">
            <div className="flex items-center gap-2 h-8 px-3 rounded-full border border-sky-500/40 bg-[#0b1a29]/95 shadow-lg shadow-black/40">
              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
              <span className="text-xs font-semibold text-sky-200 whitespace-nowrap">{scTitle}</span>
              {scenario.total ? <span className="font-mono text-2xs text-noc-mute whitespace-nowrap">{scenario.step || 0}/{scenario.total}</span> : null}
              <span className="text-xs text-noc-dim truncate">{scenario.note}</span>
            </div>
          </div>
        )}

        {hint && !drag && (() => {
          // one-time tooltip anchored above the MN glyph
          const ox = (box.w - W * scale) / 2;
          const oy = (box.h - H * scale) / 2;
          const HINT_W = 330;
          const mx = ox + mnPos[0] * scale;
          const right = mx + 38 * scale + HINT_W < box.w || mx - 38 * scale - HINT_W < 0;
          const x = ox + (mnPos[0] + (right ? 38 : -38)) * scale;
          const y = oy + mnPos[1] * scale;
          return (
            <div className={`absolute z-20 -translate-y-1/2 flex items-center fade-in ${right ? '' : '-translate-x-full flex-row-reverse'}`} style={{ left: x, top: y }}>
              <div className={`w-2 h-2 rotate-45 bg-[#0b1a29] border-sky-500/40 ${right ? '-mr-1 border-l border-b' : '-ml-1 border-r border-t'}`} />
              <div className="flex items-center gap-2 h-8 pl-2.5 pr-1 rounded-md border border-sky-500/40 bg-[#0b1a29] text-xs text-sky-100 shadow-lg shadow-black/50 whitespace-nowrap">
                <Icon name="info" size={14} className="text-sky-400" />
                Drag the MN onto another network to hand off
                <button className="icon-btn btn-ghost w-6 h-6" aria-label="Dismiss hint"
                  onClick={() => { localStorage.setItem('mip.hint.drag', '1'); setHint(false); }}><Icon name="close" size={12} /></button>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
