import { describe, expect, it } from 'vitest';
import { CITY_VOTE_OPTIONS, cityVoteKey, normaliseCustomCity } from '@/lib/city-vote';

describe('city vote inventory', () => {
  it('keeps every listed city unique', () => {
    const keys = CITY_VOTE_OPTIONS.map((option) => cityVoteKey(option.city, option.country));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has broad coverage in every promised region', () => {
    const counts = Object.groupBy(CITY_VOTE_OPTIONS, (option) => option.region);
    expect(counts.Europe?.length).toBeGreaterThanOrEqual(30);
    expect(counts.Asia?.length).toBeGreaterThanOrEqual(20);
    expect(counts.USA?.length).toBeGreaterThanOrEqual(20);
  });

  it('does not ask people to vote for the existing Dublin guide', () => {
    expect(CITY_VOTE_OPTIONS.some((option) => option.city === 'Dublin')).toBe(false);
  });
});

describe('normaliseCustomCity', () => {
  it('trims and collapses pasted whitespace', () => {
    expect(normaliseCustomCity('  Cork,   Ireland  ')).toBe('Cork, Ireland');
  });
});
