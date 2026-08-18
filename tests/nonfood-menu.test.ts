import { describe, it, expect } from 'vitest';
import { isNonFoodMenu } from '@/lib/menu-discovery';

describe('isNonFoodMenu', () => {
  it('flags non-dining menus', () => {
    for (const label of [
      'Allergen Menu',
      'Allergen Information',
      'Allergens',
      // zerozero.nl published an "Allergies" page as a menu — the filter only
      // knew the word "allergen".
      'Allergies',
      'Allergy Information',
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
      // Cook-at-home kits: a product you finish yourself, not a menu you can
      // order at a table. rasam.ie sells "Dine at Home (Download)".
      'Dine at Home',
      'Dine at Home (Download)',
      'Heat at Home',
      'Cook at Home',
      'Meal Kits',
      'Home Kit',
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
      // The at-home rule is word-bounded, so these must not be caught.
      'Homemade Pasta',
      'Home Style Curry',
    ]) {
      expect(isNonFoodMenu(label), label).toBe(false);
    }
  });
});
