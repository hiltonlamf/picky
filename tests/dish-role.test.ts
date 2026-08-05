import { describe, it, expect } from 'vitest';
import { classifyDishRole, isCountedDish, isSimpleName } from '@/lib/dish-role';

// Every case below is a REAL dish from the Dublin or Amsterdam guide. The
// pairs are the point: the same keyword must resolve differently depending on
// whether the name is a staple or a composed dish.
const role = (section: string, name: string) => classifyDishRole(section, { name }).role;

describe('isSimpleName', () => {
  it('treats short staple names as simple', () => {
    expect(isSimpleName('Bread & Butter')).toBe(true);
    expect(isSimpleName('Butter Naan')).toBe(true);
    expect(isSimpleName('Garlic, Onion and Coriander Naan')).toBe(true);
  });

  it('treats composed, component-listing names as not simple', () => {
    expect(isSimpleName('48-hour Sourdough, Parmesan Custard, Cep Butter')).toBe(false);
    expect(isSimpleName('Gordal Olives Marinated in Orange, Rosemary, and Chilli')).toBe(false);
    expect(isSimpleName('Braised kombu, salted milk ice cream, bergamot')).toBe(false);
  });

  it('ignores parentheticals when measuring length', () => {
    expect(isSimpleName('Sesame sauce (Jhol achar)')).toBe(true);
  });
});

