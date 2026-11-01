// libs/common/src/security/temporary-password.util.ts
import * as crypto from 'crypto';

/**
 * Jeux de caractères SANS caractères ambigus (0/O, 1/l/I) pour que le mot de
 * passe reçu par SMS soit facile à recopier.
 */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '@#$%&*!?';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

function pick(charset: string): string {
  return charset[crypto.randomInt(0, charset.length)];
}

/**
 * Génère un mot de passe temporaire robuste (cryptographiquement aléatoire)
 * contenant au moins 1 majuscule, 1 minuscule, 1 chiffre et 1 symbole.
 */
export function generateTemporaryPassword(length: number = 10): string {
  const size = Math.max(8, length);
  const chars: string[] = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];

  while (chars.length < size) {
    chars.push(pick(ALL));
  }

  // Mélange de Fisher-Yates avec un aléa cryptographique
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

/**
 * Mot de passe "inutilisable" stocké pour un compte en attente d'approbation :
 * personne ne le connaît, donc aucune connexion n'est possible avant
 * l'approbation (qui remplace ce hash par celui du mot de passe temporaire).
 */
export function generateUnusablePassword(): string {
  return crypto.randomBytes(48).toString('hex');
}

/**
 * Durée de validité du mot de passe temporaire (heures).
 * Configurable via TEMP_PASSWORD_EXPIRY_HOURS (défaut : 72 h).
 */
export function getTemporaryPasswordExpiryHours(): number {
  const raw = parseInt(process.env.TEMP_PASSWORD_EXPIRY_HOURS || '72', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 72;
}

export function computeTemporaryPasswordExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + getTemporaryPasswordExpiryHours() * 60 * 60 * 1000);
}

/**
 * Règle minimale pour le NOUVEAU mot de passe choisi par l'utilisateur.
 * Retourne la clé i18n de l'erreur, ou null si le mot de passe est valide.
 */
export function validateNewPassword(password: string): string | null {
  if (!password || password.trim().length < 8) return 'password_too_short';
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return 'password_too_weak';
  }
  return null;
}
