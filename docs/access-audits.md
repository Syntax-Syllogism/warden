---
title: Access audits
description: Audit effective Salesforce user access and trace each grant to its source.
---

# Access audits

`sf warden access` is read-only. It answers two questions:

* **Who can access this?** `--type <type> --target <name>` lists the active users who can access one target.
* **What can this user access?** `--user field:value --type <type>` lists what one user can access, and where each grant comes from.

## What you can audit

Target types are `field`, `object`, `apex-class`, `vf-page`, `custom-permission`, `tab`, and `record-type`. Name the target like this:

| Type | `--target` |
| --- | --- |
| `field` | `Object.Field` |
| `object` | the object API name |
| `apex-class`, `vf-page`, `custom-permission` | the class, page, or permission developer name |
| `tab` | the tab API name |
| `record-type` | `SObject.DeveloperName` of an active, non-master record type |

## Scoping a user audit

A user audit needs exactly one scope: a `--target`, or an `--sobject`, not both and not neither.

| Invocation | Scope |
| --- | --- |
| `--user u:x --type field --target Account.SSN__c` | One field |
| `--user u:x --type field --sobject Account` | Explicit field grants on `Account` |
| `--user u:x --type object --target Account` | Object permissions on `Account` |
| `--user u:x --type object --sobject Account` | Object permissions on `Account` |
| `--user u:x --type apex-class/vf-page/custom-permission/tab --target <name>` | One setup or tab target |
| `--user u:x --type record-type --target Account.Business_Account` | One active, non-master record type |

`--sobject` works only with `field` and `object` user audits. The `--user` value follows the [User matching](user-matching.md) rules and must resolve to exactly one user. It never uses fuzzy Username matching.

## Record-type audits

Record-type audits read `recordTypeVisibilities` on Profiles and Permission Sets through the Metadata API. They also read `MutingPermissionSet` metadata for candidate Permission Set Groups. Only sources connected to active users are read. This takes longer than a data-API audit.

* If a matching muting entry hides the record type, that Permission Set Group path is suppressed. A direct assignment of the component Permission Set still counts.
* If any metadata read fails, the command returns an error and no partial result.
* Profile rows report `default: true` or `false`. Permission Set and Permission Set Group rows report `default: null`, because they don't define a default.

## Attribution and effective access

A user-audit row is an effective grant that comes from the user's profile, an assigned Permission Set, or an assigned Permission Set Group (PSG). PSG rows name the component Permission Set in the `via` fields. Warden keeps one row per path, so a review can see when the same target is granted more than once.

Muting is applied before rows are emitted. A PSG's backing `Group` Permission Set isn't counted as a direct assignment. Its component grants are evaluated with matching Muting Permission Sets subtracted. Muting can remove just the read or edit bit, or one object permission, and leave the rest of the access in place.

Some limits to know about:

* Field audits report explicit `FieldPermissions` rows. Visibility granted some other way isn't inferred.
* User tab audits warn that profile-level tab visibility doesn't appear as a clean `PermissionSetTabSetting` grant.
* Large results are paged with `queryMore`, but org and API limits still apply to very large audits.

## Output

Human output for a user audit starts with `Access for <user>`. With `--sobject`, the table adds a `Target` column so you can tell fields apart. CSV and JSON keep `targetType` and `targetName` on every row, and CSV rows are sorted so output is stable. Formats, destinations, and `--json` are covered in the [output contract](output-contract.md).

## Examples

```bash
# Who can access one field?
sf warden access --target-org myOrg --type field \
  --target Account.SSN__c

# Which Account fields can this user access?
sf warden access --target-org myOrg --user 'Username:alice@example.com' \
  --type field --sobject Account --output csv

# What object permissions does this user have?
sf warden access --target-org myOrg --user 'FederationIdentifier:E-123' \
  --type object --target Account --output json

# Can this user reach a setup target?
sf warden access --target-org myOrg --user 'Username:alice@example.com' \
  --type apex-class --target MyController

# Who can select this record type?
sf warden access --target-org myOrg --type record-type \
  --target Account.Business_Account

# How can one user select it?
sf warden access --target-org myOrg --user 'Username:alice@example.com' \
  --type record-type --target Account.Business_Account
```
