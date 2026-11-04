/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/approval/user-approval.service.ts
//
// Cycle de vie d'un compte utilisateur :
//
//   1. Inscription (auth.register)  → status = PENDING_VERIFICATION
//                                     (aucun mot de passe connu, pas de session)
//   2. Approbation admin            → status = ACTIVE
//                                     + mot de passe TEMPORAIRE généré et envoyé (SMS + email)
//                                     + mustChangePassword = true
//   3. Première connexion           → l'utilisateur DOIT changer son mot de passe
//                                     (auth/change-password), ce qui lève mustChangePassword
//
// Création côté admin (create_user / create_user_from_account) : le compte est
// créé DIRECTEMENT approuvé (ACTIVE) et reçoit immédiatement son mot de passe temporaire.
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { Prisma, UserRole, users_status } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { MailService } from 'apps/auth-service/src/email/email.service';
import { BankService } from 'apps/transaction-service/src/bank/bank.service';
import { I18nService } from '../../../../libs/common/src/i18n/i18n.service';
import {
  computeTemporaryPasswordExpiry,
  generateTemporaryPassword,
  getTemporaryPasswordExpiryHours,
} from '../../../../libs/common/src/security/temporary-password.util';
import { extractBankObject, hasBankClientIdentity } from '../../../../libs/common/src/bank/bank-accounts.util';
import {
  normalizePhoneToInternational,
  phoneVariants,
} from '../../../../libs/common/src/utils/phone.util';

export interface AdminCreateUserInput {
  clientId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  email?: string | null;
  phone?: string | null;
  role?: UserRole | string | null;
  photo?: string | null;
  preferredLanguage?: string | null;
  preferredCurrency?: string | null;
  timezone?: string | null;
  createdBy?: string | null;
  lang?: string;
}

export interface CredentialsDelivery {
  sms: boolean;
  email: boolean;
  phone: string | null;
  emailAddress: string | null;
  expiresAt: Date;
}

