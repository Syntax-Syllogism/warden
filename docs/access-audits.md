---
title: Access audits
description: Audit effective Salesforce user access and trace each grant to its source.
---

# Access audits

`sf warden access` is a read-only audit command. It supports two directions:

* **Target audit** — `--type <type> --target <name>` reports active users who
  can access one permission target.
* **Reverse user audit** — `--user field:value --type <type>` reports what one
  resolved user can access, and attributes each grant to its source.

## Scoping

Reverse audits require exactly one bounded scope:

| Invocation | Scope |
| --- | --- |
| `--user u:x --type field --target Account.SSN__c` | One field |
| `--user u:x --type field --sobject Account` | Explicit field grants on `Account` |
| `--user u:x --type object --target Account` | Object permissions on `Account` |
| `--user u:x --type object --sobject Account` | Object permissions on `Account` |
| `--user u:x --type apex-class/vf-page/custom-permission/tab --target <name>` | One setup or tab target |

`--sobject` is valid only with reverse `field` and `object` audits. A reverse
audit cannot omit both `--target` and `--sobject`, and the two scopes cannot be
combined. The `--user` value uses the same filterable `User` field matching
rules documented in [User matching](user-matching.md); it resolves exactly one
user and does not request fuzzy Username matching.

The target-audit direction supports `field`, `object`, `apex-class`,
`vf-page`, `custom-permission`, and `tab` targets. Field targets use
`ObjectApiName.FieldApiName`; object targets use an object API name. Setup
targets use the Apex class, Visualforce page, or custom-permission developer
name, and tab targets use the tab API name.

## Attribution and effective access

Reverse rows represent an effective grant found through the user's profile,
an individually assigned Permission Set, or an assigned Permission Set Group
(PSG). PSG rows include the component Permission Set in the `via` fields.
Rows are retained per attribution path so an access review can show how the
same target is granted more than once.

Permission Set Group muting is applied before rows are emitted. A PSG's
backing `Group` Permission Set is not treated as a direct assignment; its
component grants are evaluated with any matching Muting Permission Sets
subtracted. Muting can therefore remove only read/edit or individual object
permission bits while leaving other effective access intact.

Field audits report explicit `FieldPermissions` rows. Salesforce visibility
that is provided outside those rows is not inferred. Reverse tab audits also
warn that profile-level tab visibility is not represented by a clean
`PermissionSetTabSetting` data-API grant.

The command paginates large Salesforce query results with `queryMore` until
Salesforce indicates completion, but org/API limits still constrain very large
audits.

## Output

Human reverse output starts with `Access for <user>`. When a reverse field
audit uses `--sobject`, the table includes a `Target` column so each field is
identified. CSV and JSON retain `targetType` and `targetName` for every row;
CSV rows are sorted deterministically. See the [output contract](output-contract.md)
for shared formats, destinations, and global `--json` behavior.

## Examples

```bash
# Who can access one field?
sf warden access --target-org myOrg --type field \
  --target Account.SSN__c

# What fields on Account can this user access?
sf warden access --target-org myOrg --user 'Username:alice@example.com' \
  --type field --sobject Account --output csv

# What object permissions does this user have?
sf warden access --target-org myOrg --user 'FederationIdentifier:E-123' \
  --type object --target Account --output json

# Does this user have access to a setup target?
sf warden access --target-org myOrg --user 'Username:alice@example.com' \
  --type apex-class --target MyController
```
