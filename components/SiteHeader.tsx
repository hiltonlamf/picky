'use client';

import Link from 'next/link';
import { useHeader } from '@/lib/header-context';

export default function SiteHeader() {
  const { restaurantName } = useHeader();

  return (
    <header className="sticky top-0 z-40 bg-white/90 backdrop-blur border-b border-gray-100">
      <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2 font-bold text-lg text-gray-900 shrink-0">
          <span className="text-picky-600 text-2xl">🥦</span>
          <span>Picky</span>
        </Link>

        {restaurantName && (
          <span className="text-sm font-medium text-gray-600 truncate mx-4 max-w-[200px] sm:max-w-xs">
            {restaurantName}
          </span>
        )}

        <nav className="flex items-center gap-1 shrink-0">
          <Link href="/dublin" className="btn-ghost text-sm">
            Dublin Guide
          </Link>
        </nav>
      </div>
    </header>
  );
}
