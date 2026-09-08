import { describe, it, expect } from 'vitest';
import {
  isSeafoodDish,
  isPescatarianDish,
  effectiveDietaryClassification,
} from '@/lib/dietary-overrides';
import type { DietaryClassification } from '@/types';

// Cases are real dish names from the Dublin and Amsterdam guides wherever
// possible, and asserted in contrasting pairs — the same keyword with opposite
// answers — because that is where every rule bug in this project has lived.

const dish = (
  name: string,
  classification: DietaryClassification = 'neither',
  description: string | null = null
) => ({ name, classification, description });

const seafood = (name: string, description: string | null = null) =>
  isSeafoodDish(null, dish(name, 'neither', description));

describe('seafood detection — English', () => {
  it('recognises plain fish dishes', () => {
    expect(seafood('Fish & Chips')).toBe(true);
    expect(seafood('Grilled Salmon')).toBe(true);
    expect(seafood('Pan-fried Hake, Sea Vegetables')).toBe(true);
    expect(seafood('Smoked Haddock Chowder')).toBe(true);
    expect(seafood('Whole Sea Bass')).toBe(true);
  });

  it('recognises shellfish, molluscs and crustaceans — the founder named these', () => {
    expect(seafood('Steamed Clams')).toBe(true);
    expect(seafood('Dublin Bay Prawns')).toBe(true);
    expect(seafood('Crab Claws')).toBe(true);
    expect(seafood('Half Dozen Oysters')).toBe(true);
    expect(seafood('Scallops with pea puree')).toBe(true);
    expect(seafood('Mussels Mariniere')).toBe(true);
    expect(seafood('Lobster Roll')).toBe(true);
    expect(seafood('Squid Ink Arancini')).toBe(true);
  });

  it('recognises preparations that are inherently seafood', () => {
    expect(seafood('Sea Bream Ceviche')).toBe(true);
    expect(seafood('Sashimi Selection')).toBe(true);
    expect(seafood('Taramasalata')).toBe(true);
  });
});

describe('seafood detection — the other languages our menus are written in', () => {
  it('reads Italian dish names', () => {
    expect(seafood('Spaghetti alle Vongole')).toBe(true);
    expect(seafood('Cozze e Fagioli')).toBe(true);
    expect(seafood('Frutti di Mare')).toBe(true);
    expect(seafood('Baccalà Mantecato')).toBe(true);
    expect(seafood('Tagliatelle ai Gamberi')).toBe(true);
    expect(seafood('Polpo alla Griglia')).toBe(true);
  });

  it('reads Spanish dish names', () => {
    expect(seafood('Gambas al Ajillo')).toBe(true);
    expect(seafood('Bacalao a la Vizcaina')).toBe(true);
    expect(seafood('Pulpo a la Gallega')).toBe(true);
    expect(seafood('Boquerones en Vinagre')).toBe(true);
    expect(seafood('Almejas a la Marinera')).toBe(true);
    expect(seafood('Chipirones Fritos')).toBe(true);
  });

  it('reads Dutch dish names — the Amsterdam guide is full of them', () => {
    expect(seafood('Kabeljauw met puree')).toBe(true);
    expect(seafood('Mosselen met friet')).toBe(true);
    expect(seafood('Gerookte Zalm')).toBe(true);
    expect(seafood('Hollandse Nieuwe Haring')).toBe(true);
    expect(seafood('Garnalenkroketten')).toBe(false); // compound word: a miss, not a mislabel
  });
});

