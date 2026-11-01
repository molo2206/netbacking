// libs/common/src/bank/bank-accounts.util.ts
//
// Helpers partagés pour lire les réponses de l'API bancaire externe.
// ⚠️ Les comptes ne sont JAMAIS lus depuis la base locale : ils viennent
//    toujours de l'API (GetClientAccounts / GetAccountDetails).

export interface BankAccountView {
  accountNumber: string;
  clientId: string | null;
  accountType: string | null;
  currency: string | null;
  balance: number | string;
  status: string | null;
  isMain: boolean;
}

function parseMaybeJson(value: any): any {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Extrait un objet "métier" d'une réponse banque ({ data: {...} } ou {...}).
 */
export function extractBankObject(res: any): any {
  const raw = parseMaybeJson(res?.data ?? res);
  return raw && typeof raw === 'object' ? raw : null;
}

/**
 * Extrait la liste brute des comptes d'une réponse GetClientAccounts,
 * quel que soit le format renvoyé par la banque.
 */
export function extractBankAccounts(res: any): any[] {
  let raw: any = res?.data?.accounts ?? res?.accounts ?? res?.data ?? res ?? [];
  raw = parseMaybeJson(raw);
  if (raw && !Array.isArray(raw) && Array.isArray(raw.accounts)) {
    raw = raw.accounts;
  }
  return Array.isArray(raw) ? raw : [];
}

/**
 * Normalise un compte bancaire pour les réponses de l'API Netbacking.
 */
export function mapBankAccount(acc: any, clientId?: string | null): BankAccountView {
  const accountType = acc?.accountType ?? null;
  return {
    accountNumber: String(acc?.accountNumber ?? '').trim(),
    clientId: (acc?.clientId ?? clientId ?? null) as string | null,
    accountType,
    currency: acc?.currency ?? null,
    balance: acc?.balance ?? 0,
    status: acc?.status ?? null,
    isMain: String(accountType || '').toLowerCase().includes('pargne'),
  };
}

export function mapBankAccounts(res: any, clientId?: string | null): BankAccountView[] {
  return extractBankAccounts(res)
    .map((acc) => mapBankAccount(acc, clientId))
    .filter((acc) => !!acc.accountNumber);
}
