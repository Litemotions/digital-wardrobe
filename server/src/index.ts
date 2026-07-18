import "./haOptions.js"; // must run first: maps HA add-on options -> env
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { RowDataPacket } from "mysql2";
import { pool, initSchema } from "./db.js";
import {
  signToken,
  makeMagicToken,
  hashToken,
  requireAuth,
  requireAdmin,
  isAdminUser,
  type AuthedRequest,
} from "./auth.js";
import { sendMagicLink } from "./mailer.js";

const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const TOKEN_TTL_MS = 15 * 60 * 1000;

const app = express();
app.use(express.json({ limit: "25mb" }));

const origins = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());
app.use(
  cors({
    origin: origins.includes("*") ? true : origins,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);

const CATEGORIES = new Set([
  "top",
  "bottom",
  "dress",
  "outerwear",
  "shoes",
  "accessory",
]);

function bad(res: Response, code: number, msg: string) {
  res.status(code).json({ error: msg });
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Auth (passwordless magic link, invite-only) ----------------------
async function isAllowed(email: string): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT email FROM allowed_emails WHERE email = ?",
    [email]
  );
  return rows.length > 0;
}

// Request a sign-in link. Only allow-listed emails receive one.
app.post("/auth/request-link", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return bad(res, 400, "Enter a valid email.");
  try {
    if (!(await isAllowed(email))) {
      return bad(
        res,
        403,
        "This email isn't on the invite list yet. Ask the owner to add you."
      );
    }
    const { raw, hash } = makeMagicToken();
    // Invalidate previous links for this email, then store the new one.
    await pool.execute("DELETE FROM login_tokens WHERE email = ?", [email]);
    await pool.execute(
      `INSERT INTO login_tokens (id, email, token_hash, expires_at, used, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [randomUUID(), email, hash, Date.now() + TOKEN_TTL_MS, Date.now()]
    );
    const base = APP_URL || (req.headers.origin as string) || "";
    const link = `${base}/?token=${raw}`;
    await sendMagicLink(email, link);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    bad(res, 500, "Could not send the sign-in link.");
  }
});

// Exchange a magic-link token for a session.
app.post("/auth/verify", async (req, res) => {
  const raw = String(req.body?.token || "");
  if (!raw) return bad(res, 400, "Missing token.");
  try {
    const hash = hashToken(raw);
    const [rows] = await pool.execute<RowDataPacket[]>(
      "SELECT id, email, expires_at, used FROM login_tokens WHERE token_hash = ?",
      [hash]
    );
    const row = rows[0];
    if (!row || row.used || Number(row.expires_at) < Date.now())
      return bad(res, 401, "This sign-in link is invalid or has expired.");
    await pool.execute("UPDATE login_tokens SET used = 1 WHERE id = ?", [row.id]);

    const email = String(row.email);
    // Guard: email might have been removed from the allowlist meanwhile.
    if (!(await isAllowed(email)))
      return bad(res, 403, "Your access has been removed.");

    // Find or create the user.
    let [users] = await pool.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );
    let userId: string;
    if (users.length) {
      userId = users[0].id;
    } else {
      userId = randomUUID();
      await pool.execute(
        "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)",
        [userId, email, Date.now()]
      );
    }
    res.json({
      token: signToken(userId),
      user: { id: userId, email, isAdmin: await isAdminUser(userId) },
    });
  } catch (err) {
    console.error(err);
    bad(res, 500, "Could not verify the sign-in link.");
  }
});

app.get("/auth/me", requireAuth, async (req: AuthedRequest, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, email FROM users WHERE id = ?",
    [req.userId!]
  );
  if (!rows.length) return bad(res, 404, "User not found.");
  res.json({
    user: {
      id: rows[0].id,
      email: rows[0].email,
      isAdmin: await isAdminUser(req.userId!),
    },
  });
});

// --- Admin: manage the invite allowlist -------------------------------
app.get("/admin/allowed", requireAdmin, async (_req, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT email, is_admin, invited_by, created_at FROM allowed_emails ORDER BY created_at ASC"
  );
  res.json(
    rows.map((r) => ({
      email: r.email,
      isAdmin: !!r.is_admin,
      invitedBy: r.invited_by || undefined,
      createdAt: Number(r.created_at),
    }))
  );
});

app.post("/admin/allowed", requireAdmin, async (req: AuthedRequest, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const isAdmin = req.body?.isAdmin ? 1 : 0;
  if (!email || !email.includes("@")) return bad(res, 400, "Enter a valid email.");
  const [me] = await pool.execute<RowDataPacket[]>(
    "SELECT email FROM users WHERE id = ?",
    [req.userId!]
  );
  const inviter = me[0]?.email || "admin";
  try {
    await pool.execute(
      `INSERT INTO allowed_emails (email, is_admin, invited_by, created_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_admin = VALUES(is_admin)`,
      [email, isAdmin, inviter, Date.now()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    bad(res, 500, "Could not add that email.");
  }
});

app.delete(
  "/admin/allowed/:email",
  requireAdmin,
  async (req: AuthedRequest, res) => {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase();
    const [me] = await pool.execute<RowDataPacket[]>(
      "SELECT email FROM users WHERE id = ?",
      [req.userId!]
    );
    if (me[0]?.email === email)
      return bad(res, 400, "You can't remove your own access.");
    await pool.execute("DELETE FROM allowed_emails WHERE email = ?", [email]);
    res.json({ ok: true });
  }
);

// --- Generic image-owning resource helpers ----------------------------
type Kind = "item" | "model" | "look";
const TABLE: Record<Kind, string> = {
  item: "items",
  model: "models",
  look: "looks",
};

async function ownsRow(kind: Kind, id: string, userId: string) {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT id FROM ${TABLE[kind]} WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  return rows.length > 0;
}

function serveImage(kind: Kind) {
  return async (req: AuthedRequest, res: Response) => {
    const [rows] = await pool.execute<RowDataPacket[]>(
      `SELECT mime, image FROM ${TABLE[kind]} WHERE id = ? AND user_id = ?`,
      [req.params.id, req.userId!]
    );
    if (!rows.length) return res.status(404).end();
    res.setHeader("Content-Type", rows[0].mime || "image/png");
    res.setHeader("Cache-Control", "private, max-age=86400");
    res.end(rows[0].image);
  };
}

app.get("/img/item/:id", requireAuth, serveImage("item"));
app.get("/img/model/:id", requireAuth, serveImage("model"));
app.get("/img/look/:id", requireAuth, serveImage("look"));

// --- Items ------------------------------------------------------------
app.get("/items", requireAuth, async (req: AuthedRequest, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, name, category, color, created_at FROM items WHERE user_id = ? ORDER BY created_at DESC",
    [req.userId!]
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      color: r.color || undefined,
      createdAt: Number(r.created_at),
      imageUrl: `/img/item/${r.id}`,
    }))
  );
});

app.post("/items", requireAuth, async (req: AuthedRequest, res) => {
  const { id, name, category, color, mime, imageBase64 } = req.body || {};
  if (!id || !CATEGORIES.has(category) || !imageBase64)
    return bad(res, 400, "Missing item fields.");
  try {
    await pool.execute(
      `INSERT INTO items (id, user_id, name, category, color, mime, image, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.userId!,
        String(name || ""),
        category,
        color || null,
        mime || "image/jpeg",
        Buffer.from(imageBase64, "base64"),
        Date.now(),
      ]
    );
    res.json({ id, imageUrl: `/img/item/${id}` });
  } catch (err) {
    console.error(err);
    bad(res, 500, "Could not save the item.");
  }
});

app.delete("/items/:id", requireAuth, async (req: AuthedRequest, res) => {
  await pool.execute("DELETE FROM items WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.userId!,
  ]);
  res.json({ ok: true });
});