describe('classifyDishRole', () => {
  describe('the Indian-restaurant trap — section names must not decide', () => {
    // These sit under sections called "Condiments/Sides" and "Accompaniments"
    // but are the actual vegetarian offering, priced €8–€14.50.
    it('counts vegetarian curries filed under a sides/condiments section', () => {
      expect(role('Condiments/Sides', 'Palak Paneer')).toBe('counted');
      expect(role('Condiments/Sides', 'Bhindi Masala')).toBe('counted');
      expect(role('Condiments/Sides', 'Ghar Ki Dal')).toBe('counted');
      expect(role('Accompaniments', 'Aloo Gobi')).toBe('counted');
      expect(role('Accompaniments', 'Tadka Broccoli')).toBe('counted');
      expect(role('Sides', 'Saag Paneer')).toBe('counted');
    });

    it('still drops the breads and rice from those same sections', () => {
      expect(role('Breads, Rice & Salads', 'Dilli Wala Butter Naan')).toBe('staple');
      expect(role('Breads, Rice & Salads', 'Basmati Rice')).toBe('staple');
      expect(role('Breads, Rice & Salads', 'Pudina Parantha')).toBe('staple');
      expect(role('Accompaniments', 'Cucumber Raita')).toBe('condiment');
    });

    it('counts a salad that happens to share the bread section', () => {
      expect(role('Breads, Rice & Salads', 'Indian Green Salad')).toBe('counted');
    });
  });

  describe('the simple-name guard', () => {
    it('drops bread-and-butter but keeps a composed sourdough starter', () => {
      expect(role('Snacks + Starters', 'Bread + Butter')).toBe('staple');
      expect(role('Starters', '48-hour Sourdough, Parmesan Custard, Cep Butter')).toBe('counted');
    });

    it('keeps a savoury dish that merely mentions ice cream', () => {
      expect(role('Seafood Tapas', 'Braised kombu, salted milk ice cream, bergamot')).toBe('counted');
    });

    it('keeps a composed olive dish but drops the plain one', () => {
      expect(role('Snacks', 'Olives')).toBe('staple');
      expect(role('Bites', 'Gordal Olives Marinated in Orange, Rosemary, and Chilli')).toBe('counted');
    });
  });

  // Every rule here reads the FAR END of the name. The head rules above assume
  // English dish names are head-initial ("Chips with mayo" is chips), which is
  // true of an accompaniment but false of a modifier list: "Garlic, Onion and
  // Coriander Naan" is a naan whose head is "garlic". Rasam's other five naans
  // were excluded and that one was counted, which is how the gap surfaced.
  describe('staples named head-finally', () => {
    it('drops a naan however many things are sprinkled on it', () => {
      expect(role('Tandoori Breads & Rice', 'Garlic, Onion and Coriander Naan')).toBe('staple');
      expect(role('Breads, Rice', 'Garlic, Onion & Coriander Naan')).toBe('staple');
    });

    it('keeps a main course that merely arrives with a naan', () => {
      // The "with …" clause is stripped before the tail is read, so the dish is
      // judged on "paneer tikka" — otherwise every Indian main served with
      // bread would vanish.
      expect(role('Mains', 'Paneer Tikka with Butter Naan')).toBe('counted');
    });

    it('drops bread and butter without eating the composed starter', () => {
      expect(role('Snacks', 'Guinness Bread & Butter')).toBe('staple');
      expect(role('SHARING PLATES', 'Warm Focaccia & Whipped Smoked Butter')).toBe('staple');
      // Mr Fox, €7. The comma is what saves it — the match cannot cross one.
      expect(role('Starters', '48-hour Sourdough, Parmesan Custard, Cep Butter')).toBe('counted');
    });

    it('leaves a dish that merely ends in a bread', () => {
      expect(role('Starters', 'Shitake Mushroom Parfait, Port Jelly, Focaccia')).toBe('counted');
      expect(role('Rice Bowls', 'Tomato & Egg Rice')).toBe('counted');
    });
  });

  // Founder's rule (2026-08-05): "any side of potatoes if potatoes is the only
  // main ingredient — roast potatoes, fries, mashed potatoes". Measured as the
  // single biggest gap in the head-only rules: 20 dish rows at 13 restaurants.
  describe('potatoes on their own', () => {
    it('drops the potato side however it is described', () => {
      expect(role('Side Dishes', 'Creamed potatoes')).toBe('staple');
      expect(role('Sides', 'Mashed Potatoes')).toBe('staple');
      expect(role('VEGETABLES, SALADS & SIDES', 'Glazed New Potatoes')).toBe('staple');
      expect(role('Accompaniments', 'Urlai Roast Potatoes')).toBe('staple');
      expect(role('A La Carte - Sides', 'Golden Wonder Ballymakenny potatoes')).toBe('staple');
      expect(role('Sides', 'Truffle & parmesan fries')).toBe('staple');
    });

    it('sees through a seasoning, wherever the potato sits in the name', () => {
      // Six words — too long for the simple-name guard, which is exactly why
      // these rules run before it.
      expect(role('Side Dishes', 'Chive & Butter Sautéed Baby Potatoes')).toBe('staple');
      expect(role('Side Dishes', 'Irish baby potatoes in herb butter')).toBe('staple');
      expect(role('Sides', 'Fried maris piper potatoes, rosemary and garlic butter')).toBe('staple');
      expect(role('Sides', 'Salt & Vinegar Potatoes')).toBe('staple');
      expect(role('Sides', 'Roast potatoes with garlic mayo')).toBe('staple');
    });

    it('keeps potatoes that share the plate with real food', () => {
      // What follows "with" decides: a sauce means a side, an ingredient means
      // a meal.
      expect(role('Mains', 'Baked potato with beans and cheese')).toBe('counted');
      expect(role('Sides', 'Roast potatoes, chard & romesco')).toBe('counted');
    });

    it('keeps dishes where potato is an ingredient, not the dish', () => {
      expect(role('Soups', 'Potato & leek soup')).toBe('counted');
      expect(role('Mains', 'Potato Gnocchi')).toBe('counted');
      expect(role('Tapas', 'Patatas Bravas')).toBe('counted');
    });
  });

  describe('pita is a meal at a Middle Eastern restaurant', () => {
    it('counts dips and sandwiches served with pita', () => {
      expect(role('Dips & Pita', 'Hummus & Pita')).toBe('counted');
      expect(role('Dips & Pita', 'Babaganush & Pita')).toBe('counted');
      expect(role('In a Pita', 'Cauliflower Pita')).toBe('counted');
    });

    it('drops the pita you order on the side', () => {
      expect(role('Pita', 'Extra Pita')).toBe('condiment'); // "extra …" add-on
      expect(role('Pita', 'Fried Pita Bites')).toBe('staple');
    });
  });

  describe('sauces and condiments', () => {
    it('drops a dedicated sauce or dip section wholesale', () => {
      // "Brandy Peppercorn" and "Roast Garlic & Herb" contain no keyword at all.
      expect(role('SAUCES', 'Brandy Peppercorn')).toBe('condiment');
      expect(role('House Sauces', 'Jade Sauce')).toBe('condiment');
      expect(role('Dips', 'Roast Garlic & Herb')).toBe('condiment');
      expect(role('Extra Dips', 'Grilled Green Chilli')).toBe('condiment');
    });

    it('drops named condiments anywhere', () => {
      expect(role('Starters', 'Egg Mayonnaise')).toBe('condiment');
      expect(role('House Sauces', 'Hot Sichuan Mayo')).toBe('condiment');
      expect(role('Sahayak Parikar', 'Sesame sauce (Jhol achar)')).toBe('condiment');
      expect(role('Sahayak Parikar', 'Tomato & coriander sauce')).toBe('condiment');
    });

    it('keeps a real dish whose name happens to end in "sauce"', () => {
      // €12 padrón peppers at Etto — five words, so the sauce rule stands down.
      expect(role('Nibbles', 'Padron pepper and romesco sauce')).toBe('counted');
    });

    it('judges the head of the name, not the accompaniment', () => {
      // Fabel Friet is a chip shop; these are its actual products. Matching
      // "mayo" anywhere in the string excluded most of its menu.
      expect(role('Chips', 'Chips with mayo')).toBe('staple'); // chips, not mayo
      expect(role('Chips', 'Chips, Parmesan & truffle mayo')).toBe('staple');
      // The condiment sold on its own is still a condiment.
      expect(role('Create Your Own', 'Truffle mayo')).toBe('condiment');
      expect(role('Create Your Own', 'Vegan mayo')).toBe('condiment');
    });

    it('folds accents so the lists need only one spelling', () => {
      expect(role('SAUCES', 'Béarnaise')).toBe('condiment');
    });
  });

  describe('desserts', () => {
    it('drops everything in a dessert section, however elaborate the name', () => {
      expect(role('Desserts', "SOLE's Sharing Dessert - Alaskan Bomb")).toBe('dessert');
      expect(role('Sweets', 'Burnt Basque Cheesecake, Caramelised Banana')).toBe('dessert');
      expect(role('Cheese & Desserts', 'Old Fashioned Rice Pudding, Plums & Custard')).toBe('dessert');
      expect(role('Early Bird Menu - Desserts', 'Selection of Ice Creams')).toBe('dessert');
    });

    it('drops obvious desserts outside a dessert section', () => {
      expect(role('Tasting Menu', 'Tulsi Sorbet')).toBe('dessert');
      expect(role('Sweets', 'Baklawa 4 Pieces')).toBe('dessert');
    });

    it('does not mistake a savoury "sweet & sour" section for pudding', () => {
      expect(role('Sweet & Sour', 'Crispy Tofu')).toBe('counted');
    });

    it('recognises a pudding section that avoids the word "dessert"', () => {
      // Drury Buildings files its puddings under "Something Sweet"; two
      // ice-cream tarts were counted as veggie options on the spelling alone.
      expect(role('Something Sweet', 'Pistachio & Ricotta Tart, Pistachio Ice Cream')).toBe('dessert');
      expect(role('To Finish', 'Affogato')).toBe('dessert');
    });

    it('leaves savoury dishes that borrow a dessert word', () => {
      // Glas serves this as a starter. "mousse", "cake" and "tart" are savoury
      // often enough that the when-in-doubt-count rule wins.
      expect(role('Starters', 'Artichoke Mousse')).toBe('counted');
      expect(role('Starters', 'Tomato Tart')).toBe('counted');
      // …but the same word inside an actual dessert section is still pudding.
      expect(role('Desserts', 'Mango Mousse')).toBe('dessert');
    });
  });

  describe('staples', () => {
    it('drops plain rice, breads and bar snacks', () => {
      expect(role('Sahayak Parikar', 'White rice')).toBe('staple');
      expect(role('Sides', 'House Rice')).toBe('staple');
      expect(role('Sides', 'Skinny Rosemary Fries')).toBe('staple');
      expect(role('Rice & Breads', 'Breadbasket')).toBe('staple');
    });

    it('matches the noun, not one menu’s particular adjective', () => {
      // The list used to say "smoked almonds" — the wording Dublin menus use —
      // so Uno Mas's "Salted almonds" was counted as a veggie option.
      expect(role('Bites', 'Smoked Almonds')).toBe('staple');
      expect(role('Para picar', 'Salted almonds')).toBe('staple');
      expect(role('Snacks', 'Marcona almonds')).toBe('staple');
      // …but the noun inside a composed dish is still a dish.
      expect(role('Sides', 'Roast Carrots, Pesto, Almond & Cumin')).toBe('counted');
    });

    it('drops a build-your-own component list', () => {
      // Fabel Friet is a chip shop; "Create Your Own" is toppings priced at
      // €0.10–€1.95, not a menu of twelve vegetarian dishes.
      expect(role('Create Your Own', 'Chopped onions')).toBe('condiment');
      expect(role('Create Your Own', 'Cheddar')).toBe('condiment');
      expect(role('Create Your Own', 'Curry')).toBe('condiment');
      expect(role('Toppings', 'Parmesan')).toBe('condiment');
      // A bare "Extras" is NOT a component list — Fade Street Social files a
      // €21.50 Truffle Cheese Flatbread there.
      expect(role('Extras', 'Truffle Cheese Flatbread')).toBe('counted');
    });

    it('keeps substantial vegetable sides', () => {
      // A vegetarian at a steakhouse genuinely orders these.
      expect(role('SIDES', 'Truffle Mac & Cheese')).toBe('counted');
      expect(role('SIDES', 'Creamed Spinach')).toBe('counted');
      expect(role('Sides', 'Salt & Vinegar Potatoes')).toBe('counted');
      expect(role('Sides', 'Corn Ribs')).toBe('counted');
      expect(role('Sides', 'Wok Fried Pak Choi')).toBe('counted');
    });
  });

  it('counts anything it has no opinion about', () => {
    expect(isCountedDish('Mains', { name: 'Roasted Gnocchi, Courgette & Basil' })).toBe(true);
    expect(isCountedDish(null, { name: 'Margherita' })).toBe(true);
    expect(isCountedDish('Sahayak Parikar', { name: 'Fried egg' })).toBe(true);
  });

  it('is safe on empty and missing names', () => {
    expect(role('Desserts', '')).toBe('counted');
    expect(isCountedDish(undefined, { name: 'Burrata' })).toBe(true);
  });
});
