---
title: Warden documentation
description: Guides for auditing and managing Salesforce user lifecycle state with Warden.
---

Warden is a Salesforce CLI plugin for managing users over their lifetime. You can audit access, compare users with the access they should have, provision users from reusable personas, and freeze, restore, and snapshot users safely.

Start with [Getting started](getting-started.md). Come back to the guides below when you need the details of one workflow.

- [Getting started](getting-started.md): install Warden and run your first audit or provisioning plan.
- [Command details](command-details.md): how provisioning merges personas, field precedence, assignment modes, dry runs, and persona-scoped `strip`.
- [Related-record provisioning](related-records.md): catalogs, before/after phases, context lookups, and User linking.
- [CLI reference](cli-reference.md): every command with its usage, flags, and examples.
- [Persona promotion](persona-promotion.md): keep personas in an org, and move them with export, import, and diff.
- [sfd operations](sfd.md): access, diff, snapshot, and persona reads, plus plan-gated provision, restore, freeze, unfreeze, strip, and persona import writes, through the warm `sfd` daemon.
- [Connected org writes](connected-org-writes.md): the optional provisioning ledger and run log, and the persona revocation records `strip` writes, in orgs with the Warden package.
- [Access audits](access-audits.md): who can access a target, what a user can access, and where each grant comes from.
- [User matching](user-matching.md): which fields identify a user, fuzzy Username matching, and how lifecycle commands pick their targets.
- [Lifecycle output and snapshots](lifecycle-output.md): resolved identities, assignment labels, snapshots, and action reports.
- [Interactive mode](interactive-mode.md): `-i` prompts for the flags you leave out.
- [Output contract](output-contract.md): human, CSV, and JSON output, destinations, and exit codes.
- [CLI/core architecture](architecture.md): implementation ownership, plan/apply boundaries, and output compatibility adapters.
