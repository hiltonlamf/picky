/**
 * DNS resolution for the SSRF guard, isolated in its own module for two
 * reasons that pull in opposite directions.
 *
 * 1. **The Edge bundle must not reference a Node builtin.** lib/url-guard is
 *    reachable from instrumentation.ts (via lib/scraper and lib/init-dublin),
 *    which Next compiles for Edge as well as Node, and Vercel refuses to deploy
 *    an Edge Function that *references* an unsupported module even when it
 *    never runs it. `import 'node:dns/promises'` fails that check, and so do
 *    the usual workarounds: `webpackIgnore` leaves the specifier in the output,
 *    and building the string at runtime gets folded back into a literal by the
 *    minifier. `process.getBuiltinModule` puts no specifier in the bundle at
 *    all.
 * 2. **Tests need a seam.** Because there is no import, `vi.mock` has nothing
 *    to intercept — the fixture suites that drive the retry ladder under fake
 *    timers would hang on real DNS. They mock this module instead.
 */
export async function dnsLookupAll(host: string): Promise<{ address: string }[]> {
  const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } })
    .process?.getBuiltinModule;
  if (typeof getBuiltin !== 'function') {
    throw new Error('DNS lookup is unavailable on this runtime');
  }
  const dns = getBuiltin('dns/promises') as {
    lookup: (h: string, o: { all: true }) => Promise<{ address: string }[]>;
  };
  return dns.lookup(host, { all: true });
}
