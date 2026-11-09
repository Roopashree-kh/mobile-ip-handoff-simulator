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

/** Toggle switch. Renders as role="switch" so it is keyboard and screen reader friendly. */
export function Switch({ checked, onChange, label, hint, small = false }) {
  return (
    <label className={`flex items-start gap-2.5 cursor-pointer group ${small ? '' : 'py-1.5'}`}>
      <button type="button" role="switch" aria-checked={!!checked} onClick={() => onChange(!checked)}
        className={`relative mt-0.5 shrink-0 w-7 h-4 rounded-full transition-colors duration-150
          ${checked ? 'bg-sky-500' : 'bg-[#2b3646] group-hover:bg-[#364357]'}`}>
        <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform duration-150
          ${checked ? 'translate-x-3' : ''}`} />
      </button>
      {(label || hint) && (
        <span className="min-w-0">
          {label && <span className={`block ${small ? 'text-xs' : 'text-sm'} text-noc-ink leading-5`}>{label}</span>}
          {hint && <span className="block text-2xs text-noc-mute leading-4">{hint}</span>}
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
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 h-9 text-left hover:bg-white/[0.02]">
        <span className="section-label">{title}</span>
        <span className="ml-auto flex items-center gap-2 text-2xs text-noc-mute">{right}</span>
        <Icon name="chevron" size={14} className={`text-noc-mute transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className={flush ? 'pb-2' : 'px-3 pb-3'}>{children}</div>}
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
  const tone = frac > 0.2 ? 'bg-sky-400' : 'bg-amber-400';
  return (
    <div className="flex items-center gap-2 min-w-[84px]">
      <div className="flex-1 h-1 rounded-full bg-[#243042] overflow-hidden">
        <div className={`h-full rounded-full ${tone} transition-[width] duration-300 ease-linear`} style={{ width: `${frac * 100}%` }} />
      </div>
      <span className="font-mono text-2xs text-noc-dim w-10 text-right tabular-nums">{left.toFixed(1)}s</span>
    </div>
  );
}

export const Empty = ({ children }) => <div className="text-xs text-noc-mute py-1">{children}</div>;
