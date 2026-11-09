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
    <div className="pt-1 pb-4">
      <div className="relative grid grid-cols-4">
        <div className="absolute left-[12.5%] right-[12.5%] top-[9px] h-0.5 bg-[#d5dbe3]" />
        <div className="absolute left-[12.5%] top-[9px] h-0.5 bg-acc transition-[width] duration-500 ease-out"
          style={{ width: `${(cur / 3) * 75}%` }} />
        {STEPS.map(([k, label], i) => {
          const done = i < cur;
          const on = i === cur;
          return (
            <div key={k} className="relative flex flex-col items-center gap-1.5">
              <span className={`w-5 h-5 rounded-full grid place-items-center border-2 
                ${on ? 'bg-acc border-acc' : done ? 'bg-white border-acc' : 'bg-white border-[#b8bfc8]'}`}>
                {(done || on) && <span className={`w-1.5 h-1.5 rounded-full ${on ? 'bg-white' : 'bg-acc'}`} />}
              </span>
              <span className={`text-xs text-center leading-tight ${on ? 'text-noc-head1 font-semibold' : done ? 'text-noc-ink' : 'text-noc-mute'}`}>{label}</span>
              {on && side && <span className="badge border-warn-line bg-warn-soft text-warn">{side[1]}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function KV({ rows }) {
  return (
    <dl className="grid grid-cols-[160px_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
      {rows.filter(Boolean).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-noc-dim min-h-5 flex items-center">{k}</dt>
          <dd className="text-noc-ink min-h-5 flex items-center min-w-0 overflow-hidden whitespace-nowrap">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

const M = ({ children, className = '' }) => <span className={`font-mono ${className}`}>{children}</span>;
const ENCAP = { ipip: 'IP-in-IP', minimal: 'Minimal', gre: 'GRE' };

/** Sub-header for one table inside the Binding tables section. */
function TableHead({ title, right, first = false }) {
  return (
    <div className={`flex items-center gap-2 mb-2 ${first ? '' : 'mt-5'}`}>
      <span className="sub-label">{title}</span>
      <span className="ml-auto flex items-center gap-2 text-xs text-noc-dim">{right}</span>
    </div>
  );
}

const Note = ({ children, tone = 'text-noc-dim' }) => <div className={`text-xs ${tone} mt-2`}>{children}</div>;

function FaTable({ name, fa, now }) {
  const v = fa?.visitors || [];
  return (
    <div>
      <TableHead title={`${name} visitor list`} right={<>{fa?.label && <span>{fa.label}</span>}<M>adv seq {fa?.seq ?? '-'}</M></>} />
      {v.length ? (
        <div className="overflow-x-auto"><table className="tbl">
          <thead><tr><th>Home</th><th>HA</th><th>Encap</th><th className="w-[120px]">Lifetime</th></tr></thead>
          <tbody>
            {v.map((x) => (
              <tr key={x.home}>
                <td><M>{x.home}</M>{!x.reachable && <span className="ml-1 text-warn text-xs">left cell</span>}</td>
                <td><M className="text-noc-dim">{x.ha}</M></td>
                <td className="text-noc-dim">{ENCAP[x.encap] || x.encap}{x.reverse ? ', T' : ''}</td>
                <td><LifeBar expiresAt={x.expires_at} lifetime={x.lifetime} now={now} /></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <Empty>no visitors</Empty>}
      {fa?.pending?.length ? <Note tone="text-warn">{fa.pending.length} pending request{fa.pending.length > 1 ? 's' : ''}</Note> : null}
      {fa?.forward?.map((f) => (
        <div key={f.home} className="grid grid-cols-[1fr_auto] gap-2 items-center text-xs text-noc-dim mt-2">
          <span>Smooth forwarding <M>{f.home}</M> to <M>{f.coa}</M></span>
          <LifeBar expiresAt={f.expires_at} lifetime={f.lifetime} now={now} />
        </div>
      ))}
      {fa?.buffered ? <Note>{fa.buffered} packet{fa.buffered > 1 ? 's' : ''} buffered</Note> : null}
      {fa?.last_denial && now - fa.last_denial.ts < 30000 && <Note tone="text-warn">Denied: {fa.last_denial.text}</Note>}
    </div>
  );
}

export default function AgentPanel() {
  const s = useStore((x) => x.states);
  const topology = useStore((x) => x.topology);
  const features = useStore((x) => x.features);
  const now = useNow();
  const mn = s.MN;
  const ha = s.HA;
  const cn = s.CN;
  const router = s.ROUTER;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-head">
        <span className="panel-title">Agent state</span>
        {mn && <span className="ml-auto font-mono text-xs text-noc-dim">{mn.state}</span>}
      </div>
      <div className="flex-1 overflow-y-auto">
        <Section title="Mobile node" right={mn ? <M>{mn.home}</M> : null}>
          <Stepper state={mn?.state} />
          {mn ? (
            <KV rows={[
              ['Link', mn.link_label],
              ['Agent', mn.current_node || '-'],
              ['Care-of address', mn.binding?.coa ? <M>{mn.binding.coa}{mn.binding.ccoa ? ' (co-located)' : ''}</M> : <span className="text-noc-mute">none</span>],
              ['Registration', mn.binding ? <LifeBar expiresAt={mn.binding.expires_at} lifetime={mn.binding.lifetime} now={now} />
                : mn.pending ? <span className="text-warn">pending, attempt {mn.pending.attempts}</span> : <span className="text-noc-mute">none</span>],
              ['Detection', <span>{mn.algorithm === 'lifetime' ? 'Advertisement lifetime' : 'Network prefix'}, <span className="text-noc-dim">{mn.replay}</span></span>],
              ['Stream', <M>{mn.stats.rx} rx  {mn.stats.lost_total} lost  {mn.stats.last_latency_ms ?? '-'} ms</M>],
              mn.last_handoff && ['Last handoff', <M>{mn.last_handoff.detection_ms} + {mn.last_handoff.registration_ms} = <span className="text-acc">{mn.last_handoff.total_ms} ms</span></M>],
            ]} />
          ) : <Empty>waiting for the mobile node</Empty>}
        </Section>

        <Section title="Binding tables">
          <TableHead first title="Home agent mobility bindings" right={ha ? <M>seq {ha.seq}</M> : null} />
          {ha?.bindings?.length ? (
            <div className="overflow-x-auto"><table className="tbl">
              <thead><tr><th>Home</th><th>Care-of</th><th>Encap</th><th className="w-[120px]">Lifetime</th></tr></thead>
              <tbody>
                {ha.bindings.map((b) => (
                  <tr key={b.coa} title={`identification ${b.ident}, via ${b.via}`}>
                    <td><M>{b.home}</M></td>
                    <td><M>{b.coa}</M>{b.reverse ? <span className="ml-1 text-xs text-[#c45f12]">T</span> : ''}</td>
                    <td className="text-noc-dim">{ENCAP[b.encap] || b.encap}</td>
                    <td><LifeBar expiresAt={b.expires_at} lifetime={b.lifetime} now={now} /></td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          ) : <Empty>no bindings</Empty>}
          {ha?.last_reg && (
            <div className="flex items-center gap-2 text-xs mt-2">
              <span className={`w-2 h-2 rounded-full shrink-0 ${ha.last_reg.code <= 1 ? 'bg-[#2f9e44]' : 'bg-[#c98500]'}`} />
              <span className="text-noc-dim truncate">Last reply: {ha.last_reg.text}</span>
            </div>
          )}
          {ha?.proxy_arp?.length ? <Note>Proxy ARP for <M>{ha.proxy_arp.join(', ')}</M></Note> : null}
          {['FA-1', 'FA-2', 'FA-3'].map((n) => <FaTable key={n} name={n} fa={s[n]} now={now} />)}
        </Section>

        <Section title="Correspondent node" right={cn ? <M>{cn.ip}</M> : null}>
          <TableHead first title="Binding cache" />
          {cn?.cache?.length ? (
            <div className="overflow-x-auto"><table className="tbl">
              <thead><tr><th>Home</th><th>Care-of</th><th className="w-[120px]">Lifetime</th></tr></thead>
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
          {cn && <div className="mt-4"><KV rows={[
              ['Stream', cn.streaming ? <span className="text-acc">{cn.rate} pkt/s</span> : <span className="text-noc-mute">off</span>],
              ['Sent', <M>{cn.stats.sent} <span className="text-noc-mute">({cn.stats.sent_direct} direct)</span></M>],
              ['Replies, RTT', <M>{cn.stats.replies}, {cn.stats.rtt_avg_ms ?? '-'} ms</M>],
            ]} /></div>}
        </Section>

        <Section title="Core router" right={router ? <M>10.0.0.1</M> : null}>
          {router ? (
            <KV rows={[
              ['Forwarded', <M>{router.counters.forwarded}</M>],
              ['Dropped', <M className={router.counters.dropped ? 'text-bad' : ''}>{router.counters.dropped}</M>],
              ['Backbone delay', <M>{router.backbone?.delay_ms ?? '-'} ms</M>],
              ['Ingress filtering', features.ingress_filtering ? <span className="text-warn">on</span> : <span className="text-noc-mute">off</span>],
            ]} />
          ) : <Empty>waiting for the router</Empty>}
        </Section>
        {!topology && <div className="p-4 text-sm text-noc-mute">Waiting for the gateway</div>}
      </div>
    </div>
  );
}
