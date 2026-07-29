# Security Policy

We take the security of the Zenrows CLI seriously and appreciate
responsible disclosure.

## Reporting a vulnerability

Please report suspected vulnerabilities privately by emailing
**support@zenrows.com**.

Do **not** open a public issue for security reports. Include, where possible:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept helps), and
- any relevant versions, configuration, or logs (with secrets removed).

We will acknowledge your report, keep you updated on our progress, and
coordinate a disclosure timeline with you.

## Secrets

Never commit secrets. This toolkit stores credentials only in your local
workspace (`.zenrows/secrets.json` and `.zenrows/account.json`, both written
with `0600` permissions) and redacts API keys from logs and run artifacts.
API keys and account files are git-ignored and must never be committed to this
or any other repository.
