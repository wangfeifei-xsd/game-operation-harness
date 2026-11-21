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

Web and Electron share a sidebar account card with a blue avatar, the display name, a green signed-in indicator and a trailing sign-out action. Long names show their full value on hover. The collapsed sidebar keeps an icon-only sign-out action. The Web download action uses the same icon size and left inset as the model and settings actions below it.

The sign-in and registration page offers Light and Dark controls beside the optional desktop download. It follows the system appearance until the user selects a theme, then remembers that choice in the entry's local storage across reloads. Switching themes retains form values and verification progress. If local storage is unavailable, the selection lasts for the current page.

Theme controls, verification and Web downloads use soft filled surfaces in both appearances. The captcha dialog keeps the server-provided puzzle, a keyboard-accessible slider, refresh and confirmation controls. Electron uses the same authentication styles without a download action.

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

The sign-in page sends pairing requests through the same transport. The user reviews the business identity and grants access to a workspace. The business page then confirms the device.
