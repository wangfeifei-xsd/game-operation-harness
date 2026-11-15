---
description: "Account-scoped model configuration, independent credentials, and live provider routes for Harness products."
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-model-config

English | [中文](README.zh.md)

## Summary

Own the model records, default selection and API-key references used by the Harness Web/PWA and Electron products. The Host calls suppliers through the existing [pi-ai adapter](../llm-pi-ai/README.md); no central model proxy is involved.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The entry supplies an explicitly resolved `root` and the `storage`, JSON storage backend, `credentials`, `llm` and `agentDefaultModel` services. Product composition binds the JSON backend and credential store to the same user home. The plugin takes a process-lifetime file lock before opening `harness_models`, rejects another writer and drains admitted changes before closing.

Each record names one built-in provider, protocol, endpoint, model identifier and timeout. Context and output limits are required for models without an exact catalog/protocol match. Catalog metadata never establishes endpoint connectivity. New homes start empty; legacy model profiles, credentials and environment keys are not imported or used as fallback. The first enabled record becomes the default. Removing or disabling the default requires an enabled replacement when one exists; removing the last enabled record clears it.

Mutations serialize and require the caller's revision. Key replacement writes a new credential record before committing one configuration snapshot, then publishes routes and cleans unreferenced keys. A failed commit retains the old record and key; an unknown storage outcome blocks further work. Cleanup failure returns a committed snapshot with `cleanupPending`, and startup retries cleanup within this package's credential namespace. List responses never contain keys or credential references. Blank edit keys retain the existing key; changing provider or origin requires a new key.

Calls freeze their resolved endpoint, model and credential for the request. Later calls use the new configuration; disabled or removed routes reject new calls. Connection checks perform an actual model-directory request, obey cancellation and a 15-second upper bound, and invalidate results after a revision change.

## Further Exploration

[Product configuration](../../../docs/harness-product.md) · [Remote controller](../../api/model-config-controller/README.md) · [Model settings](../../client/ui-settings-models/README.md)

## Model Experience

### Configured provider requests

#### What the model sees

The `harness-model-<id>` route selects its saved model and provider parameters. This package adds no model-visible prompt text.

#### Token effect

Configuration adds no input tokens. Saved capacity and output limits bound subsequent provider requests; image and reasoning declarations affect their supported options.

#### KV Cache effect

Configuration adds no request prefix. The adapter owns serialization; changing the model or its input options may affect provider cache reuse.

## Known Limitations and Deferred Work

- A successful directory check establishes access to that endpoint's directory, not generation, tool calling or image support.
- The entry selects the user home under the [product data rules](../../../docs/harness-product.md#runtime-and-data); this package provides no cross-directory synchronization or legacy import.
- Credentials use the existing local credential store; this package does not add operating-system keychain storage.

### Dev Note

Protocol implementation belongs to the pi-ai adapter; the configuration service and controller own only their data and operations.
