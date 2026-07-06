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
