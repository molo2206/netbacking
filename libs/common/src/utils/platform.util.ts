// libs/common/src/utils/platform.util.ts

export type AppPlatform = 'MOBILE' | 'WEB' | 'BACK_OFFICE' | 'UNKNOWN';

const MOBILE_VALUES = ['MOBILE', 'MOBILE_APP', 'APP', 'ANDROID', 'IOS', 'IPHONE', 'IPAD', 'REACT-NATIVE', 'REACT_NATIVE'];
const WEB_VALUES = ['WEB', 'ONLINE', 'BROWSER', 'DESKTOP', 'INTERNET', 'NETBANKING', 'ONLINEBANKING'];
const BACK_OFFICE_VALUES = ['BACK_OFFICE', 'BACKOFFICE', 'ADMIN'];

/**
 * Ramène toutes les variantes envoyées par les apps à MOBILE / WEB / BACK_OFFICE.
 * `platform` : valeur du header x-client ou du body (prioritaire)
 * `userAgent` : utilisé si la plateforme n'est pas fournie
 */
export function normalizePlatform(platform?: string | null, userAgent?: string | null): AppPlatform {
  const p = String(platform || '').trim().toUpperCase();
  if (p) {
    if (MOBILE_VALUES.includes(p)) return 'MOBILE';
    if (WEB_VALUES.includes(p)) return 'WEB';
    if (BACK_OFFICE_VALUES.includes(p)) return 'BACK_OFFICE';
  }

  const ua = String(userAgent || '').toLowerCase();
  if (ua) {
    if (/okhttp|dart|cfnetwork|darwin|react-native|expo|dalvik/.test(ua)) return 'MOBILE';
    if (/android|iphone|ipad|mobile/.test(ua) && !/mozilla/.test(ua)) return 'MOBILE';
    if (/mozilla|chrome|safari|firefox|edge/.test(ua)) return 'WEB';
  }
  return p ? 'UNKNOWN' : 'UNKNOWN';
}

/** Plateforme bancaire attendue par l'API de la banque. */
export function toBankPlatform(platform?: string | null): 'Mobile' | 'Online' {
  return normalizePlatform(platform) === 'WEB' ? 'Online' : 'Mobile';
}
