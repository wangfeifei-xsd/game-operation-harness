---
kind: upgrade-guide
description: "The game operation brand replaces the official brand package and fish primitives."
---

# Use the game operation brand

English | [中文](guide.zh.md)

## Change

This fork replaces `@deepseek-ai/dsh-client-ui-brand-official` with `@deepseek-ai/dsh-client-ui-brand-game-operation`. The shared Web/Desktop composition uses the `ui-brand-game-operation` row and fills four brand slots in all build profiles. Custom patches targeting the old row or package must change. The public primitive is now `CatLogo`; fish path exports are removed, and `BrandWordmark` requires a localized `label`.

## Migration

1. Replace the old package dependency and patch target with `@deepseek-ai/dsh-client-ui-brand-game-operation` and `ui-brand-game-operation`. Do not mount both brand providers.
2. Replace `FishLogo` with `CatLogo`. Remove fish-specific SVG path interpolation and use the square mark's `size` and `className` props.
3. Pass the localized product name to `BrandWordmark` through `label`; keep `includeMark={false}` when a separate mark slot is present.
4. Confirm that the sidebar and home show one cat mark, custom `DSH_CLIENT_TITLE` values still apply, and unloading the brand removes its frame.
