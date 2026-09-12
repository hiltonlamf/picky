import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { getCityGuideBySlug, listGuideQueue } from '@/lib/db';
import { hasLiveRun, selectQueue } from '@/lib/guide-queue';

/**
 * Start the server-side batch for a city guide.
 *
 * Admin-gated by middleware.ts. This route does NOT analyse anything itself —
 * it starts a GitHub Actions run (.github/workflows/analyze-queue.yml), because
 * a 40-restaurant batch needs ~30 minutes and Vercel's Hobby plan kills any
 * function at 60 seconds. That is the whole reason the batch used to run in the
 * admin's browser tab, and the whole reason closing the tab stranded it.
 *
 * Security notes:
 *  - The token is server-only. Never expose it as NEXT_PUBLIC_*, which would
 *    ship it to every visitor, and never return it in a response.
 *  - `city` is the slug of a guide that exists in `city_guides`, never free
 *    text from the client. The workflow spends money, so what reaches it must
 *    be a value we chose, not one a caller supplied.
 *  - The client sends no URL and nothing that gets fetched — same principle as
 *    the candidate-id pattern in app/api/parse/analyze.
 */

export const dynamic = 'force-dynamic';

const schema = z.object({ mode: z.enum(['queued', 'failed']).default('queued') });

const WORKFLOW_FILE = 'analyze-queue.yml';

/** Where a human can start the same run by hand when the token isn't set up. */
function actionsUrl(repo: string): string {
  return `https://github.com/${repo}/actions/workflows/${WORKFLOW_FILE}`;
}

export async function POST(request: NextRequest, { params }: { params: { slug: string } }) {
  try {
    const guide = await getCityGuideBySlug(params.slug);
    if (!guide) return NextResponse.json({ error: 'Guide not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }
    const { mode } = parsed.data;

    // Refuse only a run with nothing to do. Note `selectQueue` already excludes
    // restaurants a live run is holding, so a dispatch while another run is
    // working simply picks up whatever that run has not claimed — and the
    // workflow's per-city concurrency group serialises the two.
    //
    // Deliberately NOT "refuse whenever any row looks live": a tab closed five
    // minutes ago leaves a row `processing` for the rest of the staleness
    // window, and blocking on that would lock the admin out of their own guide
    // for ten minutes with a message claiming work is happening. The worker's
    // lease is what actually prevents double-billing; this check is courtesy.
    const rows = await listGuideQueue(guide.slug);
    const queued = selectQueue(rows, { mode });
    if (queued.length === 0) {
      return NextResponse.json(
        {
          error: hasLiveRun(rows)
            ? 'A run is already analysing every restaurant that still needs it. Give it a few minutes.'
            : mode === 'failed'
              ? 'Nothing has failed in this guide, so there is nothing to retry.'
              : 'Every restaurant in this guide has already been analysed.',
        },
        { status: 409 }
      );
    }

    const repo = process.env.GITHUB_REPO;
    const token = process.env.GITHUB_WORKFLOW_TOKEN;
    if (!repo || !token) {
      // Fail closed, but usefully: say what is missing and how to run it by hand
      // in the meantime. A 500 here would look like the feature is broken.
      return NextResponse.json(
        {
          error:
            'Server-side analysis is not configured yet. Add GITHUB_WORKFLOW_TOKEN and GITHUB_REPO to the deployment, or start the run from GitHub.',
          actionsUrl: repo ? actionsUrl(repo) : null,
          configured: false,
        },
        { status: 501 }
      );
    }

    const res = await fetch(
      `https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: process.env.GITHUB_WORKFLOW_REF || 'main',
          inputs: { city: guide.slug, mode },
        }),
      }
    );

    if (!res.ok) {
      // GitHub's body can echo the request; keep it out of the response so a
      // token can never leak through an error message.
      const detail = await res.text().catch(() => '');
      Sentry.captureMessage(`Guide batch dispatch failed (${res.status})`, {
        level: 'error',
        tags: { surface: 'guide_batch_dispatch' },
        extra: { status: res.status, city: guide.slug, detail: detail.slice(0, 500) },
      });
      const hint =
        res.status === 404
          ? 'GitHub rejected the request as not found — usually the token lacks Actions access to this repository, or the workflow is not on the branch being dispatched.'
          : res.status === 401 || res.status === 403
            ? 'GitHub refused the token. It may have expired or lack the Actions write permission.'
            : 'GitHub would not start the run.';
      return NextResponse.json({ error: hint, actionsUrl: actionsUrl(repo) }, { status: 502 });
    }

    // 204 No Content is success, and it carries no run id — GitHub gives no way
    // to learn it from the dispatch itself. Progress is read from the database
    // instead (that is the point: the queue, not the tab, is the source of
    // truth), so hand back the run list for a human who wants the log.
    return NextResponse.json({
      started: true,
      city: guide.slug,
      mode,
      queued: queued.length,
      actionsUrl: actionsUrl(repo),
    });
  } catch (err) {
    Sentry.captureException(err, { tags: { surface: 'guide_batch_dispatch' } });
    const msg = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
