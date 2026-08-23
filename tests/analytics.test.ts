import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * These cover the consent state machine and the error classifier — the two
 * pieces where a silent regression would be invisible in production.
 *
 * A wrong consent branch either loses every pageview (top-of-funnel reads
 * zero) or captures behaviour from someone who declined (a privacy failure
 * nothing would surface). Neither shows up in a typecheck, and PostHog's own
 * config type is loose enough that a mistyped option compiles fine, so this is
 * the only automated guard.
 *
 * Browser globals are stubbed by hand rather than pulling in jsdom: the surface
 * needed is three objects, and a dev dependency per test file adds up.
 */

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  register: vi.fn(),
  set_config: vi.fn(),
  startSessionRecording: vi.fn(),
}));

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock('posthog-js', () => ({ default: posthog }));
vi.mock('@sentry/nextjs', () => sentry);

const ANON = '11111111-2222-3333-4444-555555555555';

/** Minimal window/localStorage/document so the client module thinks it's in a
 *  browser. Returns the backing store so tests can assert what was persisted. */
function installDom(opts: { consent?: string | null; pathname?: string; search?: string } = {}) {
  const store = new Map<string, string>();
  if (opts.consent != null) store.set('picky-cookie-consent', opts.consent);

  (globalThis as Record<string, unknown>).window = {
    location: { pathname: opts.pathname ?? '/', search: opts.search ?? '', protocol: 'https:' },
  };
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };

  // A real document.cookie *appends* on assignment; a plain string property
  // replaces. Modelling that faithfully matters — with a naive string stub,
  // writing the consent cookie wiped picky_anon_id and the test reported a
  // failure the browser would never have.
  const jar = new Map<string, string>([['picky_anon_id', ANON]]);
  (globalThis as Record<string, unknown>).document = {
    get cookie() {
      // forEach rather than spreading the Map: this project's tsconfig target
      // rejects Map iteration without --downlevelIteration, and CI runs tsc.
      const parts: string[] = [];
      jar.forEach((v, k) => parts.push(`${k}=${v}`));
      return parts.join('; ');
    },
    set cookie(raw: string) {
      const [pair] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    },
  };
  return store;
}

/** Fresh module instance — the client keeps `initialized` at module scope. */
async function loadClient() {
  vi.resetModules();
  return import('@/lib/posthog-client');
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = 'phc_test';
});

