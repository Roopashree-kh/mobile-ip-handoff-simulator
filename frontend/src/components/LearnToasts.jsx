// Learn mode: each protocol step that carries an explanation pops up briefly with its RFC section.
import React, { useEffect } from 'react';
import { dismissToast, useStore } from '../lib/store.js';

function Toast({ t }) {
  useEffect(() => {
    const id = setTimeout(() => dismissToast(t.id), 9000);
    return () => clearTimeout(id);
  }, [t.id]);
  return (
    <div className="panel p-3 w-80 shadow-xl shadow-black/50 border-sky-500/30 cursor-pointer fade-in" onClick={() => dismissToast(t.id)}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="badge border-sky-500/40 bg-sky-500/10 text-sky-300">{t.node}</span>
        {t.rfc && <span className="font-mono text-2xs text-noc-mute">{t.rfc}</span>}
      </div>
      <div className="text-sm font-medium text-noc-ink mb-1">{t.title}</div>
      <div className="text-xs text-noc-dim leading-[18px]">{t.text}</div>
    </div>
  );
}

export default function LearnToasts() {
  const toasts = useStore((s) => s.toasts);
  const learn = useStore((s) => s.learn);
  if (!learn || !toasts.length) return null;
  return (
    <div className="absolute right-3 top-12 flex flex-col gap-2 z-30 pointer-events-auto">
      {toasts.map((t) => <Toast key={t.id} t={t} />)}
    </div>
  );
}
