import type { DietaryFilterConfig } from '@/types';

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

export const REPORT_ISSUE_TYPES = [
  { value: 'wrong_classification', label: 'Wrong dietary label (e.g. marked vegan but contains dairy)' },
  { value: 'hidden_ingredient', label: 'Hidden non-vegetarian ingredient not mentioned' },
  { value: 'dish_removed', label: 'This dish is no longer on the menu' },
  { value: 'incorrect_info', label: 'Name or description is wrong' },
  { value: 'other', label: 'Something else' },
];

// General, page-level feedback — distinct from REPORT_ISSUE_TYPES, which is
// always about one specific dish's label.
export const GENERAL_FEEDBACK_TYPES = [
  { value: 'missing_dish', label: "A dish is missing — it's on the menu but not in our results" },
  { value: 'wrong_menu', label: 'This looks like the wrong menu, or the wrong restaurant entirely' },
  { value: 'menu_outdated', label: 'This menu looks out of date — the restaurant has changed it' },
  { value: 'feature_request', label: 'I have an idea for a feature' },
  { value: 'other', label: 'Something else' },
];

export const CONFIDENCE_THRESHOLD_WARNING = 0.6;
export const STALENESS_DAYS = 30;
export const REPORT_COUNT_WARNING_THRESHOLD = 3;
