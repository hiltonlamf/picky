import type { MenuCandidate } from '@/types';

/**
 * Per-browser anonymous usage ID (UUID, set by middleware.ts, 1-year expiry).
 * A stable persistent ID for usage-per-person measurement — deliberately NOT
 * the per-request IP hash in lib/rate-limit.ts, which exists for abuse
 * control. Monetization groundwork: usage can't be reconstructed later.
 * Not httpOnly — the PostHog client reads it as its distinct_id.
 */
export const ANON_ID_COOKIE = 'picky_anon_id';

/** Read the anon ID from document.cookie (client-side only; null on server). */
export function anonIdFromDocument(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${ANON_ID_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Bucket a set of menu candidates into the analytics category taxonomy:
 * pdf / image / js / text / multi. "js" covers menus that live on a
 * separate page the scraper had to follow (usually JS-rendered sites).
 */
export function menuCategory(candidates: Array<Pick<MenuCandidate, 'type'>>): string {
  if (candidates.length > 1) return 'multi';
  switch (candidates[0]?.type) {
    case 'pdf':
      return 'pdf';
    case 'image':
      return 'image';
    case 'subpage':
      return 'js';
    default:
      return 'text';
  }
}

/** Bare hostname of a URL ("www." stripped), or null if unparseable. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
