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
   folder named `wardrobe_api`, i.e. `/addons/wardrobe_api/` (use the **Samba**
   or **Studio Code Server / File editor** add-on to copy the files there).
2. **Settings → Add-ons → Add-on Store → ⋮ (top right) → Check for updates**,
   then look for **Local add-ons → Digital Wardrobe API** and click **Install**.
3. Open the add-on's **Configuration** tab and set:
   - `db_host: core-mariadb`
   - `db_name: wardrobe`, `db_user: wardrobe`, `db_password:` *(the one you set)*
   - `jwt_secret:` a long random string (any ~40+ random characters)
   - `allowed_origins: https://digital-wardrobe-sable.vercel.app`
4. **Start** the add-on, then check the **Log** tab — you should see
   `Digital Wardrobe API listening on :8080`.

The API is now reachable at `http://<your-home-assistant-ip>:8080`.

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

### Option A — Home Assistant "Cloudflared" add-on (recommended, needs a domain on Cloudflare)

1. **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add
   `https://github.com/brenner-tobias/ha-addons`, then install **Cloudflared**.
2. In its config, set your `external_hostname` (for HA) and add an
   `additional_hosts` entry:
   ```yaml
   additional_hosts:
     - hostname: wardrobe.yourdomain.com
       service: http://<api-host-ip>:8080
   ```
   (use `homeassistant.local` / the host IP running the API server).
3. Start the add-on — it creates the DNS record and tunnel automatically.

Your API is now at `https://wardrobe.yourdomain.com`.

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

1. In **Vercel → your project → Settings → Environment Variables**, add:
   - `VITE_API_BASE` = `https://wardrobe.yourdomain.com` (no trailing slash)
2. Make sure the server's `ALLOWED_ORIGINS` (in `server/.env`) matches your
   Vercel app URL, and restart the server (`docker compose up -d`).
3. **Redeploy** the Vercel app (Vite bakes `VITE_` vars at build time, so a
   redeploy is required after changing it).
4. Open the app → you'll see a **sign-in screen** → create your account.

Everything now saves to your MariaDB and syncs across every device you sign in
on. With `VITE_API_BASE` unset, the app falls back to on-device (offline) mode.

## Security notes

- MariaDB itself is never exposed to the internet — only the auth-protected API.
- Use a strong `JWT_SECRET` and DB password.
- Image URLs carry the session token as a `?token=` query param (browsers can't
  send auth headers on `<img>` tags). For extra hardening, put **Cloudflare
  Access** in front of `wardrobe.yourdomain.com`.
