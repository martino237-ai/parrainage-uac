-- MySQL 8+. En local : CREATE DATABASE parrainage_uac CHARACTER SET utf8mb4; USE parrainage_uac;
-- Sur Aiven : la base "defaultdb" existe déjà, importer directement ce fichier.

CREATE TABLE IF NOT EXISTS campagne (
  id TINYINT PRIMARY KEY,
  annee VARCHAR(9) NOT NULL,
  phase ENUM('inscriptions','closes','pointage','ceremonie','termine') NOT NULL DEFAULT 'inscriptions',
  capacite_parrain TINYINT NOT NULL DEFAULT 1,
  meme_filiere TINYINT(1) NOT NULL DEFAULT 0,
  niveau_superieur TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT chk_capacite CHECK (capacite_parrain BETWEEN 1 AND 5)
) ENGINE=InnoDB;
INSERT IGNORE INTO campagne (id, annee) VALUES (1, '2026-2027');

CREATE TABLE IF NOT EXISTS participants (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role ENUM('parrain','filleul') NOT NULL,
  nom VARCHAR(80) NOT NULL,
  matricule VARCHAR(20) NOT NULL,
  filiere VARCHAR(80) NOT NULL,
  niveau ENUM('L1','L2','L3','M1','M2') NOT NULL,
  telephone VARCHAR(20) NOT NULL,
  photo MEDIUMBLOB NOT NULL,
  photo_mime VARCHAR(20) NOT NULL,
  dossier ENUM('en_attente','valide','rejete') NOT NULL DEFAULT 'en_attente',
  motif_rejet VARCHAR(500) NULL,
  present TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_matricule (matricule),
  KEY idx_tirage (role, dossier, present),
  CONSTRAINT chk_present CHECK (present = 0 OR dossier = 'valide')
) ENGINE=InnoDB;

-- Contient uniquement les couples actifs. UNIQUE(filleul_id) : un filleul n'a jamais deux parrains.
CREATE TABLE IF NOT EXISTS couples (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parrain_id INT NOT NULL,
  filleul_id INT NOT NULL,
  statut ENUM('propose','suspendu','valide') NOT NULL DEFAULT 'propose',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  validated_at TIMESTAMP NULL,
  UNIQUE KEY uq_filleul (filleul_id),
  KEY idx_parrain (parrain_id),
  FOREIGN KEY (parrain_id) REFERENCES participants(id),
  FOREIGN KEY (filleul_id) REFERENCES participants(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tirages_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  action VARCHAR(30) NOT NULL,
  parrain_id INT NULL,
  filleul_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS admins (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(40) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit_log (
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
) ENGINE=InnoDB;
