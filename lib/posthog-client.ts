import posthog from 'posthog-js';
import { anonIdFromDocument } from './telemetry';

// Same key CookieConsent.tsx writes: '1' = accepted, '0' = declined,
// absent = not asked yet. The old code only ever wrote '1', so a dismissal
// was indistinguishable from a first visit and the banner nagged forever.
const CONSENT_KEY = 'picky-cookie-consent';

/** Set by visiting any page with ?internal=1 — marks the founder's own
 *  testing so it can be filtered out of every dashboard. */
const INTERNAL_KEY = 'picky-internal';

/**
 * The only events allowed before someone accepts cookies.
 *
 * Pre-consent we run PostHog in a memory-only mode that writes nothing to the
 * device, purely so we can count visits and see which pages people land on —
 * without that, everyone who ignores the banner is invisible and the
 * top-of-funnel number is meaningless. Behavioural events stay off until
 * consent: counting arrivals is not the same as following someone around.
 */
const PRE_CONSENT_EVENTS = new Set(['$pageview', '$pageleave']);

/**
 * posthog-js runs its own collectors that never pass through `capture()`, so
 * gating our wrapper is not enough on its own.
 *
 * Found on the PR #21 preview: `$autocapture` and `$web_vitals` were both
 * firing *before* consent — 45 autocapture events in one five-minute session,
 * the first 17 seconds before the banner was answered. Autocapture records
 * which elements someone clicked, including their text, which is behavioural
 * tracking of a person who hasn't agreed to any. No unit test could have caught
 * it: the events bypass our code entirely.
 *
 * These flags are therefore set at init and flipped together on consent.
 * `set_config` re-runs `autocapture.startIfEnabled()` and friends, so turning
 * them on afterwards genuinely starts them.
 */
function behaviouralCollectors(enabled: boolean) {
  return {
    autocapture: enabled,
    capture_performance: enabled,
    capture_heatmaps: enabled,
    capture_dead_clicks: enabled,
    disable_surveys: !enabled,
    disable_session_recording: !enabled,
  };
}

let initialized = false;
let consentGranted = false;

export type ConsentState = 'granted' | 'denied' | 'unasked';

export function consentState(): ConsentState {
  if (typeof window === 'undefined') return 'unasked';
  switch (localStorage.getItem(CONSENT_KEY)) {
    case '1':
      return 'granted';
    case '0':
      return 'denied';
    default:
      return 'unasked';
  }
}

export function hasAnalyticsConsent(): boolean {
  return consentState() === 'granted';
}

/** Admin pages are the founder's workplace, not product usage — counting them
 *  would inflate every metric on every dashboard. */
function isAdminSurface(): boolean {
  return typeof window !== 'undefined' && window.location.pathname.startsWith('/admin');
}

/** Sticky once set: ?internal=1 marks this browser as the team's own, so
 *  testing on the *public* site can be excluded with one dashboard filter. */
function isInternal(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('internal') === '1') {
      localStorage.setItem(INTERNAL_KEY, '1');
      return true;
    }
    return localStorage.getItem(INTERNAL_KEY) === '1';
  } catch {
    // Private mode / storage disabled — not worth failing analytics over.
    return false;
  }
}

/**
 * Boot PostHog. Safe to call repeatedly and from anywhere — idempotent, and a
 * no-op on admin pages or without a key.
 *
 * Runs in one of two modes:
 *  - **Pre-consent**: `persistence: 'memory'` so nothing is written to the
 *    device, no person profile is created, session replay is off, and
 *    `capture()` only lets pageviews through.
 *  - **Post-consent**: normal persistence, a real person profile, replay on.
 *
 * The distinct_id is the middleware-set `picky_anon_id` cookie in both modes,
 * so a visitor who accepts later keeps the same identity and their pre-consent
 * pageviews still belong to them — and client, server and DB rows all join on
 * the same ID.
 */
export function initPostHog(): void {
  if (initialized || typeof window === 'undefined') return;
  if (isAdminSurface()) return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  const granted = hasAnalyticsConsent();
  const anonId = anonIdFromDocument();

  posthog.init(key, {
    // Events go to our own domain and are proxied on to PostHog by the
    // /ingest rewrite in next.config.js. Requests to posthog.com are blocked
    // by most ad blockers, which silently drops a fifth to a third of all
    // events — and skews them toward more technical users.
    api_host: '/ingest',
    ui_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://eu.posthog.com',
    // Follow App Router client-side navigation. The library's default is
    // load-only unless `defaults` is set past 2025-05-24, so without this a
    // visit to home → /dublin → /restaurant/x records ONE pageview, not three.
    // Set explicitly rather than via `defaults` so a library upgrade moving
    // that cutoff date can't silently change our behaviour.
    capture_pageview: 'history_change',
    capture_pageleave: true,
    // Uncaught client errors become funnel-visible events, not just Sentry rows.
    capture_exceptions: true,
    persistence: granted ? 'localStorage+cookie' : 'memory',
    // Pre-consent we deliberately create no person profile; granting consent
    // calls identify() below, which creates one then.
    person_profiles: 'identified_only',
    // Autocapture, web vitals, heatmaps, replay and surveys — all off until
    // consent. See behaviouralCollectors().
    ...behaviouralCollectors(granted),
    ...(anonId && { bootstrap: { distinctID: anonId } }),
  });

  initialized = true;
  consentGranted = granted;

  if (isInternal()) posthog.register({ is_internal: true });
  if (granted && anonId) posthog.identify(anonId);
}

/**
 * @deprecated Kept so existing callers keep working — prefer `initPostHog`,
 * which also runs (in memory-only mode) before consent is given.
 */
export const initPostHogIfConsented = initPostHog;

/** Record acceptance and upgrade the running instance in place — no reload,
 *  and the visitor keeps the distinct_id their pageviews were already under. */
export function grantConsent(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CONSENT_KEY, '1');
  initPostHog();
  if (!initialized) return;

  consentGranted = true;
  // One call: upgrade storage AND switch on every collector that was held back.
  // set_config re-runs autocapture.startIfEnabled() / heatmaps /
  // sessionRecording internally, so these actually start rather than just
  // being recorded as config.
  posthog.set_config({
    persistence: 'localStorage+cookie',
    ...behaviouralCollectors(true),
  });
  const anonId = anonIdFromDocument();
  if (anonId) posthog.identify(anonId);
  posthog.startSessionRecording();
  capture('cookie_consent_decision', { accepted: true });
}

/** Record a refusal. Stays in memory-only pageview mode — and, unlike the old
 *  "Dismiss", it is remembered, so we stop asking and can measure refusal rate. */
export function denyConsent(): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(CONSENT_KEY, '0');
  consentGranted = false;
  initPostHog();
  // Bypasses capture()'s allowlist on purpose: a refusal is a single
  // aggregate datapoint about the banner, and we can't measure the refusal
  // rate without it. Nothing is persisted to the device either way.
  if (initialized) posthog.capture('cookie_consent_decision', { accepted: false });
}

/**
 * Capture a client-side event. A no-op without a key, on admin pages, or —
 * for anything outside PRE_CONSENT_EVENTS — before consent is given.
 */
export function capture(event: string, properties?: Record<string, unknown>): void {
  // Self-initialize so callers don't depend on mount order relative to
  // PostHogProvider.
  initPostHog();
  if (!initialized) return;
  if (!consentGranted && !PRE_CONSENT_EVENTS.has(event)) return;
  posthog.capture(event, properties);
}
