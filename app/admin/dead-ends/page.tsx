import Link from 'next/link';
import AdminNav from '@/components/admin/AdminNav';
import { getDeadEnds, type DeadEndItem } from '@/lib/db';
import { NO_MENU_REASON_LABEL, noMenuCopy } from '@/lib/site-copy';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live

/** The filter keys, which double as the reason taxonomy. `error` is the parse
 *  failure screen; the rest are the four `no_menu` reasons. */
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'error', label: 'Analysis failed' },
  { value: 'unavailable', label: 'Site unreachable' },
  { value: 'blocked', label: 'Access refused' },
  { value: 'not_listed', label: 'No menu on site' },
  { value: 'closed', label: 'Closed' },
] as const;

/** The bucket an item belongs to — mirrors what the visitor actually saw, so
 *  an `error` restaurant never lands in a no-menu bucket and vice versa. */
function bucketOf(item: DeadEndItem): string {
  return item.status === 'error' ? 'error' : item.reason ?? 'not_listed';
}

/** The exact heading the visitor was shown, so an admin reading this page and a
 *  visitor reading the site are looking at the same words. */
function wallHeading(item: DeadEndItem): string {
  if (item.status === 'error') return "Couldn't read this menu";
  return noMenuCopy(item.reason, item.name ?? 'this restaurant').heading;
}

const BUCKET_STYLE: Record<string, string> = {
  error: 'bg-red-100 text-red-800',
  unavailable: 'bg-amber-100 text-amber-900',
  blocked: 'bg-sun-50 text-sun-800',
  not_listed: 'bg-slate-100 text-slate-700',
  closed: 'bg-slate-100 text-slate-700',
};

/** Mirrors the read cap in getDeadEnds — copy only, the query owns the real one. */
const HIT_ROW_DISCLOSURE = 1000;

function when(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 16).replace('T', ' ');
}

