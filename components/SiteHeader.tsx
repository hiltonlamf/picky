'use client';

import Link from 'next/link';
import { useHeader } from '@/lib/header-context';
import { SproutIcon } from './icons';

export default function SiteHeader() {
  const { restaurantName } = useHeader();

  return (
    // Glass over whatever scrolls beneath it — the first bit of the
    // intelligence layer people meet.
    <header className="sticky top-0 z-40 bg-forest-deep/75 backdrop-blur-md backdrop-saturate-150 border-b border-azalea-400/35 text-paper">
      <div className="max-w-5xl mx-auto px-6 h-[62px] flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5 font-display text-xl shrink-0">
          {/* The sprout is green at all times — green always means plants. */}
          <SproutIcon className="w-6 h-6 text-picky-400" />
          <span>Picky</span>
        </Link>

        {restaurantName && (
          <span className="text-sm font-medium text-paper/80 truncate mx-4 max-w-[200px] sm:max-w-xs">
            {restaurantName}
          </span>
        )}

        <nav className="flex items-center gap-1 shrink-0">
          <Link
            href="/dublin"
            className="text-sm px-4 py-2 rounded-full text-paper/85 hover:bg-azalea-500 hover:text-white transition-colors"
          >
            Dublin Guide
          </Link>
        </nav>
      </div>
    </header>
  );
}
