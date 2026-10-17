# Security Policy

## Supported Versions

Currently, the following versions of View Counter are supported with security updates:

| Version | Supported          |
| ------- | ------------------ |
| 3.6.x   | :white_check_mark: |
| < 3.6   | :x:                |

Versions before 3.0 are not supported: the analytics read endpoints were
unauthenticated and visitor hashes were derived without a server secret, which
made them reversible to the originating IP. Upgrade rather than patching 2.x.

3.5.x is not patched further. 3.6 is a drop-in upgrade: its schema v8 adds one
column (`collected_by`) to every app table on first start, and nothing else
changes until edge counting or the consent prompt is switched on.

3.4.x is not patched further. 3.5 is a drop-in upgrade with no schema change.
It fixes a way past an app's origin binding and request budget: a POST to
`/event` or `/engage` naming one app in its query string and another in its
body was checked as the first and stored under the second. Earlier
releases are affected where apps are bound to their sites; upgrade.

3.4 was a drop-in upgrade with no breaking change
to the public API: its schema migration runs on startup and adds one small
table. From 3.4 a visitor hash is also keyed with a per-window salt that is
deleted when the window ends, so a past window's hashes cannot be recomputed
even with the server secret; exclude the `_visitor_salts` table from backups
and mind the binary log, as the README explains. See the changelog for the
upgrade notes.

3.3 added one nullable column and its index, and updated `proxy-addr` for
GHSA-jqcg-44mw-7w3h.

3.2 stores referrers without their query string or fragment, which in 3.1
could keep a token or email address from the page a visitor came from; it
stops storing bots; and it replaces the AGPL-licensed ua-parser-js 2.x with
the MIT-licensed 1.x.

3.0.x and 3.1.x are not supported. 3.1 moved to a public id per row and fixed
runtime dependency advisories present in 3.0.x.

## Edge counting: a credential and an endpoint of their own

Edge counting adds one optional secret and one endpoint. `EDGE_SECRET` (at
least 32 characters, or the server refuses to start) is a credential tier of
its own: it authenticates the Worker in front of your sites on
`POST /edge/view`, server to server, and can do nothing but add page views.
It is read from the environment only, compared in constant time, and never
logged; a request without it, or with a wrong one, is limited by its own
address and refused with 401 before its body is read, and counted in the
tracking log under no app, never with the header's value. Without the
secret the endpoint does not exist (404). The page each report names must be
on one of its app's registered sites, so a Worker mapping a site to the wrong
app cannot file views under it, and the per-address limit counts the
visitor's address each report names, not the Worker's. Keep the secret apart
from your API keys and the admin password (the server warns when one is
reused), and rotate it on the server and the Worker together if it may have
leaked. Anyone holding it can add views to your apps, not read or change any.

## Reporting a Vulnerability

We take the security of this project seriously. If you believe you have found a security vulnerability, **please do not open a public issue.**

Report it privately through GitHub's [private vulnerability reporting](https://github.com/harshankur/viewcounter/security/advisories/new). That opens a draft advisory visible only to you and the maintainers, and lets us coordinate a fix and disclosure in one place.

Please include:
- The version of the project you are using.
- A description of the vulnerability.
- Steps to reproduce (if possible).
- Any potential impact.

We will acknowledge your report and work on a fix as soon as possible. Please do not disclose vulnerabilities publicly until we have had a chance to address them.
