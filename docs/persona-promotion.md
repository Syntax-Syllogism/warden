---
title: Persona promotion
description: Store, compare, and promote Warden persona assignment bundles through a Salesforce org.
---

# Persona promotion

This page is for admins who keep personas (named bundles of permission sets, groups, and queues) in an org and want to move them between orgs, such as from a sandbox to production. Warden can use personas stored in the org by [warden-base](https://github.com/Syntax-Syllogism/warden-base) as a provisioning source. It can also move those personas between orgs as JSON files. The promotion commands need the package objects `wdn_Persona__c` and `wdn_Persona_Component__c` in the target org. `strip --persona-source org` reads the same active personas, plus each user's `Active` persona assignments. See [Persona-scoped removal](command-details.md#persona-scoped-removal).

## File format

Promotion files have the same top-level shape as `personas.json`:

```json
{
  "personas": {
    "operations": {
      "permissionSets": ["Operations_Core"],
      "permissionSetGroups": ["Operations_Access"],
      "publicGroups": ["Operations_Team"],
      "queues": ["Operations_Queue"]
    }
  }
}
```

The org model stores assignment components only:

| Org component type     | File property         |
| ---------------------- | --------------------- |
| `Permission Set`       | `permissionSets`      |
| `Permission Set Group` | `permissionSetGroups` |
| `Public Group`         | `publicGroups`        |
| `Queue`                | `queues`              |

Profiles, roles, assignment modes, and `userAttributes` are not stored in the org and are not read from it. If provisioning needs them, put them on file personas or on the user definition. To round-trip a file without losing anything, keep only the four lists above.

## Export, diff, and import

`export` reads active `wdn_Persona__c` records and their components, and writes the JSON file. Inactive org personas are left out.

```bash
sf warden persona export --target-org myOrg --output personas.json
```

`diff` compares a file with the org's active personas. It is read-only. It reports personas that were added, removed, or changed. With global `--json`, the result also includes the before and after definitions for each change.

```bash
sf warden persona diff --target-org myOrg --input personas.json
```

`import` requires the `wdn_Persona_Publisher` permission set in the target org. It upserts each persona in the file by `wdn_Api_Name__c`, sets it active, and adds any missing components. Existing components are kept by default. With `--prune`, components that are not in the file are deleted, for the personas named in the file only.

```bash
sf warden persona import --target-org myOrg --input personas.json
sf warden persona import --target-org myOrg --input personas.json --prune
```

Import never deletes or deactivates an org persona just because it's missing from the file. `--prune` is the destructive option. Add `--dry-run` to print the same comparison as `persona diff` and write nothing. Review it before you use `--prune`, which deletes components.

```bash
sf warden persona import --target-org myOrg --input personas.json --dry-run
```

## Provisioning from org personas

`provision` takes `--persona-source file|org`:

- **`file`**: reads `--personas-def` if you passed it. Without that file, only profile-only user definitions are valid.
- **`org`**: reads the org's active personas. It doesn't read or merge `--personas-def`.
- **Omitted**: uses `file` if you passed `--personas-def`. Otherwise Warden looks for `wdn_Persona__c` and uses `org` if the package is there, or `file` if it isn't.

The result shows which source was used. References from org personas resolve like any other assignment reference, so the permission sets, groups, and queues must exist in the target org. The org model has no profile, so a new user still needs a profile in the user definition.
