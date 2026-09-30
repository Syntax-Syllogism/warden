---
title: Lifecycle output and snapshots
description: Understand Warden lifecycle reports, assignment labels, action notices, and snapshots.
---

# Lifecycle output and snapshots

This page describes what the lifecycle commands print and what a snapshot file contains. For flags, see the [README](https://github.com/Syntax-Syllogism/warden/blob/v0.7.1/README.md#commands).

## Resolved user identity

When a lifecycle command finds a user, its human output starts with who they are, then shows how they were found:

```text
Ana Park <apark@acme.com.dev> · 0055g00000ABCDeAAF
  matched Employee_ID__c = E-9981 · was active
```

`was` is the user's state before the command ran: `frozen` if they were frozen, otherwise `inactive` or `active`. If Warden can't find the user, there's no identity to show, so the output falls back to the match expression and any Id it has.

This applies to `freeze`, `unfreeze`, `strip`, `snapshot`, `restore`, and any other lifecycle path that reports a resolved user. See [User matching](user-matching.md) for how users are found.

## Assignment labels and action notices

Warden reads assignment names from Salesforce relationship fields. Human output shows the API or developer name, and adds the label when it differs:

```text
  action: Removed 2 permission sets
    · Field_Service_Agent (Field Service Agent)
    · Knowledge_Reader
```

If Salesforce provides no name or label, the Id is shown. Human `diff` output resolves names the same way for permission sets, permission set groups, public groups, queues, permission set licenses, profiles, and roles, so profile and role changes appear as names when possible. Lists are sorted by API or developer name so output is stable. `diff` resolves labels in both persona and user-to-user modes. Its CSV fields still hold the underlying values, since label formatting applies to human output only.

## Action reports and failures

* A dry run reports planned actions as `would...` notices and makes no changes.
* A real run reports an action only after its DML succeeds.
* Flag-only real runs ask for confirmation before changing anything, unless you set `--no-prompt` or use global JSON output. Interactive runs use their summary confirmation as the only gate and don't ask again.
* For partial `allOrNone: false` results, itemized notices list only the assignments or removals that succeeded, and the user's result is marked failed if any DML returned an error.
* Restore's activation and unfreeze notices follow the same rule. A failed `User` or `UserLogin` update is never reported as done.

## Snapshot format

`snapshot` writes a version-1 JSON file with provenance and one entry per user. Each entry has:

* `match`, `matchValue`, and `userId`, to find the user later;
* optional `name`, `username`, `email`, `profile`, and `role`, for review only;
* `IsActive` and `IsFrozen`, to restore lifecycle state; and
* sorted, deduplicated developer/API-name arrays for `permissionSets`, `permissionSetGroups`, `publicGroups`, `queues`, and `permissionSetLicenses`.

Assignments are stored by name, not Id, so they're portable. If a name is missing, the snapshot uses the Id so the assignment isn't silently dropped. `restore` resolves the names in the destination org, warns about missing optional references, and adds only the assignments that aren't already there. It never removes access.

A `.csv` output path writes the same snapshot as CSV, and `restore --snapshot` reads it back. CSV has one row per assignment and repeats the file metadata on every row:

```text
snapshotVersion,capturedAt,org,match,matchValue,userId,userName,username,email,profile,role,isActive,isFrozen,category,name
```

* A user with no assignments gets a `none` row.
* Reading CSV groups rows by match, match value, and user Id, rejects conflicting file metadata, and sorts and deduplicates assignments. `snapshotVersion` stays `1`.
* An empty snapshot writes one `emptySnapshot` row that carries the file metadata, so an empty JSON snapshot round-trips through CSV like any other.

Examples: [JSON](examples/user-snapshot.json) and [CSV](examples/user-snapshot.csv).

In `restore --dry-run`, the snapshot's identity appears next to the identity found in the target org. Differences are warnings, not failures. Profile and role comparisons are for information and are marked `(reported, not applied)`.
