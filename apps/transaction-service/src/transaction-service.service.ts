// apps/transaction-service/src/transaction-service.service.ts
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';
import {
  transactions_type,
  transactions_status,
  users_status,
} from '@prisma/client';
import * as crypto from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { I18nService } from '../../../libs/common/src/i18n/i18n.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import { notifyBankOperation, BankNotificationDeps } from './utils/bank-notification.util';
import { MailService } from 'apps/auth-service/src/email/email.service';
import { getLogoDataUri } from '../../../libs/common/src/branding/brand';
import {
  renderStatementHtml,
  statementLabels,
  StatementRow,
} from '../../../libs/common/src/branding/statement-template';
import { htmlToPdf } from '../../../libs/common/src/pdf/html-to-pdf';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { BankService, BankPlatform } from './bank/bank.service';
import {
  effectiveLimits,
  loadOperationControls,
  loadUserLimits,
  startOfLocalDay,
} from '../../../libs/common/src/settings/operation-controls';
// 👇 Import du service bancaire (adapte le chemin à ta structure)

@Injectable()
export class TransactionServiceService {
  private readonly logger = new Logger(TransactionServiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18nService: I18nService,
    private readonly notificationHelper: NotificationHelper,
    private readonly smsService: SmsService,
    private readonly bankService: BankService,
    private readonly mailService: MailService,
  ) { }

  // ========================= UTILITAIRES =========================

  /**
   * ✅ Les comptes viennent EXCLUSIVEMENT de l'API bancaire : l'identifiant d'un
   *    compte est son numéro bancaire. `accountId` est accepté par compatibilité
   *    (les fronts l'envoient parfois) et interprété comme un numéro de compte.
   */
  private async resolveAccountNumber(data: {
    accountId?: string;
    accountNumber?: string;
    lang?: string;
  }): Promise<string> {
    const accountNumber = String(data.accountNumber || data.accountId || '').trim();
    if (!accountNumber) {
      throw new RpcException({
        status: 'error',
        message: 'accountNumber or accountId is required',
        statusCode: 400,
      });
    }
    return this.assertAccountNumber(accountNumber, data.lang || 'fr');
  }

  /**
   * ✅ Contrôle des opérations défini par l'admin (table settings) :
   *    maintenance, opération activée, montant min / max, plafond journalier.
   *    Appelé AVANT le PIN et l'OTP : aucune tentative ni code consommé
   *    pour une opération refusée d'avance.
   */
  private async assertOperationAllowed(
    kind: 'TRANSFER' | 'DEPOSIT' | 'WITHDRAWAL',
    userId: string | undefined,
    amount: number,
    currencyInput: string | undefined,
    lang: string,
  ) {
    // Limites globales, puis limites propres à l'utilisateur (admin/settings/limits/:userId)
    const controls = effectiveLimits(
      await loadOperationControls(this.prisma),
      await loadUserLimits(this.prisma, userId),
    );
    const fail = (key: string, statusCode: number, params: Record<string, any> = {}) => {
      throw new RpcException({
        status: 'error',
        code: key.toUpperCase(),
        message: this.i18nService.translate(key, lang, params),
        statusCode,
      });
    };

    if (controls.maintenanceMode) {
      throw new RpcException({
        status: 'error',
        code: 'MAINTENANCE',
        message: controls.maintenanceMessage,
        statusCode: 503,
      });
    }

    if (kind === 'TRANSFER' && !controls.transfersEnabled) fail('operation_disabled_transfer', 403);
    if (kind === 'DEPOSIT' && !controls.depositsEnabled) fail('operation_disabled_deposit', 403);
    if (kind === 'WITHDRAWAL' && !controls.withdrawalsEnabled) fail('operation_disabled_withdrawal', 403);

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) fail('operation_amount_invalid', 400);

    const currency = String(currencyInput || 'USD').toUpperCase() as 'USD' | 'CDF';
    const limits = controls.limits[currency];
    if (!limits) return; // devise non gérée : la validation de devise existante s'en charge

    if (limits.minPerOperation != null && value < limits.minPerOperation) {
      fail('operation_amount_below_min', 400, { min: limits.minPerOperation, currency });
    }
    if (limits.maxPerOperation != null && value > limits.maxPerOperation) {
      fail('operation_amount_above_max', 400, { max: limits.maxPerOperation, currency });
    }

