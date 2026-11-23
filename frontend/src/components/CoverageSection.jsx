// Coverage part of the Quality drawer: where the train is on the route, the signal of each
// network against time with the usable threshold, dead zones shaded and handoffs marked,
// plus the ride controls and the five rescue switches (the drawer covers the Controls panel).
import React, { useMemo } from 'react';
import { useStore } from '../lib/store.js';
import { command, send } from '../lib/ws.js';
import { SERIES } from '../lib/util.js';
import RescueSwitches from './RescueSwitches.jsx';
import { TimeChart } from './QualityDrawer.jsx';

const NET = [['home', 'Home', SERIES.s3], ['fa1', 'Campus Wi-Fi', SERIES.s1], ['fa2', 'Metro LTE', SERIES.s2], ['fa3', 'Airport', SERIES.s4]];

function RouteStrip({ cov, cfg }) {
  const L = cfg.route.length_m;
  const X = (m) => 30 + (m / L) * 940;
  const here = cov?.pos ?? 0;
  const link = cov?.link;
  const sig = cov && link ? cov.sig[link] : null;
  return (
    <svg viewBox="0 0 1000 96" className="w-full h-[96px]" role="img" aria-label="Route with the tunnel and the train position">
      <line x1={X(0)} y1="52" x2={X(L)} y2="52" stroke="#9aa9bb" strokeWidth="4" strokeLinecap="round" />
      {cfg.dead_zones.map((z) => (
        <g key={z.name}>
          <rect x={X(z.from_m)} y="40" width={X(z.to_m) - X(z.from_m)} height="24" rx="4" fill="#3d4a5a" />
          <text x={(X(z.from_m) + X(z.to_m)) / 2} y="57" textAnchor="middle" fontSize="13" fill="#ffffff">{z.name}</text>
        </g>
      ))}
      {cfg.route.waypoints.filter((w) => w.link).map((w) => (
        <g key={w.name}>
          <circle cx={X(w.at_m)} cy="52" r="6" fill="#ffffff" stroke="#2457a6" strokeWidth="2.5" />
          <text x={X(w.at_m)} y="80" textAnchor="middle" fontSize="13" fill="#1f2933">{w.name}</text>
        </g>
      ))}
      <g transform={`translate(${X(here)},0)`}>
        <polygon points="-7,20 7,20 0,34" fill="#d92d20" />
        <line x1="0" y1="34" x2="0" y2="46" stroke="#d92d20" strokeWidth="2" />
        <text x="0" y="14" textAnchor="middle" fontSize="13" fontWeight="600" fill="#1f2933">
          {Math.round(here)} m{sig !== null && sig !== undefined ? `, ${Math.round(sig)} dBm` : ''}</text>
      </g>
    </svg>
  );
}

export default function CoverageSection() {
  const cfg = useStore((s) => s.config?.coverage);
  const cover = useStore((s) => s.cover);
  const f = useStore((s) => s.features);
  const sc = useStore((s) => s.scenario);
  const last = cover[cover.length - 1];
  const { rows, t0 } = useMemo(() => {
    if (!cover.length) return { rows: [], t0: 0 };
    const t = cover[0].ts;
    return { t0: t, rows: cover.map((c) => ({ x: +((c.ts - t) / 1000).toFixed(2), ...c.sig, blackout: c.dead })) };
  }, [cover]);
  if (!cfg) return null;
  return (
    <section className="panel p-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-noc-head1">Coverage and the Metro ride</h3>
        <span className="text-xs text-noc-mute font-mono">{last ? `${last.place}, MN on ${last.link}${last.extra?.length ? ` + ${last.extra.join(', ')}` : ''}` : 'coverage is off'}</span>
        <span className="ml-auto flex items-center gap-2">
          <button className="btn" disabled={!!sc} onClick={() => send({ type: 'scenario', id: '8_metro_ride' })}>Run the ride</button>
          <button className="btn btn-primary" disabled={!!sc} onClick={() => send({ type: 'scenario', id: '9_metro_compare' })}>Compare: off then on</button>
          {sc && <button className="btn" onClick={() => send({ type: 'scenario_stop' })}>Stop</button>}
        </span>
      </div>
      <p className="text-2xs text-noc-mute mt-0.5 mb-2">Each network has a signal that depends on position. Below {cfg.usable_dbm} dBm the core router drops everything to and from the phone.
        The train moves at {cfg.speed_mps} m/s. {f.coverage ? '' : 'Coverage is off, switch it on in Controls or run the ride.'}</p>
      <RouteStrip cov={last} cfg={cfg} />
      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-4 mt-2 items-start">
        <TimeChart title="Signal against time" note="Shaded: no network usable. Dashed vertical lines: handoffs." rows={rows} t0={t0} unit=" dBm" height={230}
          domainY={[-130, -40]} ticks={[-130, -115, -100, -85, -70, -55, -40]} refs={[{ y: cfg.usable_dbm, label: `usable ${cfg.usable_dbm} dBm` }]}
          lines={NET.map(([k, name, c]) => [k, name, c])} />
        <div>
          <h4 className="text-sm font-semibold text-noc-head1 mb-2">Rescue features</h4>
          <RescueSwitches />
          <div className="flex gap-2 mt-3">
            <button className="btn" onClick={() => command('ROUTER', 'ride_start')} disabled={!f.coverage}>Ride</button>
            <button className="btn" onClick={() => command('ROUTER', 'ride_stop')}>Pause</button>
            <button className="btn" onClick={() => command('ROUTER', 'ride_reset')}>Back to start</button>
          </div>
        </div>
      </div>
    </section>
  );
}
