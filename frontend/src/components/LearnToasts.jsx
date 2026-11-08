// Learn mode: each protocol step that carries an explanation pops up briefly with its RFC section.
import React, { useEffect } from 'react';
import { dismissToast, useStore } from '../lib/store.js';

function Toast({ t }) {
  useEffect(() => {
    const id = setTimeout(() => dismissToast(t.id), 9000);
    return () => clearTimeout(id);
  }, [t.id]);
  return (
    <div className="panel p-2.5 shadow-xl shadow-black/50 border-sky-800 w-80 text-xs" onClick={() => dismissToast(t.id)}>
      <div className="flex items-center gap-2 mb-1">
        <span className="px-1.5 rounded bg-sky-900 text-sky-200 text-[10px]">{t.node}</span>
        {t.rfc && <span className="text-[10px] text-amber-300">{t.rfc}</span>}
      </div>
      <div className="text-slate-200 font-medium mb-1">{t.title}</div>
      <div className="text-slate-400 leading-snug">{t.text}</div>
    </div>
  );
}

export default function LearnToasts() {
  const toasts = useStore((s) => s.toasts);
  const learn = useStore((s) => s.learn);
  if (!learn || !toasts.length) return null;
  return (
    <div className="absolute right-3 bottom-3 flex flex-col gap-2 z-30 pointer-events-auto">
      {toasts.map((t) => <Toast key={t.id} t={t} />)}
    </div>
  );
}
