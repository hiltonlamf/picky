import type { MenuCandidate } from '@/types';

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
