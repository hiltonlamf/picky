import type { DietaryFilterConfig, DietaryClassification } from '@/types';

export const DIETARY_FILTERS: Record<string, DietaryFilterConfig> = {
  vegan: {
    label: 'Vegan',
    emoji: '🥦',
    color: 'green',
    badgeClass: 'bg-picky-600 text-white',
    markers: [
      '(ve)', '[ve]', '(vg)', '[vg]', '(v*)', '(pb)',
      'vegan', 'plant-based', 'plant based', '100% plant',
    ],
    excludedIngredients: [
      'meat', 'beef', 'chicken', 'pork', 'lamb', 'veal', 'venison', 'duck',
      'turkey', 'goat', 'rabbit', 'fish', 'salmon', 'tuna', 'cod', 'haddock',
      'plaice', 'sole', 'trout', 'mackerel', 'sardine', 'prawn', 'shrimp',
      'lobster', 'crab', 'mussel', 'oyster', 'scallop', 'squid', 'octopus',
      'seafood', 'anchovy', 'anchovies', 'egg', 'eggs', 'milk', 'cream',
      'butter', 'cheese', 'yogurt', 'yoghurt', 'honey', 'gelatin', 'gelatine',
      'lard', 'suet', 'whey', 'casein', 'lactose', 'beeswax',
      'fish sauce', 'oyster sauce', 'worcestershire', 'beef stock',
      'chicken stock', 'fish stock', 'bone broth', 'bacon', 'ham',
      'sausage', 'salami', 'pepperoni', 'prosciutto', 'chorizo', 'pancetta',
    ],
  },
  vegetarian: {
    label: 'Vegetarian',
    emoji: '🍳',
    color: 'emerald',
    badgeClass: 'bg-picky-500 text-white',
    markers: [
      '(v)', '[v]', '(veg)', 'vegetarian', 'veggie', '(v)',
    ],
    excludedIngredients: [
      'meat', 'beef', 'chicken', 'pork', 'lamb', 'veal', 'venison', 'duck',
      'turkey', 'goat', 'rabbit', 'fish', 'salmon', 'tuna', 'cod', 'haddock',
      'plaice', 'sole', 'trout', 'mackerel', 'sardine', 'prawn', 'shrimp',
      'lobster', 'crab', 'mussel', 'oyster', 'scallop', 'squid', 'octopus',
      'seafood', 'anchovy', 'anchovies', 'bacon', 'ham', 'sausage', 'salami',
      'pepperoni', 'prosciutto', 'chorizo', 'pancetta', 'lard', 'suet',
      'gelatin', 'gelatine', 'fish sauce', 'oyster sauce',
      'worcestershire sauce', 'beef stock', 'chicken stock', 'fish stock',
      'bone broth',
    ],
  },
  // Future additions — adding a new filter is just a new entry here:
  // pescatarian: { ... },
  // halal: { ... },
  // kosher: { ... },
  // gluten_free: { ... },
};

// Per-dish reports (the flag on each dish). Deterministic options first — the
// ones an admin can accept in one click — with open-ended "something else" last.
export const REPORT_ISSUE_TYPES = [
  { value: 'wrong_classification', label: 'Wrong dietary label — it should be something else' },
  { value: 'not_a_dish', label: "This isn't a dish (it's a sauce, add-on, or a heading)" },
  { value: 'dish_removed', label: 'This dish is no longer on the menu' },
  { value: 'duplicate_dish', label: 'This is a duplicate — the same dish appears twice' },
  { value: 'hidden_ingredient', label: 'Hidden non-vegetarian ingredient not mentioned' },
  { value: 'incorrect_info', label: 'Name, description or price is wrong' },
  { value: 'other', label: 'Something else' },
];

