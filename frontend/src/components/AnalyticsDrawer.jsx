// Analytics slide-out drawer (Recharts). Colours are the validated dark categorical slots
// in fixed order (see lib/util.js SERIES). Every chart has a legend or a title naming its
// single series, a hover tooltip, and a table view below for exact values.
import React, { useMemo } from 'react';
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { setState, useStore } from '../lib/store.js';
import { SERIES, downloadCsv, linkLabel } from '../lib/util.js';
import { Icon } from './ui.jsx';

const AXIS = { stroke: '#b8bfc8', tick: { fill: '#5f6b7a', fontSize: 11 }, tickLine: false };
const GRID = <CartesianGrid stroke="#e6e9ed" vertical={false} />;
const TIP = { contentStyle: { background: '#ffffff', border: '1px solid #b8bfc8', borderRadius: 3, fontSize: 12 }, labelStyle: { color: '#111111' }, itemStyle: { color: '#1f2933' } };
const ROUTES = [['triangle', 'Triangle (via HA)', SERIES.s1], ['optimized', 'Route optimized', SERIES.s2],
  ['home', 'At home', SERIES.s3], ['rescued', 'Rescued by smooth handoff', SERIES.s4]];
const THEORY = { ipip: 20, minimal: 12, gre: 24 };
const INNER = 148; // stream datagram: 20 IPv4 + 8 UDP + 120 payload