// --- Models (photos of you) -------------------------------------------
app.get("/models", requireAuth, async (req: AuthedRequest, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, name, created_at FROM models WHERE user_id = ? ORDER BY created_at DESC",
    [req.userId!]
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: Number(r.created_at),
      imageUrl: `/img/model/${r.id}`,
    }))
  );
});

app.post("/models", requireAuth, async (req: AuthedRequest, res) => {
  const { id, name, mime, imageBase64 } = req.body || {};
  if (!id || !imageBase64) return bad(res, 400, "Missing photo fields.");
  try {
    await pool.execute(
      `INSERT INTO models (id, user_id, name, mime, image, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.userId!,
        String(name || ""),
        mime || "image/png",
        Buffer.from(imageBase64, "base64"),
        Date.now(),
      ]
    );
    res.json({ id, imageUrl: `/img/model/${id}` });
  } catch (err) {
    console.error(err);
    bad(res, 500, "Could not save the photo.");
  }
});

app.delete("/models/:id", requireAuth, async (req: AuthedRequest, res) => {
  await pool.execute("DELETE FROM models WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.userId!,
  ]);
  res.json({ ok: true });
});

// --- Looks ------------------------------------------------------------
app.get("/looks", requireAuth, async (req: AuthedRequest, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, name, model_id, item_ids, created_at FROM looks WHERE user_id = ? ORDER BY created_at DESC",
    [req.userId!]
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      modelId: r.model_id || undefined,
      itemIds:
        typeof r.item_ids === "string" ? JSON.parse(r.item_ids) : r.item_ids,
      createdAt: Number(r.created_at),
      imageUrl: `/img/look/${r.id}`,
    }))
  );
});

app.post("/looks", requireAuth, async (req: AuthedRequest, res) => {
  const { id, name, modelId, itemIds, mime, imageBase64 } = req.body || {};
  if (!id || !imageBase64) return bad(res, 400, "Missing look fields.");
  // Guard against dangling references to another user's rows.
  if (modelId && !(await ownsRow("model", modelId, req.userId!)))
    return bad(res, 400, "Unknown model.");
  try {
    await pool.execute(
      `INSERT INTO looks (id, user_id, name, model_id, item_ids, mime, image, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.userId!,
        String(name || ""),
        modelId || null,
        JSON.stringify(Array.isArray(itemIds) ? itemIds : []),
        mime || "image/png",
        Buffer.from(imageBase64, "base64"),
        Date.now(),
      ]
    );
    res.json({ id, imageUrl: `/img/look/${id}` });
  } catch (err) {
    console.error(err);
    bad(res, 500, "Could not save the look.");
  }
});

app.delete("/looks/:id", requireAuth, async (req: AuthedRequest, res) => {
  await pool.execute("DELETE FROM looks WHERE id = ? AND user_id = ?", [
    req.params.id,
    req.userId!,
  ]);
  res.json({ ok: true });
});

const port = Number(process.env.PORT || 8080);
initSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`Digital Wardrobe API listening on :${port}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialise database schema:", err);
    process.exit(1);
  });
