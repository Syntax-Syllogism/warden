# summary

Freeze one or more users.

# description

Freezes matching users by setting `UserLogin.IsFrozen = true` and leaving all other access untouched.

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

# info.summary

Processed %s user%s: %s changed, %s unchanged, %s failed.

# examples

- Preview a single freeze by field match:

  <%= config.bin %> <%= command.id %> --user username:someone@example.com --dry-run --target-org myOrg

- Freeze users from a definition file without prompts:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg --no-prompt
