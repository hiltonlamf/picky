'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { EVENTS } from '@/lib/analytics';
import {
  CITY_VOTE_OPTIONS,
  cityVoteKey,
  normaliseCustomCity,
  type CityVoteOption,
  type CityVoteRegion,
} from '@/lib/city-vote';
import { capture } from '@/lib/posthog-client';

type RegionFilter = 'All' | CityVoteRegion;
type Selection = CityVoteOption & { isCustom: boolean };
type SubmitState = 'idle' | 'submitting' | 'success' | 'error';

const FILTERS: readonly RegionFilter[] = ['All', 'Europe', 'Asia', 'USA'];

export default function CityVoteForm() {
  const [filter, setFilter] = useState<RegionFilter>('All');
  const [query, setQuery] = useState('');
  const [customOpen, setCustomOpen] = useState(false);
  const [customCity, setCustomCity] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [email, setEmail] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [message, setMessage] = useState('');
  const emailRef = useRef<HTMLInputElement>(null);

  const visibleCities = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('en');
    return CITY_VOTE_OPTIONS.filter((option) => {
      const inRegion = filter === 'All' || option.region === filter;
      const matches = !needle || `${option.city} ${option.country}`.toLocaleLowerCase('en').includes(needle);
      return inRegion && matches;
    });
  }, [filter, query]);

  const grouped = useMemo(() => {
    return FILTERS.slice(1).map((region) => ({
      region,
      cities: visibleCities.filter((city) => city.region === region),
    })).filter((group) => group.cities.length > 0);
  }, [visibleCities]);

  useEffect(() => {
    if (!selection || submitState === 'success') return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => emailRef.current?.focus(), 80);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && submitState !== 'submitting') setSelection(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [selection, submitState]);

  function chooseCity(option: CityVoteOption) {
    setSelection({ ...option, isCustom: false });
    setSubmitState('idle');
    setMessage('');
    capture(EVENTS.CITY_VOTE_STARTED, { city: option.city, region: option.region, custom: false });
  }

  function chooseCustomCity() {
    const value = normaliseCustomCity(customCity);
    if (value.length < 2) return;
    const option: Selection = { city: value, country: '', region: 'Europe', flag: '📍', isCustom: true };
    setSelection(option);
    setSubmitState('idle');
    setMessage('');
    capture(EVENTS.CITY_VOTE_STARTED, { city: value, region: 'custom', custom: true });
  }

  async function submitVote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection || submitState === 'submitting') return;
    setSubmitState('submitting');
    setMessage('');

    try {
      const response = await fetch('/api/city-votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: selection.city,
          country: selection.country || null,
          region: selection.isCustom ? null : selection.region,
          isCustom: selection.isCustom,
          email: email.trim(),
        }),
      });
      const data = (await response.json()) as { error?: string; duplicate?: boolean };
      if (!response.ok) throw new Error(data.error || 'We could not save your vote. Please try again.');

      setSubmitState('success');
      capture(EVENTS.CITY_VOTE_SUBMITTED, {
        city: selection.city,
        region: selection.isCustom ? 'custom' : selection.region,
        custom: selection.isCustom,
        duplicate: !!data.duplicate,
      });
      setMessage(
        data.duplicate
          ? `You already backed ${selection.city} — your excellent taste is noted.`
          : `${selection.city} is officially in the running.`
      );
    } catch (error) {
      setSubmitState('error');
      setMessage(error instanceof Error ? error.message : 'We could not save your vote. Please try again.');
    }
  }

  function closePanel() {
    if (submitState === 'submitting') return;
    setSelection(null);
    setSubmitState('idle');
    setMessage('');
  }

  return (
    <div className="max-w-5xl mx-auto px-6">
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-6">
        <div>
          <span className="eyebrow-pink">Choose your contender</span>
          <h2 className="font-display text-[clamp(1.9rem,4vw,3rem)] leading-none tracking-[-0.025em] mt-3">
            What should we tofu-analyse next?
          </h2>
          <p className="mt-3 text-forest/70 max-w-[56ch] leading-relaxed">
            One tap gets your city into the race. Dublin is sitting this one out—it already has a guide.
          </p>
        </div>

        <label className="block lg:w-[320px]">
          <span className="sr-only">Search cities</span>
          <span className="relative block">
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-forest/45">
              <circle cx="11" cy="11" r="6.5" stroke="currentColor" strokeWidth="2" />
              <path d="m16 16 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find your city…"
              className="w-full rounded-full border-2 border-paper-line bg-white py-3.5 pl-12 pr-5 text-forest placeholder:text-forest/45 focus:border-azalea-500 focus:outline-none focus:ring-4 focus:ring-azalea-500/15"
            />
          </span>
        </label>
      </div>

      <div className="mt-8 flex flex-wrap gap-2" aria-label="Filter cities by region">
        {FILTERS.map((region) => (
          <button
            key={region}
            type="button"
            aria-pressed={filter === region}
            onClick={() => setFilter(region)}
            className={`rounded-full px-5 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-azalea-500/25 ${
              filter === region ? 'bg-forest text-paper' : 'border border-paper-line bg-white text-forest hover:border-azalea-500/60'
            }`}
          >
            {region}
          </button>
        ))}
      </div>

      <div className="mt-10 space-y-12">
        {grouped.map(({ region, cities }) => (
          <section key={region} aria-labelledby={`region-${region}`}>
            <div className="flex items-center gap-4 mb-4">
              <h3 id={`region-${region}`} className="font-mono text-xs tracking-[0.14em] uppercase text-azalea-700">
                {region}
              </h3>
              <span className="h-px flex-1 bg-paper-line" />
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {cities.map((option) => (
                <button
                  key={cityVoteKey(option.city, option.country)}
                  type="button"
                  onClick={() => chooseCity(option)}
                  className="group flex min-h-[76px] items-center gap-3 rounded-2xl border-[1.5px] border-paper-line bg-white px-4 py-3 text-left shadow-card-soft transition-all hover:-translate-y-0.5 hover:border-azalea-500 hover:shadow-card-pop focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-azalea-500/25"
                  aria-label={`Vote for ${option.city}, ${option.country}`}
                >
                  <span className="text-2xl" aria-hidden="true">{option.flag}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-display text-lg leading-tight">{option.city}</span>
                    <span className="block mt-0.5 text-xs text-forest/55 truncate">{option.country}</span>
                  </span>
                  <span className="grid h-8 w-8 place-items-center rounded-full bg-mint-100 text-forest transition-colors group-hover:bg-azalea-500 group-hover:text-white" aria-hidden="true">↑</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        {visibleCities.length === 0 && !customOpen && (
          <div className="rounded-3xl border border-paper-line bg-white p-8 text-center">
            <p className="font-display text-xl">No match. Excellent wildcard energy.</p>
            <p className="mt-2 text-sm text-forest/65">Add it as your own pick below.</p>
          </div>
        )}

        <section className="relative overflow-hidden rounded-3xl bg-forest text-paper p-6 md:p-8">
          <div className="mesh" aria-hidden="true">
            <span className="w-[48%] h-[150%] right-[-8%] top-[-30%] bg-azalea-500 opacity-30" />
          </div>
          <div className="relative z-[2] flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <span className="eyebrow-light">Wildcard entry</span>
              <h3 className="font-display text-2xl mt-2">City missing? Put it on the ballot.</h3>
              <p className="mt-2 text-sm text-paper/70">Tiny, mighty, or simply overlooked—we&rsquo;re listening.</p>
            </div>
            {!customOpen ? (
              <button type="button" onClick={() => setCustomOpen(true)} className="btn-ghost-glass self-start md:self-auto">
                Add my city →
              </button>
            ) : (
              <div className="w-full md:max-w-[390px] animate-rise">
                <label htmlFor="custom-city" className="sr-only">City and country</label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    id="custom-city"
                    autoFocus
                    value={customCity}
                    onChange={(event) => setCustomCity(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        chooseCustomCity();
                      }
                    }}
                    placeholder="e.g. Cork, Ireland"
                    maxLength={120}
                    className="min-w-0 flex-1 rounded-full bg-white px-5 py-3 text-forest placeholder:text-forest/45 focus:outline-none focus:ring-4 focus:ring-azalea-500/35"
                  />
                  <button
                    type="button"
                    disabled={normaliseCustomCity(customCity).length < 2}
                    onClick={chooseCustomCity}
                    className="rounded-full bg-azalea-500 px-5 py-3 font-display text-white transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Vote →
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      {selection && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-forest-deep/70 p-0 sm:p-6 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="vote-dialog-title"
            className="relative w-full max-w-lg overflow-hidden rounded-t-[28px] sm:rounded-[28px] bg-paper p-6 pb-8 sm:p-8 shadow-2xl animate-rise"
          >
            <button
              type="button"
              onClick={closePanel}
              disabled={submitState === 'submitting'}
              className="absolute right-5 top-5 grid h-10 w-10 place-items-center rounded-full bg-white text-forest/65 hover:text-forest focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-azalea-500/25"
              aria-label="Close vote form"
            >
              ×
            </button>

            {submitState === 'success' ? (
              <div className="py-5 text-center" aria-live="polite">
                <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-mint-100 text-3xl" aria-hidden="true">✓</span>
                <p className="eyebrow-pink mt-6">Vote counted</p>
                <h2 id="vote-dialog-title" className="font-display text-3xl leading-tight mt-2">Big city-guide energy.</h2>
                <p className="mt-3 text-forest/70">{message}</p>
                <p className="mt-2 text-sm text-forest/55">We&rsquo;ll be in touch if it makes the map.</p>
                <button type="button" onClick={closePanel} className="btn-guide mt-7">Done</button>
              </div>
            ) : (
              <>
                <span className="inline-flex items-center gap-2 rounded-full bg-mint-100 px-4 py-2 text-sm font-semibold">
                  <span aria-hidden="true">{selection.flag}</span>
                  {selection.city}{selection.country ? `, ${selection.country}` : ''}
                </span>
                <h2 id="vote-dialog-title" className="font-display text-[clamp(1.8rem,5vw,2.5rem)] leading-tight mt-5 pr-10">
                  Nice pick. Make it official?
                </h2>
                <p className="mt-3 text-forest/70 leading-relaxed">
                  Add your email to count your vote and hear if {selection.city} gets the Picky treatment.
                </p>

                <form onSubmit={submitVote} className="mt-6">
                  <label htmlFor="vote-email" className="block text-sm font-semibold mb-2">Your email</label>
                  <input
                    ref={emailRef}
                    id="vote-email"
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-full border-2 border-paper-line bg-white px-5 py-4 text-forest placeholder:text-forest/45 focus:border-azalea-500 focus:outline-none focus:ring-4 focus:ring-azalea-500/15"
                  />
                  <p className="mt-2.5 text-xs leading-relaxed text-forest/55">
                    One email keeps each vote honest—and lets us tell you if your city wins. No random inbox clutter.
                  </p>
                  {submitState === 'error' && (
                    <p role="alert" className="mt-3 text-sm font-semibold text-azalea-700">{message}</p>
                  )}
                  <button type="submit" disabled={submitState === 'submitting'} className="btn-cta mt-6 w-full">
                    {submitState === 'submitting' ? 'Counting your vote…' : `Vote for ${selection.city} →`}
                  </button>
                </form>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
