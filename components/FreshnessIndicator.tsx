'use client';

interface Props {
  lastScrapedAt: string | null | undefined;
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

export default function FreshnessIndicator({ lastScrapedAt }: Props) {
  if (!lastScrapedAt) return null;

  const days = getAgeInDays(lastScrapedAt);
  const ageText = formatAge(days);

  return (
    <p className="text-xs text-evergreen/55">
      Menu scraped {ageText}
    </p>
  );
}
