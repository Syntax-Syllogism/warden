# Security Policy

## Supported Versions

Warden is in pre-1.0 development. Only the current release receives security
fixes.

| Version                   | Supported |
| ------------------------- | --------- |
| `0.x.y` (current release) | ✅        |
| Older `0.x` releases      | ❌        |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email a description to **<j.p.richter@gmail.com>** with:

- a clear description of the issue,
- reproduction steps or a proof of concept,
- the affected version (commit SHA or release tag), and
- the impact you believe the issue has.

If you would like to encrypt your report, request a PGP key in your first
message and one will be provided.

## Response SLA

- **Acknowledgement:** within 7 days of receipt.
- **Triage and initial assessment:** within 14 days.
- **Fix target:** within 90 days of the acknowledged report.

If a fix will take longer than 90 days, the reporter will be notified with
a revised timeline and the reasoning.

## Public Disclosure

Disclosure happens at whichever comes first:

- 90 days after the report was acknowledged, or
- the release that ships the fix.

Reporters are credited in the release notes unless they request otherwise.

## Scope

In scope:

- The Warden source code and Salesforce API interactions.
- The packaged plugin artifacts published to npm and GitHub.
- Documentation or examples that could cause unsafe command behavior.

Out of scope:

- Vulnerabilities in Salesforce itself or in the `sf` CLI — please report
  those upstream.
- Issues that require an attacker to already have local code-execution
  privileges equivalent to the local user running Warden. Warden is a local
  Salesforce CLI plugin and relies on the permissions of the authenticated
  Salesforce user.
- Vulnerabilities that depend only on an intentionally over-privileged
  Salesforce user or org configuration, unless Warden makes the impact worse.

Please do not include production credentials or unredacted Salesforce data in
a report. Attach a minimal reproduction or sanitized sample instead.
