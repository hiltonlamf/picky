import { createClient } from '@supabase/supabase-js';
import type { Restaurant, MenuSection, Dish, ClassifiedMenu, RawSection, RawDish, DiscoveryPayload } from '@/types';
import type { AIUsage } from './ai';
import { REPORT_COUNT_WARNING_THRESHOLD } from './dietary-config';

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

function normalizeUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, '')
    .replace(/\/+$/, '');
}

type DbRestaurantRow = {
  id: string;
  url: string;
  canonical_url: string | null;
  last_scraped_at: string | null;
  status: string;
};

type DbRow = Record<string, unknown>;

export async function findExistingRestaurant(
  url: string
): Promise<{ id: string; status: string; lastScrapedAt: string | null } | null> {
  const normalized = normalizeUrl(url);
  // Reconstruct candidate URL forms to match against the DB index
  const candidates = [
    url,
    url.replace(/^https?:\/\//, 'https://'),
    url.replace(/^https?:\/\//, 'http://'),
    `https://${normalized}`,
    `https://www.${normalized}`,
  ];

  // Try each candidate directly — the DB has a unique index on lower(url)
  for (const candidate of candidates) {
    const { data } = await db()
      .from('restaurants')
      .select('id, url, canonical_url, last_scraped_at, status')
      .ilike('url', candidate)
      .maybeSingle();
    if (data) {
      const row = data as DbRestaurantRow;
      return { id: row.id, status: row.status, lastScrapedAt: row.last_scraped_at };
    }
  }

  // Canonical URL check (covers redirected URLs saved after first scrape)
  const { data: byCanonical } = await db()
    .from('restaurants')
    .select('id, url, canonical_url, last_scraped_at, status')
    .ilike('canonical_url', `https://${normalized}`)
    .maybeSingle();

  if (byCanonical) {
    const row = byCanonical as DbRestaurantRow;
    return { id: row.id, status: row.status, lastScrapedAt: row.last_scraped_at };
  }

  return null;
}

export async function resetRestaurantForReparse(id: string): Promise<void> {
  await db()
    .from('restaurants')
    .update({ status: 'processing', error_message: null, menu_candidates: null, candidates_at: null })
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

export async function fetchRestaurantWithDishes(id: string): Promise<Restaurant | null> {
  const { data: r } = await db().from('restaurants').select('*').eq('id', id).single();
  if (!r) return null;

  const { data: rawSections } = await db()
    .from('menu_sections')
    .select('*')
    .eq('restaurant_id', id)
    .order('display_order');

  const { data: rawDishes } = await db()
    .from('dishes')
    .select('*')
    .eq('restaurant_id', id)
    .order('created_at');

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
  };
}

export async function createRestaurantRecord(url: string, city = 'dublin'): Promise<string> {
  const { data, error } = await db()
    .from('restaurants')
    .insert({ url, city, status: 'processing' })
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
    }));

    if (dishRows.length > 0) {
      await db().from('dishes').insert(dishRows);
    }
  }
}

export async function markRestaurantError(restaurantId: string, message: string): Promise<void> {
  await db()
    .from('restaurants')
    .update({ status: 'error', error_message: message })
    .eq('id', restaurantId);
}

export async function reportDish(
  dishId: string,
  issueType: string,
  notes: string,
  ipHash: string
): Promise<void> {
  await db().from('dish_reports').insert({
    dish_id: dishId,
    issue_type: issueType,
    notes: notes ?? null,
    ip_hash: ipHash,
  });

  const { data: dish } = await db().from('dishes').select('report_count').eq('id', dishId).single();
  const newCount = ((dish as DbRow)?.report_count as number ?? 0) + 1;
  await db()
    .from('dishes')
    .update({ report_count: newCount, warning_flagged: newCount >= REPORT_COUNT_WARNING_THRESHOLD })
    .eq('id', dishId);
}

export async function submitFeedback(
  restaurantId: string,
  restaurantName: string | null,
  feedbackType: string,
  notes: string,
  ipHash: string
): Promise<void> {
  await db().from('restaurant_feedback').insert({
    restaurant_id: restaurantId,
    restaurant_name: restaurantName,
    feedback_type: feedbackType,
    notes: notes || null,
    ip_hash: ipHash,
  });
}

export async function getFeaturedRestaurants(city: string): Promise<Restaurant[]> {
  const { data } = await db()
    .from('featured_restaurants')
    .select('restaurant_id, display_order')
    .eq('city', city)
    .order('display_order');

  const rows = (data ?? []) as Array<{ restaurant_id: string; display_order: number }>;
  if (!rows.length) return [];

  const results = await Promise.all(rows.map((r) => fetchRestaurantWithDishes(r.restaurant_id)));
  return results.filter(Boolean) as Restaurant[];
}
