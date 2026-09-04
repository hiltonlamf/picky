import { describe, expect, it, vi } from 'vitest';
import {
  areAddressesEquivalent,
  cleanPublishedAddress,
  dedupeLocationCandidates,
  extractLocationFromHtml,
  extractLocationsFromHtml,
  findLocationOnContactPage,
  findLocationsOnContactPages,
  pointInGeoJson,
} from '../lib/location';

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

  it('keeps every branch published as structured first-party data', () => {
    const candidates = extractLocationsFromHtml(`
      <script type="application/ld+json">[{"@type":"Restaurant","name":"North","address":{"streetAddress":"1 North Street","addressLocality":"Dublin","postalCode":"D01 AB12"}},{"@type":"Restaurant","name":"South","address":{"streetAddress":"2 South Street","addressLocality":"Dublin","postalCode":"D02 CD34"}}]</script>
    `, 'https://restaurant.example/locations');
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.label)).toEqual(['North', 'South']);
    expect(candidates.map((candidate) => candidate.address)).toEqual([
      '1 North Street, Dublin, D01 AB12',
      '2 South Street, Dublin, D02 CD34',
    ]);
  });

  it('collapses equivalent first-party Dublin address variants by Eircode', () => {
    const candidates = dedupeLocationCandidates([
      { label: 'Sichuan Chilli King 老湘好', address: '100 Parnell Street Parnell Street, Dublin 1, IE, D01 A7P8, IE', confidence: 'high', source: 'website_jsonld', sourceUrl: 'https://sichuanchilliking.com' },
      { label: 'Sichuan Chilli King 老湘好', address: '100 PARNELL STREET, DUBLIN 1, IE, D01 A7P8, IE', confidence: 'high', source: 'website_jsonld', sourceUrl: 'https://sichuanchilliking.com' },
      { address: '地址：100 Parnell street D01A7P8', confidence: 'medium', source: 'website_address_element', sourceUrl: 'https://sichuanchilliking.com' },
      { address: 'Sichuan Chilli King Chinese Restaruant-English Menu, 100 Parnell Street, Parnell Street, Dublin 1, D01 A7P8', confidence: 'medium', source: 'website_map_link', sourceUrl: 'https://sichuanchilliking.com' },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      label: 'Sichuan Chilli King 老湘好',
      address: '100 Parnell Street, Dublin 1, D01 A7P8, IE',
      confidence: 'high',
    });
  });

  it('uses matching Eircodes as duplicate evidence but keeps distinct branches', () => {
    expect(areAddressesEquivalent('地址：100 Parnell street D01A7P8', '100 Parnell Street, Dublin 1, D01 A7P8')).toBe(true);
    expect(areAddressesEquivalent('1 North Street, Dublin, D01 AB12', '2 South Street, Dublin, D02 CD34')).toBe(false);
    expect(cleanPublishedAddress('Sichuan Chilli King Restaurant Menu, 100 Parnell Street, Parnell Street, Dublin 1, D01A7P8'))
      .toBe('100 Parnell Street, Dublin 1, D01 A7P8');
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

  it('uses an explicitly located-at address from first-party metadata', () => {
    const candidate = extractLocationFromHtml(`
      <title>Forest Avenue | Dublin 4</title>
      <meta name="description" content="Forest Avenue is a modern restaurant located at 126 Leeson Street Upper.">
    `, 'https://forestavenuerestaurant.ie/menu');
    expect(candidate).toMatchObject({
      address: '126 Leeson Street Upper, Dublin 4',
      source: 'website_address_element',
      confidence: 'medium',
    });
  });

  it('prefers the named branch on a specific group-site page', () => {
    const candidates = extractLocationsFromHtml(`
      <p class="address">Charlotte Quay Dock, Millennium Tower, Ground Floor, Ringsend Rd, Dublin 4</p>
      <p class="address">Row Wines, City Assembly House, Coppinger Row, Dublin 2</p>
      <p class="address">Location—8 Orwell Road, D06 H2Y5</p>
    `, 'https://bereenbrothers.com/orwell-road');
    expect(candidates.map((candidate) => candidate.address)).toEqual(['8 Orwell Road, D06 H2Y5']);
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

  it('accepts a compact street-and-city block when the site omits a postcode', () => {
    const candidate = extractLocationFromHtml(
      '<footer><p>14 Trinity Street,<br>Dublin 2</p></footer>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: '14 Trinity Street, Dublin 2' });
  });

  it('accepts a short unnumbered street address published before the city', () => {
    const candidate = extractLocationFromHtml(
      '<footer><p>Fade Street Social,<br>Fade Street,<br>Dublin 2, Ireland</p></footer>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: 'Fade Street Social, Fade Street, Dublin 2' });
  });

  it('accepts a compact labelled venue address without a street suffix', () => {
    const candidate = extractLocationFromHtml(
      '<p class="address">Gigi Ranelagh, 53 Ranelagh<br>Dublin 6, Ireland</p>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: 'Gigi Ranelagh, 53 Ranelagh Dublin 6' });
  });

  it('finds several branch addresses published in heading blocks', () => {
    const candidates = extractLocationsFromHtml(
      '<h4>Kerkstraat 332<br>1017 JA Amsterdam</h4><h4>Voetboogstraat 23<br>1012 XK Amsterdam</h4>',
      'https://restaurant.example'
    );
    expect(candidates.map((candidate) => candidate.address)).toEqual([
      'Kerkstraat 332 1017 JA Amsterdam',
      'Voetboogstraat 23 1012 XK Amsterdam',
    ]);
  });

  it('accepts a first-party address block in an unfamiliar city and country', () => {
    const candidates = extractLocationsFromHtml(
      '<footer><p>12 Rue de Rivoli<br>75001 Paris, France</p></footer>',
      'https://restaurant.example'
    );
    expect(candidates[0]?.address).toBe('12 Rue de Rivoli 75001 Paris, France');
  });

  it('does not mistake promotional copy mentioning a city and unrelated number for an address', () => {
    const candidate = extractLocationFromHtml(
      '<p>DÍON is Dublin\'s first wine bar with 20 bottles, just off Market Lane.</p>',
      'https://restaurant.example'
    );
    expect(candidate).toBeNull();
  });

  it('does not mistake a year following the letter D for an Eircode', () => {
    const candidate = extractLocationFromHtml(
      '<p>Graham held the post in Ireland from 2016 to 2019.</p>',
      'https://restaurant.example'
    );
    expect(candidate).toBeNull();
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

  it('checks a same-site splash page used as the restaurant homepage', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(`
      <title>Forest Avenue | Dublin 4</title>
      <meta name="description" content="Forest Avenue is located at 126 Leeson Street Upper.">
    `, { status: 200, headers: { 'content-type': 'text/html' } }));
    const candidates = await findLocationsOnContactPages(
      '<a href="/splash">Forest Avenue</a>',
      'https://forestavenuerestaurant.ie/'
    );
    expect(candidates.map((candidate) => candidate.address)).toEqual(['126 Leeson Street Upper, Dublin 4']);
    fetchMock.mockRestore();
  });

  it('checks another relevant page when the first one has no address', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<p>Our story</p>', { status: 200, headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('<p>4 Example Street, Dublin 2</p>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const candidate = await findLocationOnContactPage(
      '<a href="/about">About</a><a href="/visit">Visit us</a>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: '4 Example Street, Dublin 2' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it('combines branches found across several first-party location pages', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<address>1 North Street, Dublin 1</address>', { status: 200, headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(new Response('<address>2 South Street, Dublin 2</address>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const candidates = await findLocationsOnContactPages(
      '<a href="/locations/north">North location</a><a href="/locations/south">South location</a>',
      'https://restaurant.example'
    );
    expect(candidates.map((candidate) => candidate.address)).toEqual([
      '1 North Street, Dublin 1',
      '2 South Street, Dublin 2',
    ]);
    fetchMock.mockRestore();
  });

  it('fetches independent contact pages concurrently while preserving page order', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      const north = String(input).includes('north');
      return new Response(
        `<address>${north ? '1 North Street, Dublin 1' : '2 South Street, Dublin 2'}</address>`,
        { status: 200, headers: { 'content-type': 'text/html' } }
      );
    });
    const candidates = await findLocationsOnContactPages(
      '<a href="/locations/north">North location</a><a href="/locations/south">South location</a>',
      'https://restaurant.example'
    );

    expect(maxActive).toBe(2);
    expect(candidates.map((candidate) => candidate.address)).toEqual([
      '1 North Street, Dublin 1',
      '2 South Street, Dublin 2',
    ]);
    fetchMock.mockRestore();
  });

  it('treats www and bare-domain contact links as the same first-party site', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response('<p>4 Example Street, Dublin 2</p>', { status: 200, headers: { 'content-type': 'text/html' } })
    );
    const candidate = await findLocationOnContactPage(
      '<a href="https://www.restaurant.example/contact">Contact</a>',
      'https://restaurant.example'
    );
    expect(candidate).toMatchObject({ address: '4 Example Street, Dublin 2' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
