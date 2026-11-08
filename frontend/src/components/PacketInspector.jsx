// Wireshark-style packet inspector: virtualised list, filter box, protocol tree and a hex
// dump where hovering a field highlights its bytes (and hovering a byte finds its field).
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { setState, useStore } from '../lib/store.js';
import { GATEWAY_HTTP, send } from '../lib/ws.js';
import { PTYPE_COLOR, compileFilter, fmtSecs } from '../lib/util.js';

const ROW = 20;
const COLS = 'grid-cols-[56px_76px_100px_100px_118px_92px_48px_1fr]';

function PacketList({ packets, startedAt, selectedNo }) {
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
      <div className={`grid ${COLS} px-2 text-[10px] uppercase tracking-wide text-slate-500 border-b border-noc-line py-1 pr-4`}>
        <span>No.</span><span>Time</span><span>Source</span><span>Destination</span><span>Protocol</span><span>Hop</span><span>Len</span><span>Info</span>
      </div>
      <div ref={box} onScroll={onScroll} className="flex-1 overflow-y-auto mono text-[11.5px]">
        <div style={{ height: packets.length * ROW, position: 'relative' }}>
          {rows.map((p, i) => {
            const dropped = p.verdict === 'dropped';
            const sel = p.no === selectedNo;
            return (
              <div key={p.no} onClick={() => setState({ selectedNo: p.no })}
                style={{ position: 'absolute', top: (first + i) * ROW, height: ROW, left: 0, right: 0, borderLeft: `3px solid ${dropped ? PTYPE_COLOR.drop : PTYPE_COLOR[p.ptype] || '#475569'}` }}
                className={`grid ${COLS} px-2 items-center cursor-pointer whitespace-nowrap overflow-hidden
                  ${sel ? 'bg-sky-800/70 text-white' : dropped ? 'text-red-300 hover:bg-slate-800' : 'hover:bg-slate-800'}`}
                title={p.reason || ''}>
                <span>{p.no}</span>
                <span>{fmtSecs(p.ts - startedAt)}</span>
                <span className="truncate">{p.src}</span>
                <span className="truncate">{p.dst}</span>
                <span className="truncate">{p.protocol}</span>
                <span className="truncate text-slate-400">{p.frm}{'>'}{p.to || 'x'}</span>
                <span>{p.length}</span>
                <span className="truncate">{dropped ? `[DROPPED: ${p.reason}] ` : ''}{p.info}</span>
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
  if (!pkt) return <div className="p-3 text-xs text-slate-500">Click a packet to decode it.</div>;
  const same = (f) => hl && f.off === hl.off && f.len === hl.len;
  return (
    <div className="text-[11.5px] mono p-1.5">
      <div className="text-slate-300 mb-1 px-1">
        Frame {pkt.no}: {pkt.length} bytes, {pkt.lkind} {pkt.frm} {'->'} {pkt.to || '(none)'} on {pkt.link || '-'}, delay {pkt.delay_ms} ms
        {pkt.verdict === 'dropped' && <div className="text-red-400">Dropped: {pkt.reason}</div>}
      </div>
      {(pkt.layers || []).map((l, i) => (
        <div key={i} className="mb-0.5">
          <div className="cursor-pointer px-1 rounded hover:bg-slate-800 text-sky-200"
            onClick={() => setClosed((c) => ({ ...c, [i]: !c[i] }))}
            onMouseEnter={() => setHl({ off: l.off, len: l.len })} onMouseLeave={() => setHl(pin)}>
            {closed[i] ? '+' : '-'} {l.name}
          </div>
          {!closed[i] && l.fields.map((f, j) => (
            <div key={j}>
              <div className={`pl-5 pr-1 rounded cursor-default ${same(f) ? 'bg-amber-700/50' : 'hover:bg-slate-800'}`}
                onMouseEnter={() => setHl(f)} onMouseLeave={() => setHl(pin)}
                onClick={() => setPin(pin && pin.off === f.off && pin.len === f.len ? null : f)} title={f.desc || ''}>
                <span className="text-slate-400">{f.name}:</span> <span className="text-slate-100">{f.value}</span>
                {f.desc && <span className="text-slate-500"> ({f.desc})</span>}
              </div>
              {f.bits && f.bits.map((b, k) => (
                <div key={k} className={`pl-10 ${b.set ? 'text-emerald-300' : 'text-slate-500'}`}>{b.set ? '1' : '0'} = {b.name}</div>
              ))}
            </div>
          ))}
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
    <div className="mono text-[11.5px] p-2 leading-5">
      {lines.map((o) => (
        <div key={o} className="flex gap-3 whitespace-pre">
          <span className="text-slate-500">{o.toString(16).padStart(4, '0')}</span>
          <span>
            {bytes.slice(o, o + 16).map((b, k) => (
              <span key={k} className={`px-[1px] ${lit(o + k) ? 'bg-amber-600 text-black' : 'text-slate-200'} ${k === 7 ? 'mr-2' : ''}`}
                onMouseEnter={() => setHl(fieldAt(o + k) || null)} onMouseLeave={() => setHl(pin)}>
                {b.toString(16).padStart(2, '0')}{' '}
              </span>
            ))}
          </span>
          <span className="text-slate-400">
            {bytes.slice(o, o + 16).map((b, k) => (
              <span key={k} className={lit(o + k) ? 'bg-amber-600 text-black' : ''}>{b >= 32 && b < 127 ? String.fromCharCode(b) : '.'}</span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function EventLog({ events, startedAt }) {
  const box = useRef(null);
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events.length]);
  const tone = (e) => (e.kind === 'registration' && e.code > 1 ? 'text-red-300' : e.kind === 'drop' || e.kind === 'error' ? 'text-red-300'
    : e.kind === 'handoff' ? 'text-emerald-300' : e.kind === 'scenario' ? 'text-sky-300' : e.kind === 'demo' ? 'text-amber-300' : 'text-slate-300');
  return (
    <div ref={box} className="flex-1 overflow-y-auto mono text-[11.5px] p-1.5">
      {events.map((e) => (
        <div key={e.no} className={`grid grid-cols-[64px_64px_100px_1fr] gap-2 ${tone(e)}`} title={e.rfc || ''}>
          <span className="text-slate-500">{fmtSecs(e.ts - startedAt)}</span><span className="text-slate-400">{e.node}</span>
          <span className="text-slate-500">{e.kind}</span><span>{e.summary}</span>
        </div>
      ))}
    </div>
  );
}

export default function PacketInspector() {
  const packets = useStore((s) => s.packets);
  const events = useStore((s) => s.events);
  const startedAt = useStore((s) => s.startedAt);
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

  return (
    <div className="panel h-full flex flex-col">
      <div className="panel-title !py-1.5">
        <button className={`px-2 py-0.5 rounded ${tab === 'packets' ? 'bg-slate-700 text-white' : ''}`} onClick={() => setTab('packets')}>Packets ({filtered.length})</button>
        <button className={`px-2 py-0.5 rounded ${tab === 'events' ? 'bg-slate-700 text-white' : ''}`} onClick={() => setTab('events')}>Protocol events</button>
        {tab === 'packets' && (
          <>
            <input value={text} onChange={(e) => setText(e.target.value)} spellCheck="false"
              placeholder='filter: reg  icmp  tunnel  drop  node==FA-2  src==10.1.0.50  type==bu  !adv'
              className="ml-2 flex-1 max-w-xl sel mono normal-case tracking-normal font-normal" />
            <label className="normal-case tracking-normal font-normal flex items-center gap-1">
              <input type="checkbox" className="accent-sky-500" checked={hideAdv} onChange={(e) => setHideAdv(e.target.checked)} /> hide advertisements
            </label>
          </>
        )}
        {paused && <span className="text-amber-300 normal-case">paused</span>}
        <span className="ml-auto flex gap-1.5 normal-case tracking-normal font-normal">
          <button className="btn" onClick={() => send({ type: 'clear' })}>Clear</button>
          <a className="btn btn-on" href={`${GATEWAY_HTTP}/export.pcap`} download>Download .pcap</a>
        </span>
      </div>
      {tab === 'events' ? <EventLog events={events} startedAt={startedAt} /> : (
        <div className="flex-1 min-h-0 flex">
          <div className="flex-[3] min-w-0 flex flex-col border-r border-noc-line">
            <PacketList packets={filtered} startedAt={startedAt} selectedNo={selectedNo} />
          </div>
          <div className="flex-[2] min-w-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto border-b border-noc-line">
              <Tree pkt={pkt} hl={hl} setHl={setHl} pin={pin} setPin={(f) => { setPin(f); setHl(f); }} />
            </div>
            <div className="h-[42%] overflow-y-auto"><Hex pkt={pkt} hl={hl} setHl={setHl} pin={pin} /></div>
          </div>
        </div>
      )}
    </div>
  );
}
