/**
 * Site-wide strings that appear in more than one place (metadata, share cards,
 * the footer). Homepage prose lives in `lib/home-copy.ts` instead.
 */

/** The standard one-line description of Picky. Founder-approved wording — use
 *  it verbatim for meta descriptions, OG/Twitter cards and share text. */
export const SITE_TAGLINE =
  'Picky — find veggie dishes in any restaurant, instantly. AI-assisted. Human-verified.';

/** The tagline without the "Picky — " prefix, for places that already show the
 *  site name (e.g. an OG card whose title is "Picky"). */
export const SITE_DESCRIPTION =
  'Find veggie dishes in any restaurant, instantly. AI-assisted. Human-verified.';

/** Title used for the browser tab and as the OG/Twitter card title. */
export const SITE_TITLE = 'Picky — find veggie dishes in any restaurant';

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

export function guideMetaDescription(city: string, where: string): string {
  return (
    `Which of ${where}'s most popular restaurants are actually good for vegetarians. ` +
    `Dish-by-dish vegetarian and vegan options for ${city}, read by AI and reviewed by a human.`
  );
}
