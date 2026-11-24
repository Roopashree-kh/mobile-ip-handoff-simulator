// Story mode, Metro ride: the route drawn as a track from Home to the Airport with a tunnel
// in the middle. The train is the moving marker. Above it, signal bars and the name of the
// network it is on. Inside the tunnel the bars are empty and it says so. Positions, the
// tunnel and the signal come from the core router through the same config the Expert chart uses.
import React from 'react';
import { useStore } from '../../lib/store.js';
import { Airport, Campus, House } from './StoryScene.jsx';

const SKY = '#eaf3fb';
const INK = '#1f2933';
const ACC = '#2457a6';
const GROUND = 330;
const X0 = 70;
const SPAN = 860;

function bars(sig, cfg) {
  if (sig === null || sig === undefined) return 0;
  const [b5, b4, b3, b2] = cfg.bars_dbm;
  if (sig >= b5) return 5;
  if (sig >= b4) return 4;
  if (sig >= b3) return 3;
  if (sig >= b2) return 2;
  return sig >= cfg.usable_dbm ? 1 : 0;
}

function Bars({ n, x, y }) {
  return (
    <g transform={`translate(${x},${y})`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <rect key={i} x={i * 9} y={20 - (i + 1) * 4.4} width="6.5" height={(i + 1) * 4.4} rx="1.5" fill={i < n ? ACC : '#d3dbe5'} />
      ))}
    </g>
  );
}

function Station({ x }) {
  return (
    <g transform={`translate(${x},${GROUND})`}>
      <rect x="-30" y="-7" width="60" height="7" fill="#b9c3cf" />
      <line x1="-22" y1="-7" x2="-22" y2="-46" stroke="#5f6b7a" strokeWidth="3" />
      <line x1="22" y1="-7" x2="22" y2="-46" stroke="#5f6b7a" strokeWidth="3" />
      <rect x="-28" y="-52" width="56" height="8" rx="3" fill="#5f6b7a" />
      <line x1="0" y1="-52" x2="0" y2="-62" stroke="#5f6b7a" strokeWidth="3" />
      <circle cx="0" cy="-72" r="11" fill={ACC} />
      <text x="0" y="-67" textAnchor="middle" fontSize="14" fontWeight="700" fill="#ffffff">M</text>
    </g>
  );
}

function Tower({ x, on }) {
  const c = on ? ACC : '#9aa9bb';
  return (
    <g>
      <line x1={x} y1={GROUND} x2={x} y2={GROUND - 66} stroke={c} strokeWidth="3" strokeLinecap="round" />
      <path d={`M${x - 9},${GROUND - 78} a13,13 0 0 1 18,0`} fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" />
      <path d={`M${x - 16},${GROUND - 86} a24,24 0 0 1 32,0`} fill="none" stroke={c} strokeWidth="2.5" strokeLinecap="round" opacity={on ? 1 : 0.6} />
    </g>
  );
}

