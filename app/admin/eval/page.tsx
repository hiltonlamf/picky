import Link from 'next/link';
import AdminNav from '@/components/admin/AdminNav';
import RestaurantBadges from '@/components/admin/RestaurantBadges';
import { getEvalDashboardStats } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live (never a cached DB read after an edit)

function StatTile({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className="card p-4">
      <p className="eyebrow mb-1">{label}</p>
      <p className={`text-2xl font-bold ${warn ? 'text-sun-800' : 'text-evergreen'}`}>{value}</p>
      {sub && <p className="text-xs text-evergreen/80 mt-1">{sub}</p>}
    </div>
  );
}

function pct(n: number | null): string {
  return n !== null ? `${n.toFixed(0)}%` : 'n/a';
}

export default async function AdminEvalPage() {
  const stats = await getEvalDashboardStats();

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav active="eval" />

      <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
        <h1 className="text-xl font-bold text-evergreen">Evaluation Dashboard</h1>
        <a href="/api/admin/eval/export" className="btn-secondary text-sm px-4 py-2">
          Export CSV
        </a>
      </div>
      <p className="text-sm text-evergreen/80 mb-8">
        How well the app is doing, in priority order — getting the menus right matters most, classification least (a
        human confirms those). All numbers are free DB reads, no AI cost.{' '}
        <Link href="/admin/guide" className="text-picky-700 hover:underline">
          How to review →
        </Link>
      </p>

      {/* Needs review — featured restaurants the public ISN'T seeing. */}
      <div className={`card p-4 mb-8 ${stats.withheldFeatured.length > 0 ? 'border-l-4 border-l-sun-500' : ''}`}>
        <h2 className="eyebrow mb-2">⚠ Needs review — in a guide but hidden from the public</h2>
        <p className="text-sm text-evergreen/90 mb-3">
          <span className="font-bold text-evergreen">{stats.withheldFeatured.length}</span> featured restaurant(s) are being
          withheld from the public guide because they look odd (too few dishes, or a tasting/dim-sum menu captured as a
          single &ldquo;dish&rdquo;). Open one to fix its menu, <em>Approve for public</em> if it&rsquo;s actually fine, or
          delete it. Restaurants with at least {stats.minGuideDishes} dishes and no odd menus appear automatically.
        </p>
        {stats.withheldFeatured.length === 0 ? (
          <p className="text-xs text-evergreen/70">None — every featured restaurant is clean and visible. 🎉</p>
        ) : (
          <div className="divide-y divide-mint-100">
            {stats.withheldFeatured.map((r) => (
              <Link
                key={r.id}
                href={`/admin/restaurants/${r.id}/review`}
                className="flex items-start justify-between gap-3 py-2 hover:bg-mint-50 transition-colors"
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium text-evergreen truncate block">
                    {r.name ?? r.url}
                    <span className="ml-2 text-[10px] font-medium text-lime bg-evergreen rounded-full px-2 py-0.5 align-middle">
                      ⭐ {r.cities.join(', ')}
                    </span>
                  </span>
                  <span className="text-xs text-sun-800 block">{r.reasons.join(' · ')}</span>
                </span>
                <span className="text-xs font-mono px-2 py-1 rounded-full bg-sun-50 text-sun-800 flex-shrink-0">
                  {r.dishCount} dish{r.dishCount === 1 ? '' : 'es'}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ① Menus — the top priority: the right menus, no more, no fewer. */}
      <h2 className="eyebrow mb-3">① Menus — are we finding the right menus?</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
        <StatTile
          label="Restaurants reviewed"
          value={`${stats.restaurantsMenuReviewed}`}
          sub={`of ${stats.restaurantsTotal} total — menus signed off`}
        />
        <StatTile
          label="Discovery accuracy"
          value={pct(stats.discoveryAccuracyPct)}
          sub="of reviewed restaurants, menus were clean"
        />
        <StatTile
          label="Discovery problems"
          value={`${stats.discoveryProblemCount}`}
          sub="reviewed but had a wrong/missing/dup menu"
          warn={stats.discoveryProblemCount > 0}
        />
      </div>

      {/* ② Fetch health — did we manage to read the site at all? */}
      <h2 className="eyebrow mb-3">② Fetch health — restaurants that failed or came back empty</h2>
      <div className="card p-4 mb-8">
        <p className="text-sm text-evergreen/90 mb-2">
          <span className="font-bold text-evergreen">{stats.fetchFailures.length}</span> restaurant(s) errored or returned
          zero dishes. Open one and use <em>Add a menu URL or file</em> to give the AI the menu directly.
        </p>
        {stats.fetchFailures.length === 0 ? (
          <p className="text-xs text-evergreen/70">None — every restaurant returned at least one dish. 🎉</p>
        ) : (
          <div className="divide-y divide-mint-100">
            {stats.fetchFailures.slice(0, 15).map((r) => (
              <Link
                key={r.id}
                href={`/admin/restaurants/${r.id}/review`}
                className="flex items-center justify-between gap-3 py-2 hover:bg-mint-50 transition-colors"
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium text-evergreen truncate block">{r.name ?? r.url}</span>
                  <span className="text-xs text-evergreen/70 truncate block">{r.url}</span>
                </span>
                <span className="text-xs font-mono uppercase px-2 py-1 rounded-full bg-sun-50 text-sun-800 flex-shrink-0">
                  {r.status === 'error' ? 'error' : '0 dishes'}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ③ Dishes found — suspiciously thin menus (the "2 dishes / tasting menu as one dish" tell). */}
      <h2 className="eyebrow mb-3">③ Dishes found — suspiciously thin menus</h2>
      <div className="card p-4 mb-8">
        <p className="text-sm text-evergreen/90 mb-2">
          <span className="font-bold text-evergreen">{stats.lowDishRestaurants.length}</span> restaurant(s) came back with
          fewer than {stats.lowDishThreshold} dishes — often a sign the menu wasn&rsquo;t really read (e.g. a tasting menu
          captured as a single &ldquo;dish&rdquo;). Worth a look.
        </p>
        {stats.lowDishRestaurants.length === 0 ? (
          <p className="text-xs text-evergreen/70">None below the threshold.</p>
        ) : (
          <div className="divide-y divide-mint-100">
            {stats.lowDishRestaurants.slice(0, 15).map((r) => (
              <Link
                key={r.id}
                href={`/admin/restaurants/${r.id}/review`}
                className="flex items-center justify-between gap-3 py-2 hover:bg-mint-50 transition-colors"
              >
                <span className="min-w-0">
                  <span className="text-sm font-medium text-evergreen truncate block">{r.name ?? r.url}</span>
                  <span className="text-xs text-evergreen/70 truncate block">{r.url}</span>
                </span>
                <span className="text-xs font-mono px-2 py-1 rounded-full bg-sun-50 text-sun-800 flex-shrink-0">
                  {r.dishCount} dish{r.dishCount === 1 ? '' : 'es'}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ④ Classification — lowest priority; a human confirms these anyway. */}
      <h2 className="eyebrow mb-3">④ Classification — least critical (a human confirms these)</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-10">
        <StatTile
          label="Dishes reviewed"
          value={`${stats.dishesReviewed}`}
          sub={`of ${stats.dishesTotal} live dishes checked by a human`}
        />
        <StatTile
          label="Dish accuracy"
          value={pct(stats.dishAccuracyPct)}
          sub={stats.dishAccuracyN > 0 ? `AI right on ${stats.dishAccuracyN} reviewed dishes` : 'no reviewed dishes yet'}
        />
        <StatTile
          label="Unsafe mislabels"
          value={`${stats.unsafeCount}`}
          sub="AI called a non-veg dish vegan/veggie"
          warn={stats.unsafeCount > 0}
        />
      </div>

      {/* Restaurant list with review + feedback status. */}
      <h2 className="eyebrow mb-3">Restaurants</h2>
      <div className="card divide-y divide-mint-100">
        {stats.restaurants.length === 0 && <p className="p-4 text-sm text-evergreen/80">No restaurants yet.</p>}
        {stats.restaurants.map((r) => (
          <Link
            key={r.id}
            href={`/admin/restaurants/${r.id}/review`}
            className="flex items-center justify-between gap-4 p-4 hover:bg-mint-50 transition-colors"
          >
            <div className="min-w-0">
              <p className="font-semibold text-evergreen truncate">{r.name ?? r.url}</p>
              <p className="text-xs text-evergreen/80 truncate">{r.url}</p>
            </div>
            <RestaurantBadges
              menusReviewed={r.menusReviewed}
              reviewedDishes={r.reviewedDishes}
              totalDishes={r.totalDishes}
              openFeedbackCount={r.openFeedbackCount}
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
