-- ════════════════════════════════════════════════════════════════════
-- Migration du 2026-11-11 — AccesFinance : traçabilité appareil + plateforme
--   audit_logs    : plateforme, type/nom d'appareil, OS, navigateur, id appareil, version app
--   login_history : (plateforme déjà ajoutée le 2026-11-04) + appareil, OS, navigateur
--   sessions      : (plateforme déjà ajoutée le 2026-11-04) + type d'appareil, version app
--
-- Les services ajoutent aussi ces colonnes automatiquement au démarrage
-- (AUTO_DB_TRACKING_COLUMNS=true par défaut). Ce script sert si l'utilisateur
-- MySQL de l'application n'a pas le droit ALTER.
-- À exécuter UNE fois sur netbacking_db. Aucune donnée existante n'est modifiée.
-- (Si une colonne existe déjà, MySQL affiche « Duplicate column » : ignorer.)
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE `audit_logs` ADD COLUMN `platform`   VARCHAR(20)  NULL;
ALTER TABLE `audit_logs` ADD COLUMN `deviceType` VARCHAR(20)  NULL;
ALTER TABLE `audit_logs` ADD COLUMN `deviceName` VARCHAR(100) NULL;
ALTER TABLE `audit_logs` ADD COLUMN `os`         VARCHAR(50)  NULL;
ALTER TABLE `audit_logs` ADD COLUMN `browser`    VARCHAR(60)  NULL;
ALTER TABLE `audit_logs` ADD COLUMN `deviceId`   VARCHAR(255) NULL;
ALTER TABLE `audit_logs` ADD COLUMN `appVersion` VARCHAR(30)  NULL;
CREATE INDEX `idx_audit_logs_platform` ON `audit_logs` (`platform`);

-- login_history.platform existe si la migration du 2026-11-04 a été appliquée
ALTER TABLE `login_history` ADD COLUMN `platform`   VARCHAR(20)  NULL;
ALTER TABLE `login_history` ADD COLUMN `deviceType` VARCHAR(20)  NULL;
ALTER TABLE `login_history` ADD COLUMN `deviceName` VARCHAR(100) NULL;
ALTER TABLE `login_history` ADD COLUMN `os`         VARCHAR(50)  NULL;
ALTER TABLE `login_history` ADD COLUMN `browser`    VARCHAR(60)  NULL;

ALTER TABLE `sessions` ADD COLUMN `platform`   VARCHAR(20) NULL;
ALTER TABLE `sessions` ADD COLUMN `deviceType` VARCHAR(20) NULL;
ALTER TABLE `sessions` ADD COLUMN `appVersion` VARCHAR(30) NULL;
