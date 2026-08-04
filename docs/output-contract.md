---
title: Output contract
description: Machine-readable formats, destinations, CSV schemas, and exit codes for Warden.
---

# Output contract

All eight operational `warden` commands accept `--output human|csv|json` and
`--output-file <path>`. Human output is the default. The generated flag
reference is in the [README](https://github.com/Syntax-Syllogism/warden/blob/v0.2.5/README.md#commands).

## Formats and destinations

Use `--output csv` or `--output json` to write the selected machine-readable
payload to stdout. Add `--output-file <path>` to write that payload to a file;
the command keeps its normal human-readable progress, warning, and
confirmation behavior on the console. `--output-file` has no effect with the
default human format unless global `--json` is also enabled.

The global Salesforce CLI `--json` flag is separate from warden's
`--output json` format:

* `--json` alone writes the Salesforce CLI `{status,result,warnings}` envelope
  to stdout and suppresses interactive confirmation prompts.
* `--json --output csv --output-file <path>` or
  `--json --output json --output-file <path>` writes the selected warden
  payload to the file while the global envelope remains on stdout.
* `--json --output-file <path>` without a non-human `--output` writes the
  global envelope to both stdout and the file.
* Combining `--json` with `--output csv` or `--output json` without
  `--output-file` is an error.

Direct machine output does not suppress mutating-command confirmations. Use
global `--json` when a non-interactive run is required.

## Exit codes

Commands return `0` when they complete without per-user failures. The
provisioning and lifecycle commands return `1` when one or more users fail.
`access` has no per-row failure state and returns `0` unless the command
itself cannot run. `diff` returns `1` for per-user failures and also supports
`--fail-on-drift`, which returns `1` when any user has drift; the flag is off
by default. `diff --verify` returns `1` when any user is non-conformant and
uses `process.exitCode = 1` after rendering its verdicts.

These signals do not change the result payload. With global `--json`, a
partial failure or non-conformant verify result therefore keeps `status: 0`
in the Salesforce CLI envelope while the process exits with code `1`; verify
mode's result remains the full verdict array. Command errors use oclif's exit
code `1` as well.

## CSV shape

CSV rows are deterministic across runs and use one shared escaping and
serialization rule.

* `access` retains its first eight columns (`userId`, `userName`, `username`,
  `assignmentType`, `sourceId`, `sourceName`, `viaPermissionSetId`, and
  `viaPermissionSetName`) and adds `targetType`, `targetName`,
  `sourceApiName`, and `sourceLabel`, followed by target-specific access
  columns.
* `diff` appends `userName,username,valueApiName,valueLabel,valueType,
  valueBefore,valueAfter` after its existing six columns.
  `diff --verify` instead uses `key,conformant,violations`.
* `provision` emits one row per action or error with
  `userKey,userId,userName,username,personas,matchedBy,status,action,detail,error`.
* `freeze` and `unfreeze` emit one row per user with
  `userKey,userId,userName,username,wasFrozen,status,action,error`.
* `restore` emits one row per action or action item with
  `userKey,userId,userName,username,status,action,category,name,error`.
* `strip` emits one row per action or removed item with
  `userKey,userId,userName,username,status,action,category,itemId,itemApiName,error`.
* `snapshot` emits `key,id,status,actions,skipped,warnings,errors`, one row per
  selected user. This report CSV is separate from the JSON snapshot file
  written with `--out`.

For lifecycle commands, users with no actions still produce one row and each
error produces its own row. Formula-like cells are prefixed with an apostrophe
on CSV write (`=`, `+`, `-`, `@`, tab, and carriage return); this is an output
safety measure for spreadsheet viewers and is not applied to JSON or human
output.

Access statistics and warnings remain outside CSV stdout when CSV is written
directly to stdout. When CSV is written to a file, the file contains only the
CSV payload.
