// Interactive topology map, hand-built SVG.
//  * every frame the router mirrors becomes a dot that travels the segment it actually took
//    (routed frames go through the backbone cloud, link-local frames stay inside the cell)
//  * dropped frames end in a red X where they died
//  * tunnels are dashed pipes derived from the HA binding table and the CN binding cache
//  * the mobile node can be dragged onto another network to trigger a real handoff
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { onPacket, useStore } from '../lib/store.js';
import { command } from '../lib/ws.js';
import { PTYPE_COLOR, PTYPE_LABEL } from '../lib/util.js';

const W = 1000;
const H = 600;
const ROUTER = [500, 285];
// Each network region: rectangle, where its agent sits, and where the MN sits when attached.
const REGIONS = {
  home: { x: 40, y: 30, w: 290, h: 165, agent: 'HA', a: [125, 110], mn: [250, 140] },
  cnnet: { x: 670, y: 30, w: 290, h: 165, agent: 'CN', a: [830, 112], mn: null },
  fa1: { x: 30, y: 385, w: 290, h: 175, agent: 'FA-1', a: [115, 460], mn: [240, 505] },
  fa2: { x: 355, y: 400, w: 290, h: 175, agent: 'FA-2', a: [440, 475], mn: [565, 520] },
  fa3: { x: 680, y: 385, w: 290, h: 175, agent: 'FA-3', a: [765, 460], mn: [890, 505] },
};
const NODE_LINK = { HA: 'home', CN: 'cnnet', 'FA-1': 'fa1', 'FA-2': 'fa2', 'FA-3': 'fa3' };
const MAX_DOTS = 180;

