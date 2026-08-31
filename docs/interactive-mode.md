---
title: Interactive mode
description: Use Warden's guided flag prompts to collect, review, and confirm command inputs.
---

# Interactive mode

All eight `sf warden` commands support `-i`/`--interactive`:
`access`, `diff`, `freeze`, `provision`, `restore`, `snapshot`, `strip`, and
`unfreeze`.

Interactive mode is a guided way to supply command flags. Values already
provided on the command line are retained. Missing values are collected with
text, select, confirm, or checkbox prompts as appropriate. After collection,
Warden prints the resolved values and asks `Proceed with these values?` once.
The command runs only after confirmation. A decline prints `Operation
cancelled.`, returns an empty result, and performs no DML or snapshot `--out`
file write.

The confirmed values then use the same target resolution, planning, execution,
and output paths as a flag-only invocation. Interactive mode does not change
user matching, definition-file validation, access resolution, or output
schemas.

## Terminal requirements

Interactive mode requires a TTY on standard input. It cannot be combined with
the Salesforce CLI global `--json` flag, because that mode is intended for
machine-readable, unattended execution. Warden fails before prompting when
either condition is not met.

Warden's `--output json` is a separate output-format flag. It can be selected
interactively when its output-file requirements are satisfied; see the
[output contract](output-contract.md) for the distinction between the two
`json` options.

If a default org resolves during parsing, interactive mode uses it and shows
the resolved org in the summary. If no org resolves, it asks for an org alias
or username and resolves that value with the normal Salesforce authentication
rules. To select a different org when a default exists, pass
`--target-org` explicitly.

## Guided flows

The prompts are conditional, so a command does not ask for flags that are
irrelevant to the selected mode.

| Command | Guided choices and values |
| --- | --- |
| `access` | Select a direct target audit or reverse user audit. Reverse mode then selects a target or SObject scope; `--sobject` is offered only for field and object audits, and a supplied `--sobject` likewise narrows the access-type choices to those two, and a supplied type that `--sobject` cannot use is rejected before any prompt. The access type and relevant target/user values follow. |
| `diff` | Select a two-user comparison or a users-definition/persona comparison. The selected branch controls whether Warden asks for `--against` or definition-file, matching, format, verify, and drift options. The users-definition extension determines JSON or CSV input when possible; otherwise Warden asks for the format. Supplied flags determine the branch; contradictory branch flags fail before confirmation. |
| `freeze`, `unfreeze` | Select one user (`field:value`) or a users-definition file, then collect the applicable matching options and `--dry-run`. The users-definition extension determines JSON or CSV input when possible; otherwise Warden asks for the format. |
| `provision` | Collect the users-definition file, optional persona file, matching and format options, and, when JSON input is selected, an optional related-record catalog. The users-definition extension determines JSON or CSV input when possible; otherwise Warden asks for the format. Then collect fuzzy-Username, dry-run, and insufficient-license choices. |
| `restore` | Collect the existing snapshot path and `--dry-run`. |
| `snapshot` | Select one user or a users-definition file, collect applicable matching options, and offer a timestamped JSON path as the default for `--out`. The users-definition extension determines JSON or CSV input when possible; otherwise Warden asks for the format. |
| `strip` | Select one user or a users-definition file, use one checkbox for the freeze/deactivate/access categories to skip, then collect an optional snapshot path and `--dry-run`. The users-definition extension determines JSON or CSV input when possible; otherwise Warden asks for the format. Supplied skip flags remain selected and are not changed by the checkbox. |

When a prompted path must already exist, Warden validates it before displaying
the summary. `--output` and `--api-version` are also included in the
interactive collection when they were not explicitly supplied, even though
the output format has a static human default; a resolved `--api-version`
default is offered as the prompt default, and a prompted value is validated by
the same parser the flag uses. `--csv-list-delimiter` is collected only when
the resolved users-definition input is CSV; otherwise it remains at its `;`
default. Optional text answers can be left blank where the corresponding flag
is optional.

Interactive mode is stricter than the flag-only path in one place. `diff -i`
rejects `--user`/`--against` combined with a persona-mode flag such as
`--input-format` or `--csv-list-delimiter`, which a flag-only run silently
ignores, because the branch has to be settled before Warden can decide what to
prompt for.

## Confirmation and mutating commands

The summary confirmation is the single operation gate for an interactive run.
For `freeze`, `unfreeze`, `restore`, `strip`, and `provision`, it replaces the
normal flag-only confirmation that is controlled by `--no-prompt`; interactive
mode does not add a second write confirmation or warning acknowledgement.
`--dry-run` still prevents writes after confirmation.

Without `-i`, the existing flag-only behavior and validation remain in force.
Use `--no-prompt` or the global `--json` mode for unattended flag-only runs as
described in the [output contract](output-contract.md).

## Examples

Start a fully guided provisioning run:

```bash
sf warden provision -i
```

Guide an access audit while pinning the org and audit type:

```bash
sf warden access -i --target-org myOrg --type field
```

Use guided input for a destructive workflow, but require a dry-run answer
before the final summary confirmation:

```bash
sf warden strip -i --target-org myOrg --dry-run
```
