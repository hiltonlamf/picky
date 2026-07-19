import Link from 'next/link';
import AdminNav from '@/components/admin/AdminNav';
import RestaurantBadges from '@/components/admin/RestaurantBadges';
import { getAdminRestaurants, type GuideFilter } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live

function statusClass(status: string): string {
  if (status === 'error') return 'bg-sun-50 text-sun-800';
  if (status === 'done') return 'bg-mint-100 text-picky-700';
  return 'bg-mint-100 text-evergreen/80';
}

export default async function AdminRestaurantsPage({
  searchParams,
}: {
  searchParams: { city?: string; guide?: string; q?: string; page?: string };
}) {
  const city = searchParams.city || undefined;
  const guide = (['all', 'guide', 'searched'].includes(searchParams.guide ?? '') ? searchParams.guide : 'all') as GuideFilter;
  const search = searchParams.q?.trim() || undefined;
  const page = parseInt(searchParams.page ?? '1', 10) || 1;

  const { rows, total, pageSize, cities, guideTotal } = await getAdminRestaurants({ city, guide, search, page });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  // Build a URL preserving the current filters, overriding some.
  const qs = (over: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const merged = { city, guide, q: search, page, ...over };
    for (const [k, v] of Object.entries(merged)) {
      if (v !== undefined && v !== '' && !(k === 'guide' && v === 'all') && !(k === 'page' && v === 1)) p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `/admin/restaurants?${s}` : '/admin/restaurants';
  };

  const guideTab = (key: GuideFilter, label: string) => (
    <Link
      href={qs({ guide: key, page: 1 })}
      className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
        guide === key ? 'bg-evergreen text-lime' : 'text-evergreen/80 hover:bg-mint-100'
      }`}
    >
      {label}
    </Link>
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav active="restaurants" />

      <div className="mb-2">
        <h1 className="text-xl font-bold text-evergreen">All restaurants</h1>
        <p className="text-sm text-evergreen/80">
          Every restaurant we&rsquo;ve classified — whether a user searched it or it&rsquo;s curated into a city guide.
          {' '}
          <span className="font-medium text-evergreen">{guideTotal}</span> of them are in a guide.
        </p>
      </div>

      {/* Guide filter tabs */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {guideTab('all', 'All')}
        {guideTab('guide', '⭐ In a guide')}
        {guideTab('searched', 'User-searched')}
      </div>

      {/* City + search filter (GET form) */}
      <form method="get" className="flex items-center gap-2 mb-6 flex-wrap">
        {/* keep the guide filter when submitting the form */}
        {guide !== 'all' && <input type="hidden" name="guide" value={guide} />}
        <select
          name="city"
          defaultValue={city ?? ''}
          className="rounded-full border border-mint-200 px-4 py-2 text-sm bg-white"
        >
          <option value="">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>
              {c.charAt(0).toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="q"
          defaultValue={search ?? ''}
          placeholder="Search name or URL…"
          className="flex-1 min-w-[160px] rounded-full border border-mint-200 px-4 py-2 text-sm"
        />
        <button type="submit" className="btn-secondary text-sm px-4 py-2">
          Filter
        </button>
        {(city || search) && (
          <Link href={qs({ city: undefined, q: undefined, page: 1 })} className="text-xs text-evergreen/70 hover:underline">
            Clear
          </Link>
        )}
      </form>

      <p className="text-xs text-evergreen/60 mb-3">
        {total === 0 ? 'No restaurants match.' : `Showing ${from}–${to} of ${total}`}
      </p>

      <div className="card divide-y divide-mint-100">
        {rows.map((r) => (
          <Link
            key={r.id}
            href={`/admin/restaurants/${r.id}/review`}
            className="flex items-center justify-between gap-4 p-4 hover:bg-mint-50 transition-colors"
          >
            <div className="min-w-0">
              <p className="font-semibold text-evergreen truncate">
                {r.name ?? r.url}
                {r.guideCities.length > 0 && (
                  <span className="ml-2 text-xs font-medium text-lime bg-evergreen rounded-full px-2 py-0.5 align-middle">
                    ⭐ Guide · {r.guideCities.join(', ')}
                  </span>
                )}
              </p>
              <p className="text-xs text-evergreen/80 truncate">
                <span className="uppercase font-mono text-evergreen/50">{r.city}</span> · {r.url.replace(/^https?:\/\//, '')}
              </p>
              <p className="text-[11px] font-mono text-evergreen/40 truncate select-all" title={r.id}>
                ID {r.id}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <RestaurantBadges
                menusReviewed={r.menusReviewed}
                reviewedDishes={r.reviewedDishes}
                totalDishes={r.totalDishes}
                openFeedbackCount={r.openFeedbackCount}
              />
              <span className={`text-xs font-mono uppercase px-2 py-1 rounded-full ${statusClass(r.status)}`}>{r.status}</span>
            </div>
          </Link>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          {page > 1 ? (
            <Link href={qs({ page: page - 1 })} className="btn-ghost text-sm px-4 py-1.5">
              ← Previous
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs text-evergreen/60">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link href={qs({ page: page + 1 })} className="btn-ghost text-sm px-4 py-1.5">
              Next →
            </Link>
          ) : (
            <span />
          )}
        </div>
      )}
    </div>
  );
}
