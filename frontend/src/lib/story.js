// Story mode: plain-English captions derived from the real protocol events, plus the small
// shared pieces the Story screen needs (place names, a walk request channel).
// The technical "learn" strings stay with Expert mode. Nothing here changes the simulation.

export const TOUR_ID = '7_story_tour';

export const PLACES = {
  home: { name: 'Home', at: 'home', net: 'her home network', netCap: 'Her home network', router: 'The home router' },
  fa1: { name: 'Campus Wi-Fi', at: 'the campus', net: 'the Campus Wi-Fi network', netCap: 'The Campus Wi-Fi network', router: 'The campus router' },
  fa2: { name: 'Metro', at: 'the Metro', net: 'the Metro network', netCap: 'The Metro network', router: 'The Metro router' },
  fa3: { name: 'Airport', at: 'the airport', net: 'the Airport network', netCap: 'The Airport network', router: 'The airport router' },
};
export const PLACE_ORDER = ['home', 'fa1', 'fa2', 'fa3'];
const AGENT_PLACE = { HA: 'home', 'FA-1': 'fa1', 'FA-2': 'fa2', 'FA-3': 'fa3' };

// context carried between events
let place = 'home';
let wantTunnelCaption = false;
let roExplained = false;
let radioSwitches = [];
const lastText = new Map();

/** Forget per-run context (Reset). */
export function resetStoryContext() {
  radioSwitches = [];
  wantTunnelCaption = false;
  roExplained = false;
  lastText.clear();
}

/** Route optimization switched off: explain it again the next time it takes effect. */
export function roSwitched(on) {
  if (!on) roExplained = false;
}

/**
 * Plain-English caption for one gateway event, or null. state is the store state, used
 * for the MN's current link when the event itself does not say.
 */
export function captionFor(ev, state) {
  const text = build(ev, state);
  if (!text) return null;
  // the same sentence twice within a few seconds adds nothing
  const prev = lastText.get(text) || 0;
  if (ev.ts - prev < 8000) return null;
  lastText.set(text, ev.ts);
  return { text, ts: ev.ts, kind: ev.kind === 'scenario' ? 'tour' : 'event' };
}

