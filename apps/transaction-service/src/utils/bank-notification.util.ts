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
      const data: Record<string, any> = {
        amount: op.amount,
        currency: op.currency,
        accountNumber: op.accountNumber || '',
        reference: op.reference || op.id || '',
        balance,
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
