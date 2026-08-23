/**
 * Every word on the homepage lives here, so the copy can be edited without
 * touching layout code. `app/page.tsx` renders straight from these constants.
 */

export const HERO = {
  badge: 'AI-assisted · Human-verified · Made in Dublin',
  /** The headline is split so the middle part can be set in pink. */
  headline: {
    before: 'See all ',
    accent: 'veggie dishes',
    after: " in Dublin's best restaurants, instantly.",
  },
  sub: 'No more showing up in places that only offer mushroom risotto.',
  /**
   * Primary CTA. Worded differently from GUIDE.cta, which repeats lower down
   * the page — so the `placement` breakdown in PostHog means something.
   */
  guideCta: 'Explore the Dublin guide →',
  /** Secondary CTA — reveals restaurant name/link search in place. */
  searchTrigger: 'Search a restaurant',
  /**
   * Shown inside the revealed panel. This used to sit under the headline as
   * `subAccent`, but it sells the *secondary* action — as a full-width pink
   * line under a guide-led headline it contradicted the hierarchy.
   */
  searchHint: "Type a Dublin restaurant name — or paste its website — and we'll find the menu.",
  /** Collapses the panel again. Only offered while the search is idle. */
  searchCancel: 'Cancel',
  voteCta: 'Vote for our next city →',
  voteHint: 'Not in Dublin? Put your city on the map.',
  support: "Designed for vegetarians and vegans, and their friends and family.",
} as const;

export const GUIDE = {
  eyebrow: 'Dublin, already tofu-analysed for you',
  headline: "Veggie dishes in Dublin's most popular restaurants",
  lede: "These are the hottest spots in Dublin — we've read every menu so you can see what's there for vegetarians and vegans before you book.",
  cta: 'View Dublin Guide →',
} as const;

export const STORY = {
  eyebrow: 'Why this exists',
  headline: 'I used to spend hours reading menus to look for restaurants for my vegetarian partner.',
  paragraphs: [
    "I like eating nice food. My partner is vegetarian, and so is his mum. Every time we wanted to eat somewhere good, I'd spend hours on it — going through the newest, most talked-about restaurants from the Irish Times and the food blogs, opening menu after menu, only to find the same thing.",
  ],
  pullQuote: 'One half-hearted vegetarian dish: Mushroom risotto. Pasta arrabbiata. €25, please.',
  paragraphsAfter: [
    'They were so sick of it. So I built Picky — an app to find the best veggie-friendly places in town for vegetarians, and their friends and family.',
  ],
  bylineName: 'Hilton',
  bylineRole: 'Loving boyfriend of a vegetarian in Dublin',
} as const;

export const PILLARS = {
  eyebrow: 'Behind the results',
  headline: 'How does Picky work?',
  cards: [
    {
      tag: 'AI',
      tone: 'ai',
      title: 'Reads every dish',
      body: 'Reading thousands of menus by hand was never going to happen. The AI finds the menu itself, reads PDFs and photo menus, and checks each dish for hidden fish sauce, stock and gelatine.',
    },
    {
      tag: 'HUMAN',
      tone: 'human',
      title: 'Samples and reviews',
      body: 'We review batches of classifications by hand and work through our own error log to fix the causes, not the symptoms — so the results keep getting better, not just bigger.',
    },
    {
      tag: 'YOU',
      tone: 'you',
      title: 'Can flag anything',
      // Careful with this claim: we read the feedback that comes in, but we do
      // NOT re-check every individual flag — that would overstate it.
      body: 'Wrong label, missing dish, wrong menu — one tap on any dish. We read the feedback that comes in, and it shapes what gets fixed next.',
    },
  ],
} as const;

export const FEEDBACK_CTA = {
  eyebrow: 'Help shape Picky',
  headline: 'Got an idea—or something we got wrong?',
  body: 'Choose where Picky goes next, or tell us what needs fixing.',
  city: {
    eyebrow: 'Next stop',
    title: 'Put your city on Picky’s map.',
    button: 'Vote for a city →',
  },
  general: {
    eyebrow: 'Everything else',
    title: 'Ideas, fixes, missing places.',
    button: 'Share feedback →',
  },
} as const;
