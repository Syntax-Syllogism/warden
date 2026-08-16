# summary

Capture user assignment state to a portable snapshot file.

# description

Captures matching users' active/frozen state and access assignments using developer/API names so the snapshot can be restored later.

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

# flags.out.summary

Path to write the snapshot JSON or CSV file. The extension selects the format.

# flags.api-version.summary

Override the api version used for the org connection.

# errorInvalidJson

Failed to parse JSON file %s: %s

# errorInvalidUserMatchField

Invalid user match field "%s".

# snapshotWritten

Wrote snapshot.

# info.summary

Processed %s user%s: %s changed, %s unchanged, %s failed.

# examples

- Snapshot a single user:

  <%= config.bin %> <%= command.id %> --user username:someone@example.com --out snapshots/user.json --target-org myOrg

- Snapshot users from a definition file:

  <%= config.bin %> <%= command.id %> --users-def config/user-def.json --external-id FederationIdentifier --out snapshots/users.json --target-org myOrg
