---
kind: upgrade-guide
description: Harness Web/PWA and Electron replace provider authorization and legacy model profiles with independent model records.
---

# Configure Harness models directly

English | [中文](guide.zh.md)

## Change

Harness Web/PWA and Electron open **Settings → Models** through **Model configuration**. Each record contains a built-in provider, endpoint, API key and model identifier. Provider sign-in, balance, recharge and model-account notifications are removed. Desktop no longer requires a provider login or key before entering the workspace.

Old model profiles, default selections, authorization tokens, environment model keys and credentials are not imported or used as fallback. Existing sessions, workspace files and unrelated credentials remain. The upstream `web`, headless and SDK profiles retain their own model configuration.

Catalog output capacity is separate from an explicit request limit. When no limit is configured, Chat Completions, Responses and Google requests omit the optional output-limit field; Anthropic Messages retains its required limit.

## Migration

1. Stop old Harness and Electron processes before starting the updated version. One model service owns each data directory at a time.
2. In `config/environments/{dev,test,fat,master}.json`, remove `providers.deepseekBaseUrl` and `providers.accountBaseUrl`. Keep search configuration and its independent credential; it does not configure models.
3. Open **Model configuration**, add each model and enter its key. Specify context and output limits for models without exact catalog metadata. The first enabled model becomes the default; choose another default in the list when needed.
4. Select a configured model for a session whose old model is unavailable. Run a connection check, then a conversation. Restart the application and confirm the records and default selection remain.

Web/PWA and Desktop records belong to the signed-in user's verified Host home. They use `storages/harness_models.json` and the `harness-model-config` namespace in `.credentials.yaml`. On the same machine, both products share the environment/account home under an exclusive lock; see [runtime and data](../../../harness-product.md#runtime-and-data). Old `DSH_HOME` model data is not imported. Do not delete an entire data directory to clear old model configuration.
