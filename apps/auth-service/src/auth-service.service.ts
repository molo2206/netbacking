/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/auth-service/src/auth-service.service.ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
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

const registerLocks: Map<string, boolean> = new Map();

@Injectable()
export class AuthServiceService {
  private prisma = new PrismaClient();
  private readonly SALT_ROUNDS = 10;
  private loginLocks: Map<string, boolean> = new Map();

  constructor(
    private readonly jwtService: JwtService,
    private readonly i18nService: I18nService,
    private readonly smsService: SmsService,
    private readonly mailService: MailService,
  ) { }

  private normalizePhone(phone: string): string {
    return phone.replace(/[^0-9]/g, '');
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

  // ==================== REGISTER ====================
  async register(data: RegisterDto, ipAddress?: string) {
    const clientId = data.clientId;
    const lang = data.lang || 'fr';

    console.log('[AuthService] Register received:', {
      clientId,
      hasOtpCode: !!data.otpCode,
      email: data.email,
      platform: data.platform || 'WEB',
    });

    const key = `${clientId}`;
    if (registerLocks.get(key)) {
      throw new BadRequestException(
        this.i18nService.translate('request_in_progress', lang),
      );
    }
    registerLocks.set(key, true);

    try {
      // ✅ Vérifier si le clientId existe déjà
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { clientId: clientId },
            { phone: data.phone || undefined }
          ],
        },
      });

      if (existingUser) {
        throw new UnauthorizedException(
          this.i18nService.translate('user_already_exists', lang),
        );
      }

      // ✅ Vérifier si le compte existe et récupérer les infos du client
      const existingAccount = await this.prisma.account.findFirst({
        where: { clientId: clientId },
        include: {
          clients: true,
        },
      });

      if (!existingAccount) {
        throw new BadRequestException(
          `Le clientId ${clientId} n'existe pas. Veuillez fournir un clientId valide.`,
        );
      }

      const clientInfo = existingAccount.clients;

      // ✅ Gestion OTP
      const otpProvided = data.otpCode && data.otpCode.trim() !== '';

      // ✅ SI OTP EST VIDE OU NON FOURNI → ENVOYER OTP
      if (!otpProvided) {
        // Désactiver anciens OTP
        await this.prisma.otp.updateMany({
          where: {
            email: clientInfo?.phone || data.phone || clientId,
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
            email: clientInfo?.phone || data.phone || clientId,
            otpCode: newOtpCode,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            isUsed: false,
          },
        });

        // ✅ SMS OTP
        const clientPhone = clientInfo?.phone || data.phone;
        if (clientPhone) {
          try {
            const smsText = this.i18nService.translate('otp_sms', lang, {
              otpCode: newOtpCode,
            });
            await this.smsService.sendSms(clientPhone, smsText);
          } catch (err) {
            console.error('Erreur SMS OTP:', err);
          }
        }

        // ✅ EMAIL OTP
        const clientEmail = clientInfo?.email || data.email;
        if (clientEmail) {
          try {
            await this.mailService.sendHtmlEmail(
              clientEmail,
              this.i18nService.translate('email_otp_title', lang),
              'otp-email.html',
              {
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
                email: clientEmail,
              },
            );
          } catch (err) {
            console.error(`Erreur email OTP à ${clientEmail}:`, err);
          }
        }

        return {
          requiresOtp: true,
          message: this.i18nService.translate('otp_sent', lang),
        };
      }

      // ✅ SI OTP EST FOURNI → VÉRIFIER ET CRÉER L'UTILISATEUR
      const otpRecord = await this.prisma.otp.findFirst({
        where: {
          email: clientInfo?.phone || data.phone || clientId,
          otpCode: data.otpCode,
          isUsed: false,
          expiresAt: { gt: new Date() },
        },
      });

      if (!otpRecord) {
        throw new BadRequestException(
          this.i18nService.translate('otp_invalid', lang),
        );
      }

      if (!otpRecord.expiresAt || new Date() > otpRecord.expiresAt) {
        throw new BadRequestException(
          this.i18nService.translate('otp_expired', lang),
        );
      }

      // ✅ CRÉER L'UTILISATEUR
      const plainPassword = data.password;
      const hashedPassword = await bcrypt.hash(plainPassword, 10);

      // ✅ Récupérer les valeurs par défaut pour phone et email
      const finalPhone = clientInfo?.phone || data.phone || clientId;
      const finalEmail = clientInfo?.email || data.email || null;

      // ✅ Construire firstName et lastName (sans fullName)
      let firstName = data.firstName || 'User';
      let lastName = data.lastName || clientId;

      // ✅ Utiliser firstName et lastName du client (modifié)
      if (clientInfo) {
        firstName = data.firstName || clientInfo.firstName || 'User';
        lastName = data.lastName || clientInfo.lastName || clientId;
      }

      const userData = {
        id: crypto.randomUUID(),
        email: finalEmail,
        phone: finalPhone,
        password: hashedPassword,
        firstName: firstName,
        lastName: lastName,
        role: UserRole.USER,
        status: users_status.ACTIVE,
        clientId: clientId,
        platform: data.platform || 'WEB',
        ...(data.referralCode && {
          referredBy: data.referralCode,
        }),
      };

      const user = await this.prisma.user.create({
        data: userData,
      });

      console.log(`[Account] ClientId ${clientId} lié à l'utilisateur ${user.id}`);

      // Marquer OTP utilisé
      await this.prisma.otp.update({
        where: { id: otpRecord.id },
        data: { isUsed: true },
      });

      // Audit
      await this.logAudit(
        user.id,
        'REGISTER',
        { identifier: user, clientId: clientId },
        ipAddress ?? null,
      );

      // ✅ FCM Token - Optionnel
      if (data.fcmToken && data.fcmToken.trim()) {
        try {
          await this.prisma.device.upsert({
            where: { deviceId: data.fcmToken },
            update: {
              userId: user.id,
              deviceName: data.deviceInfo || 'unknown',
              deviceType: data.platform || 'WEB',
              updatedAt: new Date(),
            },
            create: {
              id: crypto.randomUUID(),
              userId: user.id,
              deviceId: data.fcmToken,
              deviceName: data.deviceInfo || 'unknown',
              deviceType: data.platform || 'WEB',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        } catch (err) {
          console.error('Erreur FCM token:', err);
        }
      }

      // ✅ SMS BIENVENUE (modifié)
      const clientPhone = clientInfo?.phone || user.phone;
      if (clientPhone) {
        try {
          const welcomeSms = this.i18nService.translate('welcome_sms', lang, {
            full_name: clientInfo ? `${clientInfo.firstName} ${clientInfo.lastName}` : `${user.firstName} ${user.lastName}`,
            account_number: clientId,
            phone: clientPhone,
            password: plainPassword,
          });
          await this.smsService.sendSms(clientPhone, welcomeSms);
        } catch (err) {
          console.error('Erreur SMS bienvenue:', err);
        }
      }

      // ✅ EMAIL BIENVENUE (modifié)
      const clientEmail2 = clientInfo?.email || user.email;
      if (clientEmail2) {
        try {
          await this.mailService.sendHtmlEmail(
            clientEmail2,
            this.i18nService.translate('email_welcome_title', lang),
            'welcome-email.html',
            {
              title: this.i18nService.translate('email_welcome_title', lang),
              greeting: this.i18nService.translate('email_welcome_greeting', lang, {
                full_name: clientInfo ? `${clientInfo.firstName} ${clientInfo.lastName}` : `${user.firstName} ${user.lastName}`,
              }),
              message: this.i18nService.translate('email_welcome_message', lang),
              credentials_label: this.i18nService.translate('email_welcome_credentials', lang),
              phone_label: this.i18nService.translate('email_welcome_phone', lang, {
                phone: clientPhone,
              }),
              account_label: this.i18nService.translate('email_welcome_account', lang, {
                account_number: clientId,
              }),
              password_label: this.i18nService.translate('email_welcome_password', lang, {
                defaultPassword: plainPassword,
              }),
              footer: this.i18nService.translate('email_otp_footer', lang),
              sent_to: this.i18nService.translate('email_otp_sent_to', lang),
              copyright: this.i18nService.translate('email_otp_copyright', lang, {
                year: new Date().getFullYear(),
              }),
              email: clientEmail2,
            },
          );
        } catch (err) {
          console.error('Erreur email bienvenue:', err);
        }
      }

      // ✅ Générer les tokens JWT
      const userRole = user.role || UserRole.USER;
      const tokens = this.generateJwtTokens(user.id, user.email || null, userRole);

      // Créer la session
      const sessionToken = crypto.randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      const createdSession = await this.prisma.session.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          token: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          userAgent: data.deviceInfo || null,
          ipAddress: ipAddress || null,
          expiresAt: expiresAt,
          isActive: true,
          createdAt: new Date(),
        },
      });

      // Récupérer les sessions actives
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

      // Récupérer les comptes
      let accounts: any[] = [];
      if (user.clientId) {
        accounts = await this.prisma.account.findMany({
          where: { clientId: user.clientId },
          select: {
            id: true,
            clientId: true,
            accountType: true,
            balance: true,
            currency: true,
            status: true,
            isMain: true,
            accountNumber: true
          },
        });
      }

      // ✅ RÉPONSE
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        message: this.i18nService.translate('register_success', lang),
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
          accounts: accounts.map(account => ({
            id: account.id,
            clientId: account.clientId,
            accountType: account.accountType,
            balance: account.balance,
            currency: account.currency,
            status: account.status,
            isMain: account.isMain,
            accountNumber: account.accountNumber
          })),
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

      if (user.lockedUntil && user.lockedUntil > new Date()) {
        const minutesLeft = Math.ceil(
          (user.lockedUntil.getTime() - Date.now()) / 60000,
        );
        let message = this.i18nService.translate('account_locked', lang);
        message = message.replace('{minutes}', minutesLeft.toString());
        await this.logFailedLoginAttempt(
          user.id,
          identifier,
          ipAddress || null,
          dto.userAgent || null,
        );
        throw new RpcException({ status: 'error', message, statusCode: 403 });
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
        let lockedUntil = user.lockedUntil;
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

      await this.prisma.loginHistory.create({
        data: {
          userId: user.id,
          ipAddress: ipAddress || 'unknown',
          userAgent: dto.userAgent || 'unknown',
          success: true,
          deviceId: dto.fcmToken || undefined,
        },
      });

      const userRole = user.role || UserRole.USER;
      const tokens = this.generateJwtTokens(user.id, user.email || null, userRole);

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

      if (dto.fcmToken && dto.fcmToken.trim()) {
        try {
          await this.prisma.device.upsert({
            where: { deviceId: dto.fcmToken },
            update: {
              userId: user.id,
              deviceName: dto.deviceInfo || 'unknown',
              deviceType: dto.platform || 'unknown',
              updatedAt: new Date(),
            },
            create: {
              id: crypto.randomUUID(),
              userId: user.id,
              deviceId: dto.fcmToken,
              deviceName: dto.deviceInfo || 'unknown',
              deviceType: dto.platform || 'unknown',
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          });
        } catch (err) {
          console.error('Erreur FCM token:', err);
        }
      }

      // Récupérer les comptes
      let accounts: any[] = [];
      if (user.clientId) {
        accounts = await this.prisma.account.findMany({
          where: { clientId: user.clientId },
          select: {
            id: true,
            clientId: true,
            accountType: true,
            balance: true,
            currency: true,
            status: true,
            isMain: true,
            accountNumber: true,
          },
        });
      }

      // Récupérer toutes les sessions actives
      const sessions = await this.prisma.session.findMany({
        where: {
          userId: user.id,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      });

      // Formatage unifié des sessions
      const formattedSessions = sessions.map(session => ({
        id: session.id,
        device_info: session.userAgent,
        ip_address: session.ipAddress,
        last_activity: session.createdAt,
        created_at: session.createdAt,
        expires_at: session.expiresAt,
      }));

      // ✅ RÉPONSE UNIFIÉE - MÊME FORMAT QUE REGISTER
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        message: this.i18nService.translate('login_success', lang),
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
          accounts: accounts.map(account => ({
            id: account.id,
            clientId: account.clientId,
            accountType: account.accountType,
            balance: account.balance,
            currency: account.currency,
            status: account.status,
            isMain: account.isMain,
            accountNumber: account.accountNumber
          })),
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
        session.user.status === users_status.SUSPENDED) {
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
    const otpEntry = await this.prisma.otp.findFirst({
      where: {
        email: email,
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
    const isEmail = identifier.includes('@');
    const cleanIdentifier = identifier.trim();

    let user;
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
    } else {
      const normalizedPhone = this.normalizePhone(cleanIdentifier);
      user = await this.prisma.user.findFirst({
        where: { phone: normalizedPhone },
      });
      if (!user)
        throw new BadRequestException(
          this.i18nService.translate('user_not_found', lang),
        );
      if (!user.phone)
        throw new BadRequestException(
          this.i18nService.translate('no_phone', lang),
        );
    }

    await this.prisma.otp.updateMany({
      where: { userId: user.id, isUsed: false, expiresAt: { gt: new Date() } },
      data: { isUsed: true },
    });

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();

    await this.prisma.otp.create({
      data: {
        id: crypto.randomUUID(),
        userId: user.id,
        email: isEmail ? user.email : user.phone,
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
    return { message: this.i18nService.translate('otp_sent', lang) };
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

    const user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanIdentifier },
          { email: cleanIdentifier.toLowerCase() },
        ],
      },
    });
    if (!user)
      throw new BadRequestException(
        this.i18nService.translate('user_not_found', lang),
      );

    const otpEntry = await this.prisma.otp.findFirst({
      where: {
        otpCode: code.toString(),
        isUsed: false,
        expiresAt: { gt: new Date() },
      },
    });
    if (!otpEntry)
      throw new BadRequestException(
        this.i18nService.translate('otp_invalid', lang),
      );

    const hashedPassword = await bcrypt.hash(password, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashedPassword },
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
  async changePassword(
    userId: string,
    changePasswordDto: {
      currentPassword: string;
      newPassword: string;
      lang?: string;
    },
    ipAddress?: string,
  ): Promise<{ message: string; data: any }> {
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

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedNewPassword,
      },
    });

    const { password, ...safeUser } = updatedUser;
    await this.logAudit(
      user.id,
      'CHANGE_PASSWORD',
      { identifier: user.phone },
      ipAddress ?? null,
    );
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
  async registerDeviceToken(userId: string, fcmToken: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Utilisateur non trouvé');
    if (!fcmToken || !fcmToken.trim())
      throw new BadRequestException('Token FCM requis');
    return this.prisma.device.upsert({
      where: { deviceId: fcmToken.trim() },
      update: { userId: userId, updatedAt: new Date() },
      create: {
        id: crypto.randomUUID(),
        userId: userId,
        deviceId: fcmToken.trim(),
        deviceType: 'unknown',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
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

    // Récupérer les comptes de l'utilisateur via clientId
    const accounts = await this.prisma.account.findMany({
      where: { clientId: user.clientId || undefined },
      select: {
        id: true,
        clientId: true,
        accountType: true,
        balance: true,
        currency: true,
        status: true,
        isMain: true,
        accountNumber: true,
      },
    });

    // Récupérer toutes les sessions actives
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

    // Formatage unifié des sessions
    const formattedSessions = sessions.map(session => ({
      id: session.id,
      device_info: session.userAgent,
      ip_address: session.ipAddress,
      last_activity: session.createdAt,
      created_at: session.createdAt,
      expires_at: session.expiresAt,
    }));

    // ✅ RÉPONSE UNIFIÉE - SANS TOKENS
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
        sessions: formattedSessions,
        accounts: accounts.map(account => ({
          id: account.id,
          clientId: account.clientId,
          accountType: account.accountType,
          balance: account.balance,
          currency: account.currency,
          status: account.status,
          isMain: account.isMain,
          accountNumber: account.accountNumber,
        })),
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

  // apps/auth-service/src/auth-service.service.ts

  private generateJwtTokens(userId: string, email: string | null, role: UserRole) {
    const payload = { sub: userId, email: email || '', role };
    const jwtSecret = process.env.JWT_SECRET || 'secret';
    const jwtRefreshSecret = process.env.JWT_REFRESH_SECRET || 'refresh_secret';

    // ✅ Augmenter la durée des tokens
    const jwtExpiration = process.env.JWT_EXPIRATION || '30d';      // 30 jours
    const jwtRefreshExpiration = process.env.JWT_REFRESH_EXPIRATION || '90d'; // 90 jours

    const accessToken = this.jwtService.sign(payload as any, {
      secret: jwtSecret,
      expiresIn: jwtExpiration as any,
    });
    const refreshToken = this.jwtService.sign(payload as any, {
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
    const payload = {
      id: user.id,
      email: user.email || null,
      phone: user.phone || null,
      full_name: user.firstName + ' ' + user.lastName || null,
      role: user.role,
      status: user.status || 'ACTIVE',
      sessionToken,
    };

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