import Link from 'next/link';
import AdminNav from '@/components/admin/AdminNav';
import RestaurantBadges from '@/components/admin/RestaurantBadges';
import { getAdminDashboardStats } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live (never a cached DB read after an edit)

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="card p-4">
      <p className="eyebrow mb-1">{label}</p>
      <p className="text-2xl font-bold text-evergreen">{value}</p>
    </div>
  );
}

function statusClass(status: string): string {
  if (status === 'error') return 'bg-sun-50 text-sun-800';
  if (status === 'done') return 'bg-mint-100 text-picky-700';
  return 'bg-mint-100 text-evergreen/80';
}

export default async function AdminHomePage() {
  const stats = await getAdminDashboardStats();

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav active="dashboard" />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-10">
        <StatTile label="Today's spend" value={`$${stats.todaySpendUsd.toFixed(4)}`} />
        <StatTile label="Error rate" value={stats.errorRatePct !== null ? `${stats.errorRatePct.toFixed(1)}%` : 'n/a'} />
        <StatTile label="Open feedback" value={String(stats.openFeedbackCount)} />
      </div>

      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h2 className="eyebrow">Recent restaurants</h2>
        <Link href="/admin/restaurants" className="text-xs text-picky-700 hover:underline">
          See all restaurants (incl. guide) →
        </Link>
      </div>
      <div className="card divide-y divide-mint-100">
        {stats.recentRestaurants.length === 0 && <p className="p-4 text-sm text-evergreen/80">No restaurants yet.</p>}
        {stats.recentRestaurants.map((r) => (
          <Link
            key={r.id}
            href={`/admin/restaurants/${r.id}/review`}
            className="flex items-center justify-between gap-4 p-4 hover:bg-mint-50 transition-colors"
          >
            <div className="min-w-0">
              <p className="font-semibold text-evergreen truncate">{r.name ?? r.url}</p>
              <p className="text-xs text-evergreen/80 truncate">{r.url}</p>
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
    </div>
  );
}
