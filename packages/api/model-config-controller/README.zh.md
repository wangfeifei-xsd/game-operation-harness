---
description: "经身份验证的 Harness 直接模型配置 Remote 操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-model-config-controller

[English](README.md) | 中文

<a id="summary"></a>

## 概述

为 [Harness 模型服务](../../llm/harness-model-config/README.zh.md)提供 `modelConfig` 列表、保存、启停、默认、删除和连接检查操作。产品现有 Gateway 验证访问身份；控制器只访问当前 Host 的服务，不接受用户目录覆盖参数。

<a id="table-of-contents"></a>

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用此包

在 `harnessModelConfig` 后加载。修改请求携带最近读取的修订号。字段检查、凭据处理、持久化和发布由服务负责。已知服务错误转换为 `model-config/rejected`，包含安全消息、原因和可选字段；意外错误返回通用消息，不包含供应商响应正文或秘密。连接检查接收 Remote 取消信号。Liveshare 将全部操作限定为 owner 使用。

<a id="further-exploration"></a>

## 延伸阅读

[模型设置](../../client/ui-settings-models/README.zh.md) · [Remote 服务](../../typert/protocol/README.zh.md)

<a id="model-experience"></a>

## 模型体验

### 模型配置操作

#### 模型看到的内容

`modelConfig` 操作不添加模型可见文本，服务将已保存配置应用于后续供应商请求。

#### Token 影响

控制器不添加提示词或输入 Token。

#### KV Cache 影响

Remote 配置操作不添加模型请求前缀，请求序列化与缓存复用由所配置的适配器负责。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓工作

- 连接检查只使用已保存记录，控制器不保存或检查尚未保存的 Key 草稿。
- 控制器不提供模型同步或供应商账号授权。

### 开发备注

协议实现集中在 pi-ai 适配器，配置服务与控制器只负责各自的数据与操作。
