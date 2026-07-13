# warden

[![NPM](https://img.shields.io/npm/v/@syntax-syllogism/warden.svg?label=%40syntax-syllogism%2Fwarden)](https://www.npmjs.com/package/@syntax-syllogism/warden) [![Downloads/week](https://img.shields.io/npm/dw/@syntax-syllogism/warden.svg)](https://npmjs.org/package/@syntax-syllogism/warden) [![License](https://img.shields.io/badge/License-MIT-brightgreen.svg)](https://raw.githubusercontent.com/Syntax-Syllogism/warden/blob/release/LICENSE)

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
  precedence tables, match resolution, assignment modes, and access-audit notes.
* [Example definition files](docs/examples/) — sample `users.json` and `personas.json`

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
yarn && yarn build
```

To use your plugin, run using the local `./bin/dev.js` file.

```bash
# Run using local run file.
./bin/dev.js warden freeze --help
```

There should be no differences when running via the Salesforce CLI or using the local run file. However, it can be useful to link the plugin to do some additional testing or run your commands from anywhere on your machine.

```bash
# Link your plugin to the sf cli
sf plugins link .
# To verify
sf plugins
```

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
  $ sf warden access -o <value> --type field|object|apex-class|vf-page|custom-permission|tab --target <value>
    [--json] [--flags-dir <value>] [--output human|csv|json] [--api-version <value>]

FLAGS
  -o, --target-org=<value>   (required) Target org username or alias.
      --api-version=<value>  Override the api version used for the org connection.
      --output=<option>      [default: human] Output format: human, csv, or json. Defaults to human.
                             <options: human|csv|json>
      --target=<value>       (required) Target API name. Use Object.Field for field, Object for object, Apex class name
                             for apex-class, Visualforce page name for vf-page, custom permission DeveloperName for
                             custom-permission, or tab API name for tab.
      --type=<option>        (required) Target type to audit: field, object, apex-class, vf-page, custom-permission, or
                             tab.
                             <options: field|object|apex-class|vf-page|custom-permission|tab>

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

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/access.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.1.1/src/commands/warden/access.ts)_

## `sf warden diff`

Compare user assignments against intended persona state or another user.

```
USAGE
  $ sf warden diff -o <value> [--json] [--flags-dir <value>] [--user <value> --against <value>] [--users-def
    <value> --personas-def <value>] [--external-id <value>] [--output human|csv|json] [--verbose] [--api-version
    <value>]

FLAGS
  -o, --target-org=<value>    (required) Target org username or alias.
      --against=<value>       Reference user to compare against using `field:value`.
      --api-version=<value>   Override the api version used for the org connection.
      --external-id=<value>   Default User field used to match entries in `--users-def`.
      --output=<option>       [default: human] Output format when not using global `--json`.
                              <options: human|csv|json>
      --personas-def=<value>  Path to persona definition JSON file.
      --user=<value>          Target user to compare using `field:value`.
      --users-def=<value>     Path to user definition JSON file.
      --verbose               Include assignments that are already present in both sides in human output.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Compare user assignments against intended persona state or another user.

  Reports read-only drift across profile, role, permission sets, permission set groups, public groups, and queues
  without applying changes.

EXAMPLES
  Compare users in a definition file against their personas:

    $ sf warden diff --users-def config/user-def.json --personas-def config/persona-def.json --external-id ^
      FederationIdentifier --target-org myOrg

  Compare one user against another:

    $ sf warden diff --user username:new@example.com --against username:template@example.com --target-org myOrg ^
      --output csv

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/diff.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.1.1/src/commands/warden/diff.ts)_

## `sf warden freeze`

Freeze one or more users.

```
USAGE
  $ sf warden freeze -o <value> [--json] [--flags-dir <value>] [--user <value>] [--users-def <value>]
    [--external-id <value>] [--no-prompt] [--dry-run] [--api-version <value>]

FLAGS
  -o, --target-org=<value>   (required) Target org username or alias.
      --api-version=<value>  Override the api version used for the org connection.
      --dry-run              Validate and plan actions without any write operations.
      --external-id=<value>  Default User field used to match entries in `--users-def`.
      --no-prompt            Skip confirmation prompts before write operations.
      --user=<value>         Target a single user using `field:value`.
      --users-def=<value>    Path to a user definition JSON file.

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

    $ sf warden freeze --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg ^
      --no-prompt

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/freeze.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.1.1/src/commands/warden/freeze.ts)_

## `sf warden provision`

Provision users from user and persona definition files.

```
USAGE
  $ sf warden provision -o <value> --users-def <value> --personas-def <value> [--json] [--flags-dir <value>]
    [--external-id <value>] [--no-prompt] [--dry-run] [--api-version <value>]

FLAGS
  -o, --target-org=<value>    (required) Target org username or alias.
      --api-version=<value>   Override the api version used for the org connection.
      --dry-run               Validate and plan actions without any write operations.
      --external-id=<value>   User field used to match existing users by default. Per-user `match` overrides this for
                              individual rows. If omitted, all entries are treated as inserts.
      --no-prompt             Skip warning confirmation prompts.
      --personas-def=<value>  (required) Path to persona definition JSON file.
      --users-def=<value>     (required) Path to user definition JSON file.

GLOBAL FLAGS
  --flags-dir=<value>  Import flag values from a directory.
  --json               Format output as json.

DESCRIPTION
  Provision users from user and persona definition files.

  Provisions Salesforce users by merging multiple personas per user into an effective persona (unioning assignment
  lists, enforcing singular-value agreement), applying insert-only Username and Alias defaults, enforcing optional
  profile and role, activating and unfreezing users, and planning or applying assignment changes.

EXAMPLES
  Dry run with explicit external id:

    $ sf warden provision --users-def config/user-def.json --personas-def config/persona-def.json --external-id ^
      FederationIdentifier --target-org myOrg --dry-run

  Apply provisioning with no prompt:

    $ sf warden provision --users-def config/user-def.json --personas-def config/persona-def.json --target-org myOrg ^
      --no-prompt

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/provision.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.1.1/src/commands/warden/provision.ts)_

