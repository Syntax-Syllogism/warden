# flags.output.summary

Output format: human, csv, or json.

# flags.target-org.summary

Target org username or alias.

# flags.api-version.summary

Salesforce API version to use, for example 62.0.

# flags.user.summary

Target a single user using `field:value`.

# flags.users-def.summary

Path to a user definition JSON or CSV file.

# flags.external-id.summary

Default User field used to match entries in `--users-def`.

# flags.input-format.summary

Override users-def format detection: json or csv.

# flags.csv-list-delimiter.summary

Delimiter for multi-value CSV cells such as personas. Defaults to semicolon.

# flags.dry-run.summary

Validate and plan actions without any write operations.

# flags.no-prompt.summary

Skip confirmation prompts before write operations.

# flags.output-file.summary

Write the machine-readable output payload to this path.

# flags.interactive.summary

Prompt for missing command values, summarize them, and confirm before continuing.

# errorInteractiveGuard

Interactive mode requires a TTY and cannot be combined with --json.

# interactive.summary

Resolved interactive values:

# interactive.declined

Operation cancelled.

# errorOutputJsonConflict

`--output` and `--json` both write to stdout. Pass `--output-file <path>` to write the `--output` payload to a file.
