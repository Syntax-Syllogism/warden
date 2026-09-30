---
title: Connected org writes
description: Provisioning ledger and reconciliation logging for orgs with the Warden package.
---

# Connected org writes

`sf warden provision` can record its successful work in the Warden package installed in the target org. This is optional. If the package isn't there, provisioning works as usual.

## What gets written

On a live run, Warden checks for the ledger and Run objects with separate `describe` calls. The package has no namespace and uses the `wdn_` prefix.

* **`wdn_Provisioned_Grant__c`** (the ledger). If the object exists, Warden writes one row for each permission set, permission set group, public group, or queue assignment the run created. If several personas asked for the same grant, you get one row per persona. Rows carry the target label when the org supplied one, and the target Id otherwise.
* **`wdn_Reconciliation_Run__c`**. With `--log-to-org`, Warden creates a Run record before provisioning and updates its counts afterward. The Run records the CLI version, the invoking OS user, the CI job, the definition path, and the definition repository SHA when known.
* **`wdn_Reconciliation_Item__c`**. With `--log-to-org --log-detail full`, Warden tries to write one Item for each provision action, related-record result, and error, plus one for each user with no reported item. Warden finds out whether the Item object exists by attempting the write, not by a separate `describe`. The default `summary` detail writes the Run header and counts, and no Items.

The ledger and the Run log are independent. `--log-to-org` needs the Run object; the ledger doesn't need that flag. If `describe` can't confirm an object, that part is skipped and provisioning carries on. If an Item can't be saved, Warden warns and continues.

## Flags and safety rules

These flags apply only to `provision`:

```bash
sf warden provision --target-org myOrg \
  --users-def ./users.json --personas-def ./personas.json \
  --log-to-org --log-detail full --no-prompt
```

* `--log-to-org` is off by default. `--log-detail` is `summary` by default and also accepts `full`.
* `--dry-run` writes nothing. It doesn't check for the connected objects, create audit records, or write ledger rows.
* Audit records are best effort. A failed create, update, or partial batch produces a warning. It never changes provisioning's result or exit code. Ledger and Item creates go out in sequential batches of at most 200 records, so a large run keeps the batches that succeed if another fails.
* Warden doesn't read personas or other configuration from the org for this feature, and it doesn't run remote Apex. User and assignment changes are still made by the normal provisioning path.

The org must expose the ledger and Run objects, and the authenticated user must be able to create and update them. Full-detail logging also needs the Item object. If objects or permissions are missing, provisioning still runs. Check the warnings to see which audit records weren't saved.
