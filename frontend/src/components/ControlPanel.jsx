// Left panel: every knob of the simulation, in collapsible groups. Feature switches go to
// all agents through the gateway, link settings to the core router, demos and handoffs
// to the mobile node.
import React, { useEffect, useState } from 'react';
import { useStore } from '../lib/store.js';
import { command, setFeature } from '../lib/ws.js';
import { Section, Switch } from './ui.jsx';

const MOVES = [['home', 'Home', 'HA'], ['fa1', 'Campus Wi-Fi', 'FA-1'], ['fa2', 'Metro LTE', 'FA-2'], ['fa3', 'Airport', 'FA-3']];

const TOGGLES = [
  ['route_optimization', 'Route optimization', 'HA sends Binding Updates, CN tunnels straight to the CoA'],
  ['smooth_handoff', 'Smooth handoff', 'Previous FA buffers and forwards in-flight packets'],
  ['reverse_tunneling', 'Reverse tunneling (T)', 'MN traffic goes back through the HA (RFC 3024)'],
  ['ingress_filtering', 'Ingress filtering', 'Backbone drops topologically wrong source addresses'],
  ['simultaneous_bindings', 'Simultaneous bindings (S)', 'HA tunnels a copy to every registered CoA'],
  ['colocated_coa', 'Co-located CoA', 'MN takes a .100 address and decapsulates itself'],
];

/** Range input that only sends when the user lets go, so a drag is one command. */
function Slider({ label, value, min, max, step, unit, onCommit }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="block mb-3 last:mb-0">
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-sm text-noc-ink">{label}</span>
        <span className="font-mono text-xs text-noc-ink tabular-nums">{v}<span className="text-noc-mute">{unit}</span></span>
      </div>
      <input type="range" className="w-full accent-[#2457a6] cursor-pointer" min={min} max={max} step={step} value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => onCommit(v)} onKeyUp={() => onCommit(v)} />
    </label>
  );
}

function Field({ label, children }) {
  return (
    <label className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-2 mb-3 last:mb-0">
      <span className="text-sm text-noc-ink">{label}</span>
      {children}
    </label>
  );
}

