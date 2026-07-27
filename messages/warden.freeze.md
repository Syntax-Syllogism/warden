# summary

Freeze one or more users.

# description

Freezes matching users by setting `UserLogin.IsFrozen = true` and leaving all other access untouched.

# flags.target-org.summary

Target org username or alias.

# flags.user.summary

Target a single user using `field:value`.

# flags.users-def.summary

Path to a user definition JSON or CSV file.

# flags.input-format.summary

Override users-def format detection: json or csv.

# flags.csv-list-delimiter.summary

Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.

# flags.external-id.summary

Default User field used to match entries in `--users-def`.

# flags.no-prompt.summary

Skip confirmation prompts before write operations.

# flags.dry-run.summary

Validate and plan actions without any write operations.

# flags.api-version.summary

Override the api version used for the org connection.

# errorInvalidJson

Failed to parse JSON file %s: %s

# errorInvalidUsersDefinition

users-def.json must contain a users array.

# errorSelectionRequired

Specify either `--user` or `--users-def`.

# errorInvalidUserMatchField

Invalid user match field "%s".

# errorPromptDeclined

Operation cancelled.

# warningPromptTimeout

Warning confirmation timed out after 10 seconds.

# warningMissingUserLogin

No UserLogin row was found for this user.

# promptContinue

Continue with this operation?

# alreadyFrozen

Already frozen.

# wouldFreeze

Would freeze.

# frozen

Froze.

# alreadyUnfrozen

Already unfrozen.

# wouldUnfreeze

Would unfreeze.

# unfrozen

Unfroze.

# info.summary

Processed %s user%s: %s changed, %s unchanged, %s failed.

# examples

- Preview a single freeze by field match:

  <%= config.bin %> <%= command.id %> --user username:someone@example.com --dry-run --target-org myOrg

- Freeze users from a definition file without prompts:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg --no-prompt
