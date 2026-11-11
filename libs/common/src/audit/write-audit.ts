// libs/common/src/audit/write-audit.ts
/**
 * ═══════════════════════════════════════════════════════════════════
 * ÉCRITURE DES AUDITS AVEC APPAREIL + PLATEFORME
 * ═══════════════════════════════════════════════════════════════════
 * writeAudit(prisma, { data }) remplace prisma.auditLog.create({ data }) :
 * même paramètre, même résultat, mais complète automatiquement
 *   ipAddress, userAgent, platform (MOBILE / WEB / BACK_OFFICE / SYSTEM…),
 *   deviceType, deviceName, os, browser, deviceId, appVersion
 * à partir du contexte de la requête (voir context/request-context.ts).
 *
 * Les valeurs déjà fournies par l'appelant ne sont jamais écrasées.
 * Si les colonnes n'existent pas encore (migration non appliquée),
 * l'audit est quand même enregistré sans ces informations.
 * ═══════════════════════════════════════════════════════════════════
 */
import { Logger } from '@nestjs/common';
import { getRequestContext, RequestContext } from '../context/request-context';
import { resolveChannel } from '../utils/platform.util';

const logger = new Logger('Audit');
let trackingColumnsMissing = false;

/** Plateforme de la requête en cours (résolue une seule fois par requête). */
export async function currentPlatform(ctx: Partial<RequestContext> = getRequestContext()): Promise<string> {
  if (!ctx || !Object.keys(ctx).length) return 'SYSTEM'; // tâche interne, pas de requête utilisateur
  if (ctx.platform) return ctx.platform;
  const p = await resolveChannel({
    client: ctx.client,
    platform: ctx.declaredPlatform,
    token: ctx.token,
    userAgent: ctx.userAgent,
  });
  const resolved = p === 'UNKNOWN' && ctx.deviceType === 'API_CLIENT' ? 'API' : p;
  try { ctx.platform = resolved; } catch { /* contexte figé */ }
  return resolved;
}

/** Champs appareil + plateforme à ajouter à une ligne (audit_logs, login_history…). */
export async function deviceFields(ctx: Partial<RequestContext> = getRequestContext()) {
  return {
    platform: await currentPlatform(ctx),
    deviceType: ctx.deviceType || null,
    deviceName: ctx.deviceName || null,
    os: ctx.os || null,
    browser: ctx.browser || null,
    deviceId: ctx.deviceId || null,
    appVersion: ctx.appVersion || null,
  };
}

function isMissingColumnError(err: any): boolean {
  const msg = String(err?.message || err);
  return /Unknown (column|argument)|does not exist in the current database|column .* does not exist|Unknown arg/i.test(msg);
}

export async function writeAudit(prisma: any, args: { data: any; [k: string]: any }): Promise<any> {
  const ctx = getRequestContext();
  const base = { ...(args?.data || {}) };
  if (!base.ipAddress && ctx.ipAddress) base.ipAddress = ctx.ipAddress;
  if (!base.userAgent && ctx.userAgent) base.userAgent = ctx.userAgent;
  // Rôle de l'auteur quand l'audit concerne l'utilisateur connecté
  if (!base.userRole && ctx.userRole && (!base.userId || base.userId === ctx.userId)) base.userRole = ctx.userRole;

  if (!trackingColumnsMissing) {
    try {
      const extra = await deviceFields(ctx);
      const data = { ...base };
      for (const [k, v] of Object.entries(extra)) {
        if ((data[k] === undefined || data[k] === null) && v !== null) data[k] = v;
      }
      return await prisma.auditLog.create({ ...args, data });
    } catch (err) {
      if (!isMissingColumnError(err)) throw err;
      trackingColumnsMissing = true;
      logger.warn(
        'Colonnes appareil/plateforme absentes dans audit_logs : exécutez prisma/sql/20261111_device_tracking.sql. ' +
        'Les audits sont enregistrés sans ces informations en attendant.',
      );
    }
  }
  for (const k of ['platform', 'deviceType', 'deviceName', 'os', 'browser', 'deviceId', 'appVersion']) delete base[k];
  return prisma.auditLog.create({ ...args, data: base });
}

// ─────────────────────────── colonnes ───────────────────────────

const TRACKING_COLUMNS: Array<{ table: string; column: string; ddl: string; index?: boolean }> = [
  { table: 'audit_logs', column: 'platform', ddl: 'VARCHAR(20) NULL', index: true },
  { table: 'audit_logs', column: 'deviceType', ddl: 'VARCHAR(20) NULL' },
  { table: 'audit_logs', column: 'deviceName', ddl: 'VARCHAR(100) NULL' },
  { table: 'audit_logs', column: 'os', ddl: 'VARCHAR(50) NULL' },
  { table: 'audit_logs', column: 'browser', ddl: 'VARCHAR(60) NULL' },
  { table: 'audit_logs', column: 'deviceId', ddl: 'VARCHAR(255) NULL' },
  { table: 'audit_logs', column: 'appVersion', ddl: 'VARCHAR(30) NULL' },
  { table: 'login_history', column: 'platform', ddl: 'VARCHAR(20) NULL', index: true },
  { table: 'login_history', column: 'deviceType', ddl: 'VARCHAR(20) NULL' },
  { table: 'login_history', column: 'deviceName', ddl: 'VARCHAR(100) NULL' },
  { table: 'login_history', column: 'os', ddl: 'VARCHAR(50) NULL' },
  { table: 'login_history', column: 'browser', ddl: 'VARCHAR(60) NULL' },
  { table: 'sessions', column: 'platform', ddl: 'VARCHAR(20) NULL', index: true },
  { table: 'sessions', column: 'deviceType', ddl: 'VARCHAR(20) NULL' },
  { table: 'sessions', column: 'appVersion', ddl: 'VARCHAR(30) NULL' },
];

/**
 * Vérifie au démarrage que les colonnes de traçabilité existent et les ajoute
 * si besoin (idempotent, sans toucher aux données). Équivalent automatique de
 * prisma/sql/20261111_device_tracking.sql. Désactivable : AUTO_DB_TRACKING_COLUMNS=false.
 */
export async function ensureTrackingColumns(prisma: any, serviceName = 'service'): Promise<void> {
  if (String(process.env.AUTO_DB_TRACKING_COLUMNS ?? 'true').toLowerCase() === 'false') return;
  try {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('audit_logs','login_history','sessions')`,
    );
    const existing = new Set(rows.map((r) => `${r.t}.${r.c}`));
    for (const col of TRACKING_COLUMNS) {
      if (existing.has(`${col.table}.${col.column}`)) continue;
      try {
        await prisma.$executeRawUnsafe(`ALTER TABLE \`${col.table}\` ADD COLUMN \`${col.column}\` ${col.ddl}`);
        if (col.index) {
          await prisma.$executeRawUnsafe(
            `CREATE INDEX \`idx_${col.table}_${col.column}\` ON \`${col.table}\` (\`${col.column}\`)`,
          ).catch(() => undefined);
        }
        logger.log(`[${serviceName}] Colonne ajoutée : ${col.table}.${col.column}`);
      } catch (err) {
        // Ajoutée au même moment par un autre service : on ignore
        if (!/Duplicate column/i.test(String((err as any)?.message || err))) throw err;
      }
    }
  } catch (err) {
    logger.error(
      `[${serviceName}] Impossible de vérifier/ajouter les colonnes de traçabilité (${(err as any)?.message || err}). ` +
      'Exécutez prisma/sql/20261111_device_tracking.sql dans MySQL.',
    );
  }
}
