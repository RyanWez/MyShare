# MyShare Dashboard

A Next.js multi-operator console for managing Mytel → Mytel balance transfers (the **MyShare**
feature of the MyID app), reverse-engineered from `MyID.apk` v2.0.19, backed by **PostgreSQL (Aiven)**.

## Run Locally

```bash
npm install
npm run dev        # http://localhost:3100
```

## Required Environment Variables (`.env`)

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection URI (e.g. Aiven `postgres://...?sslmode=require`) |
| `ADMIN_USERNAME` | Root Admin username synced on startup (default: `MyShareAdmin`) |
| `AUTH_PASSWORD` | Root Admin password synced on startup |
| `AUTH_SECRET` | 32+ byte secret for signing `myshare_session` cookies & fallback token key |
| `AUTH_TOTP_SECRET` | Optional shared Google Authenticator TOTP secret (`node generate-2fa.js`) |
| `MYTEL_CLIENT_SECRET` | Keycloak client secret from `MyID.apk` (`eu/c.java`); required for token refresh |

### Optional Tunables

| Variable | Default | Purpose |
|---|---|---|
| `TOKEN_ENC_KEY` | `AUTH_SECRET` | AES-256-GCM key material for encrypting stored SIM tokens |
| `PG_POOL_MAX` | `4` | Max PostgreSQL pool connections per app instance |
| `PG_IDLE_TIMEOUT_MS` | `120000` (`4000` for `-pooler`/`:6543`) | Idle connection timeout before pool eviction |
| `PG_SSL_CA` | — | Optional PEM CA certificate if strict TLS verification is used |
| `LOGIN_MAX_ATTEMPTS` | `10` | Failed console logins per IP per 15 min |
| `LOGIN_MAX_ATTEMPTS_GLOBAL` | `60` | Failed console logins overall per 15 min |
| `MYTEL_PROXY_URL` | — | Proxy for outbound Mytel calls (also reads `HTTPS_PROXY`) |
| `MYTEL_TIMEOUT_MS` | `20000` | Per-request timeout against the Mytel API |

## Architecture Highlights

- **Aiven PostgreSQL & `Asia/Yangon` Bucketing:** Uses `pg` connection pooling (`src/lib/pg.ts`), idempotent table/role/admin initialization, and `AT TIME ZONE 'Asia/Yangon'` aggregations so daily/monthly SIM limits (`25,000` / `50,000` Ks) match Myanmar local time regardless of DB server timezone.
- **Rex Category Isolation:** Operators belong to a unique **Rex** category (`Rex-1` .. `Rex-17`, etc.). Multiple staff can optionally share a large Rex group. Root Admin / `rex.viewAll` roles view all Rex categories and can filter globally or move SIMs between Rex groups.
- **Role-Based Permissions:** Pre-seeded `Admin` and `Staff` roles plus custom roles under `/roles`. Controls page access, Overview widget-level visibility (enforced server-side in `/api/stats`), and destructive actions (`sims.delete`, `history.delete` disabled by default for Staff).
- **SIM Expiry Check:** Refreshing a SIM fetches both main balance (`/account-detail/api/v1.2/individual/account-main`) and `generalInfo` (`/account-detail/api/v1.1/individual/{subscriptionId}/account-detail`) to display bill expiration and 1-way/2-way block status.
- **Token Encryption at Rest:** `access_token` and `refresh_token` are AES-256-GCM encrypted (`src/lib/crypto.ts`) in PostgreSQL and never selected into public SIM responses.

## Pages

| Page | Purpose |
|---|---|
| `/` | Overview — stats, trend charts, top errors, recent transfers (permission-scoped) |
| `/transfer` | Make a transfer: pick SIM → receiver + amount → OTP → confirm |
| `/sims` | Server-paged SIM tray: login SIMs, view balances & bill expiry, move Rex, refresh tokens |
| `/receivers` | Transfers grouped by receiver |
| `/history` | Server-filtered transfer log with CSV export |
| `/users` | Admin: create/edit/disable operators, auto-generate passwords, manage Rex categories |
| `/roles` | Admin: manage `Admin`, `Staff`, and custom roles with granular permissions |

## Deploy (Free Hosting Options)

Because the database is hosted externally on PostgreSQL (Aiven / Neon / Supabase), the Next.js container (`Dockerfile`, `output: "standalone"`) is completely stateless.

### 1. Render.com (Free Web Service)
- Connect repository to [Render.com](https://render.com).
- A `render.yaml` blueprint is pre-configured. Select **Docker** environment and **Singapore** region.
- Fill in the required environment variables (`DATABASE_URL`, `AUTH_PASSWORD`, `AUTH_SECRET`, `MYTEL_CLIENT_SECRET`).

### 2. Cloudflare Tunnel (Free & Local Server)
You can run the app locally on a home/office machine with zero port-forwarding and high stability:
```bash
npm run prod    # Runs Next.js standalone on port 3100
npm run tunnel  # Spawns Cloudflare Tunnel with public HTTPS URL
```

### 3. Koyeb or Hugging Face Spaces (Docker Free)
Deploy directly using the bundled `Dockerfile` with `TZ=Asia/Yangon` and map the port to `3100` (or `7860` for HF Spaces).

### 4. Oracle Cloud Always Free
Deploy inside an Always Free Ubuntu VM in Singapore region using Docker or `npm run prod`.

## ⚠️ Disclaimer

This automates a carrier service. Bulk/automated transfers may violate Mytel's terms of service and could lead to SIM/account suspension. Use responsibly and only for legitimate purposes.
