import { createClient } from '@supabase/supabase-js';
import type {
  Restaurant,
  MenuSection,
  Dish,
  ClassifiedMenu,
  RawSection,
  RawDish,
  DiscoveryPayload,
  DietaryClassification,
  MenuCandidate,
  EvalCase,
  EvalMenuCandidate,
  EvalDish,
  MenuCandidateVerdict,
  FeedbackItem,
  FeedbackStatus,
  DishReportSummary,
  RestaurantStatus,
  NoMenuReason,
} from '@/types';
import type { AIUsage } from './ai';
import { computeReviewFlags, isPubliclyVisible, MIN_GUIDE_DISHES } from './review-flags';
import { guideInsights } from './menu-insights';
import {
  verifyVegClassifications,
  classifyMenuFromImageBuffers,
  classifyMenuFromPdfBuffer,
  countFoodItems,
  sniffImageType,
  ESCALATION_MODEL,
} from './ai';
import { REPORT_COUNT_WARNING_THRESHOLD } from './dietary-config';
import { scrapeRestaurant } from './scraper';
import { extractMenuResumable, sumUsage, looksLikeHeaderItems, MIN_FOOD_ITEMS, type ExtractContext } from './menu-extract';

let _client: ReturnType<typeof createClient> | null = null;

// Typed as any to avoid Supabase schema inference errors (no generated types)
// eslint-disable-next-line
function db(): any {
  if (!_client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error(
        'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local'
      );
    }
    _client = createClient(url, key);
  }
  return _client;
}

// Exported for tests. `\/+` (not `\/\/`) deliberately eats ANY number of
// slashes after the protocol — a malformed "https:///site.com" (stray extra
// slash, e.g. from string-concatenation elsewhere) must normalize the same
// as "https://site.com", or findExistingRestaurant silently creates a
// duplicate restaurant instead of recognising it (happened in production
// with isaacsrestaurant.ie, three separate rows for one site).
export function normalizeUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/+(www\.)?/, '')
    .replace(/\/+$/, '');
}

// Hosts where MANY distinct restaurants live under one domain (hosted ordering
// platforms, maps, social, review sites). We must NOT collapse these to the
// bare host, or two unrelated restaurants would merge into one — so for them
// the full path stays part of the identity. Everything else is treated as a
// dedicated restaurant domain whose subpages (/menu, /, /menu/lunch, ...) are
// all the same restaurant.
const SHARED_PLATFORM_HOST_RE =
  /(^|\.)(toasttab\.com|square\.site|mryum\.com|bopple\.com|storekit\.com|flipdish\.[a-z.]+|google\.[a-z.]+|goo\.gl|instagram\.com|facebook\.com|fb\.com|yelp\.[a-z.]+|tripadvisor\.[a-z.]+|linktr\.ee|linktree\.[a-z.]+)$/i;

