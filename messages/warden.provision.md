# summary

Provision users from user and persona definition files.

# description

Provisions Salesforce users by merging multiple personas per user into an effective persona (unioning assignment lists, enforcing singular-value agreement), applying insert-only Username and Alias defaults, enforcing optional profile and role, activating and unfreezing users, and planning or applying assignment changes.

# flags.target-org.summary

Target org username or alias.

# flags.users-def.summary

Path to user definition JSON file.

# flags.personas-def.summary

Path to persona definition JSON file.

# flags.external-id.summary

User field used to match existing users by default. Per-user `match` overrides this for individual rows. If omitted, all entries are treated as inserts.

# flags.no-prompt.summary

Skip warning confirmation prompts.

# flags.dry-run.summary

Validate and plan actions without any write operations.

# flags.api-version.summary

Override the api version used for the org connection.

# errorInvalidJson

Failed to parse JSON file %s: %s

# errorInvalidPersonaDefinition

persona-def.json must contain a personas object.

# promptWarningsContinue

Validation warnings were found. Continue?

# errorPromptDeclined

Provisioning cancelled because warnings were not confirmed.

# warningPromptTimeout

Warning confirmation timed out after 10 seconds.

# warningReferenceMissing

%s reference "%s" was not found.

# errorFieldNotWritable

Field %s is not %s.

# errorReferenceRequiredMissing

Required %s reference "%s" was not found.

# errorDuplicateExternalIdMatch

Multiple users matched %s="%s".

# errorInvalidUserMatchField

match must name a valid User match field: %s.

# errorUserMatchFieldEmpty

match field %s must be populated on the user.

# errorMissingRequiredFields

Missing required fields for insert: %s.

# errorMissingSaveId

Save operation returned no user id.

# errorCrossReferenceCandidates

Cross-reference update candidates for this user: %s

# errorNoPersonas

Each user must include a non-empty personas array.

# errorLegacyPersonaKey

"persona" is no longer supported; use "personas": [ ... ].

# errorUnknownPersona

Unknown persona "%s".

# errorPersonaConflictProfile

Personas conflict on profile: %s.

# errorPersonaConflictRole

Personas conflict on role: %s.

# errorPersonaConflictUserAttribute

Personas conflict on userAttribute "%s".

# errorPersonaConflictMode

Personas conflict on %s.

# errorUserProfileConflict

Set either "profile" or "ProfileId" on a user, not both.

# errorUserRoleConflict

Set either "role" or "UserRoleId" on a user, not both.

# errorInvalidUserProfile

user "profile" must be a string (a profile name or Id). Got: %s

# errorInvalidUserRole

user "role" must be a string (a role name/DeveloperName or Id). Got: %s

# warningUserFailed

%s failed: %s

# info.summary

Processed %s users: %s created, %s updated, %s failed.

# examples

- Dry run with explicit external id:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --personas-def config/persona-def.json --external-id FederationIdentifier --target-org myOrg --dry-run

- Apply provisioning with no prompt:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --personas-def config/persona-def.json --target-org myOrg --no-prompt
