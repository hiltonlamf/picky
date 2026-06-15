import { STALENESS_DAYS } from '@/lib/dietary-config';

interface Props {
  lastScrapedAt: string | null | undefined;
  restaurantId: string;
}

function getAgeInDays(dateString: string): number {
  return (Date.now() - new Date(dateString).getTime()) / (1000 * 60 * 60 * 24);
}

function formatAge(days: number): string {
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  if (days < 7) return `${Math.floor(days)} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? 's' : ''} ago`;
  return `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? 's' : ''} ago`;
}

export default function FreshnessIndicator({ lastScrapedAt, restaurantId }: Props) {
  if (!lastScrapedAt) return null;

  const days = getAgeInDays(lastScrapedAt);
  const isStale = days >= STALENESS_DAYS;
  const ageText = formatAge(days);

  if (isStale) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
        <span className="text-amber-500 text-lg mt-0.5" aria-hidden="true">⚠️</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-amber-800">
            Menu data is {ageText} — it may be out of date
          </p>
          <p className="text-xs text-amber-700 mt-0.5">
            Always confirm dishes and ingredients with the restaurant directly.
          </p>
        </div>
        <a
          href={`/restaurant/${restaurantId}?refresh=1`}
          className="flex-shrink-0 text-xs font-semibold text-amber-700 underline hover:no-underline"
        >
          Refresh
        </a>
      </div>
    );
  }

  return (
    <p className="text-xs text-gray-400 flex items-center gap-1">
      <span aria-hidden="true">✓</span>
      Menu checked {ageText}
    </p>
  );
}