function build(ev, state) {
  const p = PLACES[place] || PLACES.home;
  const s = ev.summary || '';
  switch (ev.kind) {
    case 'scenario':
      return ev.scenario === TOUR_ID && ev.state === 'step' ? s : null;
    case 'coverage_event':
      if (ev.state === 'started') return 'The metro ride starts. Watch the signal bars over the train.';
      if (ev.state === 'dead_enter') return 'The train enters the tunnel. No network can reach the phone now.';
      if (ev.state === 'dead_exit') return 'The train comes out of the tunnel. The phone can hear a network again.';
      if (ev.state === 'finished') return 'The train has reached the airport. The ride is over.';
      return null;
    case 'qos_event':
      if (ev.type === 'outage') {
        const r = ev.recover_ms || {};
        const sec = (v) => (v === null || v === undefined ? 'a while' : `${(v / 1000).toFixed(1)} s`);
        return `The tunnel cut the phone off for about ${Math.round((ev.duration_ms || 0) / 1000)} seconds. After the signal came back, the call returned in ${sec(r.voice)}, the video in ${sec(r.video)} and the chat in ${sec(r.text)}.`;
      }
      return null;
    case 'hold':
      if (s.startsWith('HA holds')) return 'The phone is out of reach, so the home router keeps its packets instead of throwing them away. Old call sound is dropped, video is kept for two seconds and chat messages are kept.';
      if (s.startsWith('HA releases')) return 'The phone is back. The home router hands over everything it kept.';
      return null;
    case 'adapt':
      return ev.direction === 'down'
        ? 'The video server sees trouble on the way, so it sends a smaller picture.'
        : 'The path is healthy again, so the video server goes back to the full picture.';
    case 'l2':
      if (ev.station !== 'MN' || !PLACES[ev.new]) return null;
      place = ev.new;
      return place === 'home'
        ? "Priya is back home. Her phone just connected to her home network."
        : `Priya's phone just connected to ${PLACES[place].net}.`;
    case 'movement': {
      if (ev.node === 'MN' && s.startsWith('radio:')) {
        radioSwitches = radioSwitches.filter((t) => ev.ts - t < 12000).concat(ev.ts);
        if (radioSwitches.length >= 3) return 'The phone keeps flipping between two networks at the edge of their range. Each flip costs a moment of silence.';
        const to = s.match(/ to (.+?),/);
        return to ? `The phone moves to ${to[1]} because its signal is stronger.` : null;
      }
      if (ev.node === 'MN' && s.startsWith('overlap:')) return 'For a few seconds the phone is on two networks at once. Every packet is sent both ways, so nothing is lost while it switches.';
      if (ev.node === 'MN' && s.startsWith('signal is back')) return 'The phone does not wait for the next beacon. It announces itself the moment the signal is back.';
      if (ev.node !== 'MN' || !s.startsWith('movement detected')) return null;
      const m = s.match(/new agent (\S+)/);
      const at = PLACES[AGENT_PLACE[m && m[1]]] || p;
      return at === PLACES.home
        ? "The home router says: 'Welcome back. You are on your home network again.'"
        : `${at.router} says: 'Hi, I'm a mobility agent. You can register through me.'`;
    }
    case 'registration':
      if (ev.node === 'MN') {
        if (s.startsWith('MN sends Registration Request') && ev.reason === 'movement') {
          return `The phone tells its home router: 'I'm at ${p.at} now. Send my stuff here.'`;
        }
        if (s.startsWith('MN is home')) return "The phone tells its home router: 'I'm home. Stop forwarding my stuff.'";
        if (s.startsWith('MN registered')) {
          wantTunnelCaption = true;
          return `Home router replies: 'Got it. I'll forward everything to ${p.at} for the next ${ev.lifetime} seconds.'`;
        }
        if (s.startsWith('MN deregistered')) return "Home router replies: 'Welcome home. Your video now comes straight to you.'";
        return null;
      }
      if (ev.node === 'HA' && (ev.code === 131 || ev.code === 133)) return WRONG_KEY;
      return null;
    case 'demo':
      return ev.code === 131 || ev.code === 133 ? WRONG_KEY : null;
    case 'data_rx':
      // first packet that reached the phone through the home router after a registration
      if (wantTunnelCaption && !ev.at_home && ev.route_tag === 0) {
        wantTunnelCaption = false;
        return `The video server still sends to Priya's home address. The home router wraps each packet and forwards it to ${p.at}. The video keeps playing.`;
      }
      if (wantTunnelCaption && ev.route_tag === 1) wantTunnelCaption = false;
      return null;
    case 'handoff_loss': {
      const n = ev.lost || 0;
      if (n > 1000) return null; // a stream that restarted during Reset, not a real gap
      if (!n) return ev.completed ? 'This time no video frames were lost during the switch.' : null;
      return `While switching networks, ${n} video frame${n === 1 ? ' was' : 's were'} lost. That's the handoff gap.`;
    }
    case 'ro':
      if (ev.node === 'CN' && s.startsWith('CN binding cache:') && !roExplained) {
        roExplained = true;
        return 'Now the home router tells the video server where Priya really is, so the server sends directly. Shorter path, lower delay.';
      }
      return null;
    case 'packet':
      if (ev.verdict === 'dropped' && ev.frm === 'MN' && String(ev.reason || '').startsWith('ingress filter')) {
        return `${p.netCap} blocks packets that claim to come from somewhere else, so Priya's replies are dropped. Sending them back through home fixes it.`;
      }
      return null;
    default:
      return null;
  }
}

const WRONG_KEY = 'Someone tried to register as Priya without the secret key. Home router refused.';

// ---- walk requests: the Walk to... buttons ask the scene to animate Priya ----
const walkers = new Set();
export function onWalkRequest(fn) {
  walkers.add(fn);
  return () => walkers.delete(fn);
}
export function requestWalk(link) {
  walkers.forEach((f) => f(link));
}
