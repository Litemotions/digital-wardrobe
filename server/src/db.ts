import mysql from "mysql2/promise";

export const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "wardrobe",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "wardrobe",
  waitForConnections: true,
  connectionLimit: 5,
});

// Create tables on first boot. Safe to run every start.
export async function initSchema(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          CHAR(36) PRIMARY KEY,
        email       VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        created_at  BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS items (
        id         CHAR(36) PRIMARY KEY,
        user_id    CHAR(36) NOT NULL,
        name       VARCHAR(255) NOT NULL DEFAULT '',
        category   VARCHAR(32) NOT NULL,
        color      VARCHAR(64) NULL,
        mime       VARCHAR(64) NOT NULL,
        image      LONGBLOB NOT NULL,
        created_at BIGINT NOT NULL,
        INDEX (user_id),
        CONSTRAINT fk_items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS models (
        id         CHAR(36) PRIMARY KEY,
        user_id    CHAR(36) NOT NULL,
        name       VARCHAR(255) NOT NULL DEFAULT '',
        mime       VARCHAR(64) NOT NULL,
        image      LONGBLOB NOT NULL,
        created_at BIGINT NOT NULL,
        INDEX (user_id),
        CONSTRAINT fk_models_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS looks (
        id         CHAR(36) PRIMARY KEY,
        user_id    CHAR(36) NOT NULL,
        name       VARCHAR(255) NOT NULL DEFAULT '',
        model_id   CHAR(36) NULL,
        item_ids   JSON NOT NULL,
        mime       VARCHAR(64) NOT NULL,
        image      LONGBLOB NOT NULL,
        created_at BIGINT NOT NULL,
        INDEX (user_id),
        CONSTRAINT fk_looks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } finally {
    conn.release();
  }
}
