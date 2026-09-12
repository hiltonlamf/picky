import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Guardrails on the server-side guide batch.
 *
 * None of these test logic — they protect properties that are invisible in a
 * green build and expensive to get wrong: unattended spend, a leaked token, a
 * second copy of the analysis path. Every one of them has a real precedent in
 * this repo (a $3 suite silently wired to every merge, four world-writable
 * tables, two drifted copies of `heldBackReason`).
 */

const WORKFLOW = readFileSync('.github/workflows/analyze-queue.yml', 'utf8');
const WORKER = readFileSync('scripts/analyze-guide-queue.ts', 'utf8');
const DISPATCH = readFileSync('app/api/admin/guides/[slug]/analyze/route.ts', 'utf8');
const BATCH = readFileSync('lib/guide-batch.ts', 'utf8');

/** The shell body of every `run: |` block, cut at the first line that dedents
 *  out of it — so a following step's comments are never mistaken for script. */
function runScripts(workflow: string): string[] {
  const lines = workflow.split('\n');
  const scripts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)run: \|/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      const lead = line.length - line.trimStart().length;
      if (lead <= indent) break;
      body.push(line);
    }
    scripts.push(body.join('\n'));
  }
  return scripts;
}

describe('nothing spends money on a timer', () => {
  it('the workflow has no schedule', () => {
    // The founder rejected a ~$3 weekly cron in August, and before that EVERY
    // merge to main silently spent ~$3. A guide costs $2-3 to analyse; on a
    // schedule that is a recurring bill for work nobody asked for.
    expect(WORKFLOW).not.toMatch(/^\s*schedule:/m);
    expect(WORKFLOW).not.toMatch(/\bcron\b/);
  });

  it('runs only when a human or the admin app asks it to', () => {
    expect(WORKFLOW).toContain('workflow_dispatch:');
    // A push trigger would analyse a city on every merge.
    expect(WORKFLOW).not.toMatch(/^\s{2}push:/m);
  });

  it('the worker will not spend without --yes', () => {
    expect(WORKER).toContain("const APPLY = process.argv.includes('--yes')");
    // The dry path must return before the loop, not merely log louder.
    expect(WORKER.indexOf('if (!APPLY)')).toBeLessThan(WORKER.indexOf('runQueuePass('));
  });

  // The behaviour of these guards is tested for real in tests/guide-batch.test.ts,
  // with the analysis mocked. What text alone can still check is that the worker
  // WIRES them in — a loop that quietly stopped being handed the spend check
  // would pass every behavioural test in that file and still bypass the cap.
  it('hands the real spend cap to the loop', () => {
    expect(WORKER).toContain('checkSpend: checkDailySpend');
    expect(BATCH).toContain('deps.checkSpend()');
    // Inside the loop, per restaurant — not once before it.
    expect(BATCH.indexOf('deps.checkSpend()')).toBeGreaterThan(BATCH.indexOf('for (const row of queue)'));
  });

  it('hands the real analysis to the loop', () => {
    expect(WORKER).toContain('analyse: reanalyseRestaurant');
  });

  it('gives up on a run of failures instead of grinding through a city', () => {
    // Every failure is a full-price retry ladder. A dead reader or an expired
    // key fails all 40 at ~10-20 billed calls each, and cannot succeed.
    expect(BATCH).toContain('MAX_CONSECUTIVE_FAILURES');
    expect(BATCH).toMatch(/consecutiveFailures >= maxConsecutive/);
  });

  it('keeps the delay that stops a batch tripping the page reader', () => {
    // Without it a run of fast failures fires dozens of reader calls a minute
    // and gets rate-limited — which returned an empty menu for a whole
    // Amsterdam batch and looked like the restaurants had no menus.
    expect(BATCH).toContain('INTER_RESTAURANT_DELAY_MS');
    expect(BATCH).toContain('deps.sleep(delayMs)');
  });

  it('exits non-zero on a breakdown by asking the loop, not by reading its message', () => {
    // Sniffing the stop-reason string for "time budget" would silently start
    // filing issues (or stop filing them) the day that wording changed.
    expect(WORKER).toContain('if (report.broken)');
    expect(WORKER).not.toMatch(/stopReason.*startsWith/);
  });
});

