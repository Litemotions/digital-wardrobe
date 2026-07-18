import "./haOptions.js"; // must run first: maps HA add-on options -> env
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import type { Response } from "express";
import type { RowDataPacket } from "mysql2";
import { pool, initSchema } from "./db.js";
import {
  hashPassword,
  checkPassword,
  signToken,
  requireAuth,
  type AuthedRequest,
} from "./auth.js";

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

// --- Auth -------------------------------------------------------------
app.post("/auth/register", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !email.includes("@")) return bad(res, 400, "Enter a valid email.");
  if (password.length < 8)
    return bad(res, 400, "Password must be at least 8 characters.");
  try {
    const [existing] = await pool.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = ?",
      [email]
    );
    if (existing.length) return bad(res, 409, "That email is already registered.");
    const id = randomUUID();
    await pool.execute(
      "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
      [id, email, await hashPassword(password), Date.now()]
    );
    res.json({ token: signToken(id), user: { id, email } });
  } catch (err) {
    console.error(err);
    bad(res, 500, "Could not create the account.");
  }
});

app.post("/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  try {
    const [rows] = await pool.execute<RowDataPacket[]>(
      "SELECT id, password_hash FROM users WHERE email = ?",
      [email]
    );
    const user = rows[0];
    if (!user || !(await checkPassword(password, user.password_hash)))
      return bad(res, 401, "Wrong email or password.");
    res.json({ token: signToken(user.id), user: { id: user.id, email } });
  } catch (err) {
    console.error(err);
    bad(res, 500, "Could not sign in.");
  }
});

app.get("/auth/me", requireAuth, async (req: AuthedRequest, res) => {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT id, email FROM users WHERE id = ?",
    [req.userId!]
  );
  if (!rows.length) return bad(res, 404, "User not found.");
  res.json({ user: { id: rows[0].id, email: rows[0].email } });
});

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
