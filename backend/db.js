require('dotenv').config();

const usePostgres = !!(process.env.DB_DRIVER === 'postgres' || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);

function buildPgResult(sql, result) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const fields = Array.isArray(result?.fields) ? result.fields : [];
  const hasInsertId = /\s*INSERT\s+INTO\s+/i.test(sql);
  const insertId = hasInsertId && rows[0] && typeof rows[0].id !== 'undefined' ? Number(rows[0].id) : undefined;
  const payload = hasInsertId ? { rowCount: result.rowCount ?? 0, affectedRows: result.rowCount ?? 0, insertId, rows } : rows;
  return [payload, fields];
}

function normalizeQuery(sql, params = []) {
  let normalizedSql = sql;
  if (/^\s*INSERT\s+INTO\s+/i.test(normalizedSql) && !/RETURNING\b/i.test(normalizedSql)) {
    normalizedSql += ' RETURNING id';
  }
  if (!params || params.length === 0) return { text: normalizedSql, values: [] };
  let index = 0;
  const text = normalizedSql.replace(/\?/g, () => `$${++index}`);
  return { text, values: params };
}

if (usePostgres) {
  const { Pool } = require('pg');
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || process.env.PG_DATABASE_URL;

  if (!connectionString) {
    throw new Error('DATABASE_URL or SUPABASE_DB_URL is required when DB_DRIVER=postgres.');
  }

  const pool = new Pool({
    connectionString,
    ssl: process.env.DB_SSL === 'true' || process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  });

  module.exports = {
    async query(sql, params = []) {
      const { text, values } = normalizeQuery(sql, params);
      const result = await pool.query(text, values);
      return buildPgResult(sql, result);
    },
    async getConnection() {
      const client = await pool.connect();
      return {
        async query(sql, params = []) {
          const { text, values } = normalizeQuery(sql, params);
          const result = await client.query(text, values);
          return buildPgResult(sql, result);
        },
        async beginTransaction() { await client.query('BEGIN'); },
        async commit() { await client.query('COMMIT'); },
        async rollback() { await client.query('ROLLBACK'); },
        release() { client.release(); }
      };
    },
    end() {
      return pool.end();
    }
  };
} else {
  const mysql = require('mysql2/promise');
  module.exports = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'parrainage_uac',
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 5,
    dateStrings: true,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
  });
}