describe('the token stays server-side', () => {
  it('is never a NEXT_PUBLIC_ variable', () => {
    // NEXT_PUBLIC_* is inlined into the browser bundle, so this would hand
    // every visitor the ability to start paid runs.
    expect(DISPATCH).not.toContain('NEXT_PUBLIC_GITHUB');
    expect(DISPATCH).toContain('process.env.GITHUB_WORKFLOW_TOKEN');
  });

  it('never returns the token or GitHub’s echoed request body to the client', () => {
    const body = DISPATCH.slice(DISPATCH.indexOf('if (!res.ok)'));
    expect(body).not.toMatch(/NextResponse\.json\([^)]*\btoken\b/);
    // GitHub's error body can echo the request; it goes to Sentry, not the client.
    expect(body).toMatch(/Sentry\.captureMessage/);
  });

  it('fails closed with a usable message rather than pretending to start', () => {
    expect(DISPATCH).toMatch(/if \(!repo \|\| !token\)/);
    expect(DISPATCH).toContain('actionsUrl');
  });
});

describe('workflow inputs cannot become shell commands', () => {
  it('never interpolates an input, a secret or a step output into a shell line', () => {
    // This repo is public, so anyone can read the workflow. An inline
    // ${{ inputs.city }} in a shell line is a script-injection hole: the value
    // is pasted into the script before bash sees it, so it can carry commands.
    // Inputs go through env: instead, exactly as pipeline.yml does.
    //
    // ${{ github.* }} is deliberately allowed: those values come from GitHub,
    // not from whoever started the run, so they cannot be chosen by a caller.
    const scripts = runScripts(WORKFLOW);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script).not.toMatch(/\$\{\{\s*inputs\./);
      expect(script).not.toMatch(/\$\{\{\s*secrets\./);
      expect(script).not.toMatch(/\$\{\{\s*steps\./);
      expect(script).not.toMatch(/\$\{\{\s*(env|needs)\./);
    }
  });

  it('asks for no more permission than it needs', () => {
    // contents: read + issues: write. Notably NOT actions: write or
    // pull-requests: write — this job reads code and reports, nothing else.
    const perms = WORKFLOW.slice(WORKFLOW.indexOf('permissions:'), WORKFLOW.indexOf('concurrency:'));
    expect(perms).toContain('contents: read');
    expect(perms).not.toContain('write-all');
    expect(perms).not.toMatch(/contents: write/);
  });

  it('will not run two batches over one guide at once', () => {
    // Two workers on the same rows hand the same restaurant to both and pay
    // twice for one result.
    expect(WORKFLOW).toMatch(/group: analyze-queue-/);
    expect(WORKFLOW).toMatch(/cancel-in-progress: false/);
  });
});

describe('one analysis path', () => {
  it('the reparse route and the batch both go through lib/reanalyse', () => {
    const route = readFileSync('app/api/admin/restaurants/[id]/reparse/route.ts', 'utf8');
    expect(route).toContain("from '@/lib/reanalyse'");
    // The route must not have kept its own copy of the pipeline.
    expect(route).not.toContain('extractAndMerge');
    expect(WORKER).toContain("from '../lib/reanalyse'");
  });

  it('the batch does not use parseAndSave, which loses the no_menu verdict', () => {
    // parseAndSave records every failure as `error`, throwing away the
    // unavailable (retryable) vs not_listed (sticky, and published to diners)
    // distinction. Driving a whole city through it would misreport real
    // restaurants at scale.
    expect(WORKER).not.toContain('parseAndSave');
  });

  it('AI spend still flows through callClaude, not around it', () => {
    const reanalyse = readFileSync('lib/reanalyse.ts', 'utf8');
    // It must reach the API only via the extraction helpers, never by
    // constructing its own client — that is how three call sites once went
    // unrecorded and July under-reported spend eightfold.
    expect(reanalyse).not.toContain('new Anthropic');
    expect(reanalyse).toContain('extractAndMerge');
  });
});

describe('staleness is decided in one place', () => {
  it.each([
    ['app/admin/guides/statusBadge.ts', "from '@/lib/guide-queue'"],
    ['lib/review-flags.ts', "from './guide-queue'"],
    ['scripts/analyze-guide-queue.ts', "from '../lib/guide-queue'"],
  ])('%s imports the rule instead of re-deriving it', (path, importFrom) => {
    // A second threshold would let the badge say "analyzing" while the worker
    // reclaims the same row — the two-sources-of-truth bug this codebase keeps
    // paying for.
    const source = readFileSync(path, 'utf8');
    expect(source).toContain(importFrom);
    expect(source).not.toMatch(/15\s*\*\s*60\s*\*\s*1000/);
  });
});
