---
description: "Authenticated Remote operations for direct Harness model configuration."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-model-config-controller

English | [中文](README.zh.md)

## Summary

Expose `modelConfig` list, save, enable, default, remove and connection-check operations for the [Harness model service](../../llm/harness-model-config/README.md). The product's existing Gateway authenticates access; the controller uses only that Host's service and accepts no user-home override.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Load after `harnessModelConfig`. Mutations carry the last observed revision. The service owns field checks, credential handling, persistence and publication. Known service failures become `model-config/rejected` with a safe message, reason and optional field; unexpected failures return a generic error without supplier response bodies or secrets. Connection checks receive the Remote cancellation signal. Liveshare classifies all operations as owner-only.

## Further Exploration

[Model settings](../../client/ui-settings-models/README.md) · [Remote services](../../typert/protocol/README.md)

## Model Experience

### Model configuration operations

#### What the model sees

`modelConfig` operations add no model-visible text. The service applies saved configuration to later provider requests.

#### Token effect

The controller adds no prompts or input tokens.

#### KV Cache effect

Remote configuration operations add no model request prefix. Request serialization and cache reuse belong to the configured adapter.

## Known Limitations and Deferred Work

- Checks operate on saved records; the controller does not save or test unsaved key drafts.
- The controller provides neither model synchronization nor provider account authorization.

### Dev Note

Protocol implementation belongs to the pi-ai adapter; the configuration service and controller own only their data and operations.
