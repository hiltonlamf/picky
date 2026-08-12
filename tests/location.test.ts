import { describe, expect, it } from 'vitest';
import { extractLocationFromHtml, pointInGeoJson } from '../lib/location';

describe('first-party location extraction', () => {
  it('uses restaurant JSON-LD address and coordinates without model parsing', () => {
    const candidate = extractLocationFromHtml(`
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant","address":{"streetAddress":"5 Example Street","addressLocality":"Dublin","postalCode":"D02 XY12","addressCountry":"IE"},"geo":{"latitude":53.34,"longitude":-6.26}}</script>
    `, 'https://restaurant.example');
    expect(candidate).toMatchObject({
      address: '5 Example Street, Dublin, D02 XY12, IE', latitude: 53.34, longitude: -6.26,
      source: 'website_jsonld', confidence: 'high',
    });
  });

  it('falls back to a visible address element', () => {
    const candidate = extractLocationFromHtml('<address>12 Main Street, Dublin 2</address>', 'https://restaurant.example');
    expect(candidate).toMatchObject({ address: '12 Main Street, Dublin 2', source: 'website_address_element' });
  });

  it('combines an official address with a coordinate published in its map link', () => {
    const candidate = extractLocationFromHtml(
      '<address>12 Main Street, Dublin 2</address><a href="https://www.google.com/maps/@53.341,-6.261,16z">Map</a>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: '12 Main Street, Dublin 2', latitude: 53.341, longitude: -6.261 });
  });
});

describe('local neighbourhood assignment geometry', () => {
  const geometry = { type: 'Polygon' as const, coordinates: [[[-6.3, 53.3], [-6.2, 53.3], [-6.2, 53.4], [-6.3, 53.4], [-6.3, 53.3]]] };
  it('matches a coordinate inside GeoJSON without a reverse-geocoding call', () => {
    expect(pointInGeoJson({ latitude: 53.34, longitude: -6.26 }, geometry)).toBe(true);
  });
  it('does not match a coordinate outside the imported boundary', () => {
    expect(pointInGeoJson({ latitude: 53.5, longitude: -6.26 }, geometry)).toBe(false);
  });
});
