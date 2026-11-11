// libs/common/src/utils/platform.util.ts
/**
 * ═══════════════════════════════════════════════════════════════════
 * CANAL (plateforme) : MOBILE = Mobile Banking, WEB = Net Banking
 * ═══════════════════════════════════════════════════════════════════
 * Ordre de détection :
 *   1. valeur envoyée par l'app (header x-client, puis champ platform du body)
 *   2. plateforme de la SESSION utilisée (enregistrée à la connexion)
 *   3. user-agent (okhttp / CFNetwork / Dart → MOBILE ; navigateur → WEB)
 * ═══════════════════════════════════════════════════════════════════
 */
import { getSharedPrisma } from '../db/shared-prisma';

export type AppPlatform = 'MOBILE' | 'WEB' | 'BACK_OFFICE' | 'UNKNOWN';

const MOBILE_VALUES = ['MOBILE', 'MOBILE_APP', 'APP', 'ANDROID', 'IOS', 'IPHONE', 'IPAD', 'REACT-NATIVE', 'REACT_NATIVE', 'MOBILE_BANKING', 'MOBILEBANKING'];
const WEB_VALUES = ['WEB', 'ONLINE', 'BROWSER', 'DESKTOP', 'INTERNET', 'NETBANKING', 'NET_BANKING', 'ONLINEBANKING', 'ONLINE_BANKING'];
const BACK_OFFICE_VALUES = ['BACK_OFFICE', 'BACKOFFICE', 'ADMIN'];

export const CHANNEL_LABELS: Record<AppPlatform, string> = {
  MOBILE: 'Mobile Banking',
  WEB: 'Net Banking',
  BACK_OFFICE: 'Back-office',
  UNKNOWN: 'Non déterminé',
};

/** Valeur envoyée par une app (« mobile », « accesfinance-android », « net-banking »…). */
function fromDeclared(value?: string | null): AppPlatform {
  const p = String(value || '').trim().toUpperCase();
  if (!p) return 'UNKNOWN';
  if (MOBILE_VALUES.includes(p)) return 'MOBILE';
  if (WEB_VALUES.includes(p)) return 'WEB';
  if (BACK_OFFICE_VALUES.includes(p)) return 'BACK_OFFICE';
  // Valeurs composées : « accesfinance-mobile », « net-banking-web »…
  if (/BACK.?OFFICE|ADMIN/.test(p)) return 'BACK_OFFICE';
  if (/MOBILE|ANDROID|IOS|IPHONE|IPAD/.test(p)) return 'MOBILE';
  if (/WEB|NET.?BANK|ONLINE|BROWSER|DESKTOP/.test(p)) return 'WEB';
  return 'UNKNOWN';
}

/** Déduction depuis le user-agent. */
function fromUserAgent(userAgent?: string | null): AppPlatform {
  const ua = String(userAgent || '').toLowerCase();
  if (!ua) return 'UNKNOWN';
  if (/okhttp|dart\/|cfnetwork|darwin|react-native|expo|dalvik/.test(ua)) return 'MOBILE';
  if (/mozilla|chrome|safari|firefox|edge|opera/.test(ua)) return 'WEB';
  if (/android|iphone|ipad/.test(ua)) return 'MOBILE';
  return 'UNKNOWN';
}

/**
 * Ramène toutes les variantes envoyées par les apps à MOBILE / WEB / BACK_OFFICE.
 * `platform` : valeur du header x-client ou du body (prioritaire)
 * `userAgent` : utilisé si la plateforme n'est pas fournie ou pas reconnue
 */
export function normalizePlatform(platform?: string | null, userAgent?: string | null): AppPlatform {
  const declared = fromDeclared(platform);
  if (declared !== 'UNKNOWN') return declared;
  return fromUserAgent(userAgent);
}

/** Plateforme bancaire attendue par l'API de la banque. */
export function toBankPlatform(platform?: string | null): 'Mobile' | 'Online' {
  return normalizePlatform(platform) === 'WEB' ? 'Online' : 'Mobile';
}

/** Plateforme de la session ouverte avec ce jeton (colonne sessions.platform). */
export async function sessionPlatform(token?: string | null): Promise<AppPlatform> {
  const t = String(token || '').replace(/^Bearer\s+/i, '').trim();
  if (!t) return 'UNKNOWN';
  try {
    const rows: any[] = await getSharedPrisma().$queryRawUnsafe<any[]>(
      'SELECT platform FROM sessions WHERE token = ? LIMIT 1',
      t,
    );
    return fromDeclared(rows?.[0]?.platform);
  } catch {
    return 'UNKNOWN'; // colonne absente (migration 20261104 non appliquée)
  }
}

/**
 * Canal d'une opération : valeur déclarée par l'app → session → user-agent.
 * Utilisé pour séparer les rapports Mobile Banking / Net Banking.
 */
export async function resolveChannel(opts: {
  platform?: string | null;
  client?: string | null;
  userAgent?: string | null;
  token?: string | null;
}): Promise<AppPlatform> {
  const header = fromDeclared(opts.client);
  if (header !== 'UNKNOWN') return header;
  const declared = fromDeclared(opts.platform);
  if (declared !== 'UNKNOWN') return declared;
  const session = await sessionPlatform(opts.token);
  if (session !== 'UNKNOWN') return session;
  return fromUserAgent(opts.userAgent);
}
