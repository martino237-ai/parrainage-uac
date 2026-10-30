require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');
(async () => {
  const u = process.env.ADMIN_USER, p = process.env.ADMIN_PASSWORD;
  if (!u || !p || p.length < 8) { console.error('ADMIN_USER et ADMIN_PASSWORD (8 caractères min.) requis dans .env'); process.exit(1); }
  const h = await bcrypt.hash(p, 10);
  const isPg = !!(process.env.DB_DRIVER === 'postgres' || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);
  if (isPg) {
    await pool.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash', [u, h]);
  } else {
    await pool.query('INSERT INTO admins (username, password_hash) VALUES (?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)', [u, h]);
  }
  console.log('Admin prêt :', u);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
