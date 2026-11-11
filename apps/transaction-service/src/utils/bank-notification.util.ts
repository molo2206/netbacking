/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/transaction-service/src/utils/bank-notification.util.ts
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { I18nService } from '@app/common';

/**
 * ═══════════════════════════════════════════════════════════════════
 * NOTIFICATION D'UNE OPÉRATION BANCAIRE — procédure standard AccesFinance
 * ═══════════════════════════════════════════════════════════════════
 *  1. langue de l'utilisateur
 *  2. SMS si l'utilisateur a laissé les SMS activés
 *  3. push (+ historique) si l'utilisateur a laissé les push activés
 * Une erreur de notification ne fait JAMAIS échouer l'opération.
 * ═══════════════════════════════════════════════════════════════════
 */

export type BankOperationKind = 'deposit' | 'withdrawal' | 'transfer_sent' | 'transfer_received';

export interface BankNotificationDeps {
  smsService: SmsService;
  notificationHelper: NotificationHelper;
  i18nService: I18nService;
  shouldSendSms: (userId: string) => Promise<boolean>;
  shouldSendPush: (userId: string) => Promise<boolean>;
  getUserLanguage: (userId: string) => Promise<string>;
}

export interface BankOperationInfo {
  id?: string | null;          // id de transaction banque
  reference?: string | null;
  amount: number;
  currency: string;
  accountNumber?: string | null; // compte de l'utilisateur notifié
  balance?: number | string | null;
  fees?: number | string | null;
  description?: string | null;
  date?: Date | string | null;
}

// ─────────────────────────── détail de l'opération (push) ───────────────────────────

const LOCALES: Record<string, string> = { fr: 'fr-FR', en: 'en-US', sw: 'sw-KE' };

