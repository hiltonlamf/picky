/**
 * Integration test for every admin status-change, run against the live database
 * on a THROWAWAY restaurant that is deleted at the end. Zero LLM cost (no
 * Anthropic calls — pure DB writes). Verifies each button's effect lands in the
 * database correctly and survives a reparse.
 *
 *   npx tsx scripts/test-admin-actions.ts   (or: npm run test:admin)
 *
 * Covers: confirm, edit-to-each-label (vegan/vegetarian/neither/unknown), add,
 * soft-delete, restore, reparse preservation, menu-candidate verdicts
 * (correct/duplicate/spurious upsert), missed-menus, menus-reviewed toggle, and
 * feedback resolve (confirm/dismiss) for both dish reports and general feedback.
 */
import './_preload-env';
import { createClient } from '@supabase/supabase-js';
import {
  saveClassifiedMenu,
  applyDishVerdict,
  fetchRestaurantWithDishes,
  saveMenuCandidateVerdict,
  getMenuCandidateVerdicts,
  saveMissedMenus,
  markMenusReviewed,
  getEvalCaseByUrl,
  reportDish,
  resolveFeedback,
  getRestaurantFeedback,
} from '../lib/db';
import type { ClassifiedMenu, DietaryClassification } from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const URL = 'https://__admin_actions_test__.example/menu';
const CITY = 'testcity';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? '✓' : '✗ FAIL'} — ${label}${!ok && detail ? ` (${detail})` : ''}`);
}

function menu(dishes: Array<{ name: string; classification: DietaryClassification }>): ClassifiedMenu {
  return {
    restaurantName: 'Admin Actions Test',
    sections: [
      {
        name: 'Mains',
        menuLabel: null,
        dishes: dishes.map((d) => ({ name: d.name, classification: d.classification, confidence: 0.6 })),
      },
    ],
  } as ClassifiedMenu;
}

const base = { restaurantUrl: URL, city: CITY, restaurantName: 'Admin Actions Test' };

async function findDish(id: string, name: string, includeDeleted = true) {
  const r = await fetchRestaurantWithDishes(id, { includeDeleted });
  return r!.sections.flatMap((s) => s.dishes).find((d) => d.name === name);
}

async function main() {
  await db.from('restaurants').delete().eq('url', URL);
  await db.from('eval_cases').delete().ilike('url', URL);

  const { data: rest, error } = await db.from('restaurants').insert({ url: URL, city: CITY, status: 'processing' }).select('id').single();
  if (error) throw new Error('create temp restaurant: ' + error.message);
  const id = rest.id as string;

  try {
    await saveClassifiedMenu(id, URL, null, menu([
      { name: 'Ambiguous Pasta', classification: 'unknown' },
      { name: 'Beef Ragu', classification: 'neither' },
      { name: 'Garden Salad', classification: 'vegetarian' },
    ]));
    const section = (await fetchRestaurantWithDishes(id, { includeDeleted: true }))!.sections[0];

    // --- CONFIRM (accept the AI's guess as-is) ---
    console.log('\n[Confirm]');
    let dish = await findDish(id, 'Garden Salad');
    await applyDishVerdict({ ...base, restaurantId: id, action: 'upsert', dishId: dish!.id, name: 'Garden Salad', classification: 'vegetarian', aiOriginalClassification: 'vegetarian', sectionName: 'Mains' });
    dish = await findDish(id, 'Garden Salad');
    check('confirm sets human_verified, keeps classification', dish!.humanVerified && dish!.classification === 'vegetarian');
    {
      const ec = await getEvalCaseByUrl(URL);
      const { data: ed } = await db.from('eval_dishes').select('expected_classification, ai_original_classification').eq('eval_case_id', ec!.id).ilike('name', 'Garden Salad').single();
      check('confirm records eval_dish (expected=ai_original=vegetarian → counts correct)', ed.expected_classification === 'vegetarian' && ed.ai_original_classification === 'vegetarian');
    }

    // --- EDIT to each label ---
    console.log('\n[Edit — cycle every label]');
    dish = await findDish(id, 'Ambiguous Pasta');
    const aiOriginal = dish!.classification; // 'unknown'
    for (const target of ['vegan', 'vegetarian', 'neither', 'unknown'] as DietaryClassification[]) {
      await applyDishVerdict({ ...base, restaurantId: id, action: 'upsert', dishId: dish!.id, name: 'Ambiguous Pasta', classification: target, aiOriginalClassification: dish!.classification, sectionName: 'Mains' });
      const after = await findDish(id, 'Ambiguous Pasta');
      check(`edit → ${target} persists on the live dish`, after!.classification === target && after!.humanVerified);
    }
    {
      const ec = await getEvalCaseByUrl(URL);
      const { data: ed } = await db.from('eval_dishes').select('ai_original_classification, expected_classification').eq('eval_case_id', ec!.id).ilike('name', 'Ambiguous Pasta').single();
      check('edit keeps AI original guess captured once (=unknown)', ed.ai_original_classification === aiOriginal);
    }
    // Edit with a reviewer note — the note must be stored and readable back.
    await applyDishVerdict({ ...base, restaurantId: id, action: 'upsert', dishId: dish!.id, name: 'Ambiguous Pasta', classification: 'vegetarian', aiOriginalClassification: dish!.classification, reviewerNotes: 'Ask about egg in the pasta', sectionName: 'Mains' });
    const withNote = await findDish(id, 'Ambiguous Pasta');
    check('edit stores the reviewer note on the dish', withNote!.reviewerNotes === 'Ask about egg in the pasta');

    // --- ADD a dish by hand ---
    console.log('\n[Add]');
    await applyDishVerdict({ ...base, restaurantId: id, action: 'upsert', sectionId: section.id, sectionName: 'Mains', name: 'Hand Added Dish', classification: 'vegan' });
    let added = await findDish(id, 'Hand Added Dish');
    check('added dish exists, origin=admin, human_verified', !!added && added!.origin === 'admin' && added!.humanVerified);

    // --- SOFT DELETE + hidden from public / kept in admin ---
    console.log('\n[Remove (soft delete)]');
    const ragu = await findDish(id, 'Beef Ragu');
    await applyDishVerdict({ ...base, restaurantId: id, action: 'delete', dishId: ragu!.id });
    const inPublic = (await fetchRestaurantWithDishes(id))!.sections.flatMap((s) => s.dishes).some((d) => d.name === 'Beef Ragu');
    const inAdmin = await findDish(id, 'Beef Ragu');
    check('removed dish hidden from public view', !inPublic);
    check('removed dish kept in admin view with deletedAt set', !!inAdmin?.deletedAt);

    // --- RESTORE ---
    console.log('\n[Restore]');
    await applyDishVerdict({ ...base, restaurantId: id, action: 'restore', dishId: ragu!.id });
    const backPublic = (await fetchRestaurantWithDishes(id))!.sections.flatMap((s) => s.dishes).some((d) => d.name === 'Beef Ragu');
    check('restore brings the dish back to public view', backPublic);
    // Re-remove so we can test that a removal survives a reparse.
    await applyDishVerdict({ ...base, restaurantId: id, action: 'delete', dishId: ragu!.id });

    // --- REPARSE preserves edits, adds, and removals ---
    console.log('\n[Reparse preservation]');
    await saveClassifiedMenu(id, URL, null, menu([
      { name: 'Ambiguous Pasta', classification: 'unknown' }, // AI still guesses unknown
      { name: 'Beef Ragu', classification: 'neither' }, // AI re-extracts the removed dish
      { name: 'Garden Salad', classification: 'vegetarian' },
    ]));
    const pastaAfter = await findDish(id, 'Ambiguous Pasta');
    const raguAfterPublic = (await fetchRestaurantWithDishes(id))!.sections.flatMap((s) => s.dishes).some((d) => d.name === 'Beef Ragu');
    const handAfter = await findDish(id, 'Hand Added Dish');
    check('reparse: human edit survived (Ambiguous Pasta still unknown+verified, not reset)', pastaAfter!.humanVerified);
    check('reparse: removed dish did NOT resurface for users', !raguAfterPublic);
    check('reparse: hand-added dish survived', !!handAfter && handAfter!.origin === 'admin');

    // --- MENU CANDIDATE verdicts (upsert: one row, latest wins) ---
    console.log('\n[Menu-candidate verdicts]');
    await saveMenuCandidateVerdict({ ...base, url: URL, label: 'Lunch', verdict: 'correct' });
    await saveMenuCandidateVerdict({ ...base, url: URL, label: 'Lunch', verdict: 'duplicate' });
    await saveMenuCandidateVerdict({ ...base, url: URL, label: 'Lunch', verdict: 'spurious' });
    const verdicts = await getMenuCandidateVerdicts(URL);
    const ec2 = await getEvalCaseByUrl(URL);
    const { count: verdictRows } = await db.from('eval_menu_candidates').select('*', { count: 'exact', head: true }).eq('eval_case_id', ec2!.id).ilike('label', 'Lunch');
    check('re-clicking a verdict upserts (one row, not three)', verdictRows === 1, `rows=${verdictRows}`);
    check('latest verdict wins (spurious)', verdicts['Lunch'] === 'spurious');

    // --- MISSED MENUS + MENUS REVIEWED toggle ---
    console.log('\n[Missed menus + menus-reviewed]');
    await saveMissedMenus({ ...base, url: URL, missedMenus: 'There is a brunch menu we never found' });
    await markMenusReviewed({ ...base, url: URL, reviewed: true });
    let ecCase = await getEvalCaseByUrl(URL);
    check('missed-menus saved', ecCase!.missedMenus === 'There is a brunch menu we never found');
    check('menus-reviewed sets menusReviewedAt', !!ecCase!.menusReviewedAt);
    await markMenusReviewed({ ...base, url: URL, reviewed: false });
    ecCase = await getEvalCaseByUrl(URL);
    check('un-review clears menusReviewedAt', !ecCase!.menusReviewedAt);

    // --- FEEDBACK resolve (dish report + general) ---
    console.log('\n[Feedback resolve]');
    const salad = await findDish(id, 'Garden Salad');
    await reportDish(salad!.id, 'wrong_label', 'should be vegan', 'testhash');
    const { data: reportRow } = await db.from('dish_reports').select('id, status').eq('dish_id', salad!.id).single();
    check('dish report created with status=open', reportRow.status === 'open');
    await resolveFeedback('dish_report', reportRow.id, 'confirmed', 'fixed it');
    const { data: reportResolved } = await db.from('dish_reports').select('status, resolution_notes').eq('id', reportRow.id).single();
    check('dish report → confirmed with note', reportResolved.status === 'confirmed' && reportResolved.resolution_notes === 'fixed it');

    const { data: fb } = await db.from('restaurant_feedback').insert({ restaurant_id: id, restaurant_name: 'Admin Actions Test', feedback_type: 'missing_dish', notes: 'menu incomplete', ip_hash: 'testhash' }).select('id').single();
    await resolveFeedback('restaurant_feedback', fb.id, 'dismissed', 'not an issue');
    const { data: fbResolved } = await db.from('restaurant_feedback').select('status').eq('id', fb.id).single();
    check('general feedback → dismissed', fbResolved.status === 'dismissed');

    const feedbackForRestaurant = await getRestaurantFeedback(id);
    check('getRestaurantFeedback returns the dish report + general feedback', feedbackForRestaurant.dishReports.length === 1 && feedbackForRestaurant.restaurantFeedback.length === 1);
  } finally {
    await db.from('restaurants').delete().eq('id', id);
    await db.from('eval_cases').delete().ilike('url', URL);
    console.log('\ncleaned up throwaway restaurant + eval data.');
  }

  console.log(`\n================ ${fail === 0 ? 'ALL PASS ✓' : 'FAILURES'} — ${pass} passed, ${fail} failed ================`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST RUN FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
