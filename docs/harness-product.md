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
- [Connect a business assistant](#connect-a-business-assistant)
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

Edit the actual `config/environments/dev.json`, `test.json`, `fat.json` or `master.json` before building. The files are tracked and copied to the CLI's `lib/resources/environments/` alongside the standalone authentication UI. Source execution reads the repository directory; installed execution reads the packaged resources. Selection never depends on cwd or the Git branch. Each file is complete; product identity and listener settings do not accept environment-variable injection or `.env` fallback. Plugin configuration uses the layers below.

`server` owns loopback host and port; `creativity` owns the service root, deployment identifier and request timeout; `auth` owns heartbeat and stop bounds; `storage` owns the environment data root. `desktop` owns application identity, protocol, download index, ordinary updates and optional mandatory policy. `proxy` and `providers` supply network deployment settings; `telemetry` and `sandbox` supply defaults that user patches can override. `providers` contains search endpoints and independent search credentials; account model configuration owns model endpoints and keys. Operating-system PATH and tool environments retain their tool meanings. Browsers receive neither these files nor the central token.

Harness identities are platform-level accounts; registration, login and disablement do not use an ordinary business channel. The API exposes no channel identifier.

`creativity.deploymentId` must exactly match the selected service's `/api/v1/harness/bootstrap` response rather than derive from the local environment name. The shared service returns `harness-dev`, which all four configurations use. Remote accounts and disablement apply across these environments; local account homes, application identities and protocols remain isolated by the selected environment. An independently deployed service needs matching database migrations, authentication APIs and a verified deployment identifier before use. Heartbeats are at most 10 seconds, central request timeouts at most 5 seconds and local shutdown grace at most 5 seconds.

Plugin installation, removal, enablement, inventory, configuration editing, Cordis tools/runners, the Harness customization preset, Host/Client HMR, development context and Web surface context use the shipped open-source implementations. Feedback and `/feedback` are available; session telemetry defaults to `FEEDBACK_ONLY`, while product analytics retains its desktop-only condition. Telemetry remains configurable, and any nonempty `DSH_TELEMETRY_DISABLED` disables session export.

Each account keeps `profiles/harness-runtime/` for Web and `profiles/desktop/` for Electron. Bundle defaults apply first, then the profile’s `cordis.patch.yml`, the account-home `cordis.patch.yml`, and invocation `--patch` files. `dsh harness --patch /absolute/extension.yml --environment test` forwards the patch to the authenticated Host. Settings save through the normal configuration editor without a product namespace allowlist. Existing `preferences.json` is imported into the active profile, respecting explicit profile values, and retained as `preferences.json.imported` after success.

Plugin dependencies and selected bundles in each profile’s `package.json` survive startup and updates. The Plugins page manages the running profile. For CLI management, point `DSH_HOME` at the initialized account home and use `dsh plugin --profile harness-runtime` or the bundled Desktop CLI with `--profile desktop`. Authentication is installed before the editable tree; startup, settings edits and HMR retain the account paths and dedicated model configuration.

<a id="model-configuration"></a>
## Model configuration

**Model configuration** opens **Settings → Models** directly. Each record configures a built-in provider, endpoint, API key, model identifier and advanced parameters in one form. An empty configuration permits login, history and settings; a conversation requires an enabled model. A dedicated model service persists additions, edits, default selection, disabling and deletion independently of the general configuration editor. Provider account authorization, balances, recharge and account model notifications are not loaded.

Records live in `storages/harness_models.json` under the current user home; keys use an independent namespace in `.credentials.yaml`. Legacy model profiles, authorization and environment model keys are neither imported nor used as fallback; unrelated user data is retained. Search uses its own key and never falls back to a model key. The service owns an exclusive writer lock for the data root. Revision conflicts retain drafts until the user confirms reloading. Connection checks request the saved endpoint's model directory and do not establish generation capability. See the [model service](../packages/llm/harness-model-config/README.md) for commit and failure behavior.

Electron shares the page, Remote, service and icons. Empty model configuration and missing provider authorization do not block the workspace. On the same machine, Web/PWA and Desktop use the same environment/account home under an exclusive lock; this provides local reuse rather than cloud synchronization. See [Desktop](../apps/desktop/README.md) for native startup.

<a id="runtime-and-data"></a>
## Runtime and data

The public profile owns only authentication resources, same-origin endpoints and the runtime coordinator. A successful login acquires the account directory lock, then forks the private `harness-runtime` profile. Private credentials and identity travel through IPC; the private loopback listener accepts only the owning parent's secret. Browser HTTP and WebSocket traffic passes through the public listener. HTTP requests, new remote operations, model steps, tool executions and scheduled delivery/recovery each revalidate centrally. Background work and state polling do not renew the token; trusted browser input triggers explicit renewal.

Managed account data lives under `~/.game-operation-harness/<environment>/users/<user_id>/`: sessions, storage, credentials, attachments and anonymous identity use this explicit home. Old session and credential data is retained and is not imported. Personal instructions and skills again read `~/.dsh` and `~/.agents`, or their `DSH_HOME` and `DSH_AGENTS_HOME` overrides; projects and bundled skills keep their normal discovery paths. User-selected files remain subject to operating-system permissions. On the first authenticated login, the coordinator locks and atomically moves a sole legacy `users/<channel_id>/<user_id>` home to the new path. Multiple sources, an existing destination alongside a source, symbolic links or a locked legacy home stop login without merging data. Stop old instances before upgrading; retain backups and resolve conflicts to one authoritative home before retrying. No published Session format changes.

<a id="connect-a-business-assistant"></a>
## Connect a business assistant

After a club administrator grants access, open Agent Assistant in Core or the PC client. The assistant uses the linked Harness account automatically.

1. On the local Harness entry, select **Connect Business Assistant** and enter the pairing code shown on the business page. The local sign-in page also offers this action.
2. Review the club and user, select a workspace, and choose whether to allow desktop operations or Creativity agents.
3. Return to the business page and confirm the device and workspace. The local runtime starts within that scope. After an upgrade from the previous pairing protocol, pair the device again.

An approved device can reconnect while Harness is running and the business authorization remains valid. Closing the business assistant ends the current session. Disconnecting on the device clears its saved consent. Club administrators revoke account authorization in Core.

Local chat reads the deployment's model snapshot and credentials from `business-models/storages/harness_models.json` and `business-models/.credentials.yaml` under the environment's storage root. These use the [model service](../packages/llm/harness-model-config/README.md) format and are read when the isolated runtime starts. With no enabled default model in this configuration, the local chat asks the user to contact the deployment administrator.

Custom embedded plugins register a browser module through `harnessEmbedPlugins`. Register it within a `ctx.effect` so the module is released when its plugin stops. The module runs in an isolated iframe, and `api.status()` reports the current session's connection and activity.

<a id="failure-and-recovery"></a>
## Failure and recovery

Disablement or authentication uncertainty closes new access, disconnects proxy connections and stops the owned runtime. The coordinator confirms process termination before releasing its directory lock. A stop that cannot be confirmed keeps the instance closed; stop the local processes before restarting. A crashed parent's private Host stops after IPC disconnect; the directory lock remains unavailable until its stale-lock timeout. Login results arriving after cancellation are revoked and cannot restore the prior identity.

Logout stops local work before requesting central revocation. A central failure reports that local sign-out completed but remote sign-out was not confirmed. Reenablement requires a fresh login; old tokens remain invalid. Product tokens are not persisted: application exit or update restart returns to login. Registration and model configuration remain independent. Web/PWA offers desktop downloads on the login page and sidebar; unavailable releases provide no download links. Electron hides these downloads and uses its own update controls.
