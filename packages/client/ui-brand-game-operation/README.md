---
description: "Cat branding and click-triggered home decoration for game-operation-harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-game-operation

English | [中文](README.zh.md)

## Summary

Web, Desktop, and local builds display the game-operation-harness cat identity. Clicking empty home space plays a brief blue cat animation; successive completed plays alternate dots and technical lettering. Reduced motion leaves the home clear. The decoration makes no model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shared [Web bundle](../../bundle/web-app/cordis.patch.yml) mounts this plugin for Web and Desktop. All build profiles receive the same identity; the browser title remains independently configurable through `DSH_CLIENT_TITLE`.

The sidebar shows a cat mark and a localized product name. Narrow containers hide the long English name while retaining the mark and accessible product name. The home uses the same mark. A deployment replacing this identity must replace this row with its own occupants, rather than load two brand packages at the same priority.

Primary clicks on blank home space play one 5.7-second animation, starting with dots. The next completed playback uses the words Agent, tools, context, memory, workflow, and events. Input cards, controls, portaled overlays, and text selections do not trigger playback. Further clicks during playback do not restart it. Hidden or offscreen pages stop drawing, reduced motion clears playback, and leaving the home releases its resources.

The package accepts no configuration. It supplies presentation through the existing slots and changes no provider, authentication, payment, or session behavior.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Declaration-aware registrations occupy the paired sidebar mark/name, hero mark, and hero frame. Registrations withdraw on declaration teardown and return after redeclaration; plugin disposal removes every occupant. The [browser entry](src/client/index.ts) owns registration and the [frame renderer](src/client/home-cat/renderer.ts) owns its canvas, observers, and asynchronous image load.

The lossless [cat atlas](src/client/assets/cat-atlas.webp) contains 137 frames at 192×108, arranged in twelve columns. Red encodes radius and green opacity at 32 levels. Do not apply lossy image compression. The renderer reads it on the first eligible click and shares its geometry between dot and code fills. Theme tokens provide blue ink. Decode failures stop decoration and report a reload action without disabling the home.

Shared [CatLogo and BrandWordmark](../ui-primitives/README.md) also serve the shell fallbacks. The wordmark composes the shared cat with the localized name in the theme font; independently slotted names omit the mark. The small optical cat geometry is shared with the running status and icon generators.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Sidebar](../ui-sidebar/README.md) — brand declarations, compact layout, and fallbacks.
- [Conversation](../ui-conversation/README.md) — the hero and frame declarations.
- [Slots](../../../docs/subsystems/slots.md) — registration and lifetime semantics.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Canvas 2D required** — unavailable contexts or reduced-motion preference leave the home clear.
- **One brand provider** — other identities must replace the same composition row.
- **Browser title independent** — brand slots do not override a custom `DSH_CLIENT_TITLE`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
