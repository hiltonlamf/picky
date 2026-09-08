import type { DietaryClassification } from '@/types';

interface DishLike {
  name: string;
  description?: string | null;
  classification: DietaryClassification;
}

/**
 * Strip accents before matching.
 *
 * Not cosmetic — it is load-bearing. JavaScript's `\b` is ASCII-only, so in
 * "Baccalà Mantecato" there is NO word boundary after the à (an accented letter
 * and a space are both non-word characters to `\b`), and a `/baccalà\b/` never
 * fires. Folding to "baccala" first lets every pattern below stay plain ASCII
 * with ordinary boundaries, and it matches the unaccented spellings menus use
 * just as often ("Baccala", "atun", "salmon", "jamon").
 */
function fold(text: string): string {
  return (
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      // "Crab Meat Spring Roll" is seafood, but the meat guard saw a bare
      // "meat" in it and threw the dish out. Closing the compound up front
      // keeps `\bmeat\b` honest \u2014 "crabmeat" is already in the seafood list,
      // and a genuine "Meat, Fish, Vega" platter still matches. Found in the
      // live audit's sushi rows.
      .replace(/\b(crab|lobster|fish|white\s+crab)\s+meat\b/gi, '$1meat')
  );
}

// Caviar and roe are fish eggs, but short luxury-product names such as
// "Sevruga Royal" do not contain an ingredient the classifier recognises. The
// section heading supplies the missing context. Keep explicit plant-based
// imitations valid: aubergine/seaweed "caviar" is a different food entirely.
const CAVIAR_SECTION_RE = /\bcaviar\b/i;
const ANIMAL_ROE_RE = /\b(?:caviar|(?:fish|salmon|trout|lumpfish) roe|ikura|tobiko|masago)\b/i;
const PLANT_CAVIAR_RE = /\b(?:vegan|plant[\s-]?based|seaweed|aubergine|eggplant) caviar\b/i;

// ---------------------------------------------------------------------------
// Seafood
// ---------------------------------------------------------------------------
// This list does two jobs, and it is deliberately one list so they can never
// disagree:
//   1. Safety — a dish naming an explicit fish/shellfish is forced to 'neither'
//      so a vegetarian is never shown a "Vongole" as veggie.
//   2. The pescatarian filter — the same match is what puts a dish INTO the
//      pescatarian tab (see isPescatarianDish below).
//
// Four languages, because our menus are not English-only: Dublin lists plenty
// of Italian and Spanish dish names untranslated, and the Amsterdam guide is
// full of Dutch ones. An English-only list silently fails on all of them.
//
// Ambiguous words are handled separately in SEAFOOD_CONTEXT_RE below — they are
// real words in ordinary English/Spanish too, so a bare match would be wrong.
const SEAFOOD_RE = new RegExp(
  '\\b(?:' +
    [
      // --- English: fish
      'fish', 'seafood', 'shellfish', 'salmon', 'tuna', 'cod', 'codfish',
      'haddock', 'hake', 'plaice', 'halibut', 'turbot', 'brill', 'bream',
      'snapper', 'pollock', 'pollack', 'herring', 'kipper', 'mackerel',
      'sardines?', 'anchovy', 'anchovies', 'trout', 'eel', 'monkfish',
      'swordfish', 'whitebait', 'skate', 'sea\\s?bass', 'sea\\s?bream',
      'red\\s?mullet', 'john\\s?dory', 'smoked\\s?salmon', 'gravlax',
      // Closed compounds. `\bfish\b` does not fire inside "Fishcakes" or
      // "Kingfish", and all three of these were missed on live menus.
      'fish\\s?cakes?', 'fish\\s?fingers?', 'kingfish', 'sea\\s?trout',
      'catfish', 'whitefish', 'rockfish', 'yellowtail', 'butterfish',
      'hamachi', 'unagi', 'toro', 'kanpachi', 'lumpfish', 'crabmeat',
      'lobstermeat', 'fishmeat',
      // --- English: shellfish, molluscs, crustaceans
      'prawns?', 'shrimps?', 'crab', 'crabmeat', 'lobster', 'langoustines?',
      'crayfish', 'scampi', 'mussels?', 'clams?', 'cockles?', 'oysters?',
      'scallops?', 'squid', 'calamari', 'octopus', 'cuttlefish', 'whelks?',
      'winkles?', 'razor\\s?clams?', 'sea\\s?urchin', 'abalone', 'krill',
      // --- English: preparations that are inherently seafood.
      // NOT 'sushi'/'maki'/'nigiri' (cucumber and avocado maki are vegan — this
      // list forces 'neither', so a match here would HIDE a vegan dish from a
      // vegan) and NOT 'chowder' (corn chowder). Their fish versions name the
      // fish anyway: "Salmon Nigiri" matches on 'salmon'.
      'ceviche', 'sashimi', 'bouillabaisse', 'taramasalata', 'kedgeree',
      'surimi', 'roe', 'caviar',
      // --- Italian
      'pesce', 'pesci', 'frutti\\s+di\\s+mare', 'vongole', 'cozze',
      'gamber(?:i|etti|o)', 'scampi', 'aragosta', 'astice', 'granchio',
      'capesante', 'ostriche', 'seppia', 'seppie', 'calamar(?:i|o)', 'polpo',
      'moscardini', 'acciughe', 'alici', 'sarde', 'sgombro', 'baccal[àa]',
      'merluzzo', 'stoccafisso', 'tonno', 'salmone', 'branzino', 'spigola',
      'orata', 'sogliola', 'anguilla', 'pesce\\s?spada', 'bottarga',
      'fritto\\s+misto',
      // 'rombo' (turbot) is also "rhombus" — see SEAFOOD_CONTEXT_RE.
      // --- Spanish
      'pescado', 'pescados', 'marisco', 'mariscos', 'gambas?', 'langostinos?',
      'cigalas?', 'langosta', 'bogavante', 'cangrejo', 'almejas?',
      'mejillones', 'berberechos', 'navajas', 'percebes', 'vieiras?',
      'zamburi[ñn]as', 'ostras?', 'chipirones', 'calamares', 'pulpo',
      'boquerones', 'anchoas', 'sardinas', 'bacalao', 'merluza', 'at[úu]n',
      'salm[óo]n', 'lubina', 'dorada', 'rodaballo', 'lenguado', 'trucha',
      'pez\\s?espada', 'anguila', 'salpic[óo]n\\s+de\\s+marisco',
      // --- Dutch (the Amsterdam guide)
      'vis', 'visje', 'zeevruchten', 'garnalen', 'garnaal', 'gamba[\'s]*',
      'mosselen', 'kokkels', 'oesters', 'kreeft', 'krab', 'sint[\\s-]?jakobs',
      'coquilles', 'inktvis', 'kabeljauw', 'schol', 'tongschar',
      // bare 'tong' (sole) is also Dutch for tongue — see SEAFOOD_CONTEXT_RE.
      'zalm', 'tonijn', 'haring', 'maatjes', 'makreel', 'forel', 'paling',
      'ansjovis', 'sardines', 'zeebaars', 'heilbot', 'rog',
    ].join('|') +
    ')\\b',
  'i'
);