function formatAmount(value: any, currency: string, lang: string): string | null {
  if (value === null || value === undefined || value === '' || value === '-') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const txt = new Intl.NumberFormat(LOCALES[lang] || 'fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  return `${txt} ${currency}`;
}

function formatDate(value: any, lang: string): string {
  const d = value ? new Date(value) : new Date();
  const date = isNaN(d.getTime()) ? new Date() : d;
  return date.toLocaleString(LOCALES[lang] || 'fr-FR', {
    timeZone: process.env.APP_TIMEZONE || 'Africa/Lubumbashi',
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Détail complet de l'opération, affiché dans la notification et dans l'écran
 * « Notifications » de l'application (liste libellé / valeur, dans la langue de l'utilisateur).
 */
function buildOperationDetails(
  deps: BankNotificationDeps,
  kind: BankOperationKind,
  op: BankOperationInfo,
  counterparty: { name?: string | null; accountNumber?: string | null } | undefined,
  lang: string,
) {
  const t = (k: string) => deps.i18nService.translate(`notifications.label.${k}`, lang);
  const amount = formatAmount(op.amount, op.currency, lang);
  const fees = Number(op.fees || 0) > 0 ? formatAmount(op.fees, op.currency, lang) : null;
  const total = fees && kind === 'transfer_sent' ? formatAmount(Number(op.amount) + Number(op.fees), op.currency, lang) : null;
  const balance = formatAmount(op.balance, op.currency, lang);
  const date = formatDate(op.date, lang);
  const reference = op.reference || op.id || null;

  const rows: Array<[string, string | null | undefined]> = [[t('operation'), t(`op_${kind}`)], [t('amount'), amount]];
  if (fees) rows.push([t('fees'), fees]);
  if (total) rows.push([t('total'), total]);
  if (kind === 'transfer_sent') {
    rows.push([t('to'), counterparty?.name || null], [t('toAccount'), counterparty?.accountNumber || null], [t('fromAccount'), op.accountNumber]);
  } else if (kind === 'transfer_received') {
    rows.push([t('from'), counterparty?.name || null], [t('fromAccount'), counterparty?.accountNumber || null], [t('account'), op.accountNumber]);
  } else {
    rows.push([t('account'), op.accountNumber]);
  }
  rows.push([t('description'), op.description || null], [t('reference'), reference], [t('date'), date], [t('balance'), balance], [t('status'), t('status_success')]);

  const details = rows
    .filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '')
    .map(([label, value]) => ({ label, value: String(value) }));

  // Lignes ajoutées sous la phrase principale du push (visibles sur le téléphone)
  const pushLines = [
    reference ? `${t('reference')} : ${reference}` : null,
    `${t('date')} : ${date}`,
    fees ? `${t('fees')} : ${fees}` : null,
    balance ? `${t('balance')} : ${balance}` : null,
  ].filter(Boolean) as string[];

  const operation = {
    kind,
    type: kind.startsWith('transfer') ? 'TRANSFER' : kind === 'deposit' ? 'DEPOSIT' : 'WITHDRAWAL',
    direction: kind === 'transfer_sent' || kind === 'withdrawal' ? 'DEBIT' : 'CREDIT',
    amount: Number(op.amount),
    fees: Number(op.fees || 0),
    currency: op.currency,
    accountNumber: op.accountNumber || null,
    counterpartyName: counterparty?.name || null,
    counterpartyAccount: counterparty?.accountNumber || null,
    description: op.description || null,
    reference,
    transactionId: op.id || null,
    balance: op.balance !== null && op.balance !== undefined && op.balance !== '-' && Number.isFinite(Number(op.balance)) ? Number(op.balance) : null,
    status: 'COMPLETED',
    date: (op.date ? new Date(op.date) : new Date()).toISOString(),
  };

  return { details, pushLines, operation, formattedAmount: amount };
}

export interface NotifiedUser {
  id: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export async function notifyBankOperation(
  deps: BankNotificationDeps,
  kind: BankOperationKind,
  user: NotifiedUser,
  op: BankOperationInfo,
  counterparty?: { name?: string | null; accountNumber?: string | null },
) {
  if (!user?.id) return;
  const lang = await deps.getUserLanguage(user.id).catch(() => 'fr');
  const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  const balance = op.balance ?? '-';

  // ── SMS ─────────────────────────────────────────────────────────
  try {
    if (user.phone && (await deps.shouldSendSms(user.id))) {
      const keyByKind: Record<BankOperationKind, string> = {
        deposit: 'deposit_sms',
        withdrawal: 'withdraw_sms',
        transfer_sent: 'transfer_sent_sms',
        transfer_received: 'transfer_received_sms',
      };
      const smsText = deps.i18nService.translate(keyByKind[kind], lang, {
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        full_name: fullName,
        amount: op.amount,
        currency: op.currency,
        newBalance: balance,
        balance,
        accountNumber: op.accountNumber || '',
        reference: op.reference || op.id || '',
        receiverName: counterparty?.name || counterparty?.accountNumber || '',
        receiverAccountNumber: counterparty?.accountNumber || '',
        senderName: counterparty?.name || counterparty?.accountNumber || '',
        senderAccountNumber: counterparty?.accountNumber || '',
      });
      // Le numéro est normalisé par SmsService (format +243, numéros mobiles uniquement)
      await deps.smsService.sendSms(String(user.phone), smsText);
    }
  } catch (err) {
    console.warn(`[notifyBankOperation] SMS ${kind} pour ${user.id} : ${err?.message || err}`);
  }

  // ── Push + historique ───────────────────────────────────────────
  try {
    if (await deps.shouldSendPush(user.id)) {
      let type = NotificationType.TRANSACTION;
      const detail = buildOperationDetails(deps, kind, op, counterparty, lang);
      const data: Record<string, any> = {
        amount: detail.formattedAmount ? detail.formattedAmount.replace(` ${op.currency}`, '') : op.amount,
        currency: op.currency,
        accountNumber: op.accountNumber || '',
        reference: op.reference || op.id || '',
        balance,
        // ✅ Informations complètes de l'opération (écran de détail de la notification)
        operation: detail.operation,
        details: detail.details,
        pushLines: detail.pushLines,
        transactionId: op.id || '',
      };

      if (kind === 'deposit' || kind === 'withdrawal') {
        data.operationType = kind;
      } else {
        type = NotificationType.TRANSFER;
        data.direction = kind === 'transfer_sent' ? 'sent' : 'received';
        if (kind === 'transfer_sent') {
          data.receiverName = counterparty?.name || counterparty?.accountNumber || '';
          data.receiverAccountNumber = counterparty?.accountNumber || '';
        } else {
          data.senderName = counterparty?.name || counterparty?.accountNumber || '';
          data.senderAccountNumber = counterparty?.accountNumber || '';
        }
      }

      await deps.notificationHelper.notify(user.id, type, data, 'TRANSACTION', op.id || undefined, lang);
    }
  } catch (err) {
    console.warn(`[notifyBankOperation] push ${kind} pour ${user.id} : ${err?.message || err}`);
  }
}
