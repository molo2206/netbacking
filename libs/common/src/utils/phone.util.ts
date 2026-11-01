// libs/common/src/utils/phone.util.ts

/**
 * Normalise un numéro au format international (+243XXXXXXXXX par défaut).
 * Retourne '' si le numéro est vide ou invalide.
 */
export function normalizePhoneToInternational(
  phone: string | null | undefined,
  defaultCountryCode: string = '243',
): string {
  if (!phone) return '';

  let cleaned = String(phone).trim().replace(/[\s\-().]/g, '');

  if (cleaned.startsWith('+')) {
    const digits = cleaned.substring(1).replace(/[^0-9]/g, '');
    return digits ? '+' + digits : '';
  }

  cleaned = cleaned.replace(/[^0-9]/g, '');
  if (!cleaned) return '';

  if (cleaned.startsWith('00')) return '+' + cleaned.substring(2);
  if (cleaned.startsWith(defaultCountryCode)) return '+' + cleaned;
  if (cleaned.startsWith('0')) return '+' + defaultCountryCode + cleaned.substring(1);

  return '+' + defaultCountryCode + cleaned;
}

/**
 * Variantes d'écriture d'un même numéro, pour retrouver un utilisateur
 * quel que soit le format enregistré (+243…, 243…, 0…).
 */
export function phoneVariants(phone: string | null | undefined): string[] {
  const intl = normalizePhoneToInternational(phone);
  if (!intl) return [];
  const digits = intl.replace('+', '');
  const variants = new Set<string>([intl, digits]);
  if (digits.startsWith('243')) variants.add('0' + digits.substring(3));
  if (phone) variants.add(String(phone).trim());
  return Array.from(variants);
}
