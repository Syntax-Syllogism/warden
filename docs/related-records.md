---
title: Related-record provisioning
description: Provision related Salesforce records before or after users, with context lookups and User linking.
---

# Related-record provisioning

`--related-def` takes a JSON catalog of reusable relationships. A JSON user picks catalog entries by name in a `related` array. Both `related` and `relatedContext` are per-user metadata, never sent to the User API or inferred from personas. Malformed values fail JSON users-file parsing for the whole file. CSV user definitions can't select relationships, so CSV input with `--related-def` is an error.

Only `provision` applies related records; `diff`, `snapshot`, `restore`, and `strip` do not synchronize them.

## Catalog and user selection

The catalog needs a `relationships` object. Each name a user selects must exist in it and appear only once in that user's `related` array:

```json
{
  "users": [
    {
      "related": ["employee"],
      "FederationIdentifier": "E-9981"
    }
  ]
}
```

```json
{
  "relationships": {
    "employee": {
      "sobject": "Employee__c",
      "phase": "after",
      "match": {
        "field": "External_Person_Id__c",
        "from": "user.FederationIdentifier"
      },
      "fields": {
        "Department__c": { "from": "user.Department" },
        "Employment_Status__c": { "value": "Active" },
        "User__c": { "from": "user.Id" }
      }
    }
  }
}
```

## Matching, sources, and modes

* `phase: "before"` creates or updates the related record before the User save. An optional `linkUser: { "userField": "ContactId", "fromRelatedField": "Id" }` copies the related value into the User payload. `linkUser` is only valid on `before`. Two selected relationships linking the same User field fail that user before DML.
* `phase: "after"` saves the User first, then creates or updates the related record, and can set a lookup from `{ "from": "user.Id" }`. `user.Id` is forbidden anywhere in a `before` relationship and in every `match.from`.
* Matching uses a unique or External-ID, filterable field on the related object, filled from a non-Id User field. Zero matches create a record, one match updates it, and several matches fail that user. Two users selecting the same relationship with the same match value also fail, before any DML.
* Every relationship needs a non-empty `sobject`, `phase`, `match`, and `fields`.
* A field source is exactly `{ "from": "user.<UserField>" }`, `{ "from": "context.<name>" }`, or `{ "value": <literal> }`. Matching still requires a non-Id User field. Context names match exact keys in that user's `relatedContext`; missing or empty referenced values fail that user, while `0` and `false` are valid. Unreferenced context entries are ignored, including when no catalog is supplied.
* `mode` defaults to `setIfEmpty`, which keeps populated values on a matched record. Only literal `null` and `""` count as empty. Set `mode: "sync"` to overwrite every configured field. On create, both modes write all configured fields and always write the match field.
* A configured record type is applied only on create. Warden never changes the record type of a matched record, and a matched record with a different configured record type fails that user. An `Account` relationship must declare an available Person Account record type.

## Validation and execution

Before planning, Warden checks each selected relationship's target object, field access, match metadata, and record type. For `linkUser`, the User destination must be both createable and updateable, and the related source must be readable. A relationship that fails these checks is reported as a warning and skipped, after the command's single warning confirmation. `--no-prompt` and non-interactive JSON runs skip it automatically.

Malformed catalogs abort the run, including invalid phases, source expressions, and `linkUser` on an after relationship. Per-user planning errors prevent that user's writes.

Related DML is batched by phase and sObject, at most 200 records per batch, with `allOrNone: false`. Dry runs validate, resolve lookups, match, and show both phases without any DML. A before-phase failure prevents that user from reaching the User save; other users continue. If a before record succeeds but the User save fails, the related record is kept and can be orphaned unless `--cleanup-on-failure` is passed. An after-phase failure marks the user failed while keeping its saved User. Human output prints one `related:` line per result. JSON and CSV shapes are in the [output contract](output-contract.md).

## Cleanup on failure

`--cleanup-on-failure` defaults to false. When enabled, it makes a best-effort attempt to delete only related records created in this run for users whose final status is failed, processing after records before before records. Matched or updated records are kept. Before records linked to a successfully saved User are also kept and reported as `skipped` with an explanation, including Person Accounts whose generated Contact is linked to the User. The User is never deleted or reverted.

Deletes use batches of at most 200 per sObject with `allOrNone: false`; outcomes append `deleted` or `deleteFailed` entries without changing the summary. Failed deletes do not hide the original failure and are not retried. A run interrupted before the cleanup stage does not perform cleanup. Once cleanup starts, it completes best effort without further cancellation checks; there is no journal or resume support for interrupted runs. With `--dry-run`, the flag warns and has no effect.

## Before-phase external-user example

Select `contact` in a JSON user's `related` array and supply its account through context:

```json
{
  "related": ["contact"],
  "relatedContext": {
    "account": {
      "lookup": {
        "sobject": "Account",
        "field": "External_Id__c",
        "value": { "value": "CUSTOMER-1" }
      }
    }
  }
}
```

These metadata keys accompany the normal User fields. The catalog entry is:

```json
{
  "relationships": {
    "contact": {
      "sobject": "Contact",
      "phase": "before",
      "match": { "field": "External_Id__c", "from": "user.FederationIdentifier" },
      "fields": {
        "LastName": { "from": "user.LastName" },
        "AccountId": { "from": "context.account" }
      },
      "linkUser": { "userField": "ContactId", "fromRelatedField": "Id" }
    }
  }
}
```

## Context values and lookups

A context entry may instead be a string, number, boolean, or null. Referenced null and empty-string values fail that user; literal field sources can explicitly write null or an empty string. A lookup's `value` accepts `{ "from": "user.<Field>" }` or `{ "value": <literal> }`, never `user.Id` or another context source. The lookup field must be readable, filterable, and Unique or External ID. Exactly one match supplies its Id; zero or multiple matches fail that user. Lookups are grouped by object and field across users, with bounded queries of at most 200 values rather than one query per value. Queries also stay within an 18,000-character budget; an oversized lookup value fails only the users referencing it.

## Linking and Person Accounts

Linking replaces any value already supplied for that User field. An existing related record supplies its planned updated value when the relationship writes the linking field, otherwise its queried value. A missing, null, or empty linking value fails that user and prevents the User save. Relationships cannot source another relationship's Id.

For a Person Account, use `sobject: "Account"`, an available Person Account `recordType: { "developerName": "Person" }`, and `linkUser.fromRelatedField: "PersonContactId"`. Warden reads generated linking values in a batch after creating the Accounts and before saving Users. Existing matches include that field in their initial query. `PersonContactId` is readable for linking but must never appear in `fields` for writing.

Selecting a before relationship that links `ContactId` adds a warning naming the planned Profile's UserLicense. It uses the command's existing warning confirmation; `--no-prompt` proceeds. Warden does not classify license eligibility; Salesforce's User save is authoritative.