// Words that mean seafood but are also ordinary words, so they need a food
// context before we believe them:
//   sole   — "the sole reason"; but "Dover sole", "grilled sole" is a fish
//   bass   — an instrument and a voice; "sea bass" is already covered above
//   rape   — Spanish for monkfish; also an English word and "rapeseed oil"
//   sepia  — Spanish/Italian cuttlefish; also a colour
//   rombo  — Italian turbot; also "rhombus"
//   tong   — Dutch sole; also "tongs" and (Dutch) "tongue"
// The context words are the ones that actually appear next to them on menus.
const SEAFOOD_CONTEXT_RE =
  /\b(?:dover|lemon|grilled|pan[\s-]?fried|fried|whole|fillet\s+of|black)\s+sole\b|\bsole\s+(?:meuni[èe]re|fillet|goujons)\b|\b(?:sea|striped|black|chilean)\s+bass\b|\brape\s+(?:a\s+la|al|con|en)\b|\b(?:al|a\s+la)\s+rape\b|\bsepia\s+(?:a\s+la|con|plancha|encebollada)\b|\bchocos?\b|\brombo\s+(?:al|con|alla)\b|\bgeb(?:akken|raden)\s+tong\b|\btong\s+meuni[èe]re\b/i;

// Plant-based decoys: phrases that contain a seafood word but are not seafood.
// Getting one wrong is the worst error here — it would hide a vegan dish from a
// vegan.
//
// These are STRIPPED from the text rather than used to veto the whole dish. A
// veto is too blunt: Liath sells "Cromane oyster, seaweed hot sauce, fermented
// gooseberry", where the seaweed cancelled a real oyster and the dish fell out
// of the pescatarian tab. Removing just the decoy phrase leaves the rest of the
// name to speak for itself. Found by the live audit.
const PLANT_SEAFOOD_RE =
  /\boyster (?:mushrooms?|leaf|sauce)\b|\blobster mushrooms?\b|\bcrab apples?\b|\bfish[\s-]?free\b|\bsea(?:weed|\s?salt)\b|\bvis\s?vrij\b|\b(?:vegan|vegetarian|veggie|plant[\s-]?based|mock|no[\s-]?|not\s+)\s*(?:fish|seafood|prawns?|shrimps?|crab|lobster|scallops?|tuna|salmon|calamari|squid|vis|garnalen)\b/gi;

