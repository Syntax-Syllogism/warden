# Getting started with warden

`warden` is a Salesforce CLI plugin for user lifecycle administration: access
auditing, drift diffing, provisioning, freeze/unfreeze, and snapshot/restore.
This guide gets you from zero to your first provisioning run.

## Install

```bash
sf plugins install @syntax-syllogism/warden@x.y.z
```

Or build from source (see [Contributing](../README.md#contributing)):

```bash
git clone git@github.com:jprichter/warden
cd warden
yarn && yarn build
./bin/dev.js warden --help
```

## Concepts

warden's commands fall into three groups:

* **Read-only audits** — [`access`](command-details.md#warden-access) and
  [`diff`](command-details.md#warden-diff) never write to the org. Use these
  to answer "who can see X" or "what's different between this user and their
  intended state" before you touch anything.
* **State-changing lifecycle actions** — `provision`, `freeze`, `unfreeze`,
  and `strip` perform DML. Every one of them supports `--dry-run` to preview
  planned changes first, and `--no-prompt` to skip the confirmation prompt
  once you trust the plan (e.g. in CI).
* **Portable state** — `snapshot` captures a user's active/frozen state and
  assignments to a JSON file; `restore` re-applies it later. Snapshots use
  developer/API names, not Ids, so they're portable across orgs.

## Your first provisioning run

1. Write a persona definition file describing reusable access bundles. See
   [`personas.json`](examples/personas.json) for a full example.
2. Write a user definition file listing the people to provision, each
   referencing one or more personas by name. See
   [`users.json`](examples/users.json).
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

# How does this user's actual access compare to what their personas say it should be?
sf warden diff --target-org myOrg --user 'Username:user@example.com' \
  --personas-def ./personas.json
```

Both commands are read-only — safe to run against production at any time.

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
  precedence tables, match resolution, assignment modes, and access-audit
  notes.
* [Example definition files](examples/) — full `users.json` and
  `personas.json` samples.
* Full CLI reference: see the [Commands](../README.md#commands) section of
  the README, or run any command with `--help`.