export default function ControlPanel() {
  const f = useStore((s) => s.features);
  const mn = useStore((s) => s.states.MN);
  const router = useStore((s) => s.states.ROUTER);
  const cn = useStore((s) => s.states.CN);
  const topology = useStore((s) => s.topology);
  const [linkSel, setLinkSel] = useState('backbone');
  const [fa, setFa] = useState('FA-2');
  const [life, setLife] = useState('');

  const linkCfg = linkSel === 'backbone' ? router?.backbone : router?.links?.[linkSel];
  const links = router ? [['backbone', 'Backbone'], ...Object.entries(router.links).map(([k, l]) => [k, l.label])] : [];
  const here = router?.attach?.MN || mn?.link;

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-head"><span className="panel-title">Controls</span></div>
      <div className="flex-1 overflow-y-auto">
        <Section title="Mobility">
          <div className="grid grid-cols-2 gap-3">
            {MOVES.map(([link, label, agent]) => {
              const on = here === link;
              return (
                <button key={link} onClick={() => command('MN', 'handoff', { link })}
                  className={`h-14 min-w-0 rounded-[3px] border text-left px-3
                    ${on ? 'border-acc bg-acc-soft' : 'border-noc-edge bg-white hover:bg-[#eef1f5]'}`}>
                  <span className={`block truncate text-sm font-medium ${on ? 'text-acc font-semibold' : 'text-noc-ink'}`}>{label}</span>
                  <span className="block truncate font-mono text-xs text-noc-dim">
                    {agent} {topology?.links?.[link]?.prefix || ''}
                  </span>
                </button>
              );
            })}
          </div>
          <button className="btn w-full mt-3" onClick={() => command('MN', 'reregister')}>Re-register now</button>
        </Section>

        <Section title="Protocol options">
          <div className="grid gap-3">
            {TOGGLES.map(([key, label, hint]) => (
              <Switch small key={key} checked={!!f[key]} onChange={(v) => setFeature({ [key]: v })} label={label} hint={hint} />
            ))}
          </div>
        </Section>

        <Section title="Tunnel and detection">
          <Field label="Encapsulation">
            <select className="sel" value={f.encapsulation || 'ipip'} onChange={(e) => setFeature({ encapsulation: e.target.value })}>
              <option value="ipip">IP-in-IP (RFC 2003)</option>
              <option value="minimal">Minimal (RFC 2004)</option>
              <option value="gre">GRE (RFC 2784)</option>
            </select>
          </Field>
          <Field label="Movement rule">
            <select className="sel" value={f.movement_detection || 'prefix'} onChange={(e) => setFeature({ movement_detection: e.target.value })}>
              <option value="prefix">Network prefix</option>
              <option value="lifetime">Advertisement lifetime</option>
            </select>
          </Field>
          <div className="mt-4">
            <Slider label="Advertisement interval" value={f.adv_interval_ms || 1000} min={250} max={5000} step={250} unit=" ms"
              onCommit={(v) => setFeature({ adv_interval_ms: v })} />
          </div>
        </Section>

        <Section title="Link conditions">
          <select className="sel w-full mb-3" value={linkSel} onChange={(e) => setLinkSel(e.target.value)} aria-label="Link">
            {links.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          {linkCfg && (
            <>
              <Slider label="Delay" value={linkCfg.delay_ms} min={0} max={200} step={1} unit=" ms"
                onCommit={(v) => command('ROUTER', 'set_link', { link: linkSel, delay_ms: v })} />
              <Slider label="Loss" value={linkCfg.loss_pct} min={0} max={50} step={1} unit=" %"
                onCommit={(v) => command('ROUTER', 'set_link', { link: linkSel, loss_pct: v })} />
            </>
          )}
        </Section>

        <Section title="Traffic" right={cn?.streaming ? <span className="text-acc">streaming</span> : null}>
          <div className="grid grid-cols-3 gap-2 mb-4">
            <button className={`btn ${cn?.streaming ? 'btn-active' : ''}`} onClick={() => command('CN', 'stream_start')}>Start</button>
            <button className="btn" onClick={() => command('CN', 'stream_stop')}>Stop</button>
            <button className="btn" onClick={() => command('MN', 'ping', { count: 4 })} title="MN pings the CN 4 times">Ping CN</button>
          </div>
          <Slider label="CN stream rate" value={cn?.rate || 20} min={1} max={100} step={1} unit=" pkt/s"
            onCommit={(v) => command('CN', 'stream_rate', { rate: v })} />
        </Section>

        <Section title="Security">
          <Field label="Replay check">
            <select className="sel" value={f.replay_protection || 'timestamp'} onChange={(e) => setFeature({ replay_protection: e.target.value })}>
              <option value="timestamp">Timestamp</option>
              <option value="nonce">Nonce</option>
            </select>
          </Field>
          <div className="grid gap-2 mt-4">
            <button className="btn justify-between" onClick={() => command('MN', 'demo_wrong_key')}
              title="MN signs one Registration Request with a wrong MN-HA key. Needs the MN on a foreign network.">
              Wrong shared key<span className="font-mono text-xs text-noc-dim">HA 131</span></button>
            <button className="btn justify-between" onClick={() => command('MN', 'demo_replay')}
              title="MN re-sends its previous Registration Request unchanged. Needs the MN on a foreign network.">
              Re-send old request<span className="font-mono text-xs text-noc-dim">HA 133</span></button>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <span className="text-sm text-noc-ink w-[104px] shrink-0">Force lifetime</span>
            <input className="field w-16 font-mono" type="number" min="0" placeholder="auto" value={life} onChange={(e) => setLife(e.target.value)} />
            <button className="btn" onClick={() => setFeature({ request_lifetime: Number(life) || 0 })}
              title="A value above the FA maximum makes the FA deny with code 69">Apply</button>
          </div>
        </Section>

        <Section title="Agent tools" defaultOpen={false}>
          <div className="flex items-center gap-2">
            <select className="sel w-20" value={fa} onChange={(e) => setFa(e.target.value)} aria-label="Agent">
              {['HA', 'FA-1', 'FA-2', 'FA-3'].map((n) => <option key={n}>{n}</option>)}
            </select>
            <button className="btn" onClick={() => command(fa, 'reboot')} title="Clears state, sequence restarts at 0">Reboot</button>
            <button className="btn" onClick={() => command(fa, 'jump_seq')} title="Sets the sequence to 0xfffc to show the rollover to 256">
              Seq <span className="font-mono">0xfffc</span></button>
          </div>
        </Section>
      </div>
    </div>
  );
}
