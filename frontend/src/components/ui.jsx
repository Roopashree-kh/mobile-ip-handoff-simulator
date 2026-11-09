// Small shared presentation pieces: icons, switch, collapsible section, lifetime bar.
import React, { useEffect, useState } from 'react';

const PATHS = {
  play: <path d="M6 4.5v11l9-5.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="5.5" y="4.5" width="3" height="11" rx="0.8" fill="currentColor" stroke="none" /><rect x="11.5" y="4.5" width="3" height="11" rx="0.8" fill="currentColor" stroke="none" /></>,
  step: <><path d="M5 4.5v11l7.5-5.5z" fill="currentColor" stroke="none" /><rect x="13.5" y="4.5" width="2.2" height="11" rx="0.6" fill="currentColor" stroke="none" /></>,
  reset: <><path d="M4.5 10a5.5 5.5 0 1 0 1.7-4" /><path d="M4.5 3.5v3h3" /></>,
  chevron: <path d="M7 8l3 3 3-3" />,
  chart: <><path d="M4 16V9" /><path d="M8.5 16V5" /><path d="M13 16v-5" /><path d="M17 16V7" /></>,
  close: <><path d="M5.5 5.5l9 9" /><path d="M14.5 5.5l-9 9" /></>,
  download: <><path d="M10 4v8" /><path d="M6.5 9l3.5 3.5L13.5 9" /><path d="M4.5 15.5h11" /></>,
  trash: <><path d="M5 6.5h10" /><path d="M8 6.5V5h4v1.5" /><path d="M6.5 6.5l.6 9h5.8l.6-9" /></>,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.2" fill="currentColor" stroke="none" />,
  info: <><circle cx="10" cy="10" r="6.5" /><path d="M10 9v4.5" /><circle cx="10" cy="6.6" r="0.4" fill="currentColor" /></>,
};

export function Icon({ name, size = 16, className = '' }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} className={className} fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** Standard checkbox with a label and an optional one-line hint underneath. */
export function Switch({ checked, onChange, label, hint, small = false }) {
  return (
    <label className={`flex items-start gap-2 cursor-pointer ${small ? '' : 'py-1'}`}>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] w-[14px] h-[14px] shrink-0 accent-[#2457a6] cursor-pointer" />
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className="block text-sm text-noc-ink leading-5">{label}</span>}
          {hint && <span className="block text-xs text-noc-dim leading-4 mt-0.5">{hint}</span>}
        </span>
      )}
    </label>
  );
}

/** Collapsible section with a heading row. */
export function Section({ title, right, children, defaultOpen = true, flush = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="border-b border-noc-line last:border-b-0">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full flex items-center gap-2 px-4 h-10 text-left hover:bg-noc-raised">
        <Icon name="chevron" size={14} className={`text-noc-dim transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="section-label">{title}</span>
        <span className="ml-auto flex items-center gap-2 text-xs text-noc-dim">{right}</span>
      </button>
      {open && <div className={flush ? 'pb-4' : 'px-4 pb-4'}>{children}</div>}
    </section>
  );
}

export function useNow(ms = 250) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Thin remaining-lifetime bar with the seconds right-aligned. */
export function LifeBar({ expiresAt, lifetime, now }) {
  const left = Math.max(0, (expiresAt - now) / 1000);
  const frac = lifetime ? Math.min(1, left / lifetime) : 0;
  const tone = frac > 0.2 ? 'bg-acc' : 'bg-[#c98500]';
  return (
    <div className="flex items-center gap-2 min-w-[84px]">
      <div className="flex-1 h-1 rounded-full bg-[#e3e7ec] overflow-hidden">
        <div className={`h-full rounded-full ${tone} transition-[width] duration-300 ease-linear`} style={{ width: `${frac * 100}%` }} />
      </div>
      <span className="font-mono text-xs text-noc-dim w-12 text-right tabular-nums">{left.toFixed(1)}s</span>
    </div>
  );
}

export const Empty = ({ children }) => <div className="text-sm text-noc-mute">{children}</div>;
