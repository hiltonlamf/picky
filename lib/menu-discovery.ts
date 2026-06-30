import type { MenuCandidate, MenuCandidateType } from '@/types';
import type { ScrapeResult } from './scraper';
import { labelMenuCandidates } from './ai';

export interface DiscoveryResult {
  candidates: MenuCandidate[];
  inlineText: string; // homepage/landing menu text if present
  restaurantTitle: string;
  finalUrl: string;
  screenshotUrl?: string;
}

/** Stable, non-cryptographic id for a candidate (FNV-1a, 32-bit, hex). */
function candidateId(type: MenuCandidateType, ref: string): string {
  const input = `${type}|${ref}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

const MENU_WORD_RE =
  /\b(starter|main|dessert|appetiser|appetizer|entr[ée]e|side|sharing|à la carte|a la carte|course|salad|soup|pasta|pizza|risotto|burger|brunch|lunch|dinner)\b/i;

/** Heuristic: does this text actually read like a menu (prices + food words)? */
function textLooksLikeMenu(text: string): boolean {
  if (!text || text.length < 100) return false;
  const priceTokens = (text.match(/(?:€|£|\$)\s?\d|\b\d{1,3}\.\d{2}\b/g) ?? []).length;
  const hasMenuWords = MENU_WORD_RE.test(text);
  return (priceTokens >= 4 && hasMenuWords) || (priceTokens >= 8) || (hasMenuWords && text.length > 1500);
}

/** Turn a URL into a short human hint from its slug, e.g. ".../wine-list.pdf" → "wine list". */
function hintFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last)
      .replace(/\.(pdf|jpe?g|png|webp|html?)$/i, '')
      .replace(/[-_]+/g, ' ')
      .trim();
  } catch {
    return '';
  }
}

/**
 * Enumerate the distinct menu sources on a scraped restaurant page and label
 * them with a cheap LLM pass. The page text itself counts as one "text"
 * candidate when present; PDFs, images, and menu sub-pages are the others.
 */
export async function discoverMenus(scrape: ScrapeResult): Promise<DiscoveryResult> {
  const inlineText = scrape.menuText ?? '';
  const finalUrl = scrape.canonicalUrl;

  // Build raw candidates with a type, ref and a human hint for labeling.
  type Raw = { type: MenuCandidateType; ref: string; hint: string; source: MenuCandidate['source'] };
  const raw: Raw[] = [];

  // Only treat inline text as a menu candidate when it actually looks like a
  // menu (prices + course words) — avoids a homepage "teaser" masquerading as a
  // menu and creating a false multi-menu prompt alongside a real PDF.
  if (textLooksLikeMenu(inlineText)) {
    raw.push({ type: 'text', ref: '', hint: 'Main Menu', source: 'homepage' });
  }
  for (const pdf of scrape.menuPdfUrls ?? []) {
    raw.push({ type: 'pdf', ref: pdf, hint: hintFromUrl(pdf), source: 'homepage' });
  }
  for (const link of scrape.menuLinks ?? []) {
    raw.push({ type: 'subpage', ref: link, hint: hintFromUrl(link), source: 'subpage' });
  }
  // Collapse ALL page images into a SINGLE image candidate (extraction passes
  // the full image set to vision). Avoids a false multi-menu picker full of
  // photos, and keeps image menus (e.g. Squarespace boards) selectable.
  const firstImage = (scrape.menuImages ?? [])[0];
  if (firstImage) {
    raw.push({ type: 'image', ref: firstImage, hint: 'Menu Images', source: 'homepage' });
  }

  // De-dupe by ref (text has empty ref → keep one).
  const seen = new Set<string>();
  const deduped = raw.filter((r) => {
    const key = `${r.type}|${r.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (deduped.length === 0) {
    return { candidates: [], inlineText, restaurantTitle: scrape.title, finalUrl, screenshotUrl: scrape.screenshotUrl };
  }

  // Label + distinctness via Haiku. Failures degrade to keeping everything.
  let labeled: Array<{ ref: string; label: string; isDistinctMenu: boolean }>;
  try {
    labeled = await labelMenuCandidates(
      deduped.map((r) => ({ ref: `${r.type}|${r.ref}`, hint: r.hint, type: r.type })),
      scrape.title
    );
  } catch {
    labeled = deduped.map((r) => ({ ref: `${r.type}|${r.ref}`, label: r.hint || 'Menu', isDistinctMenu: true }));
  }

  const candidates: MenuCandidate[] = deduped
    .map((r, i) => {
      const key = `${r.type}|${r.ref}`;
      const match = labeled.find((l) => l.ref === key) ?? labeled[i];
      return {
        candidate: {
          id: candidateId(r.type, r.ref),
          label: match?.label || r.hint || 'Menu',
          type: r.type,
          ref: r.ref,
          source: r.source,
        } as MenuCandidate,
        isDistinct: match?.isDistinctMenu ?? true,
      };
    })
    // Drop non-menu links (nav/about/etc.). Always keep inline text, PDFs, and
    // the single image candidate, which are rarely false positives — so we never
    // strip the only real menu (e.g. an image-only site).
    .filter(
      (c) => c.isDistinct || c.candidate.type === 'text' || c.candidate.type === 'pdf' || c.candidate.type === 'image'
    )
    .map((c) => c.candidate);

  // De-dupe by id (different refs could hash-collide on label only — defensive).
  const byId = new Map<string, MenuCandidate>();
  for (const c of candidates) if (!byId.has(c.id)) byId.set(c.id, c);
  const finalCandidates = Array.from(byId.values());

  // Guarantee at least one candidate when any content exists, so the single-menu
  // path always has something to extract (covers teaser text / screenshot-only).
  if (finalCandidates.length === 0) {
    if (inlineText.length >= 100) {
      finalCandidates.push({ id: candidateId('text', ''), label: 'Menu', type: 'text', ref: '', source: 'homepage' });
    } else if (scrape.screenshotUrl) {
      finalCandidates.push({ id: candidateId('image', scrape.screenshotUrl), label: 'Menu', type: 'image', ref: scrape.screenshotUrl, source: 'homepage' });
    }
  }

  return {
    candidates: finalCandidates,
    inlineText,
    restaurantTitle: scrape.title,
    finalUrl,
    screenshotUrl: scrape.screenshotUrl,
  };
}
