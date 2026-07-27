# summary

Compare users against an intended definition or another user.

# description

Reports read-only drift across profile, role, permission sets, permission set groups, public groups, and queues without applying changes.

# flags.target-org.summary

Target org username or alias.

# flags.user.summary

Target user to compare using `field:value`.

# flags.against.summary

Reference user to compare against using `field:value`.

# flags.users-def.summary

Path to a user definition JSON or CSV file.

# flags.input-format.summary

Override users-def format detection: json or csv.

# flags.csv-list-delimiter.summary

Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.

# flags.personas-def.summary

Optional path to persona definition JSON file. Omit it for profile-only diffing.

# flags.external-id.summary

Default User field used to match entries in `--users-def`.

# flags.output.summary

Output format when not using global `--json`.

# flags.verbose.summary

Include assignments that are already present in both sides in human output.

# flags.fail-on-drift.summary

Exit with code 1 when any user has access drift.

# flags.verify.summary

Check whether users conform to their intended definition.

# flags.api-version.summary

Override the api version used for the org connection.

# errorInvalidPersonaDefinition

persona-def.json must contain a personas object.

# errorInvalidJson

Failed to parse JSON file %s: %s

# errorInvalidAgainstMatchField

Invalid against match field "%s".

# errorInvalidUserValue

Invalid --user value "%s". Expected field:value.

# errorInvalidAgainstValue

Invalid --against value "%s". Expected field:value.

# errorExternalIdUserMode

--external-id is only valid with --users-def; it cannot be used with --user or --against.

# errorPersonasUserMode

--personas-def is only valid with --users-def, not --user.

# errorPersonasWithoutDefinition

User "%s" lists personas but no --personas-def was supplied.

# errorVerboseNonHuman

--verbose is only valid with --output human.

# errorVerifyUserMode

--verify is only valid with --users-def; it cannot be used with --user or --against.

# errorDuplicateExternalIdMatch

Multiple users matched %s="%s".

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

# errorInvalidUserMatchField

match must name a valid User match field: %s.

# errorUserMatchFieldEmpty

match field %s must be populated on the user.

# errorUserProfileConflict

Set either "profile" or "ProfileId" on a user, not both.

# errorUserRoleConflict

Set either "role" or "UserRoleId" on a user, not both.

# errorInvalidUserProfile

user "profile" must be a string (a profile name or Id). Got: %s

# errorInvalidUserRole

user "role" must be a string (a role name/DeveloperName or Id). Got: %s

# info.summary

Compared %s users: %s with drift, %s failed.

# verify.summary

Verified %s users: %s conformant, %s non-conformant.

# verify.user

%s: non-conformant

# verify.violation.notFound

user not found

# verify.violation.error

error: %s

# verify.violation.missing

%s missing: %s

# verify.violation.extra

%s extra (sync): %s

# verify.violation.profile

profile mismatch: %s -> %s

# verify.violation.role

role mismatch: %s -> %s

# examples

- Compare users in a definition file against their personas:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --personas-def config/persona-def.json --external-id FederationIdentifier --target-org myOrg

- Compare one user against another:

  <%= config.bin %> <%= command.id %> --user username:new@example.com --against username:template@example.com --target-org myOrg --output csv
