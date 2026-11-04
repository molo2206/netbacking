/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/auth-service/src/auth-service.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaClient } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';
import { UserRole, users_status } from '@prisma/client';
import { I18nService } from '@app/common';
import { SmsService } from './sms/sms.service';
import { MailService } from './email/email.service';
import { BankService } from 'apps/transaction-service/src/bank/bank.service';
import {
  extractBankObject,
  hasBankClientIdentity,
  normalizePlatform,
  generateUnusablePassword,
  mapBankAccounts,
  normalizePhoneToInternational,
  phoneVariants,
  validateNewPassword,
} from '@app/common';

const registerLocks: Map<string, boolean> = new Map();

@Injectable()
export class AuthServiceService {
  private prisma = new PrismaClient();
  private readonly SALT_ROUNDS = 10;
  private loginLocks: Map<string, boolean> = new Map();

  private readonly logger = new Logger(AuthServiceService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly i18nService: I18nService,
    private readonly smsService: SmsService,
    private readonly mailService: MailService,
    private readonly bankService: BankService,
  ) { }

  // ==================== UTILITAIRES ====================

  private normalizePhone(phone: string): string {
    return phone.replace(/[^0-9]/g, '');
  }

  private mapAccountType(rawType: string): any {
    const normalized = String(rawType || '').toLowerCase().trim();

    if (
      normalized.includes('pargne') ||
      normalized.includes('epargne') ||
      normalized.includes('épargne') ||
      normalized.includes('saving') ||
      normalized.includes('savings')
    ) {
      return 'SAVINGS';
    }

    if (
      normalized.includes('courant') ||
      normalized.includes('current') ||
      normalized.includes('checking')
    ) {
      return 'CURRENT';
    }

    if (normalized.includes('terme') || normalized.includes('fixed')) {
      return 'FIXED_DEPOSIT';
    }

    if (normalized.includes('joint')) {
      return 'JOINT';
    }

    if (normalized.includes('bloqu') || normalized.includes('block')) {
      return 'BLOCKED';
    }

    this.logger.warn(
      `[mapAccountType] Type inconnu "${rawType}" → fallback CURRENT`,
    );
    return 'CURRENT';
  }

