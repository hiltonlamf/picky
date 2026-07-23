import Link from 'next/link';
import AdminNav from '@/components/admin/AdminNav';
import { getCityGuides } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live

export default async function AdminGuidesPage() {
  const guides = await getCityGuides();

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <AdminNav active="guides" />

      <div className="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-evergreen">City guides</h1>
          <p className="text-sm text-evergreen/80 max-w-xl">
            Build a new city guide from a list of restaurant websites, review each one, preview it,
            then publish it live. You can also add more restaurants to an existing guide.
          </p>
        </div>
        <Link href="/admin/guides/new" className="btn-primary text-sm whitespace-nowrap">
          + New guide
        </Link>
      </div>

      {guides.length === 0 ? (
        <div className="card p-6 text-center text-evergreen/70">
          No guides yet. Create your first one.
        </div>
      ) : (
        <div className="card divide-y divide-mint-100">
          {guides.map((g) => (
            <Link
              key={g.slug}
              href={`/admin/guides/${g.slug}`}
              className="flex items-center justify-between gap-4 p-4 hover:bg-mint-50 transition-colors"
            >
              <div className="min-w-0">
                <p className="font-semibold text-evergreen truncate">
                  {g.displayName}
                  {g.country && <span className="text-evergreen/50 font-normal"> · {g.country}</span>}
                </p>
                <p className="text-xs text-evergreen/70">
                  <span className="text-picky-700 font-medium">{g.visible} live</span>
                  {g.needsAttention > 0 && (
                    <span className="text-sun-800 font-medium"> · {g.needsAttention} need attention</span>
                  )}
                  <span className="text-evergreen/50"> · {g.total} total</span>
                </p>
              </div>
              <span
                className={`text-xs font-mono uppercase px-2 py-1 rounded-full flex-shrink-0 ${
                  g.status === 'published' ? 'bg-mint-100 text-picky-700' : 'bg-sun-50 text-sun-800'
                }`}
              >
                {g.status === 'published' ? 'Live' : 'Draft'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
