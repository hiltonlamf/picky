import { describe, it, expect } from 'vitest';
import { normalizeUrl, restaurantDedupKey, canonicalRestaurantUrl, findMatchingRestaurantId } from '@/lib/db';

// Regression coverage for two production duplicates caused by the old
// candidate-string-reconstruction approach in findExistingRestaurant:
// galleon.ie (missing trailing slash) and isaacsrestaurant.ie (a malformed
// triple-slash URL, plus a www/non-www split) each got scraped 2-3 times as
// "different" restaurants.
describe('normalizeUrl', () => {
  it('treats a missing trailing slash as the same URL (the galleon.ie bug)', () => {
    expect(normalizeUrl('https://www.galleon.ie')).toBe(normalizeUrl('https://www.galleon.ie/'));
  });

  it('treats a malformed extra slash after the protocol as the same URL (the isaacsrestaurant.ie bug)', () => {
    expect(normalizeUrl('https:///isaacsrestaurant.ie')).toBe(normalizeUrl('https://isaacsrestaurant.ie'));
  });

  it('treats www and non-www as the same URL', () => {
    expect(normalizeUrl('https://www.isaacsrestaurant.ie/')).toBe(normalizeUrl('https://isaacsrestaurant.ie/'));
  });

  it('is case-insensitive', () => {
    expect(normalizeUrl('HTTPS://Example.COM/')).toBe(normalizeUrl('https://example.com'));
  });
});

// The dohertysbar.ie bug: a subpage (/menu/) and the root were stored as two
// separate restaurants because the dedup key kept the path. A dedicated domain
// must collapse every subpage/www/scheme variant to one key.
describe('restaurantDedupKey', () => {
  it('collapses a subpage and the root of a dedicated domain to one key', () => {
    const root = restaurantDedupKey('https://dohertysbar.ie');
    expect(restaurantDedupKey('https://dohertysbar.ie/menu/')).toBe(root);
    expect(restaurantDedupKey('dohertysbar.ie')).toBe(root);
    expect(restaurantDedupKey('www.dohertysbar.ie')).toBe(root);
    expect(restaurantDedupKey('https://www.dohertysbar.ie/menu/lunch')).toBe(root);
  });

  it('keeps distinct restaurants on a shared platform separate (no over-merge)', () => {
    // Two different restaurants living under one ordering-platform host must NOT
    // collapse into one — the path is part of their identity there.
    expect(restaurantDedupKey('https://the-happy-pear.square.site'))
      .not.toBe(restaurantDedupKey('https://another-cafe.square.site'));
    expect(restaurantDedupKey('https://toasttab.com/restaurant-a'))
      .not.toBe(restaurantDedupKey('https://toasttab.com/restaurant-b'));
    // Google Maps / social links likewise stay distinct per path.
    expect(restaurantDedupKey('https://instagram.com/cafe-one'))
      .not.toBe(restaurantDedupKey('https://instagram.com/cafe-two'));
  });
});

describe('canonicalRestaurantUrl', () => {
  it('strips subpage/www/trailing-slash to a clean, valid root link for a dedicated domain', () => {
    expect(canonicalRestaurantUrl('https://www.dohertysbar.ie/menu/')).toBe('https://dohertysbar.ie');
    expect(canonicalRestaurantUrl('dohertysbar.ie')).toBe('https://dohertysbar.ie');
  });

  it('leaves a shared-platform URL untouched (the path is the identity)', () => {
    expect(canonicalRestaurantUrl('https://toasttab.com/restaurant-a')).toBe('https://toasttab.com/restaurant-a');
  });
});

describe('findMatchingRestaurantId', () => {
  it('matches an existing row by normalized url despite formatting differences', () => {
    const rows = [{ id: 'a', url: 'https://www.galleon.ie/', canonical_url: 'https://www.galleon.ie/brunch-menu' }];
    expect(findMatchingRestaurantId('https://www.galleon.ie', rows)).toBe('a');
  });

  it('matches a subpage submission against a stored root (the dohertysbar.ie bug)', () => {
    const rows = [{ id: 'a', url: 'https://dohertysbar.ie', canonical_url: 'https://dohertysbar.ie/menu/' }];
    expect(findMatchingRestaurantId('https://dohertysbar.ie/menu/', rows)).toBe('a');
    expect(findMatchingRestaurantId('www.dohertysbar.ie', rows)).toBe('a');
  });

  it('matches a submitted url against another row\'s already-resolved canonical_url', () => {
    const rows = [{ id: 'a', url: 'https://example.com/some-page', canonical_url: 'https://example.com/menu' }];
    expect(findMatchingRestaurantId('https://example.com/menu', rows)).toBe('a');
  });

  it('does not merge two different restaurants on a shared platform host', () => {
    const rows = [{ id: 'a', url: 'https://toasttab.com/restaurant-a', canonical_url: null }];
    expect(findMatchingRestaurantId('https://toasttab.com/restaurant-b', rows)).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const rows = [{ id: 'a', url: 'https://other-restaurant.com', canonical_url: null }];
    expect(findMatchingRestaurantId('https://example.com', rows)).toBeNull();
  });
});