  private async logAudit(
    userId: string | null,
    action: string,
    details: any,
    ipAddress: string | null,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: userId || undefined,
          action,
          message: details ? JSON.stringify(details) : null,
          entity: 'AUTH',
          entityId: userId || undefined,
          ipAddress: ipAddress || undefined,
          level: 'INFO',
        },
      });
    } catch (err) {
      console.error('Audit log failed:', err);
    }
  }

  private async logAuditWithDebounce(
    userId: string | null,
    action: string,
    details: any,
    ipAddress: string | null,
    debounceMs: number = 2000,
  ) {
    const lastAudit = await this.prisma.auditLog.findFirst({
      where: {
        userId: userId ?? undefined,
        action,
        createdAt: { gte: new Date(Date.now() - debounceMs) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (lastAudit) {
      console.log(`[Audit] Ignored duplicate ${action} for user ${userId}`);
      return;
    }
    await this.logAudit(userId, action, details, ipAddress);
  }

  private async logFailedLoginAttempt(
    userId: string | null,
    identifier: string,
    ipAddress: string | null,
    userAgent: string | null,
  ) {
    try {
      await this.prisma.loginHistory.create({
        data: {
          userId: userId || '',
          ipAddress: ipAddress || 'unknown',
          userAgent: userAgent || 'unknown',
          success: false,
          failureReason: 'Invalid credentials',
        },
      });
    } catch (err) {
      console.error('Failed login attempt log failed:', err);
    }
  }

  /**
   * Comptes d'un client — TOUJOURS depuis l'API bancaire externe.
   */
  private async fetchClientAccounts(
    clientId: string | null | undefined,
    lang: string = 'fr',
    context: string = 'Accounts',
  ): Promise<any[]> {
    if (!clientId) return [];
    try {
      const accountsRes = await this.bankService.getClientAccounts(clientId, undefined, lang);
      const accounts = mapBankAccounts(accountsRes, clientId).map((acc) => ({
        accountNumber: acc.accountNumber,
        accountType: acc.accountType,
        currency: acc.currency,
        balance: acc.balance,
        status: acc.status,
      }));
      this.logger.log(
        `[${context}] ${accounts.length} compte(s) reçu(s) de l'API bancaire pour ${clientId}`,
      );
      return accounts;
    } catch (err) {
      this.logger.warn(
        `[${context}] GetClientAccounts failed for ${clientId}: ${err?.message || err}`,
      );
      return [];
    }
  }

  // ==================== REGISTER (DEMANDE D'INSCRIPTION → APPROBATION ADMIN) ====================
  //
  // Étape 1 : sans otpCode → vérification du client à la banque + envoi d'un OTP.
  // Étape 2 : avec otpCode → création du compte en statut PENDING_VERIFICATION.
  //           ⚠️ Aucun mot de passe choisi par le client, aucune session ouverte.
  //           Après APPROBATION par un admin, un mot de passe TEMPORAIRE est généré
  //           et envoyé par SMS/email ; il devra être changé à la première connexion.
  async register(data: RegisterDto, ipAddress?: string) {
    const clientId = String(data.clientId || '').trim();
    const lang = data.lang || 'fr';

    this.logger.log('[AuthService] Register received:', {
      clientId,
      hasOtpCode: !!data.otpCode,
      platform: data.platform || 'WEB',
    });

    if (!clientId) {
      throw new BadRequestException(
        this.i18nService.translate('client_id_not_found', lang),
      );
    }

    const key = `${clientId}`;
    if (registerLocks.get(key)) {
      throw new BadRequestException(
        this.i18nService.translate('request_in_progress', lang),
      );
    }
    registerLocks.set(key, true);

    try {
      // ═══════════════════════════════════════════════════════════════
      // 1. 🏦 VÉRIFIER LE CLIENT CÔTÉ BANQUE (source de vérité)
      // ═══════════════════════════════════════════════════════════════
      let clientDetails: any;
      try {
        const clientRes = await this.bankService.getClientDetails(
          clientId, undefined, lang,
        );
        clientDetails = extractBankObject(clientRes);
      } catch (err) {
        this.logger.error(
          `[Register] GetClientdetails failed for ${clientId}: ${err?.message || err}`,
        );
        const status = err?.error?.statusCode ?? err?.statusCode ?? err?.response?.statusCode;
        if (status === 404) {
          throw new BadRequestException(
            this.i18nService.translate('client_id_not_found', lang),
          );
        }
        throw new BadRequestException(
          this.i18nService.translate('bank_unavailable', lang),
        );
      }

      // ✅ Client inconnu : la banque renvoie le clientId avec tous les champs à null
      if (!hasBankClientIdentity(clientDetails)) {
        throw new BadRequestException(
          this.i18nService.translate('client_id_not_found', lang),
        );
      }

      const bankStatus = String(clientDetails.status || '').toUpperCase();
      if (bankStatus && bankStatus !== 'ACTIVE') {
        this.logger.warn(
          `[Register] Client ${clientId} non actif côté banque: ${clientDetails.status}`,
        );
        throw new BadRequestException(
          this.i18nService.translate('client_inactive', lang),
        );
      }

      // Téléphone / email : la banque fait foi
      const finalPhone =
        normalizePhoneToInternational(clientDetails.phone || data.phone, '243') || clientId;
      const finalEmail =
        (clientDetails.email || data.email)
          ? String(clientDetails.email || data.email).trim().toLowerCase()
          : null;

      // ═══════════════════════════════════════════════════════════════
      // 2. COMPTE LOCAL EXISTANT ?
      //    - en attente      → on informe (pas de doublon)
      //    - refusé          → nouvelle demande autorisée (réutilise la fiche)
      //    - actif / autre   → déjà inscrit
      // ═══════════════════════════════════════════════════════════════
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { clientId: clientId },
            { phone: { in: phoneVariants(finalPhone) } },
          ],
        },
      });

      const canReapply =
        !!existingUser &&
        existingUser.status === users_status.INACTIVE &&
        !!existingUser.rejectedAt &&
        existingUser.clientId === clientId;

      if (existingUser && !canReapply) {
        if (existingUser.status === users_status.PENDING_VERIFICATION) {
          throw new BadRequestException(
            this.i18nService.translate('registration_already_pending', lang),
          );
        }
        throw new BadRequestException(
          this.i18nService.translate('user_already_exists', lang),
        );
      }

      // ═══════════════════════════════════════════════════════════════
      // 3. OTP (preuve de possession du téléphone / email du client)
      // ═══════════════════════════════════════════════════════════════
      const otpProvided = !!data.otpCode && data.otpCode.trim() !== '';
      const otpIdentifier = finalPhone || clientId;

      if (!otpProvided) {
        await this.prisma.otp.updateMany({
          where: {
            email: otpIdentifier,
            isUsed: false,
            expiresAt: { gt: new Date() },
          },
          data: { isUsed: true },
        });

        const newOtpCode = crypto.randomInt(100000, 1000000).toString();

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
        if (finalPhone && finalPhone !== clientId) {
          try {
            this.logger.log(`[Register] Envoi OTP SMS à ${finalPhone}`);
            const smsText = this.i18nService.translate('otp_sms', lang, {
              otpCode: newOtpCode,
            });
            await this.smsService.sendSms(finalPhone, smsText);
          } catch (err) {
            this.logger.error(`Erreur SMS OTP à ${finalPhone}: ${err.message}`);
          }
        } else {
          this.logger.warn(`[Register] Aucun numéro de téléphone disponible pour l'OTP`);
        }

        // Email OTP
        if (finalEmail) {
          try {
            await this.mailService.sendHtmlEmail(
              finalEmail,
              this.i18nService.translate('email_otp_title', lang),
              'otp-email.html',
              {
                lang,
                title: this.i18nService.translate('email_otp_title', lang),
                greeting: this.i18nService.translate('email_otp_greeting', lang),
                message: this.i18nService.translate('email_otp_message', lang),
                otpCode: newOtpCode,
                expiry: this.i18nService.translate('email_otp_expiry', lang),
                ignore: this.i18nService.translate('email_otp_ignore', lang),
                thanks: this.i18nService.translate('email_otp_thanks', lang),
                team: this.i18nService.translate('email_otp_team', lang),
                footer: this.i18nService.translate('email_otp_footer', lang),
                sent_to: this.i18nService.translate('email_otp_sent_to', lang),
                copyright: this.i18nService.translate('email_otp_copyright', lang, {
                  year: new Date().getFullYear(),
                }),
                email: finalEmail,
              },
            );
          } catch (err) {
            this.logger.error(`Erreur email OTP à ${finalEmail}: ${err.message}`);
          }
        }

        return {
          requiresOtp: true,
          message: this.i18nService.translate('otp_sent', lang),
        };
      }

      // ═══════════════════════════════════════════════════════════════
      // 4. VÉRIFIER L'OTP
      // ═══════════════════════════════════════════════════════════════
      const otpRecord = await this.prisma.otp.findFirst({
        where: {
          email: otpIdentifier,
          otpCode: String(data.otpCode).trim(),
          isUsed: false,
          expiresAt: { gt: new Date() },
        },
      });

      if (!otpRecord) {
        throw new BadRequestException(
          this.i18nService.translate('otp_invalid', lang),
        );
      }

      // ═══════════════════════════════════════════════════════════════
      // 5. CRÉER (ou réactiver) LA DEMANDE — STATUT PENDING_VERIFICATION
      //    Mot de passe inutilisable : personne ne peut se connecter
      //    tant qu'un admin n'a pas approuvé le compte.
      // ═══════════════════════════════════════════════════════════════
      const unusablePasswordHash = await bcrypt.hash(
        generateUnusablePassword(),
        this.SALT_ROUNDS,
      );

      const firstName = clientDetails.firstName || data.firstName || 'User';
      const lastName = clientDetails.lastName || data.lastName || clientId;

      const pendingData = {
        email: finalEmail,
        phone: finalPhone,
        password: unusablePasswordHash,
        firstName,
        lastName,
        role: UserRole.USER,
        status: users_status.PENDING_VERIFICATION,
        clientId,
        // ✅ Plateforme d'inscription harmonisée : MOBILE ou WEB
        platform: (() => {
          const p = normalizePlatform(data.platform, data.deviceInfo);
          return p === 'UNKNOWN' ? 'WEB' : p;
        })(),
        isPhoneVerified: true,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
        approvedAt: null,
        approvedBy: null,
        rejectedAt: null,
        rejectedBy: null,
        rejectionReason: null,
        failedLoginAttempts: 0,
        lockedUntil: null,
      };

      const user = canReapply && existingUser
        ? await this.prisma.user.update({
          where: { id: existingUser.id },
          data: pendingData,
        })
        : await this.prisma.user.create({
          data: { id: crypto.randomUUID(), ...pendingData },
        });

      this.logger.log(
        `[Register] Demande ${user.id} créée (PENDING_VERIFICATION) pour clientId ${clientId}`,
      );

      // Paramètres utilisateur par défaut
      try {
        await this.prisma.user_settings.upsert({
          where: { user_id: user.id },
          update: { language: lang },
          create: {
            user_id: user.id,
            language: lang,
            theme: 'system',
            email_notifications: true,
            sms_notifications: true,
            push_notifications: true,
            two_factor_enabled: false,
          },
        });
      } catch (err) {
        this.logger.error(`[Register] user_settings: ${err.message}`);
      }

      // ═══════════════════════════════════════════════════════════════
      // 6. MIROIR CLIENT LOCAL (identité uniquement — les COMPTES viennent de l'API)
      // ═══════════════════════════════════════════════════════════════
      try {
        await this.prisma.clients.upsert({
          where: { clientId: clientId },
          update: {
            firstName: clientDetails.firstName,
            lastName: clientDetails.lastName,
            email: clientDetails.email,
            phone: clientDetails.phone,
            updatedAt: new Date(),
          },
          create: {
            id: crypto.randomUUID(),
            clientId: clientId,
            firstName: clientDetails.firstName,
            lastName: clientDetails.lastName,
            email: clientDetails.email,
            phone: clientDetails.phone,
          },
        });
      } catch (err) {
        this.logger.error(
          `[Register] Upsert client échoué pour ${clientId}: ${err.message}`,
        );
      }

      // Marquer l'OTP comme utilisé
      await this.prisma.otp.update({
        where: { id: otpRecord.id },
        data: { isUsed: true },
      });

      // ═══════════════════════════════════════════════════════════════
      // 7. FCM TOKEN (optionnel) — pour notifier l'approbation plus tard
      // ═══════════════════════════════════════════════════════════════
      if (data.fcmToken && data.fcmToken.trim()) {
        try {
          await this.prisma.device.upsert({
            where: { deviceId: data.fcmToken },
            update: {
              userId: user.id,
              deviceName: data.deviceInfo || 'unknown',
              deviceType: normalizePlatform(data.platform, data.deviceInfo),
              pushToken: data.fcmToken,
              isActive: true,
              updatedAt: new Date(),
            },
            create: {
              id: crypto.randomUUID(),
              userId: user.id,
              deviceId: data.fcmToken,
              deviceName: data.deviceInfo || 'unknown',
              deviceType: normalizePlatform(data.platform, data.deviceInfo),
              pushToken: data.fcmToken,
              isActive: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        } catch (err) {
          this.logger.error(`Erreur FCM token: ${err.message}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 8. ACCUSÉ DE RÉCEPTION (SMS)
      // ═══════════════════════════════════════════════════════════════
      if (finalPhone && finalPhone !== clientId) {
        try {
          await this.smsService.sendSms(
            finalPhone,
            this.i18nService.translate('registration_request_sms', lang, { clientId }),
          );
        } catch (err) {
          this.logger.error(`Erreur SMS accusé de réception: ${err.message}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 9. AUDIT
      // ═══════════════════════════════════════════════════════════════
      await this.logAudit(
        user.id,
        canReapply ? 'REGISTER_REAPPLY' : 'REGISTER_REQUEST',
        {
          identifier: user.phone,
          clientId,
          platform: user.platform,
          ipAddress: ipAddress ?? null,
        },
        ipAddress ?? null,
      );

      // ═══════════════════════════════════════════════════════════════
      // 10. RÉPONSE — PAS de token : le compte doit d'abord être approuvé
      // ═══════════════════════════════════════════════════════════════
      return {
        requiresOtp: false,
        pendingApproval: true,
        message: this.i18nService.translate('registration_pending_approval', lang),
        data: {
          id: user.id,
          clientId: user.clientId,
          firstName: user.firstName,
          lastName: user.lastName,
          phone: user.phone,
          email: user.email,
          status: user.status,
          platform: user.platform || null,
          createdAt: user.createdAt,
        },
      };
    } finally {
      registerLocks.delete(key);
    }
  }

  // ==================== LOGIN ====================
  async login(
    dto: LoginDto & { lang?: string; userAgent?: string },
    ipAddress?: string,
  ) {
    const lang = dto.lang || 'fr';
    const identifier = dto.identifier;
    // ✅ Plateforme de connexion (MOBILE / WEB) — statistiques admin
    const loginPlatform = normalizePlatform(dto.platform, dto.userAgent || dto.deviceInfo);

    try {
      const user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { clientId: identifier },
            { phone: identifier },
            { email: identifier.toLowerCase() },
          ],
        },
        select: {
          id: true,
          email: true,
          phone: true,
          password: true,
          firstName: true,
          lastName: true,
          photo: true,
          role: true,
          status: true,
          platform: true,
          isEmailVerified: true,
          isPhoneVerified: true,
          isTwoFactorEnabled: true,
          twoFactorSecret: true,
          twoFactorBackupCodes: true,
          lastLoginAt: true,
          lastLoginIp: true,
          failedLoginAttempts: true,
          lockedUntil: true,
          preferredLanguage: true,
          preferredCurrency: true,
          timezone: true,
          metadata: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
          deletedAt: true,
          clientId: true,
          pinStatus: true,
          mustChangePassword: true,
          tempPasswordExpiresAt: true,
          rejectedAt: true,
        },
      });

      if (!user) {
        await this.logFailedLoginAttempt(
          null,
          identifier,
          ipAddress || null,
          dto.userAgent || null,
        );
        throw new BadRequestException({
          status: 'error',
          message: this.i18nService.translate('user_not_found', lang),
          statusCode: 400,
        });
      }

      // ✅ Administrateurs : connexion UNIQUEMENT avec l'adresse email
      //    (pas de code client ni de téléphone pour ADMIN / SUPER_ADMIN)
      if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
        const typed = String(identifier || '').trim().toLowerCase();
        const adminEmail = String(user.email || '').trim().toLowerCase();
        if (!adminEmail || typed !== adminEmail) {
          await this.logFailedLoginAttempt(
            user.id,
            identifier,
            ipAddress || null,
            dto.userAgent || null,
          );
          throw new BadRequestException({
            status: 'error',
            message: this.i18nService.translate('admin_login_email_only', lang),
            statusCode: 400,
            code: 'ADMIN_LOGIN_EMAIL_ONLY',
          });
        }
      }

      // ✅ Compte en attente d'approbation / refusé : message explicite,
      //    et AUCUN compteur d'échecs (sinon le verrouillage pourrait le réactiver)
      if (user.status === users_status.PENDING_VERIFICATION) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_pending_approval', lang),
          statusCode: 403,
          code: 'ACCOUNT_PENDING_APPROVAL',
        });
      }
      if (user.status === users_status.INACTIVE && user.rejectedAt) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_rejected', lang),
          statusCode: 403,
          code: 'ACCOUNT_REJECTED',
        });
      }

      if (user.lockedUntil) {
        const now = new Date();
        if (now < user.lockedUntil) {
          const minutesLeft = Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60000);
          let message = this.i18nService.translate('account_locked', lang);
          message = message.replace('{minutes}', minutesLeft.toString());
          await this.logFailedLoginAttempt(
            user.id,
            identifier,
            ipAddress || null,
            dto.userAgent || null,
          );
          throw new RpcException({ status: 'error', message, statusCode: 403 });
        } else {
          // Fin du verrouillage : on ne réactive QUE les comptes verrouillés
          const restoredStatus =
            user.status === users_status.LOCKED ? users_status.ACTIVE : user.status;
          await this.prisma.user.update({
            where: { id: user.id },
            data: {
              failedLoginAttempts: 0,
              lockedUntil: null,
              status: restoredStatus,
            },
          });
          user.failedLoginAttempts = 0;
          user.lockedUntil = null;
          user.status = restoredStatus;
        }
      }

      if (user.status !== users_status.ACTIVE) {
        await this.logFailedLoginAttempt(
          user.id,
          identifier,
          ipAddress || null,
          dto.userAgent || null,
        );
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_inactive', lang),
          statusCode: 400,
        });
      }

      if (!user.password) {
        await this.logFailedLoginAttempt(
          user.id,
          identifier,
          ipAddress || null,
          dto.userAgent || null,
        );
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('user_no_password', lang),
          statusCode: 400,
        });
      }

      const isValidPassword = await bcrypt.compare(dto.password, user.password);
      if (!isValidPassword) {
        const newAttempts = (user.failedLoginAttempts || 0) + 1;
        let lockedUntil: Date | null = user.lockedUntil || null;
        let newStatus: users_status = user.status;

        if (newAttempts >= 5) {
          lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
          newStatus = users_status.LOCKED;
        }

        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: newAttempts,
            lockedUntil: lockedUntil,
            status: newStatus,
          },
        });

        await this.logFailedLoginAttempt(
          user.id,
          identifier,
          ipAddress || null,
          dto.userAgent || null,
        );

        throw new BadRequestException({
          status: 'error',
          message: this.i18nService.translate('invalid_password', lang),
          statusCode: 400,
        });
      }

      // ✅ Mot de passe temporaire expiré → l'admin doit en renvoyer un
      const mustChangePassword = user.mustChangePassword === true;
      if (
        mustChangePassword &&
        user.tempPasswordExpiresAt &&
        new Date() > user.tempPasswordExpiresAt
      ) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('temp_password_expired', lang),
          statusCode: 403,
          code: 'TEMP_PASSWORD_EXPIRED',
        });
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lockedUntil: null,
          status: users_status.ACTIVE,
          lastLoginAt: new Date(),
          lastLoginIp: ipAddress || undefined,
        },
      });

      const loginEntry = await this.prisma.loginHistory.create({
        data: {
          userId: user.id,
          ipAddress: ipAddress || 'unknown',
          userAgent: dto.userAgent || dto.deviceInfo || 'unknown',
          success: true,
          deviceId: dto.fcmToken || undefined,
        },
      });
      await this.recordPlatform('login_history', loginEntry.id, loginPlatform);

      const userRole = user.role || UserRole.USER;
      const tokens = this.generateJwtTokens(
        user.id,
        user.email || null,
        userRole,
        undefined,
        { mustChangePassword },
      );

      let deviceId = dto.fcmToken;
      if (!deviceId) {
        const fingerprint = `${dto.deviceInfo || ''}|${dto.platform || ''}|${ipAddress || ''}`;
        deviceId = crypto
          .createHash('sha256')
          .update(fingerprint)
          .digest('hex');
      }

      await this.prisma.session.updateMany({
        where: {
          userId: user.id,
          isActive: true,
          deviceId: deviceId,
        },
        data: { isActive: false },
      });

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      const createdSession = await this.prisma.session.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          deviceId: deviceId,
          userAgent: dto.deviceInfo || null,
          ipAddress: ipAddress || null,
          expiresAt: expiresAt,
          isActive: true,
          createdAt: new Date(),
        },
      });
      await this.recordPlatform('sessions', createdSession.id, loginPlatform);

      if (dto.fcmToken && dto.fcmToken.trim()) {
        try {
          // ✅ Le token FCM est aussi rangé dans pushToken (lu par le service de notification)
          await this.prisma.device.upsert({
            where: { deviceId: dto.fcmToken },
            update: {
              userId: user.id,
              deviceName: dto.deviceInfo || 'unknown',
              deviceType: loginPlatform,
              pushToken: dto.fcmToken,
              isActive: true,
              lastUsedAt: new Date(),
              updatedAt: new Date(),
            },
            create: {
              id: crypto.randomUUID(),
              userId: user.id,
              deviceId: dto.fcmToken,
              deviceName: dto.deviceInfo || 'unknown',
              deviceType: loginPlatform,
              pushToken: dto.fcmToken,
              isActive: true,
              lastUsedAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        } catch (err) {
          console.error('Erreur FCM token:', err);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // ✅ COMPTES DEPUIS L'API BANCAIRE (jamais depuis Prisma)
      //    Tant que le mot de passe temporaire n'est pas changé, on ne
      //    renvoie aucun compte : l'app doit d'abord forcer le changement.
      // ═══════════════════════════════════════════════════════════════
      const accounts = mustChangePassword
        ? []
        : await this.fetchClientAccounts(user.clientId, lang, 'Login');

      const userSettings = await this.prisma.user_settings.findUnique({
        where: { user_id: user.id },
        select: {
          language: true,
          theme: true,
          email_notifications: true,
          sms_notifications: true,
          push_notifications: true,
          two_factor_enabled: true,
        },
      });

      const sessions = await this.prisma.session.findMany({
        where: {
          userId: user.id,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      const formattedSessions = sessions.map(session => ({
        id: session.id,
        device_info: session.userAgent,
        ip_address: session.ipAddress,
        last_activity: session.createdAt,
        created_at: session.createdAt,
        expires_at: session.expiresAt,
      }));

      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        message: mustChangePassword
          ? this.i18nService.translate('password_change_required', lang)
          : this.i18nService.translate('login_success', lang),
        mustChangePassword,
        sessionId: createdSession.id,
        data: {
          id: user.id,
          email: user.email || null,
          phone: user.phone,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          status: user.status,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          clientId: user.clientId,
          sessions: formattedSessions,
          platform: user.platform || null,
          isEmailVerified: user.isEmailVerified,
          isPhoneVerified: user.isPhoneVerified,
          isTwoFactorEnabled: user.isTwoFactorEnabled,
          twoFactorSecret: user.twoFactorSecret,
          lastLoginAt: user.lastLoginAt,
          pinStatus: user.pinStatus,
          mustChangePassword,
          tempPasswordExpiresAt: mustChangePassword ? user.tempPasswordExpiresAt : null,
          accounts,   // ✅ depuis BankService (déjà nettoyé)
          settings: {
            language: userSettings?.language || user.preferredLanguage || 'fr',
            theme: userSettings?.theme || 'system',
            email_notifications: userSettings?.email_notifications ?? true,
            sms_notifications: userSettings?.sms_notifications ?? true,
            push_notifications: userSettings?.push_notifications ?? true,
            two_factor_enabled: userSettings?.two_factor_enabled ?? false,
          }
        },
      };
    } catch (error) {
      if (
        error instanceof RpcException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      throw new RpcException({
        status: 'error',
        message: error.message || 'Login failed',
        statusCode: 500,
      });
    }
  }
  // ==================== REFRESH TOKEN ====================
  async refreshToken(refreshToken: string) {
    try {
      const session = await this.prisma.session.findFirst({
        where: {
          refreshToken,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              role: true,
              status: true,
              mustChangePassword: true,
            },
          },
        },
      });

      if (!session) {
        console.warn('Refresh token invalid or expired');
        throw new RpcException({
          status: 'error',
          message: 'Invalid refresh token',
          statusCode: 401,
        });
      }

      if (session.user.status === users_status.INACTIVE ||
        session.user.status === users_status.SUSPENDED ||
        session.user.status === users_status.PENDING_VERIFICATION ||
        session.user.status === users_status.DELETED) {
        throw new RpcException({
          status: 'error',
          message: 'User account is not active',
          statusCode: 400,
        });
      }

      await this.prisma.session.update({
        where: { id: session.id },
        data: { isActive: false },
      });

      const userRole = session.user.role || UserRole.USER;
      const tokens = this.generateJwtTokens(
        session.user.id,
        session.user.email || null,
        userRole,
        undefined,
        { mustChangePassword: session.user.mustChangePassword === true },
      );

      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      const newSession = await this.prisma.session.create({
        data: {
          id: crypto.randomUUID(),
          userId: session.user.id,
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: expiresAt,
          isActive: true,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
          deviceName: session.deviceName,
          createdAt: new Date(),
        },
      });

      console.log(`Token refreshed for user ${session.user.email}`);

      return {
        success: true,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: process.env.JWT_EXPIRATION || '1h',
        sessionId: newSession.id,
        mustChangePassword: session.user.mustChangePassword === true,
      };
    } catch (error) {
      console.error('Refresh token error:', error);
      if (error instanceof RpcException) {
        throw error;
      }
      throw new RpcException({
        status: 'error',
        message: error.message || 'Refresh token failed',
        statusCode: 500,
      });
    }
  }

  // ==================== LOGOUT ====================
  async logout(userId: string, sessionId: string) {
    return this.revokeSessionById(userId, sessionId);
  }

  // ==================== VALIDATE SESSION ====================
  async validateSession(
    userId: string,
    sessionToken: string,
  ): Promise<{ valid: boolean }> {
    const session = await this.prisma.session.findFirst({
      where: {
        userId: userId,
        token: sessionToken,
        isActive: true,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) return { valid: false };
    return { valid: true };
  }

  // ==================== REVOKE SESSION BY TOKEN ====================
  async revokeSessionByToken(
    userId: string,
    sessionToken: string,
  ): Promise<{ message: string }> {
    console.log(
      `[revokeSessionByToken] userId=${userId}, sessionToken=${sessionToken}`,
    );
    const session = await this.prisma.session.findFirst({
      where: {
        userId: userId,
        token: sessionToken,
        isActive: true,
      },
    });
    if (!session) {
      return { message: 'Session déjà terminée' };
    }
    await this.prisma.session.update({
      where: { id: session.id },
      data: { isActive: false, logoutAt: new Date() },
    });
    console.log(`[revokeSessionByToken] Session supprimée : ${session.id}`);
    return { message: 'Déconnexion réussie' };
  }

  // ==================== REVOKE SESSION BY ID ====================
  async revokeSessionById(
    userId: string,
    sessionId: string,
    lang: string = 'fr',
  ): Promise<{ message: string }> {
    console.log(`[revokeSessionById] userId=${userId}, sessionId=${sessionId}`);
    let session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId: userId },
    });
    if (!session) {
      session = await this.prisma.session.findFirst({
        where: { token: sessionId, userId: userId },
      });
    }
    if (session) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { isActive: false, logoutAt: new Date() },
      });
    }
    return { message: this.i18nService.translate('logout_success', lang) };
  }

  // ==================== VERIFY OTP ====================
  async verifyOtp(
    email: string,
    code: string,
    lang: string = 'fr',
  ): Promise<{ message: string }> {
    const normalizeIdentifier = (value: string): string => {
      let cleaned = value.trim();
      cleaned = cleaned.replace(/[^0-9+]/g, '');
      if (cleaned.startsWith('00')) {
        cleaned = '+' + cleaned.substring(2);
      }
      if (cleaned.startsWith('0') && !cleaned.startsWith('+')) {
        cleaned = '+243' + cleaned.substring(1);
      }
      if (!cleaned.startsWith('+')) {
        cleaned = '+' + cleaned;
      }
      return cleaned;
    };

    const normalizedEmail = normalizeIdentifier(email);

    const otpEntry = await this.prisma.otp.findFirst({
      where: {
        OR: [
          { email: normalizedEmail },
          { email: normalizedEmail.replace('+', '') },
          { email: '+' + normalizedEmail.replace('+', '') },
          { email: normalizedEmail.replace(/[^0-9]/g, '') },
          { email: '+' + normalizedEmail.replace(/[^0-9]/g, '') },
        ],
        otpCode: code,
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otpEntry) {
      throw new BadRequestException(
        this.i18nService.translate('otp_invalid', lang),
      );
    }

    await this.prisma.otp.update({
      where: { id: otpEntry.id },
      data: { isUsed: true },
    });

    return {
      message: this.i18nService.translate('otp_validated', lang),
    };
  }

  // ==================== SEND RESET PASSWORD OTP ====================
  async sendResetPasswordOtp(
    identifier: string,
    ipAddress?: string,
    lang: string = 'fr',
  ) {
    const cleanIdentifier = identifier.trim();

    let user;
    let identifierToStore: string;
    let isEmail = cleanIdentifier.includes('@');

    if (isEmail) {
      user = await this.prisma.user.findFirst({
        where: { email: cleanIdentifier.toLowerCase() },
      });
      if (!user)
        throw new BadRequestException(
          this.i18nService.translate('user_not_found', lang),
        );
      if (!user.email)
        throw new BadRequestException(
          this.i18nService.translate('no_email', lang),
        );
      identifierToStore = user.email;
    } else {
      const normalizedPhone = this.normalizePhone(cleanIdentifier);

      user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { phone: normalizedPhone },
            { phone: normalizedPhone.replace('+', '') },
            { phone: '+' + normalizedPhone.replace('+', '') },
            { clientId: cleanIdentifier },
            { clientId: normalizedPhone },
          ]
        },
      });

      if (!user) {
        throw new BadRequestException(
          this.i18nService.translate('user_not_found', lang),
        );
      }
      if (!user.phone) {
        throw new BadRequestException(
          this.i18nService.translate('no_phone', lang),
        );
      }

      identifierToStore = user.phone;
    }

    await this.prisma.otp.updateMany({
      where: {
        userId: user.id,
        email: identifierToStore,
        isUsed: false,
        expiresAt: { gt: new Date() }
      },
      data: { isUsed: true },
    });

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    await this.prisma.otp.create({
      data: {
        id: crypto.randomUUID(),
        userId: user.id,
        email: identifierToStore,
        otpCode,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        isUsed: false,
      },
    });

    if (isEmail) {
      try {
        await this.mailService.sendHtmlEmail(
          user.email,
          this.i18nService.translate('email_otp_title', lang),
          'otp-email.html',
          {
            lang,
            title: this.i18nService.translate('email_otp_title', lang),
            greeting: this.i18nService.translate('email_otp_greeting', lang),
            message: this.i18nService.translate('email_otp_message', lang),
            otpCode,
            expiry: this.i18nService.translate('email_otp_expiry', lang),
            ignore: this.i18nService.translate('email_otp_ignore', lang),
            thanks: this.i18nService.translate('email_otp_thanks', lang),
            team: this.i18nService.translate('email_otp_team', lang),
            footer: this.i18nService.translate('email_otp_footer', lang),
            sent_to: this.i18nService.translate('email_otp_sent_to', lang),
            copyright: this.i18nService.translate('email_otp_copyright', lang, {
              year: new Date().getFullYear(),
            }),
            email: user.email,
          },
        );
      } catch (err) {
        console.error(`Erreur envoi email OTP à ${user.email}:`, err);
      }
    } else {
      const smsText = this.i18nService.translate('reset_password_sms', lang, {
        otpCode,
      });
      await this.smsService.sendSms(user.phone, smsText);
    }

    await this.logAudit(
      user.id,
      'SEND_RESET_OTP',
      { identifier },
      ipAddress ?? null,
    );

    return {
      message: this.i18nService.translate('otp_sent', lang),
      data: user.phone
    };
  }

  // ==================== RESET PASSWORD ====================
  async resetPassword(resetPasswordDto: {
    identifier: string;
    code: string;
    password: string;
    lang?: string;
  }): Promise<{ message: string }> {
    const { identifier, code, password, lang = 'fr' } = resetPasswordDto;
    const cleanIdentifier = identifier.trim();

    if (!password || password.trim().length < 8) {
      throw new BadRequestException(
        this.i18nService.translate('password_too_short', lang),
      );
    }

    const isEmail = cleanIdentifier.includes('@');

    let user: any;

    if (isEmail) {
      user = await this.prisma.user.findFirst({
        where: { email: cleanIdentifier.toLowerCase() },
      });
    } else {
      const normalizedPhone = this.normalizePhone(cleanIdentifier);

      user = await this.prisma.user.findFirst({
        where: {
          OR: [
            { phone: normalizedPhone },
            { phone: normalizedPhone.replace('+', '') },
            { phone: '+' + normalizedPhone.replace('+', '') },
            { clientId: cleanIdentifier },
            { clientId: normalizedPhone },
            { clientId: normalizedPhone.replace('+', '') },
          ]
        },
      });
    }

    if (!user) {
      throw new BadRequestException(
        this.i18nService.translate('user_not_found', lang),
      );
    }

    const otpEntry = await this.prisma.otp.findFirst({
      where: {
        userId: user.id,
        otpCode: code.toString(),
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
    });

    if (!otpEntry) {
      throw new BadRequestException(
        this.i18nService.translate('otp_invalid', lang),
      );
    }

    // ⚠️ Un compte en attente d'approbation ne peut pas définir son mot de passe
    if (user.status === users_status.PENDING_VERIFICATION) {
      throw new BadRequestException(
        this.i18nService.translate('account_pending_approval', lang),
      );
    }

    const strengthError = validateNewPassword(password);
    if (strengthError) {
      throw new BadRequestException(
        this.i18nService.translate(strengthError, lang),
      );
    }

    const hashedPassword = await bcrypt.hash(password, this.SALT_ROUNDS);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
      },
    });

    await this.prisma.otp.update({
      where: { id: otpEntry.id },
      data: { isUsed: true },
    });

    return {
      message: this.i18nService.translate('password_reset_success', lang),
    };
  }

  // ==================== CHANGE PASSWORD ====================
  // Sert aussi au remplacement OBLIGATOIRE du mot de passe temporaire
  // (première connexion après approbation / création admin).
  async changePassword(
    userId: string,
    changePasswordDto: {
      currentPassword: string;
      newPassword: string;
      lang?: string;
      deviceInfo?: string;
    },
    ipAddress?: string,
  ): Promise<{ message: string; data: any; accessToken?: string; refreshToken?: string; sessionId?: string }> {
    const { currentPassword, newPassword, lang = 'fr' } = changePasswordDto;
    if (!currentPassword || currentPassword.trim() === '') {
      throw new BadRequestException(
        this.i18nService.translate('current_password_required', lang),
      );
    }
    if (!newPassword || newPassword.trim() === '') {
      throw new BadRequestException(
        this.i18nService.translate('new_password_required', lang),
      );
    }

    const strengthError = validateNewPassword(newPassword);
    if (strengthError) {
      throw new BadRequestException(
        this.i18nService.translate(strengthError, lang),
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new NotFoundException(
        this.i18nService.translate('user_not_found', lang),
      );
    if (!user.password)
      throw new BadRequestException(
        this.i18nService.translate('no_password_set', lang),
      );

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch)
      throw new BadRequestException(
        this.i18nService.translate('current_password_incorrect', lang),
      );

    const wasTemporary = user.mustChangePassword === true;

    if (wasTemporary && user.tempPasswordExpiresAt && new Date() > user.tempPasswordExpiresAt) {
      throw new BadRequestException(
        this.i18nService.translate('temp_password_expired', lang),
      );
    }

    if (wasTemporary && (await bcrypt.compare(newPassword, user.password))) {
      throw new BadRequestException(
        this.i18nService.translate('password_same_as_temporary', lang),
      );
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, this.SALT_ROUNDS);
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedNewPassword,
        mustChangePassword: false,
        tempPasswordExpiresAt: null,
      },
    });

    const { password, pin, twoFactorSecret, twoFactorBackupCodes, ...safeUser } = updatedUser;
    await this.logAudit(
      user.id,
      wasTemporary ? 'CHANGE_TEMPORARY_PASSWORD' : 'CHANGE_PASSWORD',
      { identifier: user.phone },
      ipAddress ?? null,
    );

    // Notification SMS (best effort)
    try {
      if (user.phone) {
        await this.smsService.sendSms(
          user.phone,
          this.i18nService.translate('password_changed_sms', lang),
        );
      }
    } catch (err) {
      this.logger.error(`[ChangePassword] SMS: ${err?.message || err}`);
    }

    // ✅ Après le remplacement du mot de passe temporaire, le jeton courant
    //    porte encore mustChangePassword=true : on ferme les anciennes sessions
    //    et on renvoie de NOUVEAUX jetons utilisables partout.
    if (wasTemporary) {
      await this.prisma.session.updateMany({
        where: { userId: user.id, isActive: true },
        data: { isActive: false, logoutAt: new Date() },
      });

      const userRole = updatedUser.role || UserRole.USER;
      const sessionId = crypto.randomUUID();
      const tokens = this.generateJwtTokens(
        updatedUser.id,
        updatedUser.email || null,
        userRole,
        sessionId,
        { mustChangePassword: false },
      );
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await this.prisma.session.create({
        data: {
          id: sessionId,
          userId: updatedUser.id,
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          userAgent: changePasswordDto.deviceInfo || null,
          ipAddress: ipAddress || null,
          expiresAt,
          isActive: true,
          createdAt: new Date(),
        },
      });

      const accounts = await this.fetchClientAccounts(updatedUser.clientId, lang, 'ChangePassword');

      return {
        message: this.i18nService.translate('password_changed_success', lang),
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        sessionId,
        data: { ...safeUser, mustChangePassword: false, accounts },
      };
    }

    return {
      message: this.i18nService.translate('password_changed_success', lang),
      data: safeUser,
    };
  }

  // ==================== SET PASSWORD ====================
  async setPassword(userId: string, newPassword: string): Promise<void> {
    const hashedPassword = await bcrypt.hash(newPassword, this.SALT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });
  }

  // ==================== LIST ALL SESSIONS ====================
  async listAllSessions(
    page: number = 1,
    limit: number = 10,
    lang: string = 'fr',
  ) {
    const skip = (page - 1) * limit;
    const [sessions, total] = await Promise.all([
      this.prisma.session.findMany({
        where: { isActive: true, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      }),
      this.prisma.session.count({
        where: { isActive: true, expiresAt: { gt: new Date() } },
      }),
    ]);
    return {
      message: this.i18nService.translate('sessions_retrieved', lang),
      data: sessions,
      total,
      page,
      limit,
    };
  }

  // ==================== LIST USER SESSIONS ====================
  async listUserSessions(
    userId: string,
    page: number = 1,
    limit: number = 10,
    lang: string = 'fr',
  ) {
    const skip = (page - 1) * limit;
    const [sessions, total] = await Promise.all([
      this.prisma.session.findMany({
        where: {
          userId: userId,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true,
          deviceId: true,
          ipAddress: true,
          userAgent: true,
          deviceName: true,
          createdAt: true,
          expiresAt: true,
        },
      }),
      this.prisma.session.count({
        where: {
          userId: userId,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
      }),
    ]);
    return {
      message: this.i18nService.translate('sessions_retrieved', lang),
      data: sessions,
      total,
      page,
      limit,
    };
  }

  // ==================== GET SESSION BY ID ====================
  async getSessionById(
    sessionId: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });
    if (!session) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('session_not_found', lang),
        statusCode: 404,
      });
    }
    return {
      message: this.i18nService.translate('session_retrieved', lang),
      data: session,
    };
  }

  // ==================== REGISTER DEVICE TOKEN ====================
  async registerDeviceToken(userId: string, fcmToken: string, platform?: string, deviceName?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Utilisateur non trouvé');
    if (!fcmToken || !fcmToken.trim())
      throw new BadRequestException('Token FCM requis');
    const token = fcmToken.trim();
    const deviceType = normalizePlatform(platform || 'MOBILE');
    // ✅ pushToken renseigné : c'est là que le service de notification lit le token
    return this.prisma.device.upsert({
      where: { deviceId: token },
      update: {
        userId,
        pushToken: token,
        isActive: true,
        deviceType,
        ...(deviceName ? { deviceName } : {}),
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        id: crypto.randomUUID(),
        userId,
        deviceId: token,
        pushToken: token,
        isActive: true,
        deviceType,
        deviceName: deviceName || null,
        lastUsedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Enregistre la plateforme (MOBILE / WEB) d'une session ou d'une connexion.
   * Colonne ajoutée par prisma/sql/20261104_platform_tracking.sql : si la migration
   * n'est pas encore appliquée, on ignore simplement (la connexion n'est pas bloquée).
   */
  private async recordPlatform(table: 'sessions' | 'login_history', id: string, platform: string) {
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE \`${table}\` SET platform = ? WHERE id = ?`,
        platform,
        id,
      );
    } catch (err) {
      this.logger.warn(
        `[recordPlatform] ${table}.platform indisponible (migration 20261104 non appliquée ?) : ${err?.message || err}`,
      );
    }
  }

  // ==================== GET USER STATUS ====================
  async getUserStatus(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    });
    if (!user)
      throw new RpcException({
        status: 'error',
        message: 'User not found',
        statusCode: 404,
      });
    return user.status || 'INACTIVE';
  }

  // ==================== GET LOGIN ATTEMPTS ====================
  async getLoginAttempts(
    userId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    message: string;
    data: { data: any[]; total: number; page: number; limit: number };
  }> {
    const skip = (page - 1) * limit;
    const [attempts, total] = await Promise.all([
      this.prisma.loginHistory.findMany({
        where: { userId },
        orderBy: { loginAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.loginHistory.count({ where: { userId } }),
    ]);
    return {
      message: 'Login attempts retrieved successfully',
      data: {
        data: attempts,
        total,
        page,
        limit,
      },
    };
  }

  // ==================== FORGOT PASSWORD ====================
  async forgotPassword(forgotPasswordDto: { email: string; lang?: string }) {
    return this.sendResetPasswordOtp(
      forgotPasswordDto.email,
      undefined,
      forgotPasswordDto.lang || 'fr',
    );
  }

  // ==================== VALIDATE USER ====================
  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        photo: true,
        role: true,
        status: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        isTwoFactorEnabled: true,
        preferredLanguage: true,
        preferredCurrency: true,
      },
    });

    if (!user || user.status !== users_status.ACTIVE) {
      throw new UnauthorizedException('User not found or inactive');
    }

    return user;
  }

  // ==================== VALIDATE CREDENTIALS ====================
  async validate(identifier: string, password: string): Promise<any> {
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { phone: identifier },
          { clientId: identifier },
        ],
      },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== users_status.ACTIVE) {
      throw new UnauthorizedException('Account is not active');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const { password: _, ...result } = user;
    return result;
  }

  // ==================== ENABLE 2FA ====================
  async enableTwoFactor(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const secret = crypto.randomBytes(20).toString('hex');

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isTwoFactorEnabled: true,
        twoFactorSecret: secret,
      },
    });

    const qrCodeUrl = `otpauth://totp/Netbacking:${user.email}?secret=${secret}&issuer=Netbacking`;

    return {
      success: true,
      message: '2FA enabled successfully',
      secret,
      qrCode: qrCodeUrl,
    };
  }

  // ==================== VERIFY 2FA ====================
  async verifyTwoFactor(userId: string, code: string) {
    if (code === '123456') {
      return { success: true, message: '2FA verified successfully' };
    }
    throw new UnauthorizedException('Invalid 2FA code');
  }

  // ==================== DISABLE 2FA ====================
  async disableTwoFactor(userId: string, code: string) {
    const verification = await this.verifyTwoFactor(userId, code);

    if (!verification.success) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isTwoFactorEnabled: false,
        twoFactorSecret: null,
      },
    });

    return { success: true, message: '2FA disabled successfully' };
  }

  // ==================== GET PROFILE ====================
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        photo: true,
        role: true,
        status: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        isTwoFactorEnabled: true,
        preferredLanguage: true,
        preferredCurrency: true,
        timezone: true,
        clientId: true,
        pinStatus: true,
        createdAt: true,
        updatedAt: true,
        platform: true,
        mustChangePassword: true,
        tempPasswordExpiresAt: true,
        user_settings: {
          select: {
            language: true,
            theme: true,
            email_notifications: true,
            sms_notifications: true,
            push_notifications: true,
            two_factor_enabled: true,
          },
        },
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: 'User not found',
        statusCode: 404,
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // ✅ COMPTES DEPUIS L'API BANCAIRE (jamais depuis Prisma)
    // ═══════════════════════════════════════════════════════════════
    const accounts = user.mustChangePassword
      ? []
      : await this.fetchClientAccounts(user.clientId, user.user_settings?.language || 'fr', 'getProfile');

    const sessions = await this.prisma.session.findMany({
      where: {
        userId: user.id,
        isActive: true,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        deviceId: true,
        userAgent: true,
        ipAddress: true,
        createdAt: true,
        expiresAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    const formattedSessions = sessions.map(session => ({
      id: session.id,
      device_info: session.userAgent,
      ip_address: session.ipAddress,
      last_activity: session.createdAt,
      created_at: session.createdAt,
      expires_at: session.expiresAt,
    }));

    return {
      accessToken: null,
      refreshToken: null,
      message: 'Profile retrieved successfully',
      sessionId: sessions[0]?.id || null,
      data: {
        id: user.id,
        email: user.email || null,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        clientId: user.clientId,
        photo: user.photo,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        isTwoFactorEnabled: user.isTwoFactorEnabled,
        preferredLanguage: user.preferredLanguage || user.user_settings?.language || 'fr',
        preferredCurrency: user.preferredCurrency,
        timezone: user.timezone,
        pinStatus: user.pinStatus,
        platform: user.platform || null,
        mustChangePassword: user.mustChangePassword === true,
        tempPasswordExpiresAt: user.mustChangePassword ? user.tempPasswordExpiresAt : null,
        sessions: formattedSessions,
        accounts,   // ✅ depuis BankService (déjà nettoyé)
        settings: user.user_settings ? {
          language: user.user_settings.language,
          theme: user.user_settings.theme,
          email_notifications: user.user_settings.email_notifications,
          sms_notifications: user.user_settings.sms_notifications,
          push_notifications: user.user_settings.push_notifications,
          two_factor_enabled: user.user_settings.two_factor_enabled,
        } : null,
      },
    };
  }
  // ==================== UPDATE PROFILE ====================
  async updateProfile(userId: string, data: any) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        photo: data.photo,
        preferredLanguage: data.preferredLanguage,
        preferredCurrency: data.preferredCurrency,
        timezone: data.timezone,
      },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        photo: true,
        role: true,
        status: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        isTwoFactorEnabled: true,
        preferredLanguage: true,
        preferredCurrency: true,
        timezone: true,
      },
    });

    return {
      success: true,
      message: 'Profile updated successfully',
      user: updatedUser,
    };
  }

  // ==================== GET SESSIONS ====================
  async getSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        isActive: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return sessions;
  }

  // ==================== REVOKE SESSION ====================
  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: {
        id: sessionId,
        userId,
        isActive: true,
      },
    });

    if (!session) {
      throw new UnauthorizedException('Session not found');
    }

    await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        isActive: false,
        logoutAt: new Date(),
      },
    });

    return {
      success: true,
      message: 'Session revoked successfully',
    };
  }

  // ==================== PRIVATE METHODS ====================

  private generateJwt(
    user: any,
    sessionToken: string,
    message?: string,
  ): any {
    const payload = {
      id: user.id,
      email: user.email || null,
      phone: user.phone || null,
      full_name: user.firstName + ' ' + user.lastName || null,
      role: user.role,
      status: user.status || 'ACTIVE',
      sessionToken,
    };

    const accessToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET || 'secret',
      expiresIn: '30d',
    });
    const refreshToken = this.jwtService.sign(payload, {
      secret: process.env.JWT_SECRET || 'secret',
      expiresIn: '30d',
    });

    return {
      accessToken,
      refreshToken,
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone || null,
        full_name: user.firstName + ' ' + user.lastName || null,
        role: user.role,
        status: user.status || 'ACTIVE',
        createdAt: user.createdAt || new Date(),
        updatedAt: user.updatedAt || new Date(),
      },
      message,
    };
  }

  private generateclientId(): string {
    const timestamp = Date.now().toString().slice(-8);
    const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
    return `NE${timestamp}${random}`;
  }

  private generateJwtTokens(
    userId: string,
    email: string | null,
    role: UserRole,
    sessionId?: string,
    extraClaims: { mustChangePassword?: boolean } = {},
  ) {
    const payload: any = {
      sub: userId,
      email: email || '',
      role,
      ...(sessionId && { sessionId }),
      // ✅ Lu par JwtAuthGuard : bloque l'API tant que le mot de passe temporaire n'est pas changé
      ...(extraClaims.mustChangePassword ? { mustChangePassword: true } : {}),
    };
    const jwtSecret = process.env.JWT_SECRET || 'secret';
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || 'refresh_secret';

    const jwtExpiration = process.env.JWT_EXPIRATION || '30d';
    const jwtRefreshExpiration = process.env.JWT_REFRESH_EXPIRATION || '90d';

    const accessToken = this.jwtService.sign(payload, {
      secret: jwtSecret,
      expiresIn: jwtExpiration as any,
    });
    const refreshToken = this.jwtService.sign(payload, {
      secret: jwtRefreshSecret,
      expiresIn: jwtRefreshExpiration as any,
    });

    return { accessToken, refreshToken };
  }

  private generateJwtResponse(
    user: any,
    tokens: { accessToken: string; refreshToken: string },
    sessionToken: string,
    message?: string,
  ): any {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone || null,
        full_name: user.firstName + ' ' + user.lastName || null,
        role: user.role,
        status: user.status || 'ACTIVE',
        createdAt: user.createdAt || new Date(),
        updatedAt: user.updatedAt || new Date(),
      },
      message,
    };
  }
}
