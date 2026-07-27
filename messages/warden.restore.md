# summary

Restore user assignment state from a snapshot file.

# description

Re-resolves users by the snapshot match key, reactivates and unfreezes them, and adds missing assignments without removing existing access.

# flags.target-org.summary

Target org username or alias.

# flags.snapshot.summary

Path to a user snapshot JSON file.

# flags.no-prompt.summary

Skip confirmation prompts before write operations.

# flags.dry-run.summary

Validate and plan actions without any write operations.

# flags.api-version.summary

Override the api version used for the org connection.

# errorInvalidJson

Failed to parse JSON file %s: %s

# errorInvalidUserMatchField

Invalid user match field "%s".

# errorPromptDeclined

Operation cancelled.

# warningPromptTimeout

Warning confirmation timed out after 10 seconds.

# warningReferenceMissing

Missing %s reference "%s"; skipping it.

# promptContinue

Continue with this operation?

# wouldActivate

Would activate.

# activated

Activated.

# wouldUnfreeze

Would unfreeze.

# unfrozen

Unfroze.

# wouldAssignPermissionSet

Would assign %s permission sets.

# assignedPermissionSet

Assigned %s permission sets.

# wouldAssignPermissionSetGroup

Would assign %s permission set groups.

# assignedPermissionSetGroup

Assigned %s permission set groups.

# wouldAddPublicGroupMember

Would add %s public group memberships.

# addedPublicGroupMember

Added %s public group memberships.

# wouldAddQueueMember

Would add %s queue memberships.

# addedQueueMember

Added %s queue memberships.

# wouldAssignPermissionSetLicense

Would assign %s permission set licenses.

# assignedPermissionSetLicense

Assigned %s permission set licenses.

# info.summary

Processed %s user%s: %s changed, %s unchanged, %s failed.

# examples

- Preview a restore:

  <%= config.bin %> <%= command.id %> --snapshot snapshots/user.json --dry-run --target-org myOrg

- Restore without prompts:

  <%= config.bin %> <%= command.id %> --snapshot snapshots/user.json --target-org myOrg --no-prompt
