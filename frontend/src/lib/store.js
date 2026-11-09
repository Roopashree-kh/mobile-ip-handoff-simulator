// Tiny external store. Components subscribe with useStore(selector) and re-render only
// when the selected slice changes by reference, which keeps 50 ms event batches cheap.
import { useSyncExternalStore } from 'react';

const MAX_PACKETS = 4000;
const MAX_EVENTS = 600;
const MAX_LATENCY = 1500;

const initial = {
  connected: false,
  startedAt: Date.now(),
  resetAt: Date.now(),
  inspectorCollapsed: false,
  topology: null,
  features: {},
  states: {},
  scenarios: [],
  scenario: null,
  narration: [],
  packets: [],
  events: [],
  latency: [],
  handoffs: [],
  overhead: {},
  phases: [],
  phase: null,
  paused: false,
  buffered: [],
  selectedNo: null,
  learn: false,
  walkthrough: [],
  analyticsOpen: false,
  lastNo: 0,
};

let state = initial;
const subs = new Set();
const packetListeners = new Set();
const MAX_WALK = 300;
const recentLearn = new Map();
let walkId = 0;

export const getState = () => state;

export function setState(patch) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  subs.forEach((f) => f());
}

function subscribe(f) {
  subs.add(f);
  return () => subs.delete(f);
}

export function useStore(selector) {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/** The topology map registers here to animate each forwarded or dropped frame. */
export function onPacket(fn) {
  packetListeners.add(fn);
  return () => packetListeners.delete(fn);
}

export function initFromHello(h) {
  const handoffs = (h.metrics?.handoffs || []).sort((a, b) => a.id - b.id);
  const overhead = {};
  for (const o of h.metrics?.overhead || []) overhead[o.mode] = o;
  state = {
    ...state,
    connected: true,
    startedAt: h.startedAt,
    resetAt: h.resetAt || h.startedAt,
    topology: h.topology,
    features: h.features,
    states: h.states || {},
    scenarios: h.scenarios || [],
    scenario: h.scenario,
    packets: [],
    events: [],
    latency: h.metrics?.latency || [],
    handoffs,
    overhead,
    phases: h.metrics?.phases || [],
    phase: h.metrics?.phase || null,
    buffered: [],
    lastNo: 0,
  };
  // metrics already arrived as a snapshot above, so skip the raw metric events in the ring
  applyItems((h.events || []).filter((ev) => ev.kind !== 'metric').map((ev) => ({ type: 'event', ev })), false);
  const last = (h.events || []).reduce((n, ev) => Math.max(n, ev.no || 0), 0);
  setState({ lastNo: last });
}

function upsertHandoff(list, h) {
  const i = list.findIndex((x) => x.id === h.id);
  if (i >= 0) list[i] = { ...list[i], ...h };
  else list.push(h);
}

/** Apply a batch of gateway items. animate=false when flushing a large paused buffer. */
export function applyItems(items, animate = true) {
  if (!items.length) return;
  const s = state;
  let packets = null;
  let events = null;
  let latency = null;
  let handoffs = null;
  let overhead = null;
  let states = null;
  const patch = {};
  const animateList = [];
  const walk = [];

  for (const it of items) {
    if (it.type === 'state') {
      states = states || { ...s.states };
      states[it.node] = it.state;
      continue;
    }
    if (it.type === 'features') { patch.features = it.features; continue; }
    if (it.type === 'phase') { patch.phase = it.phase; continue; }
    if (it.type === 'reset' || it.type === 'cleared') {
      packets = [];
      events = [];
      latency = [];
      handoffs = [];
      overhead = {};
      patch.phases = [];
      patch.selectedNo = null;
      patch.walkthrough = [];
      recentLearn.clear();
      if (it.type === 'reset') patch.resetAt = it.resetAt || Date.now();
      if (it.features) patch.features = it.features;
      continue;
    }
    if (it.type !== 'event') continue;
    const ev = it.ev;
    // the hello snapshot and the first batch can overlap; event numbers are monotonic
    if (ev.no <= (patch.lastNo ?? s.lastNo)) continue;
    patch.lastNo = ev.no;
    if (ev.kind === 'packet') {
      packets = packets || s.packets.slice();
      packets.push(ev);
      if (ev.encap && ev.verdict === 'forwarded') {
        overhead = overhead || { ...s.overhead };
        const o = overhead[ev.encap] || { mode: ev.encap, packets: 0, bytes: 0, perPacket: ev.overhead };
        overhead[ev.encap] = { ...o, packets: o.packets + 1, bytes: o.bytes + ev.overhead, perPacket: ev.overhead };
      }
      if (animate) animateList.push(ev);
      continue;
    }
    if (ev.kind === 'metric') {
      if (ev.type === 'latency') {
        latency = latency || s.latency.slice();
        latency.push(ev.point);
      } else if (ev.type === 'handoff') {
        handoffs = handoffs || s.handoffs.slice();
        upsertHandoff(handoffs, ev.handoff);
      } else if (ev.type === 'phases') {
        patch.phases = ev.phases;
      }
      continue;
    }
    if (ev.kind === 'data_rx' || ev.kind === 'reply_rx' || ev.kind === 'smooth_forward') continue;
    if (ev.kind === 'scenario') {
      patch.scenario = ev.state === 'running' || ev.state === 'step'
        ? { id: ev.scenario, step: ev.step, total: ev.total, note: ev.summary }
        : null;
      patch.narration = [...(patch.narration || s.narration), { ts: ev.ts, text: ev.summary }].slice(-6);
    }
    events = events || s.events.slice();
    events.push(ev);
    if (s.learn && ev.learn && animate) {
      const key = ev.kind + ev.learn.slice(0, 60);
      const last = recentLearn.get(key) || 0;
      if (ev.ts - last > 20000) {
        recentLearn.set(key, ev.ts);
        walk.push({ id: ++walkId, ts: ev.ts, node: ev.node, title: ev.summary, text: ev.learn, rfc: ev.rfc });
      }
    }
  }
  if (packets) patch.packets = packets.length > MAX_PACKETS ? packets.slice(-MAX_PACKETS) : packets;
  if (events) patch.events = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
  if (latency) patch.latency = latency.length > MAX_LATENCY ? latency.slice(-MAX_LATENCY) : latency;
  if (handoffs) patch.handoffs = handoffs;
  if (overhead) patch.overhead = overhead;
  if (states) patch.states = states;
  if (walk.length) patch.walkthrough = [...(patch.walkthrough || s.walkthrough), ...walk].slice(-MAX_WALK);
  setState(patch);
  if (animateList.length) {
    const list = animateList.length > 60 ? animateList.slice(-60) : animateList;
    packetListeners.forEach((fn) => fn(list));
  }
}

/** Learn mode on or off. Turning it on starts the walkthrough's repeat filter afresh. */
export function setLearn(on) {
  if (on) recentLearn.clear();
  setState({ learn: on });
}
