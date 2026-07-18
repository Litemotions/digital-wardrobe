import type { NextFunction, Request, Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { RowDataPacket } from "mysql2";
import { pool } from "./db.js";

const SECRET = process.env.JWT_SECRET || "";
if (!SECRET) {
  console.warn(
    "[warn] JWT_SECRET is not set — using an insecure default. Set a long random JWT_SECRET."
  );
}
const EFFECTIVE_SECRET = SECRET || "insecure-dev-secret";

export function signToken(userId: string): string {
  return jwt.sign({ uid: userId }, EFFECTIVE_SECRET, { expiresIn: "30d" });
}

// Magic-link tokens: return the raw token (goes in the email link) and its
// hash (stored in the DB). We never store the raw token.
export function makeMagicToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  return { raw, hash: hashToken(raw) };
}
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export interface AuthedRequest extends Request {
  userId?: string;
}

export function requireAuth(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  const token = bearer || (req.query.token as string | undefined);
  if (!token) {
    res.status(401).json({ error: "Not signed in." });
    return;
  }
  try {
    const payload = jwt.verify(token, EFFECTIVE_SECRET) as { uid: string };
    req.userId = payload.uid;
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please sign in again." });
  }
}

export async function isAdminUser(userId: string): Promise<boolean> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    `SELECT ae.is_admin FROM allowed_emails ae
     JOIN users u ON u.email = ae.email
     WHERE u.id = ?`,
    [userId]
  );
  return rows.length > 0 && !!rows[0].is_admin;
}

export function requireAdmin(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
) {
  requireAuth(req, res, async () => {
    if (await isAdminUser(req.userId!)) return next();
    res.status(403).json({ error: "Admins only." });
  });
}
