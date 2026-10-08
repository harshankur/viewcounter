# Security Policy

## Supported Versions

Currently, the following versions of View Counter are supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 3.3.x   | :white_check_mark: |
| < 3.3   | :x:                |

Versions before 3.0 are not supported: the analytics read endpoints were
unauthenticated and visitor hashes were derived without a server secret, which
made them reversible to the originating IP. Upgrade rather than patching 2.x.

3.2.x is not patched further. 3.3 is a drop-in upgrade with no breaking change
to the public API: its schema migration runs on startup and adds one nullable
column and its index. See the changelog for the upgrade notes.

3.2 stores referrers without their query string or fragment, which in 3.1
could keep a token or email address from the page a visitor came from; it
stops storing bots; and it replaces the AGPL-licensed ua-parser-js 2.x with
the MIT-licensed 1.x.

3.0.x and 3.1.x are not supported. 3.1 moved to a public id per row and fixed
runtime dependency advisories present in 3.0.x.

## Reporting a Vulnerability

We take the security of this project seriously. If you believe you have found a security vulnerability, **please do not open a public issue.**

Report it privately through GitHub's [private vulnerability reporting](https://github.com/harshankur/viewcounter/security/advisories/new). That opens a draft advisory visible only to you and the maintainers, and lets us coordinate a fix and disclosure in one place.

Please include:
- The version of the project you are using.
- A description of the vulnerability.
- Steps to reproduce (if possible).
- Any potential impact.

We will acknowledge your report and work on a fix as soon as possible. Please do not disclose vulnerabilities publicly until we have had a chance to address them.