## `sf warden restore`

Restore user assignment state from a snapshot file.

```
USAGE
  $ sf warden restore -o <value> --snapshot <value> [--json] [--flags-dir <value>] [--no-prompt] [--dry-run]
    [--api-version <value>]

FLAGS
  -o, --target-org=<value>   (required) Target org username or alias.
      --api-version=<value>  Override the api version used for the org connection.
      --dry-run              Validate and plan actions without any write operations.
      --no-prompt            Skip confirmation prompts before write operations.
      --snapshot=<value>     (required) Path to a user snapshot JSON file.

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

_See code: [src/commands/warden/restore.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.1.1/src/commands/warden/restore.ts)_

## `sf warden snapshot`

Capture user assignment state to a portable snapshot file.

```
USAGE
  $ sf warden snapshot -o <value> [--json] [--flags-dir <value>] [--user <value>] [--users-def <value>]
    [--external-id <value>] [--out <value>] [--api-version <value>]

FLAGS
  -o, --target-org=<value>   (required) Target org username or alias.
      --api-version=<value>  Override the api version used for the org connection.
      --external-id=<value>  Default User field used to match entries in `--users-def`.
      --out=<value>          Path to write the snapshot JSON file.
      --user=<value>         Target a single user using `field:value`.
      --users-def=<value>    Path to a user definition JSON file.

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

    $ sf warden snapshot --users-def config/user-def.json --external-id FederationIdentifier --out ^
      snapshots/users.json --target-org myOrg

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/snapshot.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.1.1/src/commands/warden/snapshot.ts)_

## `sf warden strip`

Strip and deactivate one or more users.

```
USAGE
  $ sf warden strip -o <value> [--json] [--flags-dir <value>] [--user <value>] [--users-def <value>]
    [--external-id <value>] [--no-prompt] [--dry-run] [--no-freeze] [--no-deactivate] [--keep-permsets]
    [--keep-permset-groups] [--keep-licenses] [--keep-public-groups] [--keep-queues] [--snapshot <value>] [--api-version
    <value>]

FLAGS
  -o, --target-org=<value>   (required) Target org username or alias.
      --api-version=<value>  Override the api version used for the org connection.
      --dry-run              Validate and plan actions without any write operations.
      --external-id=<value>  Default User field used to match entries in `--users-def`.
      --keep-licenses        Keep permission set license assignments.
      --keep-permset-groups  Keep permission set group assignments.
      --keep-permsets        Keep permission set assignments.
      --keep-public-groups   Keep public group memberships.
      --keep-queues          Keep queue memberships.
      --no-deactivate        Skip the final deactivation step.
      --no-freeze            Skip the initial freeze step.
      --no-prompt            Skip confirmation prompts before write operations.
      --snapshot=<value>     Write a portable user snapshot JSON file before stripping access, including during dry-run.
      --user=<value>         Target a single user using `field:value`.
      --users-def=<value>    Path to a user definition JSON file.

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

    $ sf warden strip --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg ^
      --no-prompt

  Keep permission set licenses while stripping everything else:

    $ sf warden strip --users-def config/user-def.json --keep-licenses --target-org myOrg --dry-run

  Capture a restorable snapshot before stripping:

    $ sf warden strip --user username:someone@example.com --snapshot snapshots/user.json --target-org myOrg ^
      --no-prompt

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/strip.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.1.1/src/commands/warden/strip.ts)_

## `sf warden unfreeze`

Unfreeze one or more users.

```
USAGE
  $ sf warden unfreeze -o <value> [--json] [--flags-dir <value>] [--user <value>] [--users-def <value>]
    [--external-id <value>] [--no-prompt] [--dry-run] [--api-version <value>]

FLAGS
  -o, --target-org=<value>   (required) Target org username or alias.
      --api-version=<value>  Override the api version used for the org connection.
      --dry-run              Validate and plan actions without any write operations.
      --external-id=<value>  Default User field used to match entries in `--users-def`.
      --no-prompt            Skip confirmation prompts before write operations.
      --user=<value>         Target a single user using `field:value`.
      --users-def=<value>    Path to a user definition JSON file.

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

    $ sf warden unfreeze --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg ^
      --no-prompt

FLAG DESCRIPTIONS
  --api-version=<value>  Override the api version used for the org connection.

    Override the api version used for api requests made by this command
```

_See code: [src/commands/warden/unfreeze.ts](https://github.com/Syntax-Syllogism/warden/blob/v0.1.1/src/commands/warden/unfreeze.ts)_
<!-- commandsstop -->
