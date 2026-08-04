---
title: Command details
description: Detailed provisioning, assignment, matching, and output behavior for Warden commands.
---

# Command details

Deeper logic notes for warden's more involved commands. Flag-by-flag
reference lives in the [README](https://github.com/Syntax-Syllogism/warden/blob/v0.2.3/README.md#commands) and in each command's
`--help` output; this doc covers the *why* and the *merge/precedence rules*
that don't fit in a flag summary.

Output formats, file destinations, CSV shape, and global `--json` interaction
are documented in the [output contract](output-contract.md).

## CSV row schemas

CSV is item-grained where a command changes or reports individual access
records. Columns are stable and new columns are appended to existing schemas.

| Command | One row | Columns |
| --- | --- | --- |
| `access` | one grant | existing 12 columns, then access flags for the target type |
| `diff` | one delta | `userKey,userId,category,kind,value,mode,userName,username,valueApiName,valueLabel,valueType,valueBefore,valueAfter` |
| `provision` | one user action or error | `userKey,userId,userName,username,personas,matchedBy,status,action,detail,error` |
| `restore` | one user action or action item | `userKey,userId,userName,username,status,action,category,name,error` |
| `strip` | one user action or removed item | `userKey,userId,userName,username,status,action,category,itemId,itemApiName,error` |
| `freeze` / `unfreeze` | one user | `userKey,userId,userName,username,wasFrozen,status,action,error` |
| `snapshot` | one lifecycle report row per user | `key,id,status,actions,skipped,warnings,errors` |

`diff` keeps `value` in its original position and continues to hold the
record Id. Profile and role rows also expose `valueBefore` and `valueAfter`;
their `value` remains the human-compatible `before -> after` string. A user
with no actions still receives a row, and errors are emitted as separate
rows, so failed or unchanged users cannot disappear from a CSV attachment.

The shared CSV writer prefixes cells beginning with `=`, `+`, `-`, `@`, tab,
or carriage return with `'` before quoting. This prevents spreadsheet formula
execution, including for user-supplied labels and attributes. The escape is
write-only. CSV user-definition input rules are documented below; snapshot CSV
round-trip behavior remains a separate snapshot concern.

## `warden provision`

### Provisioning logic

User definitions and persona definitions live in two separate JSON files so
that user-specific data stays decoupled from reusable access bundles.

#### Field naming

* User fields must be Salesforce `User` API field names.
* Input field names are accepted case-insensitively and canonicalized using
  `User` describe metadata before any DML.
* User-level fields override persona `userAttributes` when both supply a
  value.
* A user may also include a `match` meta key to choose its own lookup field.

#### Multiple personas per user

When `--personas-def` is supplied, each user entry must include a non-empty
`personas` array listing names defined in `personas.json`. The command merges
all named personas into a single effective persona before planning:

* **Assignment lists** (`permissionSets`, `permissionSetGroups`,
  `publicGroups`, `queues`) are unioned across all personas, with duplicates
  removed in first-seen order.
* **Singular values** (`profile`, `role`, per-category modes) must agree
  across all personas. If two personas specify different values for the same
  singular field, that user fails with a per-row conflict error — the rest
  of the batch continues.
* **`userAttributes` keys** are also conflict-checked. If two personas
  supply the same key with different values, the user fails unless the user
  entry itself overrides that field (user-level value always wins).

#### Username and Alias defaults (insert only)

When creating a new user (no matching existing record), `Username` and
`Alias` are automatically derived if omitted:

* **`Username`** — defaults to `<Email>.<myDomain>`, where `<myDomain>` is
  the first DNS label of the org's My Domain hostname (e.g. `jdoe@acme.com`
  combined with org `mycompany.my.salesforce.com` gives
  `jdoe@acme.com.mycompany`). If the domain cannot be derived, the field is
  left unset and the normal missing-required-field error is reported.
* **`Alias`** — derived from `FirstName` and `LastName`: take up to 3
  letters from each; when one name is shorter than 3 letters, borrow from
  the other to target 6 total; lowercase; truncated to Salesforce's 8-char
  limit. Examples: `John`/`Doe` → `johdoe`; `Jo`/`Anderson` → `joande`;
  `Al`/`Bo` → `albo`.

Defaults are never applied to users matched for update, and explicit
`Username`/`Alias` values in the user entry are always used as-is.

#### Field precedence