/** Remove the plant look-alikes so what remains can be matched honestly.
 *
 *  Longest phrase first: "seaweed caviar" has to go as a unit, because
 *  stripping only the "seaweed" would leave a bare "caviar" behind and turn a
 *  vegan dish into fish roe. */
const PLANT_CAVIAR_STRIP_RE = new RegExp(PLANT_CAVIAR_RE.source, 'gi');
function stripPlantDecoys(text: string): string {
  return text.replace(PLANT_CAVIAR_STRIP_RE, ' ').replace(PLANT_SEAFOOD_RE, ' ');
}

// ---------------------------------------------------------------------------
// Meat
// ---------------------------------------------------------------------------
// The guard on the pescatarian filter. "Surf & Turf", "Chicken & Prawn Curry"
// and "Paella con chorizo y gambas" all name seafood but are NOT pescatarian —
// showing one of those in the fish tab is the trust-breaking kind of mistake,
// the same class as calling a steak vegetarian.
//
// This list MUST stay as multilingual as the seafood list above. If it did not,
// widening seafood to Italian and Spanish would actively create unsafe results:
// "Pollo e Gamberi" would match a seafood word, find no English meat word, and
// pass as pescatarian.
const MEAT_RE = new RegExp(
  '\\b(?:' +
    [
      // --- English
      'meat', 'beef', 'steaks?', 'rib\\s?eye', 'ribs?', 'sirloin', 'fillet\\s+steak',
      'chicken', 'poultry', 'pork', 'lamb', 'mutton', 'veal', 'venison',
      'duck', 'turkey', 'goat', 'rabbit', 'goose', 'quail', 'pigeon',
      'oxtail', 'brisket', 'bacon', 'ham', 'sausages?', 'salami',
      'pepperoni', 'prosciutto', 'chorizo', 'pancetta', 'guanciale',
      'bresaola', 'mortadella', "n'?duja", 'pastrami', 'meatballs?',
      // NOT 'burger' — it is a FORMAT, not a protein, and Fish Shop sells a
      // "Fillet O'Fish Shop - Our Fish Burger" that this was excluding. A plain
      // "Burger" names no seafood either way, so dropping it costs nothing:
      // this list only ever decides a dish that already matched the fish list.
      'ribs', 'wings', 'liver', 'p[âa]t[ée]', 'foie\\s?gras',
      'surf\\s*(?:and|&|\'n\'?|n)\\s*turf',
      // --- Italian
      'carne', 'manzo', 'vitello', 'maiale', 'agnello', 'pollo', 'anatra',
      'tacchino', 'coniglio', 'cinghiale', 'salsiccia', 'speck', 'lardo',
      'porchetta', 'ossobuco', 'ragù', 'bolognese', 'amatriciana',
      'carbonara', 'saltimbocca', 'cotoletta',
      // --- Spanish
      'cerdo', 'ternera', 'vaca', 'cordero', 'pollo', 'pato', 'pavo',
      'conejo', 'jam[óo]n', 'lomo', 'solomillo', 'chuleta', 'morcilla',
      'salchich[óo]n', 'longaniza', 'panceta', 'secreto', 'presa',
      'albondigas', 'alb[óo]ndigas', 'rabo\\s+de\\s+toro', 'cochinillo',
      'carrillera', 'chistorra',
      // --- Dutch
      'vlees', 'rundvlees', 'rund', 'kip', 'varken(?:svlees)?', 'lam(?:svlees)?',
      'kalfs(?:vlees)?', 'eend', 'kalkoen', 'spek', 'worst', 'gehakt',
      'ham', 'ossenhaas', 'biefstuk', 'kroket',
    ].join('|') +
    ')\\b',
  'i'
);

// "Choice of chicken or prawn" — a pescatarian can order this, they just pick
// the prawn. Founder's call: show it. Without this, the meat guard above would
// (correctly, for a fixed dish) throw it out.
//
// Dishes that offer a VEGETARIAN option are already stored as 'vegetarian' by
// the extraction prompt, so they reach the pescatarian tab via the veg branch
// and never get here.
// SUBSTITUTION only — the diner picks which protein the dish is made with.
// Deliberately NOT "add", "optional", "extra" or "upgrade": those are add-ons
// bolted onto a dish that already has its own protein. The Church Café Bar
// sells a "16oz Rib Eye on the Bone" whose description ends "Optional add-on:
// pan-fried prawns"; an add-on rule put a steak in the pescatarian tab. Found
// by the live audit, not by a unit test.
const PROTEIN_CHOICE_RE =
  /\b(?:choice|choose|select)\s+(?:of|from|your|between)\b|\byour\s+choice\b|\bwith\s+(?:a\s+)?choice\b|\bkeuze\s+(?:uit|van)\b|\ba\s+(?:elegir|escoger)\b|\ba\s+scelta\b/i;

