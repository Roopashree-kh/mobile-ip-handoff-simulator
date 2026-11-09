// Story mode scene: a flat illustration of Priya's day. Four places along the ground, the
// Internet cloud and the video server above. Clicking a place walks Priya there, and the
// real handoff is sent when she arrives. Envelopes travel the path the real packets take,
// at most one per second so the eye can follow them while the stream keeps running.
import React, { useEffect, useRef, useState } from 'react';
import { onData, onPacket, useStore } from '../../lib/store.js';
import { command } from '../../lib/ws.js';
import { onWalkRequest, PLACES, PLACE_ORDER } from '../../lib/story.js';

const VW = 1000;
const VH = 400;
const GROUND = 330;
const SPEED = 330; // envelope speed, scene units per second
const WALK_MS = 1600;
const CLOUD = [440, 84];
const HUB = [440, 112]; // where envelopes cross the cloud, under its label
const SERVER = [905, 88];
const SPOT = {
  home: { x: 120, ap: [232, 286], priya: 168 },
  fa1: { x: 370, ap: [432, 194], priya: 404 },
  fa2: { x: 620, ap: [652, 248], priya: 598 },
  fa3: { x: 870, ap: [772, 216], priya: 842 },
};
const SKY = '#eaf3fb';
const INK = '#1f2933';
const DIM = '#5f6b7a';
const ACC = '#2457a6';

// ---- illustrations, each drawn in scene coordinates ----

function House() {
  return (
    <g>
      <rect x="48" y="240" width="144" height="90" fill="#f3dcb5" stroke="#b98d5c" strokeWidth="2" />
      <polygon points="36,244 120,186 204,244" fill="#c8553d" stroke="#9d3f2c" strokeWidth="2" strokeLinejoin="round" />
      <rect x="104" y="282" width="32" height="48" rx="3" fill="#8a5a3c" />
      <circle cx="129" cy="307" r="2.2" fill="#f3dcb5" />
      <rect x="62" y="262" width="30" height="26" rx="2" fill="#bfe0f5" stroke="#b98d5c" strokeWidth="2" />
      <rect x="150" y="262" width="30" height="26" rx="2" fill="#bfe0f5" stroke="#b98d5c" strokeWidth="2" />
      {/* the home router on a small stand */}
      <rect x="216" y="306" width="34" height="14" rx="3" fill="#ffffff" stroke="#5f6b7a" strokeWidth="2" />
      <line x1="222" y1="306" x2="219" y2="290" stroke="#5f6b7a" strokeWidth="2" strokeLinecap="round" />
      <line x1="244" y1="306" x2="247" y2="290" stroke="#5f6b7a" strokeWidth="2" strokeLinecap="round" />
      <circle cx="226" cy="313" r="2" fill="#2f9e44" />
      <rect x="226" y="320" width="14" height="10" fill="#d6c3a5" />
    </g>
  );
}

function Campus() {
  return (
    <g>
      <rect x="300" y="242" width="140" height="88" fill="#e3e6ee" stroke="#8d96a3" strokeWidth="2" />
      <polygon points="292,244 370,206 448,244" fill="#cfd5e0" stroke="#8d96a3" strokeWidth="2" strokeLinejoin="round" />
      {[316, 344, 396, 424].map((x) => <rect key={x} x={x - 5} y="252" width="10" height="72" fill="#f7f8fa" stroke="#a7b0bc" strokeWidth="1.5" />)}
      <rect x="356" y="290" width="28" height="40" rx="2" fill="#8a6a4f" />
      <circle cx="370" cy="228" r="7" fill="#f7f8fa" stroke="#8d96a3" strokeWidth="1.5" />
      <line x1="432" y1="236" x2="432" y2="200" stroke="#5f6b7a" strokeWidth="2.5" strokeLinecap="round" />
    </g>
  );
}

function Train() {
  return (
    <g>
      <line x1="520" y1="330" x2="720" y2="330" stroke="#7b8794" strokeWidth="3" />
      <rect x="540" y="266" width="160" height="54" rx="14" fill="#3f8f80" stroke="#2c6b5f" strokeWidth="2" />
      <rect x="540" y="304" width="160" height="6" fill="#f2c94c" />
      {[556, 586, 616, 646].map((x) => <rect key={x} x={x} y="276" width="22" height="20" rx="3" fill="#d8eef3" />)}
      <rect x="676" y="276" width="16" height="20" rx="3" fill="#d8eef3" />
      {[566, 600, 640, 674].map((x) => <circle key={x} cx={x} cy="322" r="7" fill="#3d4a5a" />)}
      <polyline points="638,266 652,252 666,266" fill="none" stroke="#5f6b7a" strokeWidth="2.5" strokeLinejoin="round" />
    </g>
  );
}

