/**
 * Creates (or updates) the PostHog surveys defined in surveys.json.
 *
 * Kept as a script with the definitions in version control rather than clicked
 * together in the PostHog UI, so the surveys can be reviewed in a diff, restored
 * after an accidental deletion, and reasoned about without logging in.
 *
 * Idempotent: matches existing surveys by name and PATCHes them instead of
 * creating duplicates. Surveys are created as DRAFTS — launching one puts it in
 * front of real users, which is a judgement call for the founder, not a script.
 *
 *   npx tsx scripts/posthog/apply-surveys.ts          # create/update as drafts
 *   npx tsx scripts/posthog/apply-surveys.ts --list   # show current state
 */
import '../_preload-env';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    headers: {
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${path}: ${JSON.stringify(body).slice(0, 400)}`);
  return body as Record<string, unknown>;
}

async function main() {
  const existing = (await api('/surveys/?limit=100')) as { results: Array<Record<string, unknown>> };
  const byName = new Map(existing.results.map((s) => [String(s.name), s]));

  if (process.argv.includes('--list')) {
    console.log(`${existing.results.length} survey(s) in project ${PROJECT_ID}:\n`);
    for (const s of existing.results) {
      const state = s.start_date ? (s.end_date ? 'stopped' : 'RUNNING') : 'draft';
      console.log(`  [${state}] ${s.name}`);
    }
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const defs = JSON.parse(readFileSync(join(here, 'surveys.json'), 'utf8')) as Array<
    Record<string, unknown>
  >;

  for (const def of defs) {
    // `_notes` documents intent for whoever reads the JSON; strip before sending.
    const { _notes, ...payload } = def;
    const name = String(payload.name);
    const found = byName.get(name);
    if (found) {
      await api(`/surveys/${found.id}/`, { method: 'PATCH', body: JSON.stringify(payload) });
      console.log(`updated: ${name}`);
    } else {
      await api('/surveys/', { method: 'POST', body: JSON.stringify(payload) });
      console.log(`created (draft): ${name}`);
    }
  }

  console.log(
    '\nAll three are DRAFTS. Review the wording and targeting in PostHog, then launch —' +
    '\nthese go in front of real users, so that last step is deliberately manual.'
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
