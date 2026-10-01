---
title: Output contract
description: Machine-readable formats, destinations, CSV schemas, and exit codes for Warden.
---

# Output contract

All eight operational `warden` commands accept `--output human|csv|json` and `--output-file <path>`. Human output is the default. The flag reference is in the [README](https://github.com/Syntax-Syllogism/warden/blob/v0.8.0/README.md#commands).

## Formats and destinations

`--output csv` or `--output json` writes the machine-readable payload to stdout. Add `--output-file <path>` to write it to a file instead. Progress, warnings, and confirmations still print to the console as usual. With the default human format, `--output-file` does nothing unless global `--json` is on.

The Salesforce CLI's global `--json` flag is not the same as Warden's `--output json`:

* `--json` alone writes the Salesforce CLI `{status,result,warnings}` envelope to stdout and suppresses confirmation prompts.
* `--json --output csv --output-file <path>` (or `--output json`) writes the Warden payload to the file, and the envelope stays on stdout.
* `--json --output-file <path>` with no non-human `--output` writes the envelope to both stdout and the file.
* `--json` with `--output csv` or `--output json` and no `--output-file` is an error.

Direct machine output does not suppress confirmations on commands that change data. For an unattended run, use global `--json`.

`-i`/`--interactive` is a separate guided mode. It needs a TTY on standard input and can't be combined with global `--json`. Warden rejects that combination before prompting. In interactive mode, the summary confirmation is the only confirmation, even for commands that change data. See [Interactive mode](interactive-mode.md).

## Exit codes

* `0`: the command finished with no per-user failures.
* `1`: one or more users failed in `provision` or a lifecycle command, or the command itself errored (oclif also uses `1`).
* `access` has no per-row failure, so it returns `0` unless it can't run.
* `diff` returns `1` for per-user failures. `--fail-on-drift` (off by default) also returns `1` when any user has drift. `diff --verify` returns `1` when any user is non-conformant, by setting `process.exitCode = 1` after it renders the verdicts.

Exit codes don't change the result payload. With global `--json`, a partial failure or non-conformant verify result keeps `status: 0` in the Salesforce CLI envelope while the process exits with `1`. Verify mode's result is still the full verdict array.

## CSV shape

CSV rows are the same on every run and share one escaping rule.

* **`access`** keeps its first eight columns (`userId`, `userName`, `username`, `assignmentType`, `sourceId`, `sourceName`, `viaPermissionSetId`, `viaPermissionSetName`). It adds `targetType`, `targetName`, `sourceApiName`, and `sourceLabel`, then target-specific access columns.
* **`diff`** adds `userName,username,valueApiName,valueLabel,valueType,valueBefore,valueAfter` after its original six columns. `diff --verify` uses `key,conformant,violations` instead.
* **`provision`** writes one row per action, related-record result, or error, with `userKey,userId,userName,username,personas,matchedBy,status,action,detail,error`. Details are below.
* **`freeze` and `unfreeze`** write one row per user: `userKey,userId,userName,username,wasFrozen,status,action,error`.
* **`restore`** writes one row per action or action item: `userKey,userId,userName,username,status,action,category,name,error`.
* **`strip`** writes one row per action or removed item: `userKey,userId,userName,username,status,action,category,itemId,itemApiName,error`.
* **`snapshot`** writes `key,id,status,actions,skipped,warnings,errors`, one row per selected user. This report is separate from the snapshot file that `--out` writes.

For lifecycle commands, a user with no actions still gets a row, and each error gets its own row. On CSV write, cells that start with `=`, `+`, `-`, `@`, a tab, or a carriage return get an apostrophe prefix. This protects spreadsheet viewers. It isn't applied to JSON or human output.

When CSV goes to stdout, access statistics and warnings stay out of it. When CSV goes to a file, the file holds only the CSV.

### Provision details

**Related records.** Related rows use the same ten columns. `action` is `related`, `detail` is `<relationship> <phase> <sobject> <related-action>`, and `error` holds any related-record failure. In JSON, user actions are unchanged, and `users[].relatedRecords[]` is added for selected relationships. Each entry has `relationship`, `phase`, `sobject`, `action`, `status`, and, when available, `recordId`, `detail`, and `error`.

* Dry-run actions are `wouldCreate`, `wouldUpdate`, or `wouldSkip`. An unchanged matched row is `matched`.
* Live actions are `created`, `updated`, `matched`, or `skipped`.

**Match fields.** Provision JSON also carries:

* `users[].matchValue`, the value looked up under `matchedBy`. It is `null` when no lookup was made, because the value was absent, empty, or not a string.
* `users[].matched`, whether an existing user was found.

`matchedBy` only says a match field was configured, so it can't tell you whether an existing user was found. Use `matched` for that. Human output combines the two as `matched <field> = <value>` or `unmatched <field> = <value>`, and prints bare `unmatched` when no match field was set. CSV still carries only `matchedBy`.
