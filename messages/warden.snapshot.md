# summary

Capture user assignment state to a portable snapshot file.

# description

Captures matching users' active/frozen state and access assignments using developer/API names so the snapshot can be restored later.

# flags.out.summary

Path to write the snapshot JSON or CSV file. The extension selects the format.

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
