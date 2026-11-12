// libs/common/src/db/ensure-schema.ts
/**
 * ═══════════════════════════════════════════════════════════════════
 * MISES À JOUR DE STRUCTURE APPLIQUÉES AU DÉMARRAGE (idempotentes)
 * ═══════════════════════════════════════════════════════════════════
 *  1. Suppression définitive des utilisateurs : l'historique est CONSERVÉ
 *     audit_logs.userId, activity_logs.userId, transfers.initiatedBy
 *     → colonnes facultatives + clé étrangère ON DELETE SET NULL
 *  2. OTP de connexion Web : tables trusted_devices et login_otp_challenges
 *
 * Équivalent manuel : prisma/sql/20261112_user_deletion_and_login_otp.sql
 * Désactivable : AUTO_DB_SCHEMA_UPDATES=false
 * Aucune donnée existante n'est supprimée ni modifiée.
 * ═══════════════════════════════════════════════════════════════════
 */
import { Logger } from '@nestjs/common';

const logger = new Logger('Schema');

/** Références historiques à conserver quand un utilisateur est supprimé. */
const KEEP_HISTORY_FKS: Array<{ table: string; column: string; defaultName: string }> = [
  { table: 'audit_logs', column: 'userId', defaultName: 'audit_logs_ibfk_1' },
  { table: 'activity_logs', column: 'userId', defaultName: 'activity_logs_ibfk_1' },
  { table: 'transfers', column: 'initiatedBy', defaultName: 'transfers_ibfk_3' },
];

async function usersIdCharset(prisma: any): Promise<{ charset: string; collation: string }> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'id'`,
  );
  return { charset: rows?.[0]?.cs || 'utf8mb4', collation: rows?.[0]?.coll || 'utf8mb4_unicode_ci' };
}

export async function ensureUserDeletionConstraints(prisma: any, serviceName = 'service'): Promise<void> {
  for (const fk of KEEP_HISTORY_FKS) {
    try {
      const cols: any[] = await prisma.$queryRawUnsafe(
        `SELECT IS_NULLABLE AS nullable, COLUMN_TYPE AS type, CHARACTER_SET_NAME AS cs, COLLATION_NAME AS coll
           FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        fk.table, fk.column,
      );
      if (!cols.length) continue; // table absente

      const constraints: any[] = await prisma.$queryRawUnsafe(
        `SELECT kcu.CONSTRAINT_NAME AS name, rc.DELETE_RULE AS rule
           FROM information_schema.KEY_COLUMN_USAGE kcu
           JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
             ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          WHERE kcu.TABLE_SCHEMA = DATABASE() AND kcu.TABLE_NAME = ? AND kcu.COLUMN_NAME = ?
            AND kcu.REFERENCED_TABLE_NAME = 'users'`,
        fk.table, fk.column,
      );
      const current = constraints[0];
      const nullable = String(cols[0].nullable).toUpperCase() === 'YES';
      if (nullable && current && String(current.rule).toUpperCase() === 'SET NULL') continue; // déjà à jour

      const name = current?.name || fk.defaultName;
      if (current) await prisma.$executeRawUnsafe(`ALTER TABLE \`${fk.table}\` DROP FOREIGN KEY \`${name}\``);
      if (!nullable) {
        const charset = cols[0].cs ? ` CHARACTER SET ${cols[0].cs} COLLATE ${cols[0].coll}` : '';
        await prisma.$executeRawUnsafe(
          `ALTER TABLE \`${fk.table}\` MODIFY \`${fk.column}\` ${cols[0].type}${charset} NULL`,
        );
      }
      await prisma.$executeRawUnsafe(
        `ALTER TABLE \`${fk.table}\` ADD CONSTRAINT \`${name}\` FOREIGN KEY (\`${fk.column}\`)
           REFERENCES \`users\` (\`id\`) ON DELETE SET NULL ON UPDATE RESTRICT`,
      );
      logger.log(`[${serviceName}] ${fk.table}.${fk.column} : historique conservé à la suppression d'un utilisateur (SET NULL)`);
    } catch (err) {
      logger.error(
        `[${serviceName}] Mise à jour de ${fk.table}.${fk.column} impossible (${(err as any)?.message || err}). ` +
        'Exécutez prisma/sql/20261112_user_deletion_and_login_otp.sql dans MySQL.',
      );
    }
  }
}

