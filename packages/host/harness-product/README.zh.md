---
description: "Harness Web 与 Electron 入口共用的部署配置、账号验证与模型装配。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-harness-product

[English](README.md) | 中文

<a id="summary"></a>

## 概述

Harness 入口通过本库读取部署配置、验证 Creativity 账号，并隔离各用户运行中的 Host。Web/PWA 与 Electron 复用模型装配能力，加载直接模型配置。传输、窗口和生命周期由应用入口负责；本库作为依赖使用，不是 profile 插件。

<a id="table-of-contents"></a>

## 目录

- [使用此包](#use-this-package)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用此包

`config`、`auth-client` 和 `home` 入口验证部署文件与中央响应，确定已认证用户的目录并取得归属锁。中央访问 Token 仅保留在 Node 内存中。预期认证失败使用 `HarnessAuthError`，包含状态、稳定错误码和安全消息。

`composition` 入口在加载用户扩展的同时保留账号存储与私有认证。`harnessDefaults` 提供可编辑的沙箱和遥测默认值；`harnessComposition` 在启动及每次重载时于用户层之后应用。[设置服务](../../settings/settings/README.zh.md)保存 profile 补丁并导入旧账号偏好。共用的 `model-composition` 入口装配[模型配置服务](../../llm/harness-model-config/README.zh.md)及 Remote 控制器，将存储绑定到已认证 home，并要求产品默认模型来源。模型请求由本地 Host 调用供应商。

`authorization`、`desktop-start` 和 `process-tree` 入口支持认证后的执行与受管进程归属。调用者负责关闭和释放目录锁。这些入口不接受渲染端指定的用户目录，也不向浏览器暴露中央 Token。

<a id="further-exploration"></a>

## 延伸阅读

[Harness 产品](../../../docs/harness-product.zh.md) · [Desktop](../../../apps/desktop/README.zh.md)

<a id="model-experience"></a>

## 模型体验

### 已认证的产品执行

#### 模型看到的内容

`harnessComposition` 不添加提示词。认证控制执行准入，模型服务提供已保存的供应商路由。

#### Token 影响

部署与认证操作不增加模型输入 Token。

#### KV Cache 影响

本库不添加请求前缀。所选适配器负责请求序列化与供应商缓存行为。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓工作

- 中央认证依赖配置的 Creativity 服务；登录前验证部署身份。
- 模型记录与 Key 仅保存在传入的用户目录中。本库不提供跨设备同步或旧模型导入。

### 开发备注

公开类型及失败保证在各自的导出处说明。
