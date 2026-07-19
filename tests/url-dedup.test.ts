import { describe, it, expect } from 'vitest';
import { normalizeUrl, findMatchingRestaurantId } from '@/lib/db';

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

describe('findMatchingRestaurantId', () => {
  it('matches an existing row by normalized url despite formatting differences', () => {
    const rows = [{ id: 'a', url: 'https://www.galleon.ie/', canonical_url: 'https://www.galleon.ie/brunch-menu' }];
    expect(findMatchingRestaurantId(normalizeUrl('https://www.galleon.ie'), rows)).toBe('a');
  });

  it('matches a submitted url against another row\'s already-resolved canonical_url', () => {
    const rows = [{ id: 'a', url: 'https://example.com/some-page', canonical_url: 'https://example.com/menu' }];
    expect(findMatchingRestaurantId(normalizeUrl('https://example.com/menu'), rows)).toBe('a');
  });

  it('returns null when nothing matches', () => {
    const rows = [{ id: 'a', url: 'https://other-restaurant.com', canonical_url: null }];
    expect(findMatchingRestaurantId(normalizeUrl('https://example.com'), rows)).toBeNull();
  });
});