User-level values override persona values for every overlapping field. The
only place a persona "wins" outright is by contributing assignment-list
entries (which union) and by supplying a value the user left unset.

| Setting | Set on a user (`users.json`) | Set on a persona (`personas.json`) | Who wins | Notes |
| --- | --- | --- | --- | --- |
| **Profile** | `profile` (name or 15/18-char Id) **or** raw `ProfileId` | `profile` (name or Id) | user `profile` → user `ProfileId` → persona `profile` | `Profile.Name` resolution. Setting both `profile` and `ProfileId` on one user is a per-row error. Required on insert. |
| **Role** | `role` (DeveloperName/Name or Id) **or** raw `UserRoleId` | `role` | user `role` → user `UserRoleId` → persona `role` | `UserRole.DeveloperName`/`Name` resolution. Both `role`+`UserRoleId` is a per-row error. Optional. |
| **Username** | `Username` | persona `userAttributes.Username` | explicit value > computed default | Default `<Email>.<myDomain>`, **insert only**. |
| **Alias** | `Alias` | persona `userAttributes.Alias` | explicit value > computed default | Default 3+3 name derivation, **insert only**. |
| **Permission-flag fields** (`UserPermissionKnowledgeUser`, …) | direct boolean field | persona `userAttributes` | user field > persona `userAttributes` | Written onto `User`; subject to org licenses. |
| **Other writeable `User` fields** (`Title`, `Department`, …) | direct field | persona `userAttributes` | user field > persona `userAttributes` | Canonicalized case-insensitively against `User` describe. |
| **Assignment lists** (permission sets, groups, queues) | — (not settable per user) | persona lists + per-category `…Mode` | union across all personas | Resolved by name/Id; `additive` keeps existing, `sync` removes unlisted. |
| **Match field** (upsert key) | `match` meta key | — | per-user `match` > `--external-id` flag | Must be a filterable `User` field. See [User matching](user-matching.md). |
| **IsActive** | — | — | always `true` | Provisioning always activates and unfreezes. |

A user-level `profile` or `role` also suppresses the corresponding
persona-vs-persona conflict error for that field — if you name your own
profile it no longer matters that two personas disagreed.

#### Profile-only provisioning

Omit `--personas-def` when each row carries its own `profile` and/or `role`
and should receive no permission-set, group, or queue assignments. For
example:

```bash
sf warden provision --users-def ./users-profile-only.json \
  --dry-run --target-org acme-uat
```

Profile-only rows use the same user matching, profile/role resolution, and
insert defaults as persona-driven rows. Assignment lists remain persona-only,
so the effective assignment persona is empty. Every assignment mode therefore
defaults to `additive`: this mode can add no assignments and cannot remove
existing access.

#### Match resolution

For the shared exact/fuzzy resolution rules, including case handling,
ambiguity behavior, filterable fields, and sandbox Username suffixes, see
[User matching](user-matching.md).

For provisioning specifically:

* `--external-id` sets the default field used to match existing users;
  `--match-field` is an alias.
* A per-user `match` value overrides the flag for that row only.
* If neither is present, the user is treated as an insert.

#### Mixed-source example

```json
{
  "users": [
    { "personas": ["ops"], "match": "FederationIdentifier", "FederationIdentifier": "ABC123", "LastName": "Park" },
    { "personas": ["csr"], "match": "Username", "Username": "bob@acme.com.dev", "LastName": "Bob" },
    { "personas": ["finance"], "match": "Employee_ID__c", "Employee_ID__c": "E-9981", "LastName": "Su" },
    { "personas": ["creator"], "Username": "alice@acme.com.dev", "LastName": "Alice" }
  ]
}
```

#### Practical required fields for new user creation

The following fields are required when inserting a new user. `Username` and
`Alias` can be omitted and will be defaulted automatically (see above); all
others must be explicitly provided.

* `Username` *(auto-defaulted from `Email` and org My Domain if omitted)*
* `LastName`
* `Alias` *(auto-defaulted from `FirstName`/`LastName` if omitted)*
* `TimeZoneSidKey`
* `LocaleSidKey`
* `EmailEncodingKey`
* `LanguageLocaleKey`
* `ProfileId` when no user-level or persona `profile` is specified

#### Reference lookup behavior

References are resolved by Id or developer/API name. Labels are
intentionally unsupported because they are not reliably unique.

