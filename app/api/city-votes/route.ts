import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { CITY_VOTE_OPTIONS, normaliseCustomCity } from '@/lib/city-vote';
import { countRecentCityGuideVotes, saveCityGuideVote } from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { getClientIp, hashIp } from '@/lib/rate-limit';
import { ANON_ID_COOKIE } from '@/lib/telemetry';

const MAX_VOTES_PER_DAY = 10;

const schema = z.object({
  city: z.string().min(2).max(120),
  country: z.string().max(100).nullable(),
  region: z.enum(['Europe', 'Asia', 'USA']).nullable(),
  isCustom: z.boolean(),
  email: z.string().trim().email().max(254),
});

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: 'Check your city and email, then try again.' }, { status: 400 });
    }

    const input = parsed.data;
    let city = normaliseCustomCity(input.city);
    let country: string | null = input.country;
    let region: string | null = input.region;

    if (input.isCustom) {
      country = null;
      region = null;
    } else {
      const known = CITY_VOTE_OPTIONS.find(
        (option) => option.city.toLocaleLowerCase('en') === city.toLocaleLowerCase('en')
          && option.country === country
          && option.region === region
      );
      if (!known) {
        return NextResponse.json({ error: 'Choose a city from the list or use the custom option.' }, { status: 400 });
      }
      city = known.city;
      country = known.country;
      region = known.region;
    }

    const ipHash = hashIp(getClientIp(request));
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (await countRecentCityGuideVotes(ipHash, since) >= MAX_VOTES_PER_DAY) {
      return NextResponse.json(
        { error: 'That is a lot of city spirit. Try again tomorrow.' },
        { status: 429 }
      );
    }

    const anonId = request.cookies.get(ANON_ID_COOKIE)?.value ?? null;
    const result = await saveCityGuideVote({
      city,
      country,
      region,
      isCustom: input.isCustom,
      email: input.email,
      ipHash,
      anonId,
    });

    await captureServer(request, anonId ?? ipHash, 'city_vote_submitted', {
      city,
      region: region ?? 'custom',
      custom: input.isCustom,
      duplicate: result.duplicate,
    });

    return NextResponse.json({ success: true, duplicate: result.duplicate });
  } catch (error) {
    Sentry.captureException(error);
    return NextResponse.json(
      { error: 'We could not count that vote just now. Please try again.' },
      { status: 500 }
    );
  }
}