describe('the meat guard — an unsafe mislabel here is trust-breaking', () => {
  it('excludes a fixed dish that pairs seafood with meat', () => {
    expect(seafood('Surf & Turf')).toBe(false);
    expect(seafood('Chicken & Prawn Curry')).toBe(false);
    expect(seafood('Paella with chorizo and prawns')).toBe(false);
  });

  it('excludes those dishes in every language the seafood list covers — a\n      seafood list wider than the meat list would actively create bad labels', () => {
    expect(seafood('Pollo e Gamberi')).toBe(false);
    expect(seafood('Paella con chorizo y gambas')).toBe(false);
    expect(seafood('Arroz con pollo y almejas')).toBe(false);
    expect(seafood('Kip met garnalen')).toBe(false);
    expect(seafood('Salsiccia e Vongole')).toBe(false);
  });

  it('excludes plain meat outright', () => {
    expect(seafood('Ribeye Steak')).toBe(false);
    expect(seafood('Roast Chicken')).toBe(false);
    expect(seafood('Beef Rendang')).toBe(false);
  });

  it('treats a burger as a format, not a protein', () => {
    // Fish Shop's "Fillet O'Fish Shop - Our Fish Burger" was being excluded
    // because "burger" sat in the meat list. A burger is a shape.
    expect(seafood("Fillet O'Fish Shop - Our Fish Burger")).toBe(true);
    expect(seafood('Beef Burger with garlic prawns')).toBe(false);
  });

  it('excludes fish plated with meat — the biggest group in the audit', () => {
    expect(seafood('Mussels, Beans, Chorizo, Palmito')).toBe(false);
    expect(seafood("Gambas, N'Duja, Garlic, Spring Onion & Lemon")).toBe(false);
    expect(seafood('Signature Prawn & Pork Wonton with Thin Noodle')).toBe(false);
    expect(seafood('Seared Scallops, Caramelised Parsnip, Yuzu, Bacon')).toBe(false);
    expect(seafood('Atlantic Hake, Braised Leek, Alsace Bacon, Smoked Mussels')).toBe(false);
    expect(seafood('Chicken Wings w/ fish sauce caramel')).toBe(false);
  });
});

describe('the choice exception — a pescatarian orders the prawn', () => {
  it('includes a dish whose protein the diner picks', () => {
    expect(seafood('Pad Thai with a choice of chicken or prawn')).toBe(true);
    expect(seafood('Noodles', 'Choice of chicken, beef or prawns')).toBe(true);
  });

  it('still excludes a fixed dish that merely lists two proteins', () => {
    expect(seafood('Chicken and Prawn Laksa')).toBe(false);
  });

  it('does not treat an optional ADD-ON as a choice — a steak stays a steak', () => {
    // The Church Café Bar, found by scripts/audit-pescatarian.ts against live
    // data (not by a unit test). An add-on is bolted onto a dish that already
    // has its protein; a choice decides what the protein is.
    expect(
      seafood(
        '16oz Rib Eye on the Bone',
        'All steaks are served with fondant potatoes. Optional add-on: pan-fried prawns'
      )
    ).toBe(false);
    expect(seafood('Sirloin Steak', 'Add garlic prawns for €6')).toBe(false);
    expect(seafood('Burger', 'Upgrade to a lobster topping')).toBe(false);
  });

  it('ignores the section hint when the dish name itself says meat', () => {
    // A "Caviar" section marks its dishes as roe (that rule predates this
    // feature and is right for the safety override). It must not drag a steak
    // listed in the same section into the fish tab.
    expect(isSeafoodDish('Caviar', dish('16oz Rib Eye on the Bone'))).toBe(false);
    expect(isSeafoodDish('Caviar', dish('Sevruga Royal'))).toBe(true);
  });
});

