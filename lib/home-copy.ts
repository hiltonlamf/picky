/**
 * Every word on the homepage lives here, so the copy can be edited without
 * touching layout code. `app/page.tsx` renders straight from these constants.
 */

export const HERO = {
  badge: 'AI-assisted · Human-verified · Made in Dublin',
  /** The headline is split so the middle part can be set in pink. */
  headline: {
    before: 'The popular restaurants that are ',
    accent: 'actually good',
    after: ' for vegetarians.',
  },
  sub: "Not a list of vegetarian restaurants — the places everyone's trying to book, sorted by what's really on the menu for the vegetarian at the table.",
  subAccent: 'For vegetarians, and for the friends and family eating with them.',
  support: "Any restaurant website — we'll find the menu ourselves, PDFs and photo menus included.",
} as const;

export const GUIDE = {
  eyebrow: 'Dublin, already read for you',
  headline: "See the veggie dishes in Dublin's most popular restaurants, curated for you",
  lede: "These aren't vegetarian restaurants. They're the spots people are actually going to right now — we've read every menu so you can see what's there for vegetarians and vegans before you book.",
  cta: 'View Dublin Guide →',
} as const;

export const STORY = {
  eyebrow: 'Why this exists',
  headline: 'I used to spend hours reading menus to look for restaurants for my vegetarian partner.',
  paragraphs: [
    "I'm a data scientist in Dublin. My partner is vegetarian, and so is his mum. Every time we wanted to eat somewhere good, I'd spend hours on it — going through the newest, most talked-about restaurants from the Irish Times and the food blogs, opening menu after menu, only to find the same thing.",
  ],
  pullQuote: 'One half-hearted vegetarian dish. Mushroom risotto. Pasta arrabbiata. €25, please.',
  paragraphsAfter: [
    'They were so sick of it. So I built Picky — not a directory of vegetarian restaurants, but a way to find which of the restaurants everyone wants to go to have something genuinely good for the vegetarian at the table. Useful if you’re vegetarian, and just as useful if you’re the one booking for them.',
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
  body: 'A missing restaurant, a dish we mislabelled, a city you want next — tell us. It goes straight to a person, not a queue.',
  button: 'Share your feedback →',
} as const;
