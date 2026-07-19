import type { AIUsage } from '@/lib/ai';

export type DietaryClassification = 'vegan' | 'vegetarian' | 'neither' | 'unknown';

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface Dish {
  id: string;
  name: string;
  description?: string | null;
  price?: string | null;
  classification: DietaryClassification;
  confidence: number;
  confidenceReason?: string | null;
  reportCount: number;
  warningFlagged: boolean;
  sectionId?: string;
  /** Set by an admin correction/add/confirm — protects the row from being wiped on the next reparse. */
  humanVerified: boolean;
  /** Admin note; also carries the light "no longer matched the latest extraction" flag. */
  reviewerNotes?: string | null;
  /** Who created this dish row: the AI pipeline ('ai') or an admin by hand ('admin'). */
  origin: 'ai' | 'admin';
  /** What the AI originally classified this dish as, kept even after a human overwrites
   *  `classification` — so "AI said X → now Y" stays visible. null for admin-added dishes. */
  aiClassification?: DietaryClassification | null;
  /** Non-null once an admin has soft-deleted this dish. Excluded from everything users
   *  see; kept as an audit record and shown (struck-through, restorable) in admin review. */
  deletedAt?: string | null;
}

export interface MenuSection {
  id: string;
  name: string;
  displayOrder: number;
  dishes: Dish[];
  /** Which source menu this section came from (e.g. "Lunch"); null for single-menu restaurants. */
  menuLabel?: string | null;
}

export type RestaurantStatus = 'pending' | 'processing' | 'done' | 'error';

export interface Restaurant {
  id: string;
  url: string;
  canonicalUrl?: string | null;
  name?: string | null;
  city: string;
  lastScrapedAt?: string | null;
  menuUrl?: string | null;
  status: RestaurantStatus;
  errorMessage?: string | null;
  /** Set when an admin has approved this restaurant for public display despite a
   *  review flag (e.g. a tasting menu captured as a single "dish"). null = a
   *  flagged restaurant stays hidden from the public guide until reviewed. */
  guideApprovedAt?: string | null;
  sections: MenuSection[];
  createdAt: string;
}

export type MenuCandidateType = 'text' | 'pdf' | 'image' | 'subpage';

export interface MenuCandidate {
  id: string;
  label: string;
  /** One-line diner-facing description shown on the menu picker, e.g. "Mains, sharing plates & desserts". */
  description?: string;
  type: MenuCandidateType;
  ref: string; // URL for pdf/image/subpage; '' for inline text
  source: 'homepage' | 'subpage';
}

/**
 * Resumable analysis progress. Serverless functions have hard time caps
 * (60s on Vercel Hobby), so a long extraction is split across requests:
 * each request runs attempts until its budget nears, persists this state,
 * and the client immediately calls back to continue.
 */
export interface AnalysisState {
  /** Candidate ids not yet started. */
  queue: string[];
  /** Candidate currently mid-retry-chain, if any. */
  currentId?: string | null;
  /** Attempt index to resume from within the current candidate. */
  attemptIndex?: number;
  /** Best extraction so far for the current candidate. */
  bestSoFar?: { menu: ClassifiedMenu; usage: AIUsage } | null;
  /** Cost accumulated on the current candidate (incl. failed attempts). */
  candidateUsage?: AIUsage | null;
  /** Finished menus awaiting the final merge. */
  done: Array<{ label: string; menu: ClassifiedMenu }>;
  /** Cost accumulated across finished candidates. */
  usage?: AIUsage | null;
  /** Telemetry category of the analyzed selection (pdf/image/js/text/multi) —
   *  fixed when the analysis starts so resumed requests report it correctly. */
  category?: string;
}

/** Persisted between the discover and analyze phases (keyed by restaurantId). */
export interface DiscoveryPayload {
  candidates: MenuCandidate[];
  finalUrl: string;
  title?: string;
  inlineText?: string;
  screenshotUrl?: string;
  pdfUrls?: string[];
  imageUrls?: string[];
  analysis?: AnalysisState;
}

export type ParseEventType =
  | 'progress'
  | 'cached'
  | 'result'
  | 'error'
  | 'candidates'
  | 'continue';

