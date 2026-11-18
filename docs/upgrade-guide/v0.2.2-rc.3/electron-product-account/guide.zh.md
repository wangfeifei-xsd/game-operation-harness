---
kind: upgrade-guide
description: "Electron 现在要求 Creativity 产品登录，并使用账号目录及产品分发配置。"
---
# Electron 要求产品账号

[English](guide.md) | 中文

## 变更

Agent 助手替代上游桌面欢迎页和 API Key 登录。主进程必须先完成 Creativity 认证，才启动私有 Host。产品 Token 只保存在内存，退出应用和更新重启后重新登录；模型供应商凭据不能授权产品访问。

Web/PWA 与 Desktop 通过独占锁共用环境/账号目录。受保护的 `desktop` profile 支持用户 overlay、HMR、插件安装和配置编辑；中央认证在可编辑插件树之前安装。旧 `~/.dsh` 数据和上游安装身份保持各自独立归属。

部署文件现在要求 `desktop` 应用身份、协议、下载索引与更新设置，只开放 `stable` 频道。master 使用 `agent-assistant://open`，其他环境使用 `agent-assistant-<environment>://open`；旧 `dsh://open` 链接不再定位本产品。

## 迁移

1. 切换前退出旧 Web 与 Desktop 实例并备份数据。配置选定的 `config/environments/<environment>.json`，包括匹配的 Creativity 部署标识。详见[配置](../../../harness-product.zh.md#configuration)及[Desktop](../../../../apps/desktop/README.zh.md)。
2. 以显式环境启动 Desktop，或安装携带该部署的安装包。注册或登录 Creativity 账号，再在账号内配置模型；不要复制上游 Token，也不使用 `DSH_HOME` 选择产品存储。
3. 同一账号在另一入口打开之前，先停止当前入口。本机复用既有 Harness 账号数据；旧目录迁移来源不明确时，登录停止且不合并。备份并保留唯一权威目录后重试。
4. 正式发布前配置产品自有 HTTPS 下载/更新地址和真实签名身份，将协议链接改为所选产品协议。强制策略关闭时保持关闭，不使用上游飞书策略认证。
5. 确认冷启动只显示登录页、没有账号 Host，登录成功后进入正确账号，退出后 Host 停止，重启后回到登录页。下载索引未发布时，不应出现安装包链接。
6. 将自定义依赖和补丁保留在 `profiles/desktop`。已有账号偏好迁入当前 profile。核对插件安装、设置保存及重载后账号和模型配置仍然有效；遥测遵循已配置的退出开关和平台条件。
