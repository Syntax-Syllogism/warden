---
title: sfd operations
description: Run Warden's repeated reads and plan-gated writes through the warm sfd daemon.
---

# sfd operations

This page is for people who already use [`sfd`](https://github.com/Syntax-Syllogism/sfd), a Salesforce CLI front end that keeps a warm local daemon running so repeated commands start fast. You don't need `sfd` to use Warden. Everything here is also available through `sf warden`.

Warden exposes its repeated read commands to the warm `sfd` daemon:

```sh
sfd warden access -o warden-dev --type object --target Account
sfd warden diff -o warden-dev --users-def users.json --fail-on-drift
sfd warden snapshot -o warden-dev --user Username:alice@example.com --out snapshot.json
sfd warden persona diff -o warden-dev --input personas.json
sfd warden persona export -o warden-dev --output personas.json
```

It also exposes the write commands, each as a plan/apply pair:

```sh
sfd warden provision -o warden-dev --users-def users.json --plan
sfd warden provision -o warden-dev --users-def users.json
```

`--plan` is write-free. It returns the preview, warnings, the `effects` the plan
narrows to, and the confirmation hash the host uses when the org's policy asks
for approval. Apply runs exactly the plan it is given and does not re-read the
org to rebuild it. Every write operation is marked `retry: unsafe`, so the host
never retries one automatically after a partial Salesforce update.

| sfd command                     | Effects: ceiling, narrowed by the plan                                                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `warden provision --users-def`  | `org-write`, `destructive`. `[]` with no changes; `destructive` only when a planned action removes.                                                       |
| `warden restore --snapshot`     | `org-write`, `destructive`. `[]` with no changes; `destructive` only when a planned action removes.                                                       |
| `warden freeze`                 | `org-write`. `[]` with no updates.                                                                                                                        |
| `warden unfreeze`               | `org-write`. `[]` with no updates.                                                                                                                        |
| `warden strip`                  | `org-write`, `destructive`, `local-write`. `[]` with no DML and no snapshot; `destructive` for removals or deactivation; `local-write` with `--snapshot`. |
| `warden persona import --input` | `org-write`, `destructive`. `destructive` only with `--prune` and removals.                                                                               |

`provision` writes optional warden-base ledger rows when the ledger object
is available (see [Connected org writes](connected-org-writes.md)). Run and Item
records are sf-only because sfd does not offer `--log-to-org` or `--log-detail`.
Its plan plus `--confirm` flow replaces sf's warning acknowledgement, so
`--no-prompt` is unnecessary under sfd.
`persona import` writes no warden-base records in either path.
`strip --snapshot` writes its snapshot during apply, before its first org DML,
never during `--plan`. In persona mode, persona-assignment and ledger revocation bookkeeping run
for both persona sources (`file` and `org`) when the warden-base records are available.

Confirmation hashes are single use and expire after ten minutes. A changed plan
needs a new approval. The host's safety rules are in sfd's own documentation.

## Failure reporting

Warden requires sfd 0.7.0 or later. `provision`, `restore`, `freeze`,
`unfreeze`, `strip`, `diff`, and `snapshot` report failures through
`ctx.reportFailures(count)`. The write operations report in both plan and
apply. The count is the `summary.failed` that the matching `sf warden` command
checks. A host that supports the call exits 1 when the count is above zero, so
partial failures exit as they do under `sf`. The operation still returns its
preview or result data and warnings. The call is made even when the count is
zero, and the last call wins: an apply that reports 0 overrides a plan that
reported failures.

For `diff --verify`, the count is the number of nonconformant verdicts. In
comparison mode, `diff` reports failed users and also reports drift when
`--fail-on-drift` is set; the flag is ignored in verify mode, matching `sf`.

Freeze and unfreeze plan previews count a `usersDef` row that fails resolution as failed, the same as the `sf` dry run.

`persona import` has no `sf` failure exit to match, so it reports nothing.

## Behavior matches `sf warden`

The `access`, `diff`, `snapshot`, `provision`, `restore`, `freeze`, `unfreeze`, `strip`,
and `persona import` operations run the same shared request modules as their
`sf warden` commands (see [CLI/core architecture](contributing/architecture.md#shared-request-modules-and-sfd)),
so validation, error messages, and result ordering match. The `persona diff`
and `persona export` reads use the persona helpers instead.

File paths (`--users-def`, `--snapshot`, `--input`, `--out`, `--output`) resolve
relative to the calling client's working directory, not the daemon's directory.
If you run the plugin from source, run `yarn build` after changing it: `sfd`
loads `lib/sfd/operations.js`, so an old `lib/` directory runs old operations.

`warden diff --fail-on-drift` exits 1 when its comparison finds drift. Without
the flag, drift is reported in the result but exits 0 unless a user failed.
