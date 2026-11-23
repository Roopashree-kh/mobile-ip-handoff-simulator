// Story mode phone: three apps, each with a small status light, so the audience sees what a
// loss of signal does to each kind of traffic. The video app plays a picture that freezes
// exactly when the real video flow stops. The call app shows a sound meter that goes flat
// when the real voice flow stops. The chat app shows whether the last message has arrived.
// All of it is driven by the mobile node's own QoS reports, four times a second. Beyond the
// two small video labels there are no numbers, no tables and no addresses.
import React, { useEffect, useRef, useState } from 'react';
import { useStore } from '../../lib/store.js';
import { PLACES } from '../../lib/story.js';
import { useNow } from '../ui.jsx';
import QualityBadge from './QualityBadge.jsx';

const FRAME_MS = 40;

const LIGHT = {
  good: { dot: 'bg-[#2f9e44]', text: 'text-good' },
  fair: { dot: 'bg-[#c98500]', text: 'text-warn' },
  poor: { dot: 'bg-[#d92d20]', text: 'text-bad' },
  idle: { dot: 'bg-[#9aa5b1]', text: 'text-noc-dim' },
};

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

function Status({ level, word }) {
  const l = LIGHT[level] || LIGHT.idle;
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-3 h-3 rounded-full shrink-0 ${l.dot}`} />
      <span className={`text-[15px] leading-5 font-semibold ${l.text}`}>{word}</span>
    </span>
  );
}

function Tile({ title, icon, children, level, word }) {
  return (
    <div className="rounded-[10px] bg-[#2f343c] px-2.5 py-2 min-w-0 flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[14px] font-semibold text-white">{icon}<span>{title}</span></div>
      <div className="h-7 flex items-center">{children}</div>
      <div className="rounded-[6px] bg-white px-2 py-0.5"><Status level={level} word={word} /></div>
    </div>
  );
}

const Mic = () => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <rect x="7" y="2.5" width="6" height="9" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0" /><path d="M10 15v3" />
  </svg>
);
const Bubble = () => (
  <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4.5h14v9H9l-4 3v-3H3z" />
  </svg>
);

function Meter({ live, level, t }) {
  const heights = [0.5, 0.9, 0.6, 1, 0.7, 0.85, 0.45, 0.8, 0.55];
  const c = level === 'poor' ? '#f08a82' : level === 'fair' ? '#f0c24d' : '#7fd18f';
  return (
    <svg viewBox="0 0 90 24" className="w-full h-6" aria-hidden="true">
      {heights.map((h, i) => {
        const k = live ? 0.35 + 0.65 * Math.abs(Math.sin(t / 170 + i * 1.3)) * h : 0.06;
        return <rect key={i} x={i * 10 + 2} y={12 - 11 * k} width="6" height={22 * k} rx="3" fill={live ? c : '#6b7480'} />;
      })}
    </svg>
  );
}

export default function StoryPhone() {
  const mn = useStore((s) => s.states.MN);
  const pt = useStore((s) => s.qos[s.qos.length - 1]);
  const chatSent = useStore((s) => s.states.CN?.flows?.text);
  const th = useStore((s) => s.config?.qos_targets?.story) || { video_stall_ms: 300, call_silent_ms: 400, fresh_ms: 1500 };
  const link = useStore((s) => s.states.ROUTER?.attach?.MN || s.states.MN?.link || 'home');
  const resetAt = useStore((s) => s.resetAt);
  const now = useNow(80);
  const play = useRef({ frame: 0, last: 0 });
  const [, bump] = useState(0);

  useEffect(() => { play.current = { frame: 0, last: 0 }; bump((x) => x + 1); }, [resetAt]);

  const fresh = pt && Date.now() - pt.t < th.fresh_ms;
  const v = fresh ? pt.video : null;
  const a = fresh ? pt.voice : null;
  const stalledVideo = !!v && (v.frozen || v.stall >= th.video_stall_ms);
  const idleVideo = !v || (v.level === 'idle' && v.delay === null);
  const p = play.current;
  if (!p.last) p.last = now;
  if (!stalledVideo && !idleVideo) p.frame += (now - p.last) / FRAME_MS;
  p.last = now;

  // call: silent when nothing arrives, otherwise it follows the verdict
  const callSilent = !a || a.stall >= th.call_silent_ms;
  const callLevel = !a || a.level === 'idle' ? 'idle' : a.level;
  const callWord = !a || a.level === 'idle' ? 'Ringing' : callSilent ? 'Silent' : callLevel === 'good' ? 'Clear' : callLevel === 'fair' ? 'Choppy' : 'Cutting out';
  const vLevel = idleVideo ? 'idle' : stalledVideo ? 'poor' : v.level;
  const vWord = idleVideo ? 'Starting' : stalledVideo ? 'Frozen' : vLevel === 'good' ? 'Playing' : vLevel === 'fair' ? 'Stuttering' : 'Breaking up';
  // chat: the sender knows whether a message is still waiting for its acknowledgement
  const waiting = (chatSent?.pending || 0) > 0 || (pt?.text?.waiting || 0) > 0;
  const chatLevel = !pt || pt.text.delivered === 0 ? 'idle' : waiting ? 'fair' : 'good';
  const chatWord = chatLevel === 'idle' ? 'Quiet' : waiting ? 'Sending again' : 'Delivered';

  const pl = PLACES[link] || PLACES.home;
  const state = mn?.state;
  const via = state === 'AT_HOME' ? 'Home Wi-Fi, directly'
    : state === 'REGISTERED_AWAY' ? pl.name
      : state === 'DEREGISTERING' ? 'switching back to Home'
        : `switching to ${pl.name}`;

  return (
    <div className="flex flex-col gap-3">
      <QualityBadge />
      <div className="mx-auto w-full max-w-[560px] rounded-[26px] bg-[#23272e] p-[12px] pl-[26px] relative shadow-[0_2px_6px_rgba(0,0,0,0.18)]">
        <span className="absolute left-[9px] top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-[#3d434d]" />
        <div className="relative rounded-[12px] overflow-hidden aspect-video bg-black">
          <Video frame={Math.floor(p.frame)} stalled={stalledVideo} idle={idleVideo} />
          <div className="absolute top-2 left-2 right-2 flex justify-between gap-2 text-[13px] font-semibold">
            <span className="px-2 py-0.5 rounded bg-white/90 text-noc-ink">Delay {v && v.delay !== null ? Math.round(v.delay) : '-'} ms</span>
            <span className={`px-2 py-0.5 rounded bg-white/90 ${v?.frames_lost ? 'text-[#b42318]' : 'text-noc-ink'}`}>Frames lost: {v?.frames_lost ?? 0}</span>
          </div>
          <div className="absolute left-2 bottom-2">
            <span className="px-2 py-0.5 rounded bg-white/90 inline-block"><Status level={vLevel} word={`Video: ${vWord}`} /></span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <Tile title="Call" icon={<Mic />} level={callLevel} word={callWord}><Meter live={!callSilent && callLevel !== 'idle'} level={callLevel} t={now} /></Tile>
          <Tile title="Chat" icon={<Bubble />} level={chatLevel} word={chatWord}>
            <div className="flex gap-1.5 items-center w-full">
              <span className={`h-5 rounded-full px-2 text-[12px] leading-5 ${waiting ? 'bg-[#f0c24d] text-[#3a2a00]' : 'bg-[#7fd18f] text-[#0e3a1a]'}`}>{waiting ? 'Sending' : 'Got it'}</span>
              <span className="h-2 flex-1 rounded-full bg-[#4a525d]" />
            </div>
          </Tile>
        </div>
      </div>
      <div className="grid text-[15px] leading-[21px]">
        <p><span className="text-noc-dim">My address:</span> <b className="text-noc-head1">always the same</b> <span className="text-noc-dim">(my home address)</span></p>
        <p><span className="text-noc-dim">Right now reachable via:</span> <b className={state === 'REGISTERED_AWAY' || state === 'AT_HOME' ? 'text-acc' : 'text-warn'}>{via}</b></p>
      </div>
    </div>
  );
}
