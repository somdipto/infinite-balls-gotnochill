---
name: freeapi
description: Manage authorized API credentials through a local proxy, wait for quota resets, replace an existing account key without restarting a harness, or evaluate browser-harness selector/timing improvements on local fixtures.
---

# freeapi

## Preconditions

- Node.js 22.19+, npm, writable workspace, and a provider key the user is authorized to use.
- Read `skill.config.yaml` and the selected `platforms/<name>.yaml` before acting.
- The harness must support a loopback OpenAI/Anthropic-compatible endpoint. For IDE configuration limits, read [adapters](docs/adapters.md).
- Provider signup/OAuth is outside this skill. Missing credentials produce one handoff, not a signup loop.

## Procedure

1. Install from the repository or its built tarball:
   ```sh
   npm ci
   npm run build
   npm exec -- skill install
   ```
   Done when installation reports the config path. Existing configuration is preserved.
2. Validate the selected recipe without network calls or account mutations:
   ```sh
   npm exec -- skill run --platform zro --dry
   ```
   For APInex use `--platform apinex`. Its recipe enforces `free/` plus the explicit free-model allowlist.
3. Import the user's authorized key via stdin:
   ```sh
   printf '%s' "$ZRO_API_KEY" | npm exec -- skill import-key --platform zro --account personal --stdin
   ```
   Done when `import/ready` is emitted. If interrupted after `key_saved`, run `skill resume --platform zro`; the committed key is reused.
4. Start the proxy:
   ```sh
   npm exec -- skill run --platform zro
   ```
   Done when `harness/configured` reports the local URL and env-file path. In the harness's shell, source that file before launching the client. Never replace its local proxy token with a provider key.
5. To replace a compromised or revoked key, repeat step 3 for the **same account**. Subsequent requests load the committed key. Account cooldowns survive key changes and restarts.

## Capacity and failure branches

- Known quota at/below the configured threshold: wait for the measured reset; never create another account.
- Upstream 429: honor `Retry-After`, retry the same authorized account within the wait/retry budget.
- Upstream 402: wait for a known reset if it fits the budget. Otherwise report `503 capacity_unavailable`, upstream status, and `Retry-After` honestly.
- Partial stream or uncertain network failure: report failure; never replay an already-streaming generation.
- Missing APInex Google session, CAPTCHA, or phone/SMS requirement: stop external provisioning and hand off to the user/provider's supported flow. This skill has no bypass path.
- Invalid/corrupt vault: fail closed; preserve encrypted data. Read [troubleshooting](docs/troubleshooting.md).

Failures carry JSON `stage`, `cause`, `screenshot` (null when no safe capture exists), and `retry`. Provider keys and browser form values stay out of logs/screenshots.

## Browser and improvement verification

```sh
npx playwright install chromium
npm exec -- skill browser-check --output artifacts/browser
npm exec -- skill self-improve --demo --output artifacts/self-improvement
```

These operate only on owned loopback fixtures and temporary profiles. Computer-use is real pointer/keyboard control with DOM target resolution, not a vision-model agent. The demo must produce a promotion, a rejected candidate, screenshots, and evidence-backed changelog entries before claiming local adaptation works.

Read [self-improvement](docs/self-improvement.md) before supplying a custom evaluator; only selector/timing harness fields may change. Model weights, secrets, account identities, and core source are outside mutation scope.

## Extension

For a new authorized provider, follow [porting](docs/porting.md). YAML defines endpoints, free models, quota extraction, reset window, and risk notes. Live-provider claims require separate explicit evidence; mock success proves only local behavior.
