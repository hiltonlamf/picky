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
  type: MenuCandidateType;
  ref: string; // URL for pdf/image/subpage; '' for inline text
  source: 'homepage' | 'subpage';
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
}

export type ParseEventType =
  | 'progress'
  | 'cached'
  | 'result'
  | 'error'
  | 'candidates';

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

export type ParseEvent =
  | ParseProgressEvent
  | ParseCachedEvent
  | ParseResultEvent
  | ParseErrorEvent
  | ParseCandidatesEvent;

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
