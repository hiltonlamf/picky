import { STALENESS_DAYS } from '@/lib/dietary-config';
import { AlertIcon, CheckIcon } from './icons';

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
      <div className="rounded-xl bg-sun-50 px-4 py-3 flex items-start gap-3">
        <AlertIcon className="w-4 h-4 text-sun-800 mt-0.5 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-sun-800">
            Menu data is {ageText} — it may be out of date
          </p>
          <p className="text-xs text-sun-800/80 mt-0.5">
            Always confirm dishes and ingredients with the restaurant directly.
          </p>
        </div>
        <a
          href={`/restaurant/${restaurantId}?refresh=1`}
          className="flex-shrink-0 text-xs font-semibold text-sun-800 underline hover:no-underline"
        >
          Refresh
        </a>
      </div>
    );
  }

  return (
    <p className="text-xs text-evergreen/40 flex items-center gap-1">
      <CheckIcon className="w-3 h-3" />
      Menu checked {ageText}
    </p>
  );
}
