// Wireshark-style packet inspector: virtualised list with fixed columns, filter box,
// protocol tree with indentation guides, and a hex dump where hovering a field highlights
// its bytes (and hovering a byte finds its field). The header doubles as the collapsed bar.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { setState, useStore } from '../lib/store.js';
import { GATEWAY_HTTP, send } from '../lib/ws.js';
import { PTYPE_COLOR, compileFilter, fmtSecs } from '../lib/util.js';
import { Icon, Switch } from './ui.jsx';

const ROW = 22;
const COLS = 'grid-cols-[60px_76px_112px_112px_minmax(90px,140px)_104px_56px_minmax(0,1fr)]';

const tint = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

function PacketList({ packets, base, selectedNo }) {
  const box = useRef(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(300);
  const follow = useRef(true);

  useEffect(() => {
    const el = box.current;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (follow.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [packets.length]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    setTop(el.scrollTop);
    follow.current = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW * 2;
  };
  const first = Math.max(0, Math.floor(top / ROW) - 5);
  const rows = packets.slice(first, first + Math.ceil(height / ROW) + 10);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className={`grid ${COLS} items-center h-7 px-3 pr-5 text-2xs font-medium text-noc-mute border-b border-noc-line bg-[#0f1520]`}>
        <span>No.</span><span>Time</span><span>Source</span><span>Destination</span><span>Protocol</span><span>Hop</span><span className="text-right pr-3">Length</span><span>Info</span>
      </div>
      <div ref={box} onScroll={onScroll} className="flex-1 overflow-y-auto font-mono text-xs">
        {!packets.length && <div className="p-4 font-sans text-xs text-noc-mute">No packets match.</div>}
        <div style={{ height: packets.length * ROW, position: 'relative' }}>
          {rows.map((p, i) => {
            const dropped = p.verdict === 'dropped';
            const sel = p.no === selectedNo;
            const c = dropped ? PTYPE_COLOR.drop : PTYPE_COLOR[p.ptype] || '#64748b';
            return (
              <div key={p.no} onClick={() => setState({ selectedNo: p.no })} title={p.reason || ''}
                style={{ position: 'absolute', top: (first + i) * ROW, height: ROW, left: 0, right: 0,
                  background: sel ? 'rgba(14,165,233,0.35)' : tint(c, dropped ? 0.16 : 0.08),
                  boxShadow: sel ? 'inset 2px 0 0 #38bdf8' : `inset 2px 0 0 ${tint(c, 0.8)}` }}
                className={`grid ${COLS} px-3 items-center cursor-pointer whitespace-nowrap overflow-hidden
                  border-b border-black/20 ${sel ? 'text-white' : dropped ? 'text-red-200' : 'text-[#d1d5db] hover:brightness-125'}`}>
                <span className="text-noc-dim">{p.no}</span>
                <span className="text-noc-dim">{fmtSecs(p.ts - base)}</span>
                <span className="truncate pr-2">{p.src}</span>
                <span className="truncate pr-2">{p.dst}</span>
                <span className="truncate pr-2" style={{ color: sel ? undefined : c }}>{p.protocol}</span>
                <span className="truncate pr-2 text-noc-dim">{p.frm} {'>'} {p.to || 'x'}</span>
                <span className="text-right pr-3 text-noc-dim">{p.length}</span>
                <span className="truncate">{dropped ? `[Dropped: ${p.reason}] ` : ''}{p.info}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Tree({ pkt, hl, setHl, pin, setPin }) {
  const [closed, setClosed] = useState({});
  useEffect(() => setClosed({}), [pkt?.no]);
  if (!pkt) return <div className="p-4 text-xs text-noc-mute">Select a packet to decode it.</div>;
  const same = (f) => hl && f.off === hl.off && f.len === hl.len;
  return (
    <div className="font-mono text-xs p-2">
      <div className="px-1.5 pb-2 mb-1 border-b border-noc-line text-noc-dim">
        <span className="text-noc-ink">Frame {pkt.no}</span>: {pkt.length} bytes, {pkt.lkind}, {pkt.frm} {'>'} {pkt.to || '(none)'} on {pkt.link || '-'}, {pkt.delay_ms} ms
        {pkt.verdict === 'dropped' && <div className="text-red-300">Dropped: {pkt.reason}</div>}
      </div>
      {(pkt.layers || []).map((l, i) => (
        <div key={i}>
          <div className="flex items-center gap-1 h-6 px-1 rounded cursor-pointer hover:bg-white/[0.04] text-sky-200"
            onClick={() => setClosed((c) => ({ ...c, [i]: !c[i] }))}
            onMouseEnter={() => setHl({ off: l.off, len: l.len })} onMouseLeave={() => setHl(pin)}>
            <Icon name="chevron" size={13} className={`text-noc-mute transition-transform ${closed[i] ? '-rotate-90' : ''}`} />
            <span className="font-sans text-xs font-semibold">{l.name}</span>
          </div>
          {!closed[i] && (
            <div className="ml-[11px] pl-3 border-l border-[#2b3646]">
              {l.fields.map((f, j) => (
                <div key={j}>
                  <div className={`px-1.5 leading-[22px] rounded cursor-default truncate ${same(f) ? 'bg-amber-500/25 text-amber-50' : 'hover:bg-white/[0.04]'}`}
                    onMouseEnter={() => setHl(f)} onMouseLeave={() => setHl(pin)}
                    onClick={() => setPin(pin && pin.off === f.off && pin.len === f.len ? null : f)} title={f.desc || ''}>
                    <span className="text-noc-dim">{f.name}:</span> <span className="text-noc-ink">{f.value}</span>
                    {f.desc && <span className="text-noc-mute"> ({f.desc})</span>}
                  </div>
                  {f.bits && (
                    <div className="ml-2 pl-3 border-l border-[#232d3c]">
                      {f.bits.map((b, k) => (
                        <div key={k} className={`px-1.5 leading-5 ${b.set ? 'text-emerald-300' : 'text-noc-mute'}`}>{b.set ? '1' : '0'} = {b.name}</div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Hex({ pkt, hl, setHl, pin }) {
  const bytes = useMemo(() => {
    const h = pkt?.hex || '';
    const out = new Array(h.length / 2);
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }, [pkt?.no]);
  const fields = useMemo(() => (pkt?.layers || []).flatMap((l) => l.fields).filter((f) => f.len > 0), [pkt?.no]);
  if (!pkt) return null;
  const fieldAt = (i) => fields.filter((f) => i >= f.off && i < f.off + f.len).sort((a, b) => a.len - b.len)[0];
  const lit = (i) => hl && i >= hl.off && i < hl.off + hl.len;
  const lines = [];
  for (let o = 0; o < bytes.length; o += 16) lines.push(o);
  return (
    <div className="font-mono text-xs px-3 py-2 leading-5">
      {lines.map((o) => (
        <div key={o} className="flex gap-4 whitespace-pre">
          <span className="text-noc-mute select-none">{o.toString(16).padStart(4, '0')}</span>
          <span>
            {bytes.slice(o, o + 16).map((b, k) => (
              <span key={k} className={`${lit(o + k) ? 'bg-amber-500/80 text-black' : 'text-[#d1d5db]'} ${k === 7 ? 'mr-2.5' : 'mr-[5px]'} rounded-[2px]`}
                onMouseEnter={() => setHl(fieldAt(o + k) || null)} onMouseLeave={() => setHl(pin)}>
                {b.toString(16).padStart(2, '0')}
              </span>
            ))}
          </span>
          <span className="text-noc-mute">
            {bytes.slice(o, o + 16).map((b, k) => (
              <span key={k} className={lit(o + k) ? 'bg-amber-500/80 text-black' : ''}>{b >= 32 && b < 127 ? String.fromCharCode(b) : '.'}</span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function EventLog({ events, base }) {
  const box = useRef(null);
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events.length]);
  const tone = (e) => (e.kind === 'registration' && e.code > 1 ? 'text-amber-300' : e.kind === 'drop' || e.kind === 'error' ? 'text-red-300'
    : e.kind === 'handoff' ? 'text-emerald-300' : e.kind === 'scenario' ? 'text-sky-300' : e.kind === 'demo' ? 'text-amber-300' : 'text-[#d1d5db]');
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="grid grid-cols-[84px_72px_110px_1fr] items-center h-7 px-3 text-2xs font-medium text-noc-mute border-b border-noc-line bg-[#0f1520]">
        <span>Time</span><span>Node</span><span>Kind</span><span>Event</span>
      </div>
      <div ref={box} className="flex-1 overflow-y-auto font-mono text-xs">
        {events.map((e, i) => (
          <div key={e.no} className={`grid grid-cols-[84px_72px_110px_1fr] items-center px-3 h-[22px] ${i % 2 ? 'bg-white/[0.02]' : ''} ${tone(e)}`} title={e.rfc || ''}>
            <span className="text-noc-mute">{fmtSecs(e.ts - base)}</span><span className="text-noc-dim">{e.node}</span>
            <span className="text-noc-mute">{e.kind}</span><span className="truncate">{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PacketInspector({ collapsed, onToggle }) {
  const packets = useStore((s) => s.packets);
  const events = useStore((s) => s.events);
  const base = useStore((s) => s.resetAt);
  const selectedNo = useStore((s) => s.selectedNo);
  const paused = useStore((s) => s.paused);
  const [tab, setTab] = useState('packets');
  const [text, setText] = useState('');
  const [hl, setHl] = useState(null);
  const [pin, setPin] = useState(null);
  const [hideAdv, setHideAdv] = useState(false);

  const filtered = useMemo(() => {
    const f = compileFilter(text);
    return packets.filter((p) => (!hideAdv || p.ptype !== 'adv') && (!f || f(p)));
  }, [packets, text, hideAdv]);
  const pkt = useMemo(() => packets.find((p) => p.no === selectedNo), [packets, selectedNo]);
  useEffect(() => { setPin(null); setHl(null); }, [selectedNo]);

  const tabBtn = (id, label, count) => (
    <button onClick={() => { setTab(id); if (collapsed) onToggle(); }}
      className={`h-7 px-2.5 rounded-md text-xs font-medium flex items-center gap-1.5 ${tab === id ? 'bg-noc-raised text-noc-ink border border-noc-edge' : 'text-noc-dim hover:text-noc-ink border border-transparent'}`}>
      {label}{count !== undefined && <span className="font-mono text-2xs text-noc-mute">{count}</span>}
    </button>
  );

  return (
    <div className="panel h-full flex flex-col overflow-hidden">
      <div className="panel-head gap-3">
        <button className="icon-btn btn-ghost w-7 h-7" onClick={onToggle} aria-label={collapsed ? 'Expand inspector' : 'Collapse inspector'}
          data-tip={collapsed ? 'Expand' : 'Collapse'}>
          <Icon name="chevron" size={16} className={`transition-transform ${collapsed ? 'rotate-180' : ''}`} />
        </button>
        <span className="panel-title">Packet inspector</span>
        <div className="flex items-center gap-1">
          {tabBtn('packets', 'Packets', filtered.length)}
          {tabBtn('events', 'Protocol events', events.length)}
        </div>
        {tab === 'packets' && !collapsed && (
          <>
            <input value={text} onChange={(e) => setText(e.target.value)} spellCheck="false" aria-label="Display filter"
              placeholder="Filter: reg, tunnel, drop, node==FA-2, src==10.1.0.50, type==bu, !adv"
              className="field flex-1 min-w-[160px] max-w-[520px] font-mono" />
            <Switch small checked={hideAdv} onChange={setHideAdv} label="Hide advertisements" />
          </>
        )}
        {paused && <span className="badge border-amber-500/40 bg-amber-500/10 text-amber-300">Paused</span>}
        <span className="ml-auto flex gap-2">
          <button className="btn" onClick={() => send({ type: 'clear' })}><Icon name="trash" size={14} />Clear</button>
          <a className="btn btn-primary" href={`${GATEWAY_HTTP}/export.pcap`} download><Icon name="download" size={14} />Download .pcap</a>
        </span>
      </div>
      {!collapsed && (tab === 'events' ? <EventLog events={events} base={base} /> : (
        <div className="flex-1 min-h-0 flex">
          <div className="flex-[5] min-w-0 flex flex-col border-r border-noc-line">
            <PacketList packets={filtered} base={base} selectedNo={selectedNo} />
          </div>
          <div className="flex-[3] min-w-[340px] flex flex-col">
            <div className="flex-[3] min-h-0 overflow-y-auto">
              <Tree pkt={pkt} hl={hl} setHl={setHl} pin={pin} setPin={(f) => { setPin(f); setHl(f); }} />
            </div>
            {pkt && <div className="flex-[2] min-h-0 overflow-auto border-t border-noc-line bg-[#0e141e]"><Hex pkt={pkt} hl={hl} setHl={setHl} pin={pin} /></div>}
          </div>
        </div>
      ))}
    </div>
  );
}
