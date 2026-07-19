'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldIcon } from '@/components/icons';

export default function AdminLoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Login failed');
        setLoading(false);
        return;
      }
      router.push('/admin');
      router.refresh();
    } catch {
      setError('Something went wrong — please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-4">
      <div className="card p-8 w-full max-w-sm">
        <div className="flex items-center gap-2 mb-6 text-picky-700">
          <ShieldIcon className="w-5 h-5" />
          <span className="eyebrow">Admin</span>
        </div>
        <h1 className="text-xl font-bold text-evergreen mb-1">Sign in</h1>
        <p className="text-sm text-evergreen/80 mb-6">Enter the admin password to continue.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
            aria-label="Admin password"
            className="w-full rounded-full border-2 border-mint-200 bg-white px-5 py-3 text-sm text-evergreen
                       focus:border-picky-500 focus:outline-none focus:ring-4 focus:ring-picky-500/15 transition-all"
          />
          {error && (
            <p className="text-sm text-red-500" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={loading || !password} className="btn-primary w-full">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
