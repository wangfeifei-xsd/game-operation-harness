---
kind: upgrade-guide
description: Web/PWA startup requires Creativity authentication and stores managed data in an account-specific home.
---

# Harness Web authentication

English | [中文](guide.zh.md)

## Change

The product's `start:web` and `dev:web` scripts now launch `harness --environment test` instead of the upstream `web` profile. Web/PWA users register and sign in through Creativity; account disablement closes local access and stops the private runtime. The old local owner token no longer grants product access. Provider credentials remain separate from the product account.

The source launcher `use-scripts/start.sh` also uses the Harness entry. It accepts `--environment` and defaults to `test`; the old `--port` option is replaced by `server.port` in the selected deployment file. Defaults connect to `https://catdev.g-buddy.com` and listen locally on port 3081. Explicit `dev` selection uses the same remote Creativity service and a separate local account home.

Managed data moves to `~/.game-operation-harness/<environment>/users/<user_id>/` for new product sessions. Existing `~/.dsh` data remains on disk and is not automatically imported. Personal instructions and skills retain their original local discovery paths. Upstream engineering profiles keep their independent authentication; Electron uses Creativity authentication.

## Migration

1. Stop old local instances and back up the Creativity database and account homes. Deploy Creativity migration `0060_harness_identity`, the Harness authentication API and its platform management page. Configure matching `harness_deployment_id`; remove `CREATIVITY_HARNESS_CHANNEL_CODE`. Harness accounts use the platform identity scope, and the API no longer exposes `channel_id`. Existing account passwords and states are retained; old authentication sessions are revoked and require a fresh login. Legacy business channels and their other resources remain intact.
2. A first authenticated login atomically moves one legacy `users/<channel_id>/<user_id>` home to `users/<user_id>`. Conflicting copies, symbolic links or a directory still in use stop login; back up and resolve conflicts to one authoritative home before retrying.
3. Edit required values in `config/environments/<environment>.json`, then rebuild. All four files currently target the same configured remote service. Match `creativity.deploymentId` to the server's bootstrap response; the test service currently reports `harness-dev`. Keep all files tracked; do not inject deployment values through `.env` or process variables.
4. Launch `dsh harness --environment test`, the matching `start:web:<environment>` script, or `./use-scripts/start.sh --environment test --no-open`. Stop existing source instances before switching environments. The launcher prints `/harness/login` after confirming readiness. Product profiles support user patches, plugin management and HMR while retaining Creativity authentication and account storage. See [the product reference](../../../harness-product.md) for configuration and process ownership.
5. Register a new account, sign in, and verify it in the platform's Harness management page. Disable the account and confirm that HTTP/WebSocket access ends; reenable it and sign in again. Old tokens must remain invalid. Verify account data isolation before importing any historical data manually.
6. Keep profile dependencies and patches in the account home. Existing `preferences.json` imports into the active profile and remains as `.imported`; verify theme, language, permissions, MCP and Plugins after login. See the product reference for layer precedence and telemetry controls.

Stop the new entry before rollback. Retain account data and authentication registrations; starting the upstream `web` profile does not retain Creativity disablement controls.
