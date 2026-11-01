-- ════════════════════════════════════════════════════════════════════
-- Migration du 2026-10-23
--   1. Approbation des comptes + mot de passe temporaire (table users)
--   2. Chéquiers rattachés au NUMÉRO de compte bancaire (API externe)
--      au lieu de la table locale `accounts`
--
-- Option A (recommandée) : exécuter ce script, puis `npx prisma generate`.
-- Option B : `npx prisma db push`, puis exécuter UNIQUEMENT la section 3 (backfill).
-- ════════════════════════════════════════════════════════════════════

-- 1. USERS : approbation & mot de passe temporaire
ALTER TABLE `users`
  ADD COLUMN `mustChangePassword`    TINYINT(1)  NULL DEFAULT 0,
  ADD COLUMN `tempPasswordExpiresAt` DATETIME(0) NULL,
  ADD COLUMN `approvedAt`            DATETIME(0) NULL,
  ADD COLUMN `approvedBy`            VARCHAR(36) NULL,
  ADD COLUMN `rejectedAt`            DATETIME(0) NULL,
  ADD COLUMN `rejectedBy`            VARCHAR(36) NULL,
  ADD COLUMN `rejectionReason`       TEXT        NULL;

CREATE INDEX `idx_users_mustChangePassword` ON `users` (`mustChangePassword`);

-- Les comptes déjà actifs sont considérés comme approuvés
UPDATE `users`
   SET `approvedAt` = COALESCE(`createdAt`, NOW())
 WHERE `status` = 'ACTIVE' AND `approvedAt` IS NULL;

-- 2. CHECKBOOKS : détachement de la table locale `accounts`
ALTER TABLE `checkbooks` DROP FOREIGN KEY `checkbooks_ibfk_1`;

ALTER TABLE `checkbooks`
  MODIFY COLUMN `accountId` VARCHAR(36) NULL,
  ADD COLUMN `accountNumber` VARCHAR(50) NULL AFTER `accountId`,
  ADD COLUMN `clientId`      VARCHAR(50) NULL AFTER `accountNumber`;

CREATE INDEX `idx_checkbook_accountNumber` ON `checkbooks` (`accountNumber`);

-- 3. BACKFILL : numéro de compte des chéquiers existants
UPDATE `checkbooks` c
  JOIN `accounts` a ON a.`id` = c.`accountId`
   SET c.`accountNumber` = TRIM(a.`accountNumber`),
       c.`clientId`      = a.`clientId`
 WHERE c.`accountNumber` IS NULL;