function lerp(pts, t) {
  // position at fraction t along a polyline, by length
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

const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');

export default function TopologyMap() {
  const topology = useStore((s) => s.topology);
  const states = useStore((s) => s.states);
  const svgRef = useRef(null);
  const dots = useRef([]);
  const [, setTick] = useState(0);
  const [drag, setDrag] = useState(null);

  const mnLink = states.ROUTER?.attach?.MN || states.MN?.link || 'home';
  const posRef = useRef({});

  const pos = (node, link) => {
    if (node === 'ROUTER') return ROUTER;
    if (node === 'MN') return REGIONS[link || mnLink]?.mn || ROUTER;
    const l = NODE_LINK[node];
    return l ? REGIONS[l].a : ROUTER;
  };
  posRef.current = { pos, mnLink };

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
      const { pos: p, mnLink: cur } = posRef.current;
      const now = performance.now();
      for (const ev of list) {
        if (dots.current.length >= MAX_DOTS && ev.ptype !== 'reg' && ev.ptype !== 'bu') continue;
        const from = p(ev.frm, ev.frm === 'MN' ? cur : undefined);
        let pts;
        if (ev.lkind === 'arp') pts = [from, from];
        else if (ev.lkind === 'routed') pts = ev.to ? [from, ROUTER, p(ev.to)] : [from, ROUTER];
        else {
          const to = ev.to === 'MN' && ev.verdict === 'dropped' ? (REGIONS[ev.link]?.mn || from) : p(ev.to, ev.to === 'MN' ? cur : undefined);
          pts = [from, to];
        }
        const dur = Math.min(2600, Math.max(380, 300 + (ev.delay_ms || 0) * 10));
        dots.current.push({ pts, start: now, dur, color: ev.verdict === 'dropped' ? PTYPE_COLOR.drop : (PTYPE_COLOR[ev.ptype] || '#fff'),
          dropped: ev.verdict === 'dropped', arp: ev.lkind === 'arp', key: ev.no });
      }
      if (!raf) raf = requestAnimationFrame(loop);
    });
    return () => { off(); cancelAnimationFrame(raf); };
  }, []);

  // Tunnel pipes from the live tables
  const pipes = useMemo(() => {
    const out = [];
    const faByIp = {};
    if (topology) for (const [n, v] of Object.entries(topology.nodes)) if (v.ip) faByIp[v.ip] = n;
    const endFor = (coa, colocated) => (colocated ? REGIONS[mnLink]?.mn : (faByIp[coa] && pos(faByIp[coa])));
    for (const b of states.HA?.bindings || []) {
      const end = endFor(b.coa, b.colocated);
      if (end) out.push({ key: `ha${b.coa}`, pts: [REGIONS.home.a, ROUTER, end], color: PTYPE_COLOR.tunnel, w: 7, label: `${b.encap} tunnel` });
      if (b.reverse && end) out.push({ key: `rev${b.coa}`, pts: [end, ROUTER, REGIONS.home.a], color: '#fb923c', w: 2.5, label: 'reverse tunnel' });
    }
    for (const e of states.CN?.cache || []) {
      const end = faByIp[e.coa] ? pos(faByIp[e.coa]) : REGIONS[mnLink]?.mn;
      if (end) out.push({ key: `cn${e.coa}`, pts: [REGIONS.cnnet.a, ROUTER, end], color: PTYPE_COLOR.bu, w: 5, label: 'optimized tunnel' });
    }
    for (const fa of ['FA-1', 'FA-2', 'FA-3']) {
      for (const f of states[fa]?.forward || []) {
        if (faByIp[f.coa]) out.push({ key: `sm${fa}`, pts: [pos(fa), ROUTER, pos(faByIp[f.coa])], color: '#facc15', w: 3, label: 'smooth handoff forwarding' });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [states.HA, states.CN, states['FA-1'], states['FA-2'], states['FA-3'], mnLink, topology]);

  // Dragging the mobile node
  const toSvg = (e) => {
    const pt = svgRef.current.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svgRef.current.getScreenCTM().inverse());
    return [p.x, p.y];
  };
  const regionAt = ([x, y]) => Object.entries(REGIONS).find(([k, r]) => r.mn && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)?.[0];
  const onDown = (e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(toSvg(e)); };
  const onMove = (e) => { if (drag) setDrag(toSvg(e)); };
  const onUp = (e) => {
    if (!drag) return;
    const target = regionAt(toSvg(e));
    setDrag(null);
    if (target && target !== mnLink) command('MN', 'handoff', { link: target });
  };

  const mn = states.MN;
  const mnPos = drag || REGIONS[mnLink]?.mn || ROUTER;
  const hover = drag ? regionAt(drag) : null;
  const now = performance.now();
  const r = states.ROUTER;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-title">
        Topology
        <span className="normal-case tracking-normal font-normal text-slate-500">drag the MN onto a network to hand off</span>
        {r?.ingress_filtering && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-red-900/50 text-red-300 border border-red-800">ingress filter ON</span>}
      </div>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="flex-1 w-full select-none" preserveAspectRatio="xMidYMid meet">
        {/* links from each network to the backbone */}
        {Object.entries(REGIONS).map(([k, g]) => (
          <line key={k} x1={g.a[0]} y1={g.a[1]} x2={ROUTER[0]} y2={ROUTER[1]} stroke="#334155" strokeWidth="2" />
        ))}
        {/* regions */}
        {Object.entries(REGIONS).map(([k, g]) => {
          const l = topology?.links?.[k];
          return (
            <g key={k}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} rx="12"
                fill={hover === k ? '#0c4a6e55' : '#0f172a'} stroke={hover === k ? '#38bdf8' : (mnLink === k ? '#2563eb' : '#1e293b')} strokeWidth="1.5" />
              <text x={g.x + 12} y={g.y + 20} fill="#e2e8f0" fontSize="15" fontWeight="600">{l?.label}</text>
              <text x={g.x + 12} y={g.y + 38} fill="#64748b" fontSize="12" fontFamily="monospace">{l?.prefix}  delay {l ? (r?.links?.[k]?.delay_ms ?? l.delay_ms) : ''} ms</text>
            </g>
          );
        })}
        {/* backbone cloud */}
        <g>
          <ellipse cx={ROUTER[0]} cy={ROUTER[1]} rx="120" ry="55" fill="#111c2e" stroke="#475569" strokeWidth="1.5" />
          <ellipse cx={ROUTER[0] - 70} cy={ROUTER[1] - 10} rx="55" ry="35" fill="#111c2e" stroke="#475569" strokeWidth="1.5" />
          <ellipse cx={ROUTER[0] + 70} cy={ROUTER[1] - 8} rx="55" ry="35" fill="#111c2e" stroke="#475569" strokeWidth="1.5" />
          <ellipse cx={ROUTER[0]} cy={ROUTER[1]} rx="118" ry="53" fill="#111c2e" />
          <text x={ROUTER[0]} y={ROUTER[1] - 6} textAnchor="middle" fill="#cbd5e1" fontSize="14" fontWeight="600">Internet backbone</text>
          <text x={ROUTER[0]} y={ROUTER[1] + 13} textAnchor="middle" fill="#64748b" fontSize="11" fontFamily="monospace">
            core router {r ? `${r.counters.forwarded} fwd / ${r.counters.dropped} drop` : ''}
          </text>
        </g>
        {/* tunnels */}
        {pipes.map((p) => (
          <g key={p.key}>
            <path d={path(p.pts)} fill="none" stroke={p.color} strokeOpacity="0.18" strokeWidth={p.w + 6} strokeLinejoin="round" />
            <path d={path(p.pts)} fill="none" stroke={p.color} strokeOpacity="0.85" strokeWidth={Math.max(1.5, p.w / 3)}
              strokeDasharray="8 4" className="tunnel-pipe"><title>{p.label}</title></path>
          </g>
        ))}
        {/* agents drawn above the tunnel pipes */}
        {Object.entries(REGIONS).map(([k, g]) => {
          const st = states[g.agent];
          const visitors = st?.visitors?.length;
          return (
            <g key={`a${k}`}>
              <circle cx={g.a[0]} cy={g.a[1]} r="20" fill="#1e293b" stroke={g.agent === 'CN' ? '#22c55e' : g.agent === 'HA' ? '#a855f7' : '#f59e0b'} strokeWidth="2" />
              <text x={g.a[0]} y={g.a[1] + 5} textAnchor="middle" fill="#f8fafc" fontSize="12" fontWeight="700">{g.agent}</text>
              <text x={g.a[0]} y={g.a[1] + 38} textAnchor="middle" fill="#94a3b8" fontSize="11" fontFamily="monospace">{topology?.nodes?.[g.agent]?.ip}</text>
              {visitors ? <text x={g.a[0]} y={g.a[1] + 52} textAnchor="middle" fill="#fbbf24" fontSize="11">{visitors} visitor{visitors > 1 ? 's' : ''}</text> : null}
              {g.agent === 'HA' && states.HA?.bindings?.length ? <text x={g.a[0]} y={g.a[1] + 52} textAnchor="middle" fill="#c084fc" fontSize="11">{states.HA.bindings.length} binding(s)</text> : null}
            </g>
          );
        })}
        {/* packets */}
        {dots.current.map((d) => {
          const t = Math.min(1, (now - d.start) / d.dur);
          const [x, y] = lerp(d.pts, t);
          if (d.arp) return <circle key={d.key} cx={x} cy={y} r={8 + t * 40} fill="none" stroke={d.color} strokeOpacity={1 - t} strokeWidth="2" />;
          if (d.dropped && t >= 1) {
            const fade = 1 - Math.min(1, (now - d.start - d.dur) / 900);
            return (
              <g key={d.key} opacity={fade} stroke={d.color} strokeWidth="3">
                <line x1={x - 7} y1={y - 7} x2={x + 7} y2={y + 7} /><line x1={x - 7} y1={y + 7} x2={x + 7} y2={y - 7} />
              </g>
            );
          }
          return <circle key={d.key} cx={x} cy={y} r="5" fill={d.color} stroke="#0b1018" strokeWidth="1.5" />;
        })}
        {/* mobile node */}
        <g transform={`translate(${mnPos[0]},${mnPos[1]})`} style={{ cursor: drag ? 'grabbing' : 'grab' }}
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
          <rect x="-17" y="-24" width="34" height="48" rx="7" fill="#1d4ed8" stroke="#93c5fd" strokeWidth="2" />
          <rect x="-11" y="-17" width="22" height="28" rx="2" fill="#0b1018" />
          <text y="3" textAnchor="middle" fill="#bfdbfe" fontSize="11" fontWeight="700">MN</text>
          <text y="40" textAnchor="middle" fill="#e2e8f0" fontSize="11" fontFamily="monospace">{mn?.home}</text>
          <text y="54" textAnchor="middle" fill="#7dd3fc" fontSize="10">{mn?.state}</text>
          {mn?.binding?.coa && <text y="67" textAnchor="middle" fill="#94a3b8" fontSize="10" fontFamily="monospace">CoA {mn.binding.coa}</text>}
        </g>
        {/* legend */}
        <g transform="translate(16,232)">
          {Object.entries(PTYPE_LABEL).filter(([k]) => k !== 'arp' && k !== 'icmp').map(([k, label], i) => (
            <g key={k} transform={`translate(0,${i * 17})`}>
              <circle cx="6" cy="0" r="5" fill={PTYPE_COLOR[k]} />
              <text x="16" y="4" fill="#94a3b8" fontSize="11">{label}</text>
            </g>
          ))}
          <g transform="translate(0,108)"><line x1="0" y1="0" x2="14" y2="0" stroke={PTYPE_COLOR.tunnel} strokeWidth="3" strokeDasharray="5 3" /><text x="18" y="4" fill="#94a3b8" fontSize="11">HA tunnel</text></g>
          <g transform="translate(0,125)"><line x1="0" y1="0" x2="14" y2="0" stroke={PTYPE_COLOR.bu} strokeWidth="3" strokeDasharray="5 3" /><text x="18" y="4" fill="#94a3b8" fontSize="11">CN direct tunnel</text></g>
        </g>
      </svg>
    </div>
  );
}
