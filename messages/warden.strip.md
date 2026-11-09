# summary

Strip users completely, or remove selected persona access.

# description

Without persona flags, freezes matching users, removes access grants, and deactivates the user unless the corresponding opt-out flags are set.

With `--persona` or `--all-personas`, removes only persona-derived access. Shared grants remain, and freeze/deactivation are off unless `--freeze` or `--deactivate` is supplied.

# flags.persona.summary

Persona API name to remove. Repeat for multiple personas.

# flags.all-personas.summary

Remove access granted by every active persona held by each user.

# flags.personas-def.summary

Path to the persona definitions JSON file when using `--persona-source file`.

# flags.persona-source.summary

Read persona definitions and held personas from a file or the Warden package.

# flags.freeze.summary

Freeze users in persona mode after planning access removal.

# flags.deactivate.summary

Deactivate users in persona mode after planning access removal.

# flags.no-freeze.summary

Skip the initial freeze step.

# flags.no-deactivate.summary

Skip the final deactivation step.

# flags.keep-permsets.summary

Keep permission set assignments.

# flags.keep-permset-groups.summary

Keep permission set group assignments.

# flags.keep-licenses.summary

Keep permission set license assignments.

# flags.keep-public-groups.summary

Keep public group memberships.

# flags.keep-queues.summary

Keep queue memberships.

# flags.snapshot.summary

Write a portable user snapshot JSON or CSV file before stripping access, including during dry-run. The extension selects the format.

# errorInvalidJson

Failed to parse JSON file %s: %s

# errorInvalidUsersDefinition

users-def.json must contain a users array.

# errorSelectionRequired

Specify either `--user` or `--users-def`.

# errorPersonaSelectionRequired

Provide at least one persona API name.

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

# alreadyInactive

Already inactive.

# wouldDeactivate

Would deactivate.

# deactivated

Deactivated.

# wouldRemovePermissionSet

Would remove %s permission set assignments.

# removedPermissionSet

Removed %s permission set assignments.

# wouldRemovePermissionSetGroup

Would remove %s permission set group assignments.

# removedPermissionSetGroup

Removed %s permission set group assignments.

# wouldRemovePermissionSetLicense

Would remove %s permission set license assignments.

# removedPermissionSetLicense

Removed %s permission set license assignments.

# wouldRemovePublicGroupMember

Would remove %s public group memberships.

# removedPublicGroupMember

Removed %s public group memberships.

# wouldRemoveQueueMember

Would remove %s queue memberships.

# removedQueueMember

Removed %s queue memberships.

# skippedFreeze

Skipped freeze step.

# skippedDeactivate

Skipped deactivation step.

# skippedPermissionSets

Skipped permission set removals.

# skippedPermissionSetGroups

Skipped permission set group removals.

# skippedPermissionSetLicenses

Skipped permission set license removals.

# skippedPublicGroups

Skipped public group removals.

# skippedQueues

Skipped queue removals.

# skippedProfileOwnedPermissionSets

Skipped %s profile-owned permission set assignments.

# snapshotWritten

Wrote snapshot.

# info.summary

Processed %s user%s: %s changed, %s unchanged, %s failed.

# info.personaMode

Remove persona(s) %s from %s user(s). Freeze: %s. Deactivate: %s.

# examples

- Preview a strip for a single user:

  <%= config.bin %> <%= command.id %> --user username:someone@example.com --dry-run --target-org myOrg

- Strip users from a definition file without prompts:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --external-id FederationIdentifier --target-org myOrg --no-prompt

- Keep permission set licenses while stripping everything else:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --keep-licenses --target-org myOrg --dry-run

- Capture a restorable snapshot before stripping:

  <%= config.bin %> <%= command.id %> --user username:someone@example.com --snapshot snapshots/user.json --target-org myOrg --no-prompt

- Preview removal of one persona without freezing or deactivating the user:

  <%= config.bin %> <%= command.id %> --user username:someone@example.com --persona support --persona-source org --dry-run --target-org myOrg

- Remove every active persona and then freeze the user:

  <%= config.bin %> <%= command.id %> --user username:someone@example.com --all-personas --persona-source org --freeze --target-org myOrg --no-prompt
