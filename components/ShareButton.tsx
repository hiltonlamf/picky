'use client';

import { useEffect, useState } from 'react';
import { capture } from '@/lib/posthog-client';
import type { Restaurant } from '@/types';
import { CheckIcon, CopyIcon, ShareIcon } from './icons';

type ShareChannel = 'native' | 'whatsapp' | 'copy';

/** Attribution params so share → visit → activation is measurable. */
function withAttribution(pageUrl: string, src: ShareChannel): string {
  try {
    const u = new URL(pageUrl);
    u.searchParams.set('ref', 'share');
    u.searchParams.set('src', src);
    return u.toString();
  } catch {
    return pageUrl;
  }
}

function buildShareMessage(restaurant: Restaurant, pageUrl: string): string {
  const allDishes = restaurant.sections.flatMap((s) => s.dishes);
  const veganDishes = allDishes.filter((d) => d.classification === 'vegan');
  const vegDishes = allDishes.filter((d) => d.classification === 'vegetarian');

  const name = restaurant.name ?? 'this restaurant';

  const lines: string[] = [
    `Good news about *${name}*! Our AI already checked the menu 🌱`,
    ``,
  ];

  if (veganDishes.length > 0) {
    lines.push(`*Vegan (${veganDishes.length}):*`);
    veganDishes.forEach((d) => lines.push(`• ${d.name}`));
    lines.push(``);
  }

  if (vegDishes.length > 0) {
    lines.push(`*Veggie (${vegDishes.length}):*`);
    vegDishes.forEach((d) => lines.push(`• ${d.name}`));
    lines.push(``);
  }

  lines.push(
    `Found with *Picky* — AI reads restaurant menus and instantly shows everything vegetarians can eat. Super handy before a night out 🙌`,
    ``,
    `See the full menu with prices → ${pageUrl}`
  );

  return lines.join('\n');
}

export default function ShareButton({ restaurant }: { restaurant: Restaurant }) {
  const [copied, setCopied] = useState(false);
  // Detected in an effect: navigator isn't available during SSR, and
  // rendering different buttons on server vs client breaks hydration.
  const [canNativeShare, setCanNativeShare] = useState(false);

  useEffect(() => {
    setCanNativeShare(typeof navigator.share === 'function');
  }, []);

  // origin + pathname (not href): a visitor who themselves arrived from a
  // shared link shouldn't re-share the inherited ?ref/src attribution.
  const pageUrl =
    typeof window !== 'undefined'
      ? window.location.origin + window.location.pathname
      : `https://picky.ie/restaurant/${restaurant.id}`;

  async function handleNativeShare() {
    capture('share_clicked', { channel: 'native', restaurant_id: restaurant.id });
    try {
      await navigator.share({
        text: buildShareMessage(restaurant, withAttribution(pageUrl, 'native')),
      });
    } catch {
      // user closed the share sheet — the click is still tracked above
    }
  }

  async function handleCopy() {
    capture('share_clicked', { channel: 'copy', restaurant_id: restaurant.id });
    await navigator.clipboard.writeText(
      buildShareMessage(restaurant, withAttribution(pageUrl, 'copy'))
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Native share sheet (iMessage, Instagram, AirDrop...) as the primary
  // action on devices that support it — mostly mobile, where sharing happens.
  if (canNativeShare) {
    return (
      <button
        onClick={handleNativeShare}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-picky-600 text-white text-sm font-medium hover:bg-picky-700 transition-colors"
      >
        <ShareIcon className="w-4 h-4" />
        Share
      </button>
    );
  }

  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(
    buildShareMessage(restaurant, withAttribution(pageUrl, 'whatsapp'))
  )}`;

  return (
    <div className="flex items-center gap-2">
      <a
        href={whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={() => capture('share_clicked', { channel: 'whatsapp', restaurant_id: restaurant.id })}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[#25D366] text-white text-sm font-medium hover:bg-[#1ebe5d] transition-colors"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
          <path d="M12 0C5.373 0 0 5.373 0 12c0 2.127.558 4.126 1.533 5.857L.057 23.882a.5.5 0 0 0 .606.607l6.102-1.467A11.945 11.945 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.894a9.887 9.887 0 0 1-5.031-1.376l-.36-.214-3.733.898.934-3.64-.235-.374A9.866 9.866 0 0 1 2.106 12C2.106 6.53 6.53 2.106 12 2.106c5.47 0 9.894 4.424 9.894 9.894 0 5.47-4.424 9.894-9.894 9.894z" />
        </svg>
        Share on WhatsApp
      </a>

      <button
        onClick={handleCopy}
        title="Copy share message"
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full border-2 border-mint-200 text-sm text-evergreen/80 hover:border-picky-300 hover:text-evergreen transition-colors"
      >
        {copied ? (
          <>
            <CheckIcon className="w-4 h-4" /> Copied
          </>
        ) : (
          <>
            <CopyIcon className="w-4 h-4" />
            Copy
          </>
        )}
      </button>
    </div>
  );
}
