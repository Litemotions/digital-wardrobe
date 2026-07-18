// When running as a Home Assistant add-on, options from the add-on UI are
// written to /data/options.json rather than env vars. Load them here (before
// anything reads process.env) so the rest of the server is unchanged.
import { existsSync, readFileSync } from "node:fs";

const OPTIONS_PATH = "/data/options.json";
const MAP: Record<string, string> = {
  db_host: "DB_HOST",
  db_port: "DB_PORT",
  db_name: "DB_NAME",
  db_user: "DB_USER",
  db_password: "DB_PASSWORD",
  jwt_secret: "JWT_SECRET",
  allowed_origins: "ALLOWED_ORIGINS",
  app_url: "APP_URL",
  admin_email: "ADMIN_EMAIL",
  smtp_host: "SMTP_HOST",
  smtp_port: "SMTP_PORT",
  smtp_user: "SMTP_USER",
  smtp_password: "SMTP_PASSWORD",
  smtp_from: "SMTP_FROM",
};

if (existsSync(OPTIONS_PATH)) {
  try {
    const opts = JSON.parse(readFileSync(OPTIONS_PATH, "utf8"));
    for (const [key, envName] of Object.entries(MAP)) {
      const val = opts[key];
      if (val !== undefined && val !== null && String(val) !== "") {
        process.env[envName] = String(val);
      }
    }
    console.log("Loaded configuration from Home Assistant add-on options.");
  } catch (err) {
    console.warn("Could not parse /data/options.json:", err);
  }
}
