// Live metrics derived from the telemetry stream.
//
// Path length: the router mirrors every frame with a flow key (innermost src>dst#ip-id/proto),
// so counting forwarded frames per flow gives the number of link segments each datagram
// actually crossed. When the MN reports the datagram (data_rx) we know its latency too.
//
//   at home              CN -> MN                               1 segment, optimal 1
//   FA-CoA triangle      CN -> HA -> FA -> MN                   3 segments, optimal 2
//   FA-CoA optimized     CN -> FA -> MN                         2 segments, optimal 2
//   rescued (smooth)     CN -> HA -> old FA -> new FA -> MN     4 segments
//   co-located triangle  CN -> HA -> MN                         2 segments, optimal 1
//
// Path stretch = actual segments / optimal segments.
'use strict';

const MAX_FLOWS = 20000;
const MAX_POINTS = 4000;

class Metrics {
  constructor(emit) {
    this.emit = emit; // function(event) pushes a derived event into the stream
    this.reset();
  }

  reset() {
    this.flows = new Map();
    this.latency = [];
    this.handoffs = new Map();
    this.overhead = {};
    this.phases = {};
    this.phase = null;
    this.currentHandoff = null;
    this.rescuedSince = 0;
  }

  setPhase(label) {
    this.phase = label || null;
    if (label && !this.phases[label]) {
      this.phases[label] = { label, n: 0, latency: 0, segments: 0, stretch: 0, min: Infinity, max: 0, lost: 0 };
    }
  }

  ingest(ev) {
    switch (ev.kind) {
      case 'packet':
        if (ev.verdict === 'forwarded' && ev.flow) {
          this.flows.set(ev.flow, (this.flows.get(ev.flow) || 0) + 1);
          if (this.flows.size > MAX_FLOWS) this.flows.delete(this.flows.keys().next().value);
        }
        if (ev.encap && ev.verdict === 'forwarded') {
          const o = this.overhead[ev.encap] || (this.overhead[ev.encap] = { mode: ev.encap, packets: 0, bytes: 0, perPacket: ev.overhead });
          o.packets += 1;
          o.bytes += ev.overhead;
          o.perPacket = ev.overhead;
        }
        break;
      case 'data_rx':
        // let the router's mirror of the last segment arrive first
        setTimeout(() => this.latencyPoint(ev), 40);
        break;
      case 'handoff_start':
        this.currentHandoff = ev.id;
        this.rescuedSince = 0;
        this.handoffs.set(ev.id, { id: ev.id, from: ev.from_link, to: ev.to_link, start: ev.ts, rescued: 0 });
        break;
      case 'smooth_forward':
        this.rescuedSince += 1;
        if (this.currentHandoff && this.handoffs.has(this.currentHandoff)) this.handoffs.get(this.currentHandoff).rescued += 1;
        break;
      case 'handoff': {
        const h = this.handoffs.get(ev.id) || { id: ev.id };
        Object.assign(h, { from: ev.from_link, to: ev.to_link, algorithm: ev.algorithm, detection_ms: ev.detection_ms,
          registration_ms: ev.registration_ms, total_ms: ev.total_ms, smooth: ev.smooth, encap: ev.encap });
        this.handoffs.set(ev.id, h);
        this.emit({ kind: 'metric', type: 'handoff', node: 'GATEWAY', summary: 'handoff metrics', handoff: h });
        break;
      }
      case 'handoff_loss': {
        const h = this.handoffs.get(ev.id) || { id: ev.id };
        h.lost = ev.lost;
        h.smooth = ev.smooth;
        h.completed = ev.completed;
        this.handoffs.set(ev.id, h);
        if (this.phase && this.phases[this.phase]) this.phases[this.phase].lost += ev.lost;
        this.emit({ kind: 'metric', type: 'handoff', node: 'GATEWAY', summary: 'handoff loss', handoff: h });
        break;
      }
      default:
        break;
    }
  }

  latencyPoint(ev) {
    const segments = this.flows.get(ev.flow) || null;
    if (segments !== null) this.flows.delete(ev.flow);
    let route;
    let optimal;
    if (ev.at_home) { route = 'home'; optimal = 1; }
    else if (ev.ccoa) { route = ev.route_tag === 1 ? 'optimized' : 'triangle'; optimal = 1; }
    else { route = ev.route_tag === 1 ? 'optimized' : 'triangle'; optimal = 2; }
    const expected = route === 'home' ? 1 : (route === 'optimized' ? optimal : optimal + 1);
    if (segments && segments > expected) route = 'rescued';
    const p = {
      seq: ev.seq, ts: ev.ts, latency_ms: ev.latency_ms, segments, optimal,
      stretch: segments ? +(segments / optimal).toFixed(2) : null, route, phase: this.phase, handoff: ev.handoff_id,
    };
    this.latency.push(p);
    if (this.latency.length > MAX_POINTS) this.latency.splice(0, this.latency.length - MAX_POINTS);
    if (this.phase && this.phases[this.phase]) {
      const ph = this.phases[this.phase];
      ph.n += 1;
      ph.latency += p.latency_ms;
      ph.segments += segments || 0;
      ph.stretch += p.stretch || 0;
      ph.min = Math.min(ph.min, p.latency_ms);
      ph.max = Math.max(ph.max, p.latency_ms);
    }
    this.emit({ kind: 'metric', type: 'latency', node: 'GATEWAY', summary: 'latency', point: p });
  }

  phaseSummary() {
    return Object.values(this.phases).map((ph) => ({
      label: ph.label, packets: ph.n,
      mean_latency_ms: ph.n ? +(ph.latency / ph.n).toFixed(2) : null,
      min_latency_ms: ph.n ? +ph.min.toFixed(2) : null,
      max_latency_ms: ph.n ? +ph.max.toFixed(2) : null,
      mean_segments: ph.n ? +(ph.segments / ph.n).toFixed(2) : null,
      mean_stretch: ph.n ? +(ph.stretch / ph.n).toFixed(2) : null,
      lost: ph.lost,
    }));
  }

  snapshot() {
    return {
      latency: this.latency.slice(-1500),
      handoffs: [...this.handoffs.values()],
      overhead: Object.values(this.overhead),
      phases: this.phaseSummary(),
      phase: this.phase,
    };
  }
}

module.exports = { Metrics };