// General, page-level feedback — distinct from REPORT_ISSUE_TYPES, which is
// always about one specific dish's label. Deterministic options first.
export const GENERAL_FEEDBACK_TYPES = [
  { value: 'not_a_menu', label: "This isn't a real menu — it shouldn't be listed here" },
  { value: 'missing_menu', label: 'A whole menu is missing (e.g. no dinner menu)' },
  { value: 'menu_no_dishes', label: 'A menu is shown but its dishes are missing or too few' },
  { value: 'menu_outdated', label: 'This menu looks out of date — the restaurant has changed it' },
  { value: 'missing_dish', label: "A dish is missing — it's on the menu but not in our results" },
  { value: 'wrong_name', label: 'The restaurant name is wrong' },
  { value: 'wrong_menu', label: 'This looks like the wrong menu, or the wrong restaurant entirely' },
  { value: 'feature_request', label: 'I have an idea for a feature' },
  { value: 'other', label: 'Something else' },
];

// The three labels a user can propose for a misclassified dish. "Non-vegetarian"
// maps to the internal `neither`. Emoji mirror DietaryBadge for consistency.
export const PROPOSED_CLASSIFICATION_OPTIONS: { value: DietaryClassification; label: string; emoji: string }[] = [
  { value: 'vegan', label: 'Vegan', emoji: '🌱' },
  { value: 'vegetarian', label: 'Vegetarian', emoji: '🍳' },
  { value: 'neither', label: 'Non-vegetarian', emoji: '🥩' },
];

// How an admin's "Accept" resolves each feedback/issue type. Shared by the
// accept engine (app/api/admin/feedback-resolve) and the inbox UI so the two
// never drift. `route` = no auto-apply; open the review screen and fix by hand.
export type FeedbackResolveAction =
  | 'reclassify'  // dish → applyDishVerdict upsert with the proposed label
  | 'remove_dish' // dish → applyDishVerdict delete (not-a-dish, duplicate, off-menu)
  | 'remove_menu' // menu → removeMenu keyed on menu_label (not-a-menu, duplicate menu)
  | 'rename'      // restaurant → update restaurants.name to the proposed name
  | 'reparse'     // restaurant → re-run analysis (the one AI-spend path)
  | 'route';      // manual: open review (missing dish/menu, wrong info, open-ended)

export const FEEDBACK_RESOLUTION: Record<string, FeedbackResolveAction> = {
  // dish reports
  wrong_classification: 'reclassify',
  not_a_dish: 'remove_dish',
  dish_removed: 'remove_dish',
  duplicate_dish: 'remove_dish',
  hidden_ingredient: 'route',
  incorrect_info: 'route',
  // page feedback
  not_a_menu: 'remove_menu',
  missing_menu: 'route',
  menu_no_dishes: 'reparse',
  menu_outdated: 'reparse',
  missing_dish: 'route',
  wrong_name: 'rename',
  wrong_menu: 'route',
  feature_request: 'route',
  other: 'route',
};

// Site-level feedback — the footer / homepage button, not tied to any
// restaurant or city. Shares the /api/feedback route (restaurantId is null).
export const SITE_FEEDBACK_TYPES = [
  { value: 'idea', label: 'I have an idea for Platefully' },
  { value: 'restaurant_request', label: 'Add a restaurant or a city' },
  { value: 'something_wrong', label: 'Something looks wrong' },
  { value: 'other', label: 'Something else' },
];

// Free-text notes captured inline at the moments the pipeline breaks: the
// menu picker, the no-menu screen and the parse-error screen. Not a chooser —
// these have no options, so the value is set by the surface. Listed here so
// the admin inbox labels them instead of showing a raw slug.
export const INLINE_FEEDBACK_TYPES = [
  { value: 'menu_choice_note', label: 'Menu picker — wrong or missing menus' },
  { value: 'no_menu_note', label: 'No menu found — reader knows where it is' },
  { value: 'parse_error_note', label: 'Analysis failed — reader knows where it is' },
];

// Guide-level feedback (not tied to one restaurant) — shown on the city guide.
export const GUIDE_FEEDBACK_TYPES = [
  { value: 'suggest_restaurant', label: 'Suggest a restaurant to add to this guide' },
  { value: 'guide_issue', label: 'Flag an issue with a restaurant in this guide' },
  { value: 'other', label: 'Something else' },
];

export const CONFIDENCE_THRESHOLD_WARNING = 0.6;
export const STALENESS_DAYS = 30;
export const REPORT_COUNT_WARNING_THRESHOLD = 3;
