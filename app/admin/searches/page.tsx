import AdminNav from '@/components/admin/AdminNav';
import { getRecentSearches } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store'; // admin reads must always be live

const OUTCOME_STYLE: Record<string, string> = {
  menu: 'bg-mint-100 text-evergreen',
  thin: 'bg-amber-100 text-amber-900',
  no_menu: 'bg-slate-100 text-slate-700',
  error: 'bg-red-100 text-red-800',
};

function OutcomePill({ outcome }: { outcome: string | null }) {
  if (!outcome) return <span className="text-evergreen/40">—</span>;
  return (
    <span className={`font-mono text-xs px-1.5 py-0.5 rounded ${OUTCOME_STYLE[outcome] ?? 'bg-slate-100 text-slate-700'}`}>
      {outcome}
    </span>
  );
}

export default async function AdminSearchesPage() {
  const rows = await getRecentSearches(200);

  // Analyze rows are the ones with a real outcome; discover rows are the first
  // half of the same search, so counting both would double every total.
  const analyzed = rows.filter((r) => r.stage === 'analyze');
  const thin = analyzed.filter((r) => r.outcome === 'thin').length;
  const failed = analyzed.filter((r) => r.outcome === 'error' || r.outcome === 'no_menu').length;
  const succeeded = analyzed.filter((r) => r.outcome === 'menu').length;

  return (
    <div className="max-w-6xl mx-auto px-4 py-10">
      <AdminNav active="searches" />

      <div className="flex items-center justify-between mb-2 flex-wrap gap-3">
        <h1 className="text-xl font-bold text-evergreen">Searched restaurants</h1>
        <a href="/api/admin/searches/export" className="btn-secondary text-sm px-4 py-2">
          Download .csv
        </a>
      </div>
      <p className="text-sm text-evergreen/80 mb-6">
        Every URL a visitor searched and what they got back. Read from{' '}
        <span className="font-mono text-xs">parse_attempts</span>, which is <strong>not</strong> consent-gated — so
        unlike the PostHog dashboards this covers <strong>every</strong> search, not only visitors who accepted
        cookies. Rows are deleted after 180 days.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {[
          { label: 'Analyses shown', value: analyzed.length },
          { label: 'Got a menu', value: succeeded },
          { label: 'Thin (under 7 dishes)', value: thin, warn: thin > 0 },
          { label: 'Failed / no menu', value: failed, warn: failed > 0 },
        ].map((s) => (
          <div key={s.label} className="card p-4">
            <div className={`text-2xl font-bold ${s.warn ? 'text-amber-700' : 'text-evergreen'}`}>{s.value}</div>
            <div className="text-xs text-evergreen/70 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {thin > 0 && (
        <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3 mb-6">
          <strong>{thin} thin result{thin === 1 ? '' : 's'}.</strong> A menu with only a handful of dishes is a
          pipeline bug until proven otherwise — far more likely something broke than that a real restaurant publishes
          three dishes. Check the URLs below by hand.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-evergreen/60 border-b">
              <th className="py-2 pr-3">When</th>
              <th className="py-2 pr-3">URL</th>
              <th className="py-2 pr-3">Stage</th>
              <th className="py-2 pr-3">Outcome</th>
              <th className="py-2 pr-3">Dishes</th>
              <th className="py-2 pr-3">Type</th>
              <th className="py-2 pr-3">Took</th>
              <th className="py-2">Why it failed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.createdAt}-${i}`} className="border-b border-black/5 align-top">
                <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap text-evergreen/70">
                  {r.createdAt.slice(5, 16).replace('T', ' ')}
                </td>
                <td className="py-2 pr-3 max-w-[22rem] truncate">
                  {r.url ? (
                    <a href={r.url} target="_blank" rel="noopener noreferrer" className="underline hover:text-azalea-600">
                      {r.url.replace(/^https?:\/\/(www\.)?/, '')}
                    </a>
                  ) : (
                    <span className="text-evergreen/40">—</span>
                  )}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-evergreen/70">{r.stage}</td>
                <td className="py-2 pr-3"><OutcomePill outcome={r.outcome} /></td>
                <td className="py-2 pr-3 font-mono text-xs">{r.dishCount ?? '—'}</td>
                <td className="py-2 pr-3 font-mono text-xs text-evergreen/70">{r.category ?? '—'}</td>
                <td className="py-2 pr-3 font-mono text-xs text-evergreen/60">
                  {r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
                </td>
                <td className="py-2 text-xs text-evergreen/70 max-w-[18rem]">
                  {r.errorCode ? (
                    <>
                      <span className="font-mono">{r.errorCode}</span>
                      {r.errorMessage ? <span className="block text-evergreen/50">{r.errorMessage.slice(0, 90)}</span> : null}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <p className="text-sm text-evergreen/60 py-8">No searches recorded yet.</p>}
      </div>
    </div>
  );
}
