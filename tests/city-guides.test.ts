import { describe, it, expect } from 'vitest';
import {
  GUIDE_FILTER_THRESHOLD,
  RESERVED_GUIDE_SLUGS,
  UNGROUPED_COUNTRY_LABEL,
  filterGuides,
  groupGuidesByCountry,
  isReservedGuideSlug,
} from '@/lib/city-guides';
import type { CityGuide } from '@/types';

function guide(displayName: string, country: string | null): CityGuide {
  return {
    slug: displayName.toLowerCase().replace(/\s+/g, '-'),
    displayName,
    country,
    status: 'published',
    tagline: null,
    publishedAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('groupGuidesByCountry', () => {
  it('groups by country, countries and cities alphabetical', () => {
    const groups = groupGuidesByCountry([
      guide('Limerick', 'Ireland'),
      guide('Amsterdam', 'Netherlands'),
      guide('Cork', 'Ireland'),
      guide('Dublin', 'Ireland'),
    ]);

    expect(groups.map((g) => g.country)).toEqual(['Ireland', 'Netherlands']);
    expect(groups[0].guides.map((g) => g.displayName)).toEqual(['Cork', 'Dublin', 'Limerick']);
    expect(groups[1].guides.map((g) => g.displayName)).toEqual(['Amsterdam']);
  });

  it('attaches the country flag, and null for a country it does not know', () => {
    const groups = groupGuidesByCountry([guide('Dublin', 'Ireland'), guide('Narnia City', 'Narnia')]);
    const ireland = groups.find((g) => g.country === 'Ireland');
    const narnia = groups.find((g) => g.country === 'Narnia');
    expect(ireland?.flag).toBe('🇮🇪');
    // A wrong flag is worse than none — an unknown country simply renders bare.
    expect(narnia?.flag).toBeNull();
  });

  it('puts countryless guides last, under a heading rather than "null"', () => {
    const groups = groupGuidesByCountry([
      guide('Nowhere', null),
      guide('Dublin', 'Ireland'),
      guide('Blankshire', '   '),
    ]);

    expect(groups[groups.length - 1].country).toBe(UNGROUPED_COUNTRY_LABEL);
    // Whitespace-only country is treated as absent, not as its own group.
    expect(groups).toHaveLength(2);
    expect(groups[1].guides.map((g) => g.displayName)).toEqual(['Blankshire', 'Nowhere']);
  });

  it('returns no groups for no guides', () => {
    expect(groupGuidesByCountry([])).toEqual([]);
  });
});

describe('filterGuides', () => {
  const guides = [guide('Dublin', 'Ireland'), guide('Málaga', 'Spain'), guide('Cork', 'Ireland')];

  it('matches on city name, case-insensitively', () => {
    expect(filterGuides(guides, 'dub').map((g) => g.displayName)).toEqual(['Dublin']);
  });

  it('matches on country, so typing a country finds its cities', () => {
    expect(filterGuides(guides, 'Ireland').map((g) => g.displayName)).toEqual(['Dublin', 'Cork']);
  });

  it('ignores accents — a phone keyboard should not be a barrier', () => {
    expect(filterGuides(guides, 'malaga').map((g) => g.displayName)).toEqual(['Málaga']);
    expect(filterGuides(guides, 'MÁLAGA').map((g) => g.displayName)).toEqual(['Málaga']);
  });

  it('returns everything for an empty or whitespace query', () => {
    expect(filterGuides(guides, '')).toHaveLength(3);
    expect(filterGuides(guides, '   ')).toHaveLength(3);
  });

  it('returns nothing when there is no match', () => {
    expect(filterGuides(guides, 'zzz')).toEqual([]);
  });
});

describe('isReservedGuideSlug', () => {
  // A guide on one of these would be created fine and then be permanently
  // unreachable, because Next resolves the static route first.
  it.each(['guides', 'vote', 'privacy', 'legal', 'admin', 'restaurant', 'api', 'ingest', '_next'])(
    'rejects %s',
    (slug) => {
      expect(isReservedGuideSlug(slug)).toBe(true);
    }
  );

  it('is case- and whitespace-insensitive', () => {
    expect(isReservedGuideSlug('  Guides ')).toBe(true);
    expect(isReservedGuideSlug('ADMIN')).toBe(true);
  });

  it('allows real city slugs', () => {
    for (const slug of ['dublin', 'cork', 'limerick', 'new-york', 'guidesburg']) {
      expect(isReservedGuideSlug(slug)).toBe(false);
    }
  });

  it('covers every top-level route that exists today', () => {
    // If a new static top-level route is added, it belongs in this list too.
    expect(RESERVED_GUIDE_SLUGS).toContain('guides');
    expect(RESERVED_GUIDE_SLUGS).toContain('restaurant');
  });
});

describe('GUIDE_FILTER_THRESHOLD', () => {
  it('is high enough that a handful of cities never gets a search box', () => {
    expect(GUIDE_FILTER_THRESHOLD).toBeGreaterThanOrEqual(6);
  });
});
