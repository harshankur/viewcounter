# Changelog

All notable changes to this project are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0]

Security release. The analytics read endpoints now require authentication, so
**upgrading from 2.x is a breaking change**: set `READ_API_KEYS` and send an
`x-api-key` header, set `CORS_ORIGINS`, replace any use of `GET /ip`, and run on
Node 24 or newer.

### Added

- Authentication on every analytics read endpoint (`/stats`, `/views`,
  `/trends`, `/referrers`, `/browsers`, `/pages`, `/sessions`, `/apps`), via an
  `x-api-key` header compared in constant time. Multiple keys are supported so
  one consumer can be revoked independently. Fails closed when unconfigured.
- Persisted server secret for visitor hashing, generated with a CSPRNG on first
  run and stored at mode `0600`.
- Per-app origin binding for the write endpoints, configured through `origins`
  in `allowed.json`.
- **Multi-tenancy.** Read keys are scoped to the apps they may read, via an
  `apiKeys` map in `allowed.json`. A key presented for an app outside its scope
  is refused with 403, and `GET /apps` returns only the apps in scope so the
  listing cannot be used to discover other tenants.
- Separate admin credential tier (`ADMIN_API_KEYS`) for provisioning. A read
  key cannot provision and an admin key cannot read analytics.
- `POST /apps` provisions a tenant at runtime: validates the app ID, creates its
  table, records it in a new `_apps` registry, and adds it to the live allowlist
  without a restart. Idempotent.
- Per-app write rate limit (`APP_RATE_LIMIT_MAX`), keyed on `appId` so it cannot
  be bypassed by rotating IP addresses, alongside the existing per-IP limit.
- Strict app-ID validation (`utils/appIdUtils.js`). App IDs become table
  identifiers and can now arrive over HTTP, so they are restricted to letters,
  digits, underscore, and hyphen, and may not use the reserved `_` prefix.
- Fail-fast startup validation: a production deploy on default credentials, the
  placeholder appId, or no CORS allowlist now refuses to boot.
- `constants.js`, `utils/errorUtils.js`, `utils/logger.js`, `utils/ipUtils.js`,
  `utils/stringUtils.js`, and `utils/secretStore.js`.
- Structured logger with configurable levels and a separate audit channel for
  state-mutating actions.
- `source_type` column, restoring referrer source analytics.
- `routes/analytics.js` exporting `createAnalyticsRouter`, so the service can be
  mounted into an existing Express app as middleware.
- End-to-end suite (`tests/e2e/`) that boots the real server against a real
  database and inspects the rows it wrote. Runs across MySQL 8 and MariaDB 11
  in both `create` and `connect` modes via `docker-compose.e2e.yml`, and in CI
  against a MySQL service container. It found two crash bugs a mock could not.
- Adversarial regression suite (`tests/security.test.js`) and a cross-tenant
  isolation suite (`tests/multiTenancy.test.js`), plus unit coverage for every
  new module. Test count 61 → 340; coverage floor raised from 50% to 85%/75%
  and is build-breaking.
- ESLint with the error-handling rules, wired into `npm test`.
- CI (Node 24, lint, audit, tarball check, real-MySQL E2E) and a release
  workflow that publishes each new `package.json` version to npm with
  provenance.
- `ALLOWED_APP_IDS` and `ALLOWED_DEVICE_SIZES` environment variables.
- Full icon set and `scripts/generate-brand-assets.js`.

### Changed

- **Breaking:** analytics read endpoints require `READ_API_KEYS` to be
  configured and a valid `x-api-key` header on every request.
- **Breaking:** `GET /ip` removed. It echoed the caller's address, geolocation,
  and parsed user agent, which is a tuning oracle for header spoofing.
- **Breaking:** CORS is now an explicit allowlist via `CORS_ORIGINS`. The
  previous wildcard made every read endpoint script-readable from any origin.
- **Breaking:** `PrivacyUtils.generateVisitorHash` requires a server secret and
  throws without one.
- The visitor hash is an HMAC-SHA-256 keyed with the server secret and mixed
  with a rotation window, replacing an unkeyed SHA-256 of IP + user agent + date.
- `NODE_ENV` defaults to `production` rather than `development`.
- `trust proxy` is configured through `TRUST_PROXY` and is never bare `true`.
- The `>VC` logo is drawn as vector outlines instead of being typeset from a
  webfont, so it renders identically everywhere.
- `index.js` reduced to a bootstrap; routes moved to `routes/analytics.js`.
- App-ID validation reads the allowlist per request rather than capturing it at
  startup, so apps provisioned at runtime are accepted immediately.
- `files` allowlist added to `package.json`; published tarball 188 kB → 19 kB.

### Fixed