function Airport() {
  return (
    <g>
      <line x1="790" y1="330" x2="990" y2="330" stroke="#7b8794" strokeWidth="3" strokeDasharray="14 10" />
      <rect x="765" y="246" width="14" height="84" fill="#cfd5e0" stroke="#8d96a3" strokeWidth="2" />
      <rect x="754" y="228" width="36" height="20" rx="3" fill="#e3e6ee" stroke="#8d96a3" strokeWidth="2" />
      <rect x="759" y="233" width="26" height="8" fill="#bfe0f5" />
      <line x1="772" y1="228" x2="772" y2="220" stroke="#5f6b7a" strokeWidth="2.5" strokeLinecap="round" />
      <polygon points="806,294 818,262 836,262 842,294" fill="#3b82c4" />
      <rect x="804" y="292" width="170" height="26" rx="13" fill="#ffffff" stroke="#8d96a3" strokeWidth="2" />
      {[860, 880, 900, 920, 940].map((x) => <circle key={x} cx={x} cy="302" r="3.5" fill="#bfe0f5" />)}
      <polygon points="866,310 912,310 884,330" fill="#cfd5e0" stroke="#8d96a3" strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="830" cy="324" r="4" fill="#3d4a5a" />
      <circle cx="950" cy="324" r="4" fill="#3d4a5a" />
    </g>
  );
}

function Server() {
  const [x, y] = SERVER;
  return (
    <g>
      <rect x={x - 38} y={y - 44} width="76" height="88" rx="6" fill="#e3e6ee" stroke="#8d96a3" strokeWidth="2" />
      {[-30, -8, 14].map((d) => <rect key={d} x={x - 28} y={y + d} width="56" height="14" rx="3" fill="#cfd5e0" />)}
      <circle cx={x} cy={y - 2} r="18" fill="#e8663d" />
      <polygon points={`${x - 6},${y - 12} ${x - 6},${y + 8} ${x + 11},${y - 2}`} fill="#ffffff" />
    </g>
  );
}

function Cloud() {
  const [cx, cy] = CLOUD;
  return (
    <g>
      <path d={`M${cx - 104},${cy + 30} a30,30 0 0 1 8,-52 a40,40 0 0 1 64,-24 a46,46 0 0 1 82,8 a34,34 0 0 1 54,40 a26,26 0 0 1 -12,28 z`}
        fill="#ffffff" stroke="#9aa9bb" strokeWidth="2" strokeLinejoin="round" />
    </g>
  );
}

function Signal({ at, on }) {
  const c = on ? ACC : '#b7c4d3';
  return (
    <g fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round">
      <path d={`M${at[0] - 9},${at[1] - 6} a12,12 0 0 1 18,0`} />
      <path d={`M${at[0] - 16},${at[1] - 12} a22,22 0 0 1 32,0`} opacity={on ? 1 : 0.7} />
    </g>
  );
}

function Priya({ x, phase, facing, busy }) {
  const swing = Math.sin(phase) * 18;
  return (
    <g transform={`translate(${x},${GROUND + 6}) scale(${facing},1)`}>
      <ellipse cx="0" cy="2" rx="18" ry="4" fill="#000" opacity="0.12" />
      <g transform={`rotate(${swing},0,-30)`}><rect x="-7" y="-30" width="7" height="30" rx="3" fill="#3b4a6b" /></g>
      <g transform={`rotate(${-swing},0,-30)`}><rect x="0" y="-30" width="7" height="30" rx="3" fill="#33415e" /></g>
      <path d="M-13,-30 L-10,-58 Q0,-64 10,-58 L13,-30 Z" fill="#e0607e" />
      <rect x="6" y="-56" width="6" height="16" rx="3" fill="#c68a63" transform="rotate(-35,9,-56)" />
      <rect x="12" y="-58" width="8" height="13" rx="2" fill="#23272e" />
      <rect x="13.5" y="-56.5" width="5" height="9" rx="1" fill="#9fd0f0" />
      <circle cx="0" cy="-70" r="10" fill="#c68a63" />
      <path d="M-10,-70 a10,10 0 0 1 20,-2 q-6,-6 -14,-2 q-4,2 -6,8 z" fill="#2d2a32" />
      <circle cx="-9" cy="-76" r="5" fill="#2d2a32" />
      {busy && (
        <g transform={`scale(${facing},1)`}>
          <rect x="-52" y="-122" width="104" height="28" rx="14" fill="#ffffff" stroke="#9aa9bb" strokeWidth="1.5" />
          <text x="0" y="-102" textAnchor="middle" fontSize="15" fill={DIM}>Connecting</text>
        </g>
      )}
    </g>
  );
}

