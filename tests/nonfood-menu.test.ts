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
      'Group Bookings',
      'Opt-out Preferences',
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
      'Group Menu',
      'Brunch',
      'Neighbourhood Menu',
      'Main Menu',
      'Homemade Pasta',
      'Home Style Curry',
      // Cook-at-home menus ARE menus. Founder's call (2026-08-23): rasam.ie's
      // "Dine at Home" is one of the three menus he wants diners to see,
      // alongside Early Bird and A La Carte. Only ORDERING channels
      // (delivery/collection/takeaway) are excluded, not food the restaurant
      // cooks that you happen to finish at home.
      'Dine at Home',
      'Dine at Home (Download)',
      'Heat at Home',
      'Meal Kits',
    ]) {
      expect(isNonFoodMenu(label), label).toBe(false);
    }
  });
});
