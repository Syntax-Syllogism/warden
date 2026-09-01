---
title: User matching
description: Resolve Salesforce users with exact fields, fuzzy Usernames, and lifecycle targeting rules.
---

# User matching

Warden uses one matching layer for provisioning and for lifecycle commands
that consume `users-def.json`. It resolves existing Salesforce `User` records
before planning writes or lifecycle actions.

## Match fields

* Match fields are Salesforce `User` fields marked `filterable` by `User`
  describe metadata. Field names are accepted case-insensitively and resolved
  to their canonical API names.
* Provisioning uses `--external-id` for the default match field. The
  provisioning command also accepts `--match-field` as an alias. A user's
  `match` meta key overrides the command default for that row.
* Lifecycle commands use `--external-id` as the default for `users-def.json`,
  and the per-entry `match` key overrides it. Their `--user field:value` form
  accepts a filterable User field (and `Id`) directly. Reverse `access` mode
  uses the same direct `field:value` form.
* If no match field is available, provisioning treats the row as an insert;
  lifecycle commands report a target error. A missing match value is an error.

Exact matching is case-insensitive. A request with no matching record is
reported as unmatched. If more than one record matches, the request is
skipped as ambiguous; it is never silently treated as an insert or applied to
multiple users.

## Fuzzy Username matching

Fuzzy matching is opt-in and applies only when the match field is `Username`.
The resolver looks for the base Username and for usernames with a Salesforce
sandbox suffix, equivalent to:

```text
Username = base OR Username LIKE base.%
```

The base value is compared case-insensitively after the query, and SOQL
wildcard characters and backslashes in the base are escaped. Large batches
are split to stay within the query-length budget.

Provisioning enables fuzzy matching globally with `--fuzzy-username`. A row
may set `"fuzzyUsername": true` in `users-def.json`; that value takes
precedence over the global default, so `false` can opt a row out. Setting the
key for a non-Username match field has no effect.

Lifecycle commands support `fuzzyUsername: true` on entries in
`users-def.json`. They do not expose a global `--fuzzy-username` flag, and
the `--user field:value` forms for lifecycle commands and reverse `access` do
not request fuzzy matching.

## Examples

Provision with fuzzy Username matching (the fuzzy option applies only to
Username matching):

```json
{
  "users": [
    {
      "personas": ["standard"],
      "match": "Username",
      "fuzzyUsername": true,
      "Username": "alex@example.com"
    }
  ]
}
```

Use the same per-entry matching shape with lifecycle commands:

```bash
sf warden freeze --users-def ./users.json --target-org mySandbox
```

See [command details](command-details.md#warden-provision) for provisioning
merge and precedence rules, and the [README command reference](https://github.com/Syntax-Syllogism/warden/blob/v0.6.1/README.md)
for the complete flag surface.
