---
title: Warden documentation
description: Guides for auditing and managing Salesforce user lifecycle state with Warden.
---

Warden is a Salesforce CLI plugin for user lifecycle administration. It helps
teams audit access, compare users with their intended state, provision users
from reusable personas, and safely manage freeze, restore, and snapshot
workflows.

Start with [Getting started](getting-started.md) for installation and a first
provisioning run. Use the guides below when you need the detailed behavior of
an individual workflow or its machine-readable output.

* [Getting started](getting-started.md) — install Warden and run your first
  audit or provisioning plan.
* [Command details](command-details.md) — provisioning merge rules, field
  precedence, assignment modes, and dry-run behavior.
* [Access audits](access-audits.md) — forward and reverse access scopes,
  attribution, and Permission Set Group muting.
* [User matching](user-matching.md) — supported match fields, fuzzy Username
  resolution, and lifecycle targeting.
* [Lifecycle output and snapshots](lifecycle-output.md) — resolved identity,
  assignment labels, snapshots, and action reporting.
* [Output contract](output-contract.md) — human, CSV, and JSON formats,
  destinations, and exit codes.
