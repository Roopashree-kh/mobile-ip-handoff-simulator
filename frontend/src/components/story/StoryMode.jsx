// Story mode: the beginner screen. One scene, one phone, four controls, a narrator.
// Everything reads the same store as Expert mode, so switching mid-tour shows the same
// live state and the packet inspector holds the packets drawn here as envelopes.
import React, { useEffect, useRef, useState } from 'react';
import { setState, useStore } from '../../lib/store.js';
import { command, send, setFeature } from '../../lib/ws.js';
import { PLACES, PLACE_ORDER, requestWalk, TOUR_ID } from '../../lib/story.js';
import StoryScene, { LegendEnvelope } from './StoryScene.jsx';
import StoryPhone from './StoryPhone.jsx';

const DWELL = 3200; // each narrator line stays up at least this long
const SPEEDS = [1, 2, 5, 10];

function Intro({ onClose }) {
  return (
    <section className="panel px-5 py-3 flex items-start gap-4 shrink-0" aria-label="What is this?">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-noc-head1">What is this?</h2>
        <p className="text-[15px] leading-[22px] text-noc-ink mt-0.5">
          Your phone's address normally changes when you change networks, which breaks video calls.
          Mobile IP lets the phone keep one permanent address and have a home router forward its traffic wherever it goes.
          Watch Priya move and see the video keep playing.
        </p>
      </div>
      <button className="btn shrink-0 mt-1" onClick={onClose}>Got it</button>
    </section>
  );
}

function Control({ title, hint, children }) {
  return (
    <div className="panel px-3 2xl:px-4 py-3 min-w-0 flex flex-col gap-2">
      {title && <div className="text-[14px] 2xl:text-[15px] font-semibold text-noc-head1">{title}</div>}
      {children}
      <div className="text-[13px] leading-[18px] text-noc-dim">{hint}</div>
    </div>
  );
}

function Check({ checked, onChange, label }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer text-[14px] 2xl:text-[15px] font-semibold text-noc-head1 leading-[20px]">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] w-4 h-4 shrink-0 accent-[#2457a6] cursor-pointer" />
      {label}
    </label>
  );
}

function Controls() {
  const f = useStore((s) => s.features);
  const link = useStore((s) => s.states.ROUTER?.attach?.MN || s.states.MN?.link || 'home');
  const scale = Number(f.time_scale || 1);
  return (
    <div className="grid grid-cols-[minmax(0,1.8fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2 shrink-0">
      <Control title="Walk to..." hint="Priya walks there and her phone switches networks.">
        <div className="flex flex-wrap gap-1.5">
          {PLACE_ORDER.map((k) => (
            <button key={k} onClick={() => requestWalk(k)} aria-pressed={k === link}
              className={`btn h-8 px-2 2xl:px-3 text-[14px] ${k === link ? 'btn-active font-semibold' : ''}`}>{PLACES[k].name}</button>
          ))}
        </div>
      </Control>
      <Control hint="The old network passes on frames that arrive mid-switch.">
        <Check checked={f.smooth_handoff} onChange={(v) => setFeature({ smooth_handoff: v })} label="Smooth handoff: keep frames during the switch" />
      </Control>
      <Control hint="The server skips the detour through home.">
        <Check checked={f.route_optimization} onChange={(v) => setFeature({ route_optimization: v })} label="Shorter path: let the server send directly" />
      </Control>
      <Control title="Speed" hint="Slows every delay so each step is easy to follow.">
        <div className="seg self-start" role="group" aria-label="Speed">
          {SPEEDS.map((v) => <button key={v} className="!h-8 !px-2 2xl:!px-3 !text-[13px]" aria-pressed={scale === v} onClick={() => setFeature({ time_scale: v })}>{v}x</button>)}
        </div>
      </Control>
    </div>
  );
}

/** Walks through the caption list so a burst of protocol steps is still readable. */
function useNarrator(captions) {
  const [shownId, setShownId] = useState(null);
  const since = useRef(0);
  useEffect(() => {
    const t = setInterval(() => {
      if (!captions.length) return;
      const i = captions.findIndex((c) => c.id === shownId);
      if (i === captions.length - 1) return;
      if (i >= 0 && Date.now() - since.current < DWELL) return;
      const backlog = captions.length - 1 - i;
      const next = backlog > 3 ? captions[captions.length - 3] : captions[i + 1];
      since.current = Date.now();
      setShownId(next.id);
    }, 200);
    return () => clearInterval(t);
  }, [captions, shownId]);
  const idx = captions.findIndex((c) => c.id === shownId);
  return { current: idx >= 0 ? captions[idx] : null, history: idx >= 0 ? captions.slice(Math.max(0, idx - 7), idx + 1).reverse() : [] };
}

