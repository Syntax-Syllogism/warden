---
title: Getting started with Warden
description: Install Warden and run your first Salesforce user lifecycle workflow.
---

# Getting started with warden

`warden` is a Salesforce CLI plugin for managing users over their lifetime: auditing access, finding drift, provisioning, promoting personas, freezing and unfreezing, and snapshotting and restoring. This guide is for Salesforce admins and developers who are new to Warden. It takes you from install to your first audit and your first provisioning run.

## Key terms

- **Persona**: a named, reusable bundle of access, such as a profile, a role, permission sets, permission set groups, public groups, queues, and default user fields. You define personas in a JSON file (or store them in an org) and assign them to users.
- **Provisioning**: creating or updating users so they match their personas.
- **Drift**: the difference between the access a user has in the org and the access they should have.
- **Strip**: removing a user's access. By default it freezes the user, removes their access grants, and deactivates them.
- **Snapshot**: a file that records a user's active/frozen state and assignments, so you can restore it later.
- **warden-base**: an optional Salesforce package that stores personas and audit records in an org. See [Optional: install warden-base](#optional-install-warden-base).

## Install

You need the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) and an org you can log in to.

```bash
sf plugins install @syntax-syllogism/warden@x.y.z
```

Replace `x.y.z` with a release version from the [changelog](https://github.com/Syntax-Syllogism/warden/blob/release/CHANGELOG.md). To build from source instead, see [Contributing](https://github.com/Syntax-Syllogism/warden/blob/release/CONTRIBUTING.md#development-setup).

Log in to the org you want to work in. The examples use `myOrg` as the alias:

```bash
sf org login web --alias myOrg
```

The Warden VS Code extension runs these same commands from VS Code's sidebar and Command Palette. It needs this plugin installed, and it targets the same orgs as the CLI.

## How the commands fit together

Warden's commands fall into four groups.

- **Read-only audits.** [`access`](access-audits.md), [`diff`](command-details.md#warden-diff), and `persona diff` never write to the org. Use them to answer "who can see this?", "how does this user differ from what they should have?", and "what differs from the org's personas?" before you change anything.
- **Lifecycle actions that change data.** `provision`, `freeze`, `unfreeze`, `strip`, and `restore` write to the org. Each supports `--dry-run` to preview the changes, and `--no-prompt` to skip the confirmation once you trust the plan (in CI, for example). All eight core commands (`access`, `diff`, `freeze`, `provision`, `restore`, `snapshot`, `strip`, `unfreeze`) also support `-i`/`--interactive`; see [Interactive mode](interactive-mode.md).
- **Portable state.** `snapshot` saves a user's active/frozen state and assignments to a JSON or CSV file. The file extension picks the format, and `restore` reads either. Snapshots use developer/API names where they exist and fall back to Ids, so they work across orgs that share those names.
- **Persona promotion.** `persona export` and `persona diff` read the org's personas; `persona import` writes them. See [Persona promotion](persona-promotion.md).

## Audit before you change anything

Start with a read-only command. Neither of these writes to the org:

```bash
# Who can see this custom field today?
sf warden access --target-org myOrg --type field --target Account.CustomField__c

# How does each user's actual access compare to their personas?
sf warden diff --target-org myOrg \
  --users-def ./users.json --personas-def ./personas.json
```

The second command needs the definition files from the next section.

To audit record-type visibility, use the qualified API name of an active, non-master record type:

```bash
sf warden access --target-org myOrg --type record-type \
  --target Account.Business_Account
sf warden access --target-org myOrg --user 'Username:alice@example.com' \
  --type record-type --target Account.Business_Account
```

Record-type audits read Profile and Permission Set metadata through the Metadata API, so they can be slower than other audits. If any required metadata can't be read, the audit fails and returns no partial output. Reverse record-type audits need `--target`; `--sobject` isn't supported.

## Your first provisioning run

1. Write a persona file that describes your reusable access bundles. See the [persona example](provisioning.md#example-personasjson).
2. Write a user file that lists the people to provision. Each user names one or more personas. See the [user example](provisioning.md#example-usersjson).
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

For the rules behind `provision` (several personas per user, assignment modes, Username and Alias defaults), see [Provisioning logic](provisioning.md#provisioning-logic).

## Snapshot before a destructive change

`strip` and `freeze` change data. Save a snapshot first so you can restore it:

```bash
sf warden strip --target-org myOrg --user 'Username:user@example.com' \
  --snapshot ./pre-strip.json --dry-run
```

`--snapshot` writes the file even with `--dry-run`, so you can inspect it before running the real strip. To bring the user back, run `sf warden restore --target-org myOrg --snapshot ./pre-strip.json`.

## Optional: install warden-base

The org-side objects that Warden uses (personas, persona assignments, provisioning runs and items, and the provisioned-grant ledger) come from the [warden-base](https://github.com/Syntax-Syllogism/warden-base) package, not from this plugin. Install it in each org where you want persona storage or audit records. It is an unlocked Salesforce package. Install it as a Salesforce administrator with `AdminsOnly`:

```bash
sf package install --package "$WARDEN_BASE_04T" --target-org "$ORG_ALIAS" \
  --security-type AdminsOnly --wait 30 --publish-wait 10 --no-prompt --json
```

Copy the `04t` ID from the [warden-base installation guide](https://github.com/Syntax-Syllogism/warden-base/blob/release/docs/installation.md), then assign its permission sets to the users who need them. Warden works without the package for the commands that don't read or write those objects. See [Connected org writes](connected-org-writes.md) for what the package enables.

### Promote personas through an org

With warden-base installed, you can store personas in the org and use them when provisioning. Export them, check for drift, and import your changes when you're ready:

```bash
sf warden persona export --target-org myOrg --output personas.json
sf warden persona diff --target-org myOrg --input personas.json
sf warden persona import --target-org myOrg --input personas.json --dry-run
sf warden persona import --target-org myOrg --input personas.json
```

Add `--prune` to `persona import` to remove components that exist in the org but aren't listed for the personas in your file. Import never deletes or deactivates a persona that is missing from the file. See [Persona promotion](persona-promotion.md) for how the source is chosen.

## Next steps

- [Command details](command-details.md): merge logic, precedence tables, and assignment modes.
- [Related-record provisioning](related-records.md): before/after records, context lookups, and User linking.
- [Connected org writes](connected-org-writes.md): the optional ledger and run log.
- [Access audits](access-audits.md): scopes, attribution, muting, and output.
- [Output contract](output-contract.md): formats, destinations, CSV shape, and `--json`.
- [Lifecycle output and snapshots](lifecycle-output.md): identities, labels, snapshots, and action reports.
- [Interactive mode](interactive-mode.md): guided prompts for all eight commands.
- Every flag: the [CLI reference](cli-reference.md), or `--help` on any command.
