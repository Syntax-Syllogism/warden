# warden

[![NPM](https://img.shields.io/npm/v/@syntax-syllogism/warden.svg?label=%40syntax-syllogism%2Fwarden)](https://www.npmjs.com/package/@syntax-syllogism/warden) [![Downloads/week](https://img.shields.io/npm/dw/@syntax-syllogism/warden.svg)](https://npmjs.org/package/@syntax-syllogism/warden) [![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://raw.githubusercontent.com/Syntax-Syllogism/warden/release/LICENSE)

a Salesforce CLI plugin for user lifecycle administration — access auditing, drift diffing, provisioning, freeze/unfreeze, and snapshot/restore.

## Install

```bash
sf plugins install @syntax-syllogism/warden@x.y.z
```

## Quick start

```bash
# Audit active-user access for a permission target
sf warden access --target-org myOrg --type apex-class --target My_Apex_Class

# Compare a user's current assignments against an intended persona
sf warden diff --target-org myOrg --user 'Username:user@example.com' --personas-def ./personas.json

# Snapshot a user's assignment state, then restore it later
sf warden snapshot --target-org myOrg --user 'Username:user@example.com' --out ./snapshot.json
sf warden restore --target-org myOrg --snapshot ./snapshot.json

# Freeze / unfreeze users
sf warden freeze --target-org myOrg --user 'Username:user@example.com'
sf warden unfreeze --target-org myOrg --user 'Username:user@example.com'

# Provision users from definition files
sf warden provision --target-org myOrg --users-def ./users.json --personas-def ./personas.json

# Strip access and deactivate a user (snapshotting first)
sf warden strip --target-org myOrg --user 'Username:user@example.com' --snapshot ./pre-strip.json
```

## Documentation

* [Getting started](docs/getting-started.md)
* [Command details](docs/command-details.md) — provisioning merge logic, field
  precedence tables, match resolution, and assignment modes.
* [Access audits](docs/access-audits.md) — target and reverse-user access
  scopes, attribution, muting, and output behavior.
* [Output contract](docs/output-contract.md) — output formats, file
  destinations, CSV shape, and global `--json` behavior.
* [User matching](docs/user-matching.md) — filterable fields, fuzzy Username
  resolution, and lifecycle targeting behavior.
* [Lifecycle output and snapshots](docs/lifecycle-output.md) — resolved user
  identity, assignment labels, snapshots, and action reporting.
* [Example definitions](docs/command-details.md#example-usersjson) — sample
  `users.json`, `users.csv`, and `personas.json` files.

## Issues

Please report any issues at <https://github.com/Syntax-Syllogism/warden/issues>.

## Contributing

1. Please read our [Code of Conduct](CODE_OF_CONDUCT.md).
2. Create a new issue before starting your project so that we can keep track of what you are trying to add/fix. That way, we can also offer suggestions or let you know if there is already an effort in progress.
3. Fork this repository.
4. [Build the plugin locally](#build).
5. Create a _topic_ branch in your fork. Note, this step is recommended but technically not required if contributing using a fork.
6. Edit the code in your fork.
7. Write appropriate tests for your changes. Try to achieve at least 75% code coverage on any new code. No pull request will be accepted without unit tests.
8. Send us a pull request when you are done. We'll review your code, suggest any needed changes, and merge it in.

### Build

To build the plugin locally, make sure to have yarn installed and run the following commands:

```bash
# Clone the repository
git clone git@github.com:Syntax-Syllogism/warden

# Install the dependencies and compile
yarn install
yarn build
```

To use your plugin locally, invoke the development launcher through Node:

```bash
# Run using local run file.
node ./bin/dev.js warden freeze --help
```

There should be no differences when running via the Salesforce CLI or using the local run file. However, it can be useful to link the plugin to do some additional testing or run your commands from anywhere on your machine.

```bash
# Link your plugin to the sf cli
sf plugins link .
# To verify
sf plugins
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command ran without per-user failures. `diff` also returns `0` when drift is present unless `--fail-on-drift` is set, and `diff --verify` returns `0` when all users conform. |
| `1` | The command ran with one or more per-user failures, `diff --fail-on-drift` detected drift, or `diff --verify` found a non-conformant user. Command errors also use exit code `1` through oclif. |

With global `--json`, a partial per-user failure or a non-conformant verify
result still reports `status: 0` in the Salesforce CLI envelope while the
process exits with code `1`. The result payload is unchanged so callers can
inspect the per-user errors or verdicts.

## Commands

<!-- commands -->
* [`sf warden access`](#sf-warden-access)
* [`sf warden diff`](#sf-warden-diff)
* [`sf warden freeze`](#sf-warden-freeze)
* [`sf warden provision`](#sf-warden-provision)
* [`sf warden restore`](#sf-warden-restore)
* [`sf warden snapshot`](#sf-warden-snapshot)
* [`sf warden strip`](#sf-warden-strip)
* [`sf warden unfreeze`](#sf-warden-unfreeze)

## `sf warden access`

Audit active-user access for a permission target.

```
USAGE
  $ sf warden access [--json] [--flags-dir <value>] [-o <value>] [--type
    field|object|apex-class|vf-page|custom-permission|tab] [--target <value>] [--user <value>] [--sobject <value>]
    [--output human|csv|json] [--output-file <value>] [--api-version <value>] [-i]

FLAGS
  -i, --interactive          Prompt for missing command values, summarize them, and confirm before continuing.
  -o, --target-org=<value>   Target org username or alias.
      --api-version=<value>  Override the api version used for the org connection.
      --output=<option>      [default: human] Output format: human, csv, or json. Defaults to human.
                             <options: human|csv|json>
      --output-file=<value>  Write the machine-readable output payload to this path.
      --sobject=<value>      In reverse user mode, report field or object access scoped to this SObject.
      --target=<value>       Target API name. Use Object.Field for field, Object for object, Apex class name for
                             apex-class, Visualforce page name for vf-page, custom permission DeveloperName for
                             custom-permission, or tab API name for tab.
      --type=<option>        Target type to audit: field, object, apex-class, vf-page, custom-permission, or tab.
                             <options: field|object|apex-class|vf-page|custom-permission|tab>
      --user=<value>         Reverse audit for one user, using field:value matching (for example
                             Username:alice@example.com).

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Audit active-user access for a permission target.

  Resolves active users who have access to a target and attributes each access path to Profile, Permission Set, or
  Permission Set Group sources.

EXAMPLES
  Field access in human output (default):

    $ sf warden access --type field --target Account.CustomField__c --target-org myOrg

  Object access in csv output:

    $ sf warden access --type object --target Account --target-org myOrg --output csv

  Field access in json output:

    $ sf warden access --type field --target Account.CustomField__c --target-org myOrg --output json

  Apex class access in human output:

    $ sf warden access --type apex-class --target MyController --target-org myOrg

  Visualforce page access in csv output:

    $ sf warden access --type vf-page --target MyPage --target-org myOrg --output csv

  Custom permission access in json output:

    $ sf warden access --type custom-permission --target Can_Edit_Accounts --target-org myOrg --output json

  Tab visibility in human output:

    $ sf warden access --type tab --target Account --target-org myOrg

  Reverse field access for one user:

    $ sf warden access --user 'Username:alice@example.com' --type field --target Account.CustomField__c --target-org \
      myOrg

  Reverse object access across an SObject:

    $ sf warden access --user 'Username:alice@example.com' --type object --sobject Account --target-org myOrg \
      --output json

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/access.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/src/commands/warden/access.ts)_

## `sf warden diff`

Compare users against an intended definition or another user.

```
USAGE
  $ sf warden diff [--json] [--flags-dir <value>] [-o <value>] [--user <value>] [--against <value>] [--users-def
    <value>] [--personas-def <value>] [--external-id <value>] [--input-format json|csv] [--csv-list-delimiter <value>]
    [--output human|csv|json] [--output-file <value>] [--verbose] [--fail-on-drift] [--verify] [--api-version <value>]
    [-i]

FLAGS
  -i, --interactive                 Prompt for missing command values, summarize them, and confirm before continuing.
  -o, --target-org=<value>          Target org username or alias.
      --against=<value>             Reference user to compare against using `field:value`.
      --api-version=<value>         Override the api version used for the org connection.
      --csv-list-delimiter=<value>  Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.
      --external-id=<value>         Default User field used to match entries in `--users-def`.
      --fail-on-drift               Exit with code 1 when any user has access drift.
      --input-format=<option>       Override users-def format detection: json or csv.
                                    <options: json|csv>
      --output=<option>             [default: human] Output format: human, csv, or json. Defaults to human.
                                    <options: human|csv|json>
      --output-file=<value>         Write the machine-readable output payload to this path.
      --personas-def=<value>        Optional path to persona definition JSON file. Omit it for profile-only diffing.
      --user=<value>                Target user to compare using `field:value`.
      --users-def=<value>           Path to a user definition JSON or CSV file.
      --verbose                     Include assignments that are already present in both sides in human output.
      --verify                      Check whether users conform to their intended definition.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Compare users against an intended definition or another user.

  Reports read-only drift across profile, role, permission sets, permission set groups, public groups, and queues
  without applying changes.

EXAMPLES
  Compare users in a definition file against their personas:

    $ sf warden diff --users-def config/user-def.json --personas-def config/persona-def.json --external-id \
      FederationIdentifier --target-org myOrg

  Compare one user against another:

    $ sf warden diff --user username:new@example.com --against username:template@example.com --target-org myOrg \
      --output csv

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/diff.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/src/commands/warden/diff.ts)_

## `sf warden freeze`

Freeze one or more users.

```
USAGE
  $ sf warden freeze [--json] [--flags-dir <value>] [-o <value>] [--user <value>] [--users-def <value>]
    [--external-id <value>] [--input-format json|csv] [--csv-list-delimiter <value>] [--output human|csv|json]
    [--output-file <value>] [--no-prompt] [--dry-run] [--api-version <value>] [-i]

FLAGS
  -i, --interactive                 Prompt for missing command values, summarize them, and confirm before continuing.
  -o, --target-org=<value>          Target org username or alias.
      --api-version=<value>         Override the api version used for the org connection.
      --csv-list-delimiter=<value>  Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.
      --dry-run                     Validate and plan actions without any write operations.
      --external-id=<value>         Default User field used to match entries in `--users-def`.
      --input-format=<option>       Override users-def format detection: json or csv.
                                    <options: json|csv>
      --no-prompt                   Skip confirmation prompts before write operations.
      --output=<option>             [default: human] Output format: human, csv, or json. Defaults to human.
                                    <options: human|csv|json>
      --output-file=<value>         Write the machine-readable output payload to this path.
      --user=<value>                Target a single user using `field:value`.
      --users-def=<value>           Path to a user definition JSON or CSV file.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Freeze one or more users.

  Freezes matching users by setting `UserLogin.IsFrozen = true` and leaving all other access untouched.

EXAMPLES
  Preview a single freeze by field match:

    $ sf warden freeze --user username:someone@example.com --dry-run --target-org myOrg

  Freeze users from a definition file without prompts:

    $ sf warden freeze --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg \
      --no-prompt

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/freeze.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/src/commands/warden/freeze.ts)_

## `sf warden provision`

Provision users from user and persona definition files.

```
USAGE
  $ sf warden provision [--json] [--flags-dir <value>] [-o <value>] [--users-def <value>] [--personas-def <value>]
    [--related-def <value>] [--external-id <value>] [--input-format json|csv] [--csv-list-delimiter <value>]
    [--fuzzy-username] [--no-prompt] [--dry-run] [--fail-on-insufficient-license] [--output human|csv|json]
    [--output-file <value>] [--api-version <value>] [-i]

FLAGS
  -i, --interactive                   Prompt for missing command values, summarize them, and confirm before continuing.
  -o, --target-org=<value>            Target org username or alias.
      --api-version=<value>           Override the api version used for the org connection.
      --csv-list-delimiter=<value>    Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.
      --dry-run                       Validate and plan actions without any write operations.
      --external-id=<value>           Filterable User field used to match existing users by default. `--match-field` is
                                      an alias. Per-user `match` overrides this for individual rows. If omitted, all
                                      entries are treated as inserts. Multiple matches are skipped.
      --fail-on-insufficient-license  Fail after dry-run output when projected net-new users exceed user-license
                                      headroom.
      --fuzzy-username                Match Username values with optional Salesforce sandbox suffixes.
      --input-format=<option>         Override users-def format detection: json or csv.
                                      <options: json|csv>
      --no-prompt                     Skip warning confirmation prompts.
      --output=<option>               [default: human] Output format: human, csv, or json. Defaults to human.
                                      <options: human|csv|json>
      --output-file=<value>           Write the machine-readable output payload to this path.
      --personas-def=<value>          Optional path to persona definition JSON file. Omit it for profile-only
                                      provisioning.
      --related-def=<value>           Optional path to a related-record definition JSON file. Declares named
                                      relationships a user entry selects with a `related` array. Only `phase: "after"`
                                      relationships are supported; requires a JSON `--users-def`.
      --users-def=<value>             Path to a user definition JSON or CSV file.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Provision users from user and persona definition files.

  Provisions Salesforce users by merging multiple personas per user into an effective persona (unioning assignment
  lists, enforcing singular-value agreement), applying insert-only Username and Alias defaults, enforcing optional
  profile and role, activating and unfreezing users, and planning or applying assignment changes. `--personas-def` is
  optional for profile-only provisioning.

  Matching accepts any filterable User field. A match with more than one result is skipped. Use `--fuzzy-username` for
  sandbox username suffixes, or set `fuzzyUsername: true` on an individual user; the per-user value overrides the global
  flag.

EXAMPLES
  Dry run with explicit external id:

    $ sf warden provision --users-def config/user-def.json --personas-def config/persona-def.json --external-id \
      FederationIdentifier --target-org myOrg --dry-run

  Dry run matching by another filterable User field:

    $ sf warden provision --users-def config/user-def.json --personas-def config/persona-def.json --match-field \
      LastName --target-org myOrg --dry-run

  Apply provisioning with no prompt:

    $ sf warden provision --users-def config/user-def.json --personas-def config/persona-def.json --target-org myOrg \
      --no-prompt

  Match production usernames to sandbox-suffixed users:

    $ sf warden provision --users-def config/user-def.json --personas-def config/persona-def.json --fuzzy-username \
      --target-org mySandbox --dry-run

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/provision.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/src/commands/warden/provision.ts)_

## `sf warden restore`

Restore user assignment state from a snapshot file.

```
USAGE
  $ sf warden restore [--json] [--flags-dir <value>] [-o <value>] [--snapshot <value>] [--output human|csv|json]
    [--output-file <value>] [--no-prompt] [--dry-run] [--api-version <value>] [-i]

FLAGS
  -i, --interactive          Prompt for missing command values, summarize them, and confirm before continuing.
  -o, --target-org=<value>   Target org username or alias.
      --api-version=<value>  Override the api version used for the org connection.
      --dry-run              Validate and plan actions without any write operations.
      --no-prompt            Skip confirmation prompts before write operations.
      --output=<option>      [default: human] Output format: human, csv, or json. Defaults to human.
                             <options: human|csv|json>
      --output-file=<value>  Write the machine-readable output payload to this path.
      --snapshot=<value>     Path to a user snapshot JSON or CSV file.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Restore user assignment state from a snapshot file.

  Re-resolves users by the snapshot match key, reactivates and unfreezes them, and adds missing assignments without
  removing existing access.

EXAMPLES
  Preview a restore:

    $ sf warden restore --snapshot snapshots/user.json --dry-run --target-org myOrg

  Restore without prompts:

    $ sf warden restore --snapshot snapshots/user.json --target-org myOrg --no-prompt

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/restore.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/src/commands/warden/restore.ts)_

## `sf warden snapshot`

Capture user assignment state to a portable snapshot file.

```
USAGE
  $ sf warden snapshot [--json] [--flags-dir <value>] [-o <value>] [--user <value>] [--users-def <value>]
    [--external-id <value>] [--input-format json|csv] [--csv-list-delimiter <value>] [--output human|csv|json]
    [--output-file <value>] [--out <value>] [--api-version <value>] [-i]

FLAGS
  -i, --interactive                 Prompt for missing command values, summarize them, and confirm before continuing.
  -o, --target-org=<value>          Target org username or alias.
      --api-version=<value>         Override the api version used for the org connection.
      --csv-list-delimiter=<value>  Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.
      --external-id=<value>         Default User field used to match entries in `--users-def`.
      --input-format=<option>       Override users-def format detection: json or csv.
                                    <options: json|csv>
      --out=<value>                 Path to write the snapshot JSON or CSV file. The extension selects the format.
      --output=<option>             [default: human] Output format: human, csv, or json. Defaults to human.
                                    <options: human|csv|json>
      --output-file=<value>         Write the machine-readable output payload to this path.
      --user=<value>                Target a single user using `field:value`.
      --users-def=<value>           Path to a user definition JSON or CSV file.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Capture user assignment state to a portable snapshot file.

  Captures matching users' active/frozen state and access assignments using developer/API names so the snapshot can be
  restored later.

EXAMPLES
  Snapshot a single user:

    $ sf warden snapshot --user username:someone@example.com --out snapshots/user.json --target-org myOrg

  Snapshot users from a definition file:

    $ sf warden snapshot --users-def config/user-def.json --external-id FederationIdentifier --out \
      snapshots/users.json --target-org myOrg

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/snapshot.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/src/commands/warden/snapshot.ts)_

## `sf warden strip`

Strip and deactivate one or more users.

```
USAGE
  $ sf warden strip [--json] [--flags-dir <value>] [-o <value>] [--user <value>] [--users-def <value>]
    [--external-id <value>] [--input-format json|csv] [--csv-list-delimiter <value>] [--no-prompt] [--dry-run]
    [--no-freeze] [--no-deactivate] [--keep-permsets] [--keep-permset-groups] [--keep-licenses] [--keep-public-groups]
    [--keep-queues] [--snapshot <value>] [--output human|csv|json] [--output-file <value>] [--api-version <value>] [-i]

FLAGS
  -i, --interactive                 Prompt for missing command values, summarize them, and confirm before continuing.
  -o, --target-org=<value>          Target org username or alias.
      --api-version=<value>         Override the api version used for the org connection.
      --csv-list-delimiter=<value>  Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.
      --dry-run                     Validate and plan actions without any write operations.
      --external-id=<value>         Default User field used to match entries in `--users-def`.
      --input-format=<option>       Override users-def format detection: json or csv.
                                    <options: json|csv>
      --keep-licenses               Keep permission set license assignments.
      --keep-permset-groups         Keep permission set group assignments.
      --keep-permsets               Keep permission set assignments.
      --keep-public-groups          Keep public group memberships.
      --keep-queues                 Keep queue memberships.
      --no-deactivate               Skip the final deactivation step.
      --no-freeze                   Skip the initial freeze step.
      --no-prompt                   Skip confirmation prompts before write operations.
      --output=<option>             [default: human] Output format: human, csv, or json. Defaults to human.
                                    <options: human|csv|json>
      --output-file=<value>         Write the machine-readable output payload to this path.
      --snapshot=<value>            Write a portable user snapshot JSON or CSV file before stripping access, including
                                    during dry-run. The extension selects the format.
      --user=<value>                Target a single user using `field:value`.
      --users-def=<value>           Path to a user definition JSON or CSV file.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Strip and deactivate one or more users.

  Freezes matching users, removes access grants, and deactivates the user unless the corresponding opt-out flags are
  set.

EXAMPLES
  Preview a strip for a single user:

    $ sf warden strip --user username:someone@example.com --dry-run --target-org myOrg

  Strip users from a definition file without prompts:

    $ sf warden strip --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg \
      --no-prompt

  Keep permission set licenses while stripping everything else:

    $ sf warden strip --users-def config/user-def.json --keep-licenses --target-org myOrg --dry-run

  Capture a restorable snapshot before stripping:

    $ sf warden strip --user username:someone@example.com --snapshot snapshots/user.json --target-org myOrg \
      --no-prompt

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/strip.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/src/commands/warden/strip.ts)_

