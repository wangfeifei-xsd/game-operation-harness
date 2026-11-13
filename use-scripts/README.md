# Local startup scripts

English | [中文](README.zh.md)

These scripts launch the project's Web UI from source on macOS and Linux. They require Node.js 24.9.0 or later and the pnpm version specified in `package.json`; an installed Corepack can obtain the matching pnpm version automatically. The source build also requires Git and a repository with at least one commit.

## Start and stop

Run from the project root:

```sh
./use-scripts/start.sh
./use-scripts/stop.sh
```

On macOS, you can also double-click `start.command` to start or `stop.command` to stop. You can run the scripts from any working directory.

The startup script runs `pnpm install --frozen-lockfile` on first use or after root dependency configuration or the lockfile changes, then runs the existing `pnpm run dev:web` to build, serve, and watch client source changes. The default listener is `http://127.0.0.1:3080`; open the authentication link printed by the script to access the UI. The script confirms the page is accessible through that entry before reporting success. The service runs in the background and survives closing the startup terminal.

Choose another port or prevent the browser from opening automatically:

```sh
./use-scripts/start.sh --port 3081 --no-open
```

Starting again reuses the service already running for this project; stopping again is also safe. The stop script verifies the launch record, process group, and launch token, then terminates only processes managed by these scripts. You can also stop during installation or building. Startup fails with a port-selection hint if another service occupies the chosen port.

## Configuration and logs

Model configuration uses the application's Web settings and root `.env` loading. The scripts do not execute `.env` as a shell script.

The current launch log is `output/local-service/web.log`; check it when startup fails. Each new launch overwrites the log. The launch record and dependency installation marker share this directory, which the root `.gitignore` excludes entirely.

Commit source, dependency manifests, `pnpm-lock.yaml`, and `use-scripts` to Git. Local environment files, dependencies, build outputs, logs, launch records, and Python caches are ignored; configuration examples such as `.env.example` remain available to commit.
