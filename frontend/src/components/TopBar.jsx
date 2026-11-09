// Top bar, one row: title | transport controls, speed presets, elapsed time | scenario,
// Learn mode, Analytics, connection status.
import React, { useEffect, useState } from 'react';
import { setState, useStore } from '../lib/store.js';
import { pause, play, send, setFeature, step } from '../lib/ws.js';
import { Icon, Switch } from './ui.jsx';

const SPEEDS = [1, 2, 5, 10, 20];

function Elapsed() {
  const resetAt = useStore((s) => s.resetAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((now - resetAt) / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return (
    <span className="font-mono text-sm text-noc-ink tabular-nums w-14 text-center" data-tip="Elapsed since Reset">
      {h ? `${h}:` : ''}{mm}:{ss}
    </span>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#0c4a6e" />
      <path d="M6 15.5a8 8 0 0 1 12 0" fill="none" stroke="#38bdf8" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.6 12.6a4.4 4.4 0 0 1 6.8 0" fill="none" stroke="#7dd3fc" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.6" fill="#e0f2fe" />
    </svg>
  );
}

export default function TopBar() {
  const connected = useStore((s) => s.connected);
  const paused = useStore((s) => s.paused);
  const buffered = useStore((s) => s.buffered.length);
  const scenarios = useStore((s) => s.scenarios);
  const scenario = useStore((s) => s.scenario);
  const features = useStore((s) => s.features);
  const learn = useStore((s) => s.learn);
  const [pick, setPick] = useState('');
  const scale = Number(features.time_scale || 1);

  return (
    <header className="h-12 shrink-0 grid grid-cols-[auto_1fr_auto] items-center gap-3 px-4 border-b border-noc-line bg-[#0d131d]">
      <div className="flex items-center gap-2.5 min-w-0">
        <Logo />
        <h1 className="text-base font-semibold text-noc-ink whitespace-nowrap">Mobile IPv4 Handoff<span className="hidden 2xl:inline"> Simulator</span></h1>
        <span className="badge border-sky-500/40 bg-sky-500/10 text-sky-300 font-mono">RFC 3344</span>
      </div>

      <div className="flex items-center justify-center gap-3 min-w-0">
        <div className="flex items-center gap-1">
          {paused
            ? <button className="icon-btn btn-active" onClick={play} data-tip="Play: release buffered events" aria-label="Play"><Icon name="play" /></button>
            : <button className="icon-btn" onClick={pause} data-tip="Pause: freeze the packet view" aria-label="Pause"><Icon name="pause" /></button>}
          <button className="icon-btn" onClick={step} disabled={!paused || !buffered} data-tip="Step: release one event" aria-label="Step"><Icon name="step" /></button>
          <button className="icon-btn" onClick={() => send({ type: 'reset' })} data-tip="Reset every agent and clear captures" aria-label="Reset"><Icon name="reset" /></button>
        </div>
        {paused && <span className="badge border-amber-500/40 bg-amber-500/10 text-amber-300 font-mono">{buffered} held</span>}
        <div className="h-6 w-px bg-noc-line" />
        <div className="flex items-center gap-2" data-tip="Slow-motion factor applied to every link delay">
          <span className="hidden 2xl:inline text-2xs text-noc-mute">Speed</span>
          <div className="flex rounded-md border border-noc-edge overflow-hidden">
            {SPEEDS.map((v) => (
              <button key={v} onClick={() => setFeature({ time_scale: v })}
                className={`h-7 px-2 font-mono text-2xs border-r border-noc-edge last:border-r-0 transition-colors
                  ${scale === v ? 'bg-sky-500/20 text-sky-200' : 'bg-noc-raised text-noc-dim hover:text-noc-ink hover:bg-[#1c2738]'}`}>
                {v}x
              </button>
            ))}
          </div>
        </div>
        <div className="h-6 w-px bg-noc-line" />
        <Elapsed />
      </div>

      <div className="flex items-center gap-2 justify-end min-w-0">
        <select className="sel w-36 2xl:w-44" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Scenario">
          <option value="">Choose a scenario</option>
          {scenarios.map((s) => <option key={s.id} value={s.id} title={s.description}>{s.title}</option>)}
        </select>
        {scenario
          ? <button className="btn btn-warn" onClick={() => send({ type: 'scenario_stop' })}><Icon name="stop" size={14} />Stop</button>
          : <button className="btn btn-primary" disabled={!pick} onClick={() => send({ type: 'scenario', id: pick })}><Icon name="play" size={14} />Run</button>}
        <div className="h-6 w-px bg-noc-line mx-1" />
        <div data-tip="Explain each protocol step with its RFC section">
          <Switch small checked={learn} onChange={(v) => setState({ learn: v, toasts: [] })} label={<span className="whitespace-nowrap">Learn mode</span>} />
        </div>
        <button className="btn" onClick={() => setState({ analyticsOpen: true })}><Icon name="chart" size={14} />Analytics</button>
        <div className="h-6 w-px bg-noc-line mx-1" />
        <span className="flex items-center gap-1.5 text-xs text-noc-dim whitespace-nowrap" data-tip={connected ? 'Gateway WebSocket open' : 'Reconnecting to the gateway'}>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-red-500 animate-pulse'}`} />
          <span className="hidden xl:inline">{connected ? 'Connected' : 'Offline'}</span>
        </span>
      </div>
    </header>
  );
}
