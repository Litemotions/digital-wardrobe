import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const SECRET = process.env.JWT_SECRET || "";
if (!SECRET) {
  console.warn(
    "[warn] JWT_SECRET is not set — using an insecure default. Set a long random JWT_SECRET in production."
  );
}
const EFFECTIVE_SECRET = SECRET || "insecure-dev-secret";

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
export function checkPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}
export function signToken(userId: string): string {
  return jwt.sign({ uid: userId }, EFFECTIVE_SECRET, { expiresIn: "30d" });
}

export interface AuthedRequest extends Request {
  userId?: string;
}

// Accept the token from the Authorization header (normal API calls) or from a
// ?token= query param (used by <img> tags, which can't send headers).
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
