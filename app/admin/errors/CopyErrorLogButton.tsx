'use client';

import { useState } from 'react';

// Fetches the same Markdown the export endpoint produces and copies it to the
// clipboard, so the log can be pasted straight into Claude Code.
export default function CopyErrorLogButton() {
  const [state, setState] = useState<'idle' | 'copying' | 'done' | 'error'>('idle');

  async function copy() {
    setState('copying');
    try {
      const res = await fetch('/api/admin/errors/export');
      if (!res.ok) throw new Error('failed');
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      setState('done');
      setTimeout(() => setState('idle'), 2500);
    } catch {
      setState('error');
      setTimeout(() => setState('idle'), 2500);
    }
  }

  return (
    <button onClick={copy} disabled={state === 'copying'} className="btn-primary text-sm px-4 py-2">
      {state === 'copying'
        ? 'Copying…'
        : state === 'done'
          ? 'Copied ✓'
          : state === 'error'
            ? 'Copy failed'
            : 'Copy for Claude'}
    </button>
  );
}
