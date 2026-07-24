/**
 * Display formatting for menu prices.
 *
 * Menus very often list bare numbers ("4", "14.50") because the currency is
 * obvious in the room but not on the page. Rendered alone next to a dish name
 * that reads as a stray number, not a price. So: keep whatever currency the
 * menu itself states (a Tokyo menu must not be relabelled in euro), and only
 * when there is none, assume euro — most restaurants and most of our users are
 * in Europe, and Dublin is the launch city.
 */

// Symbols and ISO codes we treat as "the menu already said which currency".
// Codes are matched as whole words so a dish note like "SEK" isn't confused
// with ordinary text.
const CURRENCY_SYMBOL = /[€£$¥₩₪₫₱₴₹₺₽¢]/;
const CURRENCY_CODE =
  /\b(EUR|USD|GBP|JPY|CNY|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|BGN|ISK|TRY|AUD|CAD|NZD|HKD|SGD|INR|KRW|THB|ZAR|AED|ILS|MXN|BRL|RUB|UAH)\b/i;
// Written-out currency words that appear on European menus.
const CURRENCY_WORD = /\b(euros?|pounds?|dollars?|kr|zł|kč|Ft|lei|lv|p\.?p\.?)\b/i;

/** Any number, with an optional decimal part using either separator. */
const NUMBER = /\d+(?:[.,]\d{1,2})?/g;

/**
 * Format a raw menu price for display.
 *
 * - "4"           → "€4"
 * - "14.50"       → "€14.50"
 * - "12 / 18"     → "€12 / €18"   (each price in a range gets the symbol)
 * - "€7.50"       → "€7.50"       (untouched — the menu already said so)
 * - "£12", "12 USD", "1200 JPY" → untouched
 * - "market price", "" , null    → null (nothing sensible to show)
 */
export function formatPrice(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const price = raw.trim();
  if (!price) return null;

  // No digits at all ("market price", "seasonal") — not a price we can mark up.
  if (!/\d/.test(price)) return null;

  // The menu already states a currency: leave it exactly as written.
  if (CURRENCY_SYMBOL.test(price) || CURRENCY_CODE.test(price) || CURRENCY_WORD.test(price)) {
    return price;
  }

  // Bare number(s): assume euro. Prefix each number so ranges stay readable.
  return price.replace(NUMBER, (n) => `€${n}`);
}
