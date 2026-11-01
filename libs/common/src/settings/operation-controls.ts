// libs/common/src/settings/operation-controls.ts
/**
 * ═══════════════════════════════════════════════════════════════════
 * CONTRÔLE DES OPÉRATIONS (piloté par l'admin)
 * ═══════════════════════════════════════════════════════════════════
 * Stocké dans la table `settings` (clé : "operation_controls", valeur JSON).
 * Aucune migration SQL nécessaire.
 *
 *  - maintenanceMode    : bloque l'API pour tous sauf ADMIN / SUPER_ADMIN
 *  - transfersEnabled   : active / désactive les transferts
 *  - depositsEnabled    : active / désactive les dépôts (topup)
 *  - withdrawalsEnabled : active / désactive les retraits (cashout)
 *  - limits[devise]     : plafonds par opération et par jour et par utilisateur
 *                         (null = pas de limite)
 * ═══════════════════════════════════════════════════════════════════
 */

export const OPERATION_CONTROLS_KEY = 'operation_controls';

export interface CurrencyLimits {
  minPerOperation: number | null;
  maxPerOperation: number | null;
  maxDailyPerUser: number | null;
}

export interface OperationControls {
  maintenanceMode: boolean;
  maintenanceMessage: string;
  transfersEnabled: boolean;
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
  limits: Record<'USD' | 'CDF', CurrencyLimits>;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export const DEFAULT_OPERATION_CONTROLS: OperationControls = {
  maintenanceMode: false,
  maintenanceMessage:
    'AccesFinance est en maintenance. Le service sera rétabli dans quelques instants.',
  transfersEnabled: true,
  depositsEnabled: true,
  withdrawalsEnabled: true,
  limits: {
    USD: { minPerOperation: 1, maxPerOperation: null, maxDailyPerUser: null },
    CDF: { minPerOperation: 100, maxPerOperation: null, maxDailyPerUser: null },
  },
  updatedAt: null,
  updatedBy: null,
};

function toBool(value: any, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  return fallback;
}

function toLimit(value: any, fallback: number | null): number | null {
  if (value === null || value === '') return null;
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function normalizeCurrencyLimits(raw: any, fallback: CurrencyLimits): CurrencyLimits {
  return {
    minPerOperation: toLimit(raw?.minPerOperation, fallback.minPerOperation),
    maxPerOperation: toLimit(raw?.maxPerOperation, fallback.maxPerOperation),
    maxDailyPerUser: toLimit(raw?.maxDailyPerUser, fallback.maxDailyPerUser),
  };
}

/** Fusionne une valeur (partielle) avec une base, en validant chaque champ. */
export function mergeOperationControls(
  base: OperationControls,
  patch: any,
): OperationControls {
  const p = patch || {};
  return {
    maintenanceMode: toBool(p.maintenanceMode, base.maintenanceMode),
    maintenanceMessage:
      typeof p.maintenanceMessage === 'string' && p.maintenanceMessage.trim()
        ? p.maintenanceMessage.trim()
        : base.maintenanceMessage,
    transfersEnabled: toBool(p.transfersEnabled, base.transfersEnabled),
    depositsEnabled: toBool(p.depositsEnabled, base.depositsEnabled),
    withdrawalsEnabled: toBool(p.withdrawalsEnabled, base.withdrawalsEnabled),
    limits: {
      USD: normalizeCurrencyLimits(p.limits?.USD, base.limits.USD),
      CDF: normalizeCurrencyLimits(p.limits?.CDF, base.limits.CDF),
    },
    updatedAt: p.updatedAt ?? base.updatedAt ?? null,
    updatedBy: p.updatedBy ?? base.updatedBy ?? null,
  };
}

/** Vérifie la cohérence min ≤ max ≤ plafond journalier. Retourne la liste des erreurs. */
export function validateOperationControls(c: OperationControls): string[] {
  const errors: string[] = [];
  for (const cur of ['USD', 'CDF'] as const) {
    const l = c.limits[cur];
    if (l.minPerOperation != null && l.maxPerOperation != null && l.minPerOperation > l.maxPerOperation) {
      errors.push(`${cur}: minPerOperation > maxPerOperation`);
    }
    if (l.maxPerOperation != null && l.maxDailyPerUser != null && l.maxPerOperation > l.maxDailyPerUser) {
      errors.push(`${cur}: maxPerOperation > maxDailyPerUser`);
    }
  }
  return errors;
}

// ── Cache mémoire (par processus) ─────────────────────────────────
const CACHE_TTL_MS = parseInt(process.env.OPERATION_CONTROLS_CACHE_MS || '15000', 10);
let cache: { value: OperationControls; expiresAt: number } | null = null;

export function invalidateOperationControlsCache() {
  cache = null;
}

/**
 * Lit les contrôles depuis la table `settings`.
 * `prisma` : n'importe quel client Prisma (PrismaService ou client partagé).
 */
export async function loadOperationControls(
  prisma: any,
  options: { fresh?: boolean } = {},
): Promise<OperationControls> {
  const now = Date.now();
  if (!options.fresh && cache && cache.expiresAt > now) return cache.value;

  let value = DEFAULT_OPERATION_CONTROLS;
  try {
    const row = await prisma.settings.findUnique({ where: { key: OPERATION_CONTROLS_KEY } });
    if (row?.value) {
      value = mergeOperationControls(DEFAULT_OPERATION_CONTROLS, JSON.parse(row.value));
    }
  } catch {
    // En cas d'erreur de lecture : on garde la dernière valeur connue, sinon les défauts
    if (cache) return cache.value;
  }

  cache = { value, expiresAt: now + CACHE_TTL_MS };
  return value;
}

// ── Fuseau horaire de l'application (Africa/Lubumbashi = +02:00) ──
const APP_TZ_OFFSET = process.env.APP_TZ_OFFSET || '+02:00';

function tzOffsetMinutes(): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(APP_TZ_OFFSET);
  if (!m) return 120;
  return (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** Début du jour local (minuit à Lubumbashi) pour la date donnée, en Date UTC. */
export function startOfLocalDay(date: Date = new Date()): Date {
  const offset = tzOffsetMinutes();
  const local = new Date(date.getTime() + offset * 60000);
  const day = local.toISOString().slice(0, 10);
  return new Date(`${day}T00:00:00${APP_TZ_OFFSET}`);
}
