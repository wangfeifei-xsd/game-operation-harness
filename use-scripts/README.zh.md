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

启动脚本在首次运行或根目录依赖配置、锁文件变化后执行 `pnpm install --frozen-lockfile`，然后运行已有的 `pnpm run dev:web`，自动构建、启动并监听客户端源码变化。默认监听地址是 `http://127.0.0.1:3080`，访问界面请使用脚本打印的认证链接；脚本通过该入口确认页面可访问后报告启动成功。服务继续在后台运行，关闭启动终端不影响服务。

更换端口或禁止自动打开浏览器：

```sh
./use-scripts/start.sh --port 3081 --no-open
```

重复启动会复用本项目正在运行的服务，重复关闭也可安全执行。关闭脚本核对启动记录、进程组及启动标记，仅终止这套脚本管理的进程；安装和构建过程中也可以关闭。指定端口被其他服务占用时，启动失败并提示更换端口。

## 配置与日志

模型配置沿用应用的 Web 设置和根目录 `.env` 加载方式；脚本不会将 `.env` 当作 Shell 脚本执行。

本次启动日志保存在 `output/local-service/web.log`，启动失败时先查看此文件。再次启动会覆盖日志；运行记录及依赖安装标记保存在同一目录，全部由根目录 `.gitignore` 忽略。

源码和依赖声明、`pnpm-lock.yaml`、`use-scripts` 需要提交到 Git；本地环境文件、依赖目录、构建产物、日志、运行记录和 Python 缓存均被忽略，`.env.example` 等配置示例保留可提交。
