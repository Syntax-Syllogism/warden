# summary

Provision users from user and persona definition files.

# description

Provisions Salesforce users by merging multiple personas per user into an effective persona (unioning assignment lists, enforcing singular-value agreement), applying insert-only Username and Alias defaults, enforcing optional profile and role, activating and unfreezing users, and planning or applying assignment changes. `--personas-def` is optional for profile-only provisioning.

Matching accepts any filterable User field. A match with more than one result is skipped. Use `--fuzzy-username` for sandbox username suffixes, or set `fuzzyUsername: true` on an individual user; the per-user value overrides the global flag.

# flags.target-org.summary

Target org username or alias.

# flags.users-def.summary

Path to a user definition JSON or CSV file.

# flags.input-format.summary

Override users-def format detection: json or csv.

# flags.csv-list-delimiter.summary

Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.

# flags.personas-def.summary

Optional path to persona definition JSON file. Omit it for profile-only provisioning.

# flags.external-id.summary

Filterable User field used to match existing users by default. `--match-field` is an alias. Per-user `match` overrides this for individual rows. If omitted, all entries are treated as inserts. Multiple matches are skipped.

# flags.fuzzy-username.summary

Match Username values with optional Salesforce sandbox suffixes.

# flags.no-prompt.summary

Skip warning confirmation prompts.

# flags.dry-run.summary

Validate and plan actions without any write operations.

# flags.fail-on-insufficient-license.summary

Fail after dry-run output when projected net-new users exceed user-license headroom.

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

match must name a valid filterable User field: %s.

# errorInvalidFuzzyUsername

fuzzyUsername must be a boolean. Got: %s.

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

# errorPersonasWithoutDefinition

User "%s" lists personas but no --personas-def was supplied.

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

# warningInsufficientLicense

Projected shortfall for user license %s: %s user(s) over available headroom.

# info.summary

Processed %s users: %s created, %s updated, %s failed.

# info.licenses.header

User license headroom for net-new users:

# info.licenses.row

  %s: required %s, available %s, shortfall %s%s

# info.permissionSetLicenses.notEvaluated

Permission set license headroom: not evaluated.

# errorInsufficientLicense

Insufficient user-license headroom: %s.

# examples

- Dry run with explicit external id:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --personas-def config/persona-def.json --external-id FederationIdentifier --target-org myOrg --dry-run

- Dry run matching by another filterable User field:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --personas-def config/persona-def.json --match-field LastName --target-org myOrg --dry-run

- Apply provisioning with no prompt:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --personas-def config/persona-def.json --target-org myOrg --no-prompt

- Match production usernames to sandbox-suffixed users:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --personas-def config/persona-def.json --fuzzy-username --target-org mySandbox --dry-run
