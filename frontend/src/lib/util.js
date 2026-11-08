// Shared helpers: packet filter language, colours, formatting and CSV export.

// Animation colours by packet type (topology map dots and inspector row accents).
export const PTYPE_COLOR = {
  adv: '#9ca3af',     // agent advertisement / solicitation: grey
  reg: '#f59e0b',     // registration: amber
  tunnel: '#a855f7',  // tunneled data: purple
  data: '#22c55e',    // plain data: green
  bu: '#06b6d4',      // binding update family: cyan
  arp: '#64748b',
  icmp: '#38bdf8',
  drop: '#ef4444',
};

export const PTYPE_LABEL = { adv: 'Advertisement', reg: 'Registration', tunnel: 'Tunneled data', data: 'Plain data',
  bu: 'Binding update', arp: 'ARP', icmp: 'ICMP', drop: 'Dropped' };

// Chart series colours, validated (dataviz validate_palette.js, dark mode, surface #111827).
export const SERIES = { s1: '#3987e5', s2: '#d95926', s3: '#199e70', s4: '#c98500' };

/**
 * Filter language for the packet list. Space separated terms, all must match.
 *   reg  icmp  tunnel  drop        free text over protocol, info, type, layer names
 *   node==FA-2  src==10.1.0.50  dst==...  type==bu  proto==GRE  link==fa2
 *   !adv                           negation
 */
export function compileFilter(text) {
  const terms = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const tests = terms.map((t) => {
    const neg = t.startsWith('!');
    if (neg) t = t.slice(1);
    let fn;
    const m = t.match(/^(\w+)(==|=|~)(.+)$/);
    if (m) {
      const [, key, , val] = m;
      fn = (p) => {
        const get = {
          node: () => [p.frm, p.to], src: () => [p.src], dst: () => [p.dst], ip: () => [p.src, p.dst],
          type: () => [p.ptype, p.verdict === 'dropped' ? 'drop' : ''], proto: () => [p.protocol], link: () => [p.link, p.dst_link],
          verdict: () => [p.verdict], encap: () => [p.encap],
        }[key];
        if (!get) return false;
        return get().some((v) => v && String(v).toLowerCase().includes(val));
      };
    } else {
      fn = (p) => {
        if (!p._hay) {
          p._hay = [p.protocol, p.info, p.ptype, p.encap, p.lkind, p.verdict, p.reason, p.frm, p.to,
            ...(p.layers || []).map((l) => l.name)].join(' ').toLowerCase();
          if (p.verdict === 'dropped') p._hay += ' drop dropped';
        }
        return p._hay.includes(t);
      };
    }
    return neg ? (p) => !fn(p) : fn;
  });
  return (p) => tests.every((f) => f(p));
}

export function fmtSecs(ms) {
  return (ms / 1000).toFixed(3);
}

export function clock(ms) {
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const r = Math.floor(t % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

export function downloadCsv(name, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function linkLabel(topology, link) {
  return topology?.links?.[link]?.label || link || '-';
}
