# Deploy Wardrobe on Home Assistant

Runs the app at `https://wardrobe.lightmotions.dk`, gated by your email + a
code you set. Storage lives on the add-on's `/data` volume (survives restarts
and add-on updates).

## 1. Copy the code onto Home Assistant

In **Studio Code Server** (or Samba/File editor):

1. Under `/addons`, create a folder **`wardrobe`** (i.e. `/addons/wardrobe/`).
   *(If you still have the old `/addons/wardrobe_api/`, you can delete it — we
   won't need it after this replaces it.)*
2. Copy **the entire contents** of this repo (`github.com/Litemotions/digital-wardrobe`)
   into `/addons/wardrobe/`. Two ways:
   - **In Studio Code Server's terminal:** `git clone https://github.com/Litemotions/digital-wardrobe.git /addons/wardrobe`
   - **Or:** on your Mac, `git clone https://github.com/Litemotions/digital-wardrobe.git ~/Downloads/wardrobe-addon` then drag that folder's contents into `/addons/wardrobe/`.

The important files at the root of `/addons/wardrobe/` are:
`config.yaml`, `Dockerfile`, `run.sh`, `package.json`, `vite.config.mjs`,
`src/`, `scripts/`.

## 2. Install the add-on

1. **Settings → Add-ons → Add-on Store → ⋮ (top right) → Check for updates.**
2. Refresh, scroll to **Local add-ons → Wardrobe → Install** (first build takes
   several minutes — it's compiling the frontend and installing sharp).

## 3. Configure & start

Open the **Configuration** tab and set:

- `openai_api_key`: your OpenAI key (starts `sk-...`)
- `login_email`: `jibril@litemotions.dk`
- `login_code`: pick any memorable code, e.g. `Wardrobe2026!`
- Leave the model / quality defaults as-is
- `allowed_hosts`: `wardrobe.lightmotions.dk`
- `auth_mode`: `on`

**Save → Info → Start.** Then open the **Log** tab. Success looks like:
```
[wardrobe] starting on :4173 (hosts: wardrobe.lightmotions.dk)
  ➜  Local:   http://localhost:4173/
```

## 4. Point Cloudflare at the new port

Your Cloudflare tunnel already has a route for `wardrobe.lightmotions.dk`.
Update the origin service:

1. Cloudflare Zero Trust → **Networks → Tunnels → homeassistant → Published
   application routes**.
2. Edit the `wardrobe.lightmotions.dk` row → change **URL** to:
   `http://<your-home-assistant-ip>:4173`
   (previously `:8080` from the old API). E.g. `http://192.168.0.27:4173`.
3. **Save.**

## 5. Sign in

Open **https://wardrobe.lightmotions.dk** → you'll see a **Wardrobe · Sign in**
screen. Enter your email + code → you're in.

## 6. Add your model reference photo

For "generate look" images the app needs a photo of you. Put it at:

```
/data/model-reference.png     (inside the add-on's persistent volume)
```

Easiest way: use the **Samba share** add-on, then drop the PNG into
`\\homeassistant\addon_configs\local_wardrobe\model-reference.png` — or open a
Studio Code Server terminal and copy it there. The path is what the add-on
option `WARDROBE_MODEL_REFERENCE` points at.

## Updating

`cd /addons/wardrobe && git pull` in Studio Code Server, then rebuild the
add-on from **Info → Rebuild**.

## Troubleshooting

- **502 from Cloudflare** → the add-on isn't running or the port in the tunnel
  route isn't `:4173`.
- **`Blocked host` in Log** → set `allowed_hosts` to
  `wardrobe.lightmotions.dk` and restart.
- **Login screen won't accept credentials** → double-check `login_email` /
  `login_code` in the add-on config, restart the add-on to pick up changes.
- **Import stays "Extracting..." forever** → your `openai_api_key` is missing
  or the account can't reach the model. Try `openai_image_model: gpt-image-1`
  (widely available) if `gpt-image-2` errors on your account.
