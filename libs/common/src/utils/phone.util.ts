// libs/common/src/utils/phone.util.ts
/**
 * ═══════════════════════════════════════════════════════════════════
 * NUMÉROS DE TÉLÉPHONE — format unique AccesFinance : +243XXXXXXXXX
 * ═══════════════════════════════════════════════════════════════════
 * Formats acceptés en entrée (RDC par défaut) :
 *   0979 649 404 · 979649404 · 243979649404 · +243979649404
 *   00243979649404 · +243 0979649404 · 2430979649404 (zéro en trop)
 *   +243-979-649-404 · (0979) 64.94.04 · tel:+243979649404
 *   « 0979649404 / 0812345678 » → le premier numéro valide est retenu
 * Sortie : +243979649404
 *
 * Rejetés (retour '') : vide, trop court/long, uniquement des zéros
 * (la banque renvoie parfois "0000000000" pour « pas de numéro »),
 * numéros de comptes supprimés (« deleted-… »).
 *
 * SMS : seuls les numéros MOBILES de la RDC sont acceptés
 * (numéro national commençant par 8 ou 9 : Vodacom, Orange, Airtel,
 * Africell). Désactivable avec PHONE_SMS_MOBILE_ONLY=false.
 * ═══════════════════════════════════════════════════════════════════
 */

export const DEFAULT_COUNTRY_CODE = process.env.PHONE_DEFAULT_COUNTRY_CODE || '243';
/** Longueur du numéro national RDC (sans le 0) : 9 chiffres. */
const DRC_NATIONAL_LENGTH = 9;
/** Premiers chiffres des numéros mobiles RDC (81-85, 89 : Vodacom/Orange ; 90-99 : Africell/Airtel). */
const DRC_MOBILE_FIRST_DIGITS = ['8', '9'];

function onlyDigits(value: string): string {
  return value.replace(/[^0-9]/g, '');
}

/** Normalise UN seul numéro (sans séparateur de liste). */
function normalizeSingle(raw: string, defaultCountryCode: string): string {
  let value = raw.trim().replace(/^tel:/i, '');
  if (!value || /^deleted-/i.test(value)) return '';

  const hasPlus = value.startsWith('+');
  let digits = onlyDigits(value);
  if (!digits || /^0+$/.test(digits)) return '';

  if (hasPlus) {
    // déjà international
  } else if (digits.startsWith('00')) {
    digits = digits.substring(2);
  } else if (digits.startsWith(defaultCountryCode) && digits.length > DRC_NATIONAL_LENGTH) {
    // 243979649404 ou 2430979649404
  } else if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.substring(1);
  } else {
    digits = defaultCountryCode + digits;
  }

  // +243 0979… : zéro de tête du numéro national laissé après l'indicatif
  if (digits.startsWith(defaultCountryCode + '0')) {
    digits = defaultCountryCode + digits.substring(defaultCountryCode.length + 1);
  }

  // E.164 : 8 à 15 chiffres ; RDC : exactement 243 + 9 chiffres
  if (digits.length < 8 || digits.length > 15) return '';
  if (digits.startsWith('243') && digits.length !== 3 + DRC_NATIONAL_LENGTH) return '';
  if (/^0+$/.test(digits.substring(3))) return '';
  return '+' + digits;
}

/**
 * Normalise un numéro au format international E.164 (+243XXXXXXXXX par défaut).
 * Si le champ contient plusieurs numéros (« / », « , », « ; », « | »), le premier
 * numéro valide est retenu. Retourne '' si aucun numéro n'est valide.
 */
export function normalizePhoneToInternational(
  phone: string | null | undefined,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): string {
  if (phone === null || phone === undefined) return '';
  const raw = String(phone).trim();
  if (!raw) return '';

  const parts = raw.split(/[\/,;|]| et | ou /i).map((p) => p.trim()).filter(Boolean);
  for (const part of parts.length ? parts : [raw]) {
    const normalized = normalizeSingle(part, defaultCountryCode);
    if (normalized) return normalized;
  }
  return '';
}

/** true si le numéro peut être normalisé. */
export function isValidPhone(phone: string | null | undefined): boolean {
  return normalizePhoneToInternational(phone) !== '';
}

