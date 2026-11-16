# Harness product authentication

English | [中文](harness-product.zh.md)

## Summary

The `harness` profile serves Web/PWA and the protected `desktop` profile serves Electron through Creativity authentication. Both start account runtimes only after login, run one account per instance, and enforce central disablement. The upstream `web`, headless and SDK profiles retain their independent authentication.

The public login and registration page pairs a blue brand panel with a white form panel. Narrow screens stack the brand above the form; both modes retain password visibility, field feedback and the slider verification dialog.

## Contents

- [Start the product](#start-the-product)
- [Configuration](#configuration)
- [Model configuration](#model-configuration)
- [Runtime and data](#runtime-and-data)
- [Failure and recovery](#failure-and-recovery)

<a id="start-the-product"></a>
## Start the product

Build the repository artifacts, then run the public profile with an explicit environment:

```sh
pnpm run build:artifacts
pnpm start:web --no-open
# Installed CLI:
dsh harness --environment test --no-open
```

The default repository Web scripts and `use-scripts/start.sh` select `test` and expose Harness at `http://127.0.0.1:3081`. `start:web:dev/test/fat/master` select their named files. All four environments connect to the same remote Creativity service at `https://catdev.g-buddy.com`. The `/creativity/` path serves its administration page; Harness calls `/api/v1/harness` from the origin. Selecting `dev` changes the local Harness listener to `http://127.0.0.1:3080` while using the same remote authentication service.

<a id="configuration"></a>
## Configuration

Edit the actual `config/environments/dev.json`, `test.json`, `fat.json` or `master.json` before building. The files are tracked and copied to the CLI's `lib/resources/environments/` alongside the standalone authentication UI. Source execution reads the repository directory; installed execution reads the packaged resources. Selection never depends on cwd or the Git branch. Each file is complete; there is no base/override merge, environment-variable injection, `.env` fallback or user patch.

`server` owns loopback host and port; `creativity` owns the service root, deployment identifier and request timeout; `auth` owns heartbeat and stop bounds; `storage` owns the environment data root. `desktop` owns application identity, protocol, download index, ordinary updates and optional mandatory policy. `proxy`, `providers`, `telemetry` and `sandbox` supply the remaining deployment settings. `providers` contains search endpoints and independent search credentials; account model configuration owns model endpoints and keys. Operating-system PATH and tool environments retain their tool meanings. Browsers receive neither these files nor the central token.

Harness identities are platform-level accounts; registration, login and disablement do not use an ordinary business channel. The API exposes no channel identifier.

`creativity.deploymentId` must exactly match the selected service's `/api/v1/harness/bootstrap` response rather than derive from the local environment name. The shared service returns `harness-dev`, which all four configurations use. Remote accounts and disablement apply across these environments; local account homes, application identities and protocols remain isolated by the selected environment. An independently deployed service needs matching database migrations, authentication APIs and a verified deployment identifier before use. Heartbeats are at most 10 seconds, central request timeouts at most 5 seconds and local shutdown grace at most 5 seconds.

<a id="model-configuration"></a>
## Model configuration

**Model configuration** opens **Settings → Models** directly. Each record configures a built-in provider, endpoint, API key, model identifier and advanced parameters in one form. An empty configuration permits login, history and settings; a conversation requires an enabled model. A dedicated model service persists additions, edits, default selection, disabling and deletion without enabling the general configuration editor. Provider account authorization, balances, recharge and account model notifications are not loaded.

Records live in `storages/harness_models.json` under the current user home; keys use an independent namespace in `.credentials.yaml`. Legacy model profiles, authorization and environment model keys are neither imported nor used as fallback; unrelated user data is retained. Search uses its own key and never falls back to a model key. The service owns an exclusive writer lock for the data root. Revision conflicts retain drafts until the user confirms reloading. Connection checks request the saved endpoint's model directory and do not establish generation capability. See the [model service](../packages/llm/harness-model-config/README.md) for commit and failure behavior.

Electron shares the page, Remote, service and icons. Empty model configuration and missing provider authorization do not block the workspace. On the same machine, Web/PWA and Desktop use the same environment/account home under an exclusive lock; this provides local reuse rather than cloud synchronization. See [Desktop](../apps/desktop/README.md) for native startup.

<a id="runtime-and-data"></a>
## Runtime and data

The public profile owns only authentication resources, same-origin endpoints and the runtime coordinator. A successful login acquires the account directory lock, then forks the private `harness-runtime` profile. Private credentials and identity travel through IPC; the private loopback listener accepts only the owning parent's secret. Browser HTTP and WebSocket traffic passes through the public listener. HTTP requests, new remote operations, model steps, tool executions and scheduled delivery/recovery each revalidate centrally. Background work and state polling do not renew the token; trusted browser input triggers explicit renewal.

Managed account data lives under `~/.game-operation-harness/<environment>/users/<user_id>/`: sessions, storage, credentials, attachments, instructions and anonymous identity use this explicit home. Old `~/.dsh` data is retained and is not imported. User-selected project files remain subject to operating-system permissions. The fixed product tree disables user patches, HMR and runtime plugin/configuration mutation. On the first authenticated login, the coordinator locks and atomically moves a sole legacy `users/<channel_id>/<user_id>` home to the new path. Multiple sources, an existing destination alongside a source, symbolic links or a locked legacy home stop login without merging data. Stop old instances before upgrading; retain backups and resolve conflicts to one authoritative home before retrying. No published Session format changes.

<a id="failure-and-recovery"></a>
## Failure and recovery

Disablement or authentication uncertainty closes new access, disconnects proxy connections and stops the owned runtime. The coordinator confirms process termination before releasing its directory lock. A stop that cannot be confirmed keeps the instance closed; stop the local processes before restarting. A crashed parent's private Host stops after IPC disconnect; the directory lock remains unavailable until its stale-lock timeout. Login results arriving after cancellation are revoked and cannot restore the prior identity.

Logout stops local work before requesting central revocation. A central failure reports that local sign-out completed but remote sign-out was not confirmed. Reenablement requires a fresh login; old tokens remain invalid. Product tokens are not persisted: application exit or update restart returns to login. Registration and model configuration remain independent. Web/PWA offers desktop downloads on the login page and sidebar; unavailable releases provide no download links. Electron hides these downloads and uses its own update controls.