describe('plant decoys — a false positive here would hide a vegan dish', () => {
  it('does not treat plant look-alikes as seafood', () => {
    expect(seafood('Oyster Mushroom Skewers')).toBe(false);
    expect(seafood('Lobster Mushroom Risotto')).toBe(false);
    expect(seafood('Crab Apple Chutney')).toBe(false);
    expect(seafood('Vegan Fish Cakes')).toBe(false);
    expect(seafood('Mock Tuna Sandwich')).toBe(false);
  });

  it('cancels only the decoy phrase, not the whole dish', () => {
    // Liath: "Cromane oyster, seaweed hot sauce" — the seaweed used to veto the
    // dish and take a real oyster out of the pescatarian tab with it.
    expect(seafood('Cromane oyster, seaweed hot sauce, fermented gooseberry')).toBe(true);
    expect(seafood('Seaweed butter')).toBe(false);
    // Still correct when the decoy is the whole dish.
    expect(seafood('Oyster Mushroom Skewers')).toBe(false);
  });

  it('does not let "crab meat" trip the meat guard', () => {
    // "Crab Meat Spring Roll" was excluded because the meat guard matched the
    // bare word "meat" inside it. Found in the audit's sushi rows.
    expect(seafood('Crab Meat Spring Roll')).toBe(true);
    expect(seafood('White Crab Meat, Brown Butter')).toBe(true);
    // The generic word still guards a genuinely mixed platter.
    expect(seafood('Authentic Rice Table | Meat, Fish, Vega')).toBe(false);
  });

  it('reads the fish names sushi menus actually use', () => {
    expect(seafood('Japanese Yellowtail roll, mango salsa')).toBe(true);
    expect(seafood('Hamachi crudo')).toBe(true);
  });

  it('reads closed compounds, which a bare \\bfish\\b misses', () => {
    expect(seafood('Fishcakes with lime mayonnaise')).toBe(true);
    expect(seafood('Cured kingfish, lemon, red chili')).toBe(true);
    expect(seafood('Seatrout Crudo, Apple, Kohlrabi')).toBe(true);
  });

  it('never downgrades a vegan dish through the display override', () => {
    // The seafood list also drives effectiveDietaryClassification, which forces
    // 'neither'. A wrong match there hides a vegan dish FROM A VEGAN — worse
    // than any missed fish. These are the names that nearly did it.
    for (const name of [
      'Cucumber Maki',
      'Avocado Nigiri',
      'Corn Chowder',
      'Oyster Mushroom Bao',
      'Seaweed Salad',
      'Sea Salt Focaccia',
    ]) {
      expect(effectiveDietaryClassification(null, dish(name, 'vegan'))).toBe('vegan');
    }
  });
});

describe('ambiguous words need a food context, not a bare match', () => {
  it('reads the fish sense only when the menu means the fish', () => {
    expect(seafood('Dover Sole')).toBe(true);
    expect(seafood('Grilled Sole')).toBe(true);
    expect(seafood('The sole reason we opened')).toBe(false);

    expect(seafood('Sea Bass Fillet')).toBe(true);
    expect(seafood('Bass Notes Cocktail')).toBe(false);

    expect(seafood('Sepia a la Plancha')).toBe(true);
    expect(seafood('Sepia tone dessert')).toBe(false);
  });
});

describe('isPescatarianDish — seafood plus everything vegetarian', () => {
  it('includes every veg dish without ever consulting the word list', () => {
    expect(isPescatarianDish(null, dish('Tofu Curry', 'vegan'))).toBe(true);
    expect(isPescatarianDish(null, dish('Margherita Pizza', 'vegetarian'))).toBe(true);
    // 'unknown' counts, for the same reason the veggie number counts it:
    // when in doubt, show it rather than quietly drop it.
    expect(isPescatarianDish(null, dish('Soup of the day', 'unknown'))).toBe(true);
  });

  it('includes seafood', () => {
    expect(isPescatarianDish(null, dish('Grilled Salmon', 'neither'))).toBe(true);
  });

  it('excludes meat', () => {
    expect(isPescatarianDish(null, dish('Ribeye Steak', 'neither'))).toBe(false);
    expect(isPescatarianDish(null, dish('Surf & Turf', 'neither'))).toBe(false);
  });

  it('is always a superset of vegetarian', () => {
    // A dish stored 'vegan' but named for a fish is corrected to 'neither' by
    // the override first, then caught by the seafood test — so it stays
    // pescatarian either way and never falls between the two rules.
    expect(isPescatarianDish(null, dish('Tuna Salad', 'vegan'))).toBe(true);
    expect(effectiveDietaryClassification(null, dish('Tuna Salad', 'vegan'))).toBe('neither');
  });
});
