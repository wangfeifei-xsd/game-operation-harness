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

The startup script runs `pnpm install --frozen-lockfile` on first use or after root dependency configuration or the lockfile changes, validates the selected deployment file, then runs `pnpm run dev:web --environment <environment>` to build, serve, and watch client source changes. The default environment is `dev`, whose configured listener is `http://127.0.0.1:3080`. The script reports success after the public `/harness/login` page responds and prints its URL. The service runs in the background and survives closing the startup terminal.

Select an environment and prevent the browser from opening automatically:

```sh
./use-scripts/start.sh --environment dev --no-open
```

Supported environments are `dev`, `test`, `fat`, and `master`. Set the listener through `server.host` and `server.port` in `config/environments/<environment>.json`; the scripts do not accept a `--port` override. Starting again reuses this project's service for the same environment; stop it before switching environments. Stopping again is safe. The stop script verifies the launch record, process group, and launch token, then terminates only processes managed by these scripts. You can also stop during installation or building. An occupied port causes startup to fail with the configuration path to edit.

## Configuration and logs

Deployment configuration comes directly from the selected `config/environments/<environment>.json`, using the product's configuration validator. The product does not load deployment values from `.env` or process variables. Sign-in requires the matching Creativity authentication service. See [product configuration](../docs/harness-product.md).

The current launch log is `output/local-service/web.log`; check it when startup fails. Each new launch overwrites the log. The launch record and dependency installation marker share this directory, which the root `.gitignore` excludes entirely.

Source, configuration files (including `.env`), dependency manifests, `pnpm-lock.yaml`, and `use-scripts` can be committed to the internal GitLab repository. Ignore rules exclude installed dependencies, build outputs, test reports, logs, runtime data, and caches. Test fixtures and generated source or documentation required by repository checks remain versioned.
