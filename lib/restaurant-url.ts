type RestaurantUrlSource = {
  id: string;
  name?: string | null;
  city?: string | null;
  slug?: string | null;
};

/** Turn a restaurant or city name into a clean, readable URL segment. */
export function urlSlug(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function restaurantSlug(name: string | null | undefined): string {
  return urlSlug(name ?? '') || 'restaurant';
}

/** Readable fallback for terminal pages where scraping never recovered a name. */
export function restaurantSlugFromUrl(value: string): string {
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const hostParts = parsed.hostname.toLowerCase().replace(/^www\./, '').split('.');
    let candidate = hostParts[0] ?? '';
    // Hosted ordering platforms put the restaurant identity in the path, not
    // in generic subdomains such as "order" or "ordering".
    if (/^(order|orders|ordering|www)$/.test(candidate)) {
      candidate = parsed.pathname.split('/').filter(Boolean).pop() ?? candidate;
    }
    return restaurantSlug(decodeURIComponent(candidate));
  } catch {
    return 'restaurant';
  }
}

/**
 * The one place public restaurant links are assembled. The persisted slug is
 * preferred because it includes a stable -2/-3 suffix when names collide.
 */
export function restaurantPath(restaurant: RestaurantUrlSource, cityOverride?: string): string {
  const city = urlSlug(cityOverride ?? restaurant.city ?? '') || 'unassigned';
  const slug = restaurant.slug || restaurantSlug(restaurant.name);
  return `/restaurant/${city}/${slug}`;
}

type SlugCandidate = RestaurantUrlSource & { createdAt: string; featuredInPublicCity?: boolean };

/**
 * Mirror the migration's collision numbering for the brief period before the
 * slug column exists (and for a newly named row before its best-effort update
 * finishes). Existing public-guide entries get the clean name during the
 * initial backfill; creation order then makes numbering deterministic.
 */
export function assignRestaurantSlugs<T extends SlugCandidate>(restaurants: T[]): Map<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set(restaurants.map((restaurant) => restaurant.slug).filter((slug): slug is string => !!slug));
  const nextNumber = new Map<string, number>();
  const ordered = [...restaurants].sort(
    (a, b) =>
      Number(!!b.featuredInPublicCity) - Number(!!a.featuredInPublicCity) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id)
  );

  for (const restaurant of ordered) {
    if (restaurant.slug) {
      assigned.set(restaurant.id, restaurant.slug);
      continue;
    }
    const base = restaurantSlug(restaurant.name);
    let number = nextNumber.get(base) ?? 1;
    let slug = number === 1 ? base : `${base}-${number}`;
    while (used.has(slug)) {
      number += 1;
      slug = `${base}-${number}`;
    }
    used.add(slug);
    nextNumber.set(base, number + 1);
    assigned.set(restaurant.id, slug);
  }
  return assigned;
}

/** Preserve the share attribution carried by legacy UUID links during redirect. */
export function withShareAttribution(
  path: string,
  searchParams: Record<string, string | string[] | undefined>
): string {
  const output = new URLSearchParams();
  const ref = searchParams.ref;
  const src = searchParams.src;
  if (ref === 'share') output.set('ref', ref);
  if (typeof src === 'string' && /^(native|whatsapp|copy)$/.test(src)) output.set('src', src);
  const query = output.toString();
  return query ? `${path}?${query}` : path;
}
