# Command details

Deeper logic notes for warden's more involved commands. Flag-by-flag
reference lives in the [README](../README.md#commands) and in each command's
`--help` output; this doc covers the *why* and the *merge/precedence rules*
that don't fit in a flag summary.

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

Each user entry must include a `personas` array listing one or more persona
names defined in `personas.json`. The command merges all named personas into
a single effective persona before planning:

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
| **Match field** (upsert key) | `match` meta key | — | per-user `match` > `--external-id` flag | Must be an external-Id field or `Username`/`Email`/`FederationIdentifier`. |
| **IsActive** | — | — | always `true` | Provisioning always activates and unfreezes. |

A user-level `profile` or `role` also suppresses the corresponding
persona-vs-persona conflict error for that field — if you name your own
profile it no longer matters that two personas disagreed.

#### Match resolution

* `--external-id` sets the default field used to match existing users.
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
* `ProfileId` when no persona specifies `profile`

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

See [`examples/users.json`](examples/users.json) and
[`examples/personas.json`](examples/personas.json) for larger,
multi-persona samples.

## `warden diff`

Same persona-merge and reference-resolution rules as `provision` apply when
comparing against `--personas-def`, but `diff` never writes — it only
reports what *would* change. Use `--user`/`--against` to compare two live
users directly instead of a user against its intended persona state; in that
mode, no definition files are needed at all.

## `warden access`

* The command is read-only and performs no DML.
* `--type field` expects a qualified field target such as
  `Account.CustomField__c`.
* `--type object` expects an object API name such as `Account`.
* Supported output modes are `human`, `csv`, and `json`.
* Muted access from Muting Permission Sets is excluded when evaluating
  Permission Set Group pathways.
* If a field has no explicit `FieldPermissions` rows (common for some
  standard fields), the command returns success with a warning; base
  visibility may still exist outside explicit FLS grants.
* Very large orgs are constrained by Salesforce query/API limits; the
  command paginates through query results using `queryMore` until
  Salesforce indicates completion.

### Access examples

```bash
# Human output (default)
sf warden access --type field --target Account.CustomField__c --target-org myOrg

# CSV output
sf warden access --type object --target Account --target-org myOrg --output csv

# JSON output
sf warden access --type field --target Account.CustomField__c --target-org myOrg --output json
```

## `warden snapshot` / `warden restore`

Snapshots capture active/frozen state and assignments by developer/API name
(never by Id), so a snapshot taken in one org can be restored into another.
`restore` re-resolves users by the snapshot's match key, reactivates and
unfreezes them, and only *adds* missing assignments — it never removes
access the user already has. If you need a rollback point before a
destructive change, pair `--snapshot` on `strip` with a later `restore`
rather than taking a separate `snapshot` step.

## `warden freeze` / `warden unfreeze` / `warden strip`

`freeze`/`unfreeze` touch only `UserLogin.IsFrozen` — no other access is
changed. `strip` is the composite operation: freeze, then remove access
grants, then deactivate, unless the corresponding `--no-freeze`,
`--keep-*`, or `--no-deactivate` flags opt out of a step. Use `--snapshot`
on `strip` to write a restorable snapshot before any writes happen — it is
written even during `--dry-run`, so you can capture and inspect the
pre-strip state without touching the org.
