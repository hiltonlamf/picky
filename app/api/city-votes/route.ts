import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { CITY_VOTE_OPTIONS, normaliseCustomCity } from '@/lib/city-vote';
import { CityVoteRateLimitError, countRecentCityGuideVotes, saveCityGuideVote } from '@/lib/db';
import { captureServer } from '@/lib/posthog-server';
import { getClientIp } from '@/lib/rate-limit';
import { ANON_ID_COOKIE } from '@/lib/telemetry';
import { hashCityVoteIp, validateCityVoteRequest, validatedAnonId } from '@/lib/city-vote-security';
import { cityVoteSubmittedEvent } from '@/lib/analytics-events';

const MAX_VOTES_PER_DAY = 10;

const schema = z.object({
  city: z.string().min(2).max(120),
  country: z.string().max(100).nullable(),
  region: z.enum(['Europe', 'Asia', 'USA', 'Australia']).nullable(),
  isCustom: z.boolean(),
  email: z.string().trim().email().max(254),
}).strict();

export async function POST(request: NextRequest) {
  const rejection = validateCityVoteRequest(request);
  if (rejection) {
    return NextResponse.json({ error: rejection.error }, { status: rejection.status });
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Check your city and email, then try again.' }, { status: 400 });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Check your city and email, then try again.' }, { status: 400 });
    }

    const input = parsed.data;
    let city = normaliseCustomCity(input.city);
    let country: string | null = input.country;
    let region: string | null = input.region;

    if (city.length < 2 || city.length > 120) {
      return NextResponse.json({ error: 'Check your city and email, then try again.' }, { status: 400 });
    }

    if (input.isCustom) {
      if (!region) {
        return NextResponse.json({ error: 'Choose a region for your custom city.' }, { status: 400 });
      }
      country = null;
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

    const ipHash = hashCityVoteIp(getClientIp(request));
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    if (await countRecentCityGuideVotes(ipHash, since) >= MAX_VOTES_PER_DAY) {
      return NextResponse.json(
        { error: 'That is a lot of city spirit. Try again tomorrow.' },
        { status: 429 }
      );
    }

    const anonId = validatedAnonId(request.cookies.get(ANON_ID_COOKIE)?.value);
    const result = await saveCityGuideVote({
      city,
      country,
      region,
      isCustom: input.isCustom,
      email: input.email,
      ipHash,
      anonId,
    });

    const analytics = cityVoteSubmittedEvent({
      city,
      region: region ?? 'custom',
      custom: input.isCustom,
      duplicate: result.duplicate,
    });
    await captureServer(request, anonId ?? ipHash, analytics.event, analytics.properties);

    // Do not reveal whether this email already voted for the city. That would
    // let anyone test an address and learn about another person's activity.
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof CityVoteRateLimitError) {
      return NextResponse.json(
        { error: 'That is a lot of city spirit. Try again tomorrow.' },
        { status: 429 }
      );
    }
    Sentry.captureException(error);
    return NextResponse.json(
      { error: 'We could not count that vote just now. Please try again.' },
      { status: 500 }
    );
  }
}
