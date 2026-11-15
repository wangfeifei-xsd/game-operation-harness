# 本地启动脚本

[English](README.md) | 中文

这些脚本用于 macOS 和 Linux，启动本项目源码的 Web 界面。需要 Node.js 24.9.0 或更高版本，以及 `package.json` 指定的 pnpm；已安装 Corepack 时可自动取得对应的 pnpm。源码构建还需要 Git，且仓库中至少存在一次提交。

## 启动与关闭

在项目根目录执行：

```sh
./use-scripts/start.sh
./use-scripts/stop.sh
```

macOS 也可以双击 `start.command` 启动、双击 `stop.command` 关闭。脚本可以从任意工作目录执行。

启动脚本在首次运行或根目录依赖配置、锁文件变化后执行 `pnpm install --frozen-lockfile`，校验选中的部署文件，再运行 `pnpm run dev:web --environment <environment>`，自动构建、启动并监听客户端源码变化。默认环境为 `test`，其配置监听地址为 `http://127.0.0.1:3081`。公开的 `/harness/login` 页面响应后，脚本报告启动成功并打印登录地址。服务继续在后台运行，关闭启动终端不影响服务。

选择环境并禁止自动打开浏览器：

```sh
./use-scripts/start.sh --environment test --no-open
```

支持 `dev`、`test`、`fat`、`master` 四个环境。监听地址和端口在 `config/environments/<environment>.json` 的 `server.host`、`server.port` 中设置，脚本不接受 `--port` 覆盖。重复启动会复用本项目同一环境的服务，切换环境前须先关闭；重复关闭也可安全执行。关闭脚本核对启动记录、进程组及启动标记，仅终止这套脚本管理的进程；安装和构建过程中也可以关闭。端口被其他服务占用时，启动失败并提示需要修改的配置文件。

## 配置与日志

部署配置直接取自选中的 `config/environments/<environment>.json`，复用产品配置校验器；产品不从 `.env` 或进程变量读取部署值。登录需要匹配的 Creativity 认证服务，详见[产品配置](../docs/harness-product.zh.md)。

本次启动日志保存在 `output/local-service/web.log`，启动失败时先查看此文件。再次启动会覆盖日志；运行记录及依赖安装标记保存在同一目录，全部由根目录 `.gitignore` 忽略。

源码、配置文件（含 `.env`）、依赖声明、`pnpm-lock.yaml` 和 `use-scripts` 可以提交到内网 GitLab。忽略规则排除已安装依赖、构建产物、测试报告、日志、运行数据及缓存；测试样本以及仓库检查依赖的生成源码和文档保留版本管理。
