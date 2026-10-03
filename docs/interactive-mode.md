---
title: Interactive mode
description: Use Warden's guided flag prompts to collect, review, and confirm command inputs.
---

# Interactive mode

All eight `sf warden` commands accept `-i`/`--interactive`: `access`, `diff`, `freeze`, `provision`, `restore`, `snapshot`, `strip`, and `unfreeze`.

Interactive mode asks for the flags you didn't pass. Anything already on the command line is kept. Warden uses text, select, confirm, or checkbox prompts as fits each flag. When it has everything, it prints the resolved values and asks `Proceed with these values?` once. If you decline, it prints `Operation cancelled.`, returns an empty result, and makes no changes and writes no snapshot `--out` file.

After you confirm, the command runs exactly as it would with flags only. Interactive mode doesn't change user matching, definition-file validation, access resolution, or output schemas.

## Requirements

* Standard input must be a TTY.
* You can't combine `-i` with the global `--json` flag, which is meant for unattended runs.

Warden checks both before it prompts. `--output json` is a different flag and works with `-i` as long as its output-file requirements are met. See the [output contract](output-contract.md) for the difference.

If a default org resolves, interactive mode uses it and shows it in the summary. Otherwise it asks for an org alias or username. To use a different org than the default, pass `--target-org`.

## What each command asks

Prompts depend on your earlier answers, so you're never asked about flags that don't apply.

| Command | What it asks |
| --- | --- |
| `access` | A target audit or a user audit. A user audit then asks for a target or an SObject scope. `--sobject` is offered only for field and object audits. If you pass `--sobject`, only those two types are offered, and any other `--type` is rejected before the first prompt. Then the access type and the target or user. |
| `diff` | A two-user comparison or a users-definition/persona comparison. The branch decides whether Warden asks for `--against` or for definition-file, matching, format, verify, and drift options. Flags you pass pick the branch, and contradictory flags fail before the summary. |
| `freeze`, `unfreeze` | One user (`field:value`) or a users-definition file, then the matching options and `--dry-run`. |
| `provision` | The users-definition file, an optional persona file, matching and format options, an optional related-record catalog (JSON input only), then fuzzy-Username, dry-run, and insufficient-license choices. |
| `restore` | The path to an existing snapshot, and `--dry-run`. |
| `snapshot` | One user or a users-definition file, the matching options, and `--out`, with a timestamped JSON path as the default. |
| `strip` | One user or a users-definition file, one checkbox for the freeze, deactivate, and access steps to skip, then an optional snapshot path and `--dry-run`. Skip flags you pass stay selected. |

Wherever a users-definition file is asked for, Warden picks JSON or CSV from the file extension when it can, and asks otherwise.

Other details:

* Paths that must already exist are checked before the summary.
* `--output` and `--api-version` are also prompted for when you didn't pass them. A resolved `--api-version` default is offered, and what you type is checked by the same parser as the flag.
* `--csv-list-delimiter` is asked only for CSV users-definition input. Otherwise it stays `;`.
* Optional text answers can be left blank.
* `provision -i` does not prompt for cleanup on failure. Pass
  `--cleanup-on-failure` explicitly to enable it; otherwise it stays off. See
  [Related-record cleanup](related-records.md#cleanup-on-failure) for eligibility
  and retained-record rules.

`diff -i` is stricter than a plain `diff` in one case. It rejects `--user` or `--against` combined with a persona-mode flag such as `--input-format` or `--csv-list-delimiter`. A plain run silently ignores those flags, but interactive mode has to settle the branch before it can decide what to ask.

## Confirmation

The summary confirmation is the only gate for an interactive run. For `freeze`, `unfreeze`, `restore`, `strip`, and `provision`, it replaces the normal confirmation that `--no-prompt` controls. You won't get a second prompt. `--dry-run` still stops writes after you confirm.

Without `-i`, nothing changes. For unattended runs, use `--no-prompt` or the global `--json` flag, as described in the [output contract](output-contract.md).

## Examples

A fully guided provisioning run:

```bash
sf warden provision -i
```

A guided access audit with the org and type already set:

```bash
sf warden access -i --target-org myOrg --type field
```

A guided strip that also asks for a dry run before the final confirmation:

```bash
sf warden strip -i --target-org myOrg --dry-run
```
