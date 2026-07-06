import type { DietaryClassification } from '@/types';

// Emoji, not the SVG icon set, on purpose: at a glance across a long list of
// dishes, distinct shape+color (🌱 vs 🥚 vs 🥩 vs ❓) reads faster than four
// icons that are all "some shade of green".
const CONFIG: Record<DietaryClassification, { label: string; className: string; emoji: string }> = {
  vegan: { label: 'Vegan', className: 'badge-vegan', emoji: '🌱' },
  vegetarian: { label: 'Veggie', className: 'badge-vegetarian', emoji: '🥚' },
  neither: { label: 'Not for us', className: 'badge-neither', emoji: '🥩' },
  unknown: { label: 'Double-check this one', className: 'badge-unknown', emoji: '❓' },
};

interface Props {
  classification: DietaryClassification;
  size?: 'sm' | 'md';
}

export default function DietaryBadge({ classification, size = 'md' }: Props) {
  const { label, className, emoji } = CONFIG[classification] ?? CONFIG.unknown;
  const sizeClass = size === 'sm' ? 'text-[11px] px-2.5 py-0.5' : '';

  return (
    <span className={`${className} ${sizeClass}`}>
      <span aria-hidden="true">{emoji}</span>
      {label}
    </span>
  );
}