- **The published package was unusable.** `constants.js` was missing from the
  `files` list, so the tarball shipped without it and `require('viewcounter')`
  threw `Cannot find module './constants'` immediately. CI now installs the
  packed tarball and imports it, because a `files` list can only be verified by
  actually installing what it produces.
- **Importing the package started a server and wrote to node_modules.** The
  entry point ran `initializeServer()` and eagerly resolved the visitor-hash
  secret at import time, so merely requiring the library to mount its router
  validated config, attempted a database connection, and persisted a secret
  inside `node_modules` — where the next install wipes it. Startup is now gated
  on being the main module, and the secret resolves lazily on first read.
- **The server crashed on its first database connection.** `mysql2/promise`'s
  pool emits the raw callback-style connection on its `connection` event, and
  mysql2 deliberately makes `.then()`/`.catch()` on the resulting `Query`
  throw — so the statement-timeout hook took the process down before it could
  serve a request. Only a real database surfaced this; the test mock's pool
  hook was a no-op that never invoked the handler. The mock now emits a
  realistically-shaped connection, so the unit suite catches a regression.
- **A crash exited with status 0.** `uncaughtException` routed into the
  graceful-shutdown path, which always exited 0, so Docker, systemd, and
  Kubernetes would all read a fatal crash as a clean shutdown and might decline
  to restart the service. Crash-triggered shutdowns now exit non-zero and log
  the stack.
- Visitor hashes were reversible to the originating IP. The hash was
  `SHA-256(ip | userAgent | date)` with no secret, and every input is public or
  guessable, so the full IPv4 space could be exhausted in roughly an hour on one
  CPU core. Now keyed with a persisted server secret.
- Analytics for any tracked app were readable by anonymous callers, and
  `GET /apps` enumerated the app IDs to aim at them.
- Any valid read key could read *every* app's analytics. The app-ID allowlist
  constrained which table was queried but never who was entitled to query it,
  so on a shared instance one tenant could read another's data.
- `GET /sessions/:appId/:sessionId` used `SELECT *`, returning `visitor_hash`
  and `masked_ip`. It now selects an explicit column list.
- `getIp()` trusted `x-real-ip` and `x-forwarded-for` unconditionally, letting a
  caller forge their address to bypass rate limiting, fake geolocation, and
  inflate unique-visitor counts.
- `GET /referrers/:appId` failed on every real deployment: it queried a
  `source_type` column that was never created, and the value was computed then
  discarded on insert. The test mock had been fabricating results for it.
- Raw client IPs were written to stdout on every view, event, and error, which
  persists them to disk on any normal deployment.
- Database error text was returned to callers whenever `NODE_ENV` was not
  exactly `development` — which was the default. Responses now carry only a
  request id.
- `limit`, `days`, and `offset` were unvalidated: `?limit=abc` produced
  `LIMIT NaN` and `?limit=999999999999` defeated the intended row cap.
- `POST /event` bypassed the validation layer entirely and accepted unbounded
  arbitrary JSON in `eventData`.
- No field had a length cap, so an over-long page title or a browser version
  parsed from a hostile User-Agent caused a 500 under MySQL strict mode.
- `isValidIP` had no octet range check, so `999.999.999.999` validated.
- Config precedence discarded defaults field by field: a `dbInfo.json` missing
  `host` produced `undefined`, and an `allowed.json` missing `appId` threw at
  startup.
- The connection pool had an unbounded queue and no statement timeout.
- Graceful shutdown never closed the HTTP listener, severing in-flight requests.
- No handler for `unhandledRejection` or `uncaughtException`.
- Analytics responses carried no `Cache-Control`, so a shared proxy could cache
  and re-serve them.
- The setup wizard wrote `dbInfo.json`, `allowed.json`, and `.env` world-readable
  despite them holding the database password, and wrote `NODE_ENV=development`.
- The theme switcher threw on an unexpected `localStorage` value, leaving the
  docs page unstyled, and signalled its toggled state through colour alone.

### Removed

- `GET /ip`.
- Support for Node 20 and Node 22; the minimum is now Node 24. Node 20 reached
  end of life in April 2026 and no longer receives security patches. Node 22 is
  still supported upstream, but this project tracks only the current LTS rather
  than maintaining a matrix of older runtimes — a decision, not an EOL forced
  by anything about 22 itself. Dropping a runtime is a breaking change and
  belongs in a major release, and this is that release.
- `docs/favicon.png`, superseded by `favicon.ico` and the `icon-*.png` set.

## [2.0.0]

### Added

- Unique-visitor tracking alongside total views.
- Custom event tracking via `POST /event`.
- Analytics endpoints for trends, referrers, browsers, pages, and sessions.
- Setup wizard (`npm run setup`) for guided database and allowlist configuration.

### Changed

- Privacy-first data handling: IP addresses are masked before storage and
  visitors are identified by a transient daily hash rather than a stored
  identifier.
