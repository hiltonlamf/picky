import type { DietaryClassification } from '@/types';

// Emoji, not the SVG icon set, on purpose: at a glance across a long list of
// dishes, distinct shape+color (🌱 vs 🍳 vs 🥩 vs ❓) reads faster than four
// icons that are all "some shade of green".
const CONFIG: Record<DietaryClassification, { label: string; className: string; emoji: string }> = {
  vegan: { label: 'Vegan', className: 'badge-vegan', emoji: '🌱' },
  vegetarian: { label: 'Veggie', className: 'badge-vegetarian', emoji: '🍳' },
  neither: { label: 'Not vegetarian', className: 'badge-neither', emoji: '🥩' },
  unknown: { label: 'Double-check this one', className: 'badge-unknown', emoji: '❓' },
};

// Fish gets its own badge rather than sharing "🥩 Not vegetarian" with steak.
// Two reasons: inside the Pescatarian tab a plate of mussels labelled "not
// vegetarian" reads as a bug, and a pescatarian scanning the full menu needs to
// spot their options as fast as a vegetarian spots theirs. Ocean, not green —
// green means plants here, without exception (CLAUDE.md).
const SEAFOOD_CONFIG = { label: 'Fish & seafood', className: 'badge-pescatarian', emoji: '🐟' };

interface Props {
  classification: DietaryClassification;
  /** Non-veg because it is fish/shellfish, rather than meat. */
  seafood?: boolean;
  size?: 'sm' | 'md';
}

export default function DietaryBadge({ classification, seafood = false, size = 'md' }: Props) {
  const { label, className, emoji } =
    seafood && classification === 'neither'
      ? SEAFOOD_CONFIG
      : CONFIG[classification] ?? CONFIG.unknown;
  const sizeClass = size === 'sm' ? 'text-[11px] px-2.5 py-0.5' : '';

  return (
    <span className={`${className} ${sizeClass}`}>
      <span aria-hidden="true">{emoji}</span>
      {label}
    </span>
  );
}
