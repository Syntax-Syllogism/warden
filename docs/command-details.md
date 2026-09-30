---
title: Command details
description: Detailed provisioning, assignment, matching, and output behavior for Warden commands.
---

# Command details

This page explains the rules behind Warden's more involved commands: how personas merge, which value wins, and what each mode does. For flags, see the [CLI reference](cli-reference.md) or run a command with `--help`. Output formats, destinations, and `--json` are in the [output contract](output-contract.md).

## CSV row schemas

Commands that change or report individual access records write CSV with one row per item. Columns are stable, and new columns are only ever appended.

| Command | One row is | Columns |
| --- | --- | --- |
| `access` | one grant | the existing 12 columns, then access flags for the target type |
| `diff` | one delta | `userKey,userId,category,kind,value,mode,userName,username,valueApiName,valueLabel,valueType,valueBefore,valueAfter` |
| `provision` | one user action or error | `userKey,userId,userName,username,personas,matchedBy,status,action,detail,error` |
| `restore` | one user action or action item | `userKey,userId,userName,username,status,action,category,name,error` |
| `strip` | one user action or removed item | `userKey,userId,userName,username,status,action,category,itemId,itemApiName,error` |
| `freeze` / `unfreeze` | one user | `userKey,userId,userName,username,wasFrozen,status,action,error` |
| `snapshot` | one lifecycle report row per user | `key,id,status,actions,skipped,warnings,errors` |

In `diff`, `value` keeps its position and still holds the record Id. Profile and role rows also fill `valueBefore` and `valueAfter`, while `value` stays the readable `before -> after` string. A user with no actions still gets a row, and errors get their own rows, so no user can vanish from a CSV attachment.

