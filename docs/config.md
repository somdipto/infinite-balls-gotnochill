# Configuration

`skill.config.yaml` is validated strictly: unknown fields and invalid ranges fail instead of silently being ignored. Relative workspace/platform paths are resolved against the config file's directory, not the process's launch directory.

- `workspace`: private runtime state directory; default `.freeapi`.
- `thresholdRemainingPercent`: known quota at/below this value waits until `resetsAt`; default 25. Waiting is intentional, not account replacement.
- `quotaPollMs`: probe interval; failures remain unknown, never 100% available.
- `proxy.host`: fixed to `127.0.0.1`; `proxy.port` defaults to 5101. Port 0 asks the OS for an available port, useful for fixtures; use the actual URL emitted at startup.
- `request.timeoutMs`: total request deadline, including queueing and upstream streaming.
- `request.maxWaitMs`: bounded account-capacity wait budget.
- `request.maxBodyBytes`: buffered JSON-body bound; `concurrency` and `maxQueuedRequests` bound active and waiting requests.
- `request.retryBudget`: retries only after an upstream 402/429 response before client headers are sent. Network failures and partial streams are not replayed.
- `browser`: the CLI browser check honors `headless`, `timeoutMs`, and `paceMs`; its configured driver runs first, then the other backend is checked too. Profiles remain isolated regardless of headless mode.
- `harness`: env export adapter/path; relative export path is resolved against the workspace.
- `rsi`: the demo honors `historyLimit` and `browser.headless`, and requires `maxMutations >= 2` for its fixed two-probe promotion/rejection proof. Custom `runCycle` evaluations enforce the hard maximum of five regardless of caller configuration; eval-specific selector/timings remain separate mutable harness fields.

## Recipes

`platforms/<name>.yaml` defines URLs, auth-class metadata, default/free models, optional model/key prefixes, optional quota extraction, reset hour, RPM, and risks. `authClass` documents how the owner obtains credentials; it does not trigger signup. HTTPS is required except on loopback fixture hosts. A quota probe must have the same origin as the upstream API so a recipe cannot redirect bearer credentials to a second host.

Zro's quota paths come from the supplied project specification. APInex has no supplied documented quota endpoint, so `quotaProbe: null` is honest: rate limits and 402/429 responses still apply. Model catalogs do not measure remaining tokens.

## Credentials and local authentication

Provider keys enter only via `import-key --stdin`. The encrypted vault retains one account per platform and one active key per account. Identical imports are idempotent; a changed key increments its generation. Account cooldown/RPM state is separate and survives key replacement.

The harness uses the random local token in `.freeapi/proxy.token`, never the provider key. OpenAI clients send it as a Bearer token; Anthropic clients may send it as `x-api-key`. The proxy strips caller credentials/cookies and injects the active provider Bearer key. `/health` requires the same local token.

`FREEAPI_VAULT_KEY` optionally supplies a base64-encoded 32-byte master key instead of the generated `vault/master.key`. Keep that variable stable across restarts. Losing either master-key source makes the encrypted credentials unrecoverable; the skill does not silently reset a corrupt vault.
