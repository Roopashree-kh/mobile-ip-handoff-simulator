// Quality of service drawer for Expert mode. Live numbers per flow, the compliance table
// (measured against the ITU-T targets with the source of each), charts over time with the
// handoffs marked, the interruption list and the CSV export. The mobile node does all the
// measuring. This file only shows what it reports.
import React, { useMemo, useState } from 'react';
import {
  CartesianGrid, Legend, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { setState, useStore } from '../lib/store.js';
import { GATEWAY_HTTP } from '../lib/ws.js';
import { SERIES } from '../lib/util.js';
import { Icon } from './ui.jsx';
import CoverageSection from './CoverageSection.jsx';
import ResultsSection from './ResultsSection.jsx';

const AXIS = { stroke: '#b8bfc8', tick: { fill: '#5f6b7a', fontSize: 11 }, tickLine: false };
const GRID = <CartesianGrid stroke="#e6e9ed" vertical={false} />;
const TIP = { contentStyle: { background: '#ffffff', border: '1px solid #b8bfc8', borderRadius: 3, fontSize: 12 }, labelStyle: { color: '#111111' }, itemStyle: { color: '#1f2933' } };

export const LEVEL = {
  good: { label: 'Good', cls: 'border-[#9ccfa8] bg-good-soft text-good' },
  fair: { label: 'Fair', cls: 'border-warn-line bg-warn-soft text-warn' },
  poor: { label: 'Poor', cls: 'border-bad-line bg-bad-soft text-bad' },
  idle: { label: 'No data', cls: 'border-noc-line bg-noc-raised text-noc-dim' },
};

export function Pill({ level }) {
  const l = LEVEL[level] || LEVEL.idle;
  return <span className={`badge h-6 px-2 text-xs font-semibold ${l.cls}`}>{l.label}</span>;
}

const f = (v, d = 0, unit = '') => (v === null || v === undefined || Number.isNaN(v) ? '-' : `${Number(v).toFixed(d)}${unit}`);

function Box({ title, note, children, right }) {
  return (
    <section className="panel p-4">
      <div className="flex items-baseline gap-3">
        <h3 className="text-sm font-semibold text-noc-head1">{title}</h3>
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {note ? <p className="text-2xs text-noc-mute mt-0.5 mb-3">{note}</p> : <div className="mb-3" />}
      {children}
    </section>
  );
}

function Num({ label, value, hint }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="text-2xs text-noc-dim leading-4 truncate">{label}</div>
      <div className="font-mono text-base text-noc-head1 tabular-nums leading-6">{value}</div>
    </div>
  );
}

function FlowCard({ title, rep, children }) {
  const v = rep?.verdict;
  return (
    <div className="panel p-3 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-noc-head1">{title}</span>
        <span className="ml-auto"><Pill level={v?.level || 'idle'} /></span>
      </div>
      <p className="text-xs text-noc-dim mt-1 min-h-[34px] leading-4">{v?.reason || 'Waiting for the flow to start.'}</p>
      <div className="grid grid-cols-3 gap-x-3 gap-y-1 mt-2">{children}</div>
    </div>
  );
}

/** x in seconds since the first QoS report, plus the chart-ready rows. */
function useSeries(qos) {
  return useMemo(() => {
    if (!qos.length) return { rows: [], t0: 0 };
    const t0 = qos[0].t;
    const rows = qos.map((p) => ({
      x: +((p.t - t0) / 1000).toFixed(2),
      voice_delay: p.voice.delay, voice_m2e: p.voice.m2e, video_delay: p.video.delay,
      voice_jitter: p.voice.jitter, video_jitter: p.video.jitter, mos: p.voice.mos,
      blackout: p.blackout,
    }));
    return { rows, t0 };
  }, [qos]);
}

/** Blackout spans and handoff lines for any time-based chart. */
export function useMarks(rows, t0) {
  const handoffs = useStore((s) => s.handoffs);
  return useMemo(() => {
    const hs = handoffs.filter((h) => h.start && h.start >= t0 - 1000).map((h) => ({ x: +((h.start - t0) / 1000).toFixed(2), id: h.id }));
    const spans = [];
    let from = null;
    for (const r of rows) {
      if (r.blackout && from === null) from = r.x;
      if (!r.blackout && from !== null) { spans.push([from, r.x]); from = null; }
    }
    if (from !== null && rows.length) spans.push([from, rows[rows.length - 1].x]);
    return { hs, spans };
  }, [rows, t0, handoffs]);
}