export default function MetroScene() {
  const cfg = useStore((s) => s.config?.coverage);
  const last = useStore((s) => s.cover[s.cover.length - 1]);
  const mnLink = useStore((s) => s.states.MN?.link);
  if (!cfg) return null;
  const L = cfg.route.length_m;
  const X = (m) => X0 + (m / L) * SPAN;
  const pos = last?.pos ?? 0;
  const link = last?.link || mnLink || 'home';
  const sig = last ? last.sig[link] : null;
  const dead = !!last?.dead;
  const n = dead ? 0 : bars(sig, cfg);
  const tunnel = cfg.dead_zones[0];
  const inTunnel = pos >= tunnel.from_m && pos <= tunnel.to_m;
  const name = dead ? 'No signal' : (cfg.networks[link]?.label || '');
  const both = last?.extra?.length ? last.extra : [];
  const tx = X(pos);
  const bw = Math.max(172, 76 + name.length * 10.5);   // the bubble grows with the network name
  const cells = [];
  for (const [k, net] of Object.entries(cfg.networks)) for (const c of net.cells) cells.push([k, c]);
  const active = new Set([link, ...both]);
  const place = (w, i) => {
    const x = X(w.at_m);
    if (w.name === 'Home') return <g key={i} transform={`translate(${x},${GROUND}) scale(0.5) translate(-143,-${GROUND})`}><House /></g>;
    if (w.name === 'Campus') return <g key={i} transform={`translate(${x + 8},${GROUND}) scale(0.5) translate(-370,-${GROUND})`}><Campus /></g>;
    if (w.name === 'Airport') return <g key={i} transform={`translate(${x},${GROUND}) scale(0.5) translate(-872,-${GROUND})`}><Airport /></g>;
    return <Station key={i} x={x} />;
  };
  return (
    <svg viewBox="0 20 1000 380" preserveAspectRatio="xMidYMid meet" className="story-scene w-full h-full select-none" overflow="visible"
      role="img" aria-label="The metro route from Home to the Airport with a tunnel. The marker is the train.">
      <rect x="-3000" y="-3000" width="7000" height={GROUND + 3000} fill={SKY} />
      <rect x="-3000" y={GROUND} width="7000" height="3000" fill="#e4ecd9" />
      <line x1="-3000" y1={GROUND} x2="4000" y2={GROUND} stroke="#c9d8b8" strokeWidth="2" />

      {/* track, drawn as covered up to the train */}
      <line x1={X(0)} y1={GROUND - 2} x2={X(L)} y2={GROUND - 2} stroke="#7b8794" strokeWidth="4" />
      <line x1={X(0)} y1={GROUND - 2} x2={tx} y2={GROUND - 2} stroke={ACC} strokeWidth="4" />

      {cfg.route.waypoints.filter((w) => w.link).map(place)}
      {cells.map(([k, c], i) => <Tower key={i} x={X(c) + 40} on={active.has(k)} />)}

      {/* the tunnel: a hill over the track with a dark mouth at each end */}
      <g>
        <path d={`M${X(tunnel.from_m) - 26},${GROUND} Q${X(tunnel.from_m) - 6},${GROUND - 118} ${X(tunnel.from_m) + 60},${GROUND - 124}
          L${X(tunnel.to_m) - 60},${GROUND - 124} Q${X(tunnel.to_m) + 6},${GROUND - 118} ${X(tunnel.to_m) + 26},${GROUND} Z`}
          fill="#8d9a8c" stroke="#6d7a6c" strokeWidth="2" strokeLinejoin="round" />
        <rect x={X(tunnel.from_m) - 14} y={GROUND - 44} width="30" height="44" rx="14" fill="#2b323b" />
        <rect x={X(tunnel.to_m) - 16} y={GROUND - 44} width="30" height="44" rx="14" fill="#2b323b" />
        <text x={(X(tunnel.from_m) + X(tunnel.to_m)) / 2} y={GROUND - 70} textAnchor="middle" fontSize="22" fontWeight="600" fill="#ffffff">Tunnel</text>
        <text x={(X(tunnel.from_m) + X(tunnel.to_m)) / 2} y={GROUND - 44} textAnchor="middle" fontSize="16" fill="#eef1f5">about 20 seconds</text>
      </g>

      {cfg.route.waypoints.filter((w) => w.link).map((w) => (
        <text key={w.name} x={X(w.at_m)} y="366" textAnchor="middle" fontSize="21" fontWeight="600" fill={INK}>{w.name}</text>
      ))}

      {/* the train */}
      <g transform={`translate(${tx},${GROUND - 4})`} opacity={inTunnel ? 0.55 : 1}>
        <rect x="-34" y="-30" width="68" height="28" rx="9" fill="#3f8f80" stroke="#2c6b5f" strokeWidth="2" />
        <rect x="-34" y="-12" width="68" height="4" fill="#f2c94c" />
        {[-24, -8, 8].map((x) => <rect key={x} x={x} y="-25" width="12" height="10" rx="2" fill="#d8eef3" />)}
        <circle cx="-18" cy="-1" r="5" fill="#3d4a5a" /><circle cx="18" cy="-1" r="5" fill="#3d4a5a" />
      </g>

      {/* signal bars and the network name over the train */}
      <g transform={`translate(${Math.max(bw / 2 + 6, Math.min(1000 - bw / 2 - 6, tx))},${GROUND - 176})`}>
        <rect x={-bw / 2} y="-30" width={bw} height={both.length ? 68 : 54} rx="10" fill="#ffffff" stroke={dead ? '#b42318' : '#9aa9bb'} strokeWidth="2" />
        <Bars n={n} x={-bw / 2 + 10} y={-22} />
        <text x={-bw / 2 + 66} y="-6" fontSize="17" fontWeight="600" fill={dead ? '#b42318' : INK}>{name}</text>
        {both.length > 0 && <text x={-bw / 2 + 10} y="30" fontSize="15" fill={ACC}>On two networks at once</text>}
        <line x1="0" y1={both.length ? 38 : 24} x2="0" y2={both.length ? 52 : 38} stroke="#9aa9bb" strokeWidth="2" />
      </g>
    </svg>
  );
}