| Reference | Resolved by |
| --- | --- |
| Profile | Id or `Profile.Name` |
| Role | Id or `UserRole.DeveloperName` (falls back to `Name`) |
| Permission Set | Id or `PermissionSet.Name` |
| Permission Set Group | Id or `PermissionSetGroup.DeveloperName` |
| Public Group | Id or `Group.DeveloperName` where `Group.Type='Regular'` |
| Queue | Id or `Group.DeveloperName` where `Group.Type='Queue'` |

Missing optional assignment targets produce a warning and are skipped.
Missing required references (a persona `profile` or `role` that cannot be
resolved) fail the affected user.

#### Assignment modes

Each assignment category has its own mode property. The default for every
category is `additive`. When multiple personas are merged, the mode for each
category must agree across all personas that specify it; a disagreement is a
per-row conflict error.

| Mode property | Behavior |
| --- | --- |
| `permissionSetMode` | `additive` adds missing assignments. `sync` adds missing and removes any not listed. |
| `permissionSetGroupMode` | Same semantics as `permissionSetMode`, for permission set groups. |
| `publicGroupMode` | Same semantics, for `GroupMember` records where `Group.Type='Regular'`. |
| `queueMode` | Same semantics, for `GroupMember` records where `Group.Type='Queue'`. |

`sync` partitions `GroupMember` rows by `Group.Type`, so a public-group sync
will not affect queue memberships and vice versa.

#### Dry run

`--dry-run` validates input, resolves references, queries current org state,
and reports planned actions. It performs no inserts, updates, deletes,
upserts, anonymous Apex, or Composite/Tooling write requests. Dry-run is
intentionally planning-only and not rollback-backed.

#### License headroom

During a dry run, provisioning reports the user-license headroom required by
valid net-new users. Users matched for update and plans with errors are
excluded. Profiles are grouped by their `UserLicenseId`, so multiple profiles
consume one combined license total. Available headroom is
`TotalLicenses - UsedLicenses`; a non-active license has zero available, while
a negative `TotalLicenses` is unlimited. Non-active rows include their status
in the note field.

The result's `licenses` array is included in human and JSON dry-run output.
Unlimited capacity is JSON-safe and explicit: it uses `available: null` and
`unlimited: true`, with `shortfall: 0`. Dry runs also report
`permissionSetLicenses: { evaluated: false, note: "not evaluated" }`; PSL
headroom is intentionally deferred because provisioning does not assign PSLs.
Live results omit both license fields.

`--fail-on-insufficient-license` checks the dry-run license rows after the
summary is emitted and raises a non-zero error when any `shortfall` is greater
than zero. Without the flag, each shortfall is emitted as a human warning and
counted in `summary.warnings`; JSON output exposes the same count without
duplicating warning text. With global `--json`, the non-zero error envelope
retains the complete preflight result, including `result.licenses`. The flag
has no effect on live provisioning in this release.

#### Password handling

Password set/reset is intentionally out of scope.

#### Example `users.json`

```json
{
  "users": [
    {
      "personas": ["admin"],
      "FederationIdentifier": "ABCD1234",
      "FirstName": "John",
      "LastName": "Doe",
      "Email": "jdoe@email.com",
      "LocaleSidKey": "en_US",
      "EmailEncodingKey": "UTF-8",
      "LanguageLocaleKey": "en_US",
      "TimeZoneSidKey": "America/Los_Angeles"
    }
  ]
}
```

`Username` and `Alias` are omitted above and will be defaulted on insert to
`jdoe@email.com.<myDomain>` and `johdoe` respectively.

#### Example `users.csv`

The same flat user definition can be maintained as CSV. Headers are matched
case-insensitively to `User` API fields; `personas`, `match`, and
`fuzzyUsername` are metadata columns. Empty cells are omitted, and persona
lists use semicolons by default. Use `--input-format json|csv` when the file
extension does not identify the format, and `--csv-list-delimiter` for a
different list separator. The repository does not ship a separate example
directory; the CSV shape is shown here.

CSV headers are validated strictly and all cells remain strings except for
`fuzzyUsername` and describe-backed boolean User fields. Accepted boolean
values are `true`, `false`, `1`, `0`, `yes`, and `no`, case-insensitively.
CSV is intentionally stricter than JSON for unknown headers so spreadsheet
typos cannot silently discard data. Empty cells cannot represent an explicit
blank value.

Users CSV follows these rules:

1. Values are never type-inferred; only describe-backed booleans and
   `fuzzyUsername` are converted to booleans.
