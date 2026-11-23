// Story mode quality badge: one word and one plain sentence. No numbers here. The words come
// from the same verdicts the Expert compliance table shows, so the two screens always agree.
import React from 'react';
import { useStore } from '../../lib/store.js';

const WORDS = {
  good: { word: 'Smooth', cls: 'border-[#9ccfa8] bg-good-soft text-good', dot: 'bg-[#2f9e44]' },
  fair: { word: 'A little choppy', cls: 'border-warn-line bg-warn-soft text-warn', dot: 'bg-[#c98500]' },
  poor: { word: 'Breaking up', cls: 'border-bad-line bg-bad-soft text-bad', dot: 'bg-[#d92d20]' },
  idle: { word: 'Waiting', cls: 'border-noc-line bg-noc-raised text-noc-dim', dot: 'bg-[#9aa5b1]' },
};

const PLAIN = {
  loss_pct: 'Some of it is getting lost on the way.',
  jitter_ms: 'It is arriving unevenly.',
  mouth_to_ear_delay_ms: 'There is a noticeable delay.',
  playout_delay_ms: 'There is a noticeable delay.',
  network_delay_ms: 'The network is slow.',
  mos: 'The call sounds poor.',
  freeze_ms: 'The picture keeps freezing.',
  delivery_ms: 'Messages are taking a long time.',
  lost_messages: 'A message did not get through.',
};

const RANK = { idle: 0, good: 1, fair: 2, poor: 3 };

/** Worst of voice and video. Chat only counts when it is poor. Returns { level, reason, flow }. */
export function storyQuality(q) {
  if (!q) return { level: 'idle', reason: 'The video and call have not started yet.', flow: null };
  let worst = { level: 'idle', flow: null, v: null };
  for (const k of ['voice', 'video', 'text']) {
    const v = q[k]?.verdict;
    if (!v) continue;
    if (k === 'text' && v.level !== 'poor') continue;
    if (RANK[v.level] > RANK[worst.level]) worst = { level: v.level, flow: k, v };
  }
  if (worst.level === 'idle') return { level: 'idle', reason: 'The video and call have not started yet.', flow: null };
  if (worst.level === 'good') return { level: 'good', reason: 'The video, the call and the chat are all arriving cleanly.', flow: null };
  const stall = q[worst.flow]?.stall_ms >= 1000;
  const bad = worst.v.checks.find((c) => c.status === 'hard') || worst.v.checks.find((c) => c.status === 'soft');
  const what = { voice: 'The call', video: 'The video', text: 'The chat' }[worst.flow];
  const why = stall ? 'Nothing is arriving at the moment.' : (PLAIN[bad?.key] || 'The connection is struggling.');
  return { level: worst.level, reason: `${what}: ${why}`, flow: worst.flow };
}

export default function QualityBadge() {
  const q = useStore((s) => s.states.MN?.qos);
  const { level, reason } = storyQuality(q);
  const w = WORDS[level];
  return (
    <div className={`rounded-[6px] border px-3 py-2 flex items-center gap-3 ${w.cls}`} role="status" aria-live="polite">
      <span className={`w-3 h-3 rounded-full shrink-0 ${w.dot}`} />
      <div className="min-w-0">
        <div className="text-[18px] leading-6 font-semibold">{w.word}</div>
        <div className="text-[14px] leading-5 text-noc-ink">{reason}</div>
      </div>
    </div>
  );
}
