# Security Policy

Security reports are taken seriously. Please report vulnerabilities privately
so maintainers have a reasonable opportunity to investigate and release a fix
before details become public.

## Supported versions

Security fixes target the latest release and the `main` branch. Older releases
may not receive patches; upgrade to the latest release before reporting an issue
that may already be resolved.

## Reporting a vulnerability

Do not open a public issue or post vulnerability details in a public Discord
channel.

Use the first available private channel:

1. [GitHub private vulnerability reporting](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/security/advisories/new),
   when the repository setting is enabled.
2. Otherwise, send a private message to a project maintainer through the
   [Vintrack Discord](https://discord.gg/WbEpEjaWjP) and request a secure channel.
   Do not include exploit details or secrets in the initial message.

The canonical reporting instructions are always available through the
[repository security policy](https://github.com/JakobAIOdev/Vintrack-Vinted-Monitor/security/policy).

Include:

- the affected version or commit;
- the component and deployment configuration involved;
- reproducible steps or a minimal proof of concept;
- the expected and observed impact;
- any suggested remediation, if available.

Never include real session tokens, OAuth credentials, webhook URLs, proxy
credentials, personal data, or production database contents. Redact secrets and
use synthetic test accounts and data.

You should receive an acknowledgement within seven days. Resolution time varies
with severity and complexity. Maintainers will coordinate disclosure and credit
with the reporter where practical.

## Security-sensitive areas

Reports are especially useful for:

- authentication and authorization bypasses;
- exposure or misuse of encrypted Vinted session data;
- server-side request forgery or unsafe URL handling;
- secret leakage through logs, API responses, builds, or release artifacts;
- cross-user access to monitors, alerts, linked accounts, or administrative data;
- dependency vulnerabilities with a demonstrated impact on Vintrack.

## Responsible testing

Test only systems and accounts you own or are explicitly authorized to assess.
Do not degrade the public demo, access other users' data, bypass third-party
access controls, or generate abusive traffic. Vinted and other third-party
services remain governed by their own terms and policies.
