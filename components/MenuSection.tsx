import type { MenuSection as MenuSectionType } from '@/types';
import DishCard from './DishCard';

interface Props {
  section: MenuSectionType;
  activeFilter?: string | null;
}

export default function MenuSection({ section, activeFilter }: Props) {
  const visibleDishes = section.dishes.filter((dish) => {
    if (!activeFilter || activeFilter === 'all') return true;
    if (activeFilter === 'vegan') return dish.classification === 'vegan';
    if (activeFilter === 'vegetarian')
      return dish.classification === 'vegan' || dish.classification === 'vegetarian';
    return true;
  });

  if (visibleDishes.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="text-base font-bold text-gray-800 mb-3 flex items-center gap-2">
        <span>{section.name}</span>
        <span className="text-xs font-normal text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
          {visibleDishes.length}
        </span>
      </h2>
      <div className="space-y-2">
        {visibleDishes.map((dish) => (
          <DishCard key={dish.id} dish={dish} activeFilter={activeFilter} />
        ))}
      </div>
    </section>
  );
}