2. Empty cells omit the corresponding key, like an absent JSON key; an
   explicit blank value is not representable.
3. Boolean values are case-insensitive and accept `true`/`false`, `1`/`0`,
   and `yes`/`no`; other values fail with the physical row line.
4. A UTF-8 BOM is accepted and removed from the first header.
5. LF and CRLF line endings are accepted; CSV output uses LF.
6. `personas` uses semicolon-separated, trimmed values by default, or the
   delimiter supplied through `--csv-list-delimiter`.
7. Duplicate headers, including case variants, are errors.
8. Unknown headers are errors and include a close field-name suggestion when
   one is available.
9. Parse and row-validation errors include the source path and physical line
   number, including after embedded newlines in quoted cells.
10. Rows with the wrong number of cells are errors; a final empty line is
    ignored.
11. Input uses the shared CSV module beside the shared CSV writer.

#### Example `personas.json`

```json
{
  "personas": {
    "admin": {
      "profile": "Admin",
      "role": "CEO",
      "permissionSetMode": "additive",
      "permissionSets": ["Admin_Permissions"],
      "permissionSetGroupMode": "additive",
      "permissionSetGroups": ["Admin_Group"],
      "publicGroupMode": "sync",
      "publicGroups": ["Admin_Public_Group"],
      "queueMode": "additive",
      "queues": ["Case_Queue"],
      "userAttributes": {
        "Title": "Salesforce Administrator",
        "Department": "Sales"
      }
    }
  }
}
```

The examples above also show the supported multi-persona and profile-only
shapes; no separate example directory is required.

## `warden diff`

The same reference-resolution rules as `provision` apply when
`--personas-def` is supplied, but `diff` never writes — it only reports what
*would* change. Omit `--personas-def` for a profile-only audit when each row
supplies its own profile or role; the result contains profile and role drift
only, with no assignment rows. Use `--user`/`--against` to compare two live
users directly instead of a user against its intended persona state; in that
mode, no definition files are needed at all.

Use `--fail-on-drift` when `diff` is a CI gate: it returns exit code `1` when
one or more users have drift. The flag is disabled by default. See the
[output contract](output-contract.md#exit-codes) for the interaction with
per-user failures and global `--json`.

Use `--verify` with `--users-def` to turn the diff into a conformance check.
`--personas-def` is optional when verifying profile-only definitions. It
returns one verdict per user with `key`, `conformant`, and `violations` fields.
Missing intended assignments and profile/role mismatches are violations; extra
assignments are violations only for `sync` categories. A missing org user is
reported as `user not found`.
The human format prints a conformant/non-conformant summary and violation
blocks; `--output json` and global `--json` return the verdict array, while
`--output csv` uses `key,conformant,violations` columns. Verify mode sets
`process.exitCode = 1` after rendering whenever any verdict is
non-conformant, so global JSON output remains available to CI consumers with
the normal successful envelope status. It is rejected with `--user` or
`--against`.

For example, verify a profile-only definition without assignment expectations:

```bash
sf warden diff --users-def ./users-profile-only.json \
  --verify --target-org acme-uat
```

## `warden access`

See [Access audits](access-audits.md) for target and reverse-user scopes,
attribution, Permission Set Group muting, limitations, and examples. The
command remains read-only and its shared output behavior is covered by the
[output contract](output-contract.md).

## `warden snapshot` / `warden restore`

Snapshots capture active/frozen state and assignments by developer/API name
(never by Id), so a snapshot taken in one org can be restored into another.
`restore` re-resolves users by the snapshot's match key, reactivates and
unfreezes them, and only *adds* missing assignments — it never removes
access the user already has. If you need a rollback point before a
destructive change, pair `--snapshot` on `strip` with a later `restore`
rather than taking a separate `snapshot` step.

See [Lifecycle output and snapshots](lifecycle-output.md) for the resolved
identity line, assignment label formatting, itemized action reporting, and
the snapshot file fields.

## `warden freeze` / `warden unfreeze` / `warden strip`

`freeze`/`unfreeze` touch only `UserLogin.IsFrozen` — no other access is
changed. `strip` is the composite operation: freeze, then remove access
grants, then deactivate, unless the corresponding `--no-freeze`,
`--keep-*`, or `--no-deactivate` flags opt out of a step. Use `--snapshot`
on `strip` to write a restorable snapshot before any writes happen — it is
written even during `--dry-run`, so you can capture and inspect the
pre-strip state without touching the org.
