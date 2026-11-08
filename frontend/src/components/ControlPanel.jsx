// Left panel: every knob of the simulation. Feature switches go to all agents through the
// gateway; link settings go to the core router; demos and handoffs go to the mobile node.
import React, { useEffect, useState } from 'react';
import { useStore } from '../lib/store.js';
import { command, setFeature } from '../lib/ws.js';

const MOVES = [['home', 'Home Network'], ['fa1', 'Campus Wi-Fi (FA-1)'], ['fa2', 'Metro LTE (FA-2)'], ['fa3', 'Airport (FA-3)']];

const TOGGLES = [
  ['route_optimization', 'Route optimization', 'HA sends Binding Updates; CN tunnels straight to the CoA'],
  ['smooth_handoff', 'Smooth handoff', 'Previous FA buffers and forwards in-flight packets to the new CoA'],
  ['reverse_tunneling', 'Reverse tunneling (T)', 'RFC 3024: MN -> FA -> tunnel -> HA -> CN'],
  ['ingress_filtering', 'Ingress filtering', 'Backbone drops packets whose source does not belong to the network they came from'],
  ['simultaneous_bindings', 'Simultaneous bindings (S)', 'HA tunnels a copy to every registered CoA'],
  ['colocated_coa', 'Co-located CoA', 'MN takes a .100 address on the visited link and decapsulates itself'],
];

function Section({ title, children }) {
  return (
    <div className="border-b border-noc-line px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">{title}</div>
      {children}
    </div>
  );
}

/** Range input that only sends when the user lets go, so a drag is one command. */
function Slider({ label, value, min, max, step, unit, onCommit }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="block text-xs mb-1.5">
      <div className="flex justify-between text-slate-400"><span>{label}</span><span className="mono text-slate-200">{v}{unit}</span></div>
      <input type="range" className="w-full accent-sky-500" min={min} max={max} step={step} value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={() => onCommit(v)} onKeyUp={() => onCommit(v)} />
    </label>
  );
}

export default function ControlPanel() {
  const f = useStore((s) => s.features);
  const mn = useStore((s) => s.states.MN);
  const router = useStore((s) => s.states.ROUTER);
  const cn = useStore((s) => s.states.CN);
  const [linkSel, setLinkSel] = useState('backbone');
  const [fa, setFa] = useState('FA-2');
  const [life, setLife] = useState('');

  const linkCfg = linkSel === 'backbone' ? router?.backbone : router?.links?.[linkSel];
  const links = router ? [['backbone', 'Backbone'], ...Object.entries(router.links).map(([k, l]) => [k, l.label])] : [];

  return (
    <div className="panel h-full overflow-y-auto">
      <div className="panel-title">Control</div>

      <Section title="Move the mobile node">
        <div className="grid grid-cols-2 gap-1.5">
          {MOVES.map(([link, label]) => (
            <button key={link} className={`btn ${mn?.link === link ? 'btn-on' : ''}`}
              onClick={() => command('MN', 'handoff', { link })}>{label}</button>
          ))}
        </div>
        <div className="text-[11px] text-slate-500 mt-1.5">Or drag the MN on the map.</div>
      </Section>

      <Section title="Protocol features">
        {TOGGLES.map(([key, label, tip]) => (
          <label key={key} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer" title={tip}>
            <input type="checkbox" className="accent-sky-500" checked={!!f[key]}
              onChange={(e) => setFeature({ [key]: e.target.checked })} />
            <span>{label}</span>
          </label>
        ))}
        <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1.5 items-center mt-2 text-xs">
          <span className="kv">Encapsulation</span>
          <select className="sel" value={f.encapsulation || 'ipip'} onChange={(e) => setFeature({ encapsulation: e.target.value })}>
            <option value="ipip">IP-in-IP (RFC 2003)</option>
            <option value="minimal">Minimal (RFC 2004)</option>
            <option value="gre">GRE (RFC 2784)</option>
          </select>
          <span className="kv">Movement detection</span>
          <select className="sel" value={f.movement_detection || 'prefix'} onChange={(e) => setFeature({ movement_detection: e.target.value })}>
            <option value="prefix">Network prefix</option>
            <option value="lifetime">Advertisement lifetime</option>
          </select>
          <span className="kv">Replay protection</span>
          <select className="sel" value={f.replay_protection || 'timestamp'} onChange={(e) => setFeature({ replay_protection: e.target.value })}>
            <option value="timestamp">Timestamp</option>
            <option value="nonce">Nonce</option>
          </select>
        </div>
        <div className="mt-2">
          <Slider label="Advertisement interval" value={f.adv_interval_ms || 1000} min={250} max={5000} step={250} unit=" ms"
            onCommit={(v) => setFeature({ adv_interval_ms: v })} />
        </div>
      </Section>

      <Section title="Links">
        <select className="sel w-full mb-2" value={linkSel} onChange={(e) => setLinkSel(e.target.value)}>
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

      <Section title="Correspondent stream">
        <div className="flex gap-1.5 mb-2">
          <button className={`btn ${cn?.streaming ? 'btn-on' : ''}`} onClick={() => command('CN', 'stream_start')}>Start</button>
          <button className="btn" onClick={() => command('CN', 'stream_stop')}>Stop</button>
          <button className="btn" onClick={() => command('MN', 'ping', { count: 4 })} title="MN pings the CN 4 times">Ping CN</button>
        </div>
        <Slider label="Rate" value={cn?.rate || 20} min={1} max={100} step={1} unit=" pkt/s"
          onCommit={(v) => command('CN', 'stream_rate', { rate: v })} />
      </Section>

      <Section title="Security demos">
        <div className="text-[11px] text-slate-500 mb-1.5">The MN must be registered on a foreign network.</div>
        <div className="flex flex-col gap-1.5">
          <button className="btn btn-warn" onClick={() => command('MN', 'demo_wrong_key')}
            title="MN signs one Registration Request with a wrong MN-HA key">Wrong shared key (expect HA 131)</button>
          <button className="btn btn-warn" onClick={() => command('MN', 'demo_replay')}
            title="MN re-sends its previous Registration Request unchanged">Re-send old request (expect HA 133)</button>
        </div>
        <div className="flex items-center gap-1.5 mt-2 text-xs">
          <span className="kv">Force lifetime</span>
          <input className="sel w-16" type="number" min="0" placeholder="auto" value={life} onChange={(e) => setLife(e.target.value)} />
          <button className="btn" onClick={() => setFeature({ request_lifetime: Number(life) || 0 })}
            title="A value above the FA maximum makes the FA deny with code 69">Apply</button>
        </div>
      </Section>

      <Section title="Agent tools">
        <div className="flex items-center gap-1.5">
          <select className="sel" value={fa} onChange={(e) => setFa(e.target.value)}>
            {['HA', 'FA-1', 'FA-2', 'FA-3'].map((n) => <option key={n}>{n}</option>)}
          </select>
          <button className="btn" onClick={() => command(fa, 'reboot')} title="Clears state; sequence restarts at 0">Reboot</button>
          <button className="btn" onClick={() => command(fa, 'jump_seq')} title="Sets the sequence to 0xfffc to show the rollover to 256">Seq to 0xfffc</button>
        </div>
        <button className="btn mt-1.5" onClick={() => command('MN', 'reregister')}>MN re-register now</button>
      </Section>
    </div>
  );
}
