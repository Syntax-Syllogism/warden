# summary

Compare user assignments against intended persona state or another user.

# description

Reports read-only drift across profile, role, permission sets, permission set groups, public groups, and queues without applying changes.

# flags.target-org.summary

Target org username or alias.

# flags.user.summary

Target user to compare using `field:value`.

# flags.against.summary

Reference user to compare against using `field:value`.

# flags.users-def.summary

Path to user definition JSON file.

# flags.personas-def.summary

Path to persona definition JSON file.

# flags.external-id.summary

Default User field used to match entries in `--users-def`.

# flags.output.summary

Output format when not using global `--json`.

# flags.verbose.summary

Include assignments that are already present in both sides in human output.

# flags.api-version.summary

Override the api version used for the org connection.

# errorInvalidPersonaDefinition

persona-def.json must contain a personas object.

# errorInvalidAgainstMatchField

Invalid against match field "%s".

# errorInvalidUserValue

Invalid --user value "%s". Expected field:value.

# errorInvalidAgainstValue

Invalid --against value "%s". Expected field:value.

# errorExternalIdUserMode

--external-id is only valid with --users-def and --personas-def.

# errorVerboseNonHuman

--verbose is only valid with --output human.

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

# examples

- Compare users in a definition file against their personas:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --personas-def config/persona-def.json --external-id FederationIdentifier --target-org myOrg

- Compare one user against another:

  <%= config.bin %> <%= command.id %> --user username:new@example.com --against username:template@example.com --target-org myOrg --output csv
