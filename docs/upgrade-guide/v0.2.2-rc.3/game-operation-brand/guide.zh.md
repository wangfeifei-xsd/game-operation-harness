---
kind: upgrade-guide
description: "游戏运营品牌替换官方品牌包及鱼形基础组件。"
---

# 使用游戏运营品牌

[English](guide.md) | 中文

## 变更

本二开将 `@deepseek-ai/dsh-client-ui-brand-official` 替换为 `@deepseek-ai/dsh-client-ui-brand-game-operation`。共享 Web/Desktop 组合使用 `ui-brand-game-operation` 行，在所有构建 profile 中填充四个品牌槽位。针对旧行或包的自定义补丁需要更新。公共组件改为 `CatLogo`；移除鱼形路径导出，`BrandWordmark` 要求传入本地化 `label`。

## 迁移

1. 将旧包依赖及补丁目标替换为 `@deepseek-ai/dsh-client-ui-brand-game-operation` 和 `ui-brand-game-operation`。不要同时挂载两个品牌提供者。
2. 将 `FishLogo` 替换为 `CatLogo`。移除鱼形 SVG 路径插值，使用方形标识的 `size` 和 `className` 属性。
3. 通过 `label` 向 `BrandWordmark` 传入本地化产品名；存在独立标识槽位时继续使用 `includeMark={false}`。
4. 确认侧栏和首页仅展示一个猫头，自定义 `DSH_CLIENT_TITLE` 仍生效，卸载品牌时移除其框架。
