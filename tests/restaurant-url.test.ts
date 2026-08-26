import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assignRestaurantSlugs,
  restaurantPath,
  restaurantSlug,
  restaurantSlugFromUrl,
  urlSlug,
  withShareAttribution,
} from '@/lib/restaurant-url';

describe('readable restaurant URLs', () => {
  it('uses lowercase hyphenated city and restaurant names', () => {
    expect(restaurantPath({ id: '1', city: 'Dublin', name: 'Fade Street Social' }))
      .toBe('/restaurant/dublin/fade-street-social');
  });

  it('removes accents and punctuation without underscores', () => {
    expect(urlSlug("Café en Seine & Co." )).toBe('cafe-en-seine-co');
  });

  it('prefers the permanent collision-safe database slug', () => {
    expect(restaurantPath({ id: '2', city: 'dublin', name: 'Daata', slug: 'daata-2' }))
      .toBe('/restaurant/dublin/daata-2');
  });

  it('numbers repeated names without changing the first restaurant', () => {
    const slugs = assignRestaurantSlugs([
      { id: 'newer', city: 'dublin', name: 'Daata', createdAt: '2026-08-02T00:00:00Z' },
      { id: 'first', city: 'dublin', name: 'Daata', createdAt: '2026-08-01T00:00:00Z' },
      { id: 'third', city: 'dublin', name: 'Daata', createdAt: '2026-08-03T00:00:00Z' },
    ]);
    expect(slugs.get('first')).toBe('daata');
    expect(slugs.get('newer')).toBe('daata-2');
    expect(slugs.get('third')).toBe('daata-3');
  });

  it('gives the clean URL to the existing public-guide record during backfill', () => {
    const slugs = assignRestaurantSlugs([
      { id: 'old-duplicate', city: 'dublin', name: 'Daata', createdAt: '2026-07-26T00:00:00Z' },
      {
        id: 'public-record',
        city: 'dublin',
        name: 'Daata',
        createdAt: '2026-07-28T00:00:00Z',
        featuredInPublicCity: true,
      },
    ]);
    expect(slugs.get('public-record')).toBe('daata');
    expect(slugs.get('old-duplicate')).toBe('daata-2');
  });

  it('has a safe fallback when a restaurant has not been named yet', () => {
    expect(restaurantSlug(null)).toBe('restaurant');
  });

  it('uses the restaurant domain for a terminal page with no recovered name', () => {
    expect(restaurantSlugFromUrl('https://www.daata.ie/menu')).toBe('daata');
    expect(restaurantSlugFromUrl('https://order.example.com/shops/green-table')).toBe('green-table');
  });

  it('keeps valid share attribution but drops arbitrary query parameters', () => {
    expect(withShareAttribution('/restaurant/dublin/daata', {
      ref: 'share',
      src: 'native',
      unsafe: 'ignored',
    })).toBe('/restaurant/dublin/daata?ref=share&src=native');
  });

  it('keeps old UUID links as permanent attributed redirects', () => {
    const legacyRoute = readFileSync('app/restaurant/[id]/page.tsx', 'utf8');
    expect(legacyRoute).toContain('permanentRedirect(withShareAttribution(path, searchParams))');
  });

  it('routes guide cards through the shared readable-path helper', () => {
    const card = readFileSync('components/RestaurantCard.tsx', 'utf8');
    const carousel = readFileSync('components/GuideRestaurantCarousel.tsx', 'utf8');
    expect(card).toContain('href={restaurantPath(restaurant, city)}');
    expect(card).not.toContain('href={`/restaurant/${restaurant.id}`}');
    expect(carousel).toContain('<RestaurantCard restaurant={restaurant} city="dublin" />');
  });

  it('assigns slugs on every future terminal outcome', () => {
    const database = readFileSync('lib/db.ts', 'utf8');
    const errorBody = database.slice(
      database.indexOf('export async function markRestaurantError'),
      database.indexOf('export async function markRestaurantNoMenu')
    );
    const noMenuBody = database.slice(
      database.indexOf('export async function markRestaurantNoMenu'),
      database.indexOf('export async function confirmNoMenu')
    );
    expect(errorBody).toContain('await ensureRestaurantSlug(restaurantId)');
    expect(noMenuBody).toContain('await ensureRestaurantSlug(restaurantId)');
  });
});
