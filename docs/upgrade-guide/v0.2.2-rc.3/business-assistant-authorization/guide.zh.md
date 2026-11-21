---
kind: upgrade-guide
description: "业务助手现在使用俱乐部管理员创建并绑定的 Harness 账号。"
---
# 业务助手需要俱乐部授权

[English](guide.md) | 中文

## 变更

旧版嵌入助手可在配对时自助开户或绑定，也可使用登录码授权 Harness。业务助手现在自动使用俱乐部管理员绑定的 Harness 账号。业务页启动已授权的会话后，协议 2 核对设备和工作区。旧登录码、自助绑定和配对记录在切换后失效。

## 迁移

1. 部署 Creativity 迁移 `0064_harness_authorization`、新版 Core 后端及配套版本的 `/embed` 网页与本机 Harness 客户端。
2. 在 Core 的「俱乐部设置 → Agent 助手授权」搜索要开通的用户，通过注册表单创建并绑定 Harness 账号。
3. 登录 Core 后台或 PC 客户端，确认 Agent 助手自动使用绑定账号。在本机 Harness 选择「连接业务助手」，输入新的配对码，再从业务页确认设备和工作区。