    if (limits.maxDailyPerUser != null && userId) {
      // Opérations du jour (minuit heure de Lubumbashi) tracées après succès bancaire
      const logs = await this.prisma.auditLog.findMany({
        where: { userId, action: kind, createdAt: { gte: startOfLocalDay() } },
        select: { message: true },
      });
      const used = logs.reduce((sum, l) => {
        try {
          const m = JSON.parse(l.message || '{}');
          return String(m.currency || 'USD').toUpperCase() === currency ? sum + Number(m.amount || 0) : sum;
        } catch {
          return sum;
        }
      }, 0);

      if (used + value > limits.maxDailyPerUser) {
        const remaining = Math.max(0, Math.round((limits.maxDailyPerUser - used) * 100) / 100);
        fail('operation_daily_limit_exceeded', 400, {
          limit: limits.maxDailyPerUser,
          used: Math.round(used * 100) / 100,
          remaining,
          currency,
        });
      }
    }
  }

  /**
   * ✅ Vérifie que le compte appartient au client de l'utilisateur.
   *    Les ADMIN / SUPER_ADMIN peuvent consulter tous les comptes.
   */
  private async assertAccountOwnership(accountNumber: string, userId: string | undefined, lang: string) {
    if (!userId) return; // appel interne (pas d'utilisateur) → pas de contrôle
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { clientId: true, role: true },
    });
    if (user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN') return;

    const myAccounts = user?.clientId ? await this.resolveAccountNumbers(user.clientId) : [];
    if (!myAccounts.includes(accountNumber)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('account_access_denied', lang),
        statusCode: 403,
      });
    }
  }

  /**
   * ✅ Vérifie qu'une valeur est bien un numéro de compte bancaire (chiffres
   *    uniquement). Évite de confondre avec une référence de transaction
   *    (ex. TRDR1920231102026144248) ou un id de transaction.
   */
  private assertAccountNumber(value: any, lang: string): string {
    const clean = String(value ?? '').trim();
    if (!/^\d{6,20}$/.test(clean)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('invalid_account_number', lang, { value: clean }),
        statusCode: 400,
      });
    }
    return clean;
  }

  /**
   * Valide la devise bancaire. Défaut 'USD' si absente.
   * La banque n'accepte que USD/CDF.
   */
  private validateBankCurrency(currency?: string): 'USD' | 'CDF' {
    if (!currency) return 'USD';
    const upper = currency.toUpperCase();
    if (!['USD', 'CDF'].includes(upper)) {
      throw new RpcException({
        status: 'error',
        message: `Devise non supportée par la banque: ${currency}. Utilisez USD ou CDF.`,
        statusCode: 422,
      });
    }
    return upper as 'USD' | 'CDF';
  }

  /**
   * Valide la plateforme bancaire. Défaut 'Mobile' si absente.
   */
  private validateBankPlatform(platform?: string): 'Mobile' | 'Online' {
    if (!platform) return 'Mobile';
    if (['Mobile', 'Online'].includes(platform)) {
      return platform as 'Mobile' | 'Online';
    }
    // Tolérance : accepter les enums Prisma transférés
    const p = platform.toLowerCase();
    if (p === 'mobile') return 'Mobile';
    if (p === 'web' || p === 'online') return 'Online';
    return 'Mobile';
  }

  private generateTransactionReference(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `TRX-${timestamp}-${random}`;
  }

  private verifyPin(plainPin: string, hashedPin: string): boolean {
    try {
      const hash = crypto.createHash('sha256').update(plainPin).digest('hex');
      return hash === hashedPin;
    } catch (error) {
      this.logger.error('[Verify PIN] Error:', error);
      return false;
    }
  }

  private async logAudit(
    userId: string | null,
    action: string,
    details: any,
    entity: string,
    entityId: string | null = null,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: userId || undefined,
          action,
          message: details ? JSON.stringify(details) : null,
          entity,
          entityId: entityId || undefined,
          level: 'INFO',
        },
      });
    } catch (err) {
      this.logger.error(`Audit log failed: ${err.message}`);
    }
  }

  private async shouldSendSms(userId: string): Promise<boolean> {
    const settings = await this.prisma.user_settings.findUnique({
      where: { user_id: userId },
      select: { sms_notifications: true },
    });
    return settings?.sms_notifications ?? true;
  }

  private async shouldSendPush(userId: string): Promise<boolean> {
    const settings = await this.prisma.user_settings.findUnique({
      where: { user_id: userId },
      select: { push_notifications: true },
    });
    return settings?.push_notifications ?? true;
  }

  /** Dépendances de notifyBankOperation (SMS + push, réglages et langue de l'utilisateur). */
  private notificationDeps(): BankNotificationDeps {
    return {
      smsService: this.smsService,
      notificationHelper: this.notificationHelper,
      i18nService: this.i18nService,
      shouldSendSms: (id) => this.shouldSendSms(id),
      shouldSendPush: (id) => this.shouldSendPush(id),
      getUserLanguage: (id) => this.getUserLanguage(id),
    };
  }

  private async getUserLanguage(userId: string): Promise<string> {
    const settings = await this.prisma.user_settings.findUnique({
      where: { user_id: userId },
      select: { language: true },
    });
    return settings?.language ?? 'fr';
  }

  /**
   * Résout le clientId bancaire pour un userId local.
   */
  private async resolveClientId(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { clientId: true },
    });
    return user?.clientId ?? null;
  }

  /**
   * Résout la liste des accountNumbers bancaires d'un client
   * ✅ directement depuis l'API bancaire (GetClientAccounts).
   */
  private async resolveAccountNumbers(clientId: string): Promise<string[]> {
    try {
      const accountsRes = await this.bankService.getClientAccounts(clientId);
      let rawAccounts: any = accountsRes?.data?.accounts
        ?? accountsRes?.data
        ?? accountsRes
        ?? [];
      if (typeof rawAccounts === 'string') {
        try { rawAccounts = JSON.parse(rawAccounts); } catch { rawAccounts = []; }
      }
      if (!Array.isArray(rawAccounts)) rawAccounts = [];
      return rawAccounts
        .map((a: any) => String(a?.accountNumber ?? '').trim())
        .filter(Boolean);
    } catch (err) {
      this.logger.warn(
        `[resolveAccountNumbers] GetClientAccounts failed for ${clientId}: ${err?.message || err}`,
      );
      return [];
    }
  }

  /**
   * ✅ Récupère TOUT l'historique d'un compte sur la période (toutes les pages).
   *    La banque renvoie l'historique du plus ANCIEN au plus récent : la page 1
   *    ne contient donc que les plus anciennes opérations. On charge toutes les
   *    pages puis on trie nous-mêmes (plus récent d'abord).
   *    Chaque transaction reçoit un `_seq` = sa position chronologique dans le
   *    compte, utilisé pour départager les dates identiques (la banque renvoie
   *    souvent la même date pour toutes les opérations).
   */
  private async fetchAllAccountTransactions(params: {
    accountNumber: string;
    type?: string;
    status?: string;
    movement?: 'CREDIT' | 'DEBIT';
    startDate?: string;
    endDate?: string;
    lang?: string;
  }): Promise<{ transactions: any[]; total: number }> {
    const pageSize = parseInt(process.env.BANK_HISTORY_PAGE_SIZE || '100', 10);
    const maxPages = parseInt(process.env.BANK_HISTORY_MAX_PAGES || '20', 10);

    const fetchPage = (page: number) =>
      this.bankService.getAccountTransactions({
        accountNumber: params.accountNumber,
        page,
        limit: pageSize,
        type: params.type,
        status: params.status,
        movement: params.movement,
        startDate: params.startDate,
        endDate: params.endDate,
        lang: params.lang,
      });

    const first = await fetchPage(1);
    const firstTx: any[] = first?.data?.transactions ?? [];
    const total: number = first?.data?.pagination?.total ?? firstTx.length;
    const totalPages = Math.min(
      first?.data?.pagination?.totalPages ?? Math.ceil(total / pageSize),
      maxPages,
    );

    const others = totalPages > 1
      ? await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          fetchPage(i + 2).then(r => r?.data?.transactions ?? []),
        ),
      )
      : [];

    const transactions = [firstTx, ...others]
      .flat()
      .map((t, index) => this.normalizeBankTransaction(t, params.accountNumber, index));

    return { transactions, total };
  }

  /** Nettoie une transaction bancaire (espaces, référence vide…). */
  private normalizeBankTransaction(t: any, accountNumber: string, seq: number) {
    const clean = (v: any) => (typeof v === 'string' ? v.trim() : v);
    const reference = clean(t?.reference);
    return {
      ...t,
      id: clean(t?.id),
      reference: reference || clean(t?.id) || null,
      accountNumber: clean(t?.accountNumber) || accountNumber,
      description: clean(t?.description),
      type: clean(t?.type),
      currency: clean(t?.currency),
      _seq: seq,
    };
  }

  /** Tri du plus récent au plus ancien (date, puis ordre chronologique banque). */
  private sortNewestFirst(list: any[]): any[] {
    return list.sort((a, b) => {
      const diff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (diff !== 0 && !isNaN(diff)) return diff;
      return (b._seq ?? 0) - (a._seq ?? 0);
    });
  }

  /** Retire le champ technique `_seq` avant de renvoyer au client. */
  private stripSeq(list: any[]): any[] {
    return list.map(({ _seq, ...rest }) => rest);
  }

  /**
   * Agrège l'historique de plusieurs comptes, trié du plus récent au plus ancien,
   * puis pagine localement.
   */
  private async aggregateAccountsHistory(
    accountNumbers: string[],
    filters: {
      type?: string;
      status?: string;
      movement?: 'CREDIT' | 'DEBIT';
      startDate?: string;
      endDate?: string;
      lang?: string;
    },
    page: number,
    limit: number,
    logTag: string,
  ) {
    let failures = 0;
    let lastError: any = null;

    const results = await Promise.all(
      accountNumbers.map(accountNumber =>
        this.fetchAllAccountTransactions({ accountNumber, ...filters }).catch(err => {
          failures += 1;
          lastError = err;
          this.logger.warn(`[${logTag}] compte ${accountNumber}: ${err.message}`);
          return { transactions: [], total: 0 };
        }),
      ),
    );

    // Tous les comptes en échec → vraie erreur (au lieu d'une liste vide trompeuse)
    if (accountNumbers.length > 0 && failures === accountNumbers.length) {
      if (lastError instanceof RpcException) throw lastError;
      throw new RpcException({
        status: 'error',
        message: lastError?.message || this.i18nService.translate('transactions_list_failed', filters.lang || 'fr'),
        statusCode: 502,
      });
    }

    const all = this.sortNewestFirst(results.flatMap(r => r.transactions));
    const total = all.length;

    return {
      data: this.stripSeq(all.slice((page - 1) * limit, page * limit)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasNextPage: page * limit < total,
      hasPreviousPage: page > 1,
    };
  }

  /**
   * ✅ Crée (ou met à jour) le bénéficiaire après un transfert réussi.
   *    - clé unique : (userId, accountNumber)
   *    - en mise à jour, on ne touche ni au surnom ni au favori choisis par l'utilisateur
   *    - retourne true si le bénéficiaire est enregistré
   */
  private async saveBeneficiary(
    userId: string,
    accountNumber: string,
    currency: string,
    accountName: string,
    bankName: string | undefined,
    phone: string | undefined,
    email: string | undefined,
    nickname: string,
  ): Promise<boolean> {
    const cleanAccountNumber = String(accountNumber || '').trim();
    if (!userId || !cleanAccountNumber) return false;

    const cleanName = String(accountName || '').trim() || cleanAccountNumber;
    const cleanNickname = String(nickname || '').trim() || cleanName;

    try {
      const existing = await this.prisma.beneficiary.findUnique({
        where: {
          userId_accountNumber: { userId, accountNumber: cleanAccountNumber },
        },
      });

      if (!existing) {
        await this.prisma.beneficiary.create({
          data: {
            id: crypto.randomUUID(),
            userId,
            accountNumber: cleanAccountNumber,
            currency: currency || null,
            accountName: cleanName,
            bankName: bankName || null,
            phone: phone || null,
            email: email || null,
            nickname: cleanNickname,
            isFavorite: false,
          },
        });
        this.logger.log(`[Save Beneficiary] Créé : ${cleanAccountNumber} (${cleanName}) pour ${userId}`);
      } else {
        await this.prisma.beneficiary.update({
          where: { userId_accountNumber: { userId, accountNumber: cleanAccountNumber } },
          data: {
            currency: currency || existing.currency,
            accountName: cleanName !== cleanAccountNumber ? cleanName : existing.accountName,
            bankName: bankName || existing.bankName,
            phone: phone || existing.phone,
            email: email || existing.email,
            updatedAt: new Date(),
          },
        });
        this.logger.log(`[Save Beneficiary] Mis à jour : ${cleanAccountNumber} pour ${userId}`);
      }
      return true;
    } catch (error) {
      this.logger.warn(`[Save Beneficiary] Error: ${error.message}`);
      return false;
    }
  }

  /**
 * Normalise un numéro de téléphone au format international.
 * Ex: "971081108" → "+243971081108" (RDC par défaut)
 */
  private normalizePhoneToInternational(
    phone: string,
    defaultCountryCode = '243',
  ): string {
    if (!phone) return '';

    let cleaned = String(phone).trim().replace(/[\s\-().]/g, '');

    // Déjà international avec +
    if (cleaned.startsWith('+')) {
      return '+' + cleaned.substring(1).replace(/[^0-9]/g, '');
    }

    // Nettoyer les caractères non numériques
    cleaned = cleaned.replace(/[^0-9]/g, '');
    if (!cleaned) return '';

    // Commence par 00 (ex: 00243971081108)
    if (cleaned.startsWith('00')) {
      return '+' + cleaned.substring(2);
    }

    // Commence déjà par le code pays sans + (ex: 243971081108)
    if (cleaned.startsWith(defaultCountryCode)) {
      return '+' + cleaned;
    }

    // Commence par 0 (ex: 0971081108)
    if (cleaned.startsWith('0')) {
      return '+' + defaultCountryCode + cleaned.substring(1);
    }

    // Sinon, on ajoute le code pays
    return '+' + defaultCountryCode + cleaned;
  }

  // ========================= TRANSFERT (BANQUE) =========================

  async transfer(data: {
    senderAccountNumber: string;
    receiverAccountNumber: string;
    receiverName?: string;
    receiverPhone?: string;
    receiverEmail?: string;
    amount: number;
    fees?: number;
    description?: string;
    currency?: 'USD' | 'CDF';
    platform?: BankPlatform;
    initiatedBy: string;
    lang?: string;
    saveBeneficiary?: boolean;
    otpCode?: string;   // ✅ seule protection du transfert (le PIN n'est plus demandé)
  }) {
    const lang = data.lang || 'fr';
    // ✅ Tout transfert réussi crée/met à jour le bénéficiaire (le destinataire),
    //    quel que soit saveBeneficiary (conservé dans la signature pour compatibilité).

    try {
      // ─── 0-a. Contrôles admin (maintenance, activation, plafonds) ──
      await this.assertOperationAllowed('TRANSFER', data.initiatedBy, data.amount, data.currency, lang);

      // ─── 0. Utilisateur (le PIN n'est plus demandé : l'OTP suffit) ──
      const user = await this.prisma.user.findUnique({
        where: { id: data.initiatedBy },
        select: {
          status: true,
          phone: true,
          email: true,
          clientId: true,
        },
      });

      if (!user) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('user_not_found', lang), statusCode: 404 });
      }

      // ─── 0-bis. ✅ OTP (même logique que register) ────────────────
      const otpProvided = data.otpCode && String(data.otpCode).trim() !== '';

      // Identifiant OTP : phone normalisé, sinon email, sinon clientId
      const otpIdentifier =
        (user.phone
          ? this.normalizePhoneToInternational(user.phone, '243')
          : '') ||
        user.email ||
        user.clientId ||
        data.initiatedBy;

      // ── Si OTP absent → générer + envoyer + retourner requiresOtp ──
      if (!otpProvided) {
        // Désactiver anciens OTP
        await this.prisma.otp.updateMany({
          where: {
            email: otpIdentifier,
            isUsed: false,
            expiresAt: { gt: new Date() },
          },
          data: { isUsed: true },
        });

        // Générer nouveau OTP
        const newOtpCode = Math.floor(
          100000 + Math.random() * 900000,
        ).toString();

        await this.prisma.otp.create({
          data: {
            id: crypto.randomUUID(),
            email: otpIdentifier,
            otpCode: newOtpCode,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            isUsed: false,
          },
        });

        // SMS OTP
        const clientPhone = user.phone
          ? this.normalizePhoneToInternational(user.phone, '243')
          : '';
        if (clientPhone) {
          try {
            const smsText = this.i18nService.translate('otp_sms_transfer', lang, {
              otpCode: newOtpCode,
              amount: data.amount,
              currency: data.currency || 'USD',
              receiverAccountNumber: data.receiverAccountNumber,
            });
            await this.smsService.sendSms(clientPhone, smsText);
            this.logger.log(`[Transfer] OTP SMS envoyé à ${clientPhone}`);
          } catch (err) {
            this.logger.error(`[Transfer] SMS OTP échoué: ${err.message}`);
          }
        } else {
          this.logger.warn(`[Transfer] Aucun phone pour envoyer OTP`);
        }

        return {
          requiresOtp: true,
          message: this.i18nService.translate('otp_sent', lang),
        };
      }

      // ── Si OTP fourni → vérifier ─────────────────────────────────
      const otpRecord = await this.prisma.otp.findFirst({
        where: {
          email: otpIdentifier,
          otpCode: String(data.otpCode).trim(),
          isUsed: false,
          expiresAt: { gt: new Date() },
        },
      });

      if (!otpRecord) {
        // ✅ Anti force brute : 5 codes faux en 10 min → le code en cours est annulé
        const maxAttempts = parseInt(process.env.TRANSFER_OTP_MAX_ATTEMPTS || '5', 10);
        await this.logAudit(data.initiatedBy, 'TRANSFER_OTP_FAILED', { identifier: otpIdentifier }, 'OTP');
        const failures = await this.prisma.auditLog.count({
          where: {
            userId: data.initiatedBy,
            action: 'TRANSFER_OTP_FAILED',
            createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
          },
        });

        if (failures >= maxAttempts) {
          await this.prisma.otp.updateMany({
            where: { email: otpIdentifier, isUsed: false },
            data: { isUsed: true },
          });
          throw new RpcException({
            status: 'error',
            code: 'OTP_TOO_MANY_ATTEMPTS',
            message: this.i18nService.translate('otp_too_many_attempts', lang),
            statusCode: 429,
          });
        }

        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('otp_invalid_attempts_left', lang, {
            remaining: maxAttempts - failures,
          }),
          statusCode: 400,
        });
      }

      if (!otpRecord.expiresAt || new Date() > otpRecord.expiresAt) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('otp_expired', lang),
          statusCode: 400,
        });
      }

      // Marquer OTP utilisé
      await this.prisma.otp.update({
        where: { id: otpRecord.id },
        data: { isUsed: true },
      });

      // ─── 1. Validation devise (banque = USD/CDF uniquement) ────────
      const currency = (data.currency || 'USD') as 'USD' | 'CDF';
      if (!['USD', 'CDF'].includes(currency)) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_currency_unsupported_by_bank', lang, { currency }),
          statusCode: 422,
        });
      }

      // ─── 2. Appel banque (source de vérité) ────────────────────────
      const bankResult = await this.bankService.bankTransfer({
        senderAccountNumber: data.senderAccountNumber,
        receiverAccountNumber: data.receiverAccountNumber,
        amount: data.amount,
        currency,
        description: data.description,
        platform: data.platform || 'Mobile',
        lang,
      });
      const bankData = bankResult?.data ?? bankResult;

      if (!bankData?.transactionId && bankData?.status !== 'SUCCESS') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_bank_failed', lang),
          statusCode: 502,
        });
      }

      // ─── 3. Bénéficiaire = destinataire (toujours, best-effort) ─────
      const receiverName =
        String(bankData?.beneficiaryName || data.receiverName || '').trim() ||
        String(data.receiverAccountNumber).trim();
      const beneficiarySaved = await this.saveBeneficiary(
        data.initiatedBy,
        bankData?.receiverAccountNumber ?? data.receiverAccountNumber,
        currency,
        receiverName,
        'AccesFinance',
        data.receiverPhone,
        data.receiverEmail,
        String(data.receiverName || '').trim() || receiverName,
      );

      // ─── 4. Audit (local, best-effort) ─────────────────────────────
      await this.logAudit(data.initiatedBy, 'TRANSFER', {
        from: data.senderAccountNumber,
        to: data.receiverAccountNumber,
        receiverName: bankData?.beneficiaryName || data.receiverName || null,
        amount: data.amount,
        fees: bankData?.fees ?? 0,
        currency,
        platform: data.platform || 'Mobile',
        status: bankData?.status ?? 'SUCCESS',
        bankTransactionId: bankData?.transactionId,
        bankReference: bankData?.reference,
      }, 'TRANSFER', bankData?.transactionId ?? null);

      // ─── 5. Notifications : SMS + push (procédure standard AccesFinance) ──
      try {
        const readAccount = async (accountNumber: string) => {
          try {
            const res = await this.bankService.getAccountDetails(accountNumber, undefined, lang);
            let acc: any = res?.data ?? res;
            if (typeof acc === 'string') { try { acc = JSON.parse(acc); } catch { /* */ } }
            return acc;
          } catch (err) {
            this.logger.warn(`[Transfer] GetAccountDetails ${accountNumber} : ${err?.message || err}`);
            return null;
          }
        };
        const clientName = (acc: any) =>
          acc?.client
            ? `${acc.client.firstName || ''} ${acc.client.lastName || ''}`.trim()
            : acc?.clientName || '';

        const [senderAccount, receiverAccount] = await Promise.all([
          readAccount(data.senderAccountNumber),
          readAccount(data.receiverAccountNumber),
        ]);
        const receiverName =
          String(bankData?.beneficiaryName || data.receiverName || clientName(receiverAccount) || '').trim();
        const senderName = clientName(senderAccount);

        const op = {
          id: bankData?.transactionId ?? null,
          reference: bankData?.reference ?? null,
          amount: data.amount,
          currency,
        };

        // Expéditeur
        const sender = await this.prisma.user.findUnique({
          where: { id: data.initiatedBy },
          select: { id: true, phone: true, firstName: true, lastName: true },
        });
        if (sender) {
          await notifyBankOperation(this.notificationDeps(), 'transfer_sent', sender, {
            ...op,
            accountNumber: data.senderAccountNumber,
            balance: bankData?.senderBalance ?? senderAccount?.balance ?? null,
          }, { name: receiverName, accountNumber: data.receiverAccountNumber });
        }

        // Destinataire (s'il utilise l'application)
        const receiverClientId = receiverAccount?.clientId ?? receiverAccount?.client?.clientId;
        if (receiverClientId) {
          const receiverUser = await this.prisma.user.findFirst({
            where: { clientId: String(receiverClientId) },
            select: { id: true, phone: true, firstName: true, lastName: true },
          });
          if (receiverUser && receiverUser.id !== data.initiatedBy) {
            await notifyBankOperation(this.notificationDeps(), 'transfer_received', receiverUser, {
              ...op,
              accountNumber: data.receiverAccountNumber,
              balance: receiverAccount?.balance != null
                ? Number(receiverAccount.balance) + Number(data.amount)
                : null,
            }, { name: senderName, accountNumber: data.senderAccountNumber });
          }
        }
      } catch (notifError) {
        this.logger.warn(`[Notifications] Transfer notification error: ${notifError.message}`);
      }

      // ─── 6. Retour direct de la réponse bancaire ───────────────────
      return {
        success: true,
        message: this.i18nService.translate('transfer_success', lang),
        data: {
          transactionId: bankData?.transactionId,
          transferId: bankData?.transferId,
          reference: bankData?.reference,
          senderAccountNumber: bankData?.senderAccountNumber ?? data.senderAccountNumber,
          receiverAccountNumber: bankData?.receiverAccountNumber ?? data.receiverAccountNumber,
          receiverName: bankData?.beneficiaryName ?? data.receiverName,
          amount: bankData?.amount ?? data.amount,
          fees: bankData?.fees ?? 0,
          totalAmount: bankData?.totalAmount ?? data.amount,
          currency: bankData?.currency ?? currency,
          status: bankData?.status ?? 'SUCCESS',
          senderBalance: bankData?.senderBalance,
          beneficiarySaved,
          processingDateTime: bankData?.processingDateTime,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      this.logger.error('[Transfer] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('transfer_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= DÉPÔT (BANQUE → Topup) =========================

  async deposit(data: {
    accountNumber: string;
    amount: number;
    currency?: 'USD' | 'CDF';
    description?: string;
    initiatedBy?: string;
    lang?: string;
    platform?: BankPlatform;
  }) {
    const lang = data.lang || 'fr';

    try {
      await this.assertOperationAllowed('DEPOSIT', data.initiatedBy, data.amount, data.currency, lang);

      const currency = (data.currency || 'USD') as 'USD' | 'CDF';
      if (!['USD', 'CDF'].includes(currency)) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('deposit_currency_unsupported_by_bank', lang, { currency }),
          statusCode: 422,
        });
      }

      const bankResult = await this.bankService.topup(
        data.accountNumber,
        data.amount,
        currency,
        undefined,
        lang,
        data.platform || 'Mobile',
      );
      const bankData = bankResult?.data ?? bankResult;

      if (bankData?.status && bankData.status !== 'SUCCESS') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('deposit_failed', lang),
          statusCode: 502,
        });
      }

      await this.logAudit(
        data.initiatedBy || null,
        'DEPOSIT',
        {
          accountNumber: data.accountNumber,
          amount: data.amount,
          currency,
          platform: data.platform || 'Mobile',
          status: bankData?.status ?? 'SUCCESS',
          bankTransactionId: bankData?.transactionId ?? null,
          bankReference: bankData?.reference ?? null,
          bankData,
        },
        'ACCOUNT',
        bankData?.transactionId ?? null,
      );

      // Notifications : SMS + push (procédure standard AccesFinance)
      if (data.initiatedBy) {
        const user = await this.prisma.user.findUnique({
          where: { id: data.initiatedBy },
          select: { id: true, phone: true, firstName: true, lastName: true },
        });
        if (user) {
          await notifyBankOperation(this.notificationDeps(), 'deposit', user, {
            id: bankData?.transactionId ?? null,
            reference: bankData?.reference ?? null,
            amount: data.amount,
            currency,
            accountNumber: data.accountNumber,
            balance: bankData?.balance ?? bankData?.newBalance ?? null,
          });
        }
      }

      return {
        success: true,
        message: this.i18nService.translate('deposit_success', lang),
        data: {
          transactionId: bankData?.transactionId,
          reference: bankData?.reference,
          accountNumber: bankData?.accountNumber ?? data.accountNumber,
          amount: bankData?.amount ?? data.amount,
          currency: bankData?.currency ?? currency,
          balance: bankData?.balance ?? bankData?.newBalance,
          status: bankData?.status ?? 'SUCCESS',
          processingDateTime: bankData?.processingDateTime,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      this.logger.error('[Deposit] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('deposit_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= RETRAIT (BANQUE → Cashout) =========================

  async withdraw(data: {
    accountNumber: string;
    amount: number;
    currency?: 'USD' | 'CDF';
    description?: string;
    initiatedBy?: string;
    lang?: string;
    platform?: BankPlatform;
  }) {
    const lang = data.lang || 'fr';

    try {
      await this.assertOperationAllowed('WITHDRAWAL', data.initiatedBy, data.amount, data.currency, lang);

      const currency = (data.currency || 'USD') as 'USD' | 'CDF';
      if (!['USD', 'CDF'].includes(currency)) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('withdraw_currency_unsupported_by_bank', lang, { currency }),
          statusCode: 422,
        });
      }

      const bankResult = await this.bankService.cashout(
        data.accountNumber,
        data.amount,
        currency,
        undefined,
        lang,
        data.platform || 'Mobile',
      );
      const bankData = bankResult?.data ?? bankResult;

      if (bankData?.status && bankData.status !== 'SUCCESS') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('withdraw_failed', lang),
          statusCode: 502,
        });
      }

      await this.logAudit(
        data.initiatedBy || null,
        'WITHDRAWAL',
        {
          accountNumber: data.accountNumber,
          amount: data.amount,
          currency,
          platform: data.platform || 'Mobile',
          status: bankData?.status ?? 'SUCCESS',
          bankTransactionId: bankData?.transactionId ?? null,
          bankReference: bankData?.reference ?? null,
          bankData,
        },
        'ACCOUNT',
        bankData?.transactionId ?? null,
      );

      // Notifications : SMS + push (procédure standard AccesFinance)
      if (data.initiatedBy) {
        const user = await this.prisma.user.findUnique({
          where: { id: data.initiatedBy },
          select: { id: true, phone: true, firstName: true, lastName: true },
        });
        if (user) {
          await notifyBankOperation(this.notificationDeps(), 'withdrawal', user, {
            id: bankData?.transactionId ?? null,
            reference: bankData?.reference ?? null,
            amount: data.amount,
            currency,
            accountNumber: data.accountNumber,
            balance: bankData?.balance ?? bankData?.newBalance ?? null,
          });
        }
      }

      return {
        success: true,
        message: this.i18nService.translate('withdraw_success', lang),
        data: {
          transactionId: bankData?.transactionId,
          reference: bankData?.reference,
          accountNumber: bankData?.accountNumber ?? data.accountNumber,
          amount: bankData?.amount ?? data.amount,
          currency: bankData?.currency ?? currency,
          balance: bankData?.balance ?? bankData?.newBalance,
          status: bankData?.status ?? 'SUCCESS',
          processingDateTime: bankData?.processingDateTime,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      this.logger.error('[Withdraw] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('withdraw_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= RELEVÉ (BANQUE) =========================

  async getAccountStatement(accountNumber: string, params?: {
    userId?: string;
    startDate?: string;
    endDate?: string;
    page?: number;
    limit?: number;
    type?: string;
    status?: string;
    movement?: 'CREDIT' | 'DEBIT';
    lang?: string;
  }) {
    const lang = params?.lang || 'fr';
    const page = params?.page || 1;
    const limit = params?.limit || 50;

    try {
      accountNumber = this.assertAccountNumber(accountNumber, lang);
      await this.assertAccountOwnership(accountNumber, params?.userId, lang);
      const res = await this.bankService.getAccountTransactions({
        accountNumber,
        page,
        limit,
        startDate: params?.startDate,
        endDate: params?.endDate,
        type: params?.type,
        status: params?.status,
        movement: params?.movement,
        lang,
      });

      const transactions = res?.data?.transactions ?? [];
      const pagination = res?.data?.pagination ?? { page, limit, total: 0, totalPages: 0 };

      // Agrégats sur la page (la banque ne renvoie pas d'agrégat global)
      const totalDebit = transactions
        .filter(t => t.movement === 'DEBIT')
        .reduce((s, t) => s + Number(t.amount || 0), 0);
      const totalCredit = transactions
        .filter(t => t.movement === 'CREDIT')
        .reduce((s, t) => s + Number(t.amount || 0), 0);

      // Infos compte (via GetAccountDetails)
      let accountInfo: any = { accountNumber };
      try {
        const acc = await this.bankService.getAccountDetails(accountNumber, undefined, lang);
        accountInfo = {
          accountNumber: acc?.data?.accountNumber ?? accountNumber,
          clientId: acc?.data?.clientId,
          accountType: acc?.data?.accountType,
          currency: acc?.data?.currency,
          balance: acc?.data?.balance,
          status: acc?.data?.status,
          clientName: acc?.data?.client
            ? `${acc.data.client.firstName || ''} ${acc.data.client.lastName || ''}`.trim()
            : undefined,
        };
      } catch (e) {
        this.logger.warn(`[getAccountStatement] GetAccountDetails échoué: ${e.message}`);
      }

      return {
        success: true,
        message: this.i18nService.translate('statement_success', lang),
        data: {
          account: accountInfo,
          statement: transactions,
          total: pagination.total,
          page: pagination.page,
          limit: pagination.limit,
          totalPages: pagination.totalPages,
          hasNextPage: pagination.page < pagination.totalPages,
          hasPreviousPage: pagination.page > 1,
          summary: {
            totalTransactions: pagination.total,
            totalDebit,
            totalCredit,
            netChange: totalCredit - totalDebit,
            startDate: params?.startDate || null,
            endDate: params?.endDate || null,
          },
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      this.logger.error('[Get Account Statement] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('statement_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= TRANSACTIONS (BANQUE) =========================

  /**
   * Extrait la transaction de la réponse GetTransactionDetails, quelle que soit
   * sa forme : { data: {...} }, { data: { transaction: {...} } }, tableau,
   * chaîne JSON, champ id / transactionId / TransactionId…
   */
  private extractBankTransaction(res: any): any | null {
    let t: any = res?.data ?? res;
    if (typeof t === 'string') {
      try { t = JSON.parse(t); } catch { return null; }
    }
    if (t?.transaction) t = t.transaction;
    if (Array.isArray(t?.transactions)) t = t.transactions[0];
    if (Array.isArray(t)) t = t[0];
    if (!t || typeof t !== 'object') return null;

    const id = t.id ?? t.transactionId ?? t.TransactionId ?? t.Id ?? t.ID;
    if (id === undefined || id === null || String(id).trim() === '') return null;
    return { ...t, id: String(id).trim() };
  }

  /**
   * Cherche une transaction dans l'historique des comptes de l'utilisateur
   * (par id ou par référence). Sert de secours si GetTransactionDetails échoue.
   */
  private async findInUserHistory(userId: string, id: string, lang: string): Promise<any | null> {
    const clientId = await this.resolveClientId(userId);
    if (!clientId) return null;
    const accountNumbers = await this.resolveAccountNumbers(clientId);
    if (accountNumbers.length === 0) return null;

    const wanted = String(id).trim();
    const results = await Promise.all(
      accountNumbers.map(accountNumber =>
        this.fetchAllAccountTransactions({ accountNumber, lang })
          .catch(() => ({ transactions: [] as any[], total: 0 })),
      ),
    );
    const found = results
      .flatMap(r => r.transactions)
      .find(t => String(t.id) === wanted || String(t.reference) === wanted);
    if (!found) return null;
    const { _seq, ...tx } = found;
    return tx;
  }

  /**
   * Récupère une transaction et vérifie qu'elle appartient à l'utilisateur.
   * 1. GetTransactionDetails (banque)
   * 2. Secours : recherche dans l'historique des comptes de l'utilisateur
   */
  private async fetchOwnedTransaction(id: string, lang: string, userId?: string) {
    const wanted = String(id).trim();
    let tx: any = null;

    try {
      const res = await this.bankService.getTransactionDetails(wanted, lang);
      const raw = this.extractBankTransaction(res);
      if (raw) {
        tx = this.normalizeBankTransaction(raw, String(raw.accountNumber ?? '').trim(), 0);
        delete tx._seq;
      } else {
        this.logger.warn(
          `[fetchOwnedTransaction] GetTransactionDetails ${wanted} : réponse sans transaction exploitable`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[fetchOwnedTransaction] GetTransactionDetails ${wanted} échoué : ${err?.message || err}`,
      );
    }

    // ✅ Secours : historique de l'utilisateur (l'appartenance est alors garantie)
    if (!tx && userId) {
      const fromHistory = await this.findInUserHistory(userId, wanted, lang);
      if (fromHistory) return fromHistory;
    }

    if (!tx) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('transaction_not_found', lang),
        statusCode: 404,
      });
    }

    // ✅ Contrôle d'appartenance
    if (userId) {
      const accountNumber = String(tx.accountNumber || '').trim();
      if (accountNumber) {
        const clientId = await this.resolveClientId(userId);
        const myAccounts = clientId ? await this.resolveAccountNumbers(clientId) : [];
        if (!myAccounts.includes(accountNumber)) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('account_access_denied', lang),
            statusCode: 403,
          });
        }
      } else {
        // Pas de numéro de compte dans le détail → on confirme via l'historique
        const fromHistory = await this.findInUserHistory(userId, wanted, lang);
        if (!fromHistory) {
          throw new RpcException({
            status: 'error',
            message: this.i18nService.translate('transaction_not_found', lang),
            statusCode: 404,
          });
        }
        return { ...fromHistory, ...tx, accountNumber: fromHistory.accountNumber };
      }
    }

    return tx;
  }

  private formatTransaction(t: any) {
    return {
      id: t.id,
      reference: t.reference,
      accountNumber: t.accountNumber || null,
      type: t.type,
      movement: t.movement,
      amount: t.amount,
      currency: t.currency,
      balanceBefore: t.balanceBefore,
      balanceAfter: t.balanceAfter,
      status: t.status,
      description: t.description,
      createdAt: t.createdAt,
    };
  }

  async getTransactionById(id: string, lang = 'fr', userId?: string) {
    const t = await this.fetchOwnedTransaction(id, lang, userId);
    return {
      success: true,
      message: this.i18nService.translate('transaction_retrieved', lang),
      data: this.formatTransaction(t),
    };
  }

  async getTransactionsByAccount(accountNumber: string, params?: {
    userId?: string;
    page?: number;
    limit?: number;
    type?: string;
    status?: string;
    movement?: 'CREDIT' | 'DEBIT';
    startDate?: string;
    endDate?: string;
    lang?: string;
  }) {
    const lang = params?.lang || 'fr';
    const page = params?.page || 1;
    const limit = params?.limit || 10;

    try {
      const cleanAccountNumber = this.assertAccountNumber(accountNumber, lang);
      await this.assertAccountOwnership(cleanAccountNumber, params?.userId, lang);

      // ✅ Plus récent d'abord (la banque renvoie du plus ancien au plus récent)
      const data = await this.aggregateAccountsHistory(
        [cleanAccountNumber],
        {
          type: params?.type,
          status: params?.status,
          movement: params?.movement,
          startDate: params?.startDate,
          endDate: params?.endDate,
          lang,
        },
        page,
        limit,
        'getTransactionsByAccount',
      );

      return {
        success: true,
        message: this.i18nService.translate('transactions_list_success', lang),
        data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      this.logger.error('[Get Transactions By Account] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('transactions_list_failed', lang),
        statusCode: 500,
      });
    }
  }

  async getTransactionsByUserId(userId: string, params?: {
    page?: number;
    limit?: number;
    type?: string;
    status?: string;
    movement?: 'CREDIT' | 'DEBIT';
    startDate?: string;
    endDate?: string;
    lang?: string;
  }) {
    const lang = params?.lang || 'fr';
    const page = params?.page || 1;
    const limit = params?.limit || 10;

    const empty = {
      success: true,
      message: this.i18nService.translate('transactions_list_success', lang),
      data: { data: [], total: 0, page, limit, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
    };

    const clientId = await this.resolveClientId(userId);
    if (!clientId) return empty;

    const accountNumbers = await this.resolveAccountNumbers(clientId);
    if (accountNumbers.length === 0) return empty;

    // ✅ Historique complet de chaque compte, trié du plus récent au plus ancien
    const data = await this.aggregateAccountsHistory(
      accountNumbers,
      {
        type: params?.type,
        status: params?.status,
        movement: params?.movement,
        startDate: params?.startDate,
        endDate: params?.endDate,
        lang,
      },
      page,
      limit,
      'getTransactionsByUserId',
    );

    return {
      success: true,
      message: this.i18nService.translate('transactions_list_success', lang),
      data,
    };
  }

  // ========================= TRANSFERTS (BANQUE) =========================

  async getTransferById(id: string, lang = 'fr', userId?: string) {
    const t = await this.fetchOwnedTransaction(id, lang, userId);

    if (t.type && String(t.type).toUpperCase() !== 'TRANSFER') {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('transfer_not_found', lang),
        statusCode: 404,
      });
    }

    return {
      success: true,
      message: this.i18nService.translate('transfer_retrieved', lang),
      data: this.formatTransaction(t),
    };
  }

  async getTransfersByAccount(accountNumber: string, params?: {
    userId?: string;
    page?: number;
    limit?: number;
    status?: string;
    startDate?: string;
    endDate?: string;
    lang?: string;
  }) {
    const lang = params?.lang || 'fr';

    const cleanAccountNumber = this.assertAccountNumber(accountNumber, lang);
    await this.assertAccountOwnership(cleanAccountNumber, params?.userId, lang);

    const data = await this.aggregateAccountsHistory(
      [cleanAccountNumber],
      {
        type: 'TRANSFER',
        status: params?.status,
        startDate: params?.startDate,
        endDate: params?.endDate,
        lang,
      },
      params?.page || 1,
      params?.limit || 10,
      'getTransfersByAccount',
    );

    return {
      success: true,
      message: this.i18nService.translate('transfers_list_success', lang),
      data,
    };
  }

  async getTransfersByUser(userId: string, params?: {
    page?: number;
    limit?: number;
    status?: string;
    startDate?: string;
    endDate?: string;
    lang?: string;
  }) {
    const lang = params?.lang || 'fr';
    const page = params?.page || 1;
    const limit = params?.limit || 10;

    const empty = {
      success: true,
      message: this.i18nService.translate('transfers_list_success', lang),
      data: { data: [], total: 0, page, limit, totalPages: 0, hasNextPage: false, hasPreviousPage: false },
    };

    const clientId = await this.resolveClientId(userId);
    if (!clientId) return empty;

    const accountNumbers = await this.resolveAccountNumbers(clientId);
    if (accountNumbers.length === 0) return empty;

    const data = await this.aggregateAccountsHistory(
      accountNumbers,
      {
        type: 'TRANSFER',
        status: params?.status,
        startDate: params?.startDate,
        endDate: params?.endDate,
        lang,
      },
      page,
      limit,
      'getTransfersByUser',
    );

    return {
      success: true,
      message: this.i18nService.translate('transfers_list_success', lang),
      data,
    };
  }

  // ========================= BALANCE (BANQUE) =========================

  async getBalance(data: {
    accountNumber: string;
    userId: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';

    try {
      // ✅ 1. Récupérer le user (mapping local userId → clientId)
      const user = await this.prisma.user.findUnique({
        where: { id: data.userId },
        select: { clientId: true },
      });
      if (!user?.clientId) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('user_not_found', lang),
          statusCode: 404,
        });
      }

      // ✅ 2. Le paramètre doit être un numéro de compte (chiffres uniquement)
      const cleanAccountNumber = this.assertAccountNumber(data.accountNumber, lang);

      // ✅ 3. Récupérer le compte depuis l'API bancaire (source de vérité)
      const accRes = await this.bankService.getAccountDetails(
        cleanAccountNumber, undefined, lang,
      );
      const acc = accRes?.data ?? accRes;

      if (!acc || !acc.accountNumber) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_not_found', lang),
          statusCode: 404,
        });
      }

      // ✅ 4. Vérifier l'appartenance (clientId bancaire)
      if (String(acc.clientId) !== String(user.clientId)) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_access_denied', lang),
          statusCode: 403,
        });
      }

      // ✅ 5. 5 DERNIÈRES transactions (la banque renvoie du plus ancien au plus récent)
      let lastTransactions: any[] = [];
      try {
        const history = await this.fetchAllAccountTransactions({
          accountNumber: cleanAccountNumber,
          lang,
        });
        lastTransactions = this.stripSeq(
          this.sortNewestFirst(history.transactions).slice(0, 5),
        );
      } catch (err) {
        this.logger.warn(`[Get Balance] historique indisponible: ${err?.message || err}`);
      }

      const balance = Number(acc?.balance ?? 0);
      const currency = acc?.currency ?? 'XAF';
      const clientName = acc?.client
        ? `${acc.client.firstName || ''} ${acc.client.lastName || ''}`.trim()
        : 'Unknown';

      return {
        success: true,
        message: this.i18nService.translate('balance_retrieved', lang),
        data: {
          account: {
            accountNumber: String(acc?.accountNumber ?? '').trim(),
            accountType: acc?.accountType ?? null,
            clientId: acc?.clientId ?? user.clientId,
            clientName,
            currency,
            status: acc?.status ?? null,
          },
          balance: {
            current: balance,
            formatted: new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(balance),
          },
          lastTransactions,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      this.logger.error('[Get Balance] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('balance_failed', lang),
        statusCode: 500,
      });
    }
  }
  // ========================= STATISTIQUES =========================

  async getTransactionStats(userId: string, days = 30, lang = 'fr') {
    const clientId = await this.resolveClientId(userId);
    if (!clientId) {
      return { period: `${days} ${this.i18nService.translate('stats_period', lang)}`, totalTransactions: 0, totalAmount: 0, byType: [], recent: [] };
    }
    const accountNumbers = await this.resolveAccountNumbers(clientId);
    if (accountNumbers.length === 0) {
      return { period: `${days} ${this.i18nService.translate('stats_period', lang)}`, totalTransactions: 0, totalAmount: 0, byType: [], recent: [] };
    }

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    const results = await Promise.all(
      accountNumbers.map(accountNumber =>
        this.fetchAllAccountTransactions({
          accountNumber,
          startDate: startStr,
          endDate: endStr,
          lang,
        }).catch(() => ({ transactions: [] as any[], total: 0 })),
      ),
    );

    const all = this.sortNewestFirst(results.flatMap(r => r.transactions));

    const totalTransactions = all.length;
    const totalAmount = all.reduce((s, t) => s + Number(t.amount || 0), 0);

    const byTypeMap: Record<string, { count: number; amount: number }> = {};
    for (const t of all) {
      const key = t.type || 'UNKNOWN';
      if (!byTypeMap[key]) byTypeMap[key] = { count: 0, amount: 0 };
      byTypeMap[key].count += 1;
      byTypeMap[key].amount += Number(t.amount || 0);
    }

    const recent = this.stripSeq(all.slice(0, 10));

    return {
      period: `${days} ${this.i18nService.translate('stats_period', lang)}`,
      totalTransactions,
      totalAmount,
      byType: Object.entries(byTypeMap).map(([type, v]) => ({
        type: this.i18nService.translate(`transaction_type_${type}`, lang),
        count: v.count,
        amount: v.amount,
      })),
      recent,
    };
  }

  // ========================= BÉNÉFICIAIRES (inchangés, local) =========================

  async listBeneficiaries(data: {
    userId: string;
    page?: number;
    limit?: number;
    search?: string;
    isFavorite?: boolean;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';
    const page = data.page || 1;
    const limit = data.limit || 10;
    const skip = (page - 1) * limit;

    try {
      const where: any = { userId: data.userId };
      if (data.search) {
        where.OR = [
          { accountName: { contains: data.search, mode: 'insensitive' } },
          { accountNumber: { contains: data.search, mode: 'insensitive' } },
          { bankName: { contains: data.search, mode: 'insensitive' } },
          { nickname: { contains: data.search, mode: 'insensitive' } },
          { phone: { contains: data.search, mode: 'insensitive' } },
          { email: { contains: data.search, mode: 'insensitive' } },
        ];
      }
      if (data.isFavorite !== undefined) where.isFavorite = data.isFavorite;

      const [beneficiaries, total] = await this.prisma.$transaction([
        this.prisma.beneficiary.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: limit,
        }),
        this.prisma.beneficiary.count({ where }),
      ]);

      return {
        success: true,
        message: this.i18nService.translate('beneficiaries_list_success', lang),
        data: {
          data: beneficiaries,
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      this.logger.error('[List Beneficiaries] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('beneficiaries_list_failed', lang),
        statusCode: 500,
      });
    }
  }

  async getBeneficiaryById(id: string, userId: string, lang: string) {
    try {
      const beneficiary = await this.prisma.beneficiary.findUnique({ where: { id } });
      if (!beneficiary) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_not_found', lang), statusCode: 404 });
      }
      if (beneficiary.userId !== userId) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_access_denied', lang), statusCode: 403 });
      }
      return { success: true, message: this.i18nService.translate('beneficiary_found', lang), data: beneficiary };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('beneficiary_get_failed', lang),
        statusCode: 500,
      });
    }
  }

  async createBeneficiary(data: {
    userId: string;
    accountNumber: string;
    accountName: string;
    bankName?: string;
    phone?: string;
    email?: string;
    nickname?: string;
    isFavorite?: boolean;
    currency?: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';
    try {
      const user = await this.prisma.user.findUnique({ where: { id: data.userId }, select: { id: true } });
      if (!user) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('user_not_found', lang), statusCode: 404 });
      }

      const existing = await this.prisma.beneficiary.findUnique({
        where: { userId_accountNumber: { userId: data.userId, accountNumber: data.accountNumber } },
      });
      if (existing) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_already_exists', lang), statusCode: 409 });
      }

      const beneficiary = await this.prisma.beneficiary.create({
        data: {
          id: crypto.randomUUID(),
          userId: data.userId,
          accountNumber: data.accountNumber,
          accountName: data.accountName,
          bankName: data.bankName || null,
          phone: data.phone || null,
          email: data.email || null,
          nickname: data.nickname || data.accountName,
          currency: data.currency,
          isFavorite: data.isFavorite || false,
        },
      });

      return { success: true, message: this.i18nService.translate('beneficiary_created', lang), data: beneficiary };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('beneficiary_create_failed', lang),
        statusCode: 500,
      });
    }
  }

  async updateBeneficiary(data: {
    id: string;
    userId: string;
    accountName?: string;
    bankName?: string;
    phone?: string;
    email?: string;
    nickname?: string;
    isFavorite?: boolean;
    currency?: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';
    try {
      const existing = await this.prisma.beneficiary.findUnique({ where: { id: data.id } });
      if (!existing) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_not_found', lang), statusCode: 404 });
      }
      if (existing.userId !== data.userId) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_access_denied', lang), statusCode: 403 });
      }
      const updateData: any = {};
      if (data.accountName !== undefined) updateData.accountName = data.accountName;
      if (data.bankName !== undefined) updateData.bankName = data.bankName;
      if (data.phone !== undefined) updateData.phone = data.phone;
      if (data.email !== undefined) updateData.email = data.email;
      if (data.nickname !== undefined) updateData.nickname = data.nickname;
      if (data.currency !== undefined) updateData.currency = data.currency;
      if (data.isFavorite !== undefined) updateData.isFavorite = data.isFavorite;
      updateData.updatedAt = new Date();

      const updated = await this.prisma.beneficiary.update({ where: { id: data.id }, data: updateData });
      return { success: true, message: this.i18nService.translate('beneficiary_updated', lang), data: updated };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('beneficiary_update_failed', lang),
        statusCode: 500,
      });
    }
  }

  async deleteBeneficiary(data: { id: string; userId: string; lang?: string }) {
    const lang = data.lang || 'fr';
    try {
      const existing = await this.prisma.beneficiary.findUnique({ where: { id: data.id } });
      if (!existing) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_not_found', lang), statusCode: 404 });
      }
      if (existing.userId !== data.userId) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_access_denied', lang), statusCode: 403 });
      }
      await this.prisma.beneficiary.delete({ where: { id: data.id } });
      return { success: true, message: this.i18nService.translate('beneficiary_deleted', lang) };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('beneficiary_delete_failed', lang),
        statusCode: 500,
      });
    }
  }

  async toggleFavorite(data: { id: string; userId: string; lang?: string }) {
    const lang = data.lang || 'fr';
    try {
      const existing = await this.prisma.beneficiary.findUnique({ where: { id: data.id } });
      if (!existing) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_not_found', lang), statusCode: 404 });
      }
      if (existing.userId !== data.userId) {
        throw new RpcException({ status: 'error', message: this.i18nService.translate('beneficiary_access_denied', lang), statusCode: 403 });
      }
      const updated = await this.prisma.beneficiary.update({
        where: { id: data.id },
        data: { isFavorite: !existing.isFavorite, updatedAt: new Date() },
      });
      return {
        success: true,
        message: this.i18nService.translate(updated.isFavorite ? 'beneficiary_favorite_added' : 'beneficiary_favorite_removed', lang),
        data: updated,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('beneficiary_toggle_favorite_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= COMPTE (API bancaire) =========================
  async getAccountById(data: { accountId: string; userId: string; lang?: string }) {
    const lang = data.lang || 'fr';
    try {
      // ✅ L'identifiant d'un compte est son numéro bancaire (aucune table locale)
      const accountNumber = await this.resolveAccountNumber({ accountId: data.accountId, lang });

      // ✅ Récupérer depuis l'API
      const accRes = await this.bankService.getAccountDetails(accountNumber, undefined, lang);
      const acc = accRes?.data ?? accRes;
      if (!acc || !acc.accountNumber) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_not_found', lang),
          statusCode: 404,
        });
      }

      // ✅ Vérifier l'accès
      const user = await this.prisma.user.findUnique({
        where: { id: data.userId },
        select: { clientId: true },
      });
      if (!user || String(acc.clientId) !== String(user.clientId)) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_access_denied', lang),
          statusCode: 403,
        });
      }

      return {
        success: true,
        message: this.i18nService.translate('account_retrieved', lang),
        data: {
          accountNumber: String(acc.accountNumber).trim(),
          clientId: acc.clientId ?? null,
          accountType: acc.accountType ?? null,
          currency: acc.currency ?? null,
          balance: acc.balance ?? 0,
          status: acc.status ?? null,
          isMain: (acc.accountType || '').toLowerCase().includes('pargne'),
          client: acc.client ? {
            clientId: acc.client.clientId,
            firstName: acc.client.firstName,
            lastName: acc.client.lastName,
            nickName: acc.client.nickName,
            email: acc.client.email,
            phone: acc.client.phone,
            status: acc.client.status,
          } : null,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('account_get_failed', lang),
        statusCode: 500,
      });
    }
  }


  // ═══════════════════════════════════════════════════════════════
  // ADMIN — CLIENTS & COMPTES BANCAIRES (aucun contrôle d'appartenance :
  //         réservé aux ADMIN / SUPER_ADMIN, vérifié par l'API gateway)
  // ═══════════════════════════════════════════════════════════════

  private async localUserByClientId(clientId: string) {
    if (!clientId) return null;
    return this.prisma.user.findFirst({
      where: { clientId: String(clientId).trim() },
      select: {
        id: true, clientId: true, firstName: true, lastName: true, phone: true, email: true,
        role: true, status: true, pinStatus: true, failedPinAttempts: true, pinLockedUntil: true,
        lastLoginAt: true, createdAt: true, approvedAt: true, mustChangePassword: true,
      },
    });
  }

  async adminGetClient(clientId: string, lang = 'fr') {
    const cleanClientId = String(clientId || '').trim();
    if (!cleanClientId) {
      throw new RpcException({ status: 'error', message: 'clientId is required', statusCode: 400 });
    }

    const [detailsRes, accountsRes, localUser] = await Promise.all([
      this.bankService.getClientDetails(cleanClientId, undefined, lang).catch((e) => ({ __error: e })),
      this.bankService.getClientAccounts(cleanClientId, undefined, lang).catch((e) => ({ __error: e })),
      this.localUserByClientId(cleanClientId),
    ]);

    const parse = (res: any) => {
      if (res?.__error) return null;
      let v = res?.data ?? res;
      if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* */ } }
      return v;
    };
    const details = parse(detailsRes);
    const accountsData = parse(accountsRes);
    let accounts: any[] = accountsData?.accounts ?? (Array.isArray(accountsData) ? accountsData : []);
    accounts = accounts.map((a: any) => ({
      accountNumber: String(a?.accountNumber ?? '').trim(),
      accountType: a?.accountType ?? null,
      currency: a?.currency ?? null,
      balance: a?.balance ?? null,
      status: a?.status ?? null,
    }));

    if (!details && accounts.length === 0 && !localUser) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('admin_client_not_found', lang),
        statusCode: 404,
      });
    }

    const beneficiariesCount = localUser
      ? await this.prisma.beneficiary.count({ where: { userId: localUser.id } })
      : 0;

    // Totaux par devise
    const balances: Record<string, number> = {};
    for (const a of accounts) {
      const cur = String(a.currency || '?');
      balances[cur] = Math.round(((balances[cur] || 0) + Number(a.balance || 0)) * 100) / 100;
    }

    return {
      success: true,
      message: this.i18nService.translate('client_retrieved_success', lang),
      data: {
        clientId: cleanClientId,
        bankClient: details,
        accounts,
        balances,
        appUser: localUser,
        hasAppAccount: !!localUser,
        beneficiariesCount,
        bankErrors: {
          details: (detailsRes as any)?.__error?.message ?? null,
          accounts: (accountsRes as any)?.__error?.message ?? null,
        },
      },
    };
  }

  async adminGetAccount(accountNumber: string, lang = 'fr') {
    const cleanAccountNumber = this.assertAccountNumber(accountNumber, lang);
    const accRes = await this.bankService.getAccountDetails(cleanAccountNumber, undefined, lang);
    let acc: any = accRes?.data ?? accRes;
    if (typeof acc === 'string') { try { acc = JSON.parse(acc); } catch { /* */ } }

    if (!acc || !acc.accountNumber) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('account_not_found', lang),
        statusCode: 404,
      });
    }

    let lastTransactions: any[] = [];
    try {
      const history = await this.fetchAllAccountTransactions({ accountNumber: cleanAccountNumber, lang });
      lastTransactions = this.stripSeq(this.sortNewestFirst(history.transactions).slice(0, 10));
    } catch (err) {
      this.logger.warn(`[adminGetAccount] historique indisponible: ${err?.message || err}`);
    }

    const clientId = acc.clientId ?? acc.client?.clientId ?? null;
    return {
      success: true,
      message: this.i18nService.translate('account_retrieved', lang),
      data: {
        account: {
          accountNumber: String(acc.accountNumber).trim(),
          clientId,
          accountType: acc.accountType ?? null,
          currency: acc.currency ?? null,
          balance: acc.balance ?? null,
          status: acc.status ?? null,
          client: acc.client ?? null,
        },
        appUser: clientId ? await this.localUserByClientId(String(clientId)) : null,
        lastTransactions,
      },
    };
  }

  async adminAccountTransactions(accountNumber: string, params: any = {}) {
    const { userId, ...rest } = params || {};
    return this.getTransactionsByAccount(accountNumber, rest);
  }

  async adminAccountStatement(accountNumber: string, params: any = {}) {
    const { userId, ...rest } = params || {};
    return this.getAccountStatement(accountNumber, rest);
  }

  async adminUserTransactions(userId: string, params: any = {}) {
    return this.getTransactionsByUserId(userId, params);
  }

  async adminUserBeneficiaries(params: {
    userId: string; page?: number; limit?: number; search?: string; lang?: string;
  }) {
    return this.listBeneficiaries(params);
  }

  /** Détail d'une transaction ; `accountNumber` permet de la chercher dans l'historique. */
  async adminGetTransaction(id: string, accountNumber?: string, lang = 'fr') {
    try {
      return await this.getTransactionById(id, lang);
    } catch (err) {
      if (!accountNumber) throw err;
      const cleanAccountNumber = this.assertAccountNumber(accountNumber, lang);
      const history = await this.fetchAllAccountTransactions({ accountNumber: cleanAccountNumber, lang });
      const wanted = String(id).trim();
      const found = history.transactions.find(
        (t) => String(t.id) === wanted || String(t.reference) === wanted,
      );
      if (!found) throw err;
      const { _seq, ...tx } = found;
      return {
        success: true,
        message: this.i18nService.translate('transaction_retrieved', lang),
        data: this.formatTransaction(tx),
      };
    }
  }

  /** Export CSV de l'historique d'un compte (toutes les pages, plus récent d'abord). */
  async adminAccountTransactionsCsv(accountNumber: string, params: {
    startDate?: string; endDate?: string; type?: string; status?: string;
    movement?: 'CREDIT' | 'DEBIT'; lang?: string;
  } = {}) {
    const lang = params.lang || 'fr';
    const cleanAccountNumber = this.assertAccountNumber(accountNumber, lang);
    const history = await this.fetchAllAccountTransactions({
      accountNumber: cleanAccountNumber,
      startDate: params.startDate,
      endDate: params.endDate,
      type: params.type,
      status: params.status,
      movement: params.movement,
      lang,
    });
    const rows = this.stripSeq(this.sortNewestFirst(history.transactions));

    const esc = (v: any) => {
      const str = v === null || v === undefined ? '' : String(v);
      return /[";\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const header = ['Date', 'Id', 'Référence', 'Type', 'Mouvement', 'Montant', 'Devise',
      'Solde avant', 'Solde après', 'Statut', 'Description'];
    const lines = rows.map((t: any) => [
      t.createdAt, t.id, t.reference, t.type, t.movement, t.amount, t.currency,
      t.balanceBefore, t.balanceAfter, t.status, t.description,
    ].map(esc).join(';'));

    const today = new Date().toISOString().slice(0, 10);
    return {
      success: true,
      message: this.i18nService.translate('transactions_list_success', lang),
      data: {
        filename: `historique_${cleanAccountNumber}_${today}.csv`,
        contentType: 'text/csv; charset=utf-8',
        rows: rows.length,
        content: '\uFEFF' + [header.join(';'), ...lines].join('\r\n'),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // RELEVÉ DE COMPTE PDF — gabarit officiel AccesFinance
  // ═══════════════════════════════════════════════════════════════

  /**
   * Génère le relevé PDF d'un compte.
   *  - userId fourni → le compte doit appartenir à l'utilisateur (sauf ADMIN / SUPER_ADMIN)
   *  - sendEmail → le PDF est aussi envoyé à l'email du client
   */
  async generateStatementPdf(params: {
    accountNumber: string;
    userId?: string;
    startDate?: string;
    endDate?: string;
    lang?: string;
    sendEmail?: boolean;
    email?: string;
  }) {
    const lang = ['fr', 'en', 'sw'].includes(params.lang || '') ? (params.lang as string) : 'fr';
    const L = statementLabels(lang);
    const accountNumber = this.assertAccountNumber(params.accountNumber, lang);
    await this.assertAccountOwnership(accountNumber, params.userId, lang);

    const isDay = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if ((params.startDate && !isDay(params.startDate)) || (params.endDate && !isDay(params.endDate))) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('statement_invalid_dates', lang),
        statusCode: 400,
      });
    }

    // 1. Compte (banque)
    const accRes = await this.bankService.getAccountDetails(accountNumber, undefined, lang);
    let acc: any = accRes?.data ?? accRes;
    if (typeof acc === 'string') { try { acc = JSON.parse(acc); } catch { /* */ } }
    if (!acc || !acc.accountNumber) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('account_not_found', lang),
        statusCode: 404,
      });
    }
    const clientId = String(acc.clientId ?? acc.client?.clientId ?? '').trim();
    const localUser = clientId
      ? await this.prisma.user.findFirst({
          where: { clientId },
          select: { firstName: true, lastName: true, phone: true, email: true },
        })
      : null;
    const currency = String(acc.currency || 'USD').toUpperCase();

    // 2. Historique complet (banque), ordre chronologique
    const history = await this.fetchAllAccountTransactions({
      accountNumber,
      startDate: params.startDate,
      endDate: params.endDate,
      lang,
    });
    const txs = [...history.transactions].sort((a, b) => {
      const d = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return d !== 0 && !isNaN(d) ? d : (a._seq ?? 0) - (b._seq ?? 0);
    });

    // 3. Mise en forme
    const locale = lang === 'en' ? 'en-US' : lang === 'sw' ? 'sw-TZ' : 'fr-FR';
    const money = (n: number) =>
      new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    const dateFmt = (v: any) => {
      const d = new Date(v);
      return isNaN(d.getTime()) ? String(v || '') : d.toLocaleDateString(locale, { timeZone: 'Africa/Lubumbashi' });
    };
    const typeLabel = (t: any) => {
      const k = String(t || '').toUpperCase();
      if (k.includes('TRANSFER')) return L.transfer;
      if (k.includes('DEPOSIT') || k.includes('TOPUP')) return L.deposit;
      if (k.includes('WITHDRAW') || k.includes('CASHOUT')) return L.withdrawal;
      if (k.includes('PAYMENT')) return L.payment;
      if (k.includes('FEE')) return L.fee;
      return t ? String(t) : L.operation;
    };

    let totalCredits = 0;
    let totalDebits = 0;
    let running: number | null = null;
    const rows: StatementRow[] = txs.map((t) => {
      const amount = Number(t.amount || 0);
      const isCredit = String(t.movement || '').toUpperCase() === 'CREDIT';
      if (isCredit) totalCredits += amount; else totalDebits += amount;
      const after = t.balanceAfter !== undefined && t.balanceAfter !== null ? Number(t.balanceAfter) : null;
      if (after !== null && !isNaN(after)) running = after;
      else running = (running ?? 0) + (isCredit ? amount : -amount);
      return {
        description: typeLabel(t.type),
        detail: t.description || '',
        reference: String(t.reference || t.id || ''),
        date: dateFmt(t.createdAt),
        credit: isCredit ? money(amount) : null,
        debit: !isCredit ? money(amount) : null,
        balance: money(running as number),
      };
    });

    const first = txs[0];
    const last = txs[txs.length - 1];
    const finalBalance =
      last && last.balanceAfter !== undefined && last.balanceAfter !== null
        ? Number(last.balanceAfter)
        : Number(acc.balance ?? 0);
    const opening =
      first && first.balanceBefore !== undefined && first.balanceBefore !== null
        ? Number(first.balanceBefore)
        : finalBalance - totalCredits + totalDebits;

    const fullName =
      (acc.client ? `${acc.client.firstName || ''} ${acc.client.lastName || ''}`.trim() : '') ||
      (localUser ? `${localUser.firstName || ''} ${localUser.lastName || ''}`.trim() : '') ||
      'N/A';

    const html = renderStatementHtml({
      lang,
      logoDataUri: getLogoDataUri('pdf'),
      periodStart: params.startDate ? dateFmt(`${params.startDate}T12:00:00Z`) : (first ? dateFmt(first.createdAt) : L.allTimeStart),
      periodEnd: params.endDate ? dateFmt(`${params.endDate}T12:00:00Z`) : L.allTimeEnd,
      generatedDate: new Date().toLocaleString(locale, { timeZone: 'Africa/Lubumbashi' }),
      currency,
      client: {
        fullName,
        clientId: clientId || 'N/A',
        accountNumber,
        accountType: acc.accountType || 'N/A',
        phone: acc.client?.phone || localUser?.phone || 'N/A',
        email: acc.client?.email || localUser?.email || 'N/A',
      },
      totals: {
        opening: money(opening),
        credits: money(totalCredits),
        debits: money(totalDebits),
        balance: money(finalBalance),
        count: rows.length,
      },
      transactions: rows,
      labels: {},
    });

    // 4. PDF
    let pdf: Buffer;
    try {
      pdf = await htmlToPdf(html, { footerLabel: L.page, ofLabel: L.of });
    } catch (err) {
      this.logger.error(`[Statement] Génération PDF impossible : ${err?.message || err}`);
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('statement_pdf_failed', lang),
        statusCode: 500,
      });
    }

    const suffix = [params.startDate, params.endDate].filter(Boolean).join('_') || new Date().toISOString().slice(0, 10);
    const filename = `releve_AccesFinance_${accountNumber}_${suffix}.pdf`;

    // 5. Envoi par email (optionnel)
    let emailSent: boolean | null = null;
    if (params.sendEmail) {
      const to = params.email || acc.client?.email || localUser?.email;
      if (to) {
        emailSent = await this.mailService.sendBrandedEmail(
          to,
          `AccesFinance — ${L.title} ${accountNumber}`,
          {
            lang,
            title: L.title,
            greeting: fullName !== 'N/A' ? `${fullName},` : undefined,
            paragraphs: [
              this.i18nService.translate('statement_email_body', lang, {
                accountNumber,
                periodStart: params.startDate || L.allTimeStart,
                periodEnd: params.endDate || L.allTimeEnd,
              }),
            ],
            signature: 'AccesFinance',
          },
          [{ filename, content: pdf, contentType: 'application/pdf' }],
        );
      } else {
        emailSent = false;
      }
    }

    return {
      success: true,
      message: this.i18nService.translate('statement_generated', lang),
      data: {
        filename,
        contentType: 'application/pdf',
        size: pdf.length,
        transactions: rows.length,
        emailSent,
        pdfBase64: pdf.toString('base64'),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — SANTÉ DE L'API BANCAIRE
  // ═══════════════════════════════════════════════════════════════

  async adminBankHealth(params: { live?: boolean; lang?: string } = {}) {
    const stats = this.bankService.getStats();
    const live = params.live === false
      ? null
      : await Promise.all([this.bankService.ping('Mobile'), this.bankService.ping('Online')]);

    const liveOk = live ? live.every((p: any) => !p.tested || p.ok) : null;
    const recentRate = stats.totals.successRate;
    const status =
      live && live.some((p: any) => p.tested && !p.ok) ? 'DOWN'
        : recentRate !== null && recentRate < 90 ? 'DEGRADED'
          : 'UP';

    return {
      success: true,
      message: this.i18nService.translate('admin_bank_health', params.lang || 'fr'),
      data: { status, liveOk, live, stats },
    };
  }

  async healthCheck() {
    return { status: 'ok', service: 'transaction-service' };
  }
}
