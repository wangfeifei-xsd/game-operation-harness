---
description: "Harness 产品按账号隔离的模型配置、独立凭据与实时供应商路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-harness-model-config

[English](README.md) | 中文

<a id="summary"></a>

## 概述

负责 Harness Web/PWA 与 Electron 产品的模型记录、默认选择和 API Key 引用。Host 通过现有 [pi-ai 适配器](../llm-pi-ai/README.zh.md)调用供应商，不经过中央模型代理。

<a id="table-of-contents"></a>

## 目录

- [使用此包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>

## 使用此包

入口显式传入已解析的 `root`，并提供 `storage`、JSON 存储后端、`credentials`、`llm` 和 `agentDefaultModel` 服务。产品装配将 JSON 后端与凭据存储绑定到同一用户目录。插件在打开 `harness_models` 前取得进程生命周期文件锁，拒绝其他写入者，关闭前等待已接纳的修改结束。

每条记录配置一个内置供应商、协议、接口地址、模型标识和超时。没有准确目录与协议匹配的模型必须填写上下文和输出上限。目录信息不代表端点连接已通过。新目录从空配置开始，不导入旧模型 profile、凭据或环境 Key，也不将它们用作回退。第一条启用记录成为默认；删除或停用默认模型且仍有其他启用模型时，必须选择替代默认；移除最后一条启用记录会清空默认。

修改串行执行，并检查调用者修订号。替换 Key 时先写入新凭据，再提交完整配置快照，最后发布路由并清理无引用 Key。提交失败保留原记录与 Key；存储结果不确定时阻止后续工作。清理失败返回带 `cleanupPending` 的已提交快照，启动时只在本包凭据命名空间重试清理。列表响应不包含 Key 或凭据引用。编辑时留空保留原 Key；改变供应商或源站必须输入新 Key。

每次调用冻结本次使用的地址、模型和凭据。后续调用使用新配置；已停用或删除的路由拒绝新调用。连接检查真实请求模型目录，支持取消，最长等待 15 秒；修订变化后结果失效。

<a id="further-exploration"></a>

## 延伸阅读

[产品配置](../../../docs/harness-product.zh.md) · [Remote 控制器](../../api/model-config-controller/README.zh.md) · [模型设置](../../client/ui-settings-models/README.zh.md)

<a id="model-experience"></a>

## 模型体验

### 已配置的供应商请求

#### 模型看到的内容

`harness-model-<id>` 路由选择已保存的模型及供应商参数。本包不添加模型可见提示词。

#### Token 影响

配置不增加输入 Token。已保存的容量与输出上限约束后续供应商请求；图片和推理声明影响可用选项。

#### KV Cache 影响

配置不添加请求前缀。序列化由适配器负责；改变模型或输入选项可能影响供应商缓存复用。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓工作

- 目录检查成功只代表可以访问该端点的目录，不代表生成、工具调用或图片能力通过。
- 用户目录由入口按[产品数据规则](../../../docs/harness-product.zh.md#runtime-and-data)选择，本包不提供跨目录同步或旧数据导入。
- 凭据复用现有本地凭据存储，本包不新增操作系统钥匙串。

### 开发备注

协议实现集中在 pi-ai 适配器，配置服务与控制器只负责各自的数据与操作。
