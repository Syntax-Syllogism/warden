---
title: Warden documentation
description: Guides for auditing and managing Salesforce user lifecycle state with Warden.
---

Warden is a Salesforce CLI plugin for managing users over their lifetime. You can audit access, compare users with the access they should have, provision users from reusable personas, and freeze, restore, and snapshot users safely.

These docs are for Salesforce admins and developers. Start with [Getting started](getting-started.md), then come back to the guides below when you need the details of one workflow.

## Start here

- [Getting started](getting-started.md): install Warden, define key terms, and run your first audit and provisioning plan.

## Guides

- [Access audits](access-audits.md): who can access a target, what a user can access, and where each grant comes from.
- [Provisioning](provisioning.md): how provisioning merges personas, field precedence, assignment modes, dry runs, and the example definition files.
- [Command details](command-details.md): diff, access, snapshot and restore, and the lifecycle commands, including persona-scoped `strip`.
- [User matching](user-matching.md): which fields identify a user, fuzzy Username matching, and how lifecycle commands pick their targets.
- [Related-record provisioning](related-records.md): catalogs, before/after phases, context lookups, and User linking.
- [Persona promotion](persona-promotion.md): keep personas in an org, and move them with export, import, and diff.
- [Lifecycle output and snapshots](lifecycle-output.md): resolved identities, assignment labels, snapshots, and action reports.
- [Interactive mode](interactive-mode.md): `-i` prompts for the flags you leave out.

## Reference

- [CLI reference](cli-reference.md): every command with its usage, flags, and examples.
- [Output contract](output-contract.md): human, CSV, and JSON output, destinations, and exit codes.
- Sample files: [users.json](examples/users.json), [users.csv](examples/users.csv), [users-profile-only.json](examples/users-profile-only.json), [personas.json](examples/personas.json), [user-snapshot.json](examples/user-snapshot.json), and [user-snapshot.csv](examples/user-snapshot.csv).

## Optional integrations

- [Connected org writes](connected-org-writes.md): the optional provisioning ledger and run log, and the persona revocation records `strip` writes, in orgs with warden-base.
- [sfd operations](sfd.md): use Warden through the warm `sfd` daemon, including plan-gated writes.

## For contributors

- [CLI/core architecture](contributing/architecture.md): implementation ownership, plan/apply boundaries, output compatibility adapters, and the warden-base contract pin.
