-- ════════════════════════════════════════════════════════════════════
-- Migration du 2026-11-04 — AccesFinance
--   1. Plateforme (MOBILE / WEB) des sessions et des connexions
--      → statistiques admin « utilisateurs mobiles et internet »
--   2. Normalisation de users.platform (plateforme d'inscription)
--   3. Tokens de notification : copie de devices.deviceId → devices.pushToken
--
-- À exécuter UNE fois sur la base netbacking_db (MySQL / phpMyAdmin).
-- Le backend fonctionne aussi sans cette migration : la plateforme des
-- connexions ne sera simplement pas enregistrée.
-- ════════════════════════════════════════════════════════════════════

-- 1. Plateforme des sessions et de l'historique de connexion
ALTER TABLE `sessions`      ADD COLUMN `platform` VARCHAR(20) NULL;
ALTER TABLE `login_history` ADD COLUMN `platform` VARCHAR(20) NULL;
CREATE INDEX `idx_sessions_platform`      ON `sessions` (`platform`);
CREATE INDEX `idx_login_history_platform` ON `login_history` (`platform`);

-- 2. Plateforme d'inscription : valeurs harmonisées
UPDATE `users` SET `platform` = 'MOBILE'
 WHERE UPPER(`platform`) IN ('MOBILE', 'MOBILE_APP', 'APP', 'ANDROID', 'IOS', 'IPHONE');
UPDATE `users` SET `platform` = 'WEB'
 WHERE UPPER(`platform`) IN ('WEB', 'ONLINE', 'BROWSER', 'DESKTOP', 'INTERNET');

-- 3. Tokens FCM enregistrés dans deviceId (ancienne version) → pushToken
UPDATE `devices`
   SET `pushToken` = `deviceId`, `isActive` = 1
 WHERE `pushToken` IS NULL
   AND CHAR_LENGTH(`deviceId`) > 100
   AND `deviceId` LIKE '%:%';

-- 4. Anciennes notifications : type métier invalide (doit être EMAIL/SMS/PUSH/IN_APP)
UPDATE `notifications` SET `type` = 'PUSH'
 WHERE `type` NOT IN ('EMAIL', 'SMS', 'PUSH', 'IN_APP');
