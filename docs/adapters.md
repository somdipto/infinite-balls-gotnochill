# Adapters

## Harness

Every harness adapter implements `get_usage`, `detect_limit`, `set_api_key`, and `reload` from `adapters/harness/types.ts`. `HarnessSettings.apiKey` is the **local proxy token**, not a provider secret. Unknown usage is `null`. Unsupported reloads return actionable errors, never successful no-ops.

### Environment

`EnvHarness({path})` writes a sourceable POSIX env file, atomically and privately. It exports `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, and the corresponding Anthropic base/token/key/model variables. Anthropic's base is the bare local origin; OpenAI's base includes `/v1`. Values are shell-quoted. Existing parent environments and already-running clients are unchanged.

### Config file

```sh
skill export --platform zro --format continue --path /explicit/path/config.yaml
```

Continue JSON and YAML are supported. The adapter merges one named model and preserves unrelated keys/models; YAML comments are preserved. Malformed structures and duplicate managed entries are rejected without overwriting the file. Select/import the generated model through Continue's supported interface.

Cline/Roo use editor credential storage; Cursor does not expose a supported file API for arbitrary provider settings. Their native files are left untouched, with an explicit unsupported error. An explicit `--env-launch /separate/path/proxy.env` exports env values instead, **not** an IDE provider configuration. Cursor server-side requests cannot reach a user's loopback proxy, and Cursor is not documented to consume this env file. Do not claim these clients are automatically configured.

### Zro CLI

`ZroCliHarness` requires an explicit working directory and isolated home. `get_usage()` invokes `zro status --json`; explicit `loginProvider(key,{userAuthorized:true})` invokes `zro login --api-key KEY` using literal argument boundaries, never a shell. Because that CLI requires a command argument, the explicit login may expose the key in local process listings; it is not called automatically by `skill run`. Command failures omit key-bearing output/argv. `set_api_key` configures only future adapter-child environments to use the local proxy.

## Browser

`createDriver('computer-use'|'playwright',options)` implements `goto`, `fill`, `click`, `read`, `screenshot`, and `close`. The computer-use backend locates a unique visible target, resolves its bounds, checks occlusion, then uses real mouse coordinates and keyboard typing. The fallback uses Playwright locator actions. Neither calls a vision model or adds stealth fingerprints.

Origins are explicit. An owned local egress proxy blocks cross-origin redirect hops as well as normal requests. This is an application-level origin boundary, **not an OS sandbox for hostile browser code**. WebSockets/popups fail closed. Profiles are temporary or explicitly owned/marked; unknown existing personal profiles are rejected. Screenshots are restricted to loopback fixtures and mask editable fields; page body text can still be sensitive, so use nonsecret fixtures only.

## Mail and signup

There are no disposable-mail or account-provisioning adapters in the shipped implementation. The earlier speculative/no-op implementations were removed rather than represented as working integrations. Provider account creation, OTPs, Google login, CAPTCHA, and phone/SMS steps use the provider's authorized user flow outside this skill. Key replacement never provisions another identity.
