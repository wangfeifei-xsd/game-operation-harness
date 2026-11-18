---
description: "Inspect and edit live plugin configuration through Config-derived forms."
kind: "package-reference"
---

# @deepseek-ai/dsh-settings

English | [中文](README.zh.md)

## Summary

Edit fields that plugins declare with `.volatile()` and inspect their effective values. Forms identify each plugin by its profile entry id, preserve secret values, and refuse stale writes. Changes persist through the active profile’s Cordis patch or its configured account preference file.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this plugin with Loader and a profile context. Add [config-editor](../../boot/config-editor/README.md) for profile writes, or configure an isolated preference document for a fixed deployment. Without either, forms describe live values with `writable: false`, omit editable layers, and refuse mutations and document access.

```yaml
- id: settings
  name: '@deepseek-ai/dsh-settings'
```

Forms expose only volatile fields from active, uniquely addressed profile entries. Ordinary configuration remains editable through Cordis configuration files.

For a fixed deployment, set `preferencesPath` to an account-owned JSON file and `preferencesNamespaces` to the entry ids allowed to save preferences. Writes validate the full Config, serialize revision checks and atomic persistence, and update live references without loading user patches or changing plugin composition. Other entries remain readable with namespace-level `writable: false`. Without preferences mode, an existing account-home `preferences.json` is imported into the active profile after Loader startup; explicit profile values win, and the source is renamed to `preferences.json.imported` only after every section is saved. Saved preferences in preferences mode restore after Loader startup; malformed files or nonvolatile fields fail visibly and are preserved for repair.

With the editor mounted, once the Loader has settled every entry after Settings starts, a `settings.yaml` left in the harness home by earlier releases is imported once: each section is written into the entry of the same id (`ui-developer-tools` → `ui-settings`, `ui-onboarding` → `ui-settings-general`, `shell` → the platform's shell executor entry), the file is renamed to `settings.yaml.imported` before the first write, and a section the running composition rejects is logged and stays only in the renamed file.

Reset restores the value beneath the profile override, including schema defaults. Home patches and command-line overlays take precedence; a form write that they would override is refused.

Each form reports `autoGenerate`, enabled by default, for clients that build pages from the schema; no shipped client does so yet. A plugin that ships its own page registers `configure({ auto: false }, ctx.fiber)` as an effect inside an optional `ctx.inject(['settings'], ...)` child from `apply`: the child names the plugin fiber the policy belongs to, a late-loading or replaced Settings service picks the policy up, and the business plugin runs without Settings. The policy does not remove configuration reads or writes.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [form projection](src/schema.ts) strips runtime references and ordinary fields. The [service](src/index.ts) supplies revisioned descriptors and validates edits against the full plugin Config before delegating persistence. Business plugins read their Config references directly.

Secret roles are redacted from values, inherited values, profile overrides, and schema defaults; clients receive presence markers. Path edits preserve fields a client did not receive.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Settings reference](../../../docs/subsystems/settings.md) — form values and mutations.
- [Volatile configuration](../../../vendor/loader/README.md) — reference lifetime and notifications.
- [Configuration editor](../../boot/config-editor/README.md) — persistence and reload ordering.

<a id="model-experience"></a>
## Model Experience

Indirectly, through configuration values consumed by model-facing plugins.

#### KV Cache effect

Consumers that change request prefixes determine cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Nested Includes own separate configurations and are not editable through the active profile’s form.
- Field-level resets restore inherited values; they cannot delete a value supplied by a lower configuration layer. Unsetting an array index removes that element.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