## `sf warden unfreeze`

Unfreeze one or more users.

```
USAGE
  $ sf warden unfreeze [--json] [--flags-dir <value>] [-o <value>] [--user <value>] [--users-def <value>]
    [--external-id <value>] [--input-format json|csv] [--csv-list-delimiter <value>] [--output human|csv|json]
    [--output-file <value>] [--no-prompt] [--dry-run] [--api-version <value>] [-i]

FLAGS
  -i, --interactive                 Prompt for missing command values, summarize them, and confirm before continuing.
  -o, --target-org=<value>          Target org username or alias.
      --api-version=<value>         Override the api version used for the org connection.
      --csv-list-delimiter=<value>  Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.
      --dry-run                     Validate and plan actions without any write operations.
      --external-id=<value>         Default User field used to match entries in `--users-def`.
      --input-format=<option>       Override users-def format detection: json or csv.
                                    <options: json|csv>
      --no-prompt                   Skip confirmation prompts before write operations.
      --output=<option>             [default: human] Output format: human, csv, or json. Defaults to human.
                                    <options: human|csv|json>
      --output-file=<value>         Write the machine-readable output payload to this path.
      --user=<value>                Target a single user using `field:value`.
      --users-def=<value>           Path to a user definition JSON or CSV file.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Unfreeze one or more users.

  Unfreezes matching users by setting `UserLogin.IsFrozen = false` and leaving all other access untouched.

EXAMPLES
  Preview a single unfreeze by field match:

    $ sf warden unfreeze --user username:someone@example.com --dry-run --target-org myOrg

  Unfreeze users from a definition file without prompts:

    $ sf warden unfreeze --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg \
      --no-prompt

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/unfreeze.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.5.0/src/commands/warden/unfreeze.ts)_
<!-- commandsstop -->
