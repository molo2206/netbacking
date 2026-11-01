// libs/common/src/security/session-validator.ts
import { getSharedPrisma } from '../db/shared-prisma';
import { loadOperationControls } from '../settings/operation-controls';

/**
 * Vérifie à CHAQUE requête authentifiée (avec un petit cache mémoire) :
 *   1. que l'utilisateur existe et n'est pas bloqué / supprimé
 *   2. que sa session n'a pas été fermée (déconnexion, déconnexion forcée par l'admin)
 *   3. le rôle À JOUR en base (un changement de rôle s'applique sans reconnexion)
 *   4. le mode maintenance (seuls ADMIN / SUPER_ADMIN passent)
 *
 * Sans cette vérification, un JWT reste valable jusqu'à son expiration (30 jours),
 * même si l'admin bloque le compte ou ferme la session.
 *
 * Désactivable avec SESSION_CHECK_ENABLED=false (déconseillé).
 */

export type SessionCheckResult =
  | { ok: true; role: string; status: string; maintenance: false }
  | {
      ok: false;
      httpStatus: 401 | 403 | 503;
      code: 'USER_NOT_FOUND' | 'ACCOUNT_BLOCKED' | 'SESSION_REVOKED' | 'MAINTENANCE';
      message: string;
    };

const BLOCKED_STATUSES = ['SUSPENDED', 'DELETED', 'INACTIVE'];
const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];

const CACHE_TTL_MS = parseInt(process.env.SESSION_CHECK_CACHE_MS || '15000', 10);
const cache = new Map<string, { result: SessionCheckResult; expiresAt: number }>();

export function isSessionCheckEnabled(): boolean {
  return String(process.env.SESSION_CHECK_ENABLED ?? 'true').toLowerCase() !== 'false';
}

/** À appeler quand l'admin bloque / déconnecte un utilisateur (même processus). */
export function clearSessionCheckCache() {
  cache.clear();
}

export async function checkSession(token: string, userId: string): Promise<SessionCheckResult> {
  const key = `${userId}:${token.slice(-32)}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) return cached.result;

  const result = await computeSession(token, userId);
  cache.set(key, { result, expiresAt: now + CACHE_TTL_MS });

  // Nettoyage simple pour éviter que la Map grossisse indéfiniment
  if (cache.size > 5000) {
    for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);
  }
  return result;
}

async function computeSession(token: string, userId: string): Promise<SessionCheckResult> {
  const prisma = getSharedPrisma();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true, deletedAt: true },
  });

  if (!user || user.deletedAt) {
    return { ok: false, httpStatus: 401, code: 'USER_NOT_FOUND', message: 'Utilisateur introuvable.' };
  }

  const status = String(user.status || 'ACTIVE');
  const role = String(user.role || 'USER');

  if (BLOCKED_STATUSES.includes(status)) {
    return {
      ok: false,
      httpStatus: 403,
      code: 'ACCOUNT_BLOCKED',
      message: 'Votre compte est bloqué. Veuillez contacter votre agence AccesFinance.',
    };
  }

  // ── Session ──
  //   1. Session trouvée par son token → doit être active et non expirée
  //   2. Token non retrouvé (anciennes sessions) → au moins une session active
  //      pour cet utilisateur ; une déconnexion forcée les ferme toutes.
  const now = new Date();
  const session = await prisma.session.findFirst({
    where: { token },
    select: { isActive: true, expiresAt: true },
  });

  const sessionValid = session
    ? session.isActive === true && session.expiresAt > now
    : (await prisma.session.count({
        where: { userId, isActive: true, expiresAt: { gt: now } },
      })) > 0;

  if (!sessionValid) {
    return {
      ok: false,
      httpStatus: 401,
      code: 'SESSION_REVOKED',
      message: 'Votre session a été fermée. Veuillez vous reconnecter.',
    };
  }

  // ── Maintenance ──
  if (!ADMIN_ROLES.includes(role)) {
    const controls = await loadOperationControls(prisma);
    if (controls.maintenanceMode) {
      return { ok: false, httpStatus: 503, code: 'MAINTENANCE', message: controls.maintenanceMessage };
    }
  }

  return { ok: true, role, status, maintenance: false };
}