describe('consent gating', () => {
  it('boots in memory-only mode before consent, and captures pageviews', async () => {
    installDom({ consent: null });
    const { capture, initPostHog } = await loadClient();
    initPostHog();

    expect(posthog.init).toHaveBeenCalledOnce();
    const cfg = posthog.init.mock.calls[0][1];
    // Nothing may be written to the device before someone agrees.
    expect(cfg.persistence).toBe('memory');
    expect(cfg.disable_session_recording).toBe(true);
    expect(cfg.person_profiles).toBe('identified_only');
    // But we still need to know a visit happened.
    expect(cfg.capture_pageview).toBe('history_change');
    // Same identity as the middleware cookie, so events join across
    // client, server and DB.
    expect(cfg.bootstrap).toEqual({ distinctID: ANON });
    // No person profile until consent.
    expect(posthog.identify).not.toHaveBeenCalled();

    capture('$pageview');
    expect(posthog.capture).toHaveBeenCalledWith('$pageview', undefined);
  });

  it("disables posthog's own collectors before consent", async () => {
    installDom({ consent: null });
    const { initPostHog } = await loadClient();
    initPostHog();
    const cfg = posthog.init.mock.calls[0][1];

    // Regression test for a real leak found on the PR #21 preview: gating our
    // own capture() wrapper is not enough, because posthog-js collects
    // autocapture and web vitals internally, bypassing it entirely. 45
    // autocapture events fired in one session before the banner was answered —
    // autocapture records clicked element text, which is behavioural tracking
    // of someone who never agreed to any.
    expect(cfg.autocapture).toBe(false);
    expect(cfg.capture_performance).toBe(false);
    expect(cfg.capture_heatmaps).toBe(false);
    expect(cfg.capture_dead_clicks).toBe(false);
    expect(cfg.disable_surveys).toBe(true);
    expect(cfg.disable_session_recording).toBe(true);
  });

  it("switches posthog's collectors on when consent is granted", async () => {
    installDom({ consent: null });
    const { grantConsent } = await loadClient();
    grantConsent();

    const cfg = posthog.set_config.mock.calls[0][0];
    expect(cfg.autocapture).toBe(true);
    expect(cfg.capture_performance).toBe(true);
    expect(cfg.disable_surveys).toBe(false);
    expect(cfg.disable_session_recording).toBe(false);
    expect(cfg.persistence).toBe('localStorage+cookie');
  });

  it('enables the collectors up front for someone who already consented', async () => {
    installDom({ consent: '1' });
    const { initPostHog } = await loadClient();
    initPostHog();
    const cfg = posthog.init.mock.calls[0][1];

    expect(cfg.autocapture).toBe(true);
    expect(cfg.disable_session_recording).toBe(false);
  });

  it('drops behavioural events before consent', async () => {
    installDom({ consent: null });
    const { capture } = await loadClient();

    capture('search_submitted', { domain: 'example.com' });
    capture('results_viewed', { dish_count: 12 });
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('captures everything once consent is granted', async () => {
    installDom({ consent: '1' });
    const { capture, initPostHog } = await loadClient();
    initPostHog();

    expect(posthog.init.mock.calls[0][1].persistence).toBe('localStorage+cookie');
    expect(posthog.init.mock.calls[0][1].disable_session_recording).toBe(false);
    expect(posthog.identify).toHaveBeenCalledWith(ANON);

    capture('search_submitted', { domain: 'example.com' });
    expect(posthog.capture).toHaveBeenCalledWith('search_submitted', { domain: 'example.com' });
  });

  it('upgrades in place on accept, keeping the same distinct_id', async () => {
    installDom({ consent: null });
    const { grantConsent } = await loadClient();
    grantConsent();

    // Upgraded rather than re-initialised: a re-init would reset the
    // distinct_id and orphan the pageviews already recorded.
    expect(posthog.init).toHaveBeenCalledOnce();
    // objectContaining: the same call also switches the collectors on (see the
    // collector tests above), so this asserts the storage upgrade specifically
    // rather than pinning the whole payload.
    expect(posthog.set_config).toHaveBeenCalledWith(
      expect.objectContaining({ persistence: 'localStorage+cookie' })
    );
    expect(posthog.identify).toHaveBeenCalledWith(ANON);
    expect(posthog.startSessionRecording).toHaveBeenCalled();
    expect(posthog.capture).toHaveBeenCalledWith('cookie_consent_decision', { accepted: true });
  });

  it('remembers a refusal so the banner stops asking', async () => {
    const store = installDom({ consent: null });
    const { denyConsent, consentState } = await loadClient();
    denyConsent();

    // The old code only ever wrote '1', so a dismissal was
    // indistinguishable from a first visit.
    expect(store.get('picky-cookie-consent')).toBe('0');
    expect(consentState()).toBe('denied');
    expect(posthog.capture).toHaveBeenCalledWith('cookie_consent_decision', { accepted: false });
  });

  it('stays silent for someone who declined', async () => {
    installDom({ consent: '0' });
    const { capture, initPostHog } = await loadClient();
    initPostHog();

    expect(posthog.init.mock.calls[0][1].persistence).toBe('memory');
    capture('search_submitted');
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});

describe('traffic exclusions', () => {
  it('never initialises on admin pages', async () => {
    installDom({ consent: '1', pathname: '/admin/eval' });
    const { capture, initPostHog } = await loadClient();
    initPostHog();

    // Admin is the founder's workplace; counting it inflates every metric.
    expect(posthog.init).not.toHaveBeenCalled();
    capture('anything');
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it('tags the browser as internal when ?internal=1 is used', async () => {
    installDom({ consent: '1', search: '?internal=1' });
    const { initPostHog } = await loadClient();
    initPostHog();

    expect(posthog.register).toHaveBeenCalledWith({ is_internal: true });
  });

  it('does nothing at all without a PostHog key', async () => {
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    installDom({ consent: '1' });
    const { capture, initPostHog } = await loadClient();
    initPostHog();
    capture('search_submitted');

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});

describe('analysis_abandoned must not fire on success', () => {
  /**
   * This is the shape of a bug that reached production twice, so it gets a test
   * even though the real logic lives in a React component.
   *
   * HeroSearch computes `parsingRef` during render and gates abandonment on a
   * separate `reachedTerminalRef`. The first fix checked the terminal flag while
   * computing parsingRef — which never runs again, because setting a ref does not
   * trigger a re-render. The stale value survived to unmount and reported
   * completed analyses as abandoned; on real traffic that meant searches
   * returning 28 and 27 dishes were both logged as abandonments, which would have
   * pinned the main drop-off metric near 100% forever.
   *
   * The invariant: the terminal flag must be read AT REPORT TIME, so it is immune
   * to whether a render happened in between.
   */
  function makeReporter() {
    const parsingRef = { current: null as null | { startedAt: number } };
    const reachedTerminalRef = { current: false };
    const fired: number[] = [];
    // Mirrors the report() closure in HeroSearch.
    const report = () => {
      if (reachedTerminalRef.current) return;
      const p = parsingRef.current;
      if (!p) return;
      parsingRef.current = null;
      fired.push(Date.now() - p.startedAt);
    };
    return { parsingRef, reachedTerminalRef, report, fired };
  }

  it('does not report when the stream reached a terminal outcome and no re-render followed', () => {
    const r = makeReporter();
    r.parsingRef.current = { startedAt: Date.now() - 5_000 }; // set during a 'parsing' render
    r.reachedTerminalRef.current = true;                      // terminal SSE event — no re-render
    r.report();                                               // unmount on router.push
    expect(r.fired).toHaveLength(0);
  });

  it('still reports a genuine abandonment', () => {
    const r = makeReporter();
    r.parsingRef.current = { startedAt: Date.now() - 5_000 };
    r.report(); // tab closed mid-analysis; never reached a terminal outcome
    expect(r.fired).toHaveLength(1);
  });

  it('reports at most once', () => {
    const r = makeReporter();
    r.parsingRef.current = { startedAt: Date.now() - 5_000 };
    r.report();
    r.report(); // pagehide then unmount both fire
    expect(r.fired).toHaveLength(1);
  });
});

describe('server-side consent gate', () => {
  // The browser's localStorage gate is invisible inside an API route, so
  // server events went out regardless of consent. Confirmed on the PR #21
  // preview: analysis_completed and dish_reported arrived from a session that
  // never answered the banner.
  const req = (cookie?: string) => ({
    cookies: { get: (n: string) => (cookie && n === 'picky_analytics_consent' ? { value: cookie } : undefined) },
  });

  it('treats a missing cookie as no consent', async () => {
    const { hasServerAnalyticsConsent } = await import('@/lib/telemetry');
    expect(hasServerAnalyticsConsent(req())).toBe(false);
  });

  it('treats an explicit refusal as no consent', async () => {
    const { hasServerAnalyticsConsent } = await import('@/lib/telemetry');
    expect(hasServerAnalyticsConsent(req('0'))).toBe(false);
  });

  it('recognises consent', async () => {
    const { hasServerAnalyticsConsent } = await import('@/lib/telemetry');
    expect(hasServerAnalyticsConsent(req('1'))).toBe(true);
  });
});

describe('consent cookie for the server', () => {
  it('is written on accept so API routes can see the decision', async () => {
    installDom({ consent: null });
    const { grantConsent } = await loadClient();
    grantConsent();

    expect(document.cookie).toContain('picky_analytics_consent=1');
    // The anon ID must survive — it's the join key across client, server and DB.
    expect(document.cookie).toContain(`picky_anon_id=${ANON}`);
  });

  it('is written on refusal too, so the server knows to stay quiet', async () => {
    installDom({ consent: null });
    const { denyConsent } = await loadClient();
    denyConsent();

    expect(document.cookie).toContain('picky_analytics_consent=0');
  });
});

describe('classifyError', () => {
  // Every string here is a real message the app can show — taken from
  // HeroSearch, the parse routes and the results page, not invented.
  const cases: Array<[string, string]> = [
    ['The analysis took longer than expected and the connection dropped. Please try again — a retry usually succeeds.', 'connection_dropped'],
    ['The analysis is taking much longer than expected. Please try again later.', 'timeout'],
    ['No response body', 'connection_dropped'],
    ['Invalid request body', 'invalid_url'],
    ['Invalid URL', 'invalid_url'],
    ['Restaurant not found', 'not_found'],
    ["This restaurant doesn't exist or was removed.", 'not_found'],
    ['We couldn’t read a menu from that. Please try another link or file.', 'no_menu_readable'],
    ['Rate limit exceeded', 'rate_limited'],
    ['Failed to fetch', 'network'],
    ['Restaurant name search is temporarily unavailable. Paste a website link instead.', 'provider_unavailable'],
    ['Restaurant lookup is temporarily unavailable. Paste its website link or try again.', 'provider_unavailable'],
    ['Google lists this restaurant as permanently closed. Try another result.', 'not_found'],
    ["We couldn't find an official website for that restaurant. Paste a website or menu link instead.", 'not_found'],
    ['Something went wrong. Please try again.', 'unknown'],
    // These three came back 'unknown' on the first real production run, which
    // would have made the health dashboard's failure breakdown useless. Taken
    // verbatim from what the pipeline actually emitted, not retyped.
    ['We couldn’t read a food menu on this website — it may not publish one', 'no_menu_readable'],
    ["We couldn't find a food menu on this website — some restaurants don't publish one online.", 'no_menu_readable'],
    ["We opened the website but couldn't find a menu on it", 'no_menu_readable'],
    ["This website looks like it's down or not live yet.", 'site_unreachable'],
  ];

  it.each(cases)('maps %j to %s', async (message, expected) => {
    const { classifyError } = await import('@/lib/analytics');
    expect(classifyError(message)).toBe(expected);
  });

  it('falls back to unknown for empty input', async () => {
    const { classifyError } = await import('@/lib/analytics');
    expect(classifyError(null)).toBe('unknown');
    expect(classifyError(undefined)).toBe('unknown');
    expect(classifyError('')).toBe('unknown');
  });
});

describe('captureError', () => {
  it('counts every error in PostHog with a stable code', async () => {
    installDom({ consent: '1' });
    const { captureError } = await loadClient().then(() => import('@/lib/analytics'));

    captureError({ surface: 'results', message: 'Restaurant not found', restaurantId: 'r1' });

    expect(posthog.capture).toHaveBeenCalledWith('error_shown', {
      surface: 'results',
      error_code: 'not_found',
      message: 'Restaurant not found',
      restaurant_id: 'r1',
    });
  });

  it('does not spend Sentry quota on expected failures', async () => {
    installDom({ consent: '1' });
    const { captureError } = await loadClient().then(() => import('@/lib/analytics'));

    // A bad URL or a rate limit is the system working as designed.
    captureError({ surface: 'search', message: 'Invalid URL' });
    captureError({ surface: 'search', message: 'Rate limit exceeded' });
    captureError({ surface: 'search', message: 'Restaurant lookup is temporarily unavailable. Paste its website link or try again.' });
    captureError({ surface: 'search', message: 'Google lists this restaurant as permanently closed. Try another result.' });
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('sends genuinely unexpected failures to Sentry for the stack trace', async () => {
    installDom({ consent: '1' });
    const { captureError } = await loadClient().then(() => import('@/lib/analytics'));

    captureError({ surface: 'results', message: 'Something went wrong. Please try again.' });
    expect(sentry.captureException).toHaveBeenCalledOnce();
    expect(sentry.captureException.mock.calls[0][1]).toMatchObject({
      tags: { surface: 'results', error_code: 'unknown' },
    });
  });
});