function Box({ title, children, note }) {
  return (
    <section className="panel p-4">
      <h3 className="text-sm font-semibold text-noc-head1">{title}</h3>
      {note ? <p className="text-2xs text-noc-mute mt-0.5 mb-3">{note}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

export default function AnalyticsDrawer() {
  const open = useStore((s) => s.analyticsOpen);
  const latency = useStore((s) => s.latency);
  const handoffs = useStore((s) => s.handoffs);
  const overhead = useStore((s) => s.overhead);
  const phases = useStore((s) => s.phases);
  const topology = useStore((s) => s.topology);

  const latData = useMemo(() => latency.slice(-600).map((p) => ({ seq: p.seq, [p.route]: p.latency_ms, segments: p.segments, stretch: p.stretch })), [latency]);
  const present = useMemo(() => new Set(latency.slice(-600).map((p) => p.route)), [latency]);
  const hoData = useMemo(() => handoffs.filter((h) => h.total_ms !== undefined).slice(-20).map((h) => ({
    name: `#${h.id} ${linkLabel(topology, h.to).split(' ')[0]}`, detection: h.detection_ms, registration: h.registration_ms,
    algorithm: h.algorithm, lost: h.lost ?? 0, rescued: h.rescued ?? 0, smooth: h.smooth ? 'on' : 'off',
  })), [handoffs, topology]);
  const ohData = ['ipip', 'minimal', 'gre'].map((m) => ({
    mode: { ipip: 'IP-in-IP', minimal: 'Minimal', gre: 'GRE' }[m],
    bytes: overhead[m]?.perPacket ?? THEORY[m], observed: overhead[m]?.packets || 0,
  }));
  const summary = useMemo(() => {
    const by = {};
    for (const p of latency) {
      const b = by[p.route] || (by[p.route] = { route: p.route, n: 0, lat: 0, seg: 0, str: 0 });
      b.n += 1; b.lat += p.latency_ms; b.seg += p.segments || 0; b.str += p.stretch || 0;
    }
    return Object.values(by);
  }, [latency]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex" onClick={() => setState({ analyticsOpen: false })}>
      <div className="flex-1 bg-black/20" />
      <aside className="w-[min(1100px,72vw)] h-full bg-noc-bg border-l border-noc-line overflow-y-auto shadow-[-4px_0_12px_rgba(0,0,0,0.12)]" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center gap-3 h-14 px-5 border-b border-noc-line bg-white">
          <h2 className="text-lg font-semibold text-noc-head1">Analytics</h2>
          <span className="text-xs text-noc-mute font-mono">{latency.length} samples, {handoffs.length} handoffs</span>
          <button className="btn ml-auto" onClick={() => downloadCsv('latency.csv', latency)}><Icon name="download" size={14} />Latency CSV</button>
          <button className="btn" onClick={() => downloadCsv('handoffs.csv', handoffs)}><Icon name="download" size={14} />Handoffs CSV</button>
          <button className="icon-btn btn-ghost" onClick={() => setState({ analyticsOpen: false })} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="p-5 space-y-4">

        {phases.length > 0 && (
          <Box title="Triangle vs optimized (scenario phases)" note="Same stream, same visited network, measured in two phases.">
            <table className="tbl tbl-c">
              <thead><tr><th className="text-left">Phase</th><th>Packets</th><th>Mean latency</th><th>Min</th><th>Max</th><th>Segments</th><th>Path stretch</th><th>Lost</th></tr></thead>
              <tbody>{phases.map((p) => (
                <tr key={p.label} ><td className="text-left">{p.label}</td><td>{p.packets}</td><td>{p.mean_latency_ms} ms</td>
                  <td>{p.min_latency_ms}</td><td>{p.max_latency_ms}</td><td>{p.mean_segments}</td><td>{p.mean_stretch}</td><td>{p.lost}</td></tr>
              ))}</tbody>
            </table>
          </Box>
        )}

        <Box title="End-to-end latency per packet, CN to MN" note="Each point is one stream datagram. Gaps mark handoffs.">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={latData} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
              {GRID}
              <XAxis dataKey="seq" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} {...AXIS} />
              <YAxis {...AXIS} unit=" ms" width={60} />
              <Tooltip {...TIP} />
              <Legend wrapperStyle={{ fontSize: 12, color: '#5f6b7a' }} iconType="circle" iconSize={8} />
              {ROUTES.filter(([k]) => present.has(k)).map(([k, label, c]) => (
                <Line key={k} dataKey={k} name={label} stroke={c} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <table className="tbl tbl-c mt-3">
            <thead><tr><th className="text-left">Route</th><th>Samples</th><th>Mean latency</th><th>Mean segments</th><th>Mean stretch</th></tr></thead>
            <tbody>{summary.map((b) => (
              <tr key={b.route} ><td className="text-left">{b.route}</td><td>{b.n}</td><td>{(b.lat / b.n).toFixed(1)} ms</td>
                <td>{(b.seg / b.n).toFixed(2)}</td><td>{(b.str / b.n).toFixed(2)}</td></tr>
            ))}</tbody>
          </table>
        </Box>

        <div className="grid grid-cols-2 gap-4">
          <Box title="Handoff timeline" note="Handoff latency = movement detection + registration.">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hoData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                {GRID}
                <XAxis dataKey="name" {...AXIS} />
                <YAxis {...AXIS} unit=" ms" width={64} />
                <Tooltip {...TIP} cursor={{ fill: '#eef1f5' }} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#5f6b7a' }} iconType="circle" iconSize={8} />
                <Bar dataKey="detection" name="Detection" stackId="h" fill={SERIES.s1} stroke="#ffffff" strokeWidth={2} isAnimationActive={false} />
                <Bar dataKey="registration" name="Registration" stackId="h" fill={SERIES.s2} stroke="#ffffff" strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </Box>
          <Box title="Packets lost per handoff" note="Smooth handoff state is shown per handoff. Rescued = forwarded by the previous FA.">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={hoData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                {GRID}
                {/* two-line tick: handoff name, then its smooth handoff state, so labels never run together */}
                <XAxis dataKey="name" {...AXIS} interval={0} height={36} tick={({ x, y, payload, index }) => (
                  <g transform={`translate(${x},${y})`}>
                    <text dy={12} textAnchor="middle" fill="#5f6b7a" fontSize={11}>{payload.value}</text>
                    <text dy={26} textAnchor="middle" fill="#7b8794" fontSize={11}>smooth {hoData[index]?.smooth}</text>
                  </g>
                )} />
                <YAxis {...AXIS} allowDecimals={false} width={40} />
                <Tooltip {...TIP} cursor={{ fill: '#eef1f5' }} />
                <Legend wrapperStyle={{ fontSize: 12, color: '#5f6b7a' }} iconType="circle" iconSize={8} />
                <Bar dataKey="lost" name="Lost" fill={SERIES.s2} stroke="#ffffff" strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="rescued" name="Rescued" fill={SERIES.s3} stroke="#ffffff" strokeWidth={2} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </Box>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Box title="Encapsulation overhead, bytes per tunneled packet" note="Measured from the captured tunnel packets where available, otherwise the RFC header sizes.">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={ohData} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
                {GRID}
                <XAxis dataKey="mode" {...AXIS} />
                <YAxis {...AXIS} unit=" B" width={50} />
                <Tooltip {...TIP} cursor={{ fill: '#eef1f5' }} />
                <Bar dataKey="bytes" name="Overhead" fill={SERIES.s1} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </Box>
          <Box title="Overhead table">
            <table className="tbl tbl-c">
              <thead><tr><th className="text-left">Mode</th><th>Bytes</th><th>On a {INNER} B datagram</th><th>Packets seen</th></tr></thead>
              <tbody>{ohData.map((o) => (
                <tr key={o.mode} ><td className="text-left">{o.mode}</td><td>{o.bytes}</td>
                  <td>{((o.bytes / INNER) * 100).toFixed(1)} %</td><td>{o.observed}</td></tr>
              ))}</tbody>
            </table>
            <p className="text-2xs text-noc-mute mt-3 leading-4">Minimal encapsulation is 12 bytes when the HA tunnels someone else's datagram
              (S bit set, original source carried) and 8 bytes when the encapsulator is the source. GRE is 24 bytes, 28 with the checksum.</p>
          </Box>
        </div>

        <Box title="Handoff table">
          <table className="tbl tbl-c">
            <thead><tr><th className="text-left">#</th><th className="text-left">From</th><th className="text-left">To</th><th>Rule</th><th>Detection</th><th>Registration</th><th>Total</th><th>Lost</th><th>Rescued</th><th>Smooth</th></tr></thead>
            <tbody>{handoffs.slice(-30).map((h) => (
              <tr key={h.id} ><td className="text-left">{h.id}</td><td className="text-left">{linkLabel(topology, h.from)}</td>
                <td className="text-left">{linkLabel(topology, h.to)}</td><td>{h.algorithm || '-'}</td><td>{h.detection_ms ?? '-'}</td>
                <td>{h.registration_ms ?? '-'}</td><td>{h.total_ms ?? '-'}</td><td>{h.lost ?? '-'}</td><td>{h.rescued ?? 0}</td><td>{h.smooth ? 'on' : 'off'}</td></tr>
            ))}</tbody>
          </table>
        </Box>
        </div>
      </aside>
    </div>
  );
}
