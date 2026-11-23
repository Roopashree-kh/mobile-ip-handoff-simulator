// The five switchable features of the Metro ride, each with a plain-English one-line
// description from config/resilience.json. Used by the Expert controls, the Quality drawer
// and the Story screen, so the wording is the same everywhere.
import React from 'react';
import { useStore } from '../lib/store.js';
import { setFeature } from '../lib/ws.js';
import { Switch } from './ui.jsx';

export function useRescue() {
  const cfg = useStore((s) => s.config?.resilience);
  const f = useStore((s) => s.features);
  const keys = cfg?.all_on || [];
  return { cfg, f, keys };
}

export default function RescueSwitches({ story = false }) {
  const { cfg, f, keys } = useRescue();
  if (!cfg) return null;
  return (
    <div className={story ? 'grid gap-1.5' : 'grid gap-3'}>
      {keys.map((k) => {
        const e = cfg.features[k];
        return (
          <Switch small key={k} checked={!!f[k]} onChange={(v) => setFeature({ [k]: v })}
            label={<span>{e.title}{!story && <span className="ml-1.5 badge border-noc-line bg-noc-raised text-noc-dim align-middle">{e.tag}</span>}</span>}
            hint={e.plain} />
        );
      })}
    </div>
  );
}
