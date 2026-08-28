/**
 * Builds the four Picky dashboards in PostHog, plus their insights.
 *
 * Defined in code rather than clicked together in the UI so they can be reviewed
 * in a diff, rebuilt from scratch, and reasoned about without logging in.
 * Idempotent: matches dashboards and insights by name and updates in place, so
 * re-running never duplicates.
 *
 *   npx tsx scripts/posthog/dashboards.ts           # create/update
 *   npx tsx scripts/posthog/dashboards.ts --list    # show what exists
 *
 * The dashboards deliberately mirror the founder's stated quality order —
 * right menus, then fetch success, then dish coverage, then classification —
 * so the live dashboard and /admin/eval tell the same story rather than two
 * competing ones.
 */
import '../_preload-env';

const HOST = 'https://eu.posthog.com';
const PROJECT_ID = '226285';
const KEY = process.env.POSTHOG_PERSONAL_API_KEY;

if (!KEY) {
  console.error('POSTHOG_PERSONAL_API_KEY missing from .env.local');
  process.exit(1);
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${HOST}/api/projects/${PROJECT_ID}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body).slice(0, 500)}`);
  return body as Record<string, unknown>;
}

/** Exclude the founder's own browser from every product number. */
const NOT_INTERNAL = [
  { key: 'is_internal', value: ['true'], operator: 'is_not', type: 'person' },
];

type Insight = { name: string; description: string; query: Record<string, unknown> };

const trend = (
  name: string,
  description: string,
  series: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {}
): Insight => ({
  name,
  description,
  query: {
    kind: 'InsightVizNode',
    source: {
      kind: 'TrendsQuery',
      series,
      interval: 'day',
      dateRange: { date_from: '-30d' },
      properties: NOT_INTERNAL,
      ...extra,
    },
  },
});

const ev = (event: string, extra: Record<string, unknown> = {}) => ({
  kind: 'EventsNode',
  event,
  math: 'total',
  ...extra,
});

const DASHBOARDS: Array<{ name: string; description: string; insights: Insight[] }> = [
  {
    name: '① Reach — is anyone showing up?',
    description:
      'Top of funnel. Counts pageviews and visits, including people who never accepted cookies (they are counted anonymously, with nothing stored on their device). Expect this population to be LARGER than dashboards ②–④, which cover consenting users only — that difference is the consent deal, not a bug.',
    insights: [
      trend('Pageviews', 'Every page view, consented or not.', [ev('$pageview')]),
      trend('Unique visitors', 'Distinct browsers per day.', [
        ev('$pageview', { math: 'dau' }),
      ]),
      trend('Pages entered', 'Which page people land on first.', [ev('$pageview')], {
        breakdownFilter: { breakdown: '$pathname', breakdown_type: 'event' },
      }),
      trend('Referrers', 'Where they came from — the read on whether sharing works.', [ev('$pageview')], {
        breakdownFilter: { breakdown: '$referring_domain', breakdown_type: 'event' },
      }),
      trend('Device type', 'Mobile vs desktop. Mobile is where a slow analysis hurts most.', [ev('$pageview')], {
        breakdownFilter: { breakdown: '$device_type', breakdown_type: 'event' },
      }),
      trend('Consent decisions', 'Accept vs decline — tells you how much of ②–④ you are seeing.', [
        ev('cookie_consent_decision'),
      ], {
        breakdownFilter: { breakdown: 'accepted', breakdown_type: 'event' },
      }),
      trend(
        'HERO: guide vs search — the hypothesis under test',
        'Compares Dublin-guide and restaurant-search intent since the guide-led hero launched on 2026-08-06. Break guide clicks down by `placement`. A wide guide win supports the layout; a narrow win or falling search_disclosed count suggests restaurant search is too hard to find.',
        [ev('guide_cta_clicked'), ev('search_disclosed')],
        { breakdownFilter: { breakdown: 'placement', breakdown_type: 'event' } }
      ),
      trend(
        'TOP SEARCHED RESTAURANTS',
        'What people actually come here to look up, by domain. Read this next to "Searched restaurants — did they work?" on dashboard ③: a domain high in both lists is a popular restaurant we are failing, which is the most valuable thing to fix. NOTE: PostHog only sees consenting visitors and only the domain — /admin/searches has every search and the full URL.',
        [ev('search_submitted')],
        { breakdownFilter: { breakdown: 'domain', breakdown_type: 'event' } }
      ),
    ],
  },
  {
    name: '② Funnel — where do people drop off?',
    description:
      'The core question. Every step is a consented event so the percentages stay internally consistent. Read the abandonment chart alongside it: a big drop between search and result usually means the wait is too long, not that the pipeline failed.',
    insights: [
      {
        name: 'Core funnel: search → menu → engaged',
        description:
          'The main conversion path. results_viewed is filtered to outcome=menu, so this is genuinely "got a usable menu", not merely "landed on the page".',
        query: {
          kind: 'InsightVizNode',
          source: {
            kind: 'FunnelsQuery',
            series: [
              ev('search_submitted'),
              ev('results_viewed', {
                properties: [{ key: 'outcome', value: ['menu'], operator: 'exact', type: 'event' }],
              }),
              ev('results_engaged'),
            ],
            dateRange: { date_from: '-30d' },
            properties: NOT_INTERNAL,
            funnelsFilter: { funnelVizType: 'steps' },
          },
        },
      },
      {
        // Deliberately a NEW insight rather than a step spliced into "Core
        // funnel" above: inserting a step in front of search_submitted changes
        // that funnel's denominator, so its 30-day chart would read as a cliff
        // for a month and stop being comparable to anything before the change.
        name: 'Search funnel incl. disclosure',
        description:
          'The search path since the guide-led hero launched on 2026-08-06. The drop from search_disclosed to search_submitted shows people who opened search but did not submit. A wide gap means the ask may be unclear; a low search_disclosed count means search may be buried.',
        query: {
          kind: 'InsightVizNode',
          source: {
            kind: 'FunnelsQuery',
            series: [
              ev('search_disclosed'),
              ev('search_submitted'),
              ev('results_viewed', {
                properties: [{ key: 'outcome', value: ['menu'], operator: 'exact', type: 'event' }],
              }),
              ev('results_engaged'),
            ],
            dateRange: { date_from: '-30d' },
            properties: NOT_INTERNAL,
            funnelsFilter: { funnelVizType: 'steps' },
          },
        },
      },
      {
        name: 'Guide funnel incl. CTA click',
        description:
          'Adds the click itself in front of the arrival. guide_viewed only fires once someone lands on /dublin, so the gap between these two steps is clicks that never landed — a bounce, a back button, a slow route. A widening gap is a performance problem, not a content one.',
        query: {
          kind: 'InsightVizNode',
          source: {
            kind: 'FunnelsQuery',
            series: [
              ev('guide_cta_clicked'),
              ev('guide_viewed'),
              ev('results_viewed', {
                properties: [{ key: 'source', value: ['guide'], operator: 'exact', type: 'event' }],
              }),
              ev('results_engaged'),
            ],
            dateRange: { date_from: '-30d' },
            properties: NOT_INTERNAL,
          },
        },
      },
      {
        name: 'Guide funnel: guide → restaurant → engaged',
        description: 'Whether the city guides drive real usage or just look good.',
        query: {
          kind: 'InsightVizNode',
          source: {
            kind: 'FunnelsQuery',
            series: [
              ev('guide_viewed'),
              ev('results_viewed', {
                properties: [{ key: 'source', value: ['guide'], operator: 'exact', type: 'event' }],
              }),
              ev('results_engaged'),
            ],
            dateRange: { date_from: '-30d' },
            properties: NOT_INTERNAL,
          },
        },
      },
      {
        name: 'Share loop: shared → landed → searched',
        description:
          'Whether Picky spreads. Someone arriving on a shared link and then running their own search is the growth loop closing.',
        query: {
          kind: 'InsightVizNode',
          source: {
            kind: 'FunnelsQuery',
            series: [ev('share_clicked'), ev('share_landing'), ev('search_submitted')],
            dateRange: { date_from: '-90d' },
            properties: NOT_INTERNAL,
          },
        },
      },
      trend(
        'Abandonment by wait time',
        'THE answer to "is the analysis too slow". Break down by elapsed_ms to see how long people will actually wait before giving up.',
        [ev('analysis_abandoned')],
        { breakdownFilter: { breakdown: 'elapsed_ms', breakdown_type: 'event', breakdown_histogram_bin_count: 8 } }
      ),
      trend('Picker abandonment', 'Shown the menu picker vs actually choosing — a step that used to be invisible.', [
        ev('menu_candidates_shown'),
        ev('menus_selected'),
      ]),
    ],
  },
  {
    name: '③ Health — what is breaking?',
    description:
      'Ordered to match the quality bar: fetch failures first, then thin menus, then errors. A wave of thin menus is a bug until proven otherwise — it is never averaged into a single health score here, precisely so it cannot hide.',
    insights: [
      trend(
        'Task success rate (headline)',
        'Successful results vs searches. The single number to watch — a pipeline regression shows up here before it shows up anywhere else, because a reader going down does not throw, it just quietly stops finding menus.',
        [
          ev('results_viewed', {
            properties: [{ key: 'outcome', value: ['menu'], operator: 'exact', type: 'event' }],
          }),
          ev('search_submitted'),
        ]
      ),
      trend('Outcomes', 'menu / no_menu / error, side by side.', [ev('results_viewed')], {
        breakdownFilter: { breakdown: 'outcome', breakdown_type: 'event' },
      }),
      trend(
        'THIN MENUS — the tripwire',
        'Results with fewer than 7 dishes. A 40-dish restaurant showing 3 dishes throws no error and looks healthy on every other chart; this is the only place it surfaces. Treat a rise as a bug.',
        [
          ev('results_viewed', {
            properties: [{ key: 'is_thin', value: ['true'], operator: 'exact', type: 'event' }],
          }),
        ]
      ),
      trend('Dish-count distribution', 'The shape of what users actually get.', [ev('results_viewed')], {
        breakdownFilter: { breakdown: 'dish_count', breakdown_type: 'event', breakdown_histogram_bin_count: 10 },
      }),
      trend('Analysis failures by reason', 'Grouped by stable code, not raw message.', [
        ev('analysis_completed', {
          properties: [{ key: 'success', value: ['false'], operator: 'exact', type: 'event' }],
        }),
      ], {
        breakdownFilter: { breakdown: 'failure_reason', breakdown_type: 'event' },
      }),
      trend('User-visible errors by code', 'Every screen that shows an error reports through one path.', [
        ev('error_shown'),
      ], {
        breakdownFilter: { breakdown: 'error_code', breakdown_type: 'event' },
      }),
      trend('Errors by surface', 'Which screen is failing.', [ev('error_shown')], {
        breakdownFilter: { breakdown: 'surface', breakdown_type: 'event' },
      }),
      trend(
        'Google Places lookup issues',
        'Google fallback failures and actionable lookup outcomes, grouped by stable reason. Filter deployment_environment=production for the live-service view; Preview events are deliberately labelled for verification.',
        [ev('restaurant_search_provider_failed')],
        { breakdownFilter: { breakdown: 'reason', breakdown_type: 'event' } }
      ),
      trend(
        'Restaurant selections by source',
        'Whether selected restaurant-name results came from Picky or the Google fallback.',
        [ev('restaurant_search_result_selected')],
        { breakdownFilter: { breakdown: 'source', breakdown_type: 'event' } }
      ),
      trend('No-menu reasons', 'Separates "site is down" from "site has no menu online" — different fixes.', [
        ev('no_menu_result'),
      ]),
      trend(
        'Searched restaurants — did they work?',
        'Every searched domain split by success, so a popular restaurant that quietly fails is visible rather than hidden inside an overall rate. Pair with "TOP SEARCHED RESTAURANTS" on dashboard ①.',
        [ev('analysis_completed')],
        { breakdownFilter: { breakdown: 'domain', breakdown_type: 'event' } }
      ),
      trend(
        'Successful searches by domain',
        'The same list filtered to successes — subtract it from the one above to see which restaurants people look up but never get a menu for.',
        [
          ev('analysis_completed', {
            properties: [{ key: 'success', value: ['true'], operator: 'exact', type: 'event' }],
          }),
        ],
        { breakdownFilter: { breakdown: 'domain', breakdown_type: 'event' } }
      ),
      trend('Worst domains', 'Where to point the next pipeline fix. Cross-reference parse_attempts for full URLs.', [
        ev('analysis_completed', {
          properties: [{ key: 'success', value: ['false'], operator: 'exact', type: 'event' }],
        }),
      ], {
        breakdownFilter: { breakdown: 'domain', breakdown_type: 'event' },
      }),
      trend('Crashes and rate limits', 'Both should be flat at zero.', [
        ev('app_crashed'),
        ev('rate_limit_hit'),
      ]),
      trend(
        'Rageclicks — frustration without an error',
        'Already firing, and a high rate at low traffic is a real signal: something looks clickable and is not.',
        [ev('$rageclick')],
        { breakdownFilter: { breakdown: '$pathname', breakdown_type: 'event' } }
      ),
      trend(
        'Name search that found nothing',
        'How often the Dublin name search comes up empty. Fires but was on no dashboard, so a search feature that never finds anything would have looked like silence.',
        [ev('restaurant_search_no_results')]
      ),
      trend(
        'Guide filter usage',
        'Area and cuisine filters on the city guide — whether the filtering added in #31 is used at all.',
        [ev('guide_filter_changed')],
        { breakdownFilter: { breakdown: 'filter', breakdown_type: 'event' } }
      ),
    ],
  },
  {
    name: '④ Voice — do they like it?',
    description:
      'HEART: happiness, engagement, retention. Survey verbatims live in PostHog Surveys; this is the quantitative side.',
    insights: [
      trend('Engagement rate', 'Used a menu vs merely saw one. A gap here means menus load but are not useful.', [
        ev('results_engaged'),
        ev('results_viewed'),
      ]),
      trend('NPS responses', 'Day-7 prompt.', [ev('nps_submitted')], {
        breakdownFilter: { breakdown: 'score', breakdown_type: 'event' },
      }),
      trend('Feedback by type', 'What people volunteer unprompted.', [ev('feedback_submitted')], {
        breakdownFilter: { breakdown: 'feedback_type', breakdown_type: 'event' },
      }),
      trend(
        'Dish reports — the trust metric',
        'A reported misclassification is the closest thing to a user telling you the product misled them. Watch the issue types.',
        [ev('dish_reported')],
        { breakdownFilter: { breakdown: 'issue_type', breakdown_type: 'event' } }
      ),
      {
        // The voting feature shipped in #34 with all three events wired and
        // CITY_VOTE_FUNNEL exported, but nothing on any dashboard referenced
        // them — so the one thing the launch post asks people to do had no
        // visibility at all.
        name: 'City vote funnel: CTA → started → submitted',
        description:
          'Where the "vote for the next city" ask loses people. A big drop from started to submitted means the form is too much work; a low CTA count means the ask is buried.',
        query: {
          kind: 'InsightVizNode',
          source: {
            kind: 'FunnelsQuery',
            series: [
              ev('city_vote_cta_clicked'),
              ev('city_vote_started'),
              ev('city_vote_submitted'),
            ],
            dateRange: { date_from: '-30d' },
            properties: NOT_INTERNAL,
            funnelsFilter: { funnelVizType: 'steps' },
          },
        },
      },
      trend(
        'Votes by city — what to build next',
        'The actual product-direction signal from /vote.',
        [ev('city_vote_submitted')],
        { breakdownFilter: { breakdown: 'city', breakdown_type: 'event' } }
      ),
      trend(
        'Inline feedback — notes at the moments we break',
        'Free-text notes left on the menu picker and the error screens. These are the highest-signal reports we get: the person could see the real menu when we could not.',
        [ev('inline_feedback_submitted')],
        { breakdownFilter: { breakdown: 'surface', breakdown_type: 'event' } }
      ),
      trend('Share rate', 'Shares vs results seen — the organic-growth read.', [
        ev('share_clicked'),
        ev('results_viewed'),
      ]),
      trend('Diet filter usage', 'Which diet people actually filter for — a product-direction signal.', [
        ev('filter_changed'),
      ], {
        breakdownFilter: { breakdown: 'filter', breakdown_type: 'event' },
      }),
      {
        name: 'Retention — do they come back and search again?',
        description: 'Weekly retention on search_submitted. The honest read on whether Platefully is useful more than once.',
        query: {
          kind: 'InsightVizNode',
          source: {
            kind: 'RetentionQuery',
            dateRange: { date_from: '-60d' },
            retentionFilter: {
              targetEntity: { id: 'search_submitted', type: 'events' },
              returningEntity: { id: 'search_submitted', type: 'events' },
              period: 'Week',
              retentionType: 'retention_first_time',
            },
          },
        },
      },
    ],
  },
];

async function main() {
  const dashes = (await api('/dashboards/?limit=100')) as { results: Array<Record<string, unknown>> };
  const byName = new Map(dashes.results.map((d) => [String(d.name), d]));

  if (process.argv.includes('--list')) {
    console.log(`${dashes.results.length} dashboard(s):\n`);
    for (const d of dashes.results) console.log(`  ${d.name}  (id ${d.id})`);
    return;
  }

  const existingInsights = (await api('/insights/?limit=500')) as {
    results: Array<Record<string, unknown>>;
  };
  const insightByName = new Map(existingInsights.results.map((i) => [String(i.name), i]));

  for (const spec of DASHBOARDS) {
    let dash = byName.get(spec.name);
    if (dash) {
      await api(`/dashboards/${dash.id}/`, {
        method: 'PATCH',
        body: JSON.stringify({ description: spec.description }),
      });
      console.log(`dashboard exists: ${spec.name}`);
    } else {
      dash = await api('/dashboards/', {
        method: 'POST',
        body: JSON.stringify({ name: spec.name, description: spec.description }),
      });
      console.log(`dashboard created: ${spec.name}`);
    }

    for (const ins of spec.insights) {
      const payload = {
        name: ins.name,
        description: ins.description,
        query: ins.query,
        dashboards: [dash.id],
      };
      const found = insightByName.get(ins.name);
      if (found) {
        await api(`/insights/${found.id}/`, { method: 'PATCH', body: JSON.stringify(payload) });
        console.log(`   updated: ${ins.name}`);
      } else {
        await api('/insights/', { method: 'POST', body: JSON.stringify(payload) });
        console.log(`   created: ${ins.name}`);
      }
    }
  }

  console.log('\nDone. Note the deliberate asymmetry: dashboard ① counts everyone,');
  console.log('②–④ cover consenting users only. That gap is expected.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
