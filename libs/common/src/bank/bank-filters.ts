// libs/common/src/bank/bank-filters.ts
/**
 * ═══════════════════════════════════════════════════════════════════
 * FILTRES DE GetAccountTransactions — conformes au document
 * « Banking API – Client Integration Document », section 10
 * ═══════════════════════════════════════════════════════════════════
 *   page      : défaut 1, doit être > 0
 *   limit     : défaut 20, doit être > 0 et <= 100
 *   startDate : yyyy-MM-dd
 *   endDate   : yyyy-MM-dd
 *   type      : DEPOSIT, WITHDRAWAL, TRANSFER, PAYMENT, FEE
 *   movement  : CREDIT ou DEBIT
 *   status    : PENDING, COMPLETED, FAILED
 * Les valeurs sont normalisées en MAJUSCULES (la banque fait de même).
 * Une valeur hors liste → erreur 400 claire AVANT d'appeler la banque.
 * ═══════════════════════════════════════════════════════════════════
 */

export const BANK_TX_TYPES = ['DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'PAYMENT', 'FEE'] as const;
export const BANK_TX_MOVEMENTS = ['CREDIT', 'DEBIT'] as const;
export const BANK_TX_STATUSES = ['PENDING', 'COMPLETED', 'FAILED'] as const;

export const BANK_PAGE_DEFAULT = 1;
export const BANK_LIMIT_DEFAULT = 20;
export const BANK_LIMIT_MAX = 100;

/** Variantes acceptées et ramenées à la valeur officielle de la banque. */
const TYPE_ALIASES: Record<string, string> = {
  WITHDRAW: 'WITHDRAWAL',
  CASHOUT: 'WITHDRAWAL',
  RETRAIT: 'WITHDRAWAL',
  TOPUP: 'DEPOSIT',
  DEPOT: 'DEPOSIT',
  DÉPÔT: 'DEPOSIT',
  TRANSFERT: 'TRANSFER',
  PAIEMENT: 'PAYMENT',
  FEES: 'FEE',
  FRAIS: 'FEE',
};

const STATUS_ALIASES: Record<string, string> = {
  SUCCESS: 'COMPLETED',
  COMPLETE: 'COMPLETED',
  DONE: 'COMPLETED',
  FAIL: 'FAILED',
  ERROR: 'FAILED',
};

export class BankFilterError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: string,
    public readonly allowed: readonly string[],
  ) {
    super(`Valeur invalide pour « ${field} » : ${value}. Valeurs acceptées : ${allowed.join(', ')}.`);
  }
}

function normalizeOne(
  field: string,
  raw: any,
  allowed: readonly string[],
  aliases: Record<string, string> = {},
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  if (!value) return undefined;
  const upper = value.toUpperCase();
  const mapped = aliases[upper] || upper;
  if (!(allowed as readonly string[]).includes(mapped)) throw new BankFilterError(field, value, allowed);
  return mapped;
}

export function normalizeBankType(raw: any): string | undefined {
  return normalizeOne('type', raw, BANK_TX_TYPES, TYPE_ALIASES);
}

/** Plusieurs types séparés par des virgules (filtrage local côté admin). */
export function normalizeBankTypes(raw: any): string[] {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  return String(raw)
    .split(',')
    .map((t) => normalizeBankType(t))
    .filter((t): t is string => !!t);
}

export function normalizeBankMovement(raw: any): 'CREDIT' | 'DEBIT' | undefined {
  return normalizeOne('movement', raw, BANK_TX_MOVEMENTS) as 'CREDIT' | 'DEBIT' | undefined;
}

export function normalizeBankStatus(raw: any): string | undefined {
  return normalizeOne('status', raw, BANK_TX_STATUSES, STATUS_ALIASES);
}

/** page > 0 (défaut 1). */
export function normalizeBankPage(raw: any): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : BANK_PAGE_DEFAULT;
}

/** 0 < limit <= 100 (défaut 20). */
export function normalizeBankLimit(raw: any): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return BANK_LIMIT_DEFAULT;
  return Math.min(n, BANK_LIMIT_MAX);
}

/** Type renvoyé par la banque (« Transfer ») → valeur officielle (« TRANSFER »). */
export function canonicalBankType(raw: any): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const upper = String(raw).trim().toUpperCase();
  return TYPE_ALIASES[upper] || upper;
}
