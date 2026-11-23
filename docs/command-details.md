---
title: Command details
description: How warden diff, access, snapshot, restore, freeze, unfreeze and strip behave.
---

# Command details

This page is for admins and developers who run Warden against real orgs. It explains how the audit and lifecycle commands behave. New to Warden? Read [Getting started](getting-started.md) first. For flags, see the [CLI reference](cli-reference.md) or run a command with `--help`. Output formats, CSV columns, destinations, and `--json` are in the [output contract](output-contract.md).

Provisioning rules and the example definition files are on the [Provisioning](provisioning.md) page.

## Org-defined personas and promotion

See [Persona promotion](persona-promotion.md) for how the org source is chosen, how components map, and the `persona export`, `persona import`, and `persona diff` workflows.

## `warden diff`

`diff` resolves references the same way `provision` does when you pass `--personas-def`, but it never writes. It only reports what would change.

- Omit `--personas-def` for a profile-only audit, when each row supplies its own profile or role. The result then holds profile and role drift only, with no assignment rows.
- Use `--user` and `--against` to compare two live users directly. That mode needs no definition files.
- Use `--fail-on-drift` to make `diff` a CI gate. It exits with `1` when any user has drift, and it's off by default. See the [output contract](output-contract.md#exit-codes) for how it interacts with per-user failures and `--json`.

### Assignment delta buckets

Each assignment category in `users[].assignments` has four arrays: `adds`, `removes`, `inBoth`, and `onlyInOrg`. The `rows[]` result expands the same buckets into one row per value. `onlyInOrg` never overlaps `removes`. An assignment is `onlyInOrg` only when it is extra in the org and isn't also being removed.

So an extra assignment shows up only in `removes` in a user-to-user comparison, and for a persona category in `sync` mode. In persona `additive` mode, extras are kept, so they stay in `onlyInOrg` and produce `onlyInOrg` rows. This keeps arrays and rows consistent and reports each assignment once.

### Verify mode

`--verify` with `--users-def` turns the diff into a conformance check. `--personas-def` is optional when you verify profile-only definitions. You get one verdict per user, with `key`, `conformant`, and `violations`.

- Missing intended assignments and profile or role mismatches are violations.
- Extra assignments are violations only in `sync` categories.
- A user missing from the org is reported as `user not found`.
- Human output prints a conformant/non-conformant summary and a block per violation. `--output json` and global `--json` return the verdict array. `--output csv` uses the columns `key,conformant,violations`.
- If any verdict is non-conformant, Warden sets `process.exitCode = 1` after rendering. Global JSON output stays available to CI with the normal successful envelope status.
- `--verify` can't be used with `--user` or `--against`.

To verify a profile-only definition without assignment expectations:

```bash
sf warden diff --users-def ./users-profile-only.json \
  --verify --target-org acme-uat
```

## `warden access`

See [Access audits](access-audits.md) for scopes, attribution, muting, limits, and examples. The command is read-only, and [the output contract](output-contract.md) covers its output. Record-type audits need a qualified `SObject.DeveloperName` target. They read Profile, PermissionSet, and candidate PSG `MutingPermissionSet` metadata through the Metadata API, which adds latency. Reads cover only active-user sources and fail closed if metadata is incomplete. A matching muting entry suppresses only the PSG path. User record-type audits need an explicit target and don't support `--sobject`.

## `warden snapshot` / `warden restore`

A snapshot records each user's active/frozen state and assignments by developer/API name, falling back to Id when a name is unavailable. Names make assignments portable across orgs that share them; fallback Ids are org-specific. Each entry can also record the resolved `name`, `username`, `email`, `profile`, and `role` for review. Profile and role appear by name when known, or by Id otherwise. `restore` never applies them.

`restore` finds users again by the snapshot's match key, reactivates and unfreezes them, and only **adds** missing assignments. It never removes access a user already has. If you want a rollback point before something destructive, use `--snapshot` on `strip` and `restore` later. You don't need a separate `snapshot` step.

The output file extension picks JSON or CSV, and `restore` reads either. The file fields and the CSV layout are in [Snapshot format](lifecycle-output.md#snapshot-format).

With `--dry-run`, `restore` shows the identity recorded in the snapshot next to the identity it found in the org, and warns about mismatches. Profile and role lines are marked `(reported, not applied)`.

[Lifecycle output and snapshots](lifecycle-output.md) also covers the identity line, assignment labels, and itemized action reports.

## `warden freeze` / `warden unfreeze` / `warden strip`

`freeze` and `unfreeze` change only `UserLogin.IsFrozen`. Nothing else changes.

`strip` does all of it in order: freeze, remove access grants, then deactivate. You can skip a step with `--no-freeze`, a `--keep-*` flag, or `--no-deactivate`. Use `--snapshot` on `strip` to save a restorable snapshot before any write. The file is written even with `--dry-run`, so you can capture and inspect the pre-strip state without touching the org.

### Persona-scoped removal

`strip --persona <api-name>` (repeatable) removes only access granted by those personas; `--all-personas` selects every active persona held by each user. A target also granted by a persona the user keeps is reported as kept and is not removed. Persona mode does not freeze or deactivate by default; add `--freeze` and/or `--deactivate` when that is intended. Permission-set licenses are not persona grants and are left alone in this mode.

Use `--persona-source file --personas-def personas.json` with persona names in the users definition, or `--persona-source org` to read both definitions and active assignments from warden-base in the org. A single `--user` with the file source must also provide `--users-def` so Warden can determine that user's held personas.

```bash
sf warden strip --user username:someone@example.com --persona support \
  --persona-source org --dry-run --target-org myOrg

sf warden strip --users-def users.json --personas-def personas.json --all-personas \
  --freeze --snapshot snapshots/pre-revoke.json --target-org myOrg --no-prompt
```

When the package exposes the revocation fields, live persona removal marks its active persona assignments `Revoked`, records successful target rows in the package ledger, and creates a `Revoke` reconciliation run. Older package versions are detected with describe calls and leave these audit writes out with a warning. The record details are in [Connected org writes](connected-org-writes.md#persona-revocation-writes).
