import type { DietaryClassification } from '@/types';

const CONFIG: Record<DietaryClassification, { label: string; className: string; emoji: string }> = {
  vegan: { label: 'Vegan', className: 'badge-vegan', emoji: '🥦' },
  vegetarian: { label: 'Vegetarian', className: 'badge-vegetarian', emoji: '🍳' },
  neither: { label: 'Not suitable', className: 'badge-neither', emoji: '✗' },
  unknown: { label: 'Check with restaurant', className: 'badge-unknown', emoji: '?' },
};

interface Props {
  classification: DietaryClassification;
  size?: 'sm' | 'md';
}

export default function DietaryBadge({ classification, size = 'md' }: Props) {
  const { label, className, emoji } = CONFIG[classification] ?? CONFIG.unknown;
  const sizeClass = size === 'sm' ? 'text-[11px] px-2 py-0.5' : '';

  return (
    <span className={`${className} ${sizeClass}`}>
      <span aria-hidden="true">{emoji}</span>
      {label}
    </span>
  );
}
