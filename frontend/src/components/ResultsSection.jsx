// Side by side result of the Metro ride: the same ride with the rescue features off and all
// on. These are the numbers for the report. Every cell comes from the mobile node's own
// end-of-run summary (qos_run). Nothing is computed here except the highlight of the better one.
import React from 'react';
import { useStore } from '../lib/store.js';
import { send } from '../lib/ws.js';
import { downloadCsv } from '../lib/util.js';
import { Pill } from './QualityDrawer.jsx';

const TITLE = { off: 'Features off', on: 'All features on', current: 'Your switches' };
const ORDER = ['off', 'on', 'current'];
const n = (v, d = 1, u = '') => (v === null || v === undefined ? '-' : `${Number(v).toFixed(d)}${u}`);

const ROWS = [
  ['Video', null],
  ['Frames lost', (r) => `${r.video.frames_lost} of ${r.video.frames_total} (${n(r.video.frames_lost_pct, 1, '%')})`, (r) => r.video.frames_lost_pct, 'min'],
  ['Picture frozen, total', (r) => `${n(r.video.freeze_s, 1, ' s')} in ${r.video.freezes} freezes`, (r) => r.video.freeze_s, 'min'],
  ['Longest freeze', (r) => n(r.video.longest_freeze_s, 1, ' s'), (r) => r.video.longest_freeze_s, 'min'],
  ['Voice call', null],
  ['Worst MOS in the whole ride', (r) => n(r.voice.worst_mos, 2), (r) => r.voice.worst_mos, 'max'],
  ['Worst MOS outside the tunnel', (r) => n(r.voice.worst_mos_clear, 2), (r) => r.voice.worst_mos_clear, 'max'],
  ['Time with MOS below 3.1', (r) => n(r.voice.poor_s, 1, ' s'), (r) => r.voice.poor_s, 'min'],
  ['Packet loss, incl. late', (r) => n(r.voice.loss_pct, 2, '%'), (r) => r.voice.loss_pct, 'min'],
  ['Interruptions (count, total)', (r) => `${r.voice.interruptions}, ${n(r.voice.interruption_ms / 1000, 1, ' s')}`, (r) => r.voice.interruption_ms, 'min'],
  ['Chat', null],
  ['Messages lost', (r) => `${r.text.lost} of ${r.text.sent}`, (r) => r.text.lost, 'min'],
  ['Slowest delivery', (r) => n(r.text.max_delivery_s, 1, ' s'), (r) => r.text.max_delivery_s, 'min'],
  ['Mean delivery', (r) => n(r.text.mean_delivery_s, 2, ' s'), (r) => r.text.mean_delivery_s, 'min'],
  ['Whole ride', null],
  ['Time to recover after the tunnel', (r) => n(r.recover_s, 1, ' s'), (r) => r.recover_s, 'min'],
  ['Handoffs', (r) => String(r.handoffs), (r) => r.handoffs, 'min'],
];

export default function ResultsSection() {
  const runs = useStore((s) => s.runs);
  const sc = useStore((s) => s.scenario);
  const rs = ORDER.filter((k) => runs[k]).map((k) => ({ k, r: runs[k] }));
  const csv = () => downloadCsv('metro-ride-results.csv', ROWS.filter((x) => x[1]).map(([label, f]) => Object.fromEntries([['metric', label], ...rs.map(({ k, r }) => [TITLE[k], f(r)])])));
  const best = (get, dir) => {
    if (rs.length < 2 || !get) return null;
    const v = rs.map(({ r }) => get(r)).filter((x) => x !== null && x !== undefined);
    if (v.length < 2 || Math.min(...v) === Math.max(...v)) return null;
    return dir === 'min' ? Math.min(...v) : Math.max(...v);
  };
  return (
    <section className="panel p-4">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold text-noc-head1">Metro ride result</h3>
        {sc?.id?.includes('metro') && <span className="text-xs text-acc">a ride is running, the result appears when it ends</span>}
        <span className="ml-auto flex gap-2">
          <button className="btn" onClick={csv} disabled={!rs.length}>Results CSV</button>
          <button className="btn" onClick={() => send({ type: 'clear_runs' })} disabled={!rs.length}>Clear</button>
        </span>
      </div>
      <p className="text-2xs text-noc-mute mt-0.5 mb-3">The same route, the same signal at every position, the same traffic. Only the switches differ.
        Green marks the better value of a row.</p>
      {!rs.length ? (
        <p className="text-sm text-noc-dim">No finished ride yet. Use Compare: off then on in the coverage section. It takes about 3.5 minutes.</p>
      ) : (
        <table className="tbl tbl-c">
          <thead><tr><th>Measure</th>{rs.map(({ k }) => <th key={k}>{TITLE[k]}</th>)}</tr></thead>
          <tbody>
            {ROWS.map(([label, fmt, get, dir]) => (fmt ? (
              <tr key={label}>
                <td>{label}</td>
                {rs.map(({ k, r }) => {
                  const b = best(get, dir);
                  const mine = get(r);
                  return <td key={k} className={b !== null && mine === b ? '!text-good font-semibold' : ''}>{fmt(r)}</td>;
                })}
              </tr>
            ) : (
              <tr key={label}><td colSpan={rs.length + 1} className="!text-left !font-sans text-xs font-semibold text-noc-dim bg-noc-raised">{label}</td></tr>
            )))}
            <tr>
              <td className="!font-sans">Quality verdicts</td>
              {rs.map(({ k, r }) => (
                <td key={k} className="!font-sans !text-left !h-auto py-2 align-top">
                  {[['Voice', r.voice], ['Video', r.video], ['Chat', r.text]].map(([nm, x]) => (
                    <div key={nm} className="flex items-start gap-2 mb-1">
                      <span className="w-10 text-xs text-noc-dim pt-0.5">{nm}</span><Pill level={x.verdict} />
                      <span className="text-2xs text-noc-dim whitespace-normal leading-4 max-w-[220px]">{x.reason}</span>
                    </div>
                  ))}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      )}
    </section>
  );
}
