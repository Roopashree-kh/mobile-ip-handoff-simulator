// Top bar: connection, simulation clock, Play/Pause/Step/Reset, speed, scenario picker,
// Learn mode and the Analytics drawer toggle.
import React, { useEffect, useState } from 'react';
import { setState, useStore } from '../lib/store.js';
import { pause, play, send, setFeature, step } from '../lib/ws.js';
import { clock } from '../lib/util.js';

function SimClock() {
  const startedAt = useStore((s) => s.startedAt);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span className="mono text-sky-300 tabular-nums">{clock(now - startedAt)}</span>;
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
    <header className="flex items-center gap-3 px-3 h-12 border-b border-noc-line bg-[#0d1420] shrink-0">
      <div className="font-semibold tracking-wide text-slate-100 whitespace-nowrap">
        Mobile IPv4 <span className="text-sky-400">Handoff Console</span>
        <span className="ml-2 text-[11px] text-slate-500 font-normal">RFC 3344 foreign agent simulator</span>
      </div>
      <span className={`flex items-center gap-1.5 text-xs ${connected ? 'text-emerald-400' : 'text-red-400'}`}>
        <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500 animate-pulse'}`} />
        {connected ? 'gateway connected' : 'gateway offline'}
      </span>
      <span className="text-xs text-slate-400">sim time <SimClock /></span>

      <div className="flex items-center gap-1">
        {paused
          ? <button className="btn btn-on" onClick={play} title="Resume and release buffered events">Play</button>
          : <button className="btn" onClick={pause} title="Freeze the packet view and buffer incoming events">Pause</button>}
        <button className="btn" onClick={step} disabled={!paused || !buffered} title="Release one buffered event">Step</button>
        <button className="btn btn-warn" onClick={() => send({ type: 'reset' })} title="Reset every agent and clear captures">Reset</button>
        {paused && <span className="text-[11px] text-amber-300 ml-1">{buffered} buffered</span>}
      </div>

      <label className="flex items-center gap-2 text-xs text-slate-400" title="Multiplies every link delay so packets can be followed by eye">
        speed
        <input type="range" min="1" max="20" step="1" value={scale}
          onChange={(e) => setFeature({ time_scale: Number(e.target.value) })} className="w-24 accent-sky-500" />
        <span className="mono w-14 text-slate-300">{scale === 1 ? 'real' : `${scale}x slow`}</span>
      </label>

      <div className="flex items-center gap-1.5 ml-auto">
        <select className="sel max-w-[13rem]" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Scenario...</option>
          {scenarios.map((s) => <option key={s.id} value={s.id} title={s.description}>{s.title}</option>)}
        </select>
        <button className="btn btn-on" disabled={!pick} onClick={() => send({ type: 'scenario', id: pick })}>Run</button>
        <button className="btn" disabled={!scenario} onClick={() => send({ type: 'scenario_stop' })}>Stop</button>
        {scenario && (
          <span className="text-[11px] text-sky-300 max-w-[22rem] truncate" title={scenario.note}>
            {scenario.total ? `step ${scenario.step || 0}/${scenario.total}: ` : ''}{scenario.note}
          </span>
        )}
      </div>
      <button className={`btn ${learn ? 'btn-on' : ''}`} onClick={() => setState({ learn: !learn, toasts: [] })}
        title="Explain each protocol step with its RFC section">Learn {learn ? 'on' : 'off'}</button>
      <button className="btn" onClick={() => setState({ analyticsOpen: true })}>Analytics</button>
    </header>
  );
}