export function TimeChart({ title, note, rows, t0, lines, unit, refs = [], height = 200, domainY }) {
  const { hs, spans } = useMarks(rows, t0);
  return (
    <Box title={title} note={note}>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rows} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
          {GRID}
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} allowDecimals={false} {...AXIS} unit=" s" />
          <YAxis {...AXIS} unit={unit} width={unit && unit.length > 2 ? 58 : 46} domain={domainY || [0, 'auto']} />
          <Tooltip {...TIP} />
          <Legend wrapperStyle={{ fontSize: 12, color: '#5f6b7a' }} iconType="circle" iconSize={8} />
          {spans.map(([a, b], i) => <ReferenceArea key={`b${i}`} x1={a} x2={b} fill="#1f2933" fillOpacity={0.09} ifOverflow="hidden" />)}
          {hs.map((h) => <ReferenceLine key={`h${h.id}`} x={h.x} stroke="#8a5a00" strokeDasharray="3 3" />)}
          {refs.map((r) => <ReferenceLine key={r.label} y={r.y} stroke="#b42318" strokeDasharray="5 4" label={{ value: r.label, fill: '#b42318', fontSize: 10, position: 'insideTopRight' }} />)}
          {lines.map(([k, name, c, dash]) => (
            <Line key={k} dataKey={k} name={name} stroke={c} strokeWidth={2} strokeDasharray={dash} dot={false} connectNulls={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}

function Compliance({ q }) {
  const [tab, setTab] = useState('voice');
  const rep = q?.[tab];
  const rows = rep?.verdict?.checks || [];
  const cls = { pass: 'text-good', soft: 'text-warn', hard: 'text-bad', na: 'text-noc-mute' };
  const word = { pass: 'Pass', soft: 'Fail (target)', hard: 'Fail (limit)', na: 'No data' };
  return (
    <Box title="Compliance against the standards" note="Measured over the last window. Pass means inside the objective. Fail (limit) means past the hard limit of the standard." right={
      <div className="seg" role="group" aria-label="Flow">
        {[['voice', 'Voice'], ['video', 'Video'], ['text', 'Chat']].map(([k, l]) => (
          <button key={k} className="!font-sans !text-sm" aria-pressed={tab === k} onClick={() => setTab(k)}>{l}</button>))}
      </div>}>
      <table className="tbl">
        <thead><tr><th>Metric</th><th className="!text-right">Measured</th><th>Target</th><th>Result</th><th>Source</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="align-top">
              <td className="!h-auto py-1.5 !whitespace-normal w-[22%]">{r.label}</td>
              <td className="!h-auto py-1.5 text-right font-mono tabular-nums">{r.measured === null ? '-' : `${r.measured}${r.unit === '%' ? '%' : r.unit ? ` ${r.unit}` : ''}`}</td>
              <td className="!h-auto py-1.5 font-mono text-xs !whitespace-normal">{r.target}</td>
              <td className={`!h-auto py-1.5 font-semibold ${cls[r.status]}`}>{word[r.status]}</td>
              <td className="!h-auto py-1.5 text-2xs text-noc-dim !whitespace-normal leading-4">
                {r.source}{!r.verified && <span className="text-warn font-semibold"> (not from a standard)</span>}</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan="5" className="text-noc-mute">Start the flows from the Controls panel or run a scenario.</td></tr>}
        </tbody>
      </table>
    </Box>
  );
}

function Interruptions({ marks }) {
  const list = marks.filter((m) => m.type === 'interruption' || m.type === 'outage').slice(-10).reverse();
  return (
    <Box title="Interruptions and outages" note="Interruption time is the gap between the last packet before a link change or loss and the first one after it.">
      <table className="tbl tbl-c">
        <thead><tr><th>What</th><th>Flow</th><th>Duration</th><th>From</th><th>To</th><th>Cause</th></tr></thead>
        <tbody>
          {list.map((m) => m.type === 'outage' ? (
            <tr key={m.no}><td>Outage</td><td>all</td><td>{f(m.duration_ms / 1000, 1, ' s')}</td>
              <td colSpan="3" className="!text-left !font-sans">back after: voice {f((m.recover_ms?.voice ?? NaN) / 1000, 1, ' s')}, video {f((m.recover_ms?.video ?? NaN) / 1000, 1, ' s')}, chat {f((m.recover_ms?.text ?? NaN) / 1000, 1, ' s')}</td></tr>
          ) : (
            <tr key={m.no}><td>Interruption</td><td>{m.flow}</td><td>{f(m.ms, 0, ' ms')}</td><td>{m.from_link || '-'}</td><td>{m.to_link || '-'}</td><td>{m.cause}</td></tr>
          ))}
          {!list.length && <tr><td colSpan="6" className="!text-left !font-sans text-noc-mute">None recorded yet.</td></tr>}
        </tbody>
      </table>
    </Box>
  );
}

export default function QualityDrawer() {
  const open = useStore((s) => s.qualityOpen);
  const q = useStore((s) => s.states.MN?.qos);
  const qos = useStore((s) => s.qos);
  const marks = useStore((s) => s.qosMarks);
  const { rows, t0 } = useSeries(qos);
  if (!open) return null;
  const v = q?.voice;
  const vi = q?.video;
  const tx = q?.text;
  return (
    <div className="fixed inset-0 z-40 flex" onClick={() => setState({ qualityOpen: false })}>
      <div className="flex-1 bg-black/20" />
      <aside className="w-[min(1180px,82vw)] h-full bg-noc-bg border-l border-noc-line overflow-y-auto shadow-[-4px_0_12px_rgba(0,0,0,0.12)]" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 z-10 flex items-center gap-3 h-14 px-5 border-b border-noc-line bg-white">
          <h2 className="text-lg font-semibold text-noc-head1">Quality of service</h2>
          <span className="text-xs text-noc-mute font-mono">{qos.length} reports</span>
          <a className="btn ml-auto" href={`${GATEWAY_HTTP}/export/qos.csv`} download><Icon name="download" size={14} />QoS timeline CSV</a>
          <button className="icon-btn btn-ghost" onClick={() => setState({ qualityOpen: false })} aria-label="Close"><Icon name="close" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <FlowCard title="Voice call" rep={v}>
              <Num label="Mouth-to-ear delay" value={f(v?.ta_ms, 0, ' ms')} hint="Network delay + playout buffer + codec delay (G.114)" />
              <Num label="Jitter" value={f(v?.cum?.jitter_ms, 1, ' ms')} hint="RFC 3550 interarrival jitter" />
              <Num label="Loss" value={f(v?.window?.loss_pct, 1, '%')} hint="Network loss plus late packets, last window" />
              <Num label="Quality (MOS)" value={f(v?.mos, 2)} hint="E-model, ITU-T G.107" />
              <Num label="R factor" value={f(v?.r, 0)} />
              <Num label="Playout buffer" value={f(v?.buffer_ms, 0, ' ms')} />
            </FlowCard>
            <FlowCard title="Video" rep={vi}>
              <Num label="Delay incl. buffer" value={f(vi?.playout_ms, 0, ' ms')} />
              <Num label="Jitter" value={f(vi?.cum?.jitter_ms, 1, ' ms')} />
              <Num label="Loss" value={f(vi?.window?.loss_pct, 1, '%')} />
              <Num label="Frames lost" value={vi ? `${vi.frames_lost} of ${vi.frames_total}` : '-'} />
              <Num label="Freezes" value={f(vi?.freezes)} />
              <Num label="Frozen time" value={f((vi?.freeze_ms ?? NaN) / 1000, 1, ' s')} />
            </FlowCard>
            <FlowCard title="Chat" rep={tx}>
              <Num label="Delivered" value={f(tx?.delivered)} />
              <Num label="Last delivery" value={f(tx?.last_delivery_ms, 0, ' ms')} />
              <Num label="Slowest" value={f(tx?.max_delivery_ms, 0, ' ms')} />
              <Num label="Waiting" value={f(tx?.waiting)} hint="Messages that a later one has overtaken" />
              <Num label="Retransmitted" value={f(tx?.retx_delivered)} hint="Messages that only arrived after a retransmission" />
              <Num label="Given up" value={f(tx?.cn_failed)} hint="Reported by the sender" />
            </FlowCard>
          </div>

          <Compliance q={q} />

          <div className="grid grid-cols-2 gap-4">
            <TimeChart title="One-way delay" note="Shaded bands are dead zones. Dashed vertical lines are handoffs." rows={rows} t0={t0} unit=" ms"
              lines={[['voice_delay', 'Voice network delay', SERIES.s1], ['voice_m2e', 'Voice mouth-to-ear', SERIES.s4, '4 3'], ['video_delay', 'Video network delay', SERIES.s2]]}
              refs={[{ y: 150, label: 'G.114 150 ms' }]} />
            <TimeChart title="Jitter (RFC 3550)" rows={rows} t0={t0} unit=" ms" note="Smoothed interarrival jitter. The dashed line is the Y.1541 limit."
              lines={[['voice_jitter', 'Voice', SERIES.s1], ['video_jitter', 'Video', SERIES.s2]]} refs={[{ y: 50, label: 'Y.1541 50 ms' }]} />
          </div>
          <TimeChart title="Voice quality (MOS, E-model)" rows={rows} t0={t0} unit="" height={180} domainY={[1, 4.5]}
            note="G.107 R factor converted to MOS. Below 3.1 many users are dissatisfied."
            lines={[['mos', 'MOS', SERIES.s3]]} refs={[{ y: 3.1, label: 'MOS 3.1' }]} />

          <CoverageSection />
          <ResultsSection />
          <Interruptions marks={marks} />
        </div>
      </aside>
    </div>
  );
}
