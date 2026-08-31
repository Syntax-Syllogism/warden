---
title: Lifecycle output and snapshots
description: Understand Warden lifecycle reports, assignment labels, action notices, and snapshots.
---

# Lifecycle output and snapshots

This page documents the human-readable output and snapshot data produced by
the user lifecycle commands. Flag and command reference remains in the
[README](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/README.md#commands).

## Resolved user identity

When a lifecycle command resolves a user, the human output starts with the
user's Salesforce identity and then shows the lookup provenance:

```text
Ana Park <apark@acme.com.dev> · 0055g00000ABCDeAAF
  matched Employee_ID__c = E-9981 · was active
```

The `was` state is the state observed before the command ran. A frozen user is
reported as `frozen`; otherwise an inactive user is `inactive`, and an active
user is `active`. If target resolution fails, output falls back to the match
expression and any available Id because there is no resolved user identity to
display.

This applies to `freeze`, `unfreeze`, `strip`, `snapshot`, `restore`, and the
other lifecycle paths that report a resolved target. Matching rules and the
supported target forms are documented in [User matching](user-matching.md).

## Assignment labels and action notices

Assignment names are resolved from Salesforce relationship fields. Human
output prefers the API/developer name and includes the label when it differs:

```text
  action: Removed 2 permission sets
    · Field_Service_Agent (Field Service Agent)
    · Knowledge_Reader
```

The Id remains the fallback when Salesforce does not provide a name or label.
The same resolution is used for permission sets, permission set groups,
public groups, queues, permission set licenses, profiles, and roles in the
human `diff` output. Profile and role changes therefore render as names when
available, while retaining the Id when a relationship name is unavailable.

Assignment item lists are sorted by API/developer name for stable output.
`diff` resolves labels in both persona and user-to-user comparison modes.
Its existing CSV fields continue to contain the underlying values; the
label formatting described here is for human output.

## Action reporting and failures

Dry runs report planned actions using `would...` notices and do not perform
DML. A real run reports an action only after its corresponding DML succeeds.
Flag-only real runs confirm before pending DML unless `--no-prompt` is set or
global JSON output is requested. Interactive runs use their resolved-values
summary confirmation as the single operation gate; they do not ask a second
`--no-prompt`-controlled confirmation.
For partial `allOrNone: false` results, itemized notices contain only the
successful assignments or removals, and the user result is failed if any
requested DML returned an error. Restore activation and unfreeze notices obey
the same rule: a failed `User` or `UserLogin` update is not reported as
completed.

## Snapshot format

`snapshot` writes a version-1 JSON file containing provenance plus one entry
per resolved user. Each entry includes:

* `match`, `matchValue`, and `userId` for locating the user later;
* optional advisory `name`, `username`, `email`, `profile`, and `role` fields
  for review;
* `IsActive` and `IsFrozen` for restoring lifecycle state; and
* sorted, deduplicated developer/API-name arrays for `permissionSets`,
  `permissionSetGroups`, `publicGroups`, `queues`, and
  `permissionSetLicenses`.

Assignments are stored by portable names rather than Salesforce record Ids.
When a relationship name is missing, snapshot generation uses the assignment
Id as a fallback so an assignment is not silently dropped. `restore` resolves
those names in the destination org, warns about missing optional references,
and only adds assignments that are not already present; it does not remove
existing access.

The same snapshot can be written as CSV using an `.csv` output path and read
back by `restore --snapshot`. CSV repeats file metadata on every long-format
assignment row with the columns
`snapshotVersion,capturedAt,org,match,matchValue,userId,userName,username,email,profile,role,isActive,isFrozen,category,name`.
Users with no assignments receive a `none` row. CSV input groups by match,
match value, and user Id, rejects conflicting file metadata, and sorts and
deduplicates reconstructed assignments. The `snapshotVersion` remains `1`.
An empty snapshot writes one `emptySnapshot` row carrying the file metadata,
so an empty JSON snapshot can make the same CSV round-trip as a populated one.
Worked examples are available as [JSON](examples/user-snapshot.json) and
[CSV](examples/user-snapshot.csv).

In `restore --dry-run`, the snapshot identity is shown beside the identity
resolved in the target org. Differences produce warnings rather than failure.
Profile and role comparisons are observations only and are labeled
`(reported, not applied)`.
