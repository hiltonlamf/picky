import { describe, expect, it, vi } from 'vitest';
import { extractLocationFromHtml, findLocationOnContactPage, pointInGeoJson } from '../lib/location';

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

  it('uses a compact visible text block with a postcode when semantic address markup is absent', () => {
    const candidate = extractLocationFromHtml(
      '<p>18 Merrion Row,<br>Dublin 2,<br>D02 A316<br>Phone: +35316788872</p>',
      'https://etto.ie/contact'
    );
    expect(candidate).toMatchObject({
      address: '18 Merrion Row, Dublin 2, D02 A316',
      source: 'website_address_element',
    });
  });

  it('stops a visible address at its postcode when contact details follow without labels', () => {
    const candidate = extractLocationFromHtml(
      '<p>16 Aungier St, Dublin, D02 X044 info@restaurant.example +35315388886</p>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: '16 Aungier St, Dublin, D02 X044' });
  });

  it('removes leading phone and email details before a visible address', () => {
    const candidate = extractLocationFromHtml(
      '<p>+31629827120 info@restaurant.example Schollenbrugstraat 8 | 1091EX</p>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: 'Schollenbrugstraat 8 | 1091EX' });
  });

  it('combines an official address with a coordinate published in its map link', () => {
    const candidate = extractLocationFromHtml(
      '<address>12 Main Street, Dublin 2</address><a href="https://www.google.com/maps/@53.341,-6.261,16z">Map</a>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: '12 Main Street, Dublin 2', latitude: 53.341, longitude: -6.261 });
  });

  it('uses one same-domain contact page when the homepage has no address', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<address>5 Dame Street, Dublin 2</address>',
      { status: 200, headers: { 'content-type': 'text/html' } }
    ));
    const candidate = await findLocationOnContactPage(
      '<a href="/contact">Contact</a>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({
      address: '5 Dame Street, Dublin 2',
      source: 'website_contact_page',
      sourceUrl: 'https://restaurant.example/contact',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
  });

  it('treats an About page as an eligible first-party address page', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      '<p>6 Norseman Court,<br>Manor Street, Stoneybatter,<br>Dublin 7, D07 NP83</p>',
      { status: 200, headers: { 'content-type': 'text/html' } }
    ));
    const candidate = await findLocationOnContactPage(
      '<a href="/about">About</a>',
      'https://afianco.ie'
    );
    expect(candidate).toMatchObject({
      address: '6 Norseman Court, Manor Street, Stoneybatter, Dublin 7, D07 NP83',
      source: 'website_contact_page',
      sourceUrl: 'https://afianco.ie/about',
    });
    fetchMock.mockRestore();
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
