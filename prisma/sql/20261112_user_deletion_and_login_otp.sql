-- ════════════════════════════════════════════════════════════════════
-- Migration du 2026-11-12 — AccesFinance
--   1. Suppression DÉFINITIVE des utilisateurs avec conservation de l'historique :
--      audit_logs.userId, activity_logs.userId, transfers.initiatedBy
--      → colonnes facultatives + ON DELETE SET NULL
--   2. OTP de connexion Web : tables trusted_devices et login_otp_challenges
--
-- Les services font ces modifications automatiquement au démarrage
-- (AUTO_DB_SCHEMA_UPDATES=true). Ce script sert si l'utilisateur MySQL
-- n'a pas les droits ALTER / CREATE. Aucune donnée n'est supprimée.
-- À lancer avec : mysql -u admin -p --force netbacking_db < ce_fichier.sql
-- (« Can't DROP » / « Duplicate » = déjà fait, à ignorer)
-- ════════════════════════════════════════════════════════════════════

-- 1. Historique conservé à la suppression d'un utilisateur
ALTER TABLE `audit_logs` DROP FOREIGN KEY `audit_logs_ibfk_1`;
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_ibfk_1` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE `activity_logs` DROP FOREIGN KEY `activity_logs_ibfk_1`;
ALTER TABLE `activity_logs` MODIFY `userId` VARCHAR(36) NULL;
ALTER TABLE `activity_logs` ADD CONSTRAINT `activity_logs_ibfk_1` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

ALTER TABLE `transfers` DROP FOREIGN KEY `transfers_ibfk_3`;
ALTER TABLE `transfers` MODIFY `initiatedBy` VARCHAR(36) NULL;
ALTER TABLE `transfers` ADD CONSTRAINT `transfers_ibfk_3` FOREIGN KEY (`initiatedBy`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- 2. OTP de connexion Web
CREATE TABLE IF NOT EXISTS `trusted_devices` (
  `id`          VARCHAR(36)  NOT NULL,
  `userId`      VARCHAR(36)  NOT NULL,
  `deviceKey`   VARCHAR(64)  NOT NULL,
  `ipAddress`   VARCHAR(45)  NOT NULL,
  `deviceName`  VARCHAR(100) NULL,
  `userAgent`   TEXT         NULL,
  `platform`    VARCHAR(20)  NULL,
  `createdAt`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `lastUsedAt`  DATETIME     NULL,
  `expiresAt`   DATETIME     NOT NULL,
  `revokedAt`   DATETIME     NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_trusted_device` (`userId`, `deviceKey`, `ipAddress`),
  KEY `idx_trusted_devices_userId` (`userId`),
  CONSTRAINT `trusted_devices_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS `login_otp_challenges` (
  `id`          VARCHAR(36)  NOT NULL,
  `userId`      VARCHAR(36)  NOT NULL,
  `codeHash`    VARCHAR(64)  NOT NULL,
  `reason`      VARCHAR(30)  NULL,
  `channels`    VARCHAR(30)  NULL,
  `deviceKey`   VARCHAR(64)  NOT NULL,
  `ipAddress`   VARCHAR(45)  NULL,
  `userAgent`   TEXT         NULL,
  `platform`    VARCHAR(20)  NULL,
  `rememberMe`  TINYINT(1)   NOT NULL DEFAULT 0,
  `attempts`    INT          NOT NULL DEFAULT 0,
  `sendCount`   INT          NOT NULL DEFAULT 1,
  `lastSentAt`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expiresAt`   DATETIME     NOT NULL,
  `consumedAt`  DATETIME     NULL,
  `createdAt`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_login_otp_userId` (`userId`),
  KEY `idx_login_otp_createdAt` (`createdAt`),
  CONSTRAINT `login_otp_challenges_user_fk` FOREIGN KEY (`userId`) REFERENCES `users` (`id`) ON DELETE CASCADE
);
