import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { findMenuLinks, findNavLinks, findMenuImages } from '@/lib/scraper';

const BASE = 'https://example-restaurant.ie/';

describe('findMenuLinks', () => {
  it('finds same-origin menu links', () => {
    const $ = cheerio.load(`<a href="/menu">Our Menu</a><a href="/contact">Contact</a>`);
    const { htmlLinks } = findMenuLinks($, BASE);
    expect(htmlLinks).toEqual(['https://example-restaurant.ie/menu']);
  });

  it('keeps external ordering-platform links (Toast/Square/order.*) as menu candidates', () => {
    const $ = cheerio.load(`
      <a href="https://order.toasttab.com/online/some-cafe">Order online</a>
      <a href="https://order.somecafe.com/menu">Order</a>
      <a href="https://www.instagram.com/somecafe">Instagram</a>
    `);
    const { htmlLinks } = findMenuLinks($, BASE);
    expect(htmlLinks).toContain('https://order.toasttab.com/online/some-cafe');
    expect(htmlLinks).toContain('https://order.somecafe.com/menu');
    expect(htmlLinks.some((l) => l.includes('instagram'))).toBe(false);
  });

  it('rejects other external links even with menu keywords', () => {
    const $ = cheerio.load(`<a href="https://other-site.com/menu">Menu</a>`);
    const { htmlLinks } = findMenuLinks($, BASE);
    expect(htmlLinks).toHaveLength(0);
  });
});

describe('findNavLinks (deep-discovery fallback)', () => {
  it('boosts food-adjacent nav slugs and excludes noise', () => {
    const $ = cheerio.load(`
      <nav>
        <a href="/restaurants">Restaurants</a>
        <a href="/contact">Contact</a>
        <a href="/gallery">Gallery</a>
        <a href="/private-hire">Private hire</a>
        <a href="/our-story-behind-everything/deep/path">Story</a>
      </nav>
    `);
    const links = findNavLinks($, BASE);
    expect(links[0]).toBe('https://example-restaurant.ie/restaurants');
    expect(links.some((l) => l.includes('contact'))).toBe(false);
    expect(links.some((l) => l.includes('gallery'))).toBe(false);
  });

  it('is same-origin only and capped', () => {
    const anchors = Array.from({ length: 15 }, (_, i) => `<a href="/page-${i}">Page ${i}</a>`).join('');
    const $ = cheerio.load(anchors + `<a href="https://elsewhere.com/dining">Dining</a>`);
    const links = findNavLinks($, BASE);
    expect(links.length).toBeLessThanOrEqual(8);
    expect(links.every((l) => l.startsWith('https://example-restaurant.ie/'))).toBe(true);
  });
});

describe('findMenuImages scoring', () => {
  it('prefers menu-named images over gallery photography', () => {
    const $ = cheerio.load(`
      <img src="/uploads/gallery/dumplings-photo-1.jpg" alt="our food">
      <img src="/uploads/food-menu-2026.jpg" alt="menu">
      <img src="/uploads/hero-slide-3.jpg" alt="">
    `);
    const images = findMenuImages($, BASE);
    expect(images[0]).toContain('food-menu-2026');
  });

  it('skips logos and icons entirely', () => {
    const $ = cheerio.load(`<img src="/logo.png"><img src="/favicon.ico"><img src="/menu-board.jpg">`);
    const images = findMenuImages($, BASE);
    expect(images).toHaveLength(1);
    expect(images[0]).toContain('menu-board');
  });

  // Regression: Good World (goodworld.ie). Every img on its menu page shared
  // one placeholder in `src` with the real image in `data-src`. Reading `src`
  // first collapsed the whole page to a single blank spacer, so the vision
  // call was handed an empty image and correctly reported "no menu text".
  it('prefers lazy-load attributes over a shared placeholder src', () => {
    const $ = cheerio.load(`
      <img src="/images/imgbg.png" data-src="/comdata/dim-sum-menu.png">
      <img src="/images/imgbg.png" data-lazy-src="/comdata/second-page.jpg">
      <img src="/images/imgbg.png" data-original="/comdata/third-page.jpg">
    `);
    const images = findMenuImages($, BASE);
    expect(images).toHaveLength(3);
    expect(images.some((u) => u.includes('imgbg'))).toBe(false);
    expect(images.some((u) => u.includes('dim-sum-menu'))).toBe(true);
    expect(images.some((u) => u.includes('second-page'))).toBe(true);
    expect(images.some((u) => u.includes('third-page'))).toBe(true);
  });

  it('still uses src when there is no lazy-load attribute', () => {
    const $ = cheerio.load(`<img src="/uploads/menu-board.jpg">`);
    expect(findMenuImages($, BASE)[0]).toContain('menu-board');
  });
});
