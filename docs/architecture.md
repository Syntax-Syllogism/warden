---
title: CLI/core architecture
description: Understand Warden's command layer, core use cases, and compatibility boundaries.
---

# CLI/core architecture

Warden pins `@syntax-syllogism/warden-core` exactly to `0.4.1` in `package.json`
and `yarn.lock`. Core owns access resolution, provisioning rules, lifecycle
operations, user matching, related-record synchronization, and definition parsing.
The plugin owns oclif commands and flags, Salesforce CLI messages, prompts,
file destinations, connected-org audit writes, and Salesforce CLI JSON envelopes.

## Current command paths

| Commands | Execution path |
| --- | --- |
| `freeze`, `unfreeze` | Validate the CLI target, parse core options, call core `plan()`, confirm pending writes, then call `apply()`. Dry runs summarize the planned users without applying. |
| `strip` | Call core `strip.plan()`, confirm pending writes, optionally save the pre-strip snapshot, then call `strip.apply()`. Dry runs return `plan.preview` and still save a requested snapshot. |
| `provision` | Read definitions and the selected persona source, call core `provision.plan()`, acknowledge reference warnings, then apply through the CLI compatibility adapter. Dry runs return `plan.preview`. |
| `restore` | Read the snapshot, call core `restore.plan()`, confirm pending writes, then call `restore.apply()`. Dry runs return `plan.preview`. |
| `access` | Keep CLI scope/target/user validation and stable output ordering; call core `access.run()` for forward and reverse audits. |
| `diff` | Read persona definitions with CLI error mapping; call core `diff.run()` for user/persona comparisons and verification. Keep exit policies in the CLI. |
| `snapshot` | Resolve the selection and retain failed rows; call core `snapshot.run()` with successful targets and write the returned file. |
| `persona export`, `persona import`, `persona diff` | Retain the plugin's org-package integration. |

All eight lifecycle/audit commands use core's public use-case facade. Access and
provision human output uses core renderers; provision supplies the CLI message
lookup, while access uses core's English empty-state text.

## CLI compatibility adapters

`src/userShared/useCaseOptions.ts` maps hyphenated target flags to core options.
It also validates single-user match fields before planning so an unknown field
keeps the existing Salesforce CLI error envelope.

Its `applyProvisionWithLegacyOutput` adapter preserves the CLI's live JSON/CSV
contract where core 0.4.1's apply result differs: related-record failures also
mark the user failed and populate user errors, cross-reference failures retain
candidate diagnostics, and live summary warning counts exclude license
shortfalls. Dry-run license reporting remains in the core preview; see
[Command details](command-details.md#license-headroom).
The provision command reparses user definitions to preserve the legacy CSV
error format without source-row prefixes, and retains the missing-persona-file
validation error.

Snapshot retains CLI selection/error assembly because core rejects partial
selections. It passes successful match expressions as an in-memory user
definition to `snapshot.run()`, which resolves them again and captures the file.
Its separate assignment-state read preserves omitted `isFrozen`
when no UserLogin exists; the core snapshot file defaults that state to false.
Access retains prevalidation to preserve error precedence and resolved user
labels even for empty grant sets. These adapters add org reads.
Restore translates core's missing-reference warnings back to the CLI message
lookup for machine-output parity. Core's failed-row ordering already matches
the legacy command, so no reorder is needed.

`src/userShared/prompting.ts` owns `confirmWithTimeout` (10 seconds by default)
and the shared lifecycle write confirmation. Core plans do not prompt.
Interactive summary confirmations replace the later write confirmation;
global `--json` and `--no-prompt` bypass it. See
[Interactive mode](interactive-mode.md#confirmation).

`src/wardenCommand.ts` translates core errors into the existing Salesforce CLI
error names and keeps a successful JSON envelope's status independent of a
partial-failure process exit code. Output formats and destinations are described
in the [Output contract](output-contract.md).

Before removing an adapter or changing execution paths, compare against
`test/commands/warden/fixtures/core-0.2-output.json` and
`test/commands/warden/fixtures/remaining-command-output.json` using the parity assertions
in `test/commands/warden/outputParity.ts`. The lifecycle, provision, access, and
diff tests compare serialized JSON (including key order) and CSV against those
fixtures; process tests check Salesforce CLI envelopes.
`test/commands/warden/planApply.test.ts` covers
confirmation ordering, bypasses, timeout cleanup, and partial strip snapshots.