export default async function AdminDeadEndsPage({
  searchParams,
}: {
  searchParams?: { reason?: string };
}) {
  const { items: all, hitWindowDays, hitsTruncated } = await getDeadEnds(150);
  const active = FILTERS.some((f) => f.value === searchParams?.reason) ? searchParams!.reason! : 'all';
  const items = active === 'all' ? all : all.filter((i) => bucketOf(i) === active);

  const counts = new Map<string, number>();
  for (const i of all) counts.set(bucketOf(i), (counts.get(bucketOf(i)) ?? 0) + 1);
  const withNotes = all.filter((i) => i.notes.length > 0).length;

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <AdminNav active="dead-ends" />

      <h1 className="text-xl font-bold text-evergreen mb-2">Dead ends</h1>
      <p className="text-sm text-evergreen/80 mb-6">
        Every restaurant a search ended on with nothing to show — the site was unreachable, the menu was refused us,
        no menu is published, or the analysis errored. Each row is the wall <strong>as the visitor saw it</strong>,
        why we hit it, and anything they typed into the feedback box on that screen. This is quality priority #2
        (&ldquo;actually fetching the menu&rdquo;): a cluster in one bucket is a pipeline bug until proven otherwise,
        not a run of restaurants that stopped publishing menus.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="card p-4">
          <div className={`text-2xl font-bold ${all.length > 0 ? 'text-amber-700' : 'text-evergreen'}`}>{all.length}</div>
          <div className="text-xs text-evergreen/70 mt-1">Restaurants at a dead end</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold text-evergreen">{withNotes}</div>
          <div className="text-xs text-evergreen/70 mt-1">With a note from a visitor</div>
        </div>
        <div className="card p-4">
          <div className={`text-2xl font-bold ${(counts.get('error') ?? 0) > 0 ? 'text-red-700' : 'text-evergreen'}`}>
            {counts.get('error') ?? 0}
          </div>
          <div className="text-xs text-evergreen/70 mt-1">Analysis errored</div>
        </div>
        <div className="card p-4">
          <div className="text-2xl font-bold text-evergreen">
            {(counts.get('unavailable') ?? 0) + (counts.get('blocked') ?? 0)}
          </div>
          <div className="text-xs text-evergreen/70 mt-1">Unreachable or refused</div>
        </div>
      </div>

      {hitsTruncated && (
        <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-6">
          More than {HIT_ROW_DISCLOSURE} dead-end attempts in the last {hitWindowDays} days, which is where the
          database read stops. The <strong>visitor hit</strong> counts below are therefore a floor, not a total — the
          list of restaurants itself is complete.
        </p>
      )}

      <div className="flex items-center gap-1 mb-6 flex-wrap">
        {FILTERS.map((f) => {
          const n = f.value === 'all' ? all.length : counts.get(f.value) ?? 0;
          return (
            <Link
              key={f.value}
              href={f.value === 'all' ? '/admin/dead-ends' : `/admin/dead-ends?reason=${f.value}`}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                active === f.value ? 'bg-evergreen text-lime' : 'text-evergreen/80 hover:bg-mint-100'
              }`}
            >
              {f.label} <span className="font-mono text-xs opacity-70">{n}</span>
            </Link>
          );
        })}
      </div>

      {items.length === 0 && (
        <p className="text-sm text-evergreen/80">
          {all.length === 0 ? 'No dead ends recorded — every search found something. 🎉' : 'Nothing in this bucket.'}
        </p>
      )}

      <div className="space-y-3">
        {items.map((item) => {
          const bucket = bucketOf(item);
          return (
            <div key={item.id} className="card p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="eyebrow mb-1">
                    Last analysed {when(item.lastScrapedAt)}
                    {item.hits > 0 && (
                      <>
                        {' · '}
                        {item.hits} visitor {item.hits === 1 ? 'hit' : 'hits'} in {hitWindowDays}d
                        {item.lastHitAt ? `, latest ${when(item.lastHitAt)}` : ''}
                      </>
                    )}
                  </p>
                  <p className="font-semibold text-evergreen">{item.name ?? item.url}</p>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-evergreen/70 hover:text-azalea-700 underline break-all"
                  >
                    {item.url.replace(/^https?:\/\/(www\.)?/, '')} ↗
                  </a>
                  <p className="text-sm text-evergreen mt-2">
                    Visitor saw: <strong>{wallHeading(item)}</strong>
                  </p>
                  {item.status === 'error' && item.errorMessage && (
                    <p className="text-xs text-evergreen/70 mt-1 font-mono break-words">{item.errorMessage}</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className={`text-xs font-mono uppercase px-2 py-1 rounded-full ${BUCKET_STYLE[bucket] ?? 'bg-slate-100 text-slate-700'}`}>
                    {item.status === 'error' ? 'error' : NO_MENU_REASON_LABEL[bucket] ?? bucket}
                  </span>
                  {item.confirmed && (
                    <span className="text-[11px] text-evergreen/60">signed off as genuinely no menu</span>
                  )}
                </div>
              </div>

              {item.notes.length > 0 && (
                <div className="mt-3 border-t border-mint-100 pt-3 space-y-2">
                  <p className="eyebrow">What the visitor told us</p>
                  {item.notes.map((n) => (
                    <div key={n.id}>
                      <p className="text-sm text-evergreen italic">&ldquo;{n.notes}&rdquo;</p>
                      <p className="text-[11px] text-evergreen/60 font-mono">
                        {when(n.createdAt)} · {n.feedbackType} · {n.status}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 flex items-center gap-4 flex-wrap">
                <Link
                  href={`/admin/restaurants/${item.id}/review`}
                  className="text-sm text-picky-700 hover:underline font-medium"
                >
                  Open to add the menu by hand →
                </Link>
                <Link href={`/restaurant/${item.id}`} className="text-sm text-evergreen/70 hover:underline">
                  See what the visitor sees ↗
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
