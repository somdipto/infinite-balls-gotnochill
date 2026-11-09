# Risk model

## Provider authorization and capacity

Use accounts/keys you own or are authorized to administer, under the provider's terms. The skill does not assert that disposable-mail signup is legitimate for any particular provider. It excludes account farming, free-trial recycling, Gmail creation, CAPTCHA evasion, residential-proxy disguises, and identity rotation to defeat daily budgets or RPM limits.

Free service cannot be guaranteed: providers can change prices, model IDs, verification, availability, and quotas. Both supplied recipes are user-specified integrations, not live-provider certifications. If a provider adds SMS, CAPTCHA, or new OAuth consent, use its supported user flow. Never make a loop that burns identities.

A key swap is credential maintenance within one account, not new quota. Account cooldown and rolling RPM state are separate from the credential generation and persist across swaps/restarts. Retry exhaustion returns an honest capacity error, not fake model output.

## Vault

AES-256-GCM authenticates encrypted credential data with a fresh 96-bit nonce per write. `credentials.md` contains first/last-four redaction, account labels, generation, and timestamp; it is metadata, not a plaintext backup. The default master key is a local 0600 file. This protects against accidentally sharing the encrypted file alone, **not** an attacker who can read the whole workspace or the user's process memory.

For stronger separation, supply `FREEAPI_VAULT_KEY` from an external secret manager and restrict its process environment. The project does not claim OS-keychain integration or protection from a compromised local user/root. Provider keys in explicit `zro login --api-key` arguments may be visible to process-inspection tools; that operation is opt-in and never automatic.

## Local proxy

Bind only to 127.0.0.1; local requests require an independent random token. Keep that token private. Caller auth/cookies are stripped before provider auth is injected. Providers and quota probes must use HTTPS (except loopback fixtures), quota probes share the API origin, and upstream redirects are refused. The configured recipe is trusted routing configuration: review it before importing a key.

Bodies/queues/concurrency are bounded; streaming responses use backpressure. A partial stream or ambiguous network failure is never automatically replayed. Capacity retries occur only before client response headers, against the same account, within fixed budgets. The proxy is not a public multi-tenant gateway.

## Browser and self-improvement

Browser drivers own their contexts/profiles and do not discover/reuse personal Google sessions. A loopback egress proxy enforces origin restrictions including redirect hops; this is **not** a hardened OS sandbox for hostile content/native extensions. WebSockets and unexpected popups are unsupported and fail closed. Screenshots mask editable elements, not arbitrary secrets echoed in page text. Only use nonsecret fixture pages for evidence.

RSI evaluators are trusted executable code, not a security sandbox. The supplied evaluator uses only loopback fixture pages and synthetic data. Keep secrets, provider accounts, model configuration, core source, and live harness config out of custom evaluations. Only the local `rsi/harness.json` selector/timing fields are eligible for adoption. Guardrails are persisted; manually resetting that state invalidates prior safety history.

## Git hygiene

`.freeapi/`, `artifacts/`, `.env*`, encrypted credentials, and master-key files are excluded. Never embed GitHub tokens in remote URLs or publish browser profiles. If a credential-bearing remote URL is printed or shared, rotate that credential and use the Git credential helper instead. The target repository here uses a clean HTTPS remote and existing authenticated credential-helper access.
