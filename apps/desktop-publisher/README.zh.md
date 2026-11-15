---
description: "从保留的安装包执行 Desktop 发布和灰度放量，无需安装 Desktop 构建依赖。"
kind: "package-library"
---
# Desktop 发布工具

[English](README.md) | 中文

## 概述

发布保留的 Desktop 安装包、调整已发布版本的放量比例，以及刷新官网安装包。手动 GitHub 工作流选择原始打包机器，并要求通过配置的环境审批。此私有 workspace 共用仓库锁文件，通过 Node 24 和 tsx 直接执行 TypeScript 源码。

## 目录

- [使用此包](#use-this-package)
- [实现](#implementation)
- [限制](#limitations)

## 使用此包

首次发布使用 [Publish Desktop](../../.github/workflows/desktop-publish.yml)，已发布版本使用 [Rollout & Website](../../.github/workflows/desktop-rollout.yml)。工作流负责操作输入、运行器路由、凭据和审批步骤。放量仅安装此 workspace 的生产依赖，并禁用生命周期脚本；从此包目录使用 Node 调用入口，避免 pnpm 自动修复依赖。

无依赖预检在安装之前运行，其可执行回归检查为：

```sh
node apps/desktop-publisher/tests/preinstall.mjs
```

产品部署读取 `config/environments/<environment>.json`，由 `DSH_DESKTOP_PRODUCT_ENVIRONMENT` 选择。历史发布存储将 `master` 映射为 `production`，其余产品环境映射为 `test`，不会替代产品环境；只接受 `stable` 频道。发布打包和上传拒绝缺失应用身份、普通更新源或下载索引、保留构建产品身份不匹配，以及安装包内置供应商凭据。配置见[产品配置](../../docs/harness-product.zh.md#configuration)。

同一上传计划管理安装包字节、原生更新元数据及公开的 `downloads.json` 索引。发布校验本地哈希，上传不可变文件，核对远端字节，推进原生源后才更新下载索引。跨机器对象锁串行化各目标的索引写入；同版目标合并，旧版本和同版目标内容变更被拒绝。索引写入不完整时报告失败，保留已上传对象以便核对恢复。回滚只接受携带本产品身份的保留版本。

## 实现

<details>
<summary>维护者说明</summary>

Desktop 构建和签名脚本保留在 `apps/desktop`；发布代码不导入 Desktop 实现。Desktop 通过 workspace 包导出使用发布辅助函数。运行时依赖归此包的 `dependencies` 所有；测试和类型检查使用仓库开发工具。根目录的 host TypeScript 项目检查这些源码，因此没有独立的编译产物或包级 tsconfig。

完整安装的发布与筛选安装的放量使用不同 checkout 目录。在同一 checkout 切换安装模式会移除开发依赖链接，也可能保留旧 Desktop 目录。发布记录位于这些 checkout 之外，仍由现有保留版本配置管理。

`apps/desktop` 下的测试可以复用发布工具的 loopback COS fixture。发布失败测试还将 Desktop 回滚和归档 CLI 作为仓库集成测试执行；这些测试路径不是运行时依赖。隔离安装 CI 在 Linux、macOS 和 Windows 上验证发布源码无需 Desktop 或根目录开发依赖即可加载，结果纳入必需的 CI 汇总检查。

</details>

## 限制

- 此私有工具不发布到 npm，也不生成独立产物。工作流 checkout 必须包含共用锁文件和 workspace 元数据。
- 隔离安装和预检测试不授权生产写入，也不能证明安装包能升级真实客户端。

### 开发备注

无。
