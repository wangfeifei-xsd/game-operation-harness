# Harness product authentication

English | [中文](harness-product.zh.md)

## Summary

The `harness` profile serves the Web/PWA product through Creativity authentication. It starts the conversation runtime only after login and runs one account at a time. The upstream `web`, headless, SDK and Electron profiles retain their own authentication and do not implement Creativity account disablement.

## Contents

- [Start the product](#start-the-product)
- [Configuration](#configuration)
- [Runtime and data](#runtime-and-data)
- [Failure and recovery](#failure-and-recovery)

<a id="start-the-product"></a>
## Start the product

Build the repository artifacts, then run the public profile with an explicit environment:

```sh
pnpm run build:artifacts
pnpm start:web --no-open
# Installed CLI:
dsh harness --environment dev --no-open
```

The default repository Web scripts select `dev`. `start:web:test`, `start:web:fat` and `start:web:master` select their named files. Before using an environment, deploy Creativity migration `0060_harness_identity` and its authentication API, configure its matching deployment identifier, and start the service. The default dev address is `http://127.0.0.1:8000`; the public Harness address is `http://127.0.0.1:3080`.

<a id="configuration"></a>
## Configuration

Edit the actual `config/environments/dev.json`, `test.json`, `fat.json` or `master.json` before building. The files are tracked and copied to the CLI's `lib/resources/environments/` alongside the standalone authentication UI. Source execution reads the repository directory; installed execution reads the packaged resources. Selection never depends on cwd or the Git branch. Each file is complete; there is no base/override merge, environment-variable injection, `.env` fallback or user patch.

`server` owns loopback host and port; `creativity` owns the service root, deployment identifier and request timeout; `auth` owns heartbeat and stop bounds; `storage` owns the environment data root. `proxy`, `providers`, `telemetry` and `sandbox` supply the remaining deployment settings. Saved account credentials override `providers.credentials` inside that account's runtime. Operating-system PATH and tool process environments retain their tool meanings. The browser receives neither these files nor the central authentication token.

Harness identities are platform-level accounts; registration, login and disablement do not use an ordinary business channel. The API exposes no channel identifier.

The service root is currently `null` in test, fat and master. Starting those environments fails with an explicit configuration error until their real addresses are written to the files. Deployment identifiers are `harness-dev`, `harness-test`, `harness-fat` and `harness-master`; deployments use independent Creativity databases and Redis namespaces. Heartbeats are at most 10 seconds, central request timeouts at most 5 seconds and local shutdown grace at most 5 seconds.

<a id="runtime-and-data"></a>
## Runtime and data

The public profile owns only authentication resources, same-origin endpoints and the runtime coordinator. A successful login acquires the account directory lock, then forks the private `harness-runtime` profile. Private credentials and identity travel through IPC; the private loopback listener accepts only the owning parent's secret. Browser HTTP and WebSocket traffic passes through the public listener. HTTP requests, new remote operations, model steps, tool executions and scheduled delivery/recovery each revalidate centrally. Background work and state polling do not renew the token; trusted browser input triggers explicit renewal.

Managed account data lives under `~/.game-operation-harness/<environment>/users/<user_id>/`: sessions, storage, credentials, attachments, instructions and anonymous identity use this explicit home. Old `~/.dsh` data is retained and is not imported. User-selected project files remain subject to operating-system permissions. The fixed product tree disables user patches, HMR and runtime plugin/configuration mutation. On the first authenticated login, the coordinator locks and atomically moves a sole legacy `users/<channel_id>/<user_id>` home to the new path. Multiple sources, an existing destination alongside a source, symbolic links or a locked legacy home stop login without merging data. Stop old instances before upgrading; retain backups and resolve conflicts to one authoritative home before retrying. No published Session format changes.

<a id="failure-and-recovery"></a>
## Failure and recovery

Disablement or authentication uncertainty closes new access, disconnects proxy connections and stops the owned runtime. The coordinator confirms process termination before releasing its directory lock. A stop that cannot be confirmed keeps the instance closed; stop the local processes before restarting. A crashed parent's private Host stops after IPC disconnect; the directory lock remains unavailable until its stale-lock timeout. Login results arriving after cancellation are revoked and cannot restore the prior identity.

Logout stops local work before requesting central revocation. A central failure displays “Signed out locally. Remote sign-out was not confirmed.” Reenablement requires a fresh login; old tokens remain invalid. Registration and provider authorization are separate: users still need the provider credentials required by their selected model. This phase adds no model gateway or central conversation storage. Browser and installed PWA windows share the same local server and account state; standalone Electron packaging is outside this product entry.
