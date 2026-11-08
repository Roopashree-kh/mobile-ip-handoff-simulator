// WebSocket link to the gateway (ws://localhost:<http_port from topology.json>).
// Pause keeps the connection open but parks events in a buffer. Step releases one
// event at a time, Play releases everything. Agent state snapshots are never parked,
// so the tables keep counting down while the packet view is frozen.
import { applyItems, getState, initFromHello, setState } from './store.js';

/* global __GATEWAY_PORT__ */
export const GATEWAY_PORT = __GATEWAY_PORT__;
export const GATEWAY_HTTP = `http://${location.hostname || 'localhost'}:${GATEWAY_PORT}`;

let ws = null;
let retry = null;

export function connect() {
  clearTimeout(retry);
  ws = new WebSocket(`ws://${location.hostname || 'localhost'}:${GATEWAY_PORT}`);
  ws.onopen = () => setState({ connected: true });
  ws.onclose = () => {
    setState({ connected: false });
    retry = setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (msg) => {
    const m = JSON.parse(msg.data);
    if (m.type === 'hello') return initFromHello(m);
    if (m.type !== 'batch') return;
    const s = getState();
    if (!s.paused) return applyItems(m.items);
    const live = [];
    const parked = [];
    for (const it of m.items) (it.type === 'event' ? parked : live).push(it);
    if (live.length) applyItems(live);
    if (parked.length) setState({ buffered: [...s.buffered, ...parked].slice(-20000) });
  };
}

export function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export const command = (target, cmd, args = {}) => send({ type: 'command', target, cmd, args });
export const setFeature = (features) => send({ type: 'set', features });

export function pause() {
  setState({ paused: true });
}

export function play() {
  const { buffered } = getState();
  setState({ paused: false, buffered: [] });
  applyItems(buffered, buffered.length < 80);
}

export function step() {
  const { buffered } = getState();
  if (!buffered.length) return;
  setState({ buffered: buffered.slice(1) });
  applyItems([buffered[0]], true);
}
