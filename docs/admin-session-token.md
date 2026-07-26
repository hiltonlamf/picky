# Admin session cookie: replace `sha256(ADMIN_PASSWORD)` with a signed, expiring token

**Status:** open · **Severity:** medium (not remotely exploitable) · **Found:** 2026-07-25, during `/security-review` on PR #21 · **Effort:** ~30 min plus a login test

---

## Do this in a separate PR — not in PR #21

Deliberately out of scope there, for three reasons:

1. **It is not remotely exploitable.** Nothing about it lets an outsider in. It is a "bad *if* disclosed, and un-revocable when it is" property — real, but a different urgency from an open door.
2. **PR #21 does not make it worse.** The one thing that did — the `/ingest` proxy forwarding the cookie to PostHog — was found in the same review and fixed there.
3. **The failure mode is locking yourself out of your own admin.** This touches the login route, the shared auth helper and middleware together, and it needs a real login test on a preview. That is a bad thing to bundle into a large analytics PR that is otherwise ready to merge.

**PR #21 can merge without this.**

---

## The problem

`lib/admin-auth.ts` derives the session cookie from the password:

```ts
export async function expectedAdminCookieValue(): Promise<string | null> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return null;
  return sha256Hex(password);          // <-- the cookie value IS this
}
```

`app/api/admin/login/route.ts:65-73` sets that hash as `picky_admin` (`httpOnly`, `sameSite: 'lax'`, `path: '/'`, 1-week `maxAge`), and `middleware.ts` authorises with a plain string comparison against it.

The comment in `admin-auth.ts` says the hash is used "so the plaintext never sits in the browser". That reasoning is sound as far as it goes — but it makes the cookie a *deterministic function of the password*, which creates three problems:

| Problem | Consequence |
|---|---|
| **Not revocable** | The value is identical for every session, forever. Logging out clears your browser's copy; it does not invalidate the token. The only way to revoke a leaked cookie is to change `ADMIN_PASSWORD` — which also changes it everywhere else it is used. |
| **A password oracle** | An unsalted, single-round SHA-256 of a human-chosen password is cheap to crack offline. Anyone who obtains the cookie likely recovers the password itself — and therefore anywhere it is reused. |
| **No real expiry** | `maxAge` is only a browser hint. A copied value keeps working indefinitely, because the server has no notion of when it was issued. |

Also worth fixing while in there: `login/route.ts:62` compares with `!==`, which is not constant-time. Low practical risk given the 8-attempts-per-15-min rate limit already in that file, but there is no reason not to make it constant-time.

**How it could be disclosed** (context, not a live exploit): any request that carries first-party cookies to somewhere you do not fully control. That is exactly what happened via the `/ingest` rewrite, now fixed with a header allowlist in `app/ingest/[...path]/route.ts` — worth reading before starting, because it explains why this matters more than it looks.

---

## Recommended solution: a stateless HMAC token

Yes, this is a genuine fix, not a mitigation — it removes the derivation from the password entirely.

Cookie value becomes `<expiresAtMs>.<hmacSHA256(expiresAtMs, ADMIN_SESSION_SECRET)>`.

**Why this shape for this app:**

- **No schema change and no per-request DB read.** Middleware runs on every admin request; a Supabase lookup there would add latency to every page and is awkward on the Edge runtime.
- **The cookie is no longer derived from the password**, so a leak exposes a session, not the password.
- **Expiry is enforced server-side**, so a copied cookie dies on its own.
- **Bulk revocation is rotating one env var** (`ADMIN_SESSION_SECRET`) — which, unlike rotating `ADMIN_PASSWORD`, has no other consequences.
- Uses only `crypto.subtle`, so the single Edge+Node implementation in `lib/admin-auth.ts` stays single.

**The honest limitation:** it cannot revoke *one* session while leaving others alive — rotating the secret logs out everything. For a one-admin app that is the right trade. If there is ever more than one admin, move to option B below.

### Sketch

```ts
// lib/admin-auth.ts
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function issueAdminSession(): Promise<string | null> {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) return null;                      // fail closed
  const expiresAt = String(Date.now() + TTL_MS);
  return `${expiresAt}.${await hmacHex(expiresAt, secret)}`;
}

/** Replaces expectedAdminCookieValue() — verifies rather than compares. */
export async function isValidAdminSession(cookie: string | undefined): Promise<boolean> {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || !cookie) return false;          // fail closed, as today
  const [expiresAt, sig] = cookie.split('.');
  if (!expiresAt || !sig) return false;
  if (!/^\d+$/.test(expiresAt) || Date.now() > Number(expiresAt)) return false;
  const expected = await hmacHex(expiresAt, secret);
  return timingSafeEqualHex(sig, expected);      // constant-time compare
}
```

### Steps

1. Add `ADMIN_SESSION_SECRET` to `.env.local` **and Vercel** (all environments) — 32+ random bytes, e.g. `openssl rand -hex 32`. Per CLAUDE.md, Vercel env values cannot be read back; confirm by behaviour after deploy.
2. Add `issueAdminSession` / `isValidAdminSession` (+ a constant-time hex compare) to `lib/admin-auth.ts`. Keep the fail-closed behaviour when the secret is missing — `middleware.ts` currently relies on `expectedAdminCookieValue()` returning `null` making `/admin` unreachable rather than open.
3. `login/route.ts`: set the cookie from `issueAdminSession()`; make the password check constant-time.
4. `middleware.ts`: swap the string comparison for `isValidAdminSession(cookie)`.
5. `app/[city]/page.tsx` also calls `expectedAdminCookieValue()` (for admin draft-guide preview) — update it too. **Grep for `expectedAdminCookieValue` before finishing; missing a caller fails open.**
6. Existing cookies stop validating, so everyone is logged out once. Fine — one admin.

### Verify before merging

- `/admin` while logged out → redirect to `/admin/login`; `/api/admin/*` → 401.
- Log in → admin works; the cookie is `<digits>.<hex>` and is **not** `sha256(ADMIN_PASSWORD)`.
- Tamper with one character of the signature → rejected.
- Set an expiry in the past by hand → rejected.
- Unset `ADMIN_SESSION_SECRET` → admin unreachable, **not** open.
- Log in on the Vercel preview specifically, before merging. The lockout risk is the reason this is its own PR.

---

## Option B, if there is ever more than one admin

Random opaque token, hash stored in an `admin_sessions` table (`token_hash`, `created_at`, `expires_at`, `revoked_at`). Gives true per-session revocation and an audit trail, at the cost of a migration and a DB read on every admin request. Not worth it for a single admin; the right answer the moment there are two.

---

## Related

- `app/ingest/[...path]/route.ts` — why the cookie's exposure surface mattered.
- `middleware.ts` — the sole admin guard; no `/admin` page or `/api/admin` route does its own check, which is why this cookie carries so much weight.
- Fixed in the same review: Next.js upgraded 14.2.16 → 14.2.35 for CVE-2025-29927 (a crafted `x-middleware-subrequest` header skipped middleware entirely — i.e. skipped *all* admin auth).
