require('dotenv').config();
const pool = require('./db');

async function ensureColumn(table, column, definition) {
  const [[found]] = await pool.query(
    'SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  if (!found.n) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function ensureSchema() {
  await ensureColumn('participants', 'motif_rejet', 'VARCHAR(500) NULL AFTER dossier');
  await ensureColumn('participants', 'updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER created_at');
  await pool.query(`ALTER TABLE couples MODIFY COLUMN statut ENUM('propose','suspendu','valide') NOT NULL DEFAULT 'propose'`);
  await pool.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    actor_id INT NULL,
    action VARCHAR(60) NOT NULL,
    entity_type VARCHAR(40) NOT NULL,
    entity_id INT NULL,
    reason VARCHAR(500) NULL,
    details JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_audit_created (created_at),
    KEY idx_audit_entity (entity_type, entity_id),
    KEY idx_audit_actor (actor_id),
    CONSTRAINT fk_audit_actor FOREIGN KEY (actor_id) REFERENCES admins(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`);
}

module.exports = { ensureSchema };

if (require.main === module) {
  ensureSchema()
    .then(() => console.log('Schéma vérifié et migrations appliquées.'))
    .catch(error => {
      console.error('Échec de la migration :', error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