function Envelope({ x, y, tunnel }) {
  if (!tunnel) {
    return (
      <g transform={`translate(${x - 11},${y - 8})`}>
        <rect width="22" height="15" rx="2" fill="#ffffff" stroke="#3d4a5a" strokeWidth="1.6" />
        <polyline points="1,1 11,8 21,1" fill="none" stroke="#3d4a5a" strokeWidth="1.6" strokeLinejoin="round" />
      </g>
    );
  }
  return (
    <g transform={`translate(${x - 17},${y - 12})`}>
      <rect width="34" height="24" rx="2" fill="#f1dcae" stroke="#9a6d22" strokeWidth="1.8" />
      <rect x="9" y="5" width="16" height="11" rx="1.5" fill="#ffffff" stroke="#3d4a5a" strokeWidth="1.3" />
      <polyline points="10,6 17,11 24,6" fill="none" stroke="#3d4a5a" strokeWidth="1.3" />
      <polyline points="1,1 17,13 33,1" fill="none" stroke="#9a6d22" strokeWidth="1.6" strokeLinejoin="round" opacity="0.6" />
    </g>
  );
}

/** Plain legend icons for the card header. */
export function LegendEnvelope({ tunnel }) {
  return (
    <svg width={tunnel ? 36 : 26} height="26" viewBox={tunnel ? '-1 -1 36 26' : '-2 -5 26 26'} aria-hidden="true">
      <Envelope x={tunnel ? 17 : 11} y={tunnel ? 12 : 8} tunnel={tunnel} />
    </svg>
  );
}

function along(segs, d) {
  for (const s of segs) {
    if (d <= s.len) {
      const f = s.len ? d / s.len : 1;
      return { x: s.a[0] + (s.b[0] - s.a[0]) * f, y: s.a[1] + (s.b[1] - s.a[1]) * f, tunnel: s.tunnel };
    }
    d -= s.len;
  }
  const last = segs[segs.length - 1];
  return { x: last.b[0], y: last.b[1], tunnel: last.tunnel, done: true };
}

function route(points) {
  // points: [[x,y], ...] with a tunnel flag on each leg: [[p, tunnel], ...]
  const segs = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1][0];
    const b = points[i][0];
    segs.push({ a, b, tunnel: points[i][1], len: Math.hypot(b[0] - a[0], b[1] - a[1]) });
  }
  return segs;
}

