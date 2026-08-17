import { describe, expect, it } from 'vitest';
import { dublinAreaForAddress, extractDublinAreaCode } from '../lib/dublin-areas';

describe('Dublin Eircode area mapping', () => {
  it('maps a full Eircode routing key to a broad guide area', () => {
    expect(dublinAreaForAddress('27 Ranelagh Road, Dublin, D06 FYK8, Ireland')).toEqual({
      code: 'D06',
      label: 'D06 · Rathmines / Ranelagh / Rathgar / Milltown',
      display: 'Dublin 6',
    });
  });

  it('supports conventional Dublin postal districts when a full Eircode is absent', () => {
    expect(extractDublinAreaCode('12 Main Street, Dublin, 8')).toBe('D08');
    expect(extractDublinAreaCode('Terenure, Dublin 6W')).toBe('D6W');
  });

  it('does not invent an area for an address outside a supported Dublin district', () => {
    expect(dublinAreaForAddress('1 High Street, Cork, T12 ABCD')).toBeNull();
    expect(dublinAreaForAddress('1 Example Street, Dublin 19')).toBeNull();
  });
});
