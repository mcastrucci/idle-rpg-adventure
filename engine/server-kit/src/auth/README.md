# Guest, email and live-session authentication

`createAuthModule` provides generic Fastify HTTP authentication and an authenticated WebSocket surface. Games use
`requireAccount(request, context)` from a sibling module to get the authenticated `accountId`; no Fastify decorator
crosses an encapsulation boundary. The context supplies the database and clock explicitly. Composition passes
`enableHttp` for the API role and `enableLive` for the live role. Worker-only processes install neither surface.

## Credentials and identity

A first-launch client generates **32 cryptographically random bytes**, encodes them as unpadded base64url (43
characters), and persists that device token securely. A predictable device ID, platform ID or UUID is not a credential.
The server requires the canonical 256-bit encoding and rejects uniform-byte values; no format check can prove that a
client used a secure RNG. Device/session hashes use SHA-256 with distinct purpose prefixes. Raw tokens never enter
PostgreSQL. Repeating a first-launch request uses the same account; a transaction advisory lock prevents concurrent
retries from creating orphan/duplicate accounts.

Email upgrade adds a password credential to the **existing account UUID**. Any actor's account foreign key remains
unchanged. Email addresses are trimmed, lowercased ASCII identities with a unique constraint. A duplicate email fails
without transferring an account, merging identities, or disabling the losing guest. Account identity always comes
from the authenticated session; request bodies cannot select another account. Password sign-in explicitly proves
credentials for the selected existing account; it never merges a guest identity into that account.

This is password authentication, **not email ownership verification**. There is no email transport, verification
message, recovery or password-reset flow in this foundation. An upgrade disables the old device credential and
revokes all old sessions/live leases, then returns a replacement session for the same account. Keep the disabled
device record: deleting it would incorrectly allow that credential to create a fresh guest account. A guest login and
an upgrade both lock the account row before issuing/rotating credentials, preventing a device login in flight from
issuing a valid session after upgrade.

Passwords use Node's maintained asynchronous [`crypto.scrypt`](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
with a random 16-byte salt, 32-byte derived key, `N=131072`, `r=8`, `p=1`, and `maxmem=192 MiB`. This is the scrypt
profile recommended by the [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
The versioned hash records the parameters/salt/key, and verification uses `timingSafeEqual`. Passwords are 12–256
UTF-8 bytes; they are never trimmed. Unknown emails perform the same asynchronous derivation. At most two password
operations run per process; additional work receives 429 instead of an unbounded memory/CPU queue.

## HTTP surface

| Method/path | Input | Result |
|---|---|---|
| `POST /auth/guest` | `{ deviceToken }` | Creates/reuses a guest and issues an opaque session. |
| `POST /auth/signin` | `{ email, password }` | Verifies existing password credentials and issues a session. |
| `POST /auth/upgrade` | Authenticated `{ email, password }` | Upgrades in place and rotates credentials. |
| `POST /auth/logout` | Authenticated header/cookie | Idempotently revokes that session, releases its live lease; 204. |
| `GET /auth/session` | Authenticated header/cookie | Own account ID, guest/email state and session expiry. |

Issued sessions contain a fresh server-generated 32-byte random `sessionToken`, the account ID and an expiry.
Only its hash is persisted. HTTP and WS authenticate with `Authorization: Bearer <token>` or the
`__Host-idle_session` cookie (`Secure; HttpOnly; SameSite=Strict; Path=/`, no Domain). An explicit malformed bearer
header fails instead of falling back to a cookie; duplicate session cookies also fail. Responses are `Cache-Control:
no-store`. Browser deployments require HTTPS; native/local tests can use the bearer header. Passwords and tokens
never belong in URLs, log fields or WebSocket subprotocols/frames.

Bodies have a 4096-byte limit and an exact-key parser. Authentication attempts are limited per process/IP (default
30 per minute), with an additional 10-per-minute normalized-email limit for sign-in. The bounded limiter rejects new
keys when full; it does not evict existing limits under attack. These are initial operational limits, configurable
through module options; they are not a distributed rate limiter. Fastify's default untrusted-proxy behavior prevents
arbitrary forwarded-IP headers from bypassing them. TLS reverse proxies must configure trusted forwarding and an
explicit `allowedOrigins` allowlist. Cross-origin browser requests and WS upgrades are rejected; same-origin native
server requests without an Origin still require bearer/cookie credentials. Cookie use does not enable CORS.

## Live policy and command extension

`GET /auth/live` is a WebSocket upgrade authenticated through its HTTP header/cookie. Query-string credentials are
unsupported. The socket emits `{ type: 'authenticated', accountId }` after acquiring a database-backed live lease.
Only **one active authorized live connection per account** is allowed, including two sockets sharing one HTTP token.
The second socket is refused with close code 4409 after its HTTP session is checked; the original stays active.
Missing/expired HTTP credentials fail the upgrade with 401.

Every command or `ping` renews and revalidates the lease/session; `ping` replies `pong`. Automatic heartbeat defaults
to 10 seconds with a 30-second lease. Revocation/expiry closes the socket with 4401 on its next check (at most one
heartbeat interval for an idle socket). An expired lease can be reclaimed after a crashed process; a random fencing
UUID prevents a delayed close/heartbeat from the old socket releasing or renewing its successor. Normal disconnect
and module shutdown release leases. An accepted command drains before shutdown releases the database pool.

Without an `onCommand` option, the socket supports only authenticated acknowledgement and ping/pong. With an
injected `onCommand(payload, identity, context, connection)` callback, it accepts `{ type: 'command', command: <payload> }`,
authenticates immediately before dispatch, and sends the callback's JSON result. `connection` (`id`, `push`, `onClose`)
lets a handler push later server messages on the same socket (used by the live instance host). Games can reuse their HTTP command
dispatcher through this hook. No game imports/protocol, exploration host or combat loop is implemented here. Frames
are bounded at 70 KiB, with eight queued frames and 120 client frames/minute per socket. Valid frames serialize with
heartbeat work; unsupported/binary/overload frames get a policy close. Command exceptions produce a generic error,
and frames/credentials are never logged by this module.

Optional `onLifecycle(event)` receives only `{ type, accountId, connectionId, atMs }` for `authenticated`, successful
`heartbeat` renewals (including command renewals), and `stopped`. `atMs` comes from the injected server clock. Events
are serialized with connection setup and frame work; callback errors are isolated from authentication, commands, and
lease release. `createLifecycleHandler(context)` can bind a game persistence handler during module registration; the
event passed to that handler remains limited to those four fields. This is connection telemetry: a successful
authenticated socket interval, not foreground presence or gameplay activity.

## Persistence and validation

The engine migration set includes `auth/schema.ts`: `accounts`, `guest_credentials`, `email_credentials`,
`auth_sessions`, and `live_sessions`. All timestamps use the injected clock and PostgreSQL timestamptz. Sessions
expire after 12 hours by default; module/service options can shorten that for tests. Logout is safe to retry.
Expiry/revocation is checked on every authenticated access, not dependent on a cleanup job.

Real-PostgreSQL tests create an isolated disposable database from `TEST_DATABASE_URL` (requires CREATEDB) and run the
engine migrations. They cover first-launch concurrency, hash-only storage, in-place upgrade, duplicate-email races,
a coordinated guest-versus-upgrade race, session expiry/revocation, concurrent live acquisition, fenced reconnects,
actual Fastify WS handshakes and serialized commands/pings, and HTTP cookie/origin/body/rate limits. CI must provide
the database URL; local runs without it explicitly skip persistence tests. Unit tests exercise real scrypt, random
token validation, cookie parsing and injected-clock rate limits.
