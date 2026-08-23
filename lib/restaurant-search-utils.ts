import type { PickyRestaurantSearchCandidate, RestaurantSearchCandidate } from '@/types';

export function normalizeRestaurantName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function looksLikeRestaurantUrl(value: string): boolean {
  const trimmed = value.trim();
  if (/^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed)) return true;
  return !/\s/.test(trimmed) && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#].*)?$/i.test(trimmed);
}

export function rankPickyCandidates(
  query: string,
  candidates: Omit<PickyRestaurantSearchCandidate, 'exact'>[]
): PickyRestaurantSearchCandidate[] {
  const normalizedQuery = normalizeRestaurantName(query);
  return candidates
    .map((candidate) => {
      const normalizedName = normalizeRestaurantName(candidate.name);
      return {
        ...candidate,
        exact: normalizedName === normalizedQuery,
        rank:
          normalizedName === normalizedQuery
            ? 0
            : normalizedName.startsWith(normalizedQuery)
              ? 1
              : normalizedName.includes(normalizedQuery)
                ? 2
                : 3,
      };
    })
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
    .map(({ rank: _rank, ...candidate }) => candidate);
}

export function mergeSearchCandidates(
  picky: RestaurantSearchCandidate[],
  external: RestaurantSearchCandidate[]
): RestaurantSearchCandidate[] {
  const seen = new Set(
    picky.map((candidate) => `${normalizeRestaurantName(candidate.name)}|${normalizeRestaurantName(candidate.location ?? '')}`)
  );
  return [
    ...picky,
    ...external.filter((candidate) => {
      const key = `${normalizeRestaurantName(candidate.name)}|${normalizeRestaurantName(candidate.location ?? '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}
