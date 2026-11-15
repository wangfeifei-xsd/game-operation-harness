---
description: "Harness Web 与 Electron 共用的账号表单及受限账号传输。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-harness-account

[English](README.md) | 中文

<a id="summary"></a>

## 概述

Web 与 Electron 入口复用登录、注册、账号操作和桌面下载组件。调用方提供受限的账号传输，并在认证成功后负责导航。组件展示公开账号信息，不接收中央访问 Token。

<a id="table-of-contents"></a>

## 目录

- [使用此包](#use-this-package)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用此包

在应用入口导入组件及导出的样式表。`AuthPage` 使用传入的 `AuthTransport` 调用固定认证和验证码操作；Web 入口可以使用 `createWebAuthTransport`，Electron 则提供隔离的 preload 传输。请求失败时保留表单，并显示安全的本地化消息。账号操作组件读取公开会话摘要，将退出交给调用方处理。

本包是静态 React 库，不是 Cordis 插件。模型配置由[模型设置](../ui-settings-models/README.zh.md)负责，与产品账号认证独立。

<a id="further-exploration"></a>

## 延伸阅读

[Harness 产品](../../../docs/harness-product.zh.md) · [产品品牌](../ui-brand-game-operation/README.zh.md)

<a id="model-experience"></a>

## 模型体验

### 公开账号操作

#### 模型看到的内容

`AuthPage` 和账号操作组件不会将表单、验证码图片或会话摘要添加为模型可见文本。

#### Token 影响

组件不增加模型输入 Token。

#### KV Cache 影响

组件不添加模型请求前缀，也不控制供应商缓存。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓工作

- 认证依赖调用方的本地账号 API 或桌面桥接，以及配置的中央服务。
- 组件不提供供应商账号授权或模型密钥管理。

### 开发备注

调用方负责账号传输的生命周期和导航。
