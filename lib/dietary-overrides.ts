import type { DietaryClassification } from '@/types';

interface DishLike {
  name: string;
  description?: string | null;
  classification: DietaryClassification;
}

// Caviar and roe are fish eggs, but short luxury-product names such as
// "Sevruga Royal" do not contain an ingredient the classifier recognises. The
// section heading supplies the missing context. Keep explicit plant-based
// imitations valid: aubergine/seaweed "caviar" is a different food entirely.
const CAVIAR_SECTION_RE = /\bcaviar\b/i;
const ANIMAL_ROE_RE = /\b(?:caviar|(?:fish|salmon|trout|lumpfish) roe|ikura|tobiko|masago)\b/i;
const PLANT_CAVIAR_RE = /\b(?:vegan|plant[\s-]?based|seaweed|aubergine|eggplant) caviar\b/i;
const SEAFOOD_RE =
  /\b(?:mussels?|oysters?|prawns?|shrimps?|crab|lobster|scallops?|squid|octopus|salmon|tuna|monkfish|sea\s?bass|fish|seafood|shellfish)\b/i;
const PLANT_SEAFOOD_RE =
  /\boyster (?:mushrooms?|leaf)\b|\blobster mushrooms?\b|\bcrab apples?\b|\b(?:vegan|vegetarian|plant[\s-]?based|mock)\s+(?:fish|seafood|prawns?|shrimps?|crab|lobster|scallops?|tuna|salmon)\b/i;

export function hasExplicitAnimalRoe(
  sectionName: string | null | undefined,
  dish: Pick<DishLike, 'name' | 'description'>
): boolean {
  const dishText = dish.name;
  if (PLANT_CAVIAR_RE.test(dishText)) return false;
  return CAVIAR_SECTION_RE.test(sectionName ?? '') || ANIMAL_ROE_RE.test(dishText);
}

export function hasExplicitAnimalProduct(
  sectionName: string | null | undefined,
  dish: Pick<DishLike, 'name' | 'description'>
): boolean {
  if (hasExplicitAnimalRoe(sectionName, dish)) return true;
  // Use the sold name, not the description: descriptions often advertise
  // optional meat/seafood add-ons to an otherwise vegetarian dish.
  const dishText = dish.name;
  if (PLANT_SEAFOOD_RE.test(dishText)) return false;
  return SEAFOOD_RE.test(dishText);
}

/** Public-facing classification with deterministic corrections for explicit
 * animal products. The stored AI answer remains available to admins/audits. */
export function effectiveDietaryClassification(
  sectionName: string | null | undefined,
  dish: DishLike
): DietaryClassification {
  return hasExplicitAnimalProduct(sectionName, dish) ? 'neither' : dish.classification;
}
