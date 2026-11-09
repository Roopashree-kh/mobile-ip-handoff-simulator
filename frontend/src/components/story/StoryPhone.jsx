// Story mode phone: a landscape phone playing a video. Every stream datagram the mobile node
// really receives advances the animation by one frame, so the picture freezes exactly when
// packets stop. Frames lost counts sequence numbers that never arrived (late ones that turn
// up through smooth handoff are taken back off), and ticks up live while the video stalls.
import React, { useEffect, useRef, useState } from 'react';
import { onData, useStore } from '../../lib/store.js';
import { PLACES } from '../../lib/story.js';
import { useNow } from '../ui.jsx';

const FINAL_MS = 5000; // a missing frame still absent after this long is counted for good

function Video({ frame, stalled, idle }) {
  const far = -((frame * 1.5) % 320);
  const near = -((frame * 4) % 320);
  const b = Math.abs(Math.sin(frame * 0.16));
  const hillsFar = 'M0,120 Q40,92 80,112 T160,108 T240,104 T320,120 V180 H0 Z';
  const hillsNear = 'M0,142 Q50,118 100,138 T200,134 T320,142 V180 H0 Z';
  return (
    <svg viewBox="0 0 320 180" className="block w-full h-full" aria-label={stalled ? 'Video buffering' : 'Video playing'}>
      <rect width="320" height="180" fill="#cfe8f7" />
      <circle cx="262" cy="38" r="16" fill="#f6d36b" />
      <g transform={`translate(${far},0)`} fill="#a9d18e">
        <path d={hillsFar} /><path d={hillsFar} transform="translate(320,0)" />
      </g>
      <g transform={`translate(${near},0)`}>
        <path d={hillsNear} fill="#74b05f" /><path d={hillsNear} transform="translate(320,0)" fill="#74b05f" />
        {[40, 150, 250, 360, 470, 570].map((x) => (
          <g key={x}><rect x={x - 2} y="118" width="4" height="16" fill="#7a5a3c" /><circle cx={x} cy="114" r="10" fill="#4f8f45" /></g>
        ))}
      </g>
      <ellipse cx="160" cy="156" rx={16 - b * 7} ry="3.5" fill="#000" opacity="0.18" />
      <circle cx="160" cy={142 - b * 70} r="12" fill="#e8663d" />
      {(stalled || idle) && (
        <g>
          <rect width="320" height="180" fill="#1f2933" opacity="0.45" />
          {stalled && <circle cx="160" cy="80" r="18" fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round"
            strokeDasharray="80 200" className="spin" style={{ transformOrigin: '160px 80px' }} />}
          <text x="160" y={stalled ? 128 : 96} textAnchor="middle" fill="#ffffff" fontSize="15" fontWeight="600">
            {stalled ? 'Buffering' : 'Video starting'}</text>
        </g>
      )}
    </svg>
  );
}

export default function StoryPhone() {
  const mn = useStore((s) => s.states.MN);
  const cn = useStore((s) => s.states.CN);
  const link = useStore((s) => s.states.ROUTER?.attach?.MN || s.states.MN?.link || 'home');
  const resetAt = useStore((s) => s.resetAt);
  const now = useNow(100);
  const v = useRef({ frame: 0, lastRx: 0, lastSeq: null, missing: new Map(), final: 0, lat: [] });
  const [, bump] = useState(0);

  useEffect(() => {
    v.current = { frame: 0, lastRx: 0, lastSeq: null, missing: new Map(), final: 0, lat: [] };
    bump((x) => x + 1);
  }, [resetAt]);

  useEffect(() => {
    const off = onData((list) => {
      const st = v.current;
      const t = Date.now();
      for (const ev of list) {
        const seq = ev.seq;
        if (st.missing.has(seq)) st.missing.delete(seq); // a late frame, rescued
        else if (st.lastSeq === null || seq < st.lastSeq - 50 || seq - st.lastSeq > 2000) st.lastSeq = seq; // stream restarted
        else if (seq > st.lastSeq) {
          for (let k = st.lastSeq + 1; k < seq && st.missing.size < 5000; k += 1) st.missing.set(k, t);
          st.lastSeq = seq;
        }
        st.frame += 1;
        st.lat.push(ev.latency_ms);
        if (st.lat.length > 12) st.lat.shift();
      }
      st.lastRx = t;
      bump((x) => (x + 1) % 1e6);
    });
    const timer = setInterval(() => {
      const st = v.current;
      const t = Date.now();
      for (const [k, at] of st.missing) if (t - at > FINAL_MS) { st.missing.delete(k); st.final += 1; }
    }, 1000);
    return () => { off(); clearInterval(timer); };
  }, []);

  const st = v.current;
  const rate = cn?.rate || 20;
  const streaming = !!cn?.streaming;
  const gap = now - st.lastRx;
  const stalled = streaming && st.lastRx > 0 && gap > Math.max(250, 4000 / rate);
  const live = stalled ? Math.max(0, Math.floor((gap * rate) / 1000) - 1) : 0;
  const lost = st.final + st.missing.size + live;
  const delay = st.lat.length ? Math.round(st.lat.reduce((a, b) => a + b, 0) / st.lat.length) : null;
  const p = PLACES[link] || PLACES.home;
  const state = mn?.state;
  const via = state === 'AT_HOME' ? 'Home Wi-Fi, directly'
    : state === 'REGISTERED_AWAY' ? p.name
      : state === 'DEREGISTERING' ? 'switching back to Home'
        : `switching to ${p.name}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="mx-auto w-full max-w-[560px] rounded-[30px] bg-[#23272e] p-[14px] pl-[30px] relative shadow-[0_2px_6px_rgba(0,0,0,0.18)]">
        <span className="absolute left-[11px] top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-[#3d434d]" />
        <div className="relative rounded-[14px] overflow-hidden aspect-video bg-black">
          <Video frame={st.frame} stalled={stalled} idle={!streaming || !st.lastRx} />
          <div className="absolute top-2 left-2 right-2 flex justify-between gap-2 text-[13px] font-semibold">
            <span className="px-2 py-0.5 rounded bg-white/90 text-noc-ink">Delay {delay ?? '-'} ms</span>
            <span className={`px-2 py-0.5 rounded bg-white/90 ${lost ? 'text-[#b42318]' : 'text-noc-ink'}`}>Frames lost: {lost}</span>
          </div>
          <div className="absolute left-0 right-0 bottom-0 h-1.5 bg-white/40">
            <div className="h-full bg-[#e8663d]" style={{ width: `${(st.frame % 600) / 6}%` }} />
          </div>
        </div>
      </div>
      <div className="grid gap-2 text-[18px] leading-[26px]">
        <p><span className="text-noc-dim">My address:</span> <b className="text-noc-head1">always {mn?.home || '10.1.0.50'}</b> <span className="text-noc-dim">(home address)</span></p>
        <p><span className="text-noc-dim">Right now reachable via:</span> <b className={state === 'REGISTERED_AWAY' || state === 'AT_HOME' ? 'text-acc' : 'text-warn'}>{via}</b></p>
      </div>
    </div>
  );
}