function idleCaption(mnState, link) {
  if (mnState === 'AT_HOME' || !mnState) return 'Priya is at home, watching a video. Click a place to walk her there, or start the tour.';
  return `Priya is at ${PLACES[link]?.at || 'a foreign network'}. Her video still reaches her through the home router.`;
}

function Narrator({ current, fallback }) {
  const scenario = useStore((s) => s.scenario);
  const tour = scenario?.id === TOUR_ID ? scenario : null;
  const ch = tour && Number.isInteger(tour.chapter) ? tour.chapter : null;
  const total = tour?.chapters || tour?.total || 0;
  const go = (start) => send({ type: 'scenario', id: TOUR_ID, start });
  return (
    <footer className="panel shrink-0 min-h-[76px] flex items-center gap-4 px-5 py-3" aria-live="polite">
      <span className="badge h-6 px-2 text-[12px] border-acc-line bg-acc-soft text-acc shrink-0">Narrator</span>
      <p key={current?.id} className="flex-1 min-w-0 text-[16px] leading-[24px] text-noc-head1 fade-in">{current?.text || fallback}</p>
      {tour ? (
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[14px] text-noc-dim whitespace-nowrap">{ch === null ? 'Starting' : `Step ${ch + 1} of ${total}`}</span>
          <button className="btn h-8" disabled={!ch} onClick={() => go(ch - 1)}>Back</button>
          <button className="btn btn-primary h-8" disabled={ch === null || ch >= total - 1} onClick={() => go(ch + 1)}>Next</button>
          <button className="btn h-8" onClick={() => send({ type: 'scenario_stop' })}>Skip</button>
        </div>
      ) : (
        <button className="btn btn-primary h-8 shrink-0" onClick={() => go(0)}>Start the tour</button>
      )}
      <button className="btn h-8 shrink-0" onClick={() => setState({ mode: 'expert' })}>Expert view</button>
    </footer>
  );
}

function History({ items }) {
  return (
    <section className="panel flex-1 min-h-[120px] flex flex-col overflow-hidden" aria-label="What happened so far">
      <div className="h-9 shrink-0 flex items-center px-4 border-b border-noc-line text-[14px] font-semibold text-noc-head1">What happened so far</div>
      <ol className="flex-1 overflow-y-auto">
        {!items.length && <li className="px-4 py-3 text-[14px] text-noc-mute">The story will be written here as Priya moves.</li>}
        {items.map((c, i) => (
          <li key={c.id} className={`px-4 py-2.5 text-[14px] leading-[20px] border-b border-[#e6e9ed] ${i === 0 ? 'text-noc-head1' : 'text-noc-dim'}`}>
            {c.kind === 'tour' && <span className="font-semibold text-acc">Tour: </span>}{c.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

export default function StoryMode() {
  const captions = useStore((s) => s.captions);
  const connected = useStore((s) => s.connected);
  const cn = useStore((s) => s.states.CN);
  const scenario = useStore((s) => s.scenario);
  const mnState = useStore((s) => s.states.MN?.state);
  const link = useStore((s) => s.states.ROUTER?.attach?.MN || s.states.MN?.link || 'home');
  const [intro, setIntro] = useState(() => !localStorage.getItem('mip.story.intro'));
  const { current, history } = useNarrator(captions);

  // Story mode always has the video running
  useEffect(() => {
    if (!connected || !cn || cn.streaming || scenario) return undefined;
    const t = setTimeout(() => command('CN', 'stream_start'), 800);
    return () => clearTimeout(t);
  }, [connected, cn?.streaming, !!cn, !!scenario]);

  return (
    <div className="flex-1 min-h-0 p-2 flex flex-col gap-2 text-[15px]">
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_30%] gap-2">
        <div className="min-w-0 min-h-0 flex flex-col gap-2">
          {intro && <Intro onClose={() => { localStorage.setItem('mip.story.intro', '1'); setIntro(false); }} />}
          <section className="panel flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="h-10 shrink-0 flex items-center gap-5 px-4 border-b border-noc-line text-[14px] text-noc-dim">
              <span className="font-semibold text-noc-head1 text-[15px]">Priya's day</span>
              <span className="hidden xl:inline">Click a place to walk there.</span>
              <span className="ml-auto flex items-center gap-2"><LegendEnvelope />Normal envelope</span>
              <span className="flex items-center gap-2"><LegendEnvelope tunnel />Envelope inside an envelope (tunnel)</span>
            </div>
            <div className="flex-1 min-h-0 bg-[#eaf3fb]"><StoryScene /></div>
          </section>
          <Controls />
        </div>
        <div className="min-w-0 min-h-0 flex flex-col gap-2">
          <section className="panel p-4 shrink-0"><StoryPhone /></section>
          <History items={history} />
        </div>
      </div>
      <Narrator current={current} fallback={idleCaption(mnState, link)} />
    </div>
  );
}
