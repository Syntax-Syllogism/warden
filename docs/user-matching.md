---
title: User matching
description: Resolve Salesforce users with exact fields, fuzzy Usernames, and lifecycle targeting rules.
---

# User matching

Provisioning and the lifecycle commands that read `users-def.json` share one matching layer. It finds existing Salesforce `User` records before Warden plans any write or action.

## Match fields

* A match field is any `User` field that describe metadata marks `filterable`. Names are case-insensitive and resolved to the canonical API name.
* **Provisioning:** `--external-id` sets the default match field, and `--match-field` is an alias. A user's own `match` key overrides it for that row.
* **Lifecycle commands:** `--external-id` sets the default for `users-def.json`, and a per-entry `match` key overrides it. `--user field:value` takes any filterable `User` field, or `Id`, directly. User-audit mode in `access` works the same way.
* With no match field, provisioning treats the row as a new user. A lifecycle command reports a target error. A missing match value is always an error.

Exact matching is case-insensitive. If nothing matches, the request is reported as unmatched. If more than one record matches, it is skipped as ambiguous. Warden never treats an ambiguous match as an insert, and never applies it to several users.

## Fuzzy Username matching

Fuzzy matching is opt-in and works only when the match field is `Username`. It finds the base Username and any Username with a Salesforce sandbox suffix, like this:

```text
Username = base OR Username LIKE base.%
```

The base is compared case-insensitively after the query. SOQL wildcard characters and backslashes in the base are escaped. Large batches are split to stay within the query length limit.

* **Provisioning:** `--fuzzy-username` turns it on for every row. A row can set `"fuzzyUsername": true` in `users-def.json`, and that takes precedence, so `false` opts one row out. The key does nothing for other match fields.
* **Lifecycle commands:** entries in `users-def.json` can set `fuzzyUsername: true`. There is no global `--fuzzy-username` flag, and `--user field:value` (also in `access`) never uses fuzzy matching.

## Examples

Provision with fuzzy Username matching:

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

Lifecycle commands use the same per-entry shape:

```bash
sf warden freeze --users-def ./users.json --target-org mySandbox
```

For provisioning merge and precedence rules, see [command details](command-details.md#warden-provision). For every flag, see the [README command reference](https://github.com/Syntax-Syllogism/warden/blob/v0.7.1/README.md).
