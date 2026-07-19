// Small single-user login for the deployed wardrobe. Credentials come from
// env (LOGIN_EMAIL + LOGIN_CODE); a signed cookie holds the session. When
// AUTH_MODE=off (default in dev), auth is bypassed. When AUTH_MODE=cloudflare,
// we trust the platform (e.g. Cloudflare Access) and don't gate ourselves.
import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "wardrobe_session";
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

function readCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (!k) continue;
    out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function verifyCookie(cookie, secret) {
  if (!cookie) return false;
  const [payload, sig] = cookie.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload, secret);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function makeCookie(email, secret) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  const payload = Buffer.from(JSON.stringify({ email, exp })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Parse a login submission from either JSON (fetch caller) or a plain HTML
// form POST. The stream can only be read once, so we buffer first and branch
// on content-type second.
function parseCredentials(rawBody, contentType = "") {
  const raw = String(rawBody || "").trim();
  if (!raw) return { email: "", code: "" };
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      return { email: parsed?.email || "", code: parsed?.code || "" };
    } catch {
      return { email: "", code: "" };
    }
  }
  const params = new URLSearchParams(raw);
  return { email: params.get("email") || "", code: params.get("code") || "" };
}

const LOGIN_PAGE = (email = "", error = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>Wardrobe — Sign in</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    background:#f4f0e8; color:#191919;
    font-family:"Instrument Sans","Helvetica Neue",system-ui,sans-serif; }
  form { width:min(360px, 92vw); padding:36px 32px 30px; border:1px solid #cfc8bc;
    background:#fbf8f2; }
  h1 { margin:0 0 6px; font-size:20px; letter-spacing:.04em; }
  p { margin:0 0 22px; color:#66625d; font-size:13px; }
  label { display:block; font-size:11px; letter-spacing:.14em; text-transform:uppercase;
    color:#66625d; margin:14px 0 6px; }
  input { width:100%; box-sizing:border-box; padding:11px 12px; font:inherit;
    border:1px solid #cfc8bc; background:#fff; color:#191919; }
  input:focus { outline:2px solid #6e302e; outline-offset:2px; }
  button { margin-top:22px; width:100%; padding:12px; font:inherit; font-weight:600;
    letter-spacing:.06em; text-transform:uppercase; border:0; cursor:pointer;
    background:#191919; color:#f4f0e8; }
  button:hover { background:#000; }
  .err { margin-top:16px; padding:10px 12px; background:#faece9; color:#6e302e;
    border:1px solid #e5c9c4; font-size:12px; }
</style></head>
<body>
  <form method="post" action="/auth/login">
    <h1>Wardrobe</h1>
    <p>Sign in with your email and access code.</p>
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" required value="${email.replace(/"/g, "&quot;")}" />
    <label for="code">Access code</label>
    <input id="code" name="code" type="password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
    ${error ? `<div class="err">${error}</div>` : ""}
  </form>
</body></html>`;

export function authMiddleware({ env = {}, exemptPrefixes = [] } = {}) {
  const mode = String(env.AUTH_MODE || process.env.AUTH_MODE || "off").toLowerCase();
  const email = String(env.LOGIN_EMAIL || process.env.LOGIN_EMAIL || "").trim().toLowerCase();
  const code = String(env.LOGIN_CODE || process.env.LOGIN_CODE || "");
  const secretRaw =
    String(env.AUTH_SECRET || process.env.AUTH_SECRET || "") || `${email}:${code}:wardrobe-fallback`;
  const secret = secretRaw + "|v1";

  const enabled = mode === "on" || (mode !== "off" && mode !== "cloudflare" && email && code);
  if (!enabled) {
    // No-op middleware. Sits inline so we don't have to conditionally register.
    return (_req, _res, next) => next();
  }
  if (!email || !code) {
    console.warn("[auth] AUTH_MODE requires LOGIN_EMAIL and LOGIN_CODE. Auth is DISABLED.");
    return (_req, _res, next) => next();
  }

  const isExempt = (url) => {
    if (url === "/auth/login" || url === "/auth/logout") return true;
    return exemptPrefixes.some((p) => url === p || url.startsWith(`${p}/`) || url.startsWith(`${p}?`));
  };

  return async function auth(req, res, next) {
    const url = req.url || "/";

    if (req.method === "POST" && url === "/auth/login") {
      const raw = await readBody(req).catch(() => "");
      const { email: submittedEmail, code: submittedCode } = parseCredentials(
        raw,
        req.headers["content-type"] || ""
      );
      const okEmail = String(submittedEmail).trim().toLowerCase() === email;
      const okCode = String(submittedCode) === code;
      if (okEmail && okCode) {
        const cookie = makeCookie(email, secret);
        res.setHeader("Set-Cookie", [
          `${COOKIE_NAME}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}; Secure`,
        ]);
        res.statusCode = 303;
        res.setHeader("Location", "/");
        res.end();
        return;
      }
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(LOGIN_PAGE(submittedEmail || "", "Wrong email or access code."));
      return;
    }

    if (req.method === "POST" && url === "/auth/logout") {
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
      res.statusCode = 303;
      res.setHeader("Location", "/");
      res.end();
      return;
    }

    if (isExempt(url)) return next();

    const cookies = readCookies(req);
    if (verifyCookie(cookies[COOKIE_NAME], secret)) return next();

    // API requests get a JSON 401; page requests get the login form.
    if (url.startsWith("/api/")) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Sign in required." }));
      return;
    }
    res.statusCode = 401;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(LOGIN_PAGE());
  };
}