export interface ParseProgressEvent {
  type: 'progress';
  step: string;
  stepNumber: number;
  totalSteps: number;
}

export interface ParseCachedEvent {
  type: 'cached';
  restaurantId: string;
}

export interface ParseResultEvent {
  type: 'result';
  restaurantId: string;
}

export interface ParseErrorEvent {
  type: 'error';
  error: string;
}

export interface ParseCandidatesEvent {
  type: 'candidates';
  restaurantId: string;
  candidates: MenuCandidate[];
}

/** Analysis ran out of serverless time budget — call analyze again to resume. */
export interface ParseContinueEvent {
  type: 'continue';
  restaurantId: string;
}

export type ParseEvent =
  | ParseProgressEvent
  | ParseCachedEvent
  | ParseResultEvent
  | ParseErrorEvent
  | ParseCandidatesEvent
  | ParseContinueEvent;

export interface RawDish {
  name: string;
  description?: string;
  price?: string;
  classification: DietaryClassification;
  confidence: number;
  reason: string;
}

export interface RawSection {
  name: string;
  dishes: RawDish[];
  /** Which source menu this section came from (e.g. "Lunch"); absent for single-menu results. */
  menuLabel?: string | null;
}

export interface ClassifiedMenu {
  restaurantName?: string;
  language?: string;
  sections: RawSection[];
}

export interface DietaryFilterConfig {
  label: string;
  emoji: string;
  color: string;
  badgeClass: string;
  markers: string[];
  excludedIngredients: string[];
}

export interface ReportIssueType {
  value: string;
  label: string;
}

// ============================================================
// Admin dashboard + eval infrastructure
// ============================================================

/** The durable golden set's anchor row — one per restaurant URL, auto-created
 *  the first time a dish or menu-candidate under that URL gets a human verdict. */
export interface EvalCase {
  id: string;
  url: string;
  name?: string | null;
  city?: string | null;
  /** Free text: real menus on the site the pipeline never found at all. */
  missedMenus?: string | null;
  notes?: string | null;
  /** Set when a human confirms this restaurant's menu discovery is correct (menu-level review). */
  menusReviewedAt?: string | null;
  createdAt: string;
}

export type MenuCandidateVerdict = 'correct' | 'spurious' | 'duplicate';

/** A human verdict on one AI-discovered menu candidate (or a menu-level
 *  add/remove action performed on the review screen). */
export interface EvalMenuCandidate {
  id: string;
  evalCaseId: string;
  label: string;
  verdict: MenuCandidateVerdict;
  notes?: string | null;
  createdAt: string;
}

export type EvalDishSource = 'admin_review' | 'feedback_confirmed';

/** One human-validated ground-truth dish, auto-grown from a confirm/correct
 *  action in the admin review screen or a confirmed feedback report. */
export interface EvalDish {
  id: string;
  evalCaseId: string;
  menuLabel?: string | null;
  sectionName?: string | null;
  name: string;
  expectedClassification: DietaryClassification;
  /** What the AI originally guessed at the moment of the human verdict, captured
   *  before the live dish was overwritten. null for legacy rows. Dish accuracy =
   *  % where this equals expectedClassification. */
  aiOriginalClassification?: DietaryClassification | null;
  source: EvalDishSource;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type FeedbackStatus = 'open' | 'confirmed' | 'dismissed';

/** A single user report about one dish, surfaced inline on the review screen
 *  (B7) so a reviewer can act on it where the dish lives, not just in the inbox. */
export interface DishReportSummary {
  id: string;
  dishId: string;
  issueType: string;
  notes?: string | null;
  status: FeedbackStatus;
  createdAt: string;
}

/** Unified view over dish_reports (always about one dish's label) and
 *  restaurant_feedback (general product feedback) for the admin inbox. */
export interface FeedbackItem {
  kind: 'dish_report' | 'restaurant_feedback';
  id: string;
  createdAt: string;
  status: FeedbackStatus;
  resolutionNotes?: string | null;
  resolvedAt?: string | null;
  notes?: string | null;
  /** issue_type for dish_report, feedback_type for restaurant_feedback. */
  issueOrFeedbackType: string;
  dishId?: string;
  dishName?: string;
  restaurantId?: string;
  restaurantName?: string | null;
}