/** Numéro mobile de la RDC (+243 8x / 9x) — seuls ceux-ci reçoivent des SMS. */
export function isDrcMobile(phone: string | null | undefined): boolean {
  const intl = normalizePhoneToInternational(phone);
  if (!intl.startsWith('+243') || intl.length !== 13) return false;
  return DRC_MOBILE_FIRST_DIGITS.includes(intl.charAt(4));
}

export interface SmsNumberCheck {
  ok: boolean;
  number: string;          // format fournisseur : 243979649404 (vide si refusé)
  international: string;   // +243979649404 (vide si invalide)
  reason?: string;         // motif du refus
}

/**
 * Prépare un numéro pour l'envoi d'un SMS : normalisation + contrôles.
 * Format attendu par le fournisseur : chiffres seuls, sans « + » (243979649404).
 */
export function checkSmsNumber(phone: string | null | undefined): SmsNumberCheck {
  const raw = phone === null || phone === undefined ? '' : String(phone).trim();
  if (!raw) return { ok: false, number: '', international: '', reason: 'Numéro absent' };

  const international = normalizePhoneToInternational(raw);
  if (!international) {
    return { ok: false, number: '', international: '', reason: `Numéro invalide : « ${raw.slice(0, 40)} »` };
  }

  const mobileOnly = String(process.env.PHONE_SMS_MOBILE_ONLY ?? 'true').toLowerCase() !== 'false';
  if (mobileOnly && international.startsWith('+243') && !isDrcMobile(international)) {
    return {
      ok: false,
      number: '',
      international,
      reason: `${international} n'est pas un numéro mobile RDC (doit commencer par +243 8… ou +243 9…)`,
    };
  }
  return { ok: true, number: international.substring(1), international };
}

/** Format attendu par le fournisseur SMS : chiffres seuls, sans « + » (243979649404). */
export function toSmsNumber(phone: string | null | undefined): string {
  return checkSmsNumber(phone).number;
}

/** Affichage lisible : +243 979 649 404 */
export function formatPhoneForDisplay(phone: string | null | undefined): string {
  const intl = normalizePhoneToInternational(phone);
  if (!intl) return phone ? String(phone) : '';
  const d = intl.substring(1);
  if (d.startsWith('243') && d.length === 12) {
    return `+243 ${d.substring(3, 6)} ${d.substring(6, 9)} ${d.substring(9)}`;
  }
  return intl;
}

/** Numéro masqué pour les logs : +243 979 *** 404 */
export function maskPhone(phone: string | null | undefined): string {
  const intl = normalizePhoneToInternational(phone);
  if (!intl) return '***';
  const d = intl.substring(1);
  if (d.startsWith('243') && d.length === 12) return `+243 ${d.substring(3, 6)} *** ${d.substring(9)}`;
  return `${intl.slice(0, 5)}***${intl.slice(-3)}`;
}

/** Deux écritures désignent-elles le même numéro ? */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhoneToInternational(a);
  return !!na && na === normalizePhoneToInternational(b);
}

/**
 * Variantes d'écriture d'un même numéro, pour retrouver un utilisateur
 * quel que soit le format enregistré (+243…, 243…, 0…, 9 chiffres).
 */
export function phoneVariants(phone: string | null | undefined): string[] {
  const variants = new Set<string>();
  if (phone) variants.add(String(phone).trim());
  const intl = normalizePhoneToInternational(phone);
  if (!intl) return Array.from(variants).filter(Boolean);

  const digits = intl.substring(1);
  variants.add(intl);
  variants.add(digits);
  variants.add('00' + digits);
  if (digits.startsWith('243')) {
    const national = digits.substring(3);
    variants.add('0' + national);
    variants.add(national);
    variants.add('+2430' + national);
  }
  return Array.from(variants).filter(Boolean);
}

/** L'identifiant saisi ressemble-t-il à un numéro de téléphone ? */
export function looksLikePhone(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = String(value).trim();
  if (v.includes('@')) return false;
  return /^[+0-9\s\-().]{8,20}$/.test(v) && onlyDigits(v).length >= 9;
}
