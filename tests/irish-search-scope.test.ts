import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractLocationFromHtml, looksLikeIrishAddress } from '@/lib/location';
import { guideCityForPlace } from '@/lib/db';

/**
 * Search covers the Republic of Ireland, not just Dublin.
 *
 * The bar these tests hold is asymmetric on purpose. A missed Irish address
 * costs a visitor one extra step — they can still paste the restaurant's link.
 * A false positive puts a foreign restaurant in front of someone searching
 * their own city, which reads as broken. So the negatives matter more than the
 * positives here.
 */

describe('looksLikeIrishAddress', () => {
  it.each([
    ['a Dublin address with an Eircode', '12 Wellington Quay, Temple Bar, Dublin 2, D02 XY45'],
    ['a Cork Eircode', 'Market Lane, 5 Oliver Plunkett St, Cork, T12 X2RH'],
    ['a Limerick Eircode', '3 Ellen St, Limerick, V94 E7Y0'],
    ['a Galway Eircode', 'Kirwans Lane, Galway, H91 XY72'],
    ['the country named outright', 'Spanish Arch, Galway, Ireland'],
    ['the Irish spelling', 'Baile Átha Cliath, Éire'],
    ['a county with no postcode', 'Main Street, Kinsale, Co. Cork'],
    ['a town that is not a county', 'The Tannery, Dungarvan, Co. Waterford'],
    ['the D6W special case', '108 Rathgar Road, Dublin 6W, D6W AB12'],
    // The unique identifier may start with a digit, which makes the whole
    // Eircode look UK-postcode-shaped. The Eircode has to win that tie.
    ['an Eircode whose second half starts with a digit', 'The Square, Cahir, A65 2CD4'],
  ])('accepts %s', (_label, address) => {
    expect(looksLikeIrishAddress(address)).toBe(true);
  });

  it.each([
    // Northern Ireland is out of scope: Google files it under region `gb`, and
    // the product covers the Republic.
    ['Belfast', '10 Donegall Square, Belfast BT1 5GS'],
    ['London', '55 Great Russell St, London WC1B 3BE'],
    ['a UK postcode beside an Irish-sounding street', 'Dublin Road, Newry BT35 8QB'],
    ['Amsterdam', 'Prinsengracht 263, 1016 GV Amsterdam'],
    ['prose with a year in it', 'Open from 2016 to 2019 every day'],
    ['prose with a course count', 'Serving 12 courses since 1998'],
    ['an empty string', ''],
  ])('rejects %s', (_label, address) => {
    expect(looksLikeIrishAddress(address)).toBe(false);
  });

  it('treats a missing address as not-Irish rather than throwing', () => {
    expect(looksLikeIrishAddress(null)).toBe(false);
    expect(looksLikeIrishAddress(undefined)).toBe(false);
  });

  it('does not match a routing-key-shaped word inside ordinary prose', () => {
    // The restricted Eircode alphabet is what stops this: B, G, I, J, M, O, Q,
    // S, U and Z never start a routing key.
    expect(looksLikeIrishAddress('Booking B12 3456 confirmed')).toBe(false);
  });
});

describe('scraped address extraction', () => {
  // Before Ireland-wide search, the visible-text matcher recognised only
  // Dublin/Amsterdam/London/Westport — so a Cork restaurant printing its
  // address in a plain <p> yielded no address at all.
  it('extracts a Cork address from a plain paragraph', () => {
    const html = '<html><body><p>5 Oliver Plunkett Street, Cork, T12 X2RH</p></body></html>';
    const found = extractLocationFromHtml(html, 'https://example.ie');
    expect(found?.address).toContain('Cork');
  });

  it('still extracts a Dublin address', () => {
    const html = '<html><body><p>12 Wellington Quay, Dublin 2, D02 XY45</p></body></html>';
    const found = extractLocationFromHtml(html, 'https://example.ie');
    expect(found?.address).toContain('Dublin');
  });
});

describe('search scope contracts', () => {
  it('bounds Google autocomplete to Ireland, with the region code as the real filter', () => {
    const places = readFileSync('lib/google-places.ts', 'utf8');
    expect(places).toContain("includedRegionCodes: ['ie']");
    expect(places).toContain('IRELAND_BOUNDS');
    // The Dublin circle is what made search Dublin-only.
    expect(places).not.toContain('DUBLIN_CENTRE');
    expect(places).not.toContain('DUBLIN_SEARCH_RADIUS_METRES');
  });

  it('never assumes a Google-sourced restaurant is in Dublin', () => {
    const route = readFileSync('app/api/parse/discover/route.ts', 'utf8');
    expect(route).not.toContain("discoveryCity = 'dublin'");
    expect(route).toContain('guideCityForPlace(place)');
  });

  it('drives the searchable cities from the guides table, not a hardcoded list', () => {
    const database = readFileSync('lib/db.ts', 'utf8');
    const body = database.slice(
      database.indexOf('export async function searchIrishRestaurantsByName'),
      database.indexOf('export async function getRestaurantSearchTarget')
    );
    expect(body).toContain('searchableCities()');
    expect(body).toContain('looksLikeIrishAddress');
    // The old Dublin-only address test must be gone.
    expect(body).not.toContain('\\bdublin\\b');
  });

  it('keeps the search copy out of the component and free of Dublin', () => {
    const hero = readFileSync('components/HeroSearch.tsx', 'utf8');
    expect(hero).not.toContain('Dublin');
    expect(hero).toContain('SEARCH.searching');
  });
});

describe('guideCityForPlace', () => {
  it('files a place outside Ireland as unassigned rather than guessing a city', async () => {
    await expect(
      guideCityForPlace({ locality: 'Belfast', formattedAddress: '10 Donegall Square, Belfast BT1 5GS' })
    ).resolves.toBe('unassigned');
    await expect(
      guideCityForPlace({ locality: 'London', formattedAddress: '55 Great Russell St, London WC1B 3BE' })
    ).resolves.toBe('unassigned');
  });

  it('files a place with no address as unassigned', async () => {
    await expect(guideCityForPlace({ locality: null, formattedAddress: null })).resolves.toBe('unassigned');
  });

  it('degrades to unassigned when the guides table cannot be read', async () => {
    // No database in tests. The safe direction is "we do not know" — never a
    // fallback city, which is what filing everything as Dublin used to do.
    await expect(
      guideCityForPlace({ locality: 'Cork', formattedAddress: '5 Oliver Plunkett St, Cork, T12 X2RH' })
    ).resolves.toBe('unassigned');
  });
});
