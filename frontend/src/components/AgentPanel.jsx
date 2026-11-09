// Right panel: live agent state. Lifetimes count down client-side from expires_at, which
// the agents send in wall-clock milliseconds (same machine, same clock).
import React from 'react';
import { useStore } from '../lib/store.js';
import { Empty, LifeBar, Section, useNow } from './ui.jsx';

const STEPS = [['AT_HOME', 'At home'], ['DISCOVERING', 'Discovering'], ['REGISTERING', 'Registering'], ['REGISTERED_AWAY', 'Registered away']];
// the two side states are shown as a badge on the step they belong to
const SIDE = { RENEWING: [3, 'Renewing'], DEREGISTERING: [2, 'Deregistering'] };

function Stepper({ state }) {
  const side = SIDE[state];
  const cur = side ? side[0] : Math.max(0, STEPS.findIndex(([k]) => k === state));
  return (
    <div className="pt-1 pb-2">
      <div className="relative grid grid-cols-4">
        <div className="absolute left-[12.5%] right-[12.5%] top-[9px] h-0.5 bg-[#243042]" />
        <div className="absolute left-[12.5%] top-[9px] h-0.5 bg-sky-500/60 transition-[width] duration-500 ease-out"
          style={{ width: `${(cur / 3) * 75}%` }} />
        {STEPS.map(([k, label], i) => {
          const done = i < cur;
          const on = i === cur;
          return (
            <div key={k} className="relative flex flex-col items-center gap-1.5">
              <span className={`w-5 h-5 rounded-full grid place-items-center border-2 transition-all duration-300
                ${on ? 'bg-sky-500 border-sky-300 shadow-[0_0_10px_#38bdf8]' : done ? 'bg-[#1e3a52] border-sky-700' : 'bg-noc-panel border-[#334155]'}`}>
                {done && <span className="w-1.5 h-1.5 rounded-full bg-sky-300/70" />}
              </span>
              <span className={`text-2xs text-center leading-tight transition-colors ${on ? 'text-sky-200 font-semibold' : done ? 'text-noc-mute' : 'text-noc-mute/70'}`}>{label}</span>
              {on && side && <span className="badge border-amber-500/40 bg-amber-500/10 text-amber-300 h-4 px-1 fade-in">{side[1]}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KV({ rows }) {
  return (
    <dl className="grid grid-cols-[minmax(84px,112px)_minmax(0,1fr)] gap-x-3 text-xs">
      {rows.filter(Boolean).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-noc-mute h-6 flex items-center">{k}</dt>
          <dd className="text-noc-ink h-6 flex items-center min-w-0 overflow-hidden whitespace-nowrap">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

const M = ({ children, className = '' }) => <span className={`font-mono ${className}`}>{children}</span>;
const ENCAP = { ipip: 'IP-in-IP', minimal: 'Minimal', gre: 'GRE' };

function FaCard({ name, fa, now }) {
  const v = fa?.visitors || [];
  const right = (
    <>
      {fa?.label && <span className="text-noc-dim normal-case">{fa.label}</span>}
      <span className={`badge h-4 px-1 ${v.length ? 'border-sky-500/40 bg-sky-500/10 text-sky-300' : 'border-noc-edge text-noc-mute'}`}>{v.length}</span>
    </>
  );
  return (
    <Section title={name} right={right}>
      {v.length ? (
        <div className="overflow-x-auto -mx-1 px-1"><table className="tbl">
          <thead><tr><th>Home</th><th>HA</th><th>Encap</th><th className="w-[110px]">Lifetime</th></tr></thead>
          <tbody>
            {v.map((x) => (
              <tr key={x.home}>
                <td><M>{x.home}</M>{!x.reachable && <span className="ml-1 text-amber-300 text-2xs">left cell</span>}</td>
                <td><M className="text-noc-dim">{x.ha}</M></td>
                <td className="text-noc-dim">{ENCAP[x.encap] || x.encap}{x.reverse ? ', T' : ''}</td>
                <td><LifeBar expiresAt={x.expires_at} lifetime={x.lifetime} now={now} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <Empty>no visitors</Empty>}
      {fa?.pending?.length ? <div className="text-2xs text-amber-300 mt-1.5">{fa.pending.length} pending request{fa.pending.length > 1 ? 's' : ''}</div> : null}
      {fa?.forward?.map((f) => (
        <div key={f.home} className="grid grid-cols-[1fr_auto] gap-2 items-center text-2xs text-noc-dim mt-1.5">
          <span>Smooth forwarding <M>{f.home}</M> to <M>{f.coa}</M></span>
          <LifeBar expiresAt={f.expires_at} lifetime={f.lifetime} now={now} />
        </div>
      ))}
      {fa?.buffered ? <div className="text-2xs text-noc-dim mt-1">{fa.buffered} packet{fa.buffered > 1 ? 's' : ''} buffered</div> : null}
      {fa?.last_denial && now - fa.last_denial.ts < 30000 && <div className="text-2xs text-amber-300 mt-1">Denied: {fa.last_denial.text}</div>}
      <div className="flex justify-between text-2xs text-noc-mute mt-1.5"><span>advertisement seq</span><M>{fa?.seq ?? '-'}</M></div>
    </Section>
  );
}

export default function AgentPanel() {
  const s = useStore((x) => x.states);
  const topology = useStore((x) => x.topology);
  const now = useNow();
  const mn = s.MN;
  const ha = s.HA;
  const cn = s.CN;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-head">
        <span className="panel-title">Agent state</span>
        {mn && <span className="ml-auto font-mono text-2xs text-noc-mute">{mn.state}</span>}
      </div>
      <div className="flex-1 overflow-y-auto">
        <Section title="Mobile node" right={mn ? <M className="text-noc-dim">{mn.home}</M> : null}>
          <Stepper state={mn?.state} />
          {mn ? (
            <KV rows={[
              ['Link', mn.link_label],
              ['Agent', mn.current_node || '-'],
              ['Care-of address', mn.binding?.coa ? <M>{mn.binding.coa}{mn.binding.ccoa ? ' (co-located)' : ''}</M> : <span className="text-noc-mute">none</span>],
              ['Registration', mn.binding ? <LifeBar expiresAt={mn.binding.expires_at} lifetime={mn.binding.lifetime} now={now} />
                : mn.pending ? <span className="text-amber-300">pending, attempt {mn.pending.attempts}</span> : <span className="text-noc-mute">none</span>],
              ['Detection', <span>{mn.algorithm === 'lifetime' ? 'Advertisement lifetime' : 'Network prefix'}, <span className="text-noc-dim">{mn.replay}</span></span>],
              ['Stream', <M>{mn.stats.rx} rx  {mn.stats.lost_total} lost  {mn.stats.last_latency_ms ?? '-'} ms</M>],
              mn.last_handoff && ['Last handoff', <M>{mn.last_handoff.detection_ms} + {mn.last_handoff.registration_ms} = <span className="text-sky-300">{mn.last_handoff.total_ms} ms</span></M>],
            ]} />
          ) : <Empty>waiting for the mobile node</Empty>}
        </Section>

        <Section title="Home agent bindings" right={ha ? <M className="text-noc-dim">seq {ha.seq}</M> : null}>
          {ha?.bindings?.length ? (
            <div className="overflow-x-auto -mx-1 px-1"><table className="tbl">
              <thead><tr><th>Home</th><th>Care-of</th><th>Encap</th><th className="w-[110px]">Lifetime</th></tr></thead>
              <tbody>
                {ha.bindings.map((b) => (
                  <tr key={b.coa} title={`identification ${b.ident}, via ${b.via}`}>
                    <td><M>{b.home}</M></td>
                    <td><M>{b.coa}</M>{b.reverse ? <span className="ml-1 text-2xs text-orange-300">T</span> : ''}</td>
                    <td className="text-noc-dim">{ENCAP[b.encap] || b.encap}</td>
                    <td><LifeBar expiresAt={b.expires_at} lifetime={b.lifetime} now={now} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <Empty>no bindings</Empty>}
          {ha?.last_reg && (
            <div className="flex items-center gap-2 text-2xs mt-2">
              <span className={`w-1.5 h-1.5 rounded-full ${ha.last_reg.code <= 1 ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              <span className="text-noc-dim truncate">Last reply: {ha.last_reg.text}</span>
            </div>
          )}
          {ha?.proxy_arp?.length ? <div className="text-2xs text-noc-mute mt-1">Proxy ARP for <M>{ha.proxy_arp.join(', ')}</M></div> : null}
        </Section>

        {['FA-1', 'FA-2', 'FA-3'].map((n) => <FaCard key={n} name={n} fa={s[n]} now={now} />)}

        <Section title="Correspondent cache" right={cn ? <M className="text-noc-dim">{cn.ip}</M> : null}>
          {cn?.cache?.length ? (
            <div className="overflow-x-auto -mx-1 px-1"><table className="tbl">
              <thead><tr><th>Home</th><th>Care-of</th><th className="w-[110px]">Lifetime</th></tr></thead>
              <tbody>
                {cn.cache.map((e) => (
                  <tr key={e.home}>
                    <td><M>{e.home}</M></td><td><M>{e.coa}</M></td>
                    <td><LifeBar expiresAt={e.expires_at} lifetime={e.lifetime} now={now} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <Empty>{cn?.route_optimization ? 'empty, waiting for a Binding Update' : 'empty, route optimization is off'}</Empty>}
          {cn && (
            <KV rows={[
              ['Stream', cn.streaming ? <span className="text-sky-300">{cn.rate} pkt/s</span> : <span className="text-noc-mute">off</span>],
              ['Sent', <M>{cn.stats.sent} <span className="text-noc-mute">({cn.stats.sent_direct} direct)</span></M>],
              ['Replies, RTT', <M>{cn.stats.replies}, {cn.stats.rtt_avg_ms ?? '-'} ms</M>],
            ]} />
          )}
        </Section>
        {!topology && <div className="p-3 text-xs text-noc-mute">Waiting for the gateway</div>}
      </div>
    </div>
  );
}
