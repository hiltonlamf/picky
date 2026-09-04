/**
 * Site-wide strings that appear in more than one place (metadata, share cards,
 * the footer). Homepage prose lives in `lib/home-copy.ts` instead.
 */

/** The standard one-line description of Platefully. Founder-approved wording — use
 *  it verbatim for meta descriptions, OG/Twitter cards and share text. */
export const SITE_TAGLINE =
  'Platefully — find veggie dishes in any restaurant, instantly. AI-assisted. Human-verified.';

/** The tagline without the "Platefully — " prefix, for places that already show the
 *  site name (e.g. an OG card whose title is "Platefully"). */
export const SITE_DESCRIPTION =
  'Find veggie dishes in any restaurant, instantly. AI-assisted. Human-verified.';

/** Title used for the browser tab and as the OG/Twitter card title. */
export const SITE_TITLE = 'Platefully — find veggie dishes in any restaurant';

// ---------------------------------------------------------------- city guides

/** Guide headline. The subject is the *menus* of popular restaurants — the
 *  product finds the veg options in places everyone already wants to book. */
export function guideHeadline(city: string): string {
  return `${city}'s most popular restaurant menus, analysed for vegetarians`;
}

export function guideIntro(city: string): string {
  return (
    `The places everyone in ${city} is trying to book, read menu by menu. ` +
    "See what's vegetarian and vegan before you go."
  );
}

/** The honest version of who does what. Sampling, not per-item verification. */
export const GUIDE_HUMAN_LINE =
  'AI reads the menus. We sample and review the results by hand, and keep fixing what the error log shows us.';

// ------------------------------------------------------------- the dead ends

/* The four ways a search ends with nothing to show. Kept here rather than
 * inline in RestaurantPage so /admin/dead-ends can label a wall with the exact
 * words the visitor saw — an admin investigating "why did this fail" should not
 * have to translate `unavailable` back into "This website looks down". */

/** Short label for a `no_menu_reason`, for admin tables and pills. */
export const NO_MENU_REASON_LABEL: Record<string, string> = {
  not_listed: 'No menu on the site',
  unavailable: 'Site unreachable',
  closed: 'Restaurant closed',
  blocked: 'Menu found, access refused',
};

/** The heading + body a visitor sees on a `no_menu` restaurant page. */
export function noMenuCopy(
  reason: string | null | undefined,
  name: string
): { heading: string; body: string } {
  switch (reason) {
    case 'unavailable':
      return {
        heading: 'This website looks down',
        body: `We couldn't reach ${name}'s website — it may be down or not live yet.`,
      };
    case 'closed':
      return {
        heading: 'This restaurant looks closed',
        body: `${name} appears to be permanently closed, so there's no menu to show.`,
      };
    // 'blocked' means we FOUND the menu and were refused it — a fact about the
    // host, not about the restaurant. Saying "no menu listed" here would be
    // simply untrue, and it hides the one thing that fixes it.
    case 'blocked':
      return {
        heading: "We found the menu — but we can't open it",
        body:
          'Some things on the web are off-limits to AI agents: either we cannot read them, or ' +
          'we are not permitted to. Can you give us a hand by uploading the menu, or pasting a ' +
          "direct link? We'll read it right away.",
      };
    default:
      return {
        heading: 'No menu listed on this site',
        body: `We looked, but ${name}'s website doesn't seem to publish a menu online.`,
      };
  }
}

/* The open-ended ask on a dead end. Deliberately NOT another "where is the
 * menu?" — the form directly above already asks that, and repeating it wastes
 * the one moment a disappointed visitor is willing to talk to us. This asks for
 * anything at all, and says a person will read it. */
export const DEAD_END_FEEDBACK = {
  heading: 'Not what you were hoping for?',
  body: 'Tell us anything — what you expected, what went wrong, what would make this useful. A real person reads every message, and this is exactly how we decide what to fix next.',
  placeholder: 'Type anything at all…',
  cta: 'Send',
  /** Shown in place of the form once sent. Names the human, on purpose. */
  thanks: "Thank you — that's landed with us. We read every one of these, and it's what we work from next.",
} as const;

// ------------------------------------------------------- counting methodology

/* Shown collapsed on both the city guide and the restaurant page, so the number
 * can explain itself. Edit freely — but keep any line containing an apostrophe
 * in "double quotes", or the build breaks. */

/** The always-visible label on the collapsed disclosure. */
export const COUNTING_METHOD_SUMMARY = 'How we count veggie dishes';

/** The expanded explanation. One string per paragraph. */
export const COUNTING_METHOD_BODY: string[] = [
  "We count the dishes that vegetarians and vegans actually care about when looking at the menu. Desserts, sauces and dips, plain breads and plain rice are still listed — you just won't find them in the number, because four kinds of naan and a pot of mayo don't make a restaurant good for vegetarians.",
  "Nothing is hidden. Every dish the AI found is on the menu below, with its own label, whether we count it or not.",
  "When we can't tell, we count it. We would rather show you a maybe than quietly drop something you might have wanted.",
  'Sharing plates are still dishes. At a tapas, mezze or dim sum place, small plates are the meal — so they count.',
];

/* Flag emoji beside a guide headline. Dublin used to hardcode 🇮🇪 in its own
 * route; now that every city shares one page, it comes from the guide's
 * `country`. An unknown country simply renders no flag — the headline reads
 * fine without one, which is better than shipping a wrong flag. */
const COUNTRY_FLAGS: Record<string, string> = {
  Ireland: '🇮🇪',
  Netherlands: '🇳🇱',
  'United Kingdom': '🇬🇧',
  England: '🇬🇧',
  Scotland: '🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  France: '🇫🇷',
  Spain: '🇪🇸',
  Portugal: '🇵🇹',
  Italy: '🇮🇹',
  Germany: '🇩🇪',
  Belgium: '🇧🇪',
  Denmark: '🇩🇰',
  Sweden: '🇸🇪',
  Norway: '🇳🇴',
  Finland: '🇫🇮',
  Poland: '🇵🇱',
  Austria: '🇦🇹',
  Switzerland: '🇨🇭',
  Greece: '🇬🇷',
  'Czech Republic': '🇨🇿',
  Czechia: '🇨🇿',
  Hungary: '🇭🇺',
  'United States': '🇺🇸',
  Canada: '🇨🇦',
  Australia: '🇦🇺',
  'New Zealand': '🇳🇿',
};

export function countryFlag(country: string | null | undefined): string | null {
  if (!country) return null;
  return COUNTRY_FLAGS[country.trim()] ?? null;
}

export function guideMetaDescription(city: string, where: string): string {
  return (
    `Which of ${where}'s most popular restaurants are actually good for vegetarians. ` +
    `Dish-by-dish vegetarian and vegan options for ${city}, read by AI and reviewed by a human.`
  );
}
