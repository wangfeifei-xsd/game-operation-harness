---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-20-business-assistant-attribution

English | [中文](2026-11-20-business-assistant-attribution.zh.md)

## Summary

Add the business assistant principal to prompt attribution in the persisted inbox, messages, and Session title request. Keep the V4 format.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

The writer keeps the existing user and retry source kinds. The V4 reader preserves the principal JSON of these sources without loading the business assistant plugin, so older readers retain the message and its attribution. New readers retain existing principal variants and continue to accept messages with no principal. Persisted attribution cannot authorize a request. The Host checks the live peer and lease.

<a id="verification"></a>
## Verification

Ran `pnpm exec vitest run packages/session/session-persistence-jsonl/tests/native-source-admission.spec.ts`. All 40 tests passed. The compatibility cases read V4 rows with and without the new principal through the unchanged reader, in read and write mode with both JSONL encodings, preserving the events and the original bytes.

<a id="dev-note"></a>
## Dev Note

None.
