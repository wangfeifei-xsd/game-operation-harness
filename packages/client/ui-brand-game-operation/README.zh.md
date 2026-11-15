---
description: "game-operation-harness 的猫头品牌和点击触发的首页装饰。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-game-operation

[English](README.md) | 中文

## 概述

Web、Desktop 和本地构建统一展示Agent 助手 的猫头品牌。点击首页空白处会播放短暂的蓝色猫头动效，完整播放后再次点击将在点阵与技术词语之间交替。启用减少动态效果时首页保持清空。装饰不会发起模型请求。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

共享 [Web 组合包](../../bundle/web-app/cordis.patch.yml) 为 Web 和 Desktop 挂载此插件。所有构建 profile 使用同一身份；浏览器标题仍可通过 `DSH_CLIENT_TITLE` 独立配置。

侧栏展示猫头和本地化产品名。窄容器隐藏较长的英文名称，同时保留猫头与完整可访问名称。首页使用同一标识。需要替换身份的部署应将此行替换为自己的槽位提供者，不应以同一优先级加载两个品牌包。

在首页空白处按主键点击会播放一次 5.7 秒动效，首次为点阵。下次完整播放使用 Agent、tools、context、memory、workflow 和 events 等词语。输入卡片、控件、传送浮层和文字选区不触发播放。播放期间继续点击不会重启。页面隐藏或离屏时停止绘制，减少动态效果会清空播放，离开首页会释放资源。

本包没有配置项。它通过现有槽位提供界面，不改变提供商、认证、支付或会话行为。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

声明感知的注册分别占据配对的侧栏标识与名称、首屏标识和首屏框架。声明释放时撤回注册，重新声明后恢复；插件释放移除全部占位。[浏览器入口](src/client/index.ts) 负责注册，[框架绘制器](src/client/home-cat/renderer.ts) 负责画布、观察器和异步图片加载。

无损[猫头图集](src/client/assets/cat-atlas.webp) 包含 137 帧，每帧 192×108，按十二列排列。红色通道编码半径，绿色编码透明度，各有 32 级。禁止有损图片压缩。绘制器在首次有效点击时读取图集，点阵与代码填充共用几何。主题 token 提供蓝色。解码失败停止装饰并提示重新加载，不影响首页使用。

公共 [CatLogo 与 BrandWordmark](../ui-primitives/README.zh.md) 同时供界面 fallback 使用。字标将公共猫头和主题字体中的本地化名称组合；独立名称槽位不重复包含猫头。小尺寸猫头几何同时供运行状态和图标生成器使用。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [侧栏](../ui-sidebar/README.zh.md)——品牌声明、紧凑布局与 fallback。
- [会话](../ui-conversation/README.zh.md)——首屏与框架声明。
- [槽位](../../../docs/subsystems/slots.zh.md)——注册与生命周期语义。

-----

<a id="model-experience"></a>
## 模型体验

无，因为此包只提供浏览器界面；这里的内容不会进入模型请求。

#### KV Cache 影响

无；此包既不组装也不发送提供商请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **需要 Canvas 2D**——画布不可用或启用减少动态效果时首页保持清空。
- **单一品牌提供者**——其他身份必须替换同一组合行。
- **浏览器标题独立**——品牌槽位不会覆盖自定义 `DSH_CLIENT_TITLE`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
