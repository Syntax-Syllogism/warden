# summary

Audit active-user access for a permission target.

# description

Resolves active users who have access to a target and attributes each access path to Profile, Permission Set, or Permission Set Group sources.

# flags.type.summary

Target type to audit: field, object, apex-class, vf-page, custom-permission, tab, or record-type.

# flags.target.summary

Target API name. Use Object.Field for field, Object for object, Apex class name for apex-class, Visualforce page name for vf-page, custom permission DeveloperName for custom-permission, tab API name for tab, or SObject.DeveloperName for an active non-master record type.

# flags.user.summary

Reverse audit for one user, using field:value matching (for example Username:alice@example.com).

# flags.sobject.summary

In reverse user mode, report field or object access scoped to this SObject.

# errorUnsupportedAccessType

Unsupported access type: %s.

# errorInvalidTarget

Invalid target value: %s.

# errorFieldTargetMustBeQualified

Field target must be qualified as ObjectApiName.FieldApiName: %s.

# errorObjectNotFound

Object not found: %s.

# errorFieldNotFound

Object %s does not have field %s.

# errorApexClassNotFound

Apex class not found: %s.

# errorVisualforcePageNotFound

Visualforce page not found: %s.

# errorCustomPermissionNotFound

Custom permission not found: %s.

# errorTabNotFound

Tab not found: %s.

# errorRecordTypeTargetMustBeQualified

Record type target must be qualified as SObject.DeveloperName for an active, non-master record type: %s.

# errorMasterRecordTypeUnsupported

The Master record type is not supported. Specify an active non-master record type as SObject.DeveloperName: %s.

# errorRecordTypeNotFound

Record type not found or ambiguous: %s.

# errorRecordTypeAmbiguous

Record type target matched multiple records and cannot be selected safely: %s.

# errorRecordTypeInactive

Record type is inactive: %s.

# errorRecordTypeMetadataReadFailed

Unable to read complete %s metadata for record-type access audit (%s). No partial audit result was returned. Check the authenticated user's Setup and Metadata API read permissions.

# errorAccessQueryFailed

Failed to resolve access for %s target %s.

# errorInvalidUserValue

Invalid --user value: %s. Expected field:value.

# errorInvalidUserMatchField

Invalid User match field: %s.

# errorUserModeRequiresScope

Reverse user mode requires exactly one scope: --target or --sobject.

# errorUserModeScopesMutuallyExclusive

Use only one reverse-audit scope: --target or --sobject.

# errorSobjectRequiresUser

--sobject is only supported with --user reverse-audit mode.

# errorTargetRequired

Target-audit mode requires --target.

# errorSobjectUnsupported

--sobject is only supported for reverse field and object audits, not %s.

# errorUserResolutionFailed

Unable to resolve the requested user.

# info.noResults

No active users matched this target.

# info.noUserResults

No access grants matched this user and scope.

# examples

- Field access in human output (default):

  <%= config.bin %> <%= command.id %> --type field --target Account.CustomField__c --target-org myOrg

- Object access in csv output:

  <%= config.bin %> <%= command.id %> --type object --target Account --target-org myOrg --output csv

- Field access in json output:

  <%= config.bin %> <%= command.id %> --type field --target Account.CustomField__c --target-org myOrg --output json

- Apex class access in human output:

  <%= config.bin %> <%= command.id %> --type apex-class --target MyController --target-org myOrg

- Visualforce page access in csv output:

  <%= config.bin %> <%= command.id %> --type vf-page --target MyPage --target-org myOrg --output csv

- Custom permission access in json output:

  <%= config.bin %> <%= command.id %> --type custom-permission --target Can_Edit_Accounts --target-org myOrg --output json

- Tab visibility in human output:

  <%= config.bin %> <%= command.id %> --type tab --target Account --target-org myOrg

- Record type access in human output:

  <%= config.bin %> <%= command.id %> --type record-type --target Account.Business_Account --target-org myOrg

- Reverse field access for one user:

  <%= config.bin %> <%= command.id %> --user 'Username:alice@example.com' --type field --target Account.CustomField__c --target-org myOrg

- Reverse object access across an SObject:

  <%= config.bin %> <%= command.id %> --user 'Username:alice@example.com' --type object --sobject Account --target-org myOrg --output json

- Reverse record type access for one user:

  <%= config.bin %> <%= command.id %> --user 'Username:alice@example.com' --type record-type --target Account.Business_Account --target-org myOrg
