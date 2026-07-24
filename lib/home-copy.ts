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
    after: ' at any restaurant, instantly.',
  },
  sub: "No more showing up in places that only offer mushroom risotto.",
  subAccent: "Drop any restaurant website — we'll find the menu and the veggie dishes.",
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
  headline: {
    before: 'Got an idea, or ',
    accent: 'something we got wrong?',
  },
  body: 'A missing restaurant, a dish we mislabelled, a city you want next — tell us. It goes straight to a person, not an AI.',
  button: 'Share your feedback →',
} as const;
