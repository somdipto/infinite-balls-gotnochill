# freeapi / harness-gardener

A local API proxy for **authorized, user-supplied keys**, with hot credential replacement, quota-aware waiting, real Chromium computer-use adapters, and a bounded [Harness²-inspired](https://github.com/google-research/harness2) self-improvement loop. The software and local fixtures are free; provider usage follows your account's actual pricing and limits. It does **not** create disposable accounts, automate Gmail signup, evade CAPTCHA or provider quotas, or guarantee unlimited free service.

## Install and run

Requires Node.js 22.19+ and npm. From a clone:

```sh
npm ci
npm run build
npm exec -- skill install
npm exec -- skill --help
```

Obtain a key through your authorized provider account. Import through stdin, not a command argument:

```sh
printf '%s' "$ZRO_API_KEY" | npm exec -- skill import-key --platform zro --account personal --stdin
npm exec -- skill run --platform zro
```

The proxy writes `.freeapi/harness.env` with a **local proxy token**, not the provider key. In another shell, source it before launching a compatible harness:

```sh
. .freeapi/harness.env
# launch your OpenAI-/Anthropic-compatible harness here
```

Importing a replacement key for the **same account** updates subsequent requests without restarting that harness or proxy. It does not remove account-level cooldowns. Finite capacity can still become unavailable: the proxy waits within a bounded budget, then returns an explicit `503 capacity_unavailable` and `Retry-After`, retaining the upstream status in the error metadata. It does not manufacture a successful response.

## Verify without live accounts

```sh
npx playwright install chromium
npm run ci
npm run browser-smoke
npm exec -- skill self-improve --demo --output artifacts/self-improvement
```

All verification uses loopback APIs, temporary homes/profiles, and synthetic credentials. The browser check exercises actual pointer/keyboard and Playwright interactions. The improvement demo probes fresh baseline/candidate executions, promotes a selector fix, rejects a non-improving timing change, and writes screenshots, telemetry, a diff, and score evidence. Neither demo creates external accounts or controls your personal browser.

[Verification record and browser evidence](docs/verification.md). `npm run package-smoke` also installs a real tarball without dev dependencies and exercises the installed CLI.

## Scope and support

- Zro and APInex YAML recipes use the endpoint/model details supplied with the project; **live signup, OAuth, quota claims, and provider API access have not been verified**.
- APInex requests are checked against both `free/` and an explicit model allowlist before any upstream request. `/v1/models` is not treated as a quota probe.
- AES-256-GCM vault; masked `credentials.md`; default local master key protected by file permissions. See the [threat model](docs/risk.md).
- Env export and Continue config-file support. Cline/Roo/Cursor adapters explicitly report unsupported direct credential stores; they do not invent settings or claim a running process's environment changed.
- Computer-use means deterministic browser pointer/keyboard control, **not a vision-model agent**. The local self-improvement loop is inspired by Harness², not a port of its model-backed benchmark system.

[Installation](docs/install.md) · [Configuration](docs/config.md) · [Adapters](docs/adapters.md) · [Troubleshooting](docs/troubleshooting.md) · [Port a platform](docs/porting.md) · [Assumptions](docs/assumptions.md) · [Risks](docs/risk.md) · [Self-improvement](docs/self-improvement.md)
