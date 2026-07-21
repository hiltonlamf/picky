import { describe, it, expect } from 'vitest';
import { isNonFoodMenu } from '@/lib/menu-discovery';

describe('isNonFoodMenu', () => {
  it('flags non-dining menus', () => {
    for (const label of [
      'Allergen Menu',
      'Allergen Information',
      'Catering',
      'Catering Menu',
      'Collection Order',
      'Click & Collect',
      'Delivery',
      'Takeaway Menu',
      'Kids Menu',
      "Children's Menu",
      'Kids Activity Book',
      'Gift Vouchers',
      'Group Booking',
    ]) {
      expect(isNonFoodMenu(label), label).toBe(true);
    }
  });

  it('keeps real dining menus', () => {
    for (const label of [
      'Lunch',
      'Dinner',
      'À la carte',
      'Early Bird',
      'Sunday Menu',
      'Tasting Menu',
      'Set Menu',
      'Brunch',
      'Neighbourhood Menu',
      'Main Menu',
    ]) {
      expect(isNonFoodMenu(label), label).toBe(false);
    }
  });
});
