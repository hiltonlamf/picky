import { describe, it, expect } from 'vitest';
import { EVENTS } from '@/lib/analytics-events';
import { INLINE_FEEDBACK_TYPES } from '@/lib/dietary-config';
import { noMenuCopy, NO_MENU_REASON_LABEL, DEAD_END_FEEDBACK } from '@/lib/site-copy';
import { readFileSync } from 'node:fs';

const component = readFileSync('components/InlineFeedbackNote.tsx', 'utf8');
const inbox = readFileSync('app/admin/feedback/FeedbackInboxClient.tsx', 'utf8');
const results = readFileSync('components/RestaurantPage.tsx', 'utf8');
const deadEnds = readFileSync('app/admin/dead-ends/page.tsx', 'utf8');

describe('inline feedback capture', () => {
  it('every surface it can post has a label in the admin inbox', () => {
    // A note that lands as a raw slug in the inbox is a note nobody reads.
    // match() rather than spreading matchAll(): the project's tsconfig target
    // needs downlevelIteration to spread an iterator.
    const posted = (component.match(/'\w+_note'/g) ?? []).map((m) => m.slice(1, -1));
    expect(posted.length).toBeGreaterThan(0);
    const labelled = new Set(INLINE_FEEDBACK_TYPES.map((t) => t.value));
    for (const type of posted) expect(labelled.has(type), type).toBe(true);
    expect(inbox).toContain('INLINE_FEEDBACK_TYPES');
  });

  it('posts to the existing feedback endpoint rather than a new one', () => {
    expect(component).toContain("'/api/feedback'");
  });

  it('names its events in the EVENTS schema', () => {
    expect(EVENTS.INLINE_FEEDBACK_OPENED).toBe('inline_feedback_opened');
    expect(EVENTS.INLINE_FEEDBACK_SUBMITTED).toBe('inline_feedback_submitted');
    expect(component).toContain('EVENTS.INLINE_FEEDBACK_SUBMITTED');
  });

  it('keeps "shown" and "opened" as separate events', () => {
    // Merging them would redefine inline_feedback_opened from "they chose to
    // tell us" to "we showed them a box", quietly wrecking every response rate
    // built on it.
    expect(EVENTS.INLINE_FEEDBACK_SHOWN).toBe('inline_feedback_shown');
    expect(EVENTS.INLINE_FEEDBACK_SHOWN).not.toBe(EVENTS.INLINE_FEEDBACK_OPENED);
    expect(component).toContain('EVENTS.INLINE_FEEDBACK_SHOWN');
  });
});

describe('dead-end feedback is open by default', () => {
  const hero = readFileSync('components/HeroSearch.tsx', 'utf8');

  it('expands on every screen where the search ended with nothing', () => {
    // A disappointed visitor is one click from leaving; the note we lose is the
    // one that would have told us why the pipeline failed.
    for (const [name, src] of [['RestaurantPage', results], ['HeroSearch', hero]] as const) {
      const surfaces = src.match(/surface="(no_menu|parse_error)"[\s\S]{0,500}?\/>/g) ?? [];
      expect(surfaces.length, name).toBeGreaterThan(0);
      for (const block of surfaces) expect(block, `${name}: ${block}`).toContain('variant="expanded"');
    }
  });

  it('no longer repeats the "where is the menu" ask the upload card already makes', () => {
    for (const src of [results, hero]) {
      expect(src).not.toContain('Know where the menu is? Tell us');
    }
    expect(DEAD_END_FEEDBACK.heading.toLowerCase()).not.toContain('menu');
  });

  it('does not steal focus when it was never asked for', () => {
    // autoFocus on page load would scroll a disappointed visitor straight past
    // the heading explaining what went wrong.
    expect(component).toContain('autoFocus={!expanded}');
  });

  it('the menu picker stays a quiet link — it is a decision, not a dead end', () => {
    const picker = hero.match(/surface="menu_picker"[\s\S]{0,400}?\/>/)?.[0] ?? '';
    expect(picker).not.toBe('');
    expect(picker).not.toContain('variant="expanded"');
  });
});

describe('the wall a visitor saw is described in one place', () => {
  it('covers every no_menu reason', () => {
    expect(noMenuCopy('unavailable', 'Rasa').heading).toBe('This website looks down');
    expect(noMenuCopy('closed', 'Rasa').heading).toBe('This restaurant looks closed');
    expect(noMenuCopy('blocked', 'Rasa').heading).toContain("can't open it");
    expect(noMenuCopy('not_listed', 'Rasa').heading).toBe('No menu listed on this site');
    // An unknown/absent reason must still render something true, not blank.
    expect(noMenuCopy(null, 'Rasa').heading).toBe('No menu listed on this site');
    expect(noMenuCopy('something_new', 'Rasa').body).toContain('Rasa');
  });

  it('every reason has an admin label, so no bucket renders as a raw slug', () => {
    for (const reason of ['not_listed', 'unavailable', 'closed', 'blocked']) {
      expect(NO_MENU_REASON_LABEL[reason], reason).toBeTruthy();
    }
  });

  it('the visitor screen and the admin page read from the same source', () => {
    expect(results).toContain('noMenuCopy');
    expect(deadEnds).toContain('noMenuCopy');
    expect(deadEnds).toContain('NO_MENU_REASON_LABEL');
  });
});

describe('admin dead-ends page', () => {
  it('is reachable from the admin nav', () => {
    const nav = readFileSync('components/admin/AdminNav.tsx', 'utf8');
    expect(nav).toContain('/admin/dead-ends');
  });

  it('is dynamic — a DB-reading page that prerenders fails the CI build', () => {
    expect(deadEnds).toContain("export const dynamic = 'force-dynamic'");
    expect(deadEnds).toContain("export const fetchCache = 'force-no-store'");
  });

  it('shows both dead-end statuses, not just the no-menu one', () => {
    const dbSrc = readFileSync('lib/db.ts', 'utf8');
    expect(dbSrc).toContain("getDeadEnds");
    expect(dbSrc).toContain("['no_menu', 'error']");
  });
});

describe('results-page filter events', () => {
  // These were raw literals; 'filter_changed' matched a dashboard only by
  // coincidence and a rename on either side would have silently zeroed it.
  it('fire through the EVENTS schema, not string literals', () => {
    expect(results).not.toMatch(/capture\('(menu_)?filter_changed'/);
    expect(results).toContain('EVENTS.FILTER_CHANGED');
    expect(results).toContain('EVENTS.MENU_FILTER_CHANGED');
  });
});

describe('posthog dashboards', () => {
  const dashboards = readFileSync('scripts/posthog/dashboards.ts', 'utf8');

  it('cover the city-vote funnel the launch drives traffic to', () => {
    for (const ev of ['city_vote_cta_clicked', 'city_vote_started', 'city_vote_submitted']) {
      expect(dashboards, ev).toContain(ev);
    }
  });

  it('cover the events that fired but had no chart', () => {
    for (const ev of ['restaurant_search_no_results', 'guide_filter_changed', 'inline_feedback_submitted']) {
      expect(dashboards, ev).toContain(ev);
    }
  });

  it('chart the dead-end response rate against the honest denominator', () => {
    // submitted/shown, not submitted/opened: on a dead end the box is already
    // open, so `opened` never fires and the rate would read as infinite.
    expect(dashboards).toContain('inline_feedback_shown');
  });
});
