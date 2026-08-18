## What changed

<!-- Briefly describe the user-visible outcome. -->

## Verification

- [ ] Tests, typecheck, lint, and relevant production build pass
- [ ] Database changes were dry-run, reviewed, and verified remotely
- [ ] No secrets or personal data were added to code, logs, or analytics

## Analytics and observability

- [ ] New or changed user-facing surfaces have an explicit funnel contract, or this is marked N/A
- [ ] Landing is measured by `$pageview` plus `$pathname`; no duplicate custom view event
- [ ] Success events fire exactly once from the authoritative layer
- [ ] Event names and properties are centralized, stable, and contain no PII
- [ ] PostHog consent behavior and Sentry error coverage were considered
- [ ] Analytics regression tests were added or updated

<!-- If any box is N/A, say why. Instrumentation ships with the feature, not as a follow-up. -->
