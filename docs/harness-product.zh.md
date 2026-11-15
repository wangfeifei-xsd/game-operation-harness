# Harness 产品认证

[English](harness-product.md) | 中文

## 概述

`harness` profile 通过 Creativity 认证提供 Web/PWA 产品服务，登录后才启动会话运行服务，同一实例同时运行一个账号。上游 `web`、headless、SDK 和 Electron profile 保留各自认证方式，不实现 Creativity 账号停用控制。

## 目录

- [启动产品](#start-the-product)
- [配置](#configuration)
- [运行与数据](#runtime-and-data)
- [故障与恢复](#failure-and-recovery)

<a id="start-the-product"></a>
## 启动产品

构建仓库产物后，以显式环境启动公开 profile：

```sh
pnpm run build:artifacts
pnpm start:web --no-open
# Installed CLI:
dsh harness --environment dev --no-open
```

仓库默认 Web 脚本选择 `dev`。`start:web:test`、`start:web:fat` 和 `start:web:master` 分别选择同名文件。使用一个环境前，先部署 Creativity 迁移 `0060_harness_identity` 和认证 API，配置匹配的部署标识，再启动服务。默认 dev 地址为 `http://127.0.0.1:8000`，Harness 公开地址为 `http://127.0.0.1:3080`。

<a id="configuration"></a>
## 配置

构建前直接编辑实际的 `config/environments/dev.json`、`test.json`、`fat.json` 或 `master.json`。文件受 Git 追踪，与独立认证 UI 一起复制到 CLI 的 `lib/resources/environments/`。源码运行读取仓库目录，安装后运行读取分发资源。选择不依赖 cwd 或 Git 分支。每份文件完整，不合并 base/override，不通过环境变量注入，也不从 `.env` 或用户 patch 回填。

`server` 配置 loopback 主机与端口；`creativity` 配置服务根地址、部署标识和请求超时；`auth` 配置心跳与停止时限；`storage` 配置环境数据根。`proxy`、`providers`、`telemetry` 和 `sandbox` 提供其余部署设置。账号保存的个人凭据在本账号运行服务中优先于 `providers.credentials`。操作系统 PATH 与工具进程环境保持工具自身语义。浏览器不会收到这些文件或中央认证 Token。

Harness 账号属于平台终端身份；注册、登录与启停不依赖普通业务渠道，接口不暴露渠道标识。

test、fat、master 的服务地址目前为 `null`。只有把真实地址写入文件后才能启动，否则明确报配置错误。部署标识为 `harness-dev`、`harness-test`、`harness-fat` 和 `harness-master`；各部署使用独立的 Creativity 数据库与 Redis 命名空间。心跳间隔最多 10 秒，中央请求超时最多 5 秒，本地优雅停止最多 5 秒。

<a id="runtime-and-data"></a>
## 运行与数据

公开 profile 仅负责认证资源、同源接口与进程协调。登录成功后先取得账号目录锁，再派生私有 `harness-runtime` profile。私有凭据与身份通过 IPC 传递，私有 loopback 监听仅接受所属父进程秘密。浏览器 HTTP 与 WebSocket 流量经过公开监听转发。HTTP 请求、新远程操作、模型步骤、工具执行、计划投递与恢复各自重新向中央认证。后台工作与状态轮询不续期，可信浏览器输入显式触发续期。

受管账号数据位于 `~/.game-operation-harness/<environment>/users/<user_id>/`：会话、存储、凭据、附件、指令及匿名标识均使用显式账号 home。旧 `~/.dsh` 数据保留且不自动导入。用户自行选择的项目文件仍受操作系统权限管理。固定产品树禁止用户 patch、HMR 及运行时插件/部署配置修改。首次认证登录时，协调器锁定并以原子重命名将唯一旧目录 `users/<channel_id>/<user_id>` 搬至新路径。多份来源、目标与旧目录并存、符号链接或旧目录占用均停止登录，不合并数据。升级前停止旧实例；冲突时保留备份并核对到一份权威目录后重试。不改变已发布 Session 格式。

<a id="failure-and-recovery"></a>
## 故障与恢复

账号停用或无法确认认证时，入口拒绝新访问、断开代理连接并停止所属运行服务。协调器确认进程停止后才释放目录锁。无法确认停止时实例保持关闭，先停止本地进程再重启。父进程崩溃后，私有 Host 在 IPC 断开后停止，目录锁须等待判旧超时。取消登录后晚到的签发结果会被撤销，不恢复旧身份。

退出先停止本地工作，再请求中央撤销。中央失败时显示“本机已退出，远端退出未确认”。重新启用后须重新登录，旧 Token 保持无效。产品注册与供应商授权相互独立，用户仍须提供所选模型需要的供应商凭据。本期不增加模型网关或集中会话存储。浏览器与已安装 PWA 共用本地服务和账号状态，独立 Electron 分发不属于本产品入口。
