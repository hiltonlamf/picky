import { describe, it, expect } from 'vitest';
import { isBillingError } from '@/lib/ai';

describe('isBillingError', () => {
  it('recognises Anthropic credit-exhaustion errors', () => {
    expect(
      isBillingError(new Error('400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API."}}'))
    ).toBe(true);
  });

  it('recognises invalid API key errors (misconfigured secret)', () => {
    expect(
      isBillingError(new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))
    ).toBe(true);
  });

  it('recognises the monthly usage-cap error (account switched off until reset)', () => {
    // Real message observed 2026-07-24. Must be treated as an account failure —
    // otherwise a capped account silently reports every restaurant as "no menu".
    expect(
      isBillingError(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC."}}'))
    ).toBe(true);
  });

  it('does not flag ordinary extraction failures', () => {
    expect(isBillingError(new Error('AI returned invalid JSON. Please try again.'))).toBe(false);
    expect(isBillingError(new Error('fetch failed'))).toBe(false);
  });
});
