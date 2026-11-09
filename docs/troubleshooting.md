# Troubleshooting

## Missing credential / unsupported signup

`precondition/authorized_key_required` is a one-shot handoff to the recipe's key-console URL. Obtain a key through your authorized account, then use `import-key --stdin`. The skill does not attempt disposable identities, Google account creation, phone/SMS, or CAPTCHA bypass.

## 503 capacity_unavailable

The account has no capacity within `request.maxWaitMs`, the RPM window is full, or the bounded queue is full. Read the response's `Retry-After`, `availableAt`, and optional `upstreamStatus`. Increase the wait budget if the client can wait; otherwise try after the reset. Do not create accounts or clear cooldown files to evade limits. A 402/429 is not converted into fabricated model output.

## Unknown quota

A missing probe or failed/unrecognized measurement is unknown, not a full allowance. APInex intentionally has no fabricated quota probe. Confirm provider-supported quota APIs before changing the YAML. Quota probe redirects are refused to avoid bearer-key leakage.

## Interrupted import

```sh
skill resume --platform zro
```

A committed `key_saved` checkpoint resumes env/config export. Reimporting the identical key is also idempotent. Process-crash locks become recoverable after their five-second stale window. Live operations retain their lock; wait for them rather than deleting lock directories. If a checkpoint no longer matches the vault generation, import the current authorized key again.

## Vault authentication failed

Preserve `credentials.enc`. Restore the original `master.key` or original `FREEAPI_VAULT_KEY` and check file integrity. There is no plaintext fallback and no silent fresh-vault reset. To recover a genuinely lost key, retrieve/revoke/reissue it through the provider, using a separate backed-up workspace if necessary.

## Client configuration did not change

Env files cannot change a running parent's environment. Source the reported file before launching an env-compatible client. Continue needs explicit config selection/reload. Cline/Roo/Cursor native secret stores are not edited by this tool; see `docs/adapters.md`. An env-launch export is not proof of IDE support.

## Browser launch/action failure

```sh
npx playwright install chromium
skill browser-check --output artifacts/browser
```

Linux may also need `npx playwright install --with-deps chromium`. Use the project's installed Playwright version. Unknown existing profiles, unallowlisted origins, blocked redirects, WebSockets, and popups fail closed. The action error deliberately excludes page snippets/typed values. Use only nonsecret loopback fixtures for screenshots.

## Self-improvement did not promote

Inspect the run's paired results and `decision.json`. Promotion requires strictly greater than 2% relative score gain **and** preservation of every successful case. A tie, a case regression, an invalid evaluator result, or an exhausted guardrail retains the prior harness. Three cumulative regressions hard-stop that persisted state. Model weights and provider credentials are never mutated.
