# Dashboard API authentication (D2.2)

The dashboard API uses one backend-configured Manager/Admin account. It does not
create account records or reuse the backend's operational sync credential.

Required environment-variable names:

- `DASHBOARD_ORIGIN` — the exact browser origin, with no path or trailing slash.
- `DASHBOARD_AUTH_USERNAME` — the configured account name.
- `DASHBOARD_AUTH_PASSWORD_HASH` — an encoded scrypt hash, never a plaintext password.

Optional environment-variable names:

- `DASHBOARD_SESSION_TTL_SECONDS` — defaults to eight hours; accepted range is 60 seconds to 7 days.
- `DASHBOARD_COOKIE_NAME` — defaults to `bo_dashboard_session`.
- `DASHBOARD_COOKIE_SAMESITE` — defaults to `Lax`; accepted values are `Strict`, `Lax`, or `None`.
- `DASHBOARD_RATE_LIMIT_WINDOW_SECONDS` — defaults to 60 seconds.
- `DASHBOARD_RATE_LIMIT_MAX` — defaults to 10 login attempts per window.

`DASHBOARD_AUTH_PASSWORD_HASH` uses the format
`scrypt$<salt-base64url>$<derived-key-base64url>`. The implementation uses
Node's built-in scrypt with a 16-byte-or-longer salt and a 64-byte derived key.
Use `createDashboardPasswordHash()` from `services/dashboardAuth.js` in a
trusted offline environment to prepare the value; do not print it, commit it,
or place the plaintext password in source or deployment logs.

Sessions contain only an opaque random ID in an HttpOnly, host-only cookie and
are stored in process memory. They expire server-side; a process restart
invalidates them. The store and global login limiter are process-local,
bounded, and not horizontally shared. This V1 design is suitable only for a single running
backend instance unless a later, separately approved design adds shared state.

The API adds credentialed CORS only to its exact authentication and dashboard
routes, and only for `DASHBOARD_ORIGIN`. Cookies use Secure in Production and
whenever the configured dashboard origin uses HTTPS. If a future static
frontend and API are cross-site, configure `DASHBOARD_COOKIE_SAMESITE=None`;
that policy also forces Secure. Keep the dashboard and API on HTTPS. SameSite
policy, exact origin, and HTTPS
must agree with the eventual hosting domains. This note does not change Render
or any deployment setting.

Missing or malformed dashboard configuration makes only the dashboard/auth
routes return `503 dashboard_not_configured`; it does not prevent the existing
backend from starting. `DASHBOARD_SESSION_SECRET` is not required because the
session ID is generated randomly and validated against server-side memory.
