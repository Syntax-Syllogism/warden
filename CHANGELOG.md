# Changelog

I need the commit subjects to generate the changelog entry. The "Commits:" section in your message is empty. Could you provide the git commit subjects since v0.2.2, or would you like me to fetch them with `git log` (which requires approval)?

## [0.5.1] - 2026-08-31

### Changed

- Internal maintenance and tooling updates

## [0.5.0] - 2026-08-31

### Added

- New interactive command mode for streamlined user provisioning and lifecycle management
- Automatic inference of user definition format in interactive provisioning
- Support for provisioning related records through interactive mode

### Fixed

- Validation of API configuration and flag conflicts in interactive mode
- Validation of branch names and prompted file paths when using interactive provisioning
- Early rejection of unusable access types with the --sobject flag
- Removal of duplicate rows in diff assignment output

## [0.4.0] - 2026-08-20

### Added

- Add related record provisioning

### Fixed

- Report matched values in provisioning output
- Fix person-account eligibility reading
- Address related-record provisioning review findings
- Harden related record planning
- Enforce diff message lookup requirements

## [0.3.0] - 2026-08-16

### Added

- Support for running commands in the current working directory when no project directory is specified
- Snapshot identity tracking and CSV round-trip validation

### Fixed

- Shared warden command base is no longer exposed in the CLI
- Empty snapshot CSV metadata is now properly preserved
- Improved snapshot CSV output handling

## [0.2.4] - 2026-08-04

### Changed

- Internal maintenance and tooling updates

## [0.2.2] - 2026-08-03

### Changed

- Internal maintenance and tooling updates

## [0.2.1] - 2026-07-28

### Changed

- Internal maintenance and tooling updates

## [0.2.0] - 2026-07-26

### Added

- Support for CSV user definition input
- CSV output across all warden commands
- Profile-only provisioning mode
- Reverse user access audits
- Persona conformance verification
- License-aware provisioning preflight checks
- Exit signal support
- Lifecycle identity resolution and assignment labels
- Filterable user matching with fuzzy username support
- Standardized command output format

## [0.1.1] - 2026-07-13

### Changed

- Internal maintenance and tooling updates

## [0.1.0]

- Initial release. Extracted from `jawn`'s `user` (user lifecycle administration) commands into a standalone plugin.
