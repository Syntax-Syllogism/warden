---
title: Getting started with Warden
description: Install Warden and run your first Salesforce user lifecycle workflow.
---

# Getting started with warden

`warden` is a Salesforce CLI plugin for user lifecycle administration: access
auditing, drift diffing, provisioning, freeze/unfreeze, and snapshot/restore.
This guide gets you from zero to your first provisioning run.

## Install

```bash
sf plugins install @syntax-syllogism/warden@x.y.z
```

Or build from source (see [Contributing](https://github.com/Syntax-Syllogism/warden/blob/v0.6.0/README.md#contributing)):

```bash
git clone https://github.com/Syntax-Syllogism/warden.git
cd warden
yarn install
yarn build
node ./bin/dev.js warden --help
```

## Concepts

warden's commands fall into three groups:

* **Read-only audits** — [`access`](access-audits.md) and
  [`diff`](command-details.md#warden-diff) never write to the org. Use these
  to answer "who can see X" or "what's different between this user and their
  intended state" before you touch anything.
* **State-changing lifecycle actions** — `provision`, `freeze`, `unfreeze`,
  `strip`, and `restore` perform DML. Every one of them supports `--dry-run`
  to preview planned changes first, and `--no-prompt` to skip the confirmation
  prompt once you trust the plan (e.g. in CI).
  All eight commands also support `-i`/`--interactive` for guided flag
  collection and a resolved-values confirmation; see
  [Interactive mode](interactive-mode.md).
* **Portable state** — `snapshot` captures a user's active/frozen state and
  assignments to a JSON or CSV file; the output extension selects the format
  and `restore` accepts either one. Snapshots use developer/API names when
  available, with Ids as a fallback, so they're portable across orgs where the
  referenced names exist.

## Your first provisioning run

1. Write a persona definition file describing reusable access bundles. See
   the [persona example](command-details.md#example-personasjson) for a full
   example.
2. Write a user definition file listing the people to provision, each
   referencing one or more personas by name. See the [user definition
   example](command-details.md#example-usersjson).
3. Preview the plan without writing anything:

   ```bash
   sf warden provision --target-org myOrg \
     --users-def ./users.json --personas-def ./personas.json \
     --external-id FederationIdentifier --dry-run
   ```

4. Once the plan looks right, apply it:

   ```bash
   sf warden provision --target-org myOrg \
     --users-def ./users.json --personas-def ./personas.json \
     --external-id FederationIdentifier --no-prompt
   ```

For a guided run that asks for the definition files and remaining options,
use `sf warden provision -i`. Interactive mode is terminal-only and its
single summary confirmation replaces the normal write confirmation for that
run.

For the full merge/precedence rules behind `provision` (multiple personas per
user, assignment modes, Username/Alias defaults), see
[Provisioning logic](command-details.md#provisioning-logic) in the command
details doc.

## Auditing before you change anything

Before provisioning or stripping access, it's often useful to see current
state:

```bash
# Who can see this custom field today?
sf warden access --target-org myOrg --type field --target Account.CustomField__c

# How does each defined user's actual access compare to their personas?
sf warden diff --target-org myOrg \
  --users-def ./users.json --personas-def ./personas.json
```

Both commands are read-only and perform no writes to the org.

To audit record-type visibility, use an active non-master record type's
qualified API name. The forward and reverse forms are:

```bash
sf warden access --target-org myOrg --type record-type \
  --target Account.Business_Account
sf warden access --target-org myOrg --user 'Username:alice@example.com' \
  --type record-type --target Account.Business_Account
```

Record-type access uses Metadata API reads for connected Profiles and Permission
Sets, so it may be slower than data-API audits and fails without partial output
if required metadata cannot be read. Reverse record-type audits require
`--target`; `--sobject` is not available for this target.

## Snapshot before a destructive change

`strip` and `freeze` are DML operations. Capture a restorable snapshot first:

```bash
sf warden strip --target-org myOrg --user 'Username:user@example.com' \
  --snapshot ./pre-strip.json --dry-run
```

`--snapshot` writes the file even during `--dry-run`, so you can inspect the
snapshot before deciding whether to run the real strip.

## Next steps

* [Command details](command-details.md) — provisioning merge logic, field
  precedence tables, match resolution, and assignment modes.
* [Access audits](access-audits.md) — target and reverse-user access scopes,
  attribution, muting, and output behavior.
* [Output contract](output-contract.md) — output formats, file destinations,
  CSV shape, and global `--json` behavior.
* [Lifecycle output and snapshots](lifecycle-output.md) — resolved user
  identity, assignment labels, snapshots, and action reporting.
* [Interactive mode](interactive-mode.md) — guided flag collection and
  confirmation behavior for all eight commands.
* [Example definitions](command-details.md#example-usersjson) — full
  `users.json` and `personas.json` samples are included in command details.
* Full CLI reference: see the [Commands](https://github.com/Syntax-Syllogism/warden/blob/v0.6.0/README.md#commands) section of
  the README, or run any command with `--help`.