@Injectable()
export class UserApprovalService {
  private readonly logger = new Logger(UserApprovalService.name);
  private readonly SALT_ROUNDS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    private readonly mailService: MailService,
    private readonly i18nService: I18nService,
    private readonly bankService: BankService,
  ) { }

  // ═══════════════════════════════════════════════════════════════
  // UTILITAIRES
  // ═══════════════════════════════════════════════════════════════

  private rpcError(message: string, statusCode: number): RpcException {
    return new RpcException({ status: 'error', message, statusCode });
  }

  private toResponse(user: any) {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      photo: user.photo ?? null,
      role: user.role,
      status: user.status,
      clientId: user.clientId,
      isEmailVerified: user.isEmailVerified,
      isPhoneVerified: user.isPhoneVerified,
      isTwoFactorEnabled: user.isTwoFactorEnabled,
      preferredLanguage: user.preferredLanguage,
      preferredCurrency: user.preferredCurrency,
      timezone: user.timezone,
      pinStatus: user.pinStatus,
      platform: user.platform ?? null,
      mustChangePassword: user.mustChangePassword ?? false,
      tempPasswordExpiresAt: user.tempPasswordExpiresAt ?? null,
      approvedAt: user.approvedAt ?? null,
      approvedBy: user.approvedBy ?? null,
      rejectedAt: user.rejectedAt ?? null,
      rejectedBy: user.rejectedBy ?? null,
      rejectionReason: user.rejectionReason ?? null,
      createdBy: user.createdBy ?? null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  private async logAudit(
    actorId: string | null,
    action: string,
    targetUserId: string | null,
    details: any,
    ipAddress?: string | null,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: actorId || undefined,
          action,
          entity: 'USER',
          entityId: targetUserId || undefined,
          message: details ? JSON.stringify(details) : null,
          ipAddress: ipAddress || undefined,
          level: 'INFO',
        },
      });
    } catch (err) {
      this.logger.error(`Audit log failed: ${err?.message || err}`);
    }
  }

  private async ensureUserSettings(userId: string, language: string = 'fr') {
    await this.prisma.user_settings.upsert({
      where: { user_id: userId },
      update: {},
      create: {
        user_id: userId,
        language,
        theme: 'system',
        email_notifications: true,
        sms_notifications: true,
        push_notifications: true,
        two_factor_enabled: false,
      },
    });
  }

  private isValidEmail(email?: string | null): boolean {
    return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  }

  /**
   * Envoie le mot de passe temporaire par SMS et par email.
   * Le mot de passe en clair n'est JAMAIS stocké ni renvoyé dans la réponse API.
   */
  private async sendTemporaryCredentials(
    user: { firstName: string; lastName: string; phone: string; email: string | null; clientId: string | null },
    temporaryPassword: string,
    expiresAt: Date,
    lang: string,
  ): Promise<CredentialsDelivery> {
    const hours = getTemporaryPasswordExpiryHours();
    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    const identifier = user.clientId || user.phone || user.email || '';
    const phone = normalizePhoneToInternational(user.phone);
    const emailAddress = this.isValidEmail(user.email) ? String(user.email).trim() : null;

    let smsSent = false;
    if (phone) {
      try {
        const smsText = this.i18nService.translate('temp_password_sms', lang, {
          identifier,
          password: temporaryPassword,
          hours,
        });
        smsSent = await this.smsService.sendSms(phone, smsText);
      } catch (err) {
        this.logger.error(`[TempPassword] SMS non envoyé à ${phone}: ${err?.message || err}`);
      }
    }

    let emailSent = false;
    if (emailAddress) {
      try {
        emailSent = await this.mailService.sendHtmlEmail(
          emailAddress,
          this.i18nService.translate('temp_password_email_title', lang),
          'welcome-email.html',
          {
            lang,
            title: this.i18nService.translate('temp_password_email_title', lang),
            greeting: this.i18nService.translate('temp_password_email_greeting', lang, {
              full_name: fullName,
            }),
            message: this.i18nService.translate('temp_password_email_message', lang, { hours }),
            credentials_label: this.i18nService.translate('temp_password_email_credentials', lang),
            phone_label: phone || user.phone || '',
            account_label: user.clientId || '-',
            password_label: temporaryPassword,
            footer: this.i18nService.translate('email_otp_footer', lang),
            sent_to: this.i18nService.translate('email_otp_sent_to', lang),
            copyright: `© ${new Date().getFullYear()} AccesFinance`,
            email: emailAddress,
          },
        );
      } catch (err) {
        this.logger.error(`[TempPassword] Email non envoyé à ${emailAddress}: ${err?.message || err}`);
      }
    }

    if (!smsSent && !emailSent) {
      this.logger.warn(
        `[TempPassword] Aucun canal n'a pu délivrer le mot de passe temporaire (user ${identifier}). Utiliser "renvoyer le mot de passe temporaire".`,
      );
    }

    return { sms: smsSent, email: emailSent, phone: phone || null, emailAddress, expiresAt };
  }

  /**
   * Génère un nouveau mot de passe temporaire pour un utilisateur, l'enregistre
   * (hashé) et l'envoie. Utilisé par l'approbation, la création admin et le renvoi.
   */
  private async issueTemporaryPassword(
    userId: string,
    extraData: Prisma.UserUpdateInput,
    lang: string,
  ) {
    const temporaryPassword = generateTemporaryPassword(10);
    const hashedPassword = await bcrypt.hash(temporaryPassword, this.SALT_ROUNDS);
    const expiresAt = computeTemporaryPasswordExpiry();

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        ...extraData,
        password: hashedPassword,
        mustChangePassword: true,
        tempPasswordExpiresAt: expiresAt,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });

    // Toute session éventuellement ouverte avec l'ancien mot de passe est fermée
    await this.prisma.session.updateMany({
      where: { userId, isActive: true },
      data: { isActive: false, logoutAt: new Date() },
    });

    const delivery = await this.sendTemporaryCredentials(
      {
        firstName: user.firstName,
        lastName: user.lastName,
        phone: user.phone,
        email: user.email,
        clientId: user.clientId,
      },
      temporaryPassword,
      expiresAt,
      lang,
    );

    return { user, delivery };
  }

  /**
   * Vérifie le client auprès de la banque (source de vérité).
   */
  private async fetchBankClient(clientId: string, lang: string): Promise<any> {
    let clientDetails: any;
    try {
      const res = await this.bankService.getClientDetails(clientId, undefined, lang);
      clientDetails = extractBankObject(res);
    } catch (err) {
      this.logger.error(`[BankClient] GetClientdetails ${clientId}: ${err?.message || err}`);
      const status = err?.error?.statusCode ?? err?.statusCode ?? err?.response?.statusCode;
      if (status === 404) {
        throw this.rpcError(this.i18nService.translate('client_id_not_found', lang), 404);
      }
      throw this.rpcError(this.i18nService.translate('bank_unavailable', lang), 502);
    }

    // ✅ Client inconnu : la banque renvoie le clientId avec tous les champs à null
    if (!hasBankClientIdentity(clientDetails)) {
      throw this.rpcError(this.i18nService.translate('client_id_not_found', lang), 404);
    }

    const bankStatus = String(clientDetails.status || '').toUpperCase();
    if (bankStatus && bankStatus !== 'ACTIVE') {
      throw this.rpcError(this.i18nService.translate('client_inactive', lang), 400);
    }

    return clientDetails;
  }

  // ═══════════════════════════════════════════════════════════════
  // 1. LISTE DES INSCRIPTIONS EN ATTENTE
  // ═══════════════════════════════════════════════════════════════

  async listPendingRegistrations(params: {
    page?: number;
    limit?: number;
    search?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    const page = params.page && params.page > 0 ? params.page : 1;
    const limit = params.limit && params.limit > 0 ? Math.min(params.limit, 100) : 10;
    const skip = (page - 1) * limit;

    const where: Prisma.UserWhereInput = {
      status: users_status.PENDING_VERIFICATION,
      deletedAt: null,
    };

    if (params.search && params.search.trim()) {
      const q = params.search.trim();
      where.OR = [
        { clientId: { contains: q } },
        { firstName: { contains: q } },
        { lastName: { contains: q } },
        { email: { contains: q } },
        { phone: { contains: q } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      message: this.i18nService.translate('pending_registrations_retrieved', lang),
      data: {
        data: users.map((u) => this.toResponse(u)),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 2. APPROUVER UNE INSCRIPTION → envoi du mot de passe temporaire
  // ═══════════════════════════════════════════════════════════════

  async approveUser(params: {
    id: string;
    approverId: string;
    lang?: string;
    ipAddress?: string;
  }) {
    const lang = params.lang || 'fr';

    const existing = await this.prisma.user.findUnique({ where: { id: params.id } });
    if (!existing || existing.deletedAt) {
      throw this.rpcError(this.i18nService.translate('user_not_found', lang), 404);
    }
    if (existing.id === params.approverId) {
      throw this.rpcError(this.i18nService.translate('cannot_change_own_status', lang), 403);
    }
    if (existing.status !== users_status.PENDING_VERIFICATION) {
      throw this.rpcError(this.i18nService.translate('user_not_pending', lang), 409);
    }

    // Le client doit toujours être actif à la banque au moment de l'approbation
    if (existing.clientId) {
      await this.fetchBankClient(existing.clientId, lang);
    }

    if (!normalizePhoneToInternational(existing.phone) && !this.isValidEmail(existing.email)) {
      throw this.rpcError(this.i18nService.translate('no_contact_for_temp_password', lang), 400);
    }

    const { user, delivery } = await this.issueTemporaryPassword(
      existing.id,
      {
        status: users_status.ACTIVE,
        approvedAt: new Date(),
        approvedBy: params.approverId,
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
      },
      lang,
    );

    await this.ensureUserSettings(user.id, user.preferredLanguage || lang);

    await this.logAudit(
      params.approverId,
      'APPROVE_USER',
      user.id,
      { clientId: user.clientId, delivery: { sms: delivery.sms, email: delivery.email } },
      params.ipAddress,
    );

    return {
      message: this.i18nService.translate('user_approved_success', lang),
      data: {
        user: this.toResponse(user),
        delivery,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 3. REFUSER UNE INSCRIPTION
  // ═══════════════════════════════════════════════════════════════

  async rejectUser(params: {
    id: string;
    rejecterId: string;
    reason?: string;
    lang?: string;
    ipAddress?: string;
  }) {
    const lang = params.lang || 'fr';

    const existing = await this.prisma.user.findUnique({ where: { id: params.id } });
    if (!existing || existing.deletedAt) {
      throw this.rpcError(this.i18nService.translate('user_not_found', lang), 404);
    }
    if (existing.status !== users_status.PENDING_VERIFICATION) {
      throw this.rpcError(this.i18nService.translate('user_not_pending', lang), 409);
    }

    const reason = (params.reason || '').trim() || null;

    const user = await this.prisma.user.update({
      where: { id: existing.id },
      data: {
        status: users_status.INACTIVE,
        rejectedAt: new Date(),
        rejectedBy: params.rejecterId,
        rejectionReason: reason,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
      },
    });

    const phone = normalizePhoneToInternational(user.phone);
    if (phone) {
      try {
        await this.smsService.sendSms(
          phone,
          this.i18nService.translate('registration_rejected_sms', lang, {
            reason: reason ? `${reason}.` : '',
          }),
        );
      } catch (err) {
        this.logger.error(`[RejectUser] SMS non envoyé à ${phone}: ${err?.message || err}`);
      }
    }

    await this.logAudit(params.rejecterId, 'REJECT_USER', user.id, { reason }, params.ipAddress);

    return {
      message: this.i18nService.translate('user_rejected_success', lang),
      data: this.toResponse(user),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 4. RENVOYER UN MOT DE PASSE TEMPORAIRE
  //    (perdu, expiré, SMS non reçu…) — tant que l'utilisateur ne l'a pas changé
  // ═══════════════════════════════════════════════════════════════

  async resendTemporaryPassword(params: {
    id: string;
    adminId: string;
    lang?: string;
    ipAddress?: string;
  }) {
    const lang = params.lang || 'fr';

    const existing = await this.prisma.user.findUnique({ where: { id: params.id } });
    if (!existing || existing.deletedAt) {
      throw this.rpcError(this.i18nService.translate('user_not_found', lang), 404);
    }

    const canResend =
      (existing.status === users_status.ACTIVE || existing.status === users_status.LOCKED) &&
      existing.mustChangePassword === true;

    if (!canResend) {
      throw this.rpcError(this.i18nService.translate('temp_password_resend_not_allowed', lang), 409);
    }

    const { user, delivery } = await this.issueTemporaryPassword(
      existing.id,
      { status: users_status.ACTIVE },
      lang,
    );

    await this.logAudit(
      params.adminId,
      'RESEND_TEMP_PASSWORD',
      user.id,
      { delivery: { sms: delivery.sms, email: delivery.email } },
      params.ipAddress,
    );

    return {
      message: this.i18nService.translate('temp_password_resent', lang),
      data: {
        user: this.toResponse(user),
        delivery,
      },
    };
  }

  /**
   * ✅ Réinitialisation du mot de passe par un admin (mot de passe oublié,
   *    compte compromis…) : nouveau mot de passe temporaire envoyé par SMS / email,
   *    changement obligatoire à la prochaine connexion, sessions fermées.
   */
  async adminResetPassword(params: {
    id: string;
    adminId: string;
    lang?: string;
    ipAddress?: string;
  }) {
    const lang = params.lang || 'fr';

    const existing = await this.prisma.user.findUnique({ where: { id: params.id } });
    if (!existing || existing.deletedAt) {
      throw this.rpcError(this.i18nService.translate('user_not_found', lang), 404);
    }

    // L'audit est écrit par AdminSecurityService (entity USER_SECURITY)
    const { user, delivery } = await this.issueTemporaryPassword(existing.id, {}, lang);

    return {
      message: this.i18nService.translate('admin_password_reset', lang),
      data: {
        user: this.toResponse(user),
        delivery,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // 5. CRÉATION D'UN UTILISATEUR CÔTÉ ADMIN → APPROUVÉ DIRECTEMENT
  //    - avec clientId : identité vérifiée et complétée par l'API bancaire
  //    - sans clientId : compte interne (ADMIN, AGENT, …)
  // ═══════════════════════════════════════════════════════════════

  async adminCreateUser(data: AdminCreateUserInput, ipAddress?: string) {
    const lang = data.lang || 'fr';
    const clientId = data.clientId ? String(data.clientId).trim() : null;

    // ── Identité saisie par l'admin ──
    let firstName = (data.firstName || '').trim();
    let lastName = (data.lastName || '').trim();
    if ((!firstName || !lastName) && data.fullName) {
      const parts = String(data.fullName).trim().split(/\s+/);
      firstName = firstName || parts[0] || '';
      lastName = lastName || parts.slice(1).join(' ') || '';
    }
    let phone = normalizePhoneToInternational(data.phone);
    let email = data.email ? String(data.email).trim().toLowerCase() : null;

    // ── Client bancaire : la banque est la source de vérité ──
    let clientDetails: any = null;
    if (clientId) {
      const existingClientUser = await this.prisma.user.findFirst({ where: { clientId } });
      if (existingClientUser) {
        throw this.rpcError(this.i18nService.translate('clientId_already_exists', lang), 409);
      }

      clientDetails = await this.fetchBankClient(clientId, lang);

      firstName = firstName || String(clientDetails.firstName || '').trim();
      lastName = lastName || String(clientDetails.lastName || '').trim() || clientId;
      phone = phone || normalizePhoneToInternational(clientDetails.phone);
      email = email || (clientDetails.email ? String(clientDetails.email).trim().toLowerCase() : null);
    }

    if (!firstName || !lastName || !phone) {
      throw this.rpcError(this.i18nService.translate('missing_user_identity', lang), 400);
    }
    if (email && !this.isValidEmail(email)) {
      email = null;
    }

    // ── Doublons ──
    const phoneTaken = await this.prisma.user.findFirst({
      where: { phone: { in: phoneVariants(phone) } },
    });
    if (phoneTaken) {
      throw this.rpcError(this.i18nService.translate('phone_already_exists', lang), 409);
    }
    if (email) {
      const emailTaken = await this.prisma.user.findFirst({ where: { email } });
      if (emailTaken) {
        throw this.rpcError(this.i18nService.translate('email_already_exists', lang), 409);
      }
    }

    const role = (data.role && Object.values(UserRole).includes(data.role as UserRole))
      ? (data.role as UserRole)
      : UserRole.USER;

    // ── Création (mot de passe provisoire remplacé juste après par le temporaire) ──
    const created = await this.prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email,
        phone,
        firstName,
        lastName,
        password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), this.SALT_ROUNDS),
        role,
        status: users_status.ACTIVE,
        clientId,
        photo: data.photo || null,
        preferredLanguage: data.preferredLanguage || lang,
        preferredCurrency: data.preferredCurrency || undefined,
        timezone: data.timezone || undefined,
        createdBy: data.createdBy || null,
        approvedAt: new Date(),
        approvedBy: data.createdBy || null,
        platform: 'BACK_OFFICE',
      },
    });

    await this.ensureUserSettings(created.id, data.preferredLanguage || lang);

    // ── Miroir client local (identité uniquement — les COMPTES viennent de l'API) ──
    if (clientId && clientDetails) {
      try {
        await this.prisma.clients.upsert({
          where: { clientId },
          update: {
            firstName: clientDetails.firstName ?? undefined,
            lastName: clientDetails.lastName ?? undefined,
            email: clientDetails.email ?? undefined,
            phone: clientDetails.phone ?? undefined,
            status: 'ACTIVE',
            updatedAt: new Date(),
          },
          create: {
            id: crypto.randomUUID(),
            clientId,
            firstName: clientDetails.firstName ?? firstName,
            lastName: clientDetails.lastName ?? lastName,
            email: clientDetails.email ?? email,
            phone: clientDetails.phone ?? phone,
            status: 'ACTIVE',
          },
        });
      } catch (err) {
        this.logger.error(`[AdminCreateUser] Upsert client ${clientId}: ${err?.message || err}`);
      }
    }

    // ── Mot de passe temporaire + envoi ──
    const { user, delivery } = await this.issueTemporaryPassword(created.id, {}, lang);

    await this.logAudit(
      data.createdBy || null,
      'ADMIN_CREATE_USER',
      user.id,
      {
        clientId,
        role,
        approved: true,
        delivery: { sms: delivery.sms, email: delivery.email },
      },
      ipAddress,
    );

    return {
      message: this.i18nService.translate('user_created_approved', lang),
      data: {
        user: this.toResponse(user),
        delivery,
      },
    };
  }
}
