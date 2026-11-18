---
description: "Shared deployment configuration, account verification and model composition for Harness Web and Electron entry points."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-harness-product

English | [中文](README.zh.md)

## Summary

Harness entry points use this library to read deployment settings, verify Creativity accounts and isolate each user's running Host. Web/PWA and Electron reuse its model composition to load direct model configuration. The application entry owns transport, windows and lifecycle; this library is a dependency rather than a profile plugin.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

The `config`, `auth-client` and `home` entries validate deployment files and central responses, derive the authenticated user directory and acquire its ownership lock. Central access tokens remain in Node memory. Expected authentication failures carry a `HarnessAuthError` with a status, stable code and safe message.

The `composition` entry preserves account storage and private authentication while loading user extensions. `harnessDefaults` supplies editable sandbox and telemetry defaults; `harnessComposition` runs after user layers on startup and every reload. The [settings service](../../settings/settings/README.md) saves to profile patches and imports legacy account preferences. The shared `model-composition` entry installs the [model configuration service](../../llm/harness-model-config/README.md) and Remote controller, binds storage to the authenticated home and requires the product default-model source. Model requests call suppliers from the local Host.

The `authorization`, `desktop-start` and `process-tree` entries support authenticated execution and managed process ownership. Their callers own shutdown and directory-lock release. They do not accept a renderer-selected user home or expose central tokens to the browser.

## Further Exploration

[Harness product](../../../docs/harness-product.md) · [Desktop](../../../apps/desktop/README.md)

## Model Experience

### Authenticated product execution

#### What the model sees

`harnessComposition` adds no prompt text. Authentication controls execution admission, while the model service supplies saved provider routes.

#### Token effect

Deployment and authentication operations add no model input tokens.

#### KV Cache effect

The library adds no request prefix. The selected adapter owns request serialization and provider cache behavior.

## Known Limitations and Deferred Work

- Central authentication requires the configured Creativity service; deployment identity is verified before login.
- Model records and keys are local to the supplied user home. The library supplies no cross-device synchronization or legacy model import.

### Dev Note

Public types and failure guarantees are documented at their declaring exports.
