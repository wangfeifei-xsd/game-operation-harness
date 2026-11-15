---
description: "Shared account forms and restricted account transports for Harness Web and Electron."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-harness-account

English | [中文](README.zh.md)

## Summary

Web and Electron entry points use the same sign-in, registration, account controls and desktop-download components. The caller supplies a restricted account transport and handles navigation after authentication. Components show public account information and never receive a central access token.

## Table of Contents

- [Use this package](#use-this-package)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use this package

Import the components and the exported stylesheet into the application entry. `AuthPage` uses the supplied `AuthTransport` for fixed authentication and captcha operations; the Web entry can use `createWebAuthTransport`, while Electron supplies its isolated preload transport. Failed requests retain the form and display a safe localized message. Account controls read public session summaries and delegate logout to the caller.

This package is a static React library rather than a Cordis plugin. Model configuration belongs to [model settings](../ui-settings-models/README.md), independently of product account authentication.

## Further Exploration

[Harness product](../../../docs/harness-product.md) · [Product brand](../ui-brand-game-operation/README.md)

## Model Experience

### Public account controls

#### What the model sees

`AuthPage` and the account controls add no model-visible text from forms, captcha images or session summaries.

#### Token effect

The components add no model input tokens.

#### KV Cache effect

The components add no model request prefix and do not control provider caches.

## Known Limitations and Deferred Work

- Authentication requires the caller's local account API or desktop bridge and the configured central service.
- The components provide no supplier-account authorization or model-key management.

### Dev Note

The caller owns the account transport lifecycle and navigation.
