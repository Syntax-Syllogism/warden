# summary

Unfreeze one or more users.

# description

Unfreezes matching users by setting `UserLogin.IsFrozen = false` and leaving all other access untouched.

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

# alreadyUnfrozen

Already unfrozen.

# wouldUnfreeze

Would unfreeze.

# unfrozen

Unfroze.

# info.summary

Processed %s user%s: %s changed, %s unchanged, %s failed.

# examples

- Preview a single unfreeze by field match:

  <%= config.bin %> <%= command.id %> --user username:someone@example.com --dry-run --target-org myOrg

- Unfreeze users from a definition file without prompts:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg --no-prompt
