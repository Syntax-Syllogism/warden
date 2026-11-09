---
title: Connected org writes
description: Provisioning ledger, reconciliation logging, and persona revocation records for orgs with the Warden package.
---

# Connected org writes

`sf warden provision` can record its successful work in the Warden package installed in the target org. This is optional. If the package isn't there, provisioning works as usual. Persona-mode `sf warden strip` records its revocations there too; see [Persona revocation writes](#persona-revocation-writes). The sfd `warden.provision` operation writes ledger rows, but Run and Item records remain sf-only; see [sfd operations](sfd.md).

## What gets written

On a live run, Warden checks for the ledger and Run objects with separate `describe` calls. The package has no namespace and uses the `wdn_` prefix.

- **`wdn_Provisioned_Grant__c`** (the ledger). If the object exists, Warden writes one row for each permission set, permission set group, public group, or queue assignment the run created. If several personas asked for the same grant, you get one row per persona. Rows carry the target label when the org supplied one, and the target Id otherwise.
- **`wdn_Reconciliation_Run__c`**. With `--log-to-org`, Warden creates a Run record after planning and any required warning confirmation, before applying provisioning changes, and updates its counts afterward. Declining the warnings creates no Run, ledger, or Item records. The Run records the CLI version, the invoking OS user, the CI job, the definition path, and the definition repository SHA when known.
- **`wdn_Reconciliation_Item__c`**. With `--log-to-org --log-detail full`, Warden tries to write one Item for each provision action, related-record result, and error, plus one for each user with no reported item. Warden finds out whether the Item object exists by attempting the write, not by a separate `describe`. The default `summary` detail writes the Run header and counts, and no Items.

The ledger and the Run log are independent. `--log-to-org` needs the Run object; the ledger doesn't need that flag. If `describe` can't confirm an object, that part is skipped and provisioning carries on. If an Item can't be saved, Warden warns and continues.

## Flags and safety rules

These flags apply only to `provision`:

```bash
sf warden provision --target-org myOrg \
  --users-def ./users.json --personas-def ./personas.json \
  --log-to-org --log-detail full --no-prompt
```

- `--log-to-org` is off by default. `--log-detail` is `summary` by default and also accepts `full`.
- `--dry-run` writes nothing. It doesn't check for the connected objects, create audit records, or write ledger rows.
- Audit records are best effort. A failed create, update, or partial batch produces a warning. It never changes provisioning's result or exit code. Ledger and Item creates go out in sequential batches of at most 200 records, so a large run keeps the batches that succeed if another fails.
- Apart from looking up persona Ids for ledger provenance (only when the ledger has a `wdn_Persona__c` field), Warden doesn't read personas or other configuration from the org for this feature, and it doesn't run remote Apex. User and assignment changes are still made by the normal provisioning path.

The org must expose the ledger and Run objects, and the authenticated user must be able to create and update them. Full-detail logging also needs the Item object. If objects or permissions are missing, provisioning still runs. Check the warnings to see which audit records weren't saved.

## Persona revocation writes

A live `sf warden strip` with `--persona` or `--all-personas` writes revocation records when the package exposes the fields. This doesn't use `--log-to-org`, and `--dry-run` writes nothing. The writes happen after strip applies its access removal:

- **`wdn_Persona_Assignment__c`**: for each user the run didn't fail on, the removed personas' assignments get `wdn_Status__c` = `Revoked`, `wdn_Revoked_On__c` set to the run time, and `wdn_Revoked_By__c` set to the running user's Id when the connection reports one. Warden reads only `Active` assignments as held personas, so a revoked assignment doesn't count in later runs.
- **`wdn_Provisioned_Grant__c`** (the ledger): rows for the removed persona, user, and target get `wdn_Revoked_On__c`, plus `wdn_Revoked_By_Run__c` when the Run was created. Targets kept by another persona, and targets whose removal failed, are left alone. Warden reads ledger rows only when the ledger object is available.
- **`wdn_Reconciliation_Run__c`**: one Run per live persona strip, with `wdn_Mode__c` = `Revoke` and `wdn_Source_System__c` = `Warden CLI`. It's created after the access removal, carries no counts or Items, and is skipped unless both fields exist.

Warden checks each object with `describe` before writing. If a field is missing, as on an older package, Warden warns and skips only that write. Failed or partial batches also warn. None of these writes changes strip's result or exit code.
