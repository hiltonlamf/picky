import type { RestaurantReviewInfo } from '@/lib/db';

/**
 * The at-a-glance review + feedback status shown next to each restaurant in the
 * admin lists: whether its menus have been signed off, how many of its dishes a
 * human has checked, and whether it has unresolved user feedback.
 */
export default function RestaurantBadges({
  menusReviewed,
  reviewedDishes,
  totalDishes,
  openFeedbackCount,
}: RestaurantReviewInfo) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      {openFeedbackCount > 0 && (
        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-sun-50 text-sun-800" title="Open user feedback">
          💬 {openFeedbackCount}
        </span>
      )}
      <span
        className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          menusReviewed ? 'bg-mint-100 text-picky-700' : 'bg-sun-50 text-sun-800'
        }`}
      >
        {menusReviewed ? 'Reviewed ✓' : 'Not reviewed'}
      </span>
      {totalDishes > 0 && (
        <span className="text-xs text-evergreen/70 px-2 py-0.5 rounded-full bg-mint-50" title="Dishes a human has checked">
          {reviewedDishes}/{totalDishes} dishes
        </span>
      )}
    </div>
  );
}
