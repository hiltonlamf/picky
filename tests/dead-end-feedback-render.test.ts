import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEAD_END_FEEDBACK } from '@/lib/site-copy';

// posthog-js and Sentry are browser SDKs; stub them so the component can be
// rendered as markup. vi.mock is hoisted above the imports, so the static
// import below still gets the stubs. Written with createElement rather than
// JSX because the vitest config only picks up `tests/**/*.test.ts`.
vi.mock('@/lib/posthog-client', () => ({ capture: vi.fn() }));
vi.mock('@/lib/analytics', () => ({ captureError: vi.fn() }));

import InlineFeedbackNote from '@/components/InlineFeedbackNote';

function render(props: Record<string, unknown>) {
  return renderToStaticMarkup(createElement(InlineFeedbackNote as never, props as never));
}

const DEAD_END = {
  surface: 'no_menu',
  variant: 'expanded',
  prompt: DEAD_END_FEEDBACK.heading,
  description: DEAD_END_FEEDBACK.body,
  placeholder: DEAD_END_FEEDBACK.placeholder,
  thanks: DEAD_END_FEEDBACK.thanks,
  restaurantId: '00000000-0000-0000-0000-000000000000',
  restaurantName: 'Rasa',
};

describe('the dead-end feedback box', () => {
  const html = render(DEAD_END);

  it('renders the text field with no click required', () => {
    // The whole point of the change: a disappointed visitor should be able to
    // start typing, not hunt for a link that opens a box.
    expect(html).toContain('<textarea');
    expect(html).toContain(DEAD_END_FEEDBACK.placeholder);
  });

  it('asks an open question instead of repeating the menu-upload ask', () => {
    expect(html).toContain(DEAD_END_FEEDBACK.heading);
    expect(html).toContain('A real person reads every message');
    expect(html).not.toContain('Know where the menu is');
  });

  it('offers no Cancel — there is nothing to collapse back to', () => {
    expect(html).not.toContain('Cancel');
  });

  it('does not grab focus on load', () => {
    expect(html).not.toContain('autofocus');
  });

  it('is a labelled field, not a bare box', () => {
    const forId = html.match(/<label[^>]*for="([^"]+)"/)?.[1];
    expect(forId).toBeTruthy();
    expect(html).toContain(`id="${forId}"`);
  });

  it('reads the reassurance out to screen readers, not just to sighted users', () => {
    const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
  });
});

describe('the menu-picker note is unchanged', () => {
  const html = render({
    surface: 'menu_picker',
    tone: 'dark',
    prompt: 'Menus missing or wrong here? Tell us',
    placeholder: 'e.g. the lunch menu is missing',
  });

  it('is still one quiet line until asked for', () => {
    // Not a dead end: something else on that screen is the primary action, and
    // an always-open box would compete with it.
    expect(html).toContain('Menus missing or wrong here? Tell us');
    expect(html).not.toContain('<textarea');
  });
});
