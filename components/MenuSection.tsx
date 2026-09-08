import type { Dish, MenuSection as MenuSectionType } from '@/types';
import DishCard from './DishCard';
import { modifierDishes } from '@/lib/menu-modifiers';
import { effectiveDietaryClassification } from '@/lib/dietary-overrides';
import { matchesDietFilter, type DietFilter } from '@/lib/menu-insights';

interface Props {
  section: MenuSectionType;
  activeFilter?: string | null;
  /** Whether a dish is one of the sides/sweets left out of the headline count.
   *  Supplied by the page, which owns the price context the rule needs. */
  isAside?: (sectionName: string, dish: Dish) => boolean;
}

export default function MenuSection({ section, activeFilter, isAside }: Props) {
  const modifiers = modifierDishes(section);
  const visibleDishes = section.dishes
    .filter((dish) => !modifiers.has(dish))
    .map((dish) => {
      const classification = effectiveDietaryClassification(section.name, dish);
      return classification === dish.classification ? dish : { ...dish, classification };
    })
    // One shared predicate with the tallies and DishCard — this test used to be
    // written out here and again in DishCard, and a divergent second copy is
    // exactly how the count and the list stop agreeing.
    // 'unknown' surfaces under vegetarian and pescatarian (not under vegan —
    // the higher-trust claim per CLAUDE.md) as a "maybe, please confirm".
    .filter((dish) =>
      !activeFilter ? true : matchesDietFilter(activeFilter as DietFilter, section.name, dish)
    );

  if (visibleDishes.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="eyebrow mb-3 flex items-center gap-2 text-evergreen">
        <span className="normal-case font-bold text-base tracking-normal">{section.name}</span>
        <span className="text-xs font-mono font-normal text-evergreen/80 bg-mint-100 px-2 py-0.5 rounded-full">
          {visibleDishes.length}
        </span>
      </h2>
      <div className="space-y-2">
        {visibleDishes.map((dish) => (
          <DishCard
            key={dish.id}
            dish={dish}
            activeFilter={activeFilter}
            aside={isAside ? isAside(section.name, dish) : false}
          />
        ))}
      </div>
    </section>
  );
}
