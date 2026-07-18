# Accounts + cloud sync setup (MariaDB on Home Assistant)

This connects the app to your own MariaDB so you can sign in and have your
wardrobe, photos and looks saved to your account and synced across devices.

**Architecture** — the browser never talks to MariaDB directly. A small API
server runs at home next to the database, and a **Cloudflare Tunnel** exposes
*only that API* over HTTPS. Your database stays private on your LAN.

```
Browser (Vercel UI) ──HTTPS──▶ Cloudflare Tunnel ──▶ Home API server ──▶ MariaDB
```

---

## 1. Create a `wardrobe` database + user in the MariaDB add-on

Open **Settings → Add-ons → MariaDB → Configuration** (the Options screen).

1. **Databases** → add `wardrobe`.
2. **Logins** → **Add** → username `wardrobe`, and a strong password.
3. **Rights** → **Add** → user `wardrobe` on database `wardrobe`
   (it should read `wardrobe · wardrobe`, like the existing
   `homeassistant · homeassistant` row).
4. **Save**, then restart the MariaDB add-on.

> Keep your existing `homeassistant` database/user untouched — we only add a
> separate one so the app can't see your Home Assistant data.

The MariaDB add-on listens on port **3306** of the Home Assistant host.

## 2. Run the API server

### Option A — as a Home Assistant local add-on (recommended, no terminal)

The [`server/`](./server) folder doubles as a HA add-on (it contains a
`config.yaml`). Home Assistant builds and runs it for you, and it reaches your
MariaDB add-on directly over HA's internal network (`core-mariadb`).

1. Get the `server/` folder onto your HA machine's `/addons/` directory, in a
   folder named `wardrobe_api`, i.e. `/addons/wardrobe_api/`. Use the **Studio
   Code Server** (or File editor / Samba) add-on to create that folder and paste
   the files in.
2. **Settings → Add-ons → Add-on Store → ⋮ (top right) → Check for updates**,
   then look for **Local add-ons → Digital Wardrobe API** and click **Install**.
3. Open the add-on's **Configuration** tab and set:
   - `db_host: core-mariadb`
   - `db_name: wardrobe`, `db_user: wardrobe`, `db_password:` *(the one you set)*
   - `jwt_secret:` a long random string (any ~40+ random characters)
   - `admin_email: jibril@litemotions.dk` *(seeded as the first admin)*
   - `app_url: https://digital-wardrobe-sable.vercel.app` *(used to build the
     magic-link URL)*
   - `allowed_origins: https://digital-wardrobe-sable.vercel.app`
   - `smtp_*`: your email sending details (see **Magic-link email** below).
     Leave blank at first — links get printed to the add-on **Log** so you can
     bootstrap your own sign-in before email is configured.
4. **Start** the add-on, then check the **Log** tab — you should see
   `Digital Wardrobe API listening on :8080`.

The API is now reachable at `http://<your-home-assistant-ip>:8080`.

### Magic-link email (SMTP)

Sign-in is passwordless: users request a link and receive it by email. To send
real emails, set these in the add-on config (any SMTP provider works):

```
smtp_host: smtp.gmail.com
smtp_port: 587
smtp_user: you@yourdomain.com
smtp_password: <an app password, not your normal password>
smtp_from: Digital Wardrobe <you@yourdomain.com>
```

> With Gmail/Google Workspace, create an **App Password** (Account → Security →
> 2-Step Verification → App passwords) and use that as `smtp_password`.

**Before** email is set up, you can still sign yourself in: request a link in the
app, then open the add-on **Log** tab — the link is printed there. Access is
invite-only; `admin_email` is added automatically, and you can invite others
from the app (the **Access** button in the header).

### Option B — Docker (non-HA-OS machines)

```bash
cd server
cp .env.example .env   # fill DB_*, JWT_SECRET, ALLOWED_ORIGINS
docker compose up -d --build
curl http://localhost:8080/health      # -> {"ok":true}
```

> **DB_HOST tip:** on the same host as MariaDB use `host.docker.internal`
> (wired up in `docker-compose.yml`); otherwise the DB machine's LAN IP.

## 3. Expose the API over HTTPS with a Cloudflare Tunnel

Pick one:

### Option 0 — you already expose Home Assistant with a reverse proxy

If HA is already on the internet via **Nginx Proxy Manager**, **Caddy**, or
**Traefik** (i.e. you self-host the exposure, not Nabu Casa Cloud), just add one
proxy host:

- Domain: `wardrobe.lightmotions.dk`
- Forward to: `http://<your-home-assistant-ip>:8080`
- Enable SSL (Let's Encrypt) and "Websockets" if offered.

Then create a DNS record for `wardrobe.lightmotions.dk` pointing at the same
place your other HA hostname points. No tunnel needed — skip to step 4.

> Note: **Nabu Casa Cloud only exposes the HA UI**, not arbitrary add-on ports,
> so it can't publish this API — use the Cloudflared add-on (Option A) instead.

### Option A — Home Assistant "Cloudflared" add-on (needs a domain on Cloudflare)

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add
   `https://github.com/brenner-tobias/ha-addons`, then install **Cloudflared**.
2. In its config, set your `external_hostname` (for HA) and add an
   `additional_hosts` entry:
   ```yaml
   external_hostname: ha.lightmotions.dk
   additional_hosts:
     - hostname: wardrobe.lightmotions.dk
       service: http://<your-home-assistant-ip>:8080
   ```
3. Start the add-on — it creates the DNS record and tunnel automatically.

Your API is now at `https://wardrobe.lightmotions.dk`.

### Option B — standalone `cloudflared` (needs a domain on Cloudflare)

```bash
cloudflared tunnel login
cloudflared tunnel create wardrobe
cloudflared tunnel route dns wardrobe wardrobe.yourdomain.com
# config.yml:
#   tunnel: wardrobe
#   ingress:
#     - hostname: wardrobe.yourdomain.com
#       service: http://localhost:8080
#     - service: http_status:404
cloudflared tunnel run wardrobe
```

### Option C — quick temporary URL (no domain, for testing only)

```bash
cloudflared tunnel --url http://localhost:8080
```

It prints a `https://<random>.trycloudflare.com` URL. Great for a first test,
but it changes every run — don't use it long-term.

## 4. Point the app at your API

1. Verify the API is reachable: open `https://wardrobe.lightmotions.dk/health`
   → you should see `{"ok":true}`.
2. In **Vercel → your project → Settings → Environment Variables**, add:
   - `VITE_API_BASE` = `https://wardrobe.lightmotions.dk` (no trailing slash)
3. Make sure the add-on's `allowed_origins` and `app_url` match your Vercel app
   URL; restart the add-on if you changed them.
4. **Redeploy** the Vercel app (Vite bakes `VITE_` vars at build time, so a
   redeploy is required after changing it).
5. Open the app → **sign-in screen** → enter `jibril@litemotions.dk` → get the
   magic link (by email, or from the add-on **Log** if SMTP isn't set up yet) →
   you're in. Use the **Access** button (top-right, admins only) to invite
   others.

Everything now saves to your MariaDB and syncs across every device you sign in
on. With `VITE_API_BASE` unset, the app falls back to on-device (offline) mode.

## Security notes

- MariaDB itself is never exposed to the internet — only the auth-protected API.
- Access is invite-only (allowlist) with passwordless magic-link sign-in.
- Use a strong `JWT_SECRET` and DB password.
- Image URLs carry the session token as a `?token=` query param (browsers can't
  send auth headers on `<img>` tags). Keep your API behind HTTPS.
