---
title: sfd operations
description: Run Warden's repeated reads and plan-gated writes through the warm sfd daemon.
---

# sfd operations

Warden exposes its repeated read commands to the warm `sfd` daemon:

```sh
sfd warden access -o warden-dev --type object --target Account
sfd warden diff -o warden-dev --users-def users.json
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

| sfd command                     | Effects: ceiling, narrowed by the plan                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `warden provision --users-def`  | `org-write`, `destructive`. `[]` with no changes; `destructive` only when a planned action removes. |
| `warden restore --snapshot`     | `org-write`, `destructive`. `[]` with no changes; `destructive` only when a planned action removes. |
| `warden freeze`                 | `org-write`. `[]` with no updates.                                                                  |
| `warden unfreeze`               | `org-write`. `[]` with no updates.                                                                  |
| `warden persona import --input` | `org-write`, `destructive`. `destructive` only with `--prune` and removals.                         |

`provision` skips the optional connected-package ledger and Run records that
`sf warden provision` can write (see [Connected org writes](connected-org-writes.md)).
When the package is detected, the operation emits a notice saying so.
`persona import` writes no connected-package records in either path.

Confirmation hashes are single use and expire after ten minutes. A changed plan
needs a new approval. The host's safety rules are in sfd's own documentation.

## Failure reporting

`provision`, `restore`, `freeze`, and `unfreeze` report per-user failures through
`ctx.reportFailures(count)`, in both plan and apply. The count is the
`summary.failed` that the matching `sf warden` command checks. A host that
supports the call exits 1 when the count is above zero, so partial failures exit
as they do under `sf`. The operation still returns its preview or result data
and warnings. The call is made even when the count is zero, and the last call
wins: an apply that reports 0 overrides a plan that reported failures.

Hosts without `reportFailures` (older sfd) ignore the call. On those hosts these
operations exit 0 even when users fail.

Freeze and unfreeze plan previews use `summarizeLifecycle` over the resolved
users, the same summary as the `sf` dry run. A `usersDef` row that fails
resolution therefore counts as failed in the preview. The preview previously
hard-coded `failed: 0`.

Not yet covered: `diff` and `snapshot` have no failure reporting. Their `sf`
commands exit 1 on nonconformance or failed users, but the sfd operations
still exit 0. `persona import` has no `sf` failure exit to match, so it reports
nothing.

## Milestone 1 loop

Run the following against a disposable scratch org. The write steps should use
the warm daemon's `--plan` result before applying; a production-policy run must
be confirmed with a fresh hash and cannot reuse it. Use a one-user definition
whose persona and references exist in that org; the stock test fixture is not
portable to every scratch org.

```sh
sfd warden snapshot -o warden-dev --users-def review-users.json --out snap.json
sfd warden provision -o warden-dev --users-def review-users.json --persona-source org --plan
sfd warden provision -o warden-dev --users-def review-users.json --persona-source org
sfd warden access -o warden-dev --type object --target Account --user Username:<user>
sfd warden persona export -o warden-dev --output review-personas.json
sfd warden diff -o warden-dev --users-def review-users.json --personas-def review-personas.json
sfd warden restore -o warden-dev --snapshot snap.json
SFD_POLICY=policy-production.json sfd warden provision -o warden-dev --users-def review-users.json --persona-source org
SFD_POLICY=policy-production.json sfd warden provision -o warden-dev --users-def review-users.json --persona-source org --confirm <fresh-plan-hash>
```

### Recorded transcript

Recorded on 2026-11-06 with local `sfd` 0.6.2, an isolated daemon loading this
worktree's plugin, and scratch org `warden-dev`. The scratch-only definition
matched `ava.martinez@warden-demo.example` to the active `support` persona.
The `persona export` before `diff` supplied the org's current definitions; it
is a local-write read and exited 0.

| Command                   | Exit | Wall time | Result                                                 |
| ------------------------- | ---: | --------: | ------------------------------------------------------ |
| `warden snapshot`         |    0 |    3.52 s | Captured Ava's state.                                  |
| `warden provision --plan` |    0 |    2.77 s | Write-free preview: 3 `org-write` changes.             |
| `warden provision`        |    0 |    5.98 s | Applied the three planned changes.                     |
| `warden access`           |    0 |    3.53 s | Reported Ava's Account access.                         |
| `warden diff`             |    0 |    1.56 s | Compared one user; zero changes.                       |
| `warden restore`          |    0 |    1.35 s | No lifecycle updates were needed by its snapshot plan. |

The matching cold commands were also timed on the same org: `sf warden access`
took 6.57 s, compared with the warm `sfd warden access` 3.53 s above; `sf
warden provision --dry-run` took 4.49 s. Both cold commands exited 0.

For the policy check, `SFD_POLICY` classified `warden-dev` as `production`.
The write-free plan for a separate scratch user returned `ask`, `org-write`,
and hash `de6f9f4a13a3`. Applying without `--confirm` exited 4 in 2.39 s.
Applying with that fresh hash exited 0 in 6.51 s and made the four planned
changes. A subsequent attempt to present that consumed hash for a newly
planned user exited 4 in 2.89 s and returned a new hash (`556fca8ef844`);
it did not apply a write.

The `access`, `diff`, `snapshot`, `provision`, `restore`, `freeze`, `unfreeze`,
and `persona import` operations run the same shared request modules as their
`sf warden` commands (see [CLI/core architecture](architecture.md#shared-request-modules-and-sfd)),
so validation, error messages, and result ordering match. The `persona diff`
and `persona export` reads use the persona helpers instead. The operation
definitions live in `src/sfd/operations.ts`, and the static command table in
`cli.json`.

File paths (`--users-def`, `--snapshot`, `--input`, `--out`, `--output`) resolve
relative to the calling client's working directory, not the daemon's directory.
Rebuild with `yarn build` after changing the adapter: plugin discovery loads
`lib/sfd/operations.js`, so an old `lib/` directory runs old operations.

`warden diff` deliberately does not expose `--fail-on-drift` through `sfd`.
The current runtime has no warning-to-exit-code contract, so exposing it would
silently return success when drift is found. Add the flag when that host
contract exists.

## Timing

Measured on 2026-11-05 with local `sfd` 0.5.4, Node 24.14.0, and five
wall-clock samples per case. Cold calls used `sf warden access`; warm cases
used the local `sfd` checkout with the worktree plugin. Warm and alternating
cases followed one warm-up call. `warden-gate` was recreated from
`warden-app/config/project-scratch-def.json` because its previous scratch org
had expired. The idle-out samples use a 60 ms plugin-worker idle setting and
measure the following first call.

| Measurement                                        | Median | Maximum |
| -------------------------------------------------- | -----: | ------: |
| Cold `sf warden access` on `warden-dev`            | 5.52 s |  5.78 s |
| Warm `sfd warden access` on `warden-dev`           | 1.61 s |  1.73 s |
| Alternating warm `warden-dev` / `warden-gate` pair | 3.41 s |  3.48 s |
| First `sfd` call after plugin-worker idle-out      | 2.42 s |  2.89 s |