To stop spreadsheets from running formulas, the CSV writer prefixes any cell that starts with `=`, `+`, `-`, `@`, a tab, or a carriage return with `'` before quoting. This covers user-supplied labels and attributes too. When Warden reads a snapshot CSV, it strips that prefix, so names survive a write/read round trip. The rules for CSV user-definition input are [below](#example-userscsv).

## `warden provision`

### Provisioning logic

User definitions and persona definitions live in two files, so user-specific data stays separate from reusable access bundles.

#### Field naming

* User fields must be Salesforce `User` API field names.
* Names are matched case-insensitively and canonicalized against `User` describe metadata before any DML.
* A user-level value overrides the same field in a persona's `userAttributes`.
* A user can include a `match` key to choose its own lookup field.

#### Several personas per user

With `--personas-def`, each user needs a non-empty `personas` array of names defined in `personas.json`. Before planning, Warden merges those personas into one:

* **Assignment lists** (`permissionSets`, `permissionSetGroups`, `publicGroups`, `queues`) are combined, with duplicates removed in first-seen order.
* **Single values** (`profile`, `role`, and each category's mode) must agree across personas. If two personas set different values, that user fails with a conflict error and the rest of the batch continues.
* **`userAttributes` keys** are checked the same way. If two personas set the same key differently, the user fails, unless the user entry sets that field itself. The user's value always wins.

#### Username and Alias defaults (insert only)

When a user is created, Warden fills in `Username` and `Alias` if you left them out:

* **`Username`** defaults to `<Email>.<myDomain>`, where `<myDomain>` is the first DNS label of the org's My Domain hostname. For example, `jdoe@acme.com` in the org `mycompany.my.salesforce.com` gives `jdoe@acme.com.mycompany`. If Warden can't work out the domain, it leaves the field unset and you get the usual missing-required-field error.
* **`Alias`** comes from `FirstName` and `LastName`. Take up to 3 letters from each. If one name is shorter than 3, borrow from the other to reach 6. Lowercase it and cut it to Salesforce's 8-character limit. `John`/`Doe` gives `johdoe`, `Jo`/`Anderson` gives `joande`, and `Al`/`Bo` gives `albo`.

Defaults are never applied to users matched for update. A `Username` or `Alias` you set explicitly is always used as written.

#### Field precedence

A user-level value beats a persona value for any field both set. A persona wins only by contributing assignment-list entries (which combine) and by supplying a value the user left unset.

| Setting | On a user (`users.json`) | On a persona (`personas.json`) | Who wins | Notes |
| --- | --- | --- | --- | --- |
| **Profile** | `profile` (name or 15/18-char Id) **or** raw `ProfileId` | `profile` (name or Id) | user `profile`, then user `ProfileId`, then persona `profile` | Resolved by `Profile.Name`. Setting both `profile` and `ProfileId` on one user is a per-row error. Required on insert. |
| **Role** | `role` (DeveloperName/Name or Id) **or** raw `UserRoleId` | `role` | user `role`, then user `UserRoleId`, then persona `role` | Resolved by `UserRole.DeveloperName`/`Name`. Setting both is a per-row error. Optional. |
| **Username** | `Username` | `userAttributes.Username` | explicit value beats the default | Default is `<Email>.<myDomain>`, **insert only**. |
| **Alias** | `Alias` | `userAttributes.Alias` | explicit value beats the default | Default is the 3+3 name rule, **insert only**. |
| **Permission-flag fields** (`UserPermissionKnowledgeUser`, …) | direct boolean field | persona `userAttributes` | user field | Written to `User`. Subject to org licenses. |
| **Other writeable `User` fields** (`Title`, `Department`, …) | direct field | persona `userAttributes` | user field | Matched case-insensitively against `User` describe. |
| **Assignment lists** (permission sets, groups, queues) | not settable per user | persona lists plus per-category `…Mode` | combined across personas | Resolved by name or Id. `additive` keeps existing assignments; `sync` removes unlisted ones. |
| **Match field** (upsert key) | `match` key | none | per-user `match`, then `--external-id` | Must be a filterable `User` field. See [User matching](user-matching.md). |
| **IsActive** | none | none | always `true` | Provisioning always activates and unfreezes. |

A user-level `profile` or `role` also silences the persona-versus-persona conflict for that field. If you name your own profile, it no longer matters that two personas disagreed.

#### Profile-only provisioning

Leave out `--personas-def` when each row carries its own `profile` and/or `role` and shouldn't get any permission set, group, or queue assignments:

```bash
sf warden provision --users-def ./users-profile-only.json \
  --dry-run --target-org acme-uat
```

Profile-only rows use the same matching, profile and role resolution, and insert defaults as persona-driven rows. Assignment lists come only from personas, so these rows have none, and every mode defaults to `additive`. That means the run can't add assignments and can't remove existing access.

#### Match resolution

The rules for exact and fuzzy matching, case handling, ambiguity, filterable fields, and sandbox Username suffixes are in [User matching](user-matching.md). For provisioning:

* `--external-id` sets the default field for finding existing users. `--match-field` is an alias.
* A user's own `match` value overrides the flag for that row.
* With neither, the user is treated as new.

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

#### Required fields for new users

Creating a user needs these fields. `Username` and `Alias` can be omitted because Warden fills them in (see above). Provide the rest.

* `Username` (defaulted from `Email` and My Domain)
* `LastName`
* `Alias` (defaulted from `FirstName`/`LastName`)
* `TimeZoneSidKey`
* `LocaleSidKey`
* `EmailEncodingKey`
* `LanguageLocaleKey`
* `ProfileId`, when neither the user nor a persona sets `profile`

#### How references are looked up

References resolve by Id or by developer/API name. Labels aren't supported because they aren't reliably unique.

| Reference | Resolved by |
| --- | --- |
| Profile | Id or `Profile.Name` |
| Role | Id or `UserRole.DeveloperName` (falls back to `Name`) |
| Permission Set | Id or `PermissionSet.Name` |
| Permission Set Group | Id or `PermissionSetGroup.DeveloperName` |
| Public Group | Id or `Group.DeveloperName` where `Group.Type='Regular'` |
| Queue | Id or `Group.DeveloperName` where `Group.Type='Queue'` |

A missing optional assignment target produces a warning and is skipped. A missing required reference, meaning a persona `profile` or `role` that can't be resolved, fails that user.

#### Assignment modes

Every assignment category has its own mode, and the default is `additive`. When personas are merged, each category's mode must agree across the personas that set it. A disagreement is a per-row conflict error.

| Mode property | Behavior |
| --- | --- |
| `permissionSetMode` | `additive` adds missing assignments. `sync` adds missing ones and removes any not listed. |
| `permissionSetGroupMode` | Same, for permission set groups. |
| `publicGroupMode` | Same, for `GroupMember` records where `Group.Type='Regular'`. |
| `queueMode` | Same, for `GroupMember` records where `Group.Type='Queue'`. |

`sync` splits `GroupMember` rows by `Group.Type`, so syncing public groups never touches queue memberships, and the reverse.

#### Dry run

`--dry-run` validates input, resolves references, reads the org's current state, and reports what it would do. It never inserts, updates, deletes, upserts, runs anonymous Apex, or sends Composite or Tooling write requests. It plans only, and there is nothing to roll back.

A live run can also write a ledger and reconciliation records when the Warden package objects exist. See [Connected org writes](connected-org-writes.md).

#### License headroom

A dry run reports the user licenses needed by valid new users. Users matched for update and plans with errors are left out. Profiles are grouped by `UserLicenseId`, so profiles that share a license count against one total. Available headroom is `TotalLicenses - UsedLicenses`. A license that isn't active has zero available, and a negative `TotalLicenses` means unlimited. Rows for non-active licenses include the status in the note.

The result's `licenses` array appears in human and JSON dry-run output. Unlimited capacity is shown as `available: null`, `unlimited: true`, and `shortfall: 0`. Dry runs also report `permissionSetLicenses: { evaluated: false, note: "not evaluated" }`, because provisioning doesn't assign permission set licenses yet. Live results include neither field.

`--fail-on-insufficient-license` checks the license rows after the summary is printed and exits non-zero if any `shortfall` is above zero. Without it, each shortfall is a warning in human output and is counted in `summary.warnings`. JSON output shows the same count without repeating the text. With global `--json`, the error envelope keeps the full preflight result, including `result.licenses`. The flag has no effect on live provisioning in this release.

#### Passwords

Setting or resetting passwords is out of scope.

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

`Username` and `Alias` are left out, so an insert defaults them to `jdoe@email.com.<myDomain>` and `johdoe`.

#### Example `users.csv`

You can keep the same flat user definition as CSV. See the [CSV example](examples/users.csv). Headers match `User` API fields case-insensitively. `personas`, `match`, and `fuzzyUsername` are metadata columns. Persona lists are separated by semicolons unless you set `--csv-list-delimiter`. If the file extension doesn't reveal the format, pass `--input-format json|csv`.

CSV is stricter than JSON, so a typo in a spreadsheet can't silently drop data:

1. Values are never type-guessed. Only `fuzzyUsername` and boolean `User` fields (per describe) become booleans.
2. An empty cell omits the key, like a missing JSON key. You can't express an explicit blank.
3. Booleans are case-insensitive and accept `true`/`false`, `1`/`0`, and `yes`/`no`. Anything else fails and names the row's line.
4. A UTF-8 BOM is accepted and removed from the first header.
5. LF and CRLF line endings are accepted. CSV output uses LF.
6. `personas` is a list of trimmed values separated by semicolons, or by `--csv-list-delimiter`.
7. Duplicate headers, including case variants, are errors.
8. Unknown headers are errors, with a close field-name suggestion when there is one.
9. Errors include the file path and the physical line number, even after embedded newlines in quoted cells.
10. A row with the wrong number of cells is an error. A final empty line is ignored.
11. Input uses the shared CSV module that also holds the CSV writer.

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

Larger samples: [users.json](examples/users.json), [personas.json](examples/personas.json), and [users-profile-only.json](examples/users-profile-only.json).

#### Related records (`--related-def`)

`--related-def` takes a JSON catalog of reusable relationships. A JSON user picks catalog entries by name in a `related` array. That key is metadata only and is never sent to the User API. CSV user definitions can't select relationships, so CSV input with `--related-def` is an error.

The catalog needs a `relationships` object. Each name a user selects must exist in it and appear only once in that user's `related` array:

```json
{
  "users": [
    {
      "related": ["employee"],
      "FederationIdentifier": "E-9981"
    }
  ]
}
```

```json
{
  "relationships": {
    "employee": {
      "sobject": "Employee__c",
      "phase": "after",
      "match": {
        "field": "External_Person_Id__c",
        "from": "user.FederationIdentifier"
      },
      "fields": {
        "Department__c": { "from": "user.Department" },
        "Employment_Status__c": { "value": "Active" },
        "User__c": { "from": "user.Id" }
      }
    }
  }
}
```

How it works:

* Only `phase: "after"` is supported. Warden saves the User first, then creates or updates the related record, and can set a lookup from `{ "from": "user.Id" }`. Before-phase provisioning of external users is planned for v2.
* Matching uses a unique or External-ID, filterable field on the related object, filled from a non-Id User field. Zero matches create a record, one match updates it, and several matches fail that user. Two users that resolve to the same match value also fail, before any DML.
* Every relationship needs a non-empty `sobject`, `phase`, `match`, and `fields`.
* A field source is exactly `{ "from": "user.<UserField>" }` or `{ "value": <literal> }`. `{ "from": "user.Id" }` is fine for a field, but never for `match.from`. A User-field source must name a real User field and resolve to a non-empty value.
* `mode` defaults to `setIfEmpty`, which keeps populated values on a matched record. Only literal `null` and `""` count as empty. Set `mode: "sync"` to overwrite every configured field. On create, both modes write all configured fields and always write the match field.
* A configured record type is applied only on create. Warden never changes the record type of a matched record, and a matched record with a different configured record type fails that user. An `Account` relationship must declare an available Person Account record type.

Before planning, Warden checks each selected relationship's target object, field access, match metadata, and record type. A relationship that fails these checks is reported as a warning and skipped, after the command's single warning confirmation. `--no-prompt` and non-interactive JSON runs skip it automatically.

Related DML is batched by sObject, at most 200 records per batch. Dry runs validate, match, and show the plan without any DML. In a live run, if a related record fails to save, the User that was already saved stays, and that user's result is marked failed. Human output prints one `related:` line per result. JSON and CSV shapes are in the [output contract](output-contract.md).

## Org-defined personas and promotion

See [Persona promotion](persona-promotion.md) for how the org source is chosen, how components map, and the `persona export`, `persona import`, and `persona diff` workflows.

## `warden diff`

`diff` resolves references the same way `provision` does when you pass `--personas-def`, but it never writes. It only reports what would change.

* Omit `--personas-def` for a profile-only audit, when each row supplies its own profile or role. The result then holds profile and role drift only, with no assignment rows.
* Use `--user` and `--against` to compare two live users directly. That mode needs no definition files.
* Use `--fail-on-drift` to make `diff` a CI gate. It exits with `1` when any user has drift, and it's off by default. See the [output contract](output-contract.md#exit-codes) for how it interacts with per-user failures and `--json`.

### Assignment delta buckets

Each assignment category in `users[].assignments` has four arrays: `adds`, `removes`, `inBoth`, and `onlyInOrg`. The `rows[]` result expands the same buckets into one row per value. `onlyInOrg` never overlaps `removes`. An assignment is `onlyInOrg` only when it is extra in the org and isn't also being removed.

So an extra assignment shows up only in `removes` in a user-to-user comparison, and for a persona category in `sync` mode. In persona `additive` mode, extras are kept, so they stay in `onlyInOrg` and produce `onlyInOrg` rows. This keeps arrays and rows consistent and reports each assignment once.

### Verify mode

`--verify` with `--users-def` turns the diff into a conformance check. `--personas-def` is optional when you verify profile-only definitions. You get one verdict per user, with `key`, `conformant`, and `violations`.

* Missing intended assignments and profile or role mismatches are violations.
* Extra assignments are violations only in `sync` categories.
* A user missing from the org is reported as `user not found`.
* Human output prints a conformant/non-conformant summary and a block per violation. `--output json` and global `--json` return the verdict array. `--output csv` uses the columns `key,conformant,violations`.
* If any verdict is non-conformant, Warden sets `process.exitCode = 1` after rendering. Global JSON output stays available to CI with the normal successful envelope status.
* `--verify` can't be used with `--user` or `--against`.

To verify a profile-only definition without assignment expectations:

```bash
sf warden diff --users-def ./users-profile-only.json \
  --verify --target-org acme-uat
```

## `warden access`

See [Access audits](access-audits.md) for scopes, attribution, muting, limits, and examples. The command is read-only, and [the output contract](output-contract.md) covers its output. Record-type audits need a qualified `SObject.DeveloperName` target. They read Profile, PermissionSet, and candidate PSG `MutingPermissionSet` metadata through the Metadata API, which adds latency. Reads cover only active-user sources and fail closed if metadata is incomplete. A matching muting entry suppresses only the PSG path. User record-type audits need an explicit target and don't support `--sobject`.

## `warden snapshot` / `warden restore`

A snapshot records each user's active/frozen state and assignments by developer/API name, never by Id, so a snapshot from one org can be restored into another. Each entry can also record the resolved `name`, `username`, `email`, `profile`, and `role` for review. Profile and role appear by name when known, or by Id otherwise. `restore` never applies them.

`restore` finds users again by the snapshot's match key, reactivates and unfreezes them, and only **adds** missing assignments. It never removes access a user already has. If you want a rollback point before something destructive, use `--snapshot` on `strip` and `restore` later. You don't need a separate `snapshot` step.

The output extension picks JSON or CSV. CSV is long and self-describing, with one row per assignment:

```text
snapshotVersion,capturedAt,org,match,matchValue,userId,userName,username,email,profile,role,isActive,isFrozen,category,name
```

`category` is `permissionSet`, `permissionSetGroup`, `publicGroup`, `queue`, `permissionSetLicense`, or `none`. A user with no assignments gets a `none` row, so their active/frozen state and identity aren't lost. `restore` reads either format by extension, validates the shared metadata, groups rows by `match`, `matchValue`, and `userId`, and sorts and deduplicates assignment names.

With `--dry-run`, `restore` shows the identity recorded in the snapshot next to the identity it found in the org, and warns about mismatches. Profile and role lines are marked `(reported, not applied)`.

[Lifecycle output and snapshots](lifecycle-output.md) covers the identity line, assignment labels, itemized action reports, and snapshot file fields.

## `warden freeze` / `warden unfreeze` / `warden strip`

`freeze` and `unfreeze` change only `UserLogin.IsFrozen`. Nothing else changes.

`strip` does all of it in order: freeze, remove access grants, then deactivate. You can skip a step with `--no-freeze`, a `--keep-*` flag, or `--no-deactivate`. Use `--snapshot` on `strip` to save a restorable snapshot before any write. The file is written even with `--dry-run`, so you can capture and inspect the pre-strip state without touching the org.