export function hasExplicitAnimalRoe(
  sectionName: string | null | undefined,
  dish: Pick<DishLike, 'name' | 'description'>
): boolean {
  const dishText = fold(dish.name);
  if (PLANT_CAVIAR_RE.test(dishText)) return false;
  return CAVIAR_SECTION_RE.test(fold(sectionName ?? '')) || ANIMAL_ROE_RE.test(dishText);
}

export function hasExplicitAnimalProduct(
  sectionName: string | null | undefined,
  dish: Pick<DishLike, 'name' | 'description'>
): boolean {
  if (hasExplicitAnimalRoe(sectionName, dish)) return true;
  // Use the sold name, not the description: descriptions often advertise
  // optional meat/seafood add-ons to an otherwise vegetarian dish.
  const dishText = stripPlantDecoys(fold(dish.name));
  return SEAFOOD_RE.test(dishText) || SEAFOOD_CONTEXT_RE.test(dishText);
}

/** Public-facing classification with deterministic corrections for explicit
 * animal products. The stored AI answer remains available to admins/audits. */
export function effectiveDietaryClassification(
  sectionName: string | null | undefined,
  dish: DishLike
): DietaryClassification {
  return hasExplicitAnimalProduct(sectionName, dish) ? 'neither' : dish.classification;
}

/** Does this dish name a fish, shellfish or other seafood — and nothing that
 *  rules it out for a pescatarian?
 *
 *  Only ever asked of dishes that are already NOT vegetarian (see
 *  isPescatarianDish). A veg or vegan dish is pescatarian by definition, so it
 *  never reaches this test and can never be mislabelled as fish by it.
 *
 *  Deliberately conservative. A seafood dish we fail to recognise merely goes
 *  missing from the pescatarian tab — the same "under-promise" the veggie count
 *  already prefers. A MEAT dish we wrongly let through is served to someone who
 *  does not eat meat, so anything ambiguous resolves to false. */
export function isSeafoodDish(
  sectionName: string | null | undefined,
  dish: Pick<DishLike, 'name' | 'description'>
): boolean {
  const name = fold(dish.name);
  const description = fold(dish.description ?? '');

  // Meat in the NAME settles it — the dish is sold as a meat dish, whatever
  // else the description offers. This is what keeps "Surf & Turf", "Pollo e
  // Gamberi" and a rib eye with an optional prawn add-on out of the fish tab.
  //
  // Unless the name ITSELF frames a choice ("Pad Thai — choice of chicken or
  // prawn"), in which case the meat is one option among several rather than
  // what the dish is, and a pescatarian orders the other one.
  if (MEAT_RE.test(name) && !PROTEIN_CHOICE_RE.test(name)) return false;

  // Otherwise the sold NAME is still the only evidence we trust, because
  // descriptions advertise optional add-ons. The exception is again a choice of
  // protein ("Noodles — choice of chicken, beef or prawns"), where the
  // description is the only place the prawn is named.
  const isChoice = PROTEIN_CHOICE_RE.test(name) || PROTEIN_CHOICE_RE.test(description);
  const text = stripPlantDecoys(isChoice ? `${name} ${description}` : name);

  return (
    hasExplicitAnimalRoe(sectionName, dish) || SEAFOOD_RE.test(text) || SEAFOOD_CONTEXT_RE.test(text)
  );
}

/** Can a pescatarian eat this? Seafood, plus everything a vegetarian can eat.
 *
 *  Derived at read time from the four labels we already store — there is no
 *  'pescatarian' value in the database and nothing to backfill, so this works
 *  identically for a restaurant analysed a year ago and one analysed just now. */
export function isPescatarianDish(
  sectionName: string | null | undefined,
  dish: DishLike
): boolean {
  const classification = effectiveDietaryClassification(sectionName, dish);
  // vegan / vegetarian / unknown are all fine for a pescatarian. `unknown` is
  // included for the same reason the veggie count includes it: when in doubt,
  // show it rather than quietly drop something they might have wanted.
  if (classification !== 'neither') return true;
  return isSeafoodDish(sectionName, dish);
}
