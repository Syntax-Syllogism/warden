# summary

Audit active-user access for a permission target.

# description

Resolves active users who have access to a target and attributes each access path to Profile, Permission Set, or Permission Set Group sources.

# flags.target-org.summary

Target org username or alias.

# flags.type.summary

Target type to audit: field, object, apex-class, vf-page, custom-permission, or tab.

# flags.target.summary

Target API name. Use Object.Field for field, Object for object, Apex class name for apex-class, Visualforce page name for vf-page, custom permission DeveloperName for custom-permission, or tab API name for tab.

# flags.output.summary

Output format: human, csv, or json. Defaults to human.

# flags.api-version.summary

Override the api version used for the org connection.

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

# errorAccessQueryFailed

Failed to resolve access for %s target %s.

# info.noResults

No active users matched this target.

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
