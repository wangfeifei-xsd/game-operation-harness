# Harness 产品认证

[English](harness-product.md) | 中文

## 概述

`harness` profile 提供 Web/PWA，受保护的 `desktop` profile 提供 Electron；两者均使用 Creativity 认证，登录后才启动账号运行服务，同一实例只运行一个账号，并执行中央停用控制。上游 `web`、headless 与 SDK profile 保留各自独立认证。

公开登录、注册页采用蓝色品牌区与白色表单区的分栏布局，窄屏下品牌区置于表单上方。两种模式均保留密码显隐、字段反馈和滑块验证弹窗。

## 目录

- [启动产品](#start-the-product)
- [配置](#configuration)
- [模型配置](#model-configuration)
- [运行与数据](#runtime-and-data)
- [故障与恢复](#failure-and-recovery)

<a id="start-the-product"></a>
## 启动产品

构建仓库产物后，以显式环境启动公开 profile：

```sh
pnpm run build:artifacts
pnpm start:web --no-open
# Installed CLI:
dsh harness --environment test --no-open
```

仓库默认 Web 脚本及 `use-scripts/start.sh` 选择 `test`，Harness 公开地址为 `http://127.0.0.1:3081`。`start:web:dev/test/fat/master` 分别选择同名文件。四个环境均连接远端 `https://catdev.g-buddy.com` 的同一 Creativity 服务。`/creativity/` 是管理页面路径，Harness 从域名根调用 `/api/v1/harness`。显式选择 `dev` 时，Harness 本机监听改为 `http://127.0.0.1:3080`，认证仍使用同一远端服务。

<a id="configuration"></a>
## 配置

构建前直接编辑实际的 `config/environments/dev.json`、`test.json`、`fat.json` 或 `master.json`。文件受 Git 追踪，与独立认证 UI 一起复制到 CLI 的 `lib/resources/environments/`。源码运行读取仓库目录，安装后运行读取分发资源。选择不依赖 cwd 或 Git 分支。每份文件完整，产品身份和监听设置不通过环境变量注入，也不从 `.env` 回填；插件配置使用下面的分层机制。

`server` 配置 loopback 主机和端口；`creativity` 配置服务地址、部署标识与请求超时；`auth` 配置心跳与停止时限；`storage` 配置环境数据根；`desktop` 配置应用身份、协议、下载索引、普通更新和可选强制升级策略。`proxy`、`providers` 提供网络部署设置；`telemetry`、`sandbox` 提供可由用户补丁覆盖的默认值。`providers` 只保留搜索端点与独立搜索凭据，模型端点和 Key 归账号模型配置所有。操作系统 PATH 与工具环境保持工具自身语义。浏览器不会收到这些文件或中央 Token。

Harness 账号属于平台终端身份；注册、登录与启停不依赖普通业务渠道，接口不暴露渠道标识。

`creativity.deploymentId` 必须与所选服务 `/api/v1/harness/bootstrap` 返回的标识完全一致，不从本机环境名推导；共享服务返回 `harness-dev`，四份配置据此填写。远端账号及停用状态在这四个环境间共用，本机账号目录、应用身份和协议仍按所选环境隔离。若独立部署服务，使用前需要部署匹配的数据库迁移和认证 API，并核实部署标识。心跳间隔最多 10 秒，中央请求超时最多 5 秒，本地优雅停止最多 5 秒。

插件安装、卸载、启停、清单、配置编辑、Cordis 工具与运行器、Harness 自定义预设、Host/Client HMR、开发上下文及 Web 界面上下文均使用开源实现。反馈与 `/feedback` 恢复可用；会话遥测默认采用 `FEEDBACK_ONLY`，产品统计仍仅在桌面端装配。遥测可配置，任意非空 `DSH_TELEMETRY_DISABLED` 均禁止会话导出。

每个账号通过 `profiles/harness-runtime/` 保存 Web 配置，通过 `profiles/desktop/` 保存 Electron 配置。依次应用组合包默认值、profile 的 `cordis.patch.yml`、账号 home 的 `cordis.patch.yml`、调用级 `--patch` 文件。`dsh harness --patch /absolute/extension.yml --environment test` 将补丁传给认证后的 Host。设置通过常规配置编辑器保存，不再使用产品命名空间白名单。旧 `preferences.json` 导入当前 profile，尊重已有显式 profile 值，成功后保留为 `preferences.json.imported`。

各 profile 的 `package.json` 中自定义依赖和组合包选择在启动、更新后保留。“插件”页管理当前运行的 profile。CLI 管理时，将 `DSH_HOME` 指向已初始化的账号 home，使用 `dsh plugin --profile harness-runtime`；桌面使用内置 CLI 的 `--profile desktop`。认证在可编辑树装载前安装；启动、设置编辑及 HMR 均保留账号路径与独立模型配置。

<a id="model-configuration"></a>
## 模型配置

点击“模型配置”直接打开“设置 → 模型”，每条记录在同一表单配置内置供应商、接口地址、API Key、模型标识与高级参数。没有模型时仍可登录、查看历史和打开设置；执行对话前需要选择启用模型。新增、编辑、默认选择、停用与删除由独立模型服务持久化，与通用配置编辑器相互独立。供应商账号授权、余额、充值与账号模型通知不加载。

模型记录位于当前用户目录的 `storages/harness_models.json`，Key 位于 `.credentials.yaml` 的独立命名空间。旧模型 profile、旧授权和环境模型 Key 不导入、不回退，也不删除其他用户数据。搜索使用自己独立的 Key，模型 Key 不为搜索兜底。服务对数据根持有独占写入锁；修订冲突保留草稿，重新加载需明确确认。连接检查真实请求已保存端点的模型目录，不证明生成能力。详细提交与失败规则见[模型配置服务](../packages/llm/harness-model-config/README.zh.md)。

Electron 共享页面、Remote、服务和图标，模型为空或供应商未授权均不阻塞工作区。同一机器上的 Web/PWA 与 Desktop 使用相同环境/账号目录，并通过独占锁互斥访问；本机复用不提供云同步。原生启动见[Desktop](../apps/desktop/README.zh.md)。

<a id="runtime-and-data"></a>
## 运行与数据

公开 profile 仅负责认证资源、同源接口与进程协调。登录成功后先取得账号目录锁，再派生私有 `harness-runtime` profile。私有凭据与身份通过 IPC 传递，私有 loopback 监听仅接受所属父进程秘密。浏览器 HTTP 与 WebSocket 流量经过公开监听转发。HTTP 请求、新远程操作、模型步骤、工具执行、计划投递与恢复各自重新向中央认证。后台工作与状态轮询不续期，可信浏览器输入显式触发续期。

受管账号数据位于 `~/.game-operation-harness/<environment>/users/<user_id>/`：会话、存储、凭据、附件及匿名标识使用显式账号 home。旧会话和凭据数据保留且不自动导入。个人指令和 Skill 恢复读取 `~/.dsh`、`~/.agents`，也接受 `DSH_HOME`、`DSH_AGENTS_HOME` 覆盖；项目与内置 Skill 沿用原有发现路径。用户选择的文件仍受操作系统权限管理。首次认证登录时，协调器锁定并以原子重命名将唯一旧目录 `users/<channel_id>/<user_id>` 搬至新路径。多份来源、目标与旧目录并存、符号链接或旧目录占用均停止登录，不合并数据。升级前停止旧实例；冲突时保留备份并核对到一份权威目录后重试。不改变已发布 Session 格式。

<a id="failure-and-recovery"></a>
## 故障与恢复

账号停用或无法确认认证时，入口拒绝新访问、断开代理连接并停止所属运行服务。协调器确认进程停止后才释放目录锁。无法确认停止时实例保持关闭，先停止本地进程再重启。父进程崩溃后，私有 Host 在 IPC 断开后停止，目录锁须等待判旧超时。取消登录后晚到的签发结果会被撤销，不恢复旧身份。

退出先停止本机工作，再请求中央撤销；中央故障时准确反馈本机已退出、远端退出未确认。重新启用后需要重新登录，旧 Token 仍无效。产品 Token 不持久化，退出应用或更新重启后回到登录页；注册与模型配置彼此独立。Web/PWA 在登录页和侧栏提供桌面下载入口，未发布时不生成下载链接。Electron 隐藏这些入口，使用自身更新操作。
