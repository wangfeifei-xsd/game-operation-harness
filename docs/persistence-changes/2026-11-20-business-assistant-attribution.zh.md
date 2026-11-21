---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-20-business-assistant-attribution

[English](2026-11-20-business-assistant-attribution.md) | 中文

## 概述

加入业务助手主体，标记持久化收件箱、消息和会话标题请求中的提示词来源。保留 V4 格式。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-20-business-assistant-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-05-timeline-priority-notice"
    after: "8ceba02e7bce865f42436863273e4338d8b29a7bb00991b6695dbef4740cb58f"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "d6b07e7ae30af9492482386001f8deadd3421bfbb27290d9750256b4dd03057c"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-05-timeline-priority-notice"
    after: "3b45ac816638828d4952a96532e6c72e9e75205438aae94f32a681a6f212c5bb"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-05-timeline-priority-notice"
    after: "9b2cd3c366701fa647c4068d66e3ad3116974f374bcc77eac011759b40ec0d9e"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

写入端保留原有的用户和重试来源类型。V4 读取器无需加载业务助手插件即可保留这些来源的主体 JSON，旧版读取器因此能保留消息和来源。新版读取器保留现有主体类型，也继续接受没有主体的消息。持久化来源不能授予请求权限。Host 检查当前连接的身份和租约。

<a id="verification"></a>
## 验证

运行了 `pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts`。40 个测试全部通过。兼容用例通过未修改的读取器，分别以读写模式读取两种 JSONL 编码下含有或不含新主体的 V4 记录，保留了事件和原始字节。

<a id="dev-note"></a>
## 开发备注

无。
