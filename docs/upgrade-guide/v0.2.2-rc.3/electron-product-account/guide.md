---
kind: upgrade-guide
description: "Electron now requires Creativity product login and uses account-scoped data and product distribution settings."
---
# Electron requires a product account

English | [中文](guide.zh.md)

## Change

Agent 助手 replaces the upstream desktop welcome and API-key login. The main process requires Creativity authentication before starting its private Host. Product tokens stay in memory; app exit and update restart require login again. Provider model credentials do not authorize product access.

Web/PWA and Desktop share the same environment/account data directory under an exclusive lock. The protected `desktop` profile supports user overlays, HMR, plugin installation and configuration editing; central authentication is installed before the editable plugin tree. Old `~/.dsh` data and upstream installation identities are retained independently.

Deployment files now require `desktop` application identity, protocol, download index and update settings. `stable` is the only enabled channel. The product protocol is `agent-assistant://open` for master and `agent-assistant-<environment>://open` elsewhere; old `dsh://open` links do not address this product.

## Migration

1. Quit old Web and Desktop instances and back up data before switching. Configure the selected `config/environments/<environment>.json`, including the matching Creativity deployment identifier. See [configuration](../../../harness-product.md#configuration) and [Desktop](../../../../apps/desktop/README.md).
2. Launch Desktop with an explicit environment, or install a package carrying that deployment. Register or sign in with a Creativity account, then configure models within the account. Do not copy upstream tokens or rely on `DSH_HOME` to select product storage.
3. Stop the other carrier before opening the same account. Existing Harness account data is reused locally; ambiguous legacy-directory migration stops login without merging. Resolve conflicts to one backed-up home before retrying.
4. Configure product-owned HTTPS download and update addresses and real signing identities before release. Replace protocol links with the selected product protocol. Disabled mandatory policy remains disabled; upstream Feishu policy authentication is not used.
5. Confirm cold startup shows login with no account Host, successful login opens the intended account, and sign-out stops its Host. Restart must return to login. An unpublished download index must show no installer links.
6. Keep custom dependencies and patches in `profiles/desktop`. Existing account preferences migrate to the active profile. Confirm plugin installation, configuration saving and reload preserve the account and model settings; telemetry follows the configured opt-out and platform conditions.
