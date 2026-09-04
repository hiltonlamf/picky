import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('progressive multi-menu results wiring', () => {
  it('navigates on a partial result without abandoning the analysis stream', () => {
    const hero = readFileSync('components/HeroSearch.tsx', 'utf8');
    const partialStart = hero.indexOf("event.type === 'partial_result'");
    const finalStart = hero.indexOf("event.type === 'result'", partialStart);
    const partialBranch = hero.slice(partialStart, finalStart);

    expect(partialStart).toBeGreaterThan(-1);
    expect(partialBranch).toContain('router.push(`/restaurant/${event.restaurantId}`)');
    expect(partialBranch).not.toContain("return 'done'");
    expect(hero).toContain('if (!navigatedToResultsRef.current)');
  });

  it('persists the first menu as processing and renders it with an in-progress message', () => {
    const analyze = readFileSync('app/api/parse/analyze/route.ts', 'utf8');
    const page = readFileSync('components/RestaurantPage.tsx', 'utf8');

    expect(analyze).toContain("send({ type: 'partial_result', restaurantId, remainingMenuCount })");
    expect(analyze).toContain("{ status: 'processing' }");
    expect(page).toContain("&& !hasRenderableMenu");
    expect(page).toContain("restaurant.status === 'error' && !hasRenderableMenu");
    expect(page).toContain('This menu is ready.');
    expect(page).toContain('We’re still analysing the other menus you selected.');
  });
});