export async function ensureLoginOtpTables(prisma: any, serviceName = 'service'): Promise<void> {
  try {
    const { charset, collation } = await usersIdCharset(prisma);
    const tableOpts = `ENGINE=InnoDB DEFAULT CHARSET=${charset} COLLATE=${collation}`;

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS \`trusted_devices\` (
        \`id\`          VARCHAR(36)  NOT NULL,
        \`userId\`      VARCHAR(36)  NOT NULL,
        \`deviceKey\`   VARCHAR(64)  NOT NULL,
        \`ipAddress\`   VARCHAR(45)  NOT NULL,
        \`deviceName\`  VARCHAR(100) NULL,
        \`userAgent\`   TEXT         NULL,
        \`platform\`    VARCHAR(20)  NULL,
        \`createdAt\`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`lastUsedAt\`  DATETIME     NULL,
        \`expiresAt\`   DATETIME     NOT NULL,
        \`revokedAt\`   DATETIME     NULL,
        PRIMARY KEY (\`id\`),
        UNIQUE KEY \`uk_trusted_device\` (\`userId\`, \`deviceKey\`, \`ipAddress\`),
        KEY \`idx_trusted_devices_userId\` (\`userId\`),
        CONSTRAINT \`trusted_devices_user_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ${tableOpts}`);

    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS \`login_otp_challenges\` (
        \`id\`          VARCHAR(36)  NOT NULL,
        \`userId\`      VARCHAR(36)  NOT NULL,
        \`codeHash\`    VARCHAR(64)  NOT NULL,
        \`reason\`      VARCHAR(30)  NULL,
        \`channels\`    VARCHAR(30)  NULL,
        \`deviceKey\`   VARCHAR(64)  NOT NULL,
        \`ipAddress\`   VARCHAR(45)  NULL,
        \`userAgent\`   TEXT         NULL,
        \`platform\`    VARCHAR(20)  NULL,
        \`rememberMe\`  TINYINT(1)   NOT NULL DEFAULT 0,
        \`attempts\`    INT          NOT NULL DEFAULT 0,
        \`sendCount\`   INT          NOT NULL DEFAULT 1,
        \`lastSentAt\`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`expiresAt\`   DATETIME     NOT NULL,
        \`consumedAt\`  DATETIME     NULL,
        \`createdAt\`   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (\`id\`),
        KEY \`idx_login_otp_userId\` (\`userId\`),
        KEY \`idx_login_otp_createdAt\` (\`createdAt\`),
        CONSTRAINT \`login_otp_challenges_user_fk\` FOREIGN KEY (\`userId\`) REFERENCES \`users\` (\`id\`) ON DELETE CASCADE
      ) ${tableOpts}`);
  } catch (err) {
    logger.error(
      `[${serviceName}] Tables de l'OTP de connexion non créées (${(err as any)?.message || err}). ` +
      'Exécutez prisma/sql/20261112_user_deletion_and_login_otp.sql dans MySQL.',
    );
  }
}

/** Toutes les mises à jour de structure (appelé au démarrage des services). */
export async function ensureSchemaUpdates(prisma: any, serviceName = 'service'): Promise<void> {
  if (String(process.env.AUTO_DB_SCHEMA_UPDATES ?? 'true').toLowerCase() === 'false') return;
  await ensureUserDeletionConstraints(prisma, serviceName);
  await ensureLoginOtpTables(prisma, serviceName);
}
