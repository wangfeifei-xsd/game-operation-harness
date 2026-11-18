---
kind: upgrade-guide
description: Web/PWA 启动改为 Creativity 认证，受管数据保存到独立账号 home。
---

# Harness Web 认证

[English](guide.md) | 中文

## 变更

产品 `start:web` 与 `dev:web` 脚本改为启动 `harness --environment test`，不再选择上游 `web` profile。Web/PWA 用户经 Creativity 注册和登录，账号停用后关闭本地访问并停止私有运行进程。旧本机 owner Token 不再授予产品访问权。供应商凭据仍独立于产品账号。

源码启动脚本 `use-scripts/start.sh` 同样使用 Harness 入口，接受 `--environment`，默认选择 `test`；原 `--port` 参数改由所选部署文件中的 `server.port` 设置。默认连接 `https://catdev.g-buddy.com`，本机监听 3081 端口；显式选择 `dev` 时使用同一远端 Creativity 服务及独立本机账号目录。

新产品会话的受管数据位于 `~/.game-operation-harness/<environment>/users/<user_id>/`。既有 `~/.dsh` 数据保留且不自动导入。个人指令和 Skill 保留原有本地发现路径。上游工程 profile 保持独立认证，Electron 使用 Creativity 认证。

## 迁移

1. 停止旧本地实例并备份 Creativity 数据库与账号目录，部署 Creativity 迁移 `0060_harness_identity`、Harness 认证 API 与平台管理页面，配置匹配的 `harness_deployment_id`，移除 `CREATIVITY_HARNESS_CHANNEL_CODE`。Harness 账号归平台身份范围，接口不再暴露 `channel_id`；原有密码和启停状态保留，旧认证会话撤销并要求重新登录。旧业务渠道及其其他资源保留。
2. 首次认证登录以原子重命名把唯一旧目录 `users/<channel_id>/<user_id>` 搬至 `users/<user_id>`；重复数据、符号链接或目录占用均停止登录，先备份并核对到一份权威目录后重试。
3. 直接编辑 `config/environments/<environment>.json` 中的实际值，再重新构建。四份文件目前均指向同一已配置的远端服务。`creativity.deploymentId` 与服务端 bootstrap 响应匹配，当前 test 服务返回 `harness-dev`。文件全部受 Git 追踪，不从 `.env` 或进程变量注入部署值。
4. 启动 `dsh harness --environment test`、相应的 `start:web:<environment>` 脚本，或 `./use-scripts/start.sh --environment test --no-open`。切换环境前先停止既有源码实例。启动脚本确认就绪后打印 `/harness/login` 地址。产品 profile 支持用户补丁、插件管理和 HMR，同时保留 Creativity 认证及账号存储。配置与进程归属见[产品参考](../../../harness-product.zh.md)。
5. 注册新账号并登录，在平台“Harness 管理”中核对。停用账号后确认 HTTP/WebSocket 访问结束，再启用并重新登录，旧 Token 必须保持无效。手动导入任何历史数据前，先核对账号数据隔离。
6. 在账号 home 中保留 profile 依赖和补丁。旧 `preferences.json` 导入当前 profile，并保留 `.imported` 原文件；登录后核对主题、语言、权限、MCP 与插件页。分层优先级和遥测开关见产品参考。

回退前先停止新入口，保留账号数据和认证登记；启动上游 `web` profile 不保留 Creativity 停用控制。
