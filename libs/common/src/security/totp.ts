// libs/common/src/security/totp.ts
/**
 * ═══════════════════════════════════════════════════════════════════
 * 2FA — codes TOTP (RFC 6238), compatibles Google Authenticator,
 * Microsoft Authenticator, Authy… Aucune dépendance externe.
 * ═══════════════════════════════════════════════════════════════════
 * Réglages (.env) :
 *   TWO_FACTOR_ENABLED=true
 *   TWO_FACTOR_ISSUER=AccesFinance            nom affiché dans l'application
 *   TWO_FACTOR_ENCRYPTION_KEY=…               chiffre les clés des utilisateurs en base
 *   TWO_FACTOR_WINDOW=1                       tolérance : ±1 période de 30 s
 *   TWO_FACTOR_BACKUP_CODES=8                 nombre de codes de secours
 *
 * ⚠️ Changer TWO_FACTOR_ENCRYPTION_KEY rend illisibles les clés déjà
 *    enregistrées : les utilisateurs concernés devront réactiver la 2FA.
 * ═══════════════════════════════════════════════════════════════════
 */
import * as crypto from 'crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const DIGITS = 6;

export function twoFactorConfig() {
  const num = (name: string, def: number) => {
    const n = parseInt(String(process.env[name] ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  return {
    enabled: String(process.env.TWO_FACTOR_ENABLED ?? 'true').toLowerCase() !== 'false',
    issuer: (process.env.TWO_FACTOR_ISSUER || 'AccesFinance').trim(),
    window: Math.min(num('TWO_FACTOR_WINDOW', 1), 4),
    backupCodes: Math.min(Math.max(num('TWO_FACTOR_BACKUP_CODES', 8), 0), 20),
  };
}

// ─────────────────────────── base32 ───────────────────────────

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ─────────────────────────── TOTP ───────────────────────────

/** Nouvelle clé secrète (160 bits, base32). */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function totpCode(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function currentTotpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / PERIOD);
}

/**
 * Vérifie un code ; renvoie la période (step) acceptée, ou null.
 * `lastUsedStep` empêche de réutiliser un code déjà accepté.
 */
export function verifyTotp(secretBase32: string, code: string, window: number, lastUsedStep?: number | null): number | null {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = currentTotpStep();
  for (let i = -window; i <= window; i++) {
    const step = now + i;
    if (lastUsedStep !== null && lastUsedStep !== undefined && step <= lastUsedStep) continue;
    const expected = totpCode(secretBase32, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return step;
  }
  return null;
}

/** Lien à transformer en QR code par le front (otpauth://…). */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD}`;
}

// ─────────────────────────── chiffrement de la clé en base ───────────────────────────

function encryptionKey(): Buffer {
  const raw = process.env.TWO_FACTOR_ENCRYPTION_KEY || process.env.JWT_SECRET || 'secret';
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptTotpSecret(secretBase32: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(secretBase32, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

/** Clé en clair, ou null si absente / ancien format / clé de chiffrement changée. */
export function decryptTotpSecret(stored?: string | null): string | null {
  if (!stored || !stored.startsWith('enc:v1:')) return null;
  try {
    const [, , iv, tag, data] = stored.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ─────────────────────────── codes de secours ───────────────────────────

export function hashBackupCode(code: string): string {
  return crypto.createHash('sha256').update(`${String(code).replace(/[\s-]/g, '').toUpperCase()}:${encryptionKey().toString('hex')}`).digest('hex');
}

/** Codes de secours lisibles : XXXX-XXXX (lettres et chiffres sans ambiguïté). */
export function generateBackupCodes(count: number): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: count }, () => {
    const chars = Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

/** Contenu de users.twoFactorBackupCodes : codes hachés + dernière période utilisée. */
export interface TwoFactorState {
  backup: string[];      // hachés
  lastStep?: number | null;
  enabledAt?: string | null;
}

export function readTwoFactorState(raw?: string | null): TwoFactorState {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && Array.isArray(parsed.backup)) return parsed;
  } catch { /* ancien format */ }
  return { backup: [], lastStep: null };
}
