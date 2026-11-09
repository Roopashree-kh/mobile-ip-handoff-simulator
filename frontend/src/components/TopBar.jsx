// Top bar: a plain white toolbar. Title, transport controls, speed, elapsed time, scenario,
// Learn mode, Analytics, and the connection status at the far right.
import React, { useEffect, useState } from 'react';
import { setLearn, setState, useStore } from '../lib/store.js';
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
    <span className="font-mono text-sm text-noc-ink tabular-nums w-14 text-center" data-tip="Elapsed since Reset" aria-label="Elapsed since Reset">
      {h ? `${h}:` : ''}{mm}:{ss}
    </span>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6" fill="#2457a6" />
      <path d="M6 15.5a8 8 0 0 1 12 0" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.6 12.6a4.4 4.4 0 0 1 6.8 0" fill="none" stroke="#c9d8f0" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.6" fill="#ffffff" />
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
  const mode = useStore((s) => s.mode);
  const sep = <div className="h-6 w-px bg-noc-line" />;
  const modeToggle = (
    <div className="seg shrink-0" role="group" aria-label="Screen">
      {[['story', 'Story'], ['expert', 'Expert']].map(([k, label]) => (
        <button key={k} className="!font-sans !text-sm !px-3" aria-pressed={mode === k} onClick={() => setState({ mode: k })}>
          {label}<span className={mode === 'expert' ? 'hidden 2xl:inline' : ''}> mode</span></button>
      ))}
    </div>
  );
  const status = (
    <span className="ml-auto flex items-center gap-1.5 text-sm text-noc-ink whitespace-nowrap" data-tip={connected ? 'Gateway WebSocket open' : 'Reconnecting to the gateway'}>
      <span className={`w-2 h-2 rounded-full ${connected ? 'bg-[#2f9e44]' : 'bg-bad'}`} />
      {connected ? 'Connected' : 'Offline'}
    </span>
  );
  const title = (
    <div className="flex items-center gap-2.5 min-w-0 shrink-0">
      <Logo />
      <h1 className="text-base font-semibold text-noc-head1 whitespace-nowrap">Mobile IPv4 Handoff<span className="hidden 2xl:inline"> Simulator</span></h1>
      <span className={`badge border-noc-line bg-noc-raised text-noc-dim font-mono ${mode === 'expert' ? 'hidden 2xl:inline-flex' : ''}`}>RFC 3344</span>
    </div>
  );

  if (mode !== 'expert') {
    return (
      <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-noc-line bg-white">
        {title}
        {sep}
        {modeToggle}
        {status}
      </header>
    );
  }

  return (
    <header className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-noc-line bg-white">
      {title}
      {sep}
      {modeToggle}
      {sep}
      <div className="flex items-center gap-1">
        {paused
          ? <button className="icon-btn btn-active" onClick={play} data-tip="Play: release buffered events" aria-label="Play"><Icon name="play" /></button>
          : <button className="icon-btn" onClick={pause} data-tip="Pause: freeze the packet view" aria-label="Pause"><Icon name="pause" /></button>}
        <button className="icon-btn" onClick={step} disabled={!paused || !buffered} data-tip="Step: release one event" aria-label="Step"><Icon name="step" /></button>
        <button className="icon-btn" onClick={() => send({ type: 'reset' })} data-tip="Reset every agent and clear captures" aria-label="Reset"><Icon name="reset" /></button>
      </div>
      {paused && <span className="badge border-warn-line bg-warn-soft text-warn font-mono">{buffered} held</span>}
      {sep}
      <div className="flex items-center gap-2" data-tip="Slow-motion factor applied to every link delay">
        <span className="hidden 2xl:inline text-sm text-noc-dim">Speed</span>
        <div className="seg" role="group" aria-label="Speed">
          {SPEEDS.map((v) => (
            <button key={v} aria-pressed={scale === v} onClick={() => setFeature({ time_scale: v })}>{v}x</button>
          ))}
        </div>
      </div>
      {sep}
      <Elapsed />
      {sep}
      <div className="flex items-center gap-2 min-w-0">
        <select className="sel w-40 2xl:w-48" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Scenario">
          <option value="">Choose a scenario</option>
          {scenarios.map((s) => <option key={s.id} value={s.id} title={s.description}>{s.title}</option>)}
        </select>
        {scenario
          ? <button className="btn" onClick={() => send({ type: 'scenario_stop' })}><Icon name="stop" size={14} />Stop</button>
          : <button className="btn btn-primary" disabled={!pick} onClick={() => send({ type: 'scenario', id: pick })}><Icon name="play" size={14} />Run</button>}
      </div>
      {sep}
      <div data-tip="Explain each protocol step with its RFC section">
        <Switch small checked={learn} onChange={setLearn} label={<span className="whitespace-nowrap">Learn mode</span>} />
      </div>
      <button className="btn" onClick={() => setState({ analyticsOpen: true })}><Icon name="chart" size={14} />Analytics</button>
      {status}
    </header>
  );
}