// Registrable host, www-stripped, scheme-agnostic. Returns null if the input
// can't be parsed as a URL (falls back to the legacy full-string normalizer).
function restaurantHost(url: string): string | null {
  try {
    const trimmed = url.trim();
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

function isSharedPlatformHost(host: string): boolean {
  return /^(order|orders|ordering)\./i.test(host) || SHARED_PLATFORM_HOST_RE.test(host);
}

// The identity key used to dedup restaurants. A dedicated restaurant domain
// collapses every subpage / www / scheme variant to its bare root host, so
// `dohertysbar.ie/menu/`, `https://dohertysbar.ie`, `www.dohertysbar.ie` all
// share ONE key. Shared platforms keep their full normalized path so distinct
// restaurants on a common host remain distinct.
export function restaurantDedupKey(url: string): string {
  const host = restaurantHost(url);
  if (!host) return normalizeUrl(url);
  if (isSharedPlatformHost(host)) return normalizeUrl(url);
  return host;
}

// The URL we STORE as a restaurant's identity: a clean, valid, clickable root
// link (`https://<host>`) for a dedicated domain, with subpages stripped; or
// the URL as submitted for shared platforms, where the path IS the identity.
// The actual menu page is preserved separately in `menu_url` / `canonical_url`.
export function canonicalRestaurantUrl(url: string): string {
  const host = restaurantHost(url);
  if (!host) return url.trim();
  if (isSharedPlatformHost(host)) return url.trim();
  return `https://${host}`;
}

type DbRestaurantRow = {
  id: string;
  url: string;
  canonical_url: string | null;
  last_scraped_at: string | null;
  status: string;
  no_menu_reason: string | null;
  no_menu_confirmed_at: string | null;
};

type DbRow = Record<string, unknown>;

/**
 * Pure matching helper for findExistingRestaurant (unit-tested). Reconstructing
 * a handful of candidate URL strings and exact-matching them (the previous
 * approach) missed anything a fixed candidate list didn't anticipate — a
 * missing trailing slash was enough to create a duplicate restaurant
 * (happened in production with galleon.ie). Comparing normalized forms
 * against every row is what a diner would consider "obviously the same
 * site" and catches both a differently-formatted url AND a url that happens
 * to equal another restaurant's already-resolved canonical_url.
 */
export function findMatchingRestaurantId(
  targetUrl: string,
  rows: Array<{ id: string; url: string; canonical_url: string | null }>
): string | null {
  // Primary: dedup-key match — collapses subpages/www/scheme of a dedicated
  // domain (the dohertysbar.ie/menu vs dohertysbar.ie duplicate), while
  // keeping shared-platform restaurants distinct.
  const key = restaurantDedupKey(targetUrl);
  const byKey = rows.find(
    (r) =>
      restaurantDedupKey(r.url) === key ||
      (r.canonical_url != null && restaurantDedupKey(r.canonical_url) === key)
  );
  if (byKey) return byKey.id;

  // Fallback: legacy normalized full-URL match (covers any pre-existing row
  // whose url still carries a path, and the canonical_url-equality case).
  const normalized = normalizeUrl(targetUrl);
  const byUrl = rows.find(
    (r) =>
      normalizeUrl(r.url) === normalized ||
      (r.canonical_url != null && normalizeUrl(r.canonical_url) === normalized)
  );
  return byUrl ? byUrl.id : null;
}

export async function findExistingRestaurant(
  url: string
): Promise<{
  id: string;
  status: string;
  lastScrapedAt: string | null;
  noMenuReason: NoMenuReason | null;
  noMenuConfirmedAt: string | null;
} | null> {
  // Small table (low hundreds of rows at this project's scale) — comparing
  // normalized forms in JS is simpler and far more robust than trying to
  // enumerate every URL-formatting variant as a separate DB query.
  const { data } = await db()
    .from('restaurants')
    .select('id, url, canonical_url, last_scraped_at, status, no_menu_reason, no_menu_confirmed_at');
  const rows = (data ?? []) as DbRestaurantRow[];

  const matchId = findMatchingRestaurantId(url, rows);
  if (!matchId) return null;

  const row = rows.find((r) => r.id === matchId)!;
  return {
    id: row.id,
    status: row.status,
    lastScrapedAt: row.last_scraped_at,
    noMenuReason: (row.no_menu_reason as NoMenuReason | null) ?? null,
    noMenuConfirmedAt: row.no_menu_confirmed_at ?? null,
  };
}

export async function resetRestaurantForReparse(id: string): Promise<void> {
  await db()
    .from('restaurants')
    .update({
      status: 'processing',
      error_message: null,
      menu_candidates: null,
      candidates_at: null,
      // A fresh reparse starts clean — clear any prior no_menu verdict so a
      // user-triggered "I know where the menu is" retry isn't pinned to it.
      no_menu_reason: null,
      no_menu_confirmed_at: null,
    })
    .eq('id', id);
}

export async function saveMenuCandidates(
  restaurantId: string,
  payload: DiscoveryPayload
): Promise<void> {
  const { error } = await db()
    .from('restaurants')
    .update({
      menu_candidates: payload,
      candidates_at: new Date().toISOString(),
      status: 'processing',
    })
    .eq('id', restaurantId);
  // Surface failures (e.g. the menu_candidates column not yet migrated) so the
  // caller can fall back to inline analysis instead of emitting a candidate
  // list it can't honour later.
  if (error) throw new Error(`Failed to persist menu candidates: ${error.message}`);
}

export async function getMenuCandidates(restaurantId: string): Promise<DiscoveryPayload | null> {
  const { data } = await db()
    .from('restaurants')
    .select('menu_candidates')
    .eq('id', restaurantId)
    .maybeSingle();
  const payload = (data as { menu_candidates: unknown } | null)?.menu_candidates;
  if (!payload) return null;
  return payload as DiscoveryPayload;
}

export async function fetchRestaurantWithDishes(
  id: string,
  options?: { includeDeleted?: boolean }
): Promise<Restaurant | null> {
  const { data: r } = await db().from('restaurants').select('*').eq('id', id).single();
  if (!r) return null;

  const { data: rawSections } = await db()
    .from('menu_sections')
    .select('*')
    .eq('restaurant_id', id)
    .order('display_order');

  // Soft-deleted dishes are excluded everywhere users see — only the admin
  // review screen (includeDeleted) gets them, to show/restore.
  let dishesQuery = db().from('dishes').select('*').eq('restaurant_id', id).order('created_at');
  if (!options?.includeDeleted) dishesQuery = dishesQuery.is('deleted_at', null);
  const { data: rawDishes } = await dishesQuery;

  const sections = (rawSections ?? []) as DbRow[];
  const dishes = (rawDishes ?? []) as DbRow[];

  const sectionList: MenuSection[] = sections.map((s) => ({
    id: s.id as string,
    name: s.name as string,
    displayOrder: s.display_order as number,
    menuLabel: (s.menu_label as string | null) ?? null,
    dishes: dishes.filter((d) => d.section_id === s.id).map(mapDish),
  }));

  const unsectionedDishes = dishes.filter((d) => !d.section_id).map(mapDish);
  if (unsectionedDishes.length > 0) {
    sectionList.push({ id: 'unsectioned', name: 'Menu', displayOrder: 999, dishes: unsectionedDishes });
  }

  return {
    id: r.id,
    url: r.url,
    canonicalUrl: r.canonical_url,
    name: r.name,
    city: r.city,
    lastScrapedAt: r.last_scraped_at,
    menuUrl: r.menu_url,
    status: r.status,
    errorMessage: r.error_message,
    noMenuReason: (r.no_menu_reason as NoMenuReason | null) ?? null,
    noMenuConfirmedAt: r.no_menu_confirmed_at ?? null,
    cuisine: r.cuisine ?? null,
    guideApprovedAt: r.guide_approved_at ?? null,
    sections: sectionList,
    createdAt: r.created_at,
  };
}

function mapDish(d: DbRow): Dish {
  return {
    id: d.id as string,
    name: d.name as string,
    description: d.description as string | null,
    price: d.price as string | null,
    classification: d.classification as Dish['classification'],
    confidence: d.confidence as number,
    confidenceReason: d.confidence_reason as string | null,
    reportCount: d.report_count as number,
    warningFlagged: d.warning_flagged as boolean,
    sectionId: d.section_id as string | undefined,
    humanVerified: (d.human_verified as boolean) ?? false,
    reviewerNotes: (d.reviewer_notes as string | null) ?? null,
    origin: ((d.origin as string) === 'admin' ? 'admin' : 'ai'),
    aiClassification: (d.ai_classification as DietaryClassification | null) ?? null,
    deletedAt: (d.deleted_at as string | null) ?? null,
  };
}

/**
 * Pure matching helper for the saveClassifiedMenu reparse-preservation fix
 * (unit-tested in tests/reconcile-verified-dishes.test.ts). For each
 * previously human_verified dish, find its counterpart among the freshly
 * inserted AI dishes: prefer a same-section name match (handles a dish
 * staying put), fall back to a name-only match (handles a section rename),
 * and report no match at all when the dish is a genuine admin add/removal
 * target that the new extraction simply doesn't contain.
 */
export function matchVerifiedDishes(
  verified: Array<{ name: string; sectionName: string | null }>,
  candidates: Array<{ id: string; name: string; sectionName: string | null }>
): Array<{ verifiedIndex: number; matchId: string | null }> {
  const norm = (s: string) => s.toLowerCase().trim();
  return verified.map((v, verifiedIndex) => {
    const bySection = candidates.find(
      (c) => norm(c.name) === norm(v.name) && (c.sectionName ?? null) === (v.sectionName ?? null)
    );
    if (bySection) return { verifiedIndex, matchId: bySection.id };
    const byNameOnly = candidates.find((c) => norm(c.name) === norm(v.name));
    return { verifiedIndex, matchId: byNameOnly ? byNameOnly.id : null };
  });
}

export async function createRestaurantRecord(url: string, city = 'dublin'): Promise<string> {
  // Store the clean root URL as the identity (subpages stripped for dedicated
  // domains, kept as-is for shared platforms) and stamp the dedup key so the
  // unique index enforces one-row-per-restaurant at write time.
  const { data, error } = await db()
    .from('restaurants')
    .insert({
      url: canonicalRestaurantUrl(url),
      city,
      status: 'processing',
      dedup_key: restaurantDedupKey(url),
    })
    .select('id')
    .single();
  if (error) throw new Error(`Failed to create restaurant: ${error.message}`);
  return (data as { id: string }).id;
}

/**
 * Record API spend in the append-only ai_usage_log — called on successful
 * saves AND on failed analyses (failed retry ladders are the most expensive
 * path, so skipping them made spend reports undercount badly).
 * Best-effort: a logging failure must never fail the analysis itself.
 */
export async function logUsage(
  restaurantId: string | null,
  url: string | null,
  usage: AIUsage,
  restaurantName?: string | null
): Promise<void> {
  if (!usage.costUsd && !usage.tokensIn && !usage.tokensOut) return;
  try {
    await db().from('ai_usage_log').insert({
      restaurant_id: restaurantId,
      restaurant_name: restaurantName ?? null,
      url,
      model_used: usage.model,
      tokens_in: usage.tokensIn,
      tokens_out: usage.tokensOut,
      cost_usd: usage.costUsd,
    });
  } catch (err) {
    console.error('[db] ai_usage_log insert failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

/**
 * Passive parse-attempt telemetry — one row at the end of every real
 * discover/analyze call, success or failure. Every user search becomes
 * coverage data on which sites work. Best-effort: a logging failure must
 * never fail the parse itself (and must not fail before the table's
 * migration has been applied).
 */
export async function logParseAttempt(attempt: {
  url: string;
  stage: 'discover' | 'analyze';
  category?: string | null;
  success: boolean;
  errorMessage?: string | null;
  durationMs?: number;
}): Promise<void> {
  try {
    let domain: string | null = null;
    try {
      domain = new URL(attempt.url).hostname.replace(/^www\./, '');
    } catch {}
    await db().from('parse_attempts').insert({
      url: attempt.url,
      domain,
      stage: attempt.stage,
      category: attempt.category ?? null,
      success: attempt.success,
      error_message: attempt.errorMessage ?? null,
      duration_ms: attempt.durationMs ?? null,
    });
  } catch (err) {
    console.error('[db] parse_attempts insert failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}

export async function saveClassifiedMenu(
  restaurantId: string,
  url: string,
  menuUrl: string | null,
  menu: ClassifiedMenu,
  usage?: AIUsage
): Promise<void> {
  await db()
    .from('restaurants')
    .update({
      name: menu.restaurantName || null,
      canonical_url: url,
      menu_url: menuUrl,
      status: 'done',
      last_scraped_at: new Date().toISOString(),
      // Only overwrite cuisine when this run actually detected one, so a reparse
      // that omits it doesn't wipe a good existing value.
      ...(menu.cuisine ? { cuisine: menu.cuisine } : {}),
      ...(usage && {
        model_used: usage.model,
        tokens_in: usage.tokensIn,
        tokens_out: usage.tokensOut,
        cost_usd: usage.costUsd,
      }),
    })
    .eq('id', restaurantId);

  // Append-only spend log — survives restaurant wipes (no FK by design).
  if (usage) await logUsage(restaurantId, url, usage, menu.restaurantName || null);

  // --- human_verified preservation (the saveClassifiedMenu "landmine" fix) ---
  // Snapshot section names BEFORE anything is deleted, so we can key each
  // verified dish by (name, section name) the way an admin would recognise it.
  const { data: oldSectionRows } = await db()
    .from('menu_sections')
    .select('id, name')
    .eq('restaurant_id', restaurantId);
  const oldSectionNameById = new Map<string, string>(
    ((oldSectionRows ?? []) as DbRow[]).map((s) => [s.id as string, s.name as string])
  );

  const { data: verifiedRows } = await db()
    .from('dishes')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .eq('human_verified', true);
  const verifiedDishes = ((verifiedRows ?? []) as DbRow[]).map((d) => ({
    name: d.name as string,
    sectionName: d.section_id ? (oldSectionNameById.get(d.section_id as string) ?? null) : null,
    classification: d.classification as DietaryClassification,
    confidence: d.confidence as number,
    confidenceReason: (d.confidence_reason as string | null) ?? null,
    reviewerNotes: (d.reviewer_notes as string | null) ?? null,
    price: (d.price as string | null) ?? null,
    description: (d.description as string | null) ?? null,
    // Provenance carried across the reparse so it's never lost, and so an
    // admin's soft-delete sticks instead of the dish being re-extracted live.
    origin: ((d.origin as string) === 'admin' ? 'admin' : 'ai') as 'ai' | 'admin',
    aiClassification: (d.ai_classification as DietaryClassification | null) ?? null,
    deletedAt: (d.deleted_at as string | null) ?? null,
  }));

  await db().from('dishes').delete().eq('restaurant_id', restaurantId);
  await db().from('menu_sections').delete().eq('restaurant_id', restaurantId);

  for (let i = 0; i < menu.sections.length; i++) {
    const section: RawSection = menu.sections[i];

    let { data: sectionRow } = await db()
      .from('menu_sections')
      .insert({ restaurant_id: restaurantId, name: section.name, display_order: i, menu_label: section.menuLabel ?? null })
      .select('id')
      .single();

    // Degrade gracefully when the menu_label column is unmigrated.
    if (!sectionRow) {
      const retry = await db()
        .from('menu_sections')
        .insert({ restaurant_id: restaurantId, name: section.name, display_order: i })
        .select('id')
        .single();
      sectionRow = retry.data;
    }

    if (!sectionRow) continue;

    const dishRows = section.dishes.map((d: RawDish) => ({
      restaurant_id: restaurantId,
      section_id: sectionRow.id,
      name: d.name,
      description: d.description ?? null,
      price: d.price ?? null,
      classification: d.classification,
      confidence: d.confidence,
      confidence_reason: d.reason ?? null,
      // Fresh AI extraction: record what the AI classified it as.
      origin: 'ai',
      ai_classification: d.classification,
    }));

    if (dishRows.length > 0) {
      await db().from('dishes').insert(dishRows);
    }
  }

  if (verifiedDishes.length > 0) {
    const { data: newSectionRows } = await db()
      .from('menu_sections')
      .select('id, name')
      .eq('restaurant_id', restaurantId);
    const newSections = (newSectionRows ?? []) as DbRow[];
    const newSectionNameById = new Map<string, string>(newSections.map((s) => [s.id as string, s.name as string]));
    const sectionIdByName = new Map<string, string>(newSections.map((s) => [s.name as string, s.id as string]));

    const { data: newDishRows } = await db()
      .from('dishes')
      .select('id, name, section_id')
      .eq('restaurant_id', restaurantId);
    const candidates = ((newDishRows ?? []) as DbRow[]).map((d) => ({
      id: d.id as string,
      name: d.name as string,
      sectionName: d.section_id ? (newSectionNameById.get(d.section_id as string) ?? null) : null,
    }));

    const matches = matchVerifiedDishes(
      verifiedDishes.map((v) => ({ name: v.name, sectionName: v.sectionName })),
      candidates
    );

    for (const m of matches) {
      const v = verifiedDishes[m.verifiedIndex];
      if (m.matchId) {
        // Re-apply the human verdict onto the freshly-inserted AI row. Carrying
        // deleted_at means an admin's removal sticks (the re-extracted row is
        // marked deleted again instead of coming back live). Keep the original
        // AI guess if we captured one.
        await db()
          .from('dishes')
          .update({
            classification: v.classification,
            confidence: v.confidence,
            confidence_reason: v.confidenceReason,
            human_verified: true,
            reviewer_notes: v.reviewerNotes,
            deleted_at: v.deletedAt,
            ...(v.aiClassification && { ai_classification: v.aiClassification }),
          })
          .eq('id', m.matchId);
      } else {
        // No match in the new extraction at all — this was a deliberate human
        // add/correction, so keep it rather than silently dropping it. Flag it
        // lightly (non-destructive) so the admin review screen can surface it.
        const staleNote = v.reviewerNotes
          ? `${v.reviewerNotes} (verified dish no longer matched the latest extraction)`
          : 'Verified dish no longer matched the latest extraction — kept from a previous human review.';
        await db()
          .from('dishes')
          .insert({
            restaurant_id: restaurantId,
            section_id: v.sectionName ? (sectionIdByName.get(v.sectionName) ?? null) : null,
            name: v.name,
            description: v.description,
            price: v.price,
            classification: v.classification,
            confidence: v.confidence,
            confidence_reason: v.confidenceReason,
            human_verified: true,
            reviewer_notes: staleNote,
            origin: v.origin,
            ai_classification: v.aiClassification,
            deleted_at: v.deletedAt,
          });
      }
    }
  }
}

export async function markRestaurantError(restaurantId: string, message: string): Promise<void> {
  await db()
    .from('restaurants')
    .update({ status: 'error', error_message: message })
    .eq('id', restaurantId);
}

/**
 * Terminal "no menu / dead site" outcome — distinct from an error. Used when the
 * site is up but publishes no readable menu ('not_listed') or is down/not-live
 * ('unavailable'). Unlike markRestaurantError, this sets last_scraped_at so the
 * discover-route freshness check will short-circuit the NEXT search instead of
 * re-running the paid pipeline (an 'error' row is re-analyzed every search — the
 * cost leak this fixes). The message is stored for context but the results page
 * renders from no_menu_reason. Preserves any existing admin confirmation.
 */
export async function markRestaurantNoMenu(
  restaurantId: string,
  reason: NoMenuReason,
  message: string
): Promise<void> {
  await db()
    .from('restaurants')
    .update({
      status: 'no_menu',
      no_menu_reason: reason,
      error_message: message,
      last_scraped_at: new Date().toISOString(),
    })
    .eq('id', restaurantId);
}

/**
 * Admin confirms a no_menu outcome (optionally re-labelling the reason, e.g.
 * 'closed' for a shut restaurant). Sets no_menu_confirmed_at so the result
 * becomes STICKY — future searches return the cached answer forever, past the
 * 30-day staleness window, with zero AI spend.
 */
export async function confirmNoMenu(restaurantId: string, reason: NoMenuReason): Promise<void> {
  const { error } = await db()
    .from('restaurants')
    .update({
      status: 'no_menu',
      no_menu_reason: reason,
      no_menu_confirmed_at: new Date().toISOString(),
      last_scraped_at: new Date().toISOString(),
    })
    .eq('id', restaurantId);
  if (error) throw new Error(`Failed to confirm no-menu: ${error.message}`);
}

export async function reportDish(
  dishId: string,
  issueType: string,
  notes: string,
  ipHash: string,
  anonId?: string | null
): Promise<void> {
  const row = {
    dish_id: dishId,
    issue_type: issueType,
    notes: notes ?? null,
    ip_hash: ipHash,
  };
  const { error } = await db().from('dish_reports').insert({ ...row, anon_id: anonId ?? null });
  // Degrade gracefully when the anon_id column is unmigrated.
  if (error) {
    const retry = await db().from('dish_reports').insert(row);
    if (retry.error) throw new Error(`Failed to save report: ${retry.error.message}`);
  }

  const { data: dish } = await db().from('dishes').select('report_count').eq('id', dishId).single();
  const newCount = ((dish as DbRow)?.report_count as number ?? 0) + 1;
  await db()
    .from('dishes')
    .update({ report_count: newCount, warning_flagged: newCount >= REPORT_COUNT_WARNING_THRESHOLD })
    .eq('id', dishId);
}

export async function submitFeedback(
  restaurantId: string | null,
  restaurantName: string | null,
  feedbackType: string,
  notes: string,
  ipHash: string,
  anonId?: string | null,
  city?: string | null
): Promise<void> {
  const row = {
    restaurant_id: restaurantId, // null for guide-level feedback
    restaurant_name: restaurantName,
    feedback_type: feedbackType,
    notes: notes || null,
    ip_hash: ipHash,
    city: city ?? null,
  };
  const { error } = await db().from('restaurant_feedback').insert({ ...row, anon_id: anonId ?? null });
  // Degrade gracefully when the anon_id / city columns aren't migrated yet.
  if (error) {
    const { city: _city, ...base } = row;
    const retry = await db().from('restaurant_feedback').insert(base);
    if (retry.error) throw new Error(`Failed to save feedback: ${retry.error.message}`);
  }
}

export async function saveNpsResponse(
  anonId: string | null,
  score: number,
  notes: string
): Promise<void> {
  const { error } = await db().from('nps_responses').insert({
    anon_id: anonId,
    score,
    notes: notes || null,
  });
  if (error) throw new Error(`Failed to save NPS response: ${error.message}`);
}

export async function getFeaturedRestaurants(city: string): Promise<Restaurant[]> {
  const { data } = await db()
    .from('featured_restaurants')
    .select('restaurant_id, display_order')
    .eq('city', city)
    .order('display_order');

  const rows = (data ?? []) as Array<{ restaurant_id: string; display_order: number }>;
  if (!rows.length) return [];

  const results = (await Promise.all(rows.map((r) => fetchRestaurantWithDishes(r.restaurant_id)))).filter(
    Boolean
  ) as Restaurant[];

  // Rank best-for-vegetarians first: by the best SINGLE menu's veg count (a diner
  // only sees one menu per visit), tie-broken by the curated display order.
  const orderById = new Map(rows.map((r) => [r.restaurant_id, r.display_order]));
  return results.sort((a, b) => {
    const diff = guideInsights(b).maxVegOptions - guideInsights(a).maxVegOptions;
    if (diff !== 0) return diff;
    return (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0);
  });
}

// ============================================================
// Admin dashboard + eval infrastructure
// ============================================================

/**
 * Find (or create) the durable eval_case for a restaurant URL — the anchor
 * row every human verdict (dish or menu-candidate) auto-grows onto. Uses a
 * plain select-then-insert (not a DB-level upsert) to stay consistent with
 * the rest of this file's style; the unique index on lower(url) is the
 * safety net against a rare race, not the primary mechanism.
 */
async function ensureEvalCase(url: string, name?: string | null, city?: string | null): Promise<string> {
  const { data: existing } = await db().from('eval_cases').select('id').ilike('url', url).maybeSingle();
  if (existing) return (existing as { id: string }).id;

  const { data, error } = await db().from('eval_cases').insert({ url, name: name ?? null, city: city ?? null }).select('id').single();
  if (!error && data) return (data as { id: string }).id;

  // Unique-violation race (two verdicts landing on a brand-new case at once) — refetch.
  const { data: retry } = await db().from('eval_cases').select('id').ilike('url', url).maybeSingle();
  if (retry) return (retry as { id: string }).id;
  throw new Error(`Failed to create eval_case for ${url}: ${error?.message ?? 'unknown error'}`);
}

/** Read-only lookup (does NOT create) — used to prefill the "menus we're
 *  missing" field on the review screen without growing the eval set just by
 *  viewing the page. */
export async function getEvalCaseByUrl(url: string): Promise<EvalCase | null> {
  const { data } = await db().from('eval_cases').select('*').ilike('url', url).maybeSingle();
  if (!data) return null;
  const r = data as DbRow;
  return {
    id: r.id as string,
    url: r.url as string,
    name: (r.name as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    missedMenus: (r.missed_menus as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    menusReviewedAt: (r.menus_reviewed_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/** Lightweight restaurant identity lookup (no dishes/sections) — admin write
 *  routes use this as the server-side source of truth for url/name/city
 *  instead of trusting client-supplied copies of the same fields. */
export async function getRestaurantMeta(
  id: string
): Promise<{ id: string; url: string; canonicalUrl: string | null; name: string | null; city: string; status: string } | null> {
  const { data } = await db().from('restaurants').select('id, url, canonical_url, name, city, status').eq('id', id).maybeSingle();
  if (!data) return null;
  const r = data as DbRow;
  return {
    id: r.id as string,
    url: r.url as string,
    canonicalUrl: (r.canonical_url as string | null) ?? null,
    name: (r.name as string | null) ?? null,
    city: r.city as string,
    status: r.status as string,
  };
}

/** Per-restaurant review + feedback badges shown in the admin restaurant lists. */
export interface RestaurantReviewInfo {
  /** Menu discovery has been human-signed-off (eval_case.menus_reviewed_at). */
  menusReviewed: boolean;
  reviewedDishes: number;
  totalDishes: number;
  /** Open (unresolved) feedback: dish reports + restaurant feedback. */
  openFeedbackCount: number;
}

export type RestaurantListItem = {
  id: string;
  name: string | null;
  url: string;
  status: string;
  lastScrapedAt: string | null;
} & RestaurantReviewInfo;

/**
 * Batch-builds the review + feedback badges for a set of restaurants in a fixed
 * number of queries (not one per restaurant). Menu-review status lives on the
 * URL-keyed eval_case, so we match by normalized URL (same normalizeUrl used for
 * dedup) against canonical_url first, then url.
 */
async function buildRestaurantReviewInfo(
  restaurants: Array<{ id: string; url: string; canonicalUrl: string | null }>
): Promise<Map<string, RestaurantReviewInfo>> {
  const ids = restaurants.map((r) => r.id);
  const info = new Map<string, RestaurantReviewInfo>();
  for (const r of restaurants) info.set(r.id, { menusReviewed: false, reviewedDishes: 0, totalDishes: 0, openFeedbackCount: 0 });
  if (ids.length === 0) return info;

  // Dishes (total + human-verified) per restaurant, and dish→restaurant map for reports.
  const { data: dishRows } = await db()
    .from('dishes')
    .select('id, restaurant_id, human_verified')
    .in('restaurant_id', ids)
    .is('deleted_at', null);
  const dishToRestaurant = new Map<string, string>();
  for (const d of (dishRows ?? []) as DbRow[]) {
    const rid = d.restaurant_id as string;
    dishToRestaurant.set(d.id as string, rid);
    const entry = info.get(rid);
    if (entry) {
      entry.totalDishes++;
      if (d.human_verified) entry.reviewedDishes++;
    }
  }

  // Menu-review status via URL-keyed eval_cases.
  const { data: evalCaseRows } = await db().from('eval_cases').select('url, menus_reviewed_at');
  const reviewedUrls = new Set<string>();
  for (const c of (evalCaseRows ?? []) as DbRow[]) {
    if (c.menus_reviewed_at) reviewedUrls.add(normalizeUrl(c.url as string));
  }
  for (const r of restaurants) {
    const norm = normalizeUrl(r.canonicalUrl ?? r.url);
    const normUrl = normalizeUrl(r.url);
    if (reviewedUrls.has(norm) || reviewedUrls.has(normUrl)) info.get(r.id)!.menusReviewed = true;
  }

  // Open dish reports (mapped to restaurant via dish) + open restaurant feedback.
  const dishIds = Array.from(dishToRestaurant.keys());
  if (dishIds.length > 0) {
    const { data: reportRows } = await db().from('dish_reports').select('dish_id').eq('status', 'open').in('dish_id', dishIds);
    for (const rep of (reportRows ?? []) as DbRow[]) {
      const rid = dishToRestaurant.get(rep.dish_id as string);
      if (rid && info.has(rid)) info.get(rid)!.openFeedbackCount++;
    }
  }
  const { data: fbRows } = await db().from('restaurant_feedback').select('restaurant_id').eq('status', 'open').in('restaurant_id', ids);
  for (const f of (fbRows ?? []) as DbRow[]) {
    const rid = f.restaurant_id as string;
    if (info.has(rid)) info.get(rid)!.openFeedbackCount++;
  }

  return info;
}

export interface NoMenuQueueItem {
  id: string;
  name: string | null;
  url: string;
  reason: NoMenuReason | null;
  lastScrapedAt: string | null;
  /** Open feedback on this restaurant — e.g. a user insisting there IS a menu. */
  openFeedbackCount: number;
}

/** Restaurants in the 'no_menu' state that an admin hasn't confirmed yet — the
 *  queue to sign off ("yes, genuinely no menu" → sticky) or overturn (add the
 *  real menu). Unconfirmed rows already stop re-analysis for 30 days; confirming
 *  makes that permanent. */
export async function getNoMenuQueue(): Promise<NoMenuQueueItem[]> {
  const { data } = await db()
    .from('restaurants')
    .select('id, name, url, canonical_url, no_menu_reason, last_scraped_at')
    .eq('status', 'no_menu')
    .is('no_menu_confirmed_at', null)
    .order('last_scraped_at', { ascending: false });
  const rows = (data ?? []) as DbRow[];
  const reviewInfo = await buildRestaurantReviewInfo(
    rows.map((r) => ({ id: r.id as string, url: r.url as string, canonicalUrl: (r.canonical_url as string | null) ?? null }))
  );
  return rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string | null) ?? null,
    url: r.url as string,
    reason: (r.no_menu_reason as NoMenuReason | null) ?? null,
    lastScrapedAt: (r.last_scraped_at as string | null) ?? null,
    openFeedbackCount: reviewInfo.get(r.id as string)?.openFeedbackCount ?? 0,
  }));
}

export interface AdminDashboardStats {
  recentRestaurants: RestaurantListItem[];
  todaySpendUsd: number;
  errorRatePct: number | null;
  openFeedbackCount: number;
  /** No-menu / dead-site restaurants awaiting admin confirmation. */
  noMenuQueue: NoMenuQueueItem[];
}

export async function getAdminDashboardStats(): Promise<AdminDashboardStats> {
  const { data: recent } = await db()
    .from('restaurants')
    .select('id, name, url, canonical_url, status, last_scraped_at')
    .order('created_at', { ascending: false })
    .limit(10);
  const recentRows = (recent ?? []) as DbRow[];
  const reviewInfo = await buildRestaurantReviewInfo(
    recentRows.map((r) => ({ id: r.id as string, url: r.url as string, canonicalUrl: (r.canonical_url as string | null) ?? null }))
  );
  const recentRestaurants: RestaurantListItem[] = recentRows.map((r) => ({
    id: r.id as string,
    name: (r.name as string | null) ?? null,
    url: r.url as string,
    status: r.status as string,
    lastScrapedAt: (r.last_scraped_at as string | null) ?? null,
    ...reviewInfo.get(r.id as string)!,
  }));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data: spendRows } = await db().from('ai_usage_log').select('cost_usd').gte('created_at', todayStart.toISOString());
  const todaySpendUsd = ((spendRows ?? []) as DbRow[]).reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);

  const { count: totalCount } = await db().from('restaurants').select('*', { count: 'exact', head: true });
  const { count: errorCount } = await db().from('restaurants').select('*', { count: 'exact', head: true }).eq('status', 'error');
  const errorRatePct = totalCount ? ((errorCount ?? 0) / totalCount) * 100 : null;

  const { count: openDishReports } = await db().from('dish_reports').select('*', { count: 'exact', head: true }).eq('status', 'open');
  const { count: openFeedback } = await db().from('restaurant_feedback').select('*', { count: 'exact', head: true }).eq('status', 'open');
  const openFeedbackCount = (openDishReports ?? 0) + (openFeedback ?? 0);

  const noMenuQueue = await getNoMenuQueue().catch(() => [] as NoMenuQueueItem[]);

  return { recentRestaurants, todaySpendUsd, errorRatePct, openFeedbackCount, noMenuQueue };
}

/** Restaurants with fewer than this many dishes (but not zero) are flagged as a
 *  likely extraction failure — the "2 dishes when there are 50 / tasting menu
 *  returned as a single dish" tell. Heuristic tripwire, not ground truth. */
export const LOW_DISH_COUNT_THRESHOLD = 5;

export interface EvalDashboardStats {
  restaurantsTotal: number;
  // ① Menus
  restaurantsMenuReviewed: number;
  discoveryAccuracyPct: number | null;
  discoveryProblemCount: number;
  // ② Fetch health
  fetchFailures: Array<{ id: string; name: string | null; url: string; status: string; dishCount: number }>;
  // ③ Dishes found
  lowDishThreshold: number;
  lowDishRestaurants: Array<{ id: string; name: string | null; url: string; dishCount: number }>;
  // Featured but withheld from the public guide (in a guide, yet isPubliclyVisible
  // is false) — the "looks odd, review it" queue. minGuideDishes = the public bar.
  minGuideDishes: number;
  withheldFeatured: Array<{ id: string; name: string | null; url: string; cities: string[]; dishCount: number; reasons: string[] }>;
  // ④ Classification
  dishesReviewed: number;
  dishesTotal: number;
  dishAccuracyPct: number | null;
  dishAccuracyN: number;
  unsafeCount: number;
  // Restaurant list with review + feedback badges.
  restaurants: RestaurantListItem[];
}

/**
 * The Evaluation Dashboard's top-line numbers, ordered by the founder's quality
 * priorities: menus → fetch reliability → dishes found → classification. Pure DB
 * aggregates, zero LLM cost. Accuracy is honest: dish accuracy compares what the
 * AI ORIGINALLY guessed (captured at review time) against the human verdict, not
 * the live label (which the correction already overwrote).
 */
export async function getEvalDashboardStats(): Promise<EvalDashboardStats> {
  const { data: restRows } = await db()
    .from('restaurants')
    .select('id, name, url, canonical_url, status, last_scraped_at, guide_approved_at')
    .order('created_at', { ascending: false });
  const restaurants = (restRows ?? []) as DbRow[];

  // Dish counts per restaurant + overall totals (live dishes only).
  const { data: dishRows } = await db().from('dishes').select('restaurant_id, human_verified').is('deleted_at', null);
  const dishCountByRestaurant = new Map<string, number>();
  let dishesTotal = 0;
  let dishesReviewed = 0;
  for (const d of (dishRows ?? []) as DbRow[]) {
    dishesTotal++;
    if (d.human_verified) dishesReviewed++;
    const rid = d.restaurant_id as string;
    dishCountByRestaurant.set(rid, (dishCountByRestaurant.get(rid) ?? 0) + 1);
  }

  const fetchFailures: EvalDashboardStats['fetchFailures'] = [];
  const lowDishRestaurants: EvalDashboardStats['lowDishRestaurants'] = [];
  for (const r of restaurants) {
    const id = r.id as string;
    const dishCount = dishCountByRestaurant.get(id) ?? 0;
    const status = r.status as string;
    if (status === 'error' || status === 'no_menu' || (status === 'done' && dishCount === 0)) {
      fetchFailures.push({ id, name: (r.name as string | null) ?? null, url: r.url as string, status, dishCount });
    } else if (status === 'done' && dishCount > 0 && dishCount < LOW_DISH_COUNT_THRESHOLD) {
      lowDishRestaurants.push({ id, name: (r.name as string | null) ?? null, url: r.url as string, dishCount });
    }
  }

  // Featured-but-withheld queue: restaurants that ARE in a guide yet fail the
  // exact same public-visibility gate the /dublin page uses. Reusing
  // isPubliclyVisible/computeReviewFlags guarantees this list matches what
  // diners are actually not seeing. Only featured restaurants need the (heavier)
  // per-dish fetch, so this stays cheap.
  const { data: featRows } = await db().from('featured_restaurants').select('restaurant_id, city');
  const featuredCitiesById = new Map<string, string[]>();
  for (const f of (featRows ?? []) as DbRow[]) {
    const rid = f.restaurant_id as string;
    if (!featuredCitiesById.has(rid)) featuredCitiesById.set(rid, []);
    featuredCitiesById.get(rid)!.push(f.city as string);
  }
  const featuredIds = Array.from(featuredCitiesById.keys());
  const featuredDishes = new Map<string, Array<Pick<Dish, 'name' | 'description' | 'deletedAt'>>>();
  if (featuredIds.length > 0) {
    const { data: fd } = await db().from('dishes').select('restaurant_id, name, description, deleted_at').in('restaurant_id', featuredIds);
    for (const d of (fd ?? []) as DbRow[]) {
      const rid = d.restaurant_id as string;
      if (!featuredDishes.has(rid)) featuredDishes.set(rid, []);
      featuredDishes.get(rid)!.push({
        name: d.name as string,
        description: (d.description as string | null) ?? null,
        deletedAt: (d.deleted_at as string | null) ?? null,
      });
    }
  }
  const restById = new Map(restaurants.map((r) => [r.id as string, r]));
  const withheldFeatured: EvalDashboardStats['withheldFeatured'] = [];
  for (const rid of featuredIds) {
    const r = restById.get(rid);
    if (!r) continue;
    const live = (featuredDishes.get(rid) ?? []).filter((d) => !d.deletedAt);
    // Minimal restaurant shape — computeReviewFlags/isPubliclyVisible only read
    // sections[].dishes[].{name,description,deletedAt}, status and guideApprovedAt.
    const synthetic = {
      status: r.status as RestaurantStatus,
      guideApprovedAt: (r.guide_approved_at as string | null) ?? null,
      sections: [{ dishes: live as unknown as Dish[] }],
    } as Pick<Restaurant, 'sections' | 'status' | 'guideApprovedAt'>;
    if (isPubliclyVisible(synthetic)) continue;

    const reasons: string[] = [];
    const status = r.status as string;
    if (status !== 'done') reasons.push(`not fully analysed (status: ${status})`);
    else if (live.length === 0) reasons.push('0 dishes — the menu failed to read');
    else if (live.length < MIN_GUIDE_DISHES) reasons.push(`only ${live.length} dish${live.length === 1 ? '' : 'es'} (needs ${MIN_GUIDE_DISHES})`);
    for (const f of computeReviewFlags(synthetic)) {
      if (f.code === 'menu_as_dish') reasons.push(f.detail);
    }
    withheldFeatured.push({
      id: rid,
      name: (r.name as string | null) ?? null,
      url: r.url as string,
      cities: featuredCitiesById.get(rid)!,
      dishCount: live.length,
      reasons,
    });
  }

  // ① Menu discovery: reviewed count + clean rate.
  const { data: evalCaseRows } = await db().from('eval_cases').select('id, menus_reviewed_at, missed_menus');
  const evalCases = (evalCaseRows ?? []) as DbRow[];
  const reviewedCases = evalCases.filter((c) => c.menus_reviewed_at);
  const { data: candRows } = await db().from('eval_menu_candidates').select('eval_case_id, verdict');
  const problemCaseIds = new Set<string>();
  for (const c of (candRows ?? []) as DbRow[]) {
    if (c.verdict === 'spurious' || c.verdict === 'duplicate') problemCaseIds.add(c.eval_case_id as string);
  }
  let cleanReviewed = 0;
  for (const c of reviewedCases) {
    const hasMissed = !!(c.missed_menus as string | null)?.trim();
    const hasBadCandidate = problemCaseIds.has(c.id as string);
    if (!hasMissed && !hasBadCandidate) cleanReviewed++;
  }
  const restaurantsMenuReviewed = reviewedCases.length;
  const discoveryAccuracyPct = restaurantsMenuReviewed > 0 ? (cleanReviewed / restaurantsMenuReviewed) * 100 : null;
  const discoveryProblemCount = restaurantsMenuReviewed - cleanReviewed;

  // ④ Dish accuracy from ai_original vs expected (honest); unsafe = AI called a
  //    'neither' dish veg/vegan.
  const { data: evalDishRows } = await db().from('eval_dishes').select('expected_classification, ai_original_classification');
  let dishAccuracyN = 0;
  let dishCorrect = 0;
  let unsafeCount = 0;
  for (const d of (evalDishRows ?? []) as DbRow[]) {
    const ai = d.ai_original_classification as DietaryClassification | null;
    const expected = d.expected_classification as DietaryClassification;
    if (!ai) continue;
    dishAccuracyN++;
    if (ai === expected) dishCorrect++;
    if (expected === 'neither' && (ai === 'vegan' || ai === 'vegetarian')) unsafeCount++;
  }
  const dishAccuracyPct = dishAccuracyN > 0 ? (dishCorrect / dishAccuracyN) * 100 : null;

  // Restaurant list with badges (show the most recent ~25).
  const listRows = restaurants.slice(0, 25);
  const reviewInfo = await buildRestaurantReviewInfo(
    listRows.map((r) => ({ id: r.id as string, url: r.url as string, canonicalUrl: (r.canonical_url as string | null) ?? null }))
  );
  const restaurantList: RestaurantListItem[] = listRows.map((r) => ({
    id: r.id as string,
    name: (r.name as string | null) ?? null,
    url: r.url as string,
    status: r.status as string,
    lastScrapedAt: (r.last_scraped_at as string | null) ?? null,
    ...reviewInfo.get(r.id as string)!,
  }));

  return {
    restaurantsTotal: restaurants.length,
    restaurantsMenuReviewed,
    discoveryAccuracyPct,
    discoveryProblemCount,
    fetchFailures,
    lowDishThreshold: LOW_DISH_COUNT_THRESHOLD,
    lowDishRestaurants,
    minGuideDishes: MIN_GUIDE_DISHES,
    withheldFeatured,
    dishesReviewed,
    dishesTotal,
    dishAccuracyPct,
    dishAccuracyN,
    unsafeCount,
    restaurants: restaurantList,
  };
}

// ============================================================
// Unified "all restaurants" audit view — one place to see and evaluate every
// restaurant we've classified, whether a user searched it or it's curated into
// a city guide (featured_restaurants). Built to scale to thousands across many
// cities: filter by city, by guide membership, by free-text, and paginate.
// ============================================================

export type GuideFilter = 'all' | 'guide' | 'searched';

export interface AdminRestaurantRow extends RestaurantListItem {
  city: string;
  /** Cities whose guide features this restaurant (empty = user-searched only). */
  guideCities: string[];
}

export interface AdminRestaurantsResult {
  rows: AdminRestaurantRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Distinct cities present, for the filter dropdown (so new cities appear automatically). */
  cities: string[];
  /** Total restaurants that are in at least one guide (across all cities). */
  guideTotal: number;
}

export async function getAdminRestaurants(opts: {
  city?: string;
  guide?: GuideFilter;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<AdminRestaurantsResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 50));
  const guide = opts.guide ?? 'all';

  // Guide membership (small table) → id → [cities].
  const { data: featuredRows } = await db().from('featured_restaurants').select('restaurant_id, city');
  const guideCitiesById = new Map<string, string[]>();
  for (const f of (featuredRows ?? []) as DbRow[]) {
    const rid = f.restaurant_id as string;
    if (!guideCitiesById.has(rid)) guideCitiesById.set(rid, []);
    guideCitiesById.get(rid)!.push(f.city as string);
  }
  const guideIds = Array.from(guideCitiesById.keys());

  // Distinct cities for the filter (from the restaurants themselves).
  const { data: cityRows } = await db().from('restaurants').select('city');
  const cities = Array.from(new Set(((cityRows ?? []) as DbRow[]).map((r) => r.city as string).filter(Boolean))).sort();

  let query = db()
    .from('restaurants')
    .select('id, name, url, canonical_url, city, status, last_scraped_at', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (opts.city) query = query.eq('city', opts.city);
  if (opts.search) query = query.or(`name.ilike.%${opts.search}%,url.ilike.%${opts.search}%`);
  if (guide === 'guide') query = query.in('id', guideIds.length ? guideIds : ['00000000-0000-0000-0000-000000000000']);
  else if (guide === 'searched' && guideIds.length) query = query.not('id', 'in', `(${guideIds.join(',')})`);

  const from = (page - 1) * pageSize;
  query = query.range(from, from + pageSize - 1);

  const { data: restRows, count } = await query;
  const rows = (restRows ?? []) as DbRow[];

  const reviewInfo = await buildRestaurantReviewInfo(
    rows.map((r) => ({ id: r.id as string, url: r.url as string, canonicalUrl: (r.canonical_url as string | null) ?? null }))
  );

  const result: AdminRestaurantRow[] = rows.map((r) => ({
    id: r.id as string,
    name: (r.name as string | null) ?? null,
    url: r.url as string,
    status: r.status as string,
    lastScrapedAt: (r.last_scraped_at as string | null) ?? null,
    city: (r.city as string) ?? '',
    guideCities: guideCitiesById.get(r.id as string) ?? [],
    ...reviewInfo.get(r.id as string)!,
  }));

  return { rows: result, total: count ?? 0, page, pageSize, cities, guideTotal: guideIds.length };
}

/** Cities whose guide currently features this restaurant. */
export async function getGuideCities(restaurantId: string): Promise<string[]> {
  const { data } = await db().from('featured_restaurants').select('city').eq('restaurant_id', restaurantId);
  return ((data ?? []) as DbRow[]).map((r) => r.city as string);
}

/**
 * Add or remove a restaurant from a city's guide (the featured_restaurants
 * membership table). Idempotent. New entries go to the end of the guide order.
 */
export async function setGuideMembership(input: {
  restaurantId: string;
  city: string;
  featured: boolean;
}): Promise<void> {
  if (input.featured) {
    const { data: existing } = await db()
      .from('featured_restaurants')
      .select('id')
      .eq('restaurant_id', input.restaurantId)
      .eq('city', input.city)
      .maybeSingle();
    if (existing) return;
    const { data: maxRow } = await db()
      .from('featured_restaurants')
      .select('display_order')
      .eq('city', input.city)
      .order('display_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextOrder = ((maxRow as { display_order: number } | null)?.display_order ?? -1) + 1;
    await db().from('featured_restaurants').insert({ restaurant_id: input.restaurantId, city: input.city, display_order: nextOrder });
  } else {
    await db().from('featured_restaurants').delete().eq('restaurant_id', input.restaurantId).eq('city', input.city);
  }
}

/** Approve (or un-approve) a review-flagged restaurant for public display.
 *  Approval lets an odd-but-fine restaurant (e.g. a tasting menu the AI read as
 *  one "dish") appear on the public guide despite its flag; un-approving hides
 *  it again. Has no effect on the ≥7-dish gate, which is enforced separately. */
export async function setGuideApproval(restaurantId: string, approved: boolean): Promise<void> {
  const { error } = await db()
    .from('restaurants')
    .update({ guide_approved_at: approved ? new Date().toISOString() : null })
    .eq('id', restaurantId);
  if (error) throw new Error(`Failed to update guide approval: ${error.message}`);
}

/** Permanently delete a restaurant. Menus, sections, dishes, dish reports and
 *  featured_restaurants rows cascade via ON DELETE CASCADE. Wipe-safe records
 *  (restaurant_feedback) and the URL-keyed golden set (eval_cases) are
 *  intentionally decoupled and survive. */
export async function deleteRestaurant(restaurantId: string): Promise<void> {
  const { error } = await db().from('restaurants').delete().eq('id', restaurantId);
  if (error) throw new Error(`Failed to delete restaurant: ${error.message}`);
}

export interface ApplyDishVerdictInput {
  restaurantId: string;
  /** Canonical (or original) restaurant URL — keys the auto-created eval_case. */
  restaurantUrl: string;
  restaurantName?: string | null;
  city?: string | null;
  action: 'upsert' | 'delete' | 'restore';
  /** Existing dish id — omit to add a brand-new dish (requires sectionId). */
  dishId?: string | null;
  sectionId?: string | null;
  /** Section/menu context for the eval_dishes ground-truth row. */
  sectionName?: string | null;
  menuLabel?: string | null;
  name?: string;
  classification?: DietaryClassification;
  /** What the AI had for this dish BEFORE the human touched it (the dish's
   *  current live label at click time). Stored on eval_dishes so dish accuracy
   *  can be computed honestly (ai_original == expected). Omit for admin-added
   *  dishes (the AI never guessed one). */
  aiOriginalClassification?: DietaryClassification | null;
  confidence?: number;
  reviewerNotes?: string | null;
  source?: 'admin_review' | 'feedback_confirmed';
}

/**
 * The single write path for confirm/correct/add/delete on a dish. Does two
 * things atomically from the caller's point of view: updates the LIVE dish
 * (flagged human_verified so a reparse can't erase it) and upserts the
 * durable eval_dishes ground truth — this is what makes the golden set grow
 * automatically instead of depending on a separate "bank this" step.
 *
 * Deleting a dish does NOT write a ground-truth row: a removed dish means
 * "the AI hallucinated this, it isn't real" — writing any
 * expected_classification for it would be misleading (it isn't "neither",
 * it's "not a dish"). Any matching eval_dishes ground truth is removed too
 * so a stale row can't count as ground truth from here on.
 */
export async function applyDishVerdict(input: ApplyDishVerdictInput): Promise<{ dishId: string | null }> {
  const evalCaseId = await ensureEvalCase(input.restaurantUrl, input.restaurantName, input.city);

  if (input.action === 'delete') {
    if (!input.dishId) throw new Error('dishId is required to delete a dish');
    const { data: dishRow } = await db().from('dishes').select('name').eq('id', input.dishId).maybeSingle();
    // Soft delete — mark it removed by admin instead of destroying the record,
    // and flag human_verified so a reparse preserves the deletion instead of
    // re-extracting the dish live. The record survives for troubleshooting.
    await db()
      .from('dishes')
      .update({
        deleted_at: new Date().toISOString(),
        human_verified: true,
        reviewer_notes: input.reviewerNotes ?? 'Removed by admin',
      })
      .eq('id', input.dishId);
    // A removed dish is no longer classification ground truth, so drop any
    // eval_dishes row for it.
    const dishName = (dishRow as { name: string } | null)?.name;
    if (dishName) {
      await db().from('eval_dishes').delete().eq('eval_case_id', evalCaseId).ilike('name', dishName);
    }
    return { dishId: input.dishId };
  }

  if (input.action === 'restore') {
    if (!input.dishId) throw new Error('dishId is required to restore a dish');
    await db().from('dishes').update({ deleted_at: null }).eq('id', input.dishId);
    return { dishId: input.dishId };
  }

  if (!input.name || !input.classification) {
    throw new Error('name and classification are required to confirm/correct/add a dish');
  }

  let dishId = input.dishId ?? null;
  if (dishId) {
    await db()
      .from('dishes')
      .update({
        name: input.name,
        classification: input.classification,
        confidence: input.confidence ?? 1,
        human_verified: true,
        reviewer_notes: input.reviewerNotes ?? null,
      })
      .eq('id', dishId);
  } else {
    const { data, error } = await db()
      .from('dishes')
      .insert({
        restaurant_id: input.restaurantId,
        section_id: input.sectionId ?? null,
        name: input.name,
        classification: input.classification,
        confidence: input.confidence ?? 1,
        human_verified: true,
        reviewer_notes: input.reviewerNotes ?? null,
        // Added by a human by hand — no AI guess for this one.
        origin: 'admin',
        ai_classification: null,
      })
      .select('id')
      .single();
    if (error) throw new Error(`Failed to add dish: ${error.message}`);
    dishId = (data as { id: string }).id;
  }

  // Upsert the eval_dishes ground truth (manual select-then-write, same
  // reasoning as ensureEvalCase — avoids relying on supabase-js upsert
  // matching a functional unique index).
  const { data: existingEval } = await db()
    .from('eval_dishes')
    .select('id, ai_original_classification')
    .eq('eval_case_id', evalCaseId)
    .ilike('name', input.name)
    .maybeSingle();
  const evalFields = {
    menu_label: input.menuLabel ?? null,
    section_name: input.sectionName ?? null,
    name: input.name,
    expected_classification: input.classification,
    source: input.source ?? 'admin_review',
    notes: input.reviewerNotes ?? null,
    updated_at: new Date().toISOString(),
  };
  if (existingEval) {
    // Capture the AI's original guess ONCE, at the first human touch. On a later
    // re-edit the live dish already holds the human's previous correction, so we
    // must never overwrite a captured original with it.
    const priorAiOriginal = (existingEval as { ai_original_classification: DietaryClassification | null })
      .ai_original_classification ?? null;
    await db()
      .from('eval_dishes')
      .update({ ...evalFields, ai_original_classification: priorAiOriginal ?? input.aiOriginalClassification ?? null })
      .eq('id', (existingEval as { id: string }).id);
  } else {
    await db()
      .from('eval_dishes')
      .insert({ eval_case_id: evalCaseId, ...evalFields, ai_original_classification: input.aiOriginalClassification ?? null });
  }

  return { dishId };
}

export async function getFeedbackInbox(status?: FeedbackStatus): Promise<FeedbackItem[]> {
  let dishReportsQuery = db().from('dish_reports').select('*').order('created_at', { ascending: false });
  if (status) dishReportsQuery = dishReportsQuery.eq('status', status);
  const { data: dishReportsRaw } = await dishReportsQuery;
  const dishReports = (dishReportsRaw ?? []) as DbRow[];

  const dishIds = Array.from(new Set(dishReports.map((r) => r.dish_id as string).filter(Boolean)));
  let dishesById = new Map<string, DbRow>();
  if (dishIds.length > 0) {
    const { data: dishRows } = await db().from('dishes').select('id, name, restaurant_id').in('id', dishIds);
    dishesById = new Map(((dishRows ?? []) as DbRow[]).map((d) => [d.id as string, d]));
  }

  let feedbackQuery = db().from('restaurant_feedback').select('*').order('created_at', { ascending: false });
  if (status) feedbackQuery = feedbackQuery.eq('status', status);
  const { data: feedbackRaw } = await feedbackQuery;
  const feedback = (feedbackRaw ?? []) as DbRow[];

  const restaurantIds = Array.from(
    new Set([
      ...Array.from(dishesById.values()).map((d) => d.restaurant_id as string),
      ...feedback.map((f) => f.restaurant_id as string).filter(Boolean),
    ])
  );
  let restaurantsById = new Map<string, DbRow>();
  if (restaurantIds.length > 0) {
    const { data: restRows } = await db().from('restaurants').select('id, name').in('id', restaurantIds);
    restaurantsById = new Map(((restRows ?? []) as DbRow[]).map((r) => [r.id as string, r]));
  }

  const dishItems: FeedbackItem[] = dishReports.map((r) => {
    const dish = dishesById.get(r.dish_id as string);
    const restaurant = dish ? restaurantsById.get(dish.restaurant_id as string) : undefined;
    return {
      kind: 'dish_report',
      id: r.id as string,
      createdAt: r.created_at as string,
      status: ((r.status as FeedbackStatus) ?? 'open'),
      resolutionNotes: (r.resolution_notes as string | null) ?? null,
      resolvedAt: (r.resolved_at as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      issueOrFeedbackType: r.issue_type as string,
      dishId: r.dish_id as string,
      dishName: (dish?.name as string | undefined) ?? undefined,
      restaurantId: (dish?.restaurant_id as string | undefined) ?? undefined,
      restaurantName: (restaurant?.name as string | null | undefined) ?? null,
    };
  });

  const feedbackItems: FeedbackItem[] = feedback.map((f) => ({
    kind: 'restaurant_feedback',
    id: f.id as string,
    createdAt: f.created_at as string,
    status: ((f.status as FeedbackStatus) ?? 'open'),
    resolutionNotes: (f.resolution_notes as string | null) ?? null,
    resolvedAt: (f.resolved_at as string | null) ?? null,
    notes: (f.notes as string | null) ?? null,
    issueOrFeedbackType: f.feedback_type as string,
    restaurantId: (f.restaurant_id as string | null | undefined) ?? undefined,
    restaurantName: (f.restaurant_name as string | null) ?? null,
    city: (f.city as string | null) ?? null,
  }));

  return [...dishItems, ...feedbackItems].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function resolveFeedback(
  kind: 'dish_report' | 'restaurant_feedback',
  id: string,
  status: 'confirmed' | 'dismissed',
  resolutionNotes?: string | null
): Promise<void> {
  const table = kind === 'dish_report' ? 'dish_reports' : 'restaurant_feedback';
  await db()
    .from(table)
    .update({
      status,
      resolution_notes: resolutionNotes ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id);
}

export async function getEvalCases(): Promise<EvalCase[]> {
  const { data } = await db().from('eval_cases').select('*').order('created_at', { ascending: false });
  return ((data ?? []) as DbRow[]).map((r) => ({
    id: r.id as string,
    url: r.url as string,
    name: (r.name as string | null) ?? null,
    city: (r.city as string | null) ?? null,
    missedMenus: (r.missed_menus as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    menusReviewedAt: (r.menus_reviewed_at as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export async function getEvalCaseDetail(
  caseId: string
): Promise<{ evalCase: EvalCase; menuCandidates: EvalMenuCandidate[]; dishes: EvalDish[] } | null> {
  const { data: caseRow } = await db().from('eval_cases').select('*').eq('id', caseId).maybeSingle();
  if (!caseRow) return null;
  const r = caseRow as DbRow;

  const { data: candidateRows } = await db()
    .from('eval_menu_candidates')
    .select('*')
    .eq('eval_case_id', caseId)
    .order('created_at', { ascending: false });
  const { data: dishRows } = await db()
    .from('eval_dishes')
    .select('*')
    .eq('eval_case_id', caseId)
    .order('name');

  return {
    evalCase: {
      id: r.id as string,
      url: r.url as string,
      name: (r.name as string | null) ?? null,
      city: (r.city as string | null) ?? null,
      missedMenus: (r.missed_menus as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      menusReviewedAt: (r.menus_reviewed_at as string | null) ?? null,
      createdAt: r.created_at as string,
    },
    menuCandidates: ((candidateRows ?? []) as DbRow[]).map((c) => ({
      id: c.id as string,
      evalCaseId: c.eval_case_id as string,
      label: c.label as string,
      verdict: c.verdict as MenuCandidateVerdict,
      notes: (c.notes as string | null) ?? null,
      createdAt: c.created_at as string,
    })),
    dishes: ((dishRows ?? []) as DbRow[]).map((d) => ({
      id: d.id as string,
      evalCaseId: d.eval_case_id as string,
      menuLabel: (d.menu_label as string | null) ?? null,
      sectionName: (d.section_name as string | null) ?? null,
      name: d.name as string,
      expectedClassification: d.expected_classification as DietaryClassification,
      aiOriginalClassification: (d.ai_original_classification as DietaryClassification | null) ?? null,
      source: d.source as EvalDish['source'],
      notes: (d.notes as string | null) ?? null,
      createdAt: d.created_at as string,
      updatedAt: d.updated_at as string,
    })),
  };
}

export async function saveMenuCandidateVerdict(input: {
  url: string;
  restaurantName?: string | null;
  city?: string | null;
  label: string;
  verdict: MenuCandidateVerdict;
  notes?: string | null;
}): Promise<void> {
  const evalCaseId = await ensureEvalCase(input.url, input.restaurantName, input.city);
  // Upsert: one verdict per (eval_case, candidate label). Re-clicking a verdict
  // updates the existing row instead of piling up contradictory rows (the
  // original insert-only version let one candidate be recorded correct AND
  // spurious at once).
  const { data: existing } = await db()
    .from('eval_menu_candidates')
    .select('id')
    .eq('eval_case_id', evalCaseId)
    .ilike('label', input.label)
    .maybeSingle();
  if (existing) {
    await db()
      .from('eval_menu_candidates')
      .update({ verdict: input.verdict, notes: input.notes ?? null })
      .eq('id', (existing as { id: string }).id);
  } else {
    await db().from('eval_menu_candidates').insert({
      eval_case_id: evalCaseId,
      label: input.label,
      verdict: input.verdict,
      notes: input.notes ?? null,
    });
  }
}

/** Recorded verdict per candidate label for one restaurant URL — so the review
 *  screen can show which verdict is currently set (read-only, no create). */
export async function getMenuCandidateVerdicts(url: string): Promise<Record<string, MenuCandidateVerdict>> {
  const { data: caseRow } = await db().from('eval_cases').select('id').ilike('url', url).maybeSingle();
  if (!caseRow) return {};
  const { data } = await db()
    .from('eval_menu_candidates')
    .select('label, verdict')
    .eq('eval_case_id', (caseRow as { id: string }).id);
  const out: Record<string, MenuCandidateVerdict> = {};
  for (const r of (data ?? []) as DbRow[]) out[r.label as string] = r.verdict as MenuCandidateVerdict;
  return out;
}

export async function saveMissedMenus(input: {
  url: string;
  restaurantName?: string | null;
  city?: string | null;
  missedMenus: string;
}): Promise<void> {
  const evalCaseId = await ensureEvalCase(input.url, input.restaurantName, input.city);
  await db().from('eval_cases').update({ missed_menus: input.missedMenus }).eq('id', evalCaseId);
}

export interface DishError {
  restaurantName: string | null;
  url: string;
  menuLabel: string | null;
  sectionName: string | null;
  name: string;
  aiSaid: DietaryClassification;
  shouldBe: DietaryClassification;
  notes: string | null;
}

export interface DiscoveryError {
  restaurantName: string | null;
  url: string;
  spurious: string[];
  duplicate: string[];
  missedMenus: string | null;
}

export interface HallucinatedDish {
  restaurantName: string | null;
  url: string;
  name: string;
}

export interface CorrectionLog {
  generatedAt: string;
  dishErrors: DishError[];
  discovery: DiscoveryError[];
  hallucinatedDishes: HallucinatedDish[];
}

/**
 * Everything a human reviewer has corrected the AI on — the raw material for
 * fixing the pipeline (prompts in lib/ai.ts) rather than patching one dish at a
 * time. Two kinds of error:
 *  - dish misclassifications: eval_dishes where the AI's original guess differs
 *    from the human-confirmed answer.
 *  - discovery mistakes: menu candidates a human marked spurious/duplicate, and
 *    real menus the AI missed entirely (eval_cases.missed_menus).
 * Pure DB reads, zero LLM cost.
 */
export async function getCorrectionLog(): Promise<CorrectionLog> {
  const { data: caseRows } = await db().from('eval_cases').select('id, url, name, missed_menus');
  const cases = new Map<string, { url: string; name: string | null; missedMenus: string | null }>();
  for (const c of (caseRows ?? []) as DbRow[]) {
    cases.set(c.id as string, {
      url: c.url as string,
      name: (c.name as string | null) ?? null,
      missedMenus: (c.missed_menus as string | null) ?? null,
    });
  }

  // Dish misclassifications: AI's original guess != human verdict.
  const { data: dishRows } = await db()
    .from('eval_dishes')
    .select('eval_case_id, menu_label, section_name, name, expected_classification, ai_original_classification, notes')
    .not('ai_original_classification', 'is', null);
  const dishErrors: DishError[] = [];
  for (const d of (dishRows ?? []) as DbRow[]) {
    const ai = d.ai_original_classification as DietaryClassification;
    const expected = d.expected_classification as DietaryClassification;
    if (ai === expected) continue;
    const c = cases.get(d.eval_case_id as string);
    if (!c) continue;
    dishErrors.push({
      restaurantName: c.name,
      url: c.url,
      menuLabel: (d.menu_label as string | null) ?? null,
      sectionName: (d.section_name as string | null) ?? null,
      name: d.name as string,
      aiSaid: ai,
      shouldBe: expected,
      notes: (d.notes as string | null) ?? null,
    });
  }
  // Unsafe errors (AI called a non-veg dish veg) first — they matter most.
  const unsafeRank = (e: DishError) => (e.shouldBe === 'neither' && (e.aiSaid === 'vegan' || e.aiSaid === 'vegetarian') ? 0 : 1);
  dishErrors.sort((a, b) => unsafeRank(a) - unsafeRank(b));

  // Discovery mistakes.
  const { data: candRows } = await db()
    .from('eval_menu_candidates')
    .select('eval_case_id, label, verdict')
    .in('verdict', ['spurious', 'duplicate']);
  const byCase = new Map<string, { spurious: string[]; duplicate: string[] }>();
  for (const c of (candRows ?? []) as DbRow[]) {
    const id = c.eval_case_id as string;
    if (!byCase.has(id)) byCase.set(id, { spurious: [], duplicate: [] });
    const bucket = byCase.get(id)!;
    if (c.verdict === 'spurious') bucket.spurious.push(c.label as string);
    else bucket.duplicate.push(c.label as string);
  }
  const discovery: DiscoveryError[] = [];
  for (const [id, c] of Array.from(cases.entries())) {
    const problems = byCase.get(id);
    const missed = c.missedMenus?.trim() ? c.missedMenus : null;
    if (!problems && !missed) continue;
    discovery.push({
      restaurantName: c.name,
      url: c.url,
      spurious: problems?.spurious ?? [],
      duplicate: problems?.duplicate ?? [],
      missedMenus: missed,
    });
  }

  // Hallucinated dishes: AI-created rows an admin soft-deleted (i.e. "not a real
  // dish"). An extraction error worth fixing at the prompt level.
  const { data: delRows } = await db()
    .from('dishes')
    .select('name, restaurant_id')
    .eq('origin', 'ai')
    .not('deleted_at', 'is', null);
  const delDishes = (delRows ?? []) as DbRow[];
  const restIds = Array.from(new Set(delDishes.map((d) => d.restaurant_id as string)));
  const restById = new Map<string, { name: string | null; url: string }>();
  if (restIds.length > 0) {
    const { data: restRows } = await db().from('restaurants').select('id, name, url, canonical_url').in('id', restIds);
    for (const r of (restRows ?? []) as DbRow[]) {
      restById.set(r.id as string, {
        name: (r.name as string | null) ?? null,
        url: ((r.canonical_url as string | null) ?? (r.url as string)) as string,
      });
    }
  }
  const hallucinatedDishes: HallucinatedDish[] = delDishes.map((d) => {
    const r = restById.get(d.restaurant_id as string);
    return { restaurantName: r?.name ?? null, url: r?.url ?? '', name: d.name as string };
  });

  return { generatedAt: new Date().toISOString(), dishErrors, discovery, hallucinatedDishes };
}

/**
 * Menu-level review: records (or clears) a human sign-off that this
 * restaurant's menu discovery is correct — the countable "restaurants reviewed"
 * signal. Keyed by URL on the wipe-proof eval_case, so it survives reparses.
 */
export async function markMenusReviewed(input: {
  url: string;
  restaurantName?: string | null;
  city?: string | null;
  reviewed: boolean;
}): Promise<void> {
  const evalCaseId = await ensureEvalCase(input.url, input.restaurantName, input.city);
  await db()
    .from('eval_cases')
    .update({ menus_reviewed_at: input.reviewed ? new Date().toISOString() : null })
    .eq('id', evalCaseId);
}

/**
 * All user feedback for one restaurant, for surfacing inline on the review
 * screen (B7): dish-level reports keyed by dish, plus restaurant-level general
 * feedback. Read-only; does not touch the eval set.
 */
export async function getRestaurantFeedback(
  restaurantId: string
): Promise<{ dishReports: DishReportSummary[]; restaurantFeedback: FeedbackItem[] }> {
  // Dish reports for this restaurant's dishes (dish_reports has no restaurant_id,
  // so resolve via the dish rows first).
  const { data: dishRows } = await db().from('dishes').select('id').eq('restaurant_id', restaurantId);
  const dishIds = ((dishRows ?? []) as DbRow[]).map((d) => d.id as string);
  let dishReports: DishReportSummary[] = [];
  if (dishIds.length > 0) {
    const { data: reportRows } = await db()
      .from('dish_reports')
      .select('*')
      .in('dish_id', dishIds)
      .order('created_at', { ascending: false });
    dishReports = ((reportRows ?? []) as DbRow[]).map((r) => ({
      id: r.id as string,
      dishId: r.dish_id as string,
      issueType: (r.issue_type as string) ?? 'other',
      notes: (r.notes as string | null) ?? null,
      status: ((r.status as FeedbackStatus) ?? 'open'),
      createdAt: r.created_at as string,
    }));
  }

  const { data: fbRows } = await db()
    .from('restaurant_feedback')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false });
  const restaurantFeedback: FeedbackItem[] = ((fbRows ?? []) as DbRow[]).map((f) => ({
    kind: 'restaurant_feedback',
    id: f.id as string,
    createdAt: f.created_at as string,
    status: ((f.status as FeedbackStatus) ?? 'open'),
    resolutionNotes: (f.resolution_notes as string | null) ?? null,
    resolvedAt: (f.resolved_at as string | null) ?? null,
    notes: (f.notes as string | null) ?? null,
    issueOrFeedbackType: f.feedback_type as string,
    restaurantId: (f.restaurant_id as string | null | undefined) ?? undefined,
    restaurantName: (f.restaurant_name as string | null) ?? null,
    city: (f.city as string | null) ?? null,
  }));

  return { dishReports, restaurantFeedback };
}

/**
 * Find the live restaurant for an eval_case's URL (matches lib/eval.ts's
 * scoring against "whatever's currently live"). Returns null when the
 * restaurant was never scraped, or has since been wiped/deleted.
 */
export async function getLiveMenuForUrl(url: string): Promise<Restaurant | null> {
  const { data: byUrl } = await db().from('restaurants').select('id').ilike('url', url).maybeSingle();
  const idByUrl = (byUrl as { id: string } | null)?.id;
  if (idByUrl) return fetchRestaurantWithDishes(idByUrl);

  const { data: byCanonical } = await db().from('restaurants').select('id').ilike('canonical_url', url).maybeSingle();
  const idByCanonical = (byCanonical as { id: string } | null)?.id;
  if (idByCanonical) return fetchRestaurantWithDishes(idByCanonical);

  return null;
}

/**
 * Delete an entire discovered menu group (all its sections and their
 * dishes) and record a `spurious` verdict against it. dishes.section_id is
 * ON DELETE SET NULL, not CASCADE, so the sections must never be deleted
 * before their dishes — that would just orphan the dishes instead of
 * removing them, which is why this deletes dishes first, explicitly.
 */
export async function removeMenu(input: {
  restaurantId: string;
  restaurantUrl: string;
  restaurantName?: string | null;
  city?: string | null;
  /** The menu_label shared by the sections to remove; null = the unlabeled group. */
  menuLabel: string | null;
}): Promise<{ removedDishCount: number; removedSectionCount: number }> {
  let sectionQuery = db().from('menu_sections').select('id').eq('restaurant_id', input.restaurantId);
  sectionQuery = input.menuLabel === null ? sectionQuery.is('menu_label', null) : sectionQuery.eq('menu_label', input.menuLabel);
  const { data: sectionRows } = await sectionQuery;
  const sectionIds = ((sectionRows ?? []) as DbRow[]).map((s) => s.id as string);

  let removedDishCount = 0;
  if (sectionIds.length > 0) {
    const { data: deletedDishes } = await db().from('dishes').delete().in('section_id', sectionIds).select('id');
    removedDishCount = ((deletedDishes ?? []) as DbRow[]).length;
    await db().from('menu_sections').delete().in('id', sectionIds);
  }

  await saveMenuCandidateVerdict({
    url: input.restaurantUrl,
    restaurantName: input.restaurantName,
    city: input.city,
    label: input.menuLabel ?? '(unlabeled menu)',
    verdict: 'spurious',
    notes: 'Removed via admin "Remove this menu"',
  });

  return { removedDishCount, removedSectionCount: sectionIds.length };
}

/**
 * The one admin action in this feature that spends real LLM money: scrape a
 * single admin-supplied URL directly (skipping discovery/candidate-picking —
 * the admin is pointing straight at the menu) and classify it, reusing the
 * exact extraction dispatch + retry ladder `lib/menu-extract.ts` already uses
 * for the public pipeline (extractMenuResumable), plus the same Sonnet
 * veg/vegan audit pass, so admin-added dishes get the same safety bar as
 * everything else. Appends the result as a new menu group, dishes marked
 * human_verified so they survive a reparse. Usage is logged whether the
 * extraction succeeds or fails — a failed attempt still spent tokens.
 */
export async function addMenuFromUrl(input: {
  restaurantId: string;
  restaurantUrl: string;
  restaurantName?: string | null;
  city?: string | null;
  url: string;
  label: string;
}): Promise<{ addedDishCount: number; usage: AIUsage }> {
  const scrape = await scrapeRestaurant(input.url);
  const isPdf = scrape.urlType === 'pdf' || !!scrape.menuUrl?.toLowerCase().split('?')[0].endsWith('.pdf');
  const hasText = !!scrape.menuText && scrape.menuText.length >= 100;
  const hasImages = !!scrape.menuImages && scrape.menuImages.length > 0;

  const candidate: MenuCandidate = {
    id: 'admin-added',
    label: input.label,
    type: isPdf ? 'pdf' : hasText ? 'text' : hasImages ? 'image' : 'subpage',
    ref: isPdf ? (scrape.menuUrl ?? input.url) : hasImages ? scrape.menuImages![0] : input.url,
    source: 'homepage',
  };
  const ctx: ExtractContext = {
    title: scrape.title,
    inlineText: scrape.menuText,
    screenshotUrl: scrape.screenshotUrl,
    pdfUrls: scrape.menuPdfUrls,
    imageUrls: scrape.menuImages,
    pageUrl: scrape.canonicalUrl,
  };

  const { best, usage: extractUsage } = await extractMenuResumable(candidate, ctx);
  let usage = extractUsage;

  if (!best || best.menu.sections.length === 0) {
    if (usage) await logUsage(input.restaurantId, input.restaurantUrl, usage, input.restaurantName ?? null);
    throw new Error(
      "Couldn't read a menu from that URL — check the link points directly at the menu (a page, PDF, or image)."
    );
  }

  // Same Sonnet veg/vegan double-check the public pipeline runs before saving —
  // admin-added dishes go live for real users, so they get the same guardrail.
  const verified = await verifyVegClassifications(best.menu, input.restaurantName ?? scrape.title);
  usage = sumUsage(usage, verified.usage);
  await logUsage(input.restaurantId, input.restaurantUrl, usage, input.restaurantName ?? null);

  const { data: existingSections } = await db()
    .from('menu_sections')
    .select('display_order')
    .eq('restaurant_id', input.restaurantId)
    .order('display_order', { ascending: false })
    .limit(1);
  let nextOrder = (((existingSections ?? [])[0] as DbRow | undefined)?.display_order as number | undefined) ?? -1;
  nextOrder += 1;

  let addedDishCount = 0;
  for (const section of verified.menu.sections) {
    const { data: sectionRow, error } = await db()
      .from('menu_sections')
      .insert({
        restaurant_id: input.restaurantId,
        name: section.name,
        display_order: nextOrder++,
        menu_label: input.label,
      })
      .select('id')
      .single();
    if (error || !sectionRow) continue;

    const dishRows = section.dishes.map((d: RawDish) => ({
      restaurant_id: input.restaurantId,
      section_id: sectionRow.id,
      name: d.name,
      description: d.description ?? null,
      price: d.price ?? null,
      classification: d.classification,
      confidence: d.confidence,
      confidence_reason: d.reason ?? null,
      human_verified: true,
    }));
    if (dishRows.length > 0) {
      await db().from('dishes').insert(dishRows);
      addedDishCount += dishRows.length;
    }
  }

  // A successfully-read menu makes the restaurant live: flip out of any
  // 'no_menu'/'error' state to 'done' and clear the no_menu verdict, so the
  // results page shows the menu instead of the "no menu" screen. (Harmless
  // when it was already 'done' — the normal "add a missing menu" case.)
  await markRestaurantLive(input.restaurantId);

  await saveMenuCandidateVerdict({
    url: input.restaurantUrl,
    restaurantName: input.restaurantName,
    city: input.city,
    label: input.label,
    verdict: 'correct',
    notes: 'Added via admin "Add a missing menu"',
  });

  return { addedDishCount, usage };
}

/** Mark a restaurant live after a menu was successfully added by hand (admin or
 *  a public user submission). Clears any no_menu verdict. */
async function markRestaurantLive(restaurantId: string): Promise<void> {
  await db()
    .from('restaurants')
    .update({
      status: 'done',
      error_message: null,
      no_menu_reason: null,
      no_menu_confirmed_at: null,
      last_scraped_at: new Date().toISOString(),
    })
    .eq('id', restaurantId);
}

/**
 * Same job as addMenuFromUrl, for a file the admin uploaded directly instead
 * of a URL — e.g. a photo of a menu taken at the restaurant or grabbed from
 * Google Maps, which has no page to scrape. No retry ladder here (unlike the
 * public pipeline there's no alternate source to fall back to — it's this
 * file or nothing); the one quality safeguard kept is a single re-attempt on
 * the strongest model if the cheap pass reads too few items, plus the same
 * Sonnet veg/vegan audit every other admin-added menu gets before it's saved.
 */
export async function addMenuFromUpload(input: {
  restaurantId: string;
  restaurantUrl: string;
  restaurantName?: string | null;
  city?: string | null;
  label: string;
  kind: 'image' | 'pdf';
  fileBase64: string;
}): Promise<{ addedDishCount: number; usage: AIUsage }> {
  const restaurantName = input.restaurantName ?? undefined;
  let extraction: { menu: import('@/types').ClassifiedMenu; usage: AIUsage } | null;
  if (input.kind === 'image') {
    const mediaType = sniffImageType(Buffer.from(input.fileBase64, 'base64'));
    if (!mediaType) throw new Error('Unrecognised image format — please upload a JPEG, PNG, GIF, or WebP.');
    extraction = await classifyMenuFromImageBuffers([{ data: input.fileBase64, mediaType }], restaurantName);
  } else {
    extraction = await classifyMenuFromPdfBuffer(input.fileBase64, restaurantName);
  }

  let usage = extraction?.usage;
  const tooThin = !extraction || countFoodItems(extraction.menu) < MIN_FOOD_ITEMS || looksLikeHeaderItems(extraction.menu);
  if (tooThin) {
    const retry =
      input.kind === 'image'
        ? await classifyMenuFromImageBuffers(
            [{ data: input.fileBase64, mediaType: sniffImageType(Buffer.from(input.fileBase64, 'base64'))! }],
            restaurantName,
            ESCALATION_MODEL
          )
        : await classifyMenuFromPdfBuffer(input.fileBase64, restaurantName, ESCALATION_MODEL);
    usage = sumUsage(usage, retry?.usage);
    if (retry && (!extraction || countFoodItems(retry.menu) > countFoodItems(extraction.menu))) extraction = retry;
  }

  if (!extraction || extraction.menu.sections.length === 0) {
    if (usage) await logUsage(input.restaurantId, input.restaurantUrl, usage, input.restaurantName ?? null);
    throw new Error("Couldn't read a menu from that file — check it's a clear photo or scan of the menu text.");
  }

  const verified = await verifyVegClassifications(extraction.menu, restaurantName);
  usage = sumUsage(usage, verified.usage);
  if (usage) await logUsage(input.restaurantId, input.restaurantUrl, usage, input.restaurantName ?? null);

  const { data: existingSections } = await db()
    .from('menu_sections')
    .select('display_order')
    .eq('restaurant_id', input.restaurantId)
    .order('display_order', { ascending: false })
    .limit(1);
  let nextOrder = (((existingSections ?? [])[0] as DbRow | undefined)?.display_order as number | undefined) ?? -1;
  nextOrder += 1;

  let addedDishCount = 0;
  for (const section of verified.menu.sections) {
    const { data: sectionRow, error } = await db()
      .from('menu_sections')
      .insert({
        restaurant_id: input.restaurantId,
        name: section.name,
        display_order: nextOrder++,
        menu_label: input.label,
      })
      .select('id')
      .single();
    if (error || !sectionRow) continue;

    const dishRows = section.dishes.map((d: RawDish) => ({
      restaurant_id: input.restaurantId,
      section_id: sectionRow.id,
      name: d.name,
      description: d.description ?? null,
      price: d.price ?? null,
      classification: d.classification,
      confidence: d.confidence,
      confidence_reason: d.reason ?? null,
      human_verified: true,
    }));
    if (dishRows.length > 0) {
      await db().from('dishes').insert(dishRows);
      addedDishCount += dishRows.length;
    }
  }

  await markRestaurantLive(input.restaurantId);

  await saveMenuCandidateVerdict({
    url: input.restaurantUrl,
    restaurantName: input.restaurantName,
    city: input.city,
    label: input.label,
    verdict: 'correct',
    notes: `Added via admin "Add a missing menu" (uploaded ${input.kind})`,
  });

  return { addedDishCount, usage: usage ?? { model: '', tokensIn: 0, tokensOut: 0, costUsd: 0 } };
}
