// Right panel: live agent state. Lifetimes count down client-side from expires_at, which
// the agents send in wall-clock milliseconds (same machine, same clock).
import React, { useEffect, useState } from 'react';
import { useStore } from '../lib/store.js';

function useNow(ms = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Countdown({ expiresAt, lifetime, now }) {
  const left = Math.max(0, (expiresAt - now) / 1000);
  const frac = lifetime ? Math.min(1, left / lifetime) : 0;
  const color = frac > 0.5 ? 'bg-emerald-500' : frac > 0.2 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5 min-w-[90px]">
      <div className="flex-1 h-1.5 bg-slate-700 rounded"><div className={`h-1.5 rounded ${color}`} style={{ width: `${frac * 100}%` }} /></div>
      <span className="mono text-[11px] w-9 text-right tabular-nums">{left.toFixed(1)}s</span>
    </div>
  );
}

const STATES = [
  ['AT_HOME', 0, 0], ['DISCOVERING', 1, 0], ['REGISTERING', 2, 0],
  ['DEREGISTERING', 0, 1], ['RENEWING', 1, 1], ['REGISTERED_AWAY', 2, 1],
];
const ARROWS = [
  ['AT_HOME', 'DISCOVERING', 'link change'], ['DISCOVERING', 'REGISTERING', 'agent found'],
  ['REGISTERING', 'REGISTERED_AWAY', 'reply 0'], ['REGISTERED_AWAY', 'RENEWING', ''], ['RENEWING', 'REGISTERED_AWAY', ''],
  ['REGISTERED_AWAY', 'DISCOVERING', 'moved'], ['DISCOVERING', 'DEREGISTERING', 'home'], ['DEREGISTERING', 'AT_HOME', ''],
];
const BW = 96;
const BH = 24;
const cell = (c, r) => [6 + c * 108, 10 + r * 64];

function StateMachine({ state }) {
  const at = Object.fromEntries(STATES.map(([n, c, r]) => [n, cell(c, r)]));
  const centre = (n) => [at[n][0] + BW / 2, at[n][1] + BH / 2];
  return (
    <svg viewBox="0 0 330 100" className="w-full">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#64748b" />
        </marker>
      </defs>
      {ARROWS.map(([a, b, label], i) => {
        const [x1, y1] = centre(a);
        const [x2, y2] = centre(b);
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        const ox = (dx / len) * (Math.abs(dx) > Math.abs(dy) ? BW / 2 + 2 : BH / 2 + 2);
        const oy = (dy / len) * (Math.abs(dx) > Math.abs(dy) ? BW / 2 + 2 : BH / 2 + 2);
        const bend = a === 'RENEWING' ? 8 : a === 'REGISTERED_AWAY' && b === 'RENEWING' ? -8 : 0;
        return (
          <g key={i}>
            <line x1={x1 + ox} y1={y1 + oy + bend} x2={x2 - ox} y2={y2 - oy + bend} stroke="#64748b" strokeWidth="1.2" markerEnd="url(#arr)" />
            {label && <text x={(x1 + x2) / 2 + 2} y={(y1 + y2) / 2 - 3} fill="#64748b" fontSize="8">{label}</text>}
          </g>
        );
      })}
      {STATES.map(([n]) => {
        const [x, y] = at[n];
        const on = state === n;
        return (
          <g key={n}>
            <rect x={x} y={y} width={BW} height={BH} rx="5" fill={on ? '#0369a1' : '#1e293b'} stroke={on ? '#7dd3fc' : '#334155'} strokeWidth={on ? 2 : 1} />
            <text x={x + BW / 2} y={y + 15.5} textAnchor="middle" fontSize="9" fontWeight={on ? 700 : 500} fill={on ? '#fff' : '#94a3b8'}>{n}</text>
          </g>
        );
      })}
    </svg>
  );
}

function Card({ title, right, children }) {
  return (
    <div className="border-b border-noc-line px-3 py-2">
      <div className="flex items-center text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">{title}<span className="ml-auto normal-case tracking-normal font-normal">{right}</span></div>
      {children}
    </div>
  );
}

const Empty = ({ children }) => <div className="text-[11px] text-slate-500">{children}</div>;

