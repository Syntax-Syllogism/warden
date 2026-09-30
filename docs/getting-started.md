---
title: Getting started with Warden
description: Install Warden and run your first Salesforce user lifecycle workflow.
---

# Getting started with warden

`warden` is a Salesforce CLI plugin for managing users over their lifetime: auditing access, finding drift, provisioning, promoting personas, freezing and unfreezing, and snapshotting and restoring. This guide takes you from install to your first provisioning run.

## Install

```bash
sf plugins install @syntax-syllogism/warden@x.y.z
```

Or build from source (see [Contributing](https://github.com/Syntax-Syllogism/warden/blob/v0.7.0/README.md#contributing)):

```bash
git clone https://github.com/Syntax-Syllogism/warden.git
cd warden
yarn install
yarn build
node ./bin/dev.js warden --help
```

## How the commands fit together

Warden's commands fall into four groups.

* **Read-only audits.** [`access`](access-audits.md), [`diff`](command-details.md#warden-diff), and `persona diff` never write to the org. Use them to answer "who can see this?", "how does this user differ from what they should have?", and "what differs from the org's personas?" before you change anything.
* **Lifecycle actions that change data.** `provision`, `freeze`, `unfreeze`, `strip`, and `restore` write to the org. Each supports `--dry-run` to preview the changes, and `--no-prompt` to skip the confirmation once you trust the plan (in CI, for example). All eight core commands also support `-i`/`--interactive`; see [Interactive mode](interactive-mode.md).
* **Portable state.** `snapshot` saves a user's active/frozen state and assignments to a JSON or CSV file. The file extension picks the format, and `restore` reads either. Snapshots use developer/API names where they exist and fall back to Ids, so they work across orgs that share those names.
* **Persona promotion.** `persona export` and `persona diff` read the org's personas; `persona import` writes them. See [Persona promotion](persona-promotion.md).

## Your first provisioning run

1. Write a persona file that describes your reusable access bundles. See the [persona example](command-details.md#example-personasjson).
2. Write a user file that lists the people to provision. Each user names one or more personas. See the [user example](command-details.md#example-usersjson).
3. Preview the plan. Nothing is written:

   ```bash
   sf warden provision --target-org myOrg \
     --users-def ./users.json --personas-def ./personas.json \
     --external-id FederationIdentifier --dry-run
   ```

4. When the plan looks right, apply it:

   ```bash
   sf warden provision --target-org myOrg \
     --users-def ./users.json --personas-def ./personas.json \
     --external-id FederationIdentifier --no-prompt
   ```

Prefer a guided run? `sf warden provision -i` asks for the files and remaining options. Its single summary confirmation replaces the usual write confirmation, and it only works in a terminal.

For the rules behind `provision` (several personas per user, assignment modes, Username and Alias defaults), see [Provisioning logic](command-details.md#provisioning-logic).

## Promote personas through an org

If the Warden package is installed, you can store personas in the org and use them when provisioning. Export them, check for drift, and import your changes when you're ready:

```bash
sf warden persona export --target-org myOrg --output personas.json
sf warden persona diff --target-org myOrg --input personas.json
sf warden persona import --target-org myOrg --input personas.json
```

Add `--prune` to `persona import` to remove components that exist in the org but aren't listed for the personas in your file. Import never deletes or deactivates a persona that is missing from the file. See [Persona promotion](persona-promotion.md) for how the source is chosen.

## Audit before you change anything

```bash
# Who can see this custom field today?
sf warden access --target-org myOrg --type field --target Account.CustomField__c

# How does each user's actual access compare to their personas?
sf warden diff --target-org myOrg \
  --users-def ./users.json --personas-def ./personas.json
```

Neither command writes to the org.

To audit record-type visibility, use the qualified API name of an active, non-master record type:

```bash
sf warden access --target-org myOrg --type record-type \
  --target Account.Business_Account
sf warden access --target-org myOrg --user 'Username:alice@example.com' \
  --type record-type --target Account.Business_Account
```

Record-type audits read Profile and Permission Set metadata through the Metadata API, so they can be slower than other audits. If any required metadata can't be read, the audit fails and returns no partial output. Reverse record-type audits need `--target`; `--sobject` isn't supported.

## Snapshot before a destructive change

`strip` and `freeze` change data. Save a snapshot first so you can restore it:

```bash
sf warden strip --target-org myOrg --user 'Username:user@example.com' \
  --snapshot ./pre-strip.json --dry-run
```

`--snapshot` writes the file even with `--dry-run`, so you can inspect it before running the real strip.

## Next steps

* [Command details](command-details.md): merge logic, precedence tables, and assignment modes.
* [Connected org writes](connected-org-writes.md): the optional ledger and run log.
* [Access audits](access-audits.md): scopes, attribution, muting, and output.
* [Output contract](output-contract.md): formats, destinations, CSV shape, and `--json`.
* [Lifecycle output and snapshots](lifecycle-output.md): identities, labels, snapshots, and action reports.
* [Interactive mode](interactive-mode.md): guided prompts for all eight commands.
* Every flag: the [Commands](https://github.com/Syntax-Syllogism/warden/blob/v0.7.0/README.md#commands) section of the README, or `--help` on any command.
