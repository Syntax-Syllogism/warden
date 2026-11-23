# warden

[![NPM](https://img.shields.io/npm/v/@syntax-syllogism/warden.svg?label=%40syntax-syllogism%2Fwarden)](https://www.npmjs.com/package/@syntax-syllogism/warden) [![Downloads/week](https://img.shields.io/npm/dw/@syntax-syllogism/warden.svg)](https://npmjs.org/package/@syntax-syllogism/warden) [![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://raw.githubusercontent.com/Syntax-Syllogism/warden/release/LICENSE)

A Salesforce CLI plugin for managing the lifecycle of your users. Use it to audit who has access to what, compare users against the access they should have, provision users from reusable personas (named bundles of profile, role, permission sets, groups, and queues), freeze and unfreeze users, and snapshot and restore their access.

## Install

You need the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) and an authorized org.

```bash
sf plugins install @syntax-syllogism/warden
```

This installs the latest release. To pin one, append `@x.y.z` with a version from the [changelog](CHANGELOG.md).

Warden has three parts:

- **Warden CLI** (this repo): the `sf warden` commands, installed as above.
- **[Warden VS Code extension](https://github.com/Syntax-Syllogism/warden-vscode-extension)**: a guided front end for the same commands, with a sidebar and Command Palette entries. It needs this plugin installed.
- **[warden-base](https://github.com/Syntax-Syllogism/warden-base)**: the optional Salesforce package that stores the org-side objects (personas, assignments, provisioning runs and the grant ledger). Install it in each org that uses those features:

  ```bash
  sf package install --package "$WARDEN_BASE_04T" --target-org "$ORG_ALIAS" \
    --security-type AdminsOnly --wait 30 --publish-wait 10 --no-prompt --json
  ```

  Copy the `04t` ID from the package's [installation guide](https://github.com/Syntax-Syllogism/warden-base/blob/release/docs/installation.md). Without warden-base, the commands that read personas from the org or write audit records to the org are unavailable, and the other commands run as usual.

## Quick start

`myOrg` is the alias of an org you have authorized (for example with `sf org login web --alias myOrg`). The `./users.json` and `./personas.json` files are described in [Provisioning](docs/provisioning.md#example-usersjson), and samples are in [`docs/examples`](docs/examples/users.json).

```bash
# Who can use this Apex class?
sf warden access --target-org myOrg --type apex-class --target My_Apex_Class

# How does each user's access differ from their personas?
sf warden diff --target-org myOrg --users-def ./users.json --personas-def ./personas.json

# Save a user's access, then restore it later
sf warden snapshot --target-org myOrg --user 'Username:user@example.com' --out ./snapshot.json
sf warden restore --target-org myOrg --snapshot ./snapshot.json

# Freeze and unfreeze a user
sf warden freeze --target-org myOrg --user 'Username:user@example.com'
sf warden unfreeze --target-org myOrg --user 'Username:user@example.com'

# Provision users from definition files
sf warden provision --target-org myOrg --users-def ./users.json --personas-def ./personas.json

# Strip a user's access and deactivate them (snapshot first)
sf warden strip --target-org myOrg --user 'Username:user@example.com' --snapshot ./pre-strip.json
```

Commands that change data (`provision`, `freeze`, `unfreeze`, `strip`, `restore`) accept `--dry-run` to preview the changes first.

Exit codes: `0` means no per-user failures. `1` means at least one user failed or the command itself errored. `diff` returns `0` when it finds drift unless you pass `--fail-on-drift`. See the [output contract](docs/output-contract.md#exit-codes) for the details, including how `--json` behaves.

## Documentation

New here? Start with [Getting started](docs/getting-started.md). It defines the key terms and walks through a first audit and provisioning run.

- [Provisioning](docs/provisioning.md): how provisioning merges personas, and the example definition files
- [Command details](docs/command-details.md): how diff, access, snapshot, restore, freeze, unfreeze and strip behave
- [Access audits](docs/access-audits.md): who can access a field, object, or other target, and why
- [User matching](docs/user-matching.md): how commands find the users you name
- [Lifecycle output and snapshots](docs/lifecycle-output.md): what freeze, strip, restore, and snapshot report
- [Output contract](docs/output-contract.md): output formats, file destinations, and exit codes
- [Connected org writes](docs/connected-org-writes.md): the warden-base audit records and the permission sets the CLI needs
- [CLI reference](docs/cli-reference.md): every command and flag

The [full documentation index](docs/README.md) lists the rest.

## Contributing

Read the [Code of Conduct](CODE_OF_CONDUCT.md) and [CONTRIBUTING.md](CONTRIBUTING.md), which also covers building from source and running the tests. Open an issue before starting work so we can avoid duplicate effort. Pull requests need unit tests.

Report problems at <https://github.com/Syntax-Syllogism/warden/issues>. Report security vulnerabilities as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Commands

Every command, flag and example is in the [CLI reference](docs/cli-reference.md). Run any command with `--help` for the same text.
