---
kind: upgrade-guide
description: Harness Web/PWA 与 Electron 使用独立模型记录替代供应商授权和旧模型 profile。
---

# 直接配置 Harness 模型

[English](guide.md) | 中文

## 变更

Harness Web/PWA 与 Electron 通过“模型配置”打开“设置 → 模型”。每条记录包含内置供应商、接口地址、API Key 和模型标识。供应商登录、余额、充值和模型账号通知已移除。桌面进入工作区不再要求供应商登录或密钥。

旧模型 profile、默认选择、授权 Token、环境模型 Key 和凭据不导入，也不用于回退。现有会话、工作区文件和无关凭据保留。上游 `web`、headless 和 SDK profile 继续使用各自的模型配置。

目录输出容量与显式请求上限分别处理。没有配置上限时，Chat Completions、Responses 和 Google 请求省略可选的输出上限字段；Anthropic Messages 保留协议要求的上限。

## 迁移

1. 启动新版本前停止旧 Harness 和 Electron 进程。同一数据目录只允许一个模型服务持有。
2. 从 `config/environments/{dev,test,fat,master}.json` 删除 `providers.deepseekBaseUrl` 和 `providers.accountBaseUrl`。保留搜索配置及其独立凭据，它们不配置模型。
3. 打开“模型配置”，逐条新增模型并填写密钥。没有准确目录信息的模型需要填写上下文与输出上限。第一条启用模型成为默认；需要时可在列表选择其他默认模型。
4. 旧模型不可用的会话需要重新选择已配置模型。执行连接检查并发送一条对话，重启应用后确认记录与默认选择仍然保留。

Web/PWA 与桌面记录属于已验证登录用户的 Host 数据根，使用 `storages/harness_models.json` 和 `.credentials.yaml` 的 `harness-model-config` 命名空间。同一机器上的两端在独占锁保护下共用部署环境和账号目录，参见[运行时与数据](../../../harness-product.zh.md#runtime-and-data)。旧 `DSH_HOME` 模型数据不导入。不要通过删除整个数据目录来清除旧模型配置。
