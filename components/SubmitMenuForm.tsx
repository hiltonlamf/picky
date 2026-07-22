'use client';

import { useState } from 'react';
import { capture } from '@/lib/posthog-client';
import { LinkIcon, CameraIcon, CheckIcon } from './icons';

interface Props {
  restaurantId: string;
}

// Client-side cap mirrors the server (~3MB raw, under Vercel's 4.5MB body limit
// once base64-inflated). A backstop lives in the API route too.
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;

type Mode = 'url' | 'upload';
type State = 'idle' | 'submitting' | 'done' | 'error';

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(',') + 1)); // strip the data: prefix
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Shown on a restaurant's "no menu found" screen: lets a diner who knows where
 * the menu is help us out — paste a direct link, or upload a photo/PDF. On
 * success the restaurant flips to a live menu and we reload to show it.
 */
export default function SubmitMenuForm({ restaurantId }: Props) {
  const [mode, setMode] = useState<Mode>('url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'url' && !url.trim()) return;
    if (mode === 'upload' && !file) return;
    if (mode === 'upload' && file && file.size > MAX_UPLOAD_BYTES) {
      setError('That file is over 3MB — please upload a smaller photo or PDF.');
      return;
    }

    setState('submitting');
    capture('user_menu_submission_started', { restaurant_id: restaurantId, mode });
    try {
      const body =
        mode === 'url'
          ? { restaurantId, mode: 'url' as const, url: url.trim() }
          : {
              restaurantId,
              mode: 'upload' as const,
              kind: (file!.type === 'application/pdf' || file!.name.toLowerCase().endsWith('.pdf')
                ? 'pdf'
                : 'image') as 'pdf' | 'image',
              fileBase64: await readFileAsBase64(file!),
            };
      const res = await fetch('/api/submit-menu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'We couldn’t read a menu from that. Please try another link or file.');
      setState('done');
      // The restaurant is now live — reload to show the menu.
      setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setState('error');
    }
  }

  if (state === 'done') {
    return (
      <div className="card p-6 text-center">
        <div className="w-11 h-11 mx-auto mb-3 rounded-full bg-mint-100 flex items-center justify-center">
          <CheckIcon className="w-5 h-5 text-picky-600" />
        </div>
        <p className="text-sm font-semibold text-evergreen">Got it — reading that menu now…</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card p-5 text-left">
      <p className="text-sm font-semibold text-evergreen mb-1">Know where the menu is?</p>
      <p className="text-xs text-evergreen/80 mb-4">
        Paste a direct link to the menu page, or upload a photo/PDF — we&apos;ll read it right away.
      </p>

      {/* Mode toggle */}
      <div className="flex gap-2 mb-4">
        {([
          { value: 'url', label: 'Paste a link', Icon: LinkIcon },
          { value: 'upload', label: 'Upload a photo/PDF', Icon: CameraIcon },
        ] as const).map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => { setMode(value); setError(null); }}
            aria-pressed={mode === value}
            className={`flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-full border-2 text-xs font-medium transition-colors ${
              mode === value
                ? 'border-picky-500 bg-picky-50 text-evergreen'
                : 'border-mint-200 text-evergreen/80 hover:border-picky-300'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {mode === 'url' ? (
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…/menu"
          className="input-url text-sm"
          aria-label="Direct menu link"
        />
      ) : (
        <input
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-evergreen/80 file:mr-3 file:rounded-full file:border-0 file:bg-mint-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-picky-700 hover:file:bg-mint-200"
          aria-label="Upload a menu photo or PDF"
        />
      )}

      {error && <p className="text-sm text-red-500 mt-3">{error}</p>}

      <button
        type="submit"
        disabled={state === 'submitting' || (mode === 'url' ? !url.trim() : !file)}
        className="btn-primary text-sm py-2 mt-4 w-full sm:w-auto"
      >
        {state === 'submitting' ? 'Reading the menu…' : 'Read this menu →'}
      </button>
      <p className="text-[11px] text-evergreen/60 mt-2">Takes ~20–40s while our AI reads it.</p>
    </form>
  );
}
