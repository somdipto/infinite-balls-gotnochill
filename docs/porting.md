# Add an authorized platform in under ten minutes

This extends **existing-key proxy support**, not unattended account signup. No core edits are needed for an OpenAI-compatible provider with bearer authentication and an optional same-origin JSON quota probe.

1. Copy `platforms/zro.yaml` to `platforms/example.yaml`.
2. Set `name: example`, `authClass: existing-key`, the owner's signup/key-console URLs, and `apiBaseUrl` ending in `/v1`.
3. Replace `defaultModel` and `freeModelIds` with model IDs you verified on that account. Set `requiredModelPrefix` when the provider uses a free-tier namespace; remove any irrelevant `keyPrefix`.
4. Set `quotaProbe: null` unless you have an actual documented quota endpoint. Otherwise provide its same-origin `url`, `remainingPath`, and ISO-8601 `resetsAtPath`. Do not substitute `/models` or a billing guess.
5. Set the provider's UTC reset hour, optional `requestsPerMinute`, and risk notes. Live `resetsAt` overrides the fallback hour when measured.
6. Validate and import:
   ```sh
   skill run --platform example --dry
   printf '%s' "$EXAMPLE_API_KEY" | skill import-key --platform example --account personal --stdin
   skill run --platform example
   ```

Only HTTPS endpoints or loopback HTTP fixtures are accepted. Names contain lowercase alphanumerics/hyphens; path traversal and mismatched filenames are rejected. Free models are allowlisted on every POST before upstream traffic.

A non-OpenAI protocol or non-bearer authentication requires a real new adapter; YAML is not arbitrary code execution. A successful local fixture does not prove a live provider's signup or pricing claims. Keep those verification limits in `riskNotes`.
