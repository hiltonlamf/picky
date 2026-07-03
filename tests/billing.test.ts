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

  it('does not flag ordinary extraction failures', () => {
    expect(isBillingError(new Error('AI returned invalid JSON. Please try again.'))).toBe(false);
    expect(isBillingError(new Error('fetch failed'))).toBe(false);
  });
});
