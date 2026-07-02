import { NextRequest } from 'next/server';
import { z } from 'zod';
import { extractAndMerge, ExtractContext } from '@/lib/menu-extract';
import { getMenuCandidates, saveClassifiedMenu, markRestaurantError } from '@/lib/db';
import { checkRateLimit, getClientIp } from '@/lib/rate-limit';
import type { ParseEvent } from '@/types';

// Heavy sites (image-board menus, subpage + vision retries) legitimately need
// more than 60s; Vercel kills the function at maxDuration and the stream dies.
export const maxDuration = 300;

const schema = z.object({
  restaurantId: z.string().uuid('Invalid restaurant id'),
  candidateIds: z.array(z.string()).min(1, 'Pick at least one menu'),
});

function sseEncoder() {
  const encoder = new TextEncoder();
  return (event: ParseEvent) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: NextRequest) {
  const ip = getClientIp(request);
  const encode = sseEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: ParseEvent) => {
        try {
          controller.enqueue(encode(event));
        } catch {}
      };
      const close = () => {
        try {
          controller.close();
        } catch {}
      };

      try {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          send({ type: 'error', error: 'Invalid request body' });
          return close();
        }
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          send({ type: 'error', error: parsed.error.issues[0]?.message ?? 'Invalid request' });
          return close();
        }
        const { restaurantId, candidateIds } = parsed.data;

        const { allowed } = await checkRateLimit(ip);
        if (!allowed) {
          send({ type: 'error', error: `You've reached the limit of 5 searches per hour. Please try again later.` });
          return close();
        }

        const payload = await getMenuCandidates(restaurantId).catch(() => null);
        if (!payload || !payload.candidates?.length) {
          send({ type: 'error', error: 'This selection expired — please search the restaurant again.' });
          return close();
        }

        // Resolve selected ids against the SERVER-STORED candidate list only.
        // No client-supplied URL is ever fetched (prevents SSRF).
        const selected = payload.candidates.filter((c) => candidateIds.includes(c.id));
        if (selected.length === 0) {
          send({ type: 'error', error: 'None of the selected menus could be found — please try again.' });
          return close();
        }

        send({ type: 'progress', step: 'Analysing dishes with AI...', stepNumber: 1, totalSteps: 2 });

        const ctx: ExtractContext = {
          title: payload.title,
          inlineText: payload.inlineText,
          screenshotUrl: payload.screenshotUrl,
          pdfUrls: payload.pdfUrls,
          imageUrls: payload.imageUrls,
          pageUrl: payload.finalUrl,
          // Stream live extraction status so long analyses don't look frozen.
          onProgress: (message) => send({ type: 'progress', step: message, stepNumber: 1, totalSteps: 2 }),
        };

        let menu;
        let usage;
        try {
          const result = await extractAndMerge(selected, ctx);
          menu = result.menu;
          usage = result.usage;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'AI classification failed';
          await markRestaurantError(restaurantId, msg);
          send({ type: 'error', error: msg });
          return close();
        }

        if (!menu.restaurantName && payload.title) menu.restaurantName = payload.title;

        send({ type: 'progress', step: 'Saving your results...', stepNumber: 2, totalSteps: 2 });
        await saveClassifiedMenu(restaurantId, payload.finalUrl, payload.finalUrl, menu, usage);
        send({ type: 'result', restaurantId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'An unexpected error occurred';
        send({ type: 'error', error: msg });
      }
      close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
