/**
 * Browser-neutral analytics contracts.
 *
 * Keep event names and payload builders here so client and server code cannot
 * quietly drift into two spellings or two different property schemas. This
 * module must stay free of posthog-js and browser globals.
 */
export const EVENTS = {
  // --- core funnel ---
  SEARCH_DISCLOSED: 'search_disclosed',
  SEARCH_SUBMITTED: 'search_submitted',
  RESTAURANT_SEARCH_RESULT_SELECTED: 'restaurant_search_result_selected',
  RESTAURANT_SEARCH_NO_RESULTS: 'restaurant_search_no_results',
  RESTAURANT_SEARCH_PROVIDER_FAILED: 'restaurant_search_provider_failed',
  MENU_CANDIDATES_SHOWN: 'menu_candidates_shown',
  MENUS_SELECTED: 'menus_selected',
  ANALYSIS_COMPLETED: 'analysis_completed',
  ANALYSIS_ABANDONED: 'analysis_abandoned',
  RESULTS_VIEWED: 'results_viewed',
  RESULTS_ENGAGED: 'results_engaged',
  NO_MENU_RESULT: 'no_menu_result',

  // --- city guides ---
  GUIDE_CTA_CLICKED: 'guide_cta_clicked',
  GUIDE_VIEWED: 'guide_viewed',
  GUIDE_RESTAURANT_CLICKED: 'guide_restaurant_clicked',
  GUIDE_FILTER_CHANGED: 'guide_filter_changed',
  CITY_VOTE_CTA_CLICKED: 'city_vote_cta_clicked',
  CITY_VOTE_STARTED: 'city_vote_started',
  CITY_VOTE_SUBMITTED: 'city_vote_submitted',

  // --- transparency ---
  COUNTING_METHOD_EXPANDED: 'counting_method_expanded',

  // Fired from the results page. These were raw string literals at the call
  // site for a while: 'filter_changed' happened to match a dashboard by
  // coincidence and 'menu_filter_changed' matched nothing at all. Named here
  // so a rename is a compile error rather than a silently-zero chart.
  FILTER_CHANGED: 'filter_changed',
  MENU_FILTER_CHANGED: 'menu_filter_changed',

  // --- errors ---
  ERROR_SHOWN: 'error_shown',
  APP_CRASHED: 'app_crashed',
  RATE_LIMIT_HIT: 'rate_limit_hit',

  // --- feedback & sharing ---
  FEEDBACK_MODAL_OPENED: 'feedback_modal_opened',
  FEEDBACK_SUBMITTED: 'feedback_submitted',
  // Free-text note captured inline at the two moments the pipeline breaks:
  // the menu picker, and the error / no-menu screens. `surface` says which.
  //
  // SHOWN vs OPENED are not the same step and must not be merged: on a dead
  // end the box is already open, so there is nothing to click and `opened`
  // never fires. The response rate there is submitted/shown; on the menu
  // picker (still a click-to-open link) it is submitted/opened.
  INLINE_FEEDBACK_SHOWN: 'inline_feedback_shown',
  INLINE_FEEDBACK_OPENED: 'inline_feedback_opened',
  INLINE_FEEDBACK_SUBMITTED: 'inline_feedback_submitted',
  REPORT_MODAL_OPENED: 'report_modal_opened',
  DISH_REPORTED: 'dish_reported',
  SHARE_CLICKED: 'share_clicked',
  SHARE_LANDING: 'share_landing',
  NPS_SUBMITTED: 'nps_submitted',
  NPS_DISMISSED: 'nps_dismissed',

  // --- consent ---
  COOKIE_CONSENT_DECISION: 'cookie_consent_decision',
} as const;

/**
 * The PostHog funnel definition for city voting. Landing is the automatic
 * pageview already emitted by posthog-js on initial load and App Router
 * navigation; adding a second custom "viewed" event would double-count it.
 */
export const CITY_VOTE_FUNNEL = [
  { step: 'landed', event: '$pageview', property: '$pathname', value: '/vote' },
  { step: 'selected_city', event: EVENTS.CITY_VOTE_STARTED },
  { step: 'vote_saved', event: EVENTS.CITY_VOTE_SUBMITTED, property: 'duplicate', value: false },
] as const;

export function cityVoteCtaClickedEvent(placement: 'hero' | 'bottom') {
  return {
    event: EVENTS.CITY_VOTE_CTA_CLICKED,
    properties: { placement },
  } as const;
}

export function cityVoteStartedEvent(input: {
  city: string;
  region: string;
  custom: boolean;
}) {
  return {
    event: EVENTS.CITY_VOTE_STARTED,
    properties: input,
  } as const;
}

/** Server-authoritative: call only after the database accepts the vote. */
export function cityVoteSubmittedEvent(input: {
  city: string;
  region: string;
  custom: boolean;
  duplicate: boolean;
}) {
  return {
    event: EVENTS.CITY_VOTE_SUBMITTED,
    properties: input,
  } as const;
}