export default function AgentPanel() {
  const s = useStore((x) => x.states);
  const topology = useStore((x) => x.topology);
  const now = useNow();
  const mn = s.MN;
  const ha = s.HA;
  const cn = s.CN;

  return (
    <div className="panel h-full overflow-y-auto">
      <div className="panel-title">Agent state</div>

      <Card title="Mobile node" right={mn ? <span className="mono text-sky-300">{mn.home}</span> : null}>
        <StateMachine state={mn?.state} />
        {mn && (
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs mt-1">
            <span className="kv">Link</span><span>{mn.link_label}</span>
            <span className="kv">Agent</span><span>{mn.current_node || '-'}</span>
            <span className="kv">Care-of address</span><span className="mono">{mn.binding?.coa || '-'}{mn.binding?.ccoa ? ' (co-located)' : ''}</span>
            <span className="kv">Registration</span>
            <span>{mn.binding ? <Countdown expiresAt={mn.binding.expires_at} lifetime={mn.binding.lifetime} now={now} /> : (mn.pending ? `pending, attempt ${mn.pending.attempts}` : '-')}</span>
            <span className="kv">Detection</span><span>{mn.algorithm} rule, replay: {mn.replay}</span>
            <span className="kv">Stream</span><span className="mono">{mn.stats.rx} rx, {mn.stats.lost_total} lost, {mn.stats.last_latency_ms ?? '-'} ms</span>
            {mn.last_handoff && (<><span className="kv">Last handoff</span>
              <span className="mono">{mn.last_handoff.detection_ms} + {mn.last_handoff.registration_ms} = {mn.last_handoff.total_ms} ms</span></>)}
          </div>
        )}
      </Card>

      <Card title="Home agent bindings" right={ha ? <span className="mono">{ha.ip} seq {ha.seq}</span> : null}>
        {ha?.bindings?.length ? (
          <table className="w-full text-xs">
            <thead className="text-slate-500 text-[10px] uppercase"><tr><th className="text-left">Home</th><th className="text-left">CoA</th><th className="text-left">Encap</th><th>Lifetime</th></tr></thead>
            <tbody>
              {ha.bindings.map((b) => (
                <tr key={b.coa} title={`identification ${b.ident}, via ${b.via}`}>
                  <td className="mono">{b.home}</td>
                  <td className="mono">{b.coa}{b.reverse ? <span className="text-orange-400"> T</span> : ''}</td>
                  <td>{b.encap}</td>
                  <td><Countdown expiresAt={b.expires_at} lifetime={b.lifetime} now={now} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No mobility bindings (MN at home or not registered).</Empty>}
        {ha?.last_reg && <div className={`text-[11px] mt-1 ${ha.last_reg.code <= 1 ? 'text-emerald-400' : 'text-red-400'}`}>last: {ha.last_reg.text}</div>}
        {ha?.proxy_arp?.length ? <div className="text-[11px] text-slate-400">proxy ARP for {ha.proxy_arp.join(', ')}</div> : null}
      </Card>

      {['FA-1', 'FA-2', 'FA-3'].map((n) => {
        const fa = s[n];
        return (
          <Card key={n} title={`${n} visitor list`} right={fa ? <span className="mono">{fa.label}, seq {fa.seq}</span> : null}>
            {fa?.visitors?.length ? fa.visitors.map((v) => (
              <div key={v.home} className="grid grid-cols-[1fr_auto] gap-2 text-xs items-center">
                <span><span className="mono">{v.home}</span> <span className="text-slate-500">HA {v.ha} {v.encap}{v.reverse ? ' T' : ''}</span>
                  {!v.reachable && <span className="text-red-400"> left cell</span>}</span>
                <Countdown expiresAt={v.expires_at} lifetime={v.lifetime} now={now} />
              </div>
            )) : <Empty>No visitors.</Empty>}
            {fa?.pending?.length ? <div className="text-[11px] text-amber-300">{fa.pending.length} pending request(s)</div> : null}
            {fa?.forward?.map((f) => (
              <div key={f.home} className="text-[11px] text-yellow-300 grid grid-cols-[1fr_auto] gap-2 items-center">
                <span>smooth: forwarding {f.home} to {f.coa}</span>
                <Countdown expiresAt={f.expires_at} lifetime={f.lifetime} now={now} />
              </div>
            ))}
            {fa?.buffered ? <div className="text-[11px] text-yellow-300">{fa.buffered} packet(s) buffered</div> : null}
            {fa?.last_denial && now - fa.last_denial.ts < 30000 && <div className="text-[11px] text-red-400">denied: {fa.last_denial.text}</div>}
          </Card>
        );
      })}

      <Card title="Correspondent binding cache" right={cn ? <span className="mono">{cn.ip}</span> : null}>
        {cn?.cache?.length ? cn.cache.map((e) => (
          <div key={e.home} className="grid grid-cols-[1fr_auto] gap-2 text-xs items-center">
            <span><span className="mono">{e.home}</span> {'->'} <span className="mono">{e.coa}</span> <span className="text-slate-500">{e.encap}</span></span>
            <Countdown expiresAt={e.expires_at} lifetime={e.lifetime} now={now} />
          </div>
        )) : <Empty>{cn?.route_optimization ? 'Empty: waiting for a Binding Update.' : 'Empty: route optimization is off.'}</Empty>}
        {cn && (
          <div className="text-xs mono mt-1 text-slate-300">
            stream {cn.streaming ? `on, ${cn.rate} pkt/s` : 'off'}: sent {cn.stats.sent} ({cn.stats.sent_direct} direct), replies {cn.stats.replies}, RTT {cn.stats.rtt_avg_ms ?? '-'} ms
          </div>
        )}
      </Card>
      {!topology && <div className="p-3 text-xs text-slate-500">Waiting for the gateway...</div>}
    </div>
  );
}
