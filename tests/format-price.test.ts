import { describe, expect, it } from 'vitest';
import { formatPrice } from '@/lib/format-price';

describe('formatPrice', () => {
  it('assumes euro for bare numbers', () => {
    expect(formatPrice('4')).toBe('€4');
    expect(formatPrice('14.50')).toBe('€14.50');
    expect(formatPrice('14,50')).toBe('€14,50');
    expect(formatPrice(' 27 ')).toBe('€27');
  });

  it('marks every price in a range or split', () => {
    expect(formatPrice('12 / 18')).toBe('€12 / €18');
    expect(formatPrice('9-12')).toBe('€9-€12');
  });

  it('never relabels a currency the menu already states', () => {
    expect(formatPrice('€7.50')).toBe('€7.50');
    expect(formatPrice('£12')).toBe('£12');
    expect(formatPrice('$18')).toBe('$18');
    expect(formatPrice('¥1200')).toBe('¥1200');
    expect(formatPrice('12 USD')).toBe('12 USD');
    expect(formatPrice('120 kr')).toBe('120 kr');
    // A Tokyo restaurant must not come out priced in euro.
    expect(formatPrice('1200 JPY')).toBe('1200 JPY');
  });

  it('returns null when there is no price to show', () => {
    expect(formatPrice(null)).toBeNull();
    expect(formatPrice(undefined)).toBeNull();
    expect(formatPrice('')).toBeNull();
    expect(formatPrice('   ')).toBeNull();
    expect(formatPrice('market price')).toBeNull();
  });
});
