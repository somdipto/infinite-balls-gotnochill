# Installation

Requirements: Node.js 22.19+, npm, writable local disk. Real browser checks also require the Chromium version installed by this project's Playwright dependency. No cloud/model subscription is required for the local fixtures.

## Clone

```sh
git clone https://github.com/somdipto/infinite-balls-gotnochill.git
cd infinite-balls-gotnochill
npm ci
npm run build
npm exec -- skill install
```

To install the CLI globally from this clone:

```sh
npm install -g .
skill --help
```

A published npm package is **not** assumed. `npm pack` creates an installable tarball; `npm install -g /path/to/infinite-balls-gotnochill-0.1.0.tgz` installs its built CLI.

## Workspace

`skill install --dir /path/to/workspace` copies missing config/recipes and initializes that workspace's vault and local proxy token. It preserves existing files. Run subsequent commands in that directory or pass `--config /path/to/workspace/skill.config.yaml`.

The default private state is `.freeapi/`: `vault/credentials.enc`, `vault/master.key`, masked `vault/credentials.md`, `proxy.token`, `proxy.json`, `harness.env`, `checkpoints/`, `proxy/`, and `runs/events.jsonl`. Keep it out of Git and backups that lack encryption. All generated secret files are mode 0600; directories are created as 0700. Windows uses filesystem ACLs, not POSIX mode guarantees.

## Credentials

Create/retrieve a key from your authorized provider account using the provider's supported UI. For APInex, use your existing personal Google account; the skill does not create Gmail accounts or reuse/control your personal Chrome profile.

```sh
printf '%s' "$ZRO_API_KEY" | skill import-key --platform zro --account personal --stdin
skill run --platform zro
```

APInex uses the same commands with `--platform apinex` and your APInex key. Its model must pass the recipe's `free/` and explicit free-model checks.

Source the reported env file in a second shell, then launch your compatible harness. This initial client setup is explicit; a child process cannot change its parent's environment. Once configured, replacing the same account's key requires neither a harness nor proxy restart.

## Isolated verification

```sh
npx playwright install chromium
npm run ci
npm run browser-smoke
```

CI on Linux installs browser system libraries with `npx playwright install --with-deps chromium`. The fixtures create temporary directories, homes, profiles, and loopback servers, and close only resources they own. Never aim the fixtures at live Dani Bot data or live provider accounts.