export default function StoryScene() {
  const states = useStore((s) => s.states);
  const walkCue = useStore((s) => s.walkCue);
  const mnLink = states.ROUTER?.attach?.MN || states.MN?.link || 'home';
  const mnState = states.MN?.state;
  const [, setTick] = useState(0);
  const [hover, setHover] = useState(null);
  const pr = useRef({ x: SPOT[mnLink]?.priya ?? SPOT.home.priya, place: mnLink, walk: null, facing: 1, phase: 0 });
  const env = useRef([]);
  const live = useRef({});
  live.current = { mnLink, states };
  const seen = useRef({ data: null, reply: null, tick: 0 });
  const raf = useRef(0);

  const kick = () => {
    if (raf.current) return;
    const loop = () => {
      const now = performance.now();
      const p = pr.current;
      if (p.walk) {
        const t = Math.min(1, (now - p.walk.start) / WALK_MS);
        p.x = p.walk.from + (p.walk.to - p.walk.from) * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
        p.phase = t * 14;
        if (t >= 1) {
          const w = p.walk;
          p.walk = null;
          p.place = w.link;
          p.phase = 0;
          if (w.issue && live.current.mnLink !== w.link) command('MN', 'handoff', { link: w.link });
        }
      }
      env.current = env.current.filter((e) => now - e.start < e.dur + (e.drop ? 700 : 0));
      setTick((x) => (x + 1) % 1e6);
      raf.current = p.walk || env.current.length ? requestAnimationFrame(loop) : 0;
    };
    raf.current = requestAnimationFrame(loop);
  };

  const walkTo = (link, issue) => {
    const p = pr.current;
    const target = SPOT[link]?.priya;
    if (target === undefined) return;
    if (!p.walk && p.place === link) {
      if (issue && live.current.mnLink !== link) command('MN', 'handoff', { link });
      return;
    }
    p.facing = target < p.x ? -1 : 1;
    p.walk = { from: p.x, to: target, start: performance.now(), link, issue };
    kick();
  };

  // Walk to... buttons and clicks on a place
  useEffect(() => onWalkRequest((link) => walkTo(link, true)), []);
  // the tour announces a walk before it sends the handoff
  useEffect(() => { if (walkCue) walkTo(walkCue.to, false); }, [walkCue?.no]);
  // a handoff from anywhere else (Expert mode, a scenario) moves Priya too
  useEffect(() => {
    const p = pr.current;
    if (!p.walk && p.place !== mnLink) walkTo(mnLink, false);
    else if (p.walk && p.walk.link !== mnLink && !p.walk.issue) walkTo(mnLink, false);
  }, [mnLink]);

  // what the real stream is doing, sampled once a second for the envelopes
  useEffect(() => {
    const offData = onData((list) => { seen.current.data = list[list.length - 1]; });
    const offPkt = onPacket((list) => {
      for (const ev of list) {
        if (ev.frm === 'MN' && ev.ptype === 'data' && /reply/i.test(ev.info || '')) seen.current.reply = ev;
        if (ev.frm === 'MN' && ev.verdict === 'dropped') seen.current.reply = ev;
      }
    });
    const timer = setInterval(() => {
      const sn = seen.current;
      sn.tick += 1;
      const { states: st, mnLink: link } = live.current;
      const at = SPOT[link] || SPOT.home;
      const phone = [pr.current.x + 16 * pr.current.facing, GROUND - 46];
      const home = SPOT.home.ap;
      let pts = null;
      let drop = false;
      if (sn.tick % 4 === 0 && sn.reply) {
        const r = sn.reply;
        drop = r.verdict === 'dropped';
        const reverse = (st.HA?.bindings || []).some((b) => b.reverse);
        if (drop) {
          const mid = [(at.ap[0] + HUB[0]) / 2, (at.ap[1] + HUB[1]) / 2];
          pts = [[phone], [at.ap, false], [mid, false]];
        } else if (link !== 'home' && reverse) {
          pts = [[phone], [at.ap, false], [HUB, true], [home, true], [HUB, false], [SERVER, false]];
        } else {
          // replies take the short way: straight from wherever Priya is to the server
          pts = [[phone], [link === 'home' ? home : at.ap, false], [HUB, false], [SERVER, false]];
        }
        sn.reply = null;
      } else if (sn.data) {
        const d = sn.data;
        if (d.at_home || link === 'home') pts = [[SERVER], [HUB, false], [home, false], [phone, false]];
        else if (d.route_tag === 1) pts = [[SERVER], [HUB, true], [at.ap, true], [phone, false]];
        else pts = [[SERVER], [HUB, false], [home, false], [HUB, true], [at.ap, true], [phone, false]];
        sn.data = null;
      }
      if (!pts) return;
      const segs = route(pts);
      const total = segs.reduce((n, s) => n + s.len, 0);
      env.current.push({ segs, total, start: performance.now(), dur: (total / SPEED) * 1000, drop, key: performance.now() });
      kick();
    }, 1000);
    return () => { offData(); offPkt(); clearInterval(timer); cancelAnimationFrame(raf.current); raf.current = 0; };
  }, []);

  const p = pr.current;
  const now = performance.now();
  const busy = !p.walk && (mnState === 'DISCOVERING' || mnState === 'REGISTERING' || mnState === 'DEREGISTERING');

  return (
    <svg viewBox={`0 34 ${VW} ${VH - 40}`} preserveAspectRatio="xMidYMid meet" className="story-scene w-full h-full select-none" overflow="visible"
      role="img" aria-label="Priya's day: home, campus, metro and airport, with the Internet and the video server">
      {/* sky and ground run past the drawing so a letterboxed panel still looks whole */}
      <rect x="-3000" y="-3000" width="7000" height={GROUND + 3000} fill={SKY} />
      <rect x="-3000" y={GROUND} width="7000" height="3000" fill="#e4ecd9" />
      <line x1="-3000" y1={GROUND} x2="4000" y2={GROUND} stroke="#c9d8b8" strokeWidth="2" />

      {/* network links: dashed, the one Priya uses is solid */}
      <line x1={SERVER[0]} y1={SERVER[1]} x2={CLOUD[0]} y2={CLOUD[1]} stroke="#9aa9bb" strokeWidth="2.5" />
      {PLACE_ORDER.map((k) => {
        const on = k === mnLink || k === 'home';
        return <line key={k} x1={CLOUD[0]} y1={CLOUD[1]} x2={SPOT[k].ap[0]} y2={SPOT[k].ap[1]}
          stroke={on ? '#7d93ad' : '#c3cfdc'} strokeWidth={on ? 2.5 : 2} strokeDasharray={on ? undefined : '6 6'} />;
      })}

      <Cloud />
      <text x={CLOUD[0]} y={CLOUD[1] + 6} textAnchor="middle" fontSize="22" fontWeight="600" fill={INK}>Internet</text>
      <Server />
      <text x={SERVER[0]} y={SERVER[1] + 66} textAnchor="middle" fontSize="20" fontWeight="600" fill={INK}>Video server</text>

      {/* home agent callout */}
      <g>
        <rect x="8" y="98" width="268" height="58" rx="8" fill="#ffffff" stroke="#9aa9bb" strokeWidth="1.5" />
        <polygon points="214,154 232,154 226,170" fill="#ffffff" stroke="#9aa9bb" strokeWidth="1.5" strokeLinejoin="round" />
        <rect x="213" y="151" width="20" height="5" fill="#ffffff" />
        <line x1="226" y1="172" x2="232" y2="282" stroke="#9aa9bb" strokeWidth="1.5" strokeDasharray="3 4" />
        <text x="142" y="122" textAnchor="middle" fontSize="16.5" fill={INK}><tspan fontWeight="600">Home Agent:</tspan> forwards your mail</text>
        <text x="142" y="145" textAnchor="middle" fontSize="16.5" fill={INK}>when you're away</text>
      </g>

      {/* places */}
      {PLACE_ORDER.map((k) => {
        const sp = SPOT[k];
        const here = k === mnLink;
        return (
          <g key={k} style={{ cursor: 'pointer' }} onClick={() => walkTo(k, true)}
            onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
            <rect x={sp.x - 118} y="176" width="236" height="210" rx="10"
              fill={hover === k ? ACC : 'transparent'} fillOpacity={hover === k ? 0.06 : 0}
              stroke={hover === k ? ACC : 'none'} strokeDasharray="6 5" strokeWidth="1.5" />
            {k === 'home' && <House />}
            {k === 'fa1' && <Campus />}
            {k === 'fa2' && <Train />}
            {k === 'fa3' && <Airport />}
            <Signal at={sp.ap} on={here} />
            <text x={sp.x} y="366" textAnchor="middle" fontSize="22" fontWeight="600" fill={here ? ACC : INK}>{PLACES[k].name}</text>
            <title>{`Walk Priya to ${PLACES[k].name}`}</title>
          </g>
        );
      })}

      {/* envelopes */}
      {env.current.map((e) => {
        const t = Math.min(1, (now - e.start) / e.dur);
        const q = along(e.segs, t * e.total);
        if (e.drop && q.done) {
          const fade = 1 - Math.min(1, (now - e.start - e.dur) / 700);
          return (
            <g key={e.key} opacity={fade} stroke="#b42318" strokeWidth="4" strokeLinecap="round">
              <line x1={q.x - 9} y1={q.y - 9} x2={q.x + 9} y2={q.y + 9} /><line x1={q.x - 9} y1={q.y + 9} x2={q.x + 9} y2={q.y - 9} />
            </g>
          );
        }
        return <Envelope key={e.key} x={q.x} y={q.y} tunnel={q.tunnel} />;
      })}

      <Priya x={p.x} phase={p.phase} facing={p.facing} busy={busy} />
    </svg>
  );
}
