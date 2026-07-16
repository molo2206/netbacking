/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/user-service.service.ts
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { MailService } from 'apps/auth-service/src/email/email.service';
import { I18nService } from '../../../libs/common/src/i18n/i18n.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { CreateUserFromAccountDto } from '../dto/create-user-from-account.dto';
import { UpdateUserSettingsDto } from '../dto/user-settings.dto';
import { AssignMultipleResourcesDto } from '../dto/assign-resource.dto';
import { UpsertAppSettingsDto } from '../dto/app-settings.dto';
import { UserRole, users_status } from '@prisma/client';
import { ApiResponse } from '../interfaces/api-response.interface';
import { UserResponseDto } from '../dto/user-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateResourceDto, UpdateResourceDto } from '../dto/resource.dto';
import { UpdateUserDto } from '../dto/update-user.dto';

@Injectable()
export class UserServiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly smsService: SmsService,
    private readonly mailService: MailService,
    private readonly i18nService: I18nService,
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
          entity: 'USER',
          entityId: userId || undefined,
          ipAddress: ipAddress || undefined,
          level: 'INFO',
        },
      });
    } catch (err) {
      console.error('Audit log failed:', err);
    }
  }

  private toResponse(user: any): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      phone: user.phone,
      firstName: user.firstName,
      lastName: user.lastName,
      photo: user.photo,
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
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  // ========================= CREATE USER =========================
  async createUser(
    data: CreateUserDto,
    ipAddress?: string,
  ): Promise<ApiResponse<UserResponseDto>> {
    const lang = data.lang || 'fr';
    console.log(`[createUser] Langue utilisée : ${lang} pour ${data.email || data.phone}`);

    // 1. Vérifier que email ou phone est fourni
    if (!data.email && !data.phone) {
      throw new RpcException({
        status: 'error',
        message: 'Email or phone is required',
        statusCode: 400,
      });
    }

    // 2. Vérifier les doublons d'email - Utiliser findFirst car email est nullable
    if (data.email) {
      const existing = await this.prisma.user.findFirst({
        where: { email: data.email.toLowerCase() },
      });
      if (existing) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('email_already_exists', lang),
          statusCode: 409,
        });
      }
    }

    // 3. Vérifier les doublons de téléphone
    if (data.phone) {
      const existing = await this.prisma.user.findFirst({
        where: { phone: data.phone },
      });
      if (existing) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('phone_already_exists', lang),
          statusCode: 409,
        });
      }
    }

    // 4. Vérifier les doublons de clientId
    if (data.clientId) {
      const existing = await this.prisma.user.findFirst({
        where: { clientId: data.clientId },
      });
      if (existing) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('clientId_already_exists', lang),
          statusCode: 409,
        });
      }
    }

    // 5. Hasher le mot de passe
    const hashedPassword = await bcrypt.hash(data.password || 'Accespay!26', 10);

    // 6. Création de l'utilisateur
    const user = await this.prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: data.email ? data.email.toLowerCase() : `${crypto.randomUUID().slice(0, 8)}@accespay.com`,
        phone: data.phone || `000000000${crypto.randomUUID().slice(0, 4)}`,
        firstName: data.firstName,
        lastName: data.lastName,
        password: hashedPassword,
        role: data.role || UserRole.USER,
        status: users_status.ACTIVE,
        clientId: data.clientId || null,
        createdBy: data.createdBy || null,
      },
    });

    // 7. Créer les paramètres utilisateur par défaut
    await this.prisma.user_settings.create({
      data: {
        user_id: user.id,
        language: 'fr',
        theme: 'system',
        email_notifications: true,
        sms_notifications: true,
        push_notifications: true,
        two_factor_enabled: false,
      },
    });

    // 8. SMS de bienvenue
    if (data.phone) {
      const cleanPhone = data.phone.replace(/[^0-9+]/g, '');
      try {
        const smsText = this.i18nService.translate('welcome_sms', lang, {
          full_name: `${user.firstName} ${user.lastName}`,
          phone: cleanPhone,
          password: 'Accespay!26',
        });
        await this.smsService.sendSms(cleanPhone, smsText);
      } catch (smsErr) {
        console.error(`SMS non envoyé à ${cleanPhone}:`, smsErr.message);
      }
    }

    // 9. Email de bienvenue
    if (user.email) {
      try {
        await this.mailService.sendHtmlEmail(
          user.email,
          this.i18nService.translate('welcome_email_title', lang),
          'welcome-email.html',
          {
            title: this.i18nService.translate('welcome_email_title', lang),
            greeting: this.i18nService.translate('welcome_email_greeting', lang, {
              name: `${user.firstName} ${user.lastName}`,
            }),
            message: this.i18nService.translate('welcome_email_message', lang),
            credentials_label: this.i18nService.translate('welcome_email_credentials', lang),
            phone_label: `${this.i18nService.translate('phone', lang)}: ${user.phone || ''}`,
            password_label: `${this.i18nService.translate('password', lang)}: Accespay!26`,
            recommend: this.i18nService.translate('welcome_email_recommend', lang),
            support: this.i18nService.translate('welcome_email_support', lang),
            footer: this.i18nService.translate('welcome_email_footer', lang),
            sent_to: this.i18nService.translate('email_sent_to', lang),
            copyright: `© ${new Date().getFullYear()} ACCESPAY`,
            email: user.email,
          },
        );
      } catch (emailError) {
        console.error(`Erreur envoi email à ${user.email}:`, emailError);
      }
    }

    // 10. Audit
    await this.logAudit(user.id, 'CREATE_USER', { identifier: user }, ipAddress ?? null);

    return {
      message: this.i18nService.translate('user_created_success', lang),
      data: this.toResponse(user),
    };
  }

  // ========================= CREATE USER FROM ACCOUNT =========================
  async createUserFromAccount(
    data: CreateUserFromAccountDto,
    ipAddress?: string,
  ): Promise<ApiResponse<UserResponseDto>> {
    const lang = data.lang || 'fr';
    console.log(`[createUserFromAccount] Langue utilisée : ${lang} pour ${data.fullName}`);

    // 1. Vérifier que phone est fourni
    if (!data.phone) {
      throw new RpcException({
        status: 'error',
        message: 'Phone number is required',
        statusCode: 400,
      });
    }

    // 2. Vérifier doublon téléphone
    const existing = await this.prisma.user.findFirst({
      where: { phone: data.phone },
    });
    if (existing) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('phone_already_exists', lang),
        statusCode: 409,
      });
    }

    // 3. Générer l'email si non fourni
    const email = data.email?.toLowerCase() || `${data.fullName.replace(/\s/g, '.').toLowerCase()}.${crypto.randomUUID().slice(0, 4)}@accespay.com`;

    // 4. Vérifier doublon email
    const existingEmail = await this.prisma.user.findFirst({
      where: { email: email },
    });
    if (existingEmail) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('email_already_exists', lang),
        statusCode: 409,
      });
    }

    // 5. Vérifier clientId
    let clientId = data.clientId;
    if (!clientId) {
      clientId = `CLT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const existingClient = await this.prisma.user.findFirst({
        where: { clientId },
      });
      if (existingClient) {
        clientId = `CLT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      }
    }

    // 6. Vérifier si le client existe déjà dans clients
    const existingClient = await this.prisma.clients.findFirst({
      where: { clientId: clientId },
    });

    if (!existingClient) {
      // Créer le client s'il n'existe pas
      await this.prisma.clients.create({
        data: {
          id: crypto.randomUUID(),
          clientId: clientId,
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          status: 'ACTIVE',
        },
      });
    }

    // 7. Hasher le mot de passe
    const defaultPassword = 'Accespay!26';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    // 8. Créer l'utilisateur
    const user = await this.prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: email,
        phone: data.phone,
        firstName: data.fullName.split(' ')[0] || '',
        lastName: data.fullName.split(' ').slice(1).join(' ') || '',
        password: hashedPassword,
        role: data.role || UserRole.USER,
        status: users_status.ACTIVE,
        clientId: clientId,
        createdBy: data.createdBy || null,
      },
    });

    // 9. Créer les paramètres utilisateur
    await this.prisma.user_settings.create({
      data: {
        user_id: user.id,
        language: 'fr',
        theme: 'system',
        email_notifications: true,
        sms_notifications: true,
        push_notifications: true,
        two_factor_enabled: false,
      },
    });

    // 10. SMS de bienvenue
    const cleanPhone = data.phone.replace(/[^0-9+]/g, '');
    try {
      const smsText = this.i18nService.translate('welcome_sms', lang, {
        full_name: data.fullName,
        phone: cleanPhone,
        password: defaultPassword,
      });
      await this.smsService.sendSms(cleanPhone, smsText);
    } catch (smsErr) {
      console.error(`SMS non envoyé à ${cleanPhone}:`, smsErr.message);
    }

    // 11. Email de bienvenue
    if (user.email) {
      try {
        await this.mailService.sendHtmlEmail(
          user.email,
          this.i18nService.translate('welcome_email_title', lang),
          'welcome-email.html',
          {
            title: this.i18nService.translate('welcome_email_title', lang),
            greeting: this.i18nService.translate('welcome_email_greeting', lang, {
              name: data.fullName,
            }),
            message: this.i18nService.translate('welcome_email_message', lang),
            credentials_label: this.i18nService.translate('welcome_email_credentials', lang),
            phone_label: `${this.i18nService.translate('phone', lang)}: ${user.phone || ''}`,
            password_label: `${this.i18nService.translate('password', lang)}: ${defaultPassword}`,
            recommend: this.i18nService.translate('welcome_email_recommend', lang),
            support: this.i18nService.translate('welcome_email_support', lang),
            footer: this.i18nService.translate('welcome_email_footer', lang),
            sent_to: this.i18nService.translate('email_sent_to', lang),
            copyright: `© ${new Date().getFullYear()} ACCESPAY`,
            email: user.email,
          },
        );
      } catch (emailError) {
        console.error(`Erreur envoi email à ${user.email}:`, emailError);
      }
    }

    await this.logAudit(user.id, 'CREATE_USER_FROM_ACCOUNT', { identifier: user }, ipAddress ?? null);

    return {
      message: this.i18nService.translate('user_created_success', lang),
      data: this.toResponse(user),
    };
  }

  // ========================= GET USER =========================
  async getUser(id: string, lang: string = 'fr'): Promise<{ message: string; data: UserResponseDto }> {
    console.log(`[getUser] Langue utilisée : ${lang} pour l'utilisateur ${id}`);

    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        photo: true,
        role: true,
        status: true,
        clientId: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        isTwoFactorEnabled: true,
        preferredLanguage: true,
        preferredCurrency: true,
        timezone: true,
        pinStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: this.toResponse(user),
    };
  }

  // ========================= GET USER BY EMAIL =========================
  async getUserByEmail(email: string, lang: string = 'fr'): Promise<ApiResponse<UserResponseDto>> {
    console.log(`[getUserByEmail] Langue utilisée : ${lang} pour l'email ${email}`);

    if (!email) {
      throw new RpcException({
        status: 'error',
        message: 'Email is required',
        statusCode: 400,
      });
    }

    // Utiliser findFirst car email est nullable
    const user = await this.prisma.user.findFirst({
      where: { email: email.toLowerCase() },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: this.toResponse(user),
    };
  }

  // ========================= GET USER BY PHONE =========================
  async getUserByPhone(phone: string, lang: string = 'fr'): Promise<ApiResponse<UserResponseDto>> {
    console.log(`[getUserByPhone] Langue utilisée : ${lang} pour le téléphone ${phone}`);

    if (!phone) {
      throw new RpcException({
        status: 'error',
        message: 'Phone number is required',
        statusCode: 400,
      });
    }

    const user = await this.prisma.user.findFirst({ where: { phone } });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: this.toResponse(user),
    };
  }

  // ========================= GET USER BY CLIENT ID =========================
  async getUserByClientId(clientId: string, lang: string = 'fr'): Promise<ApiResponse<UserResponseDto>> {
    console.log(`[getUserByClientId] Langue utilisée : ${lang} pour le clientId ${clientId}`);

    if (!clientId) {
      throw new RpcException({
        status: 'error',
        message: 'Client ID is required',
        statusCode: 400,
      });
    }

    const user = await this.prisma.user.findFirst({
      where: { clientId },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    return {
      message: this.i18nService.translate('user_retrieved_success', lang),
      data: this.toResponse(user),
    };
  }

  // ========================= UPDATE USER =========================
  async updateUser(
    id: string,
    data: UpdateUserDto,
    lang: string = 'fr',
  ): Promise<ApiResponse<UserResponseDto>> {
    console.log(`[updateUser] Langue utilisée : ${lang} pour l'utilisateur ${id}`);

    const existingUser = await this.prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // Vérification d'unicité du téléphone
    if (data.phone && data.phone !== existingUser.phone) {
      const phoneExists = await this.prisma.user.findFirst({
        where: { phone: data.phone, id: { not: id } },
      });
      if (phoneExists) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('phone_already_exists', lang),
          statusCode: 409,
        });
      }
    }

    // Vérification d'unicité du clientId
    if (data.clientId && data.clientId !== existingUser.clientId) {
      const clientExists = await this.prisma.user.findFirst({
        where: { clientId: data.clientId, id: { not: id } },
      });
      if (clientExists) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('clientId_already_exists', lang),
          statusCode: 409,
        });
      }
    }

    // Préparation des données de mise à jour
    const updateData: any = {};
    if (data.email) updateData.email = data.email.toLowerCase();
    if (data.phone) updateData.phone = data.phone;
    if (data.firstName) updateData.firstName = data.firstName;
    if (data.lastName) updateData.lastName = data.lastName;
    if (data.photo) updateData.photo = data.photo;
    if (data.role) updateData.role = data.role;
    if (data.status) updateData.status = data.status;
    if (data.clientId) updateData.clientId = data.clientId;
    if (data.preferredLanguage) updateData.preferredLanguage = data.preferredLanguage;
    if (data.preferredCurrency) updateData.preferredCurrency = data.preferredCurrency;
    if (data.timezone) updateData.timezone = data.timezone;

    // Gestion du mot de passe
    if (data.password) {
      updateData.password = await bcrypt.hash(data.password, 10);
    }

    // Gestion du PIN
    if (data.pin) {
      const hashedPin = crypto.createHash('sha256').update(data.pin).digest('hex');
      updateData.pin = hashedPin;
      updateData.pinStatus = true;
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: updateData,
    });

    await this.logAudit(user.id, 'UPDATE_USER', { identifier: user }, null);

    return {
      message: this.i18nService.translate('user_updated_success', lang),
      data: this.toResponse(user),
    };
  }

  // ========================= UPDATE USER STATUS =========================
  async updateUserStatus(
    id: string,
    status: string,
    requesterId: string,
    lang: string = 'fr',
  ): Promise<ApiResponse<UserResponseDto>> {
    console.log(`[updateUserStatus] Langue: ${lang}, user: ${id}, requester: ${requesterId}, status: ${status}`);

    const userExist = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!userExist) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    if (requesterId === id) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('cannot_change_own_status', lang),
        statusCode: 403,
      });
    }

    const normalized = status.trim().toUpperCase();
    const allowed = ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'LOCKED', 'PENDING_VERIFICATION', 'DELETED'];
    if (!allowed.includes(normalized)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('invalid_status', lang, { allowed: allowed.join(', ') }),
        statusCode: 400,
      });
    }

    const user = await this.prisma.user.update({
      where: { id },
      data: { status: normalized as users_status },
    });

    return {
      message: this.i18nService.translate('status_updated_success', lang),
      data: this.toResponse(user),
    };
  }

  // ========================= DELETE USER =========================
  async deleteUser(id: string, lang: string = 'fr'): Promise<ApiResponse<null>> {
    console.log(`[deleteUser] Langue utilisée : ${lang} pour l'utilisateur ${id}`);

    await this.prisma.user.update({
      where: { id },
      data: { status: users_status.LOCKED, deletedAt: new Date() },
    });

    return {
      message: this.i18nService.translate('user_deleted_success', lang),
      data: null,
    };
  }

  // ========================= LIST USERS =========================
  async listUsers(params: {
    page: number;
    limit: number;
    role?: string;
    status?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    console.log(`[listUsers] Langue utilisée : ${lang}`);
    const { page = 1, limit = 10, role, status } = params;
    const skip = (page - 1) * limit;
    const where: any = { status: { not: users_status.LOCKED } };

    if (role) where.role = role;
    if (status) where.status = status;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((user) => this.toResponse(user)),
      total,
      page,
      limit,
    };
  }

  // ========================= LIST USERS WITH LINKS =========================
  async listUsersLinks(params: {
    page: number;
    limit: number;
    role?: string;
    status?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    console.log(`[listUsersLinks] Langue utilisée : ${lang}`);
    const { page = 1, limit = 10, role, status } = params;
    const skip = (page - 1) * limit;
    const where: any = {
      status: { not: users_status.LOCKED },
      clientId: { not: null },
    };

    if (role) where.role = role;
    if (status) where.status = status;

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          phone: true,
          firstName: true,
          lastName: true,
          clientId: true,
          role: true,
          status: true,
          createdAt: true,
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      users: users.map((user) => ({
        id: user.id,
        email: user.email,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        clientId: user.clientId,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  // ========================= UPDATE PIN =========================
  async updatePin(
    userId: string,
    oldPin: string,
    newPin: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    console.log(`[updatePin] Langue utilisée : ${lang} pour l'utilisateur ${userId}`);

    if (!oldPin || oldPin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('old_pin_min_length', lang),
        statusCode: 400,
      });
    }
    if (!/^\d+$/.test(oldPin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_digits_only', lang),
        statusCode: 400,
      });
    }
    if (!newPin || newPin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('new_pin_min_length', lang),
        statusCode: 400,
      });
    }
    if (!/^\d+$/.test(newPin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // Récupérer l'utilisateur avec cast pour les champs PIN
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    }) as any;

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    if (!user.pin) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('no_pin_set', lang),
        statusCode: 400,
      });
    }

    const hashedOldPin = crypto.createHash('sha256').update(oldPin).digest('hex');
    if (user.pin !== hashedOldPin) {
      const newAttempts = (user.failedPinAttempts || 0) + 1;
      const pinLockedUntil: Date | null = newAttempts >= 5
        ? new Date(Date.now() + 30 * 60 * 1000)
        : null;

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failedPinAttempts: newAttempts,
          pinLockedUntil: pinLockedUntil,
        },
      });

      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('old_pin_incorrect', lang),
        statusCode: 401,
      });
    }

    const hashedNewPin = crypto.createHash('sha256').update(newPin).digest('hex');
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        pin: hashedNewPin,
        pinStatus: true,
        failedPinAttempts: 0,
        pinLockedUntil: null,
      },
    });

    return {
      message: this.i18nService.translate('pin_changed_success', lang),
      data: this.toResponse(updatedUser),
    };
  }

  // ========================= VERIFY PIN =========================
  async verifyPin(
    userId: string,
    pin: string,
    lang: string = 'fr',
  ): Promise<{ valid: boolean; message: string }> {
    console.log(`[verifyPin] Langue utilisée : ${lang} pour l'utilisateur ${userId}`);

    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_min_length', lang),
        statusCode: 400,
      });
    }
    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // Récupérer l'utilisateur avec cast pour les champs PIN
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    }) as any;

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    if (!user.pinStatus || !user.pin) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('no_pin_set', lang),
        statusCode: 400,
      });
    }

    // Vérifier si le PIN est verrouillé
    if (user.pinLockedUntil && user.pinLockedUntil.getTime() > Date.now()) {
      const minutesLeft = Math.ceil((user.pinLockedUntil.getTime() - Date.now()) / 60000);
      throw new RpcException({
        status: 'error',
        message: `PIN verrouillé pour ${minutesLeft} minutes`,
        statusCode: 403,
      });
    }

    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    const isValid = user.pin === hashedPin;

    if (!isValid) {
      const newAttempts = (user.failedPinAttempts || 0) + 1;
      const pinLockedUntil: Date | null = newAttempts >= 5
        ? new Date(Date.now() + 30 * 60 * 1000)
        : null;

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failedPinAttempts: newAttempts,
          pinLockedUntil: pinLockedUntil,
        },
      });

      await this.prisma.login_attempt.create({
        data: {
          userId: userId,
          identifier: 'pin_verification',
          success: false,
          failed_pin_attempts: newAttempts,
          pin_locked_until: pinLockedUntil,
        },
      });

      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_invalid', lang),
        statusCode: 400,
      });
    }

    // Succès - Réinitialiser
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedPinAttempts: 0,
        pinLockedUntil: null,
      },
    });

    await this.prisma.login_attempt.create({
      data: {
        userId: userId,
        identifier: 'pin_verification',
        success: true,
        failed_pin_attempts: 0,
        pin_locked_until: null,
      },
    });

    return {
      valid: true,
      message: this.i18nService.translate('pin_valid', lang),
    };
  }

  // ========================= CHANGE PIN =========================
  async changePin(
    userId: string,
    pin: string,
    lang: string = 'fr',
  ): Promise<{ message: string; data: any }> {
    console.log(`[changePin] Langue utilisée : ${lang} pour l'utilisateur ${userId}`);

    if (!pin || pin.length < 4) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_min_length', lang),
        statusCode: 400,
      });
    }
    if (!/^\d+$/.test(pin)) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('pin_digits_only', lang),
        statusCode: 400,
      });
    }

    // Vérifier que l'utilisateur existe
    const userExists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!userExists) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        pin: hashedPin,
        pinStatus: true,
        failedPinAttempts: 0,
        pinLockedUntil: null,
      },
    });

    return {
      message: this.i18nService.translate('pin_changed_success', lang),
      data: this.toResponse(updatedUser),
    };
  }

  // ========================= USER SETTINGS =========================
  async getUserSettings(userId: string): Promise<{ message: string; data: any }> {
    let settings = await this.prisma.user_settings.findUnique({
      where: { user_id: userId },
    });

    if (!settings) {
      settings = await this.prisma.user_settings.create({
        data: {
          user_id: userId,
          language: 'fr',
          theme: 'system',
          email_notifications: true,
          sms_notifications: true,
          push_notifications: true,
          two_factor_enabled: false,
        },
      });
    }

    return {
      message: 'Settings retrieved successfully',
      data: settings,
    };
  }

  async updateUserSettings(
    userId: string,
    dto: UpdateUserSettingsDto,
  ): Promise<{ message: string; data: any }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new RpcException({
        status: 'error',
        message: 'User not found',
        statusCode: 404,
      });
    }

    const data: any = { ...dto };
    if (dto.theme) {
      data.theme = dto.theme.toLowerCase();
    }

    const settings = await this.prisma.user_settings.upsert({
      where: { user_id: userId },
      update: data,
      create: { user_id: userId, ...data },
    });

    return {
      message: 'Settings updated successfully',
      data: settings,
    };
  }

  // ========================= ADMIN DASHBOARD =========================
  async getAdminDashboard(filters?: { startDate?: Date; endDate?: Date }) {
    try {
      let { startDate, endDate } = filters || {};

      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        startDate = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        endDate = end;
      }

      const now = new Date();
      if (!startDate && !endDate) {
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        endDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      }

      const dateFilter: any = {};
      if (startDate && !isNaN(startDate.getTime())) {
        dateFilter.gte = startDate;
      }
      if (endDate && !isNaN(endDate.getTime())) {
        dateFilter.lte = endDate;
      }

      const transactionWhere: any = {};
      if (Object.keys(dateFilter).length > 0) {
        transactionWhere.createdAt = dateFilter;
      }

      const userWhere: any = { status: { not: users_status.LOCKED } };

      const [totalUsers, totalTransactions] = await Promise.all([
        this.prisma.user.count({ where: userWhere }),
        this.prisma.transaction.count({ where: transactionWhere }),
      ]);

      return {
        message: 'Dashboard data retrieved successfully',
        data: {
          keyMetrics: {
            totalRegisteredUsers: totalUsers,
            totalAdmin: 0,
            totalSuperAdmin: 0,
            totalMerchant: 0,
          },
          wallet: {
            totalTransactionsToday: totalTransactions,
            totalTransactionVolume: 0,
            pendingTransactions: 0,
            failedTransactions: 0,
          },
          charts: {
            transactionVolume: [],
            paymentsByType: [],
            userGrowth: [],
            platformRevenue: 0,
          },
          quickStatus: {
            successRate: 0,
            avgTransactionAmount: 0,
            pendingRate: 0,
          },
        },
      };
    } catch (error) {
      console.error('[Dashboard] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to fetch dashboard data',
        statusCode: 500,
      });
    }
  }

  // ========================= RESOURCES MANAGEMENT =========================
  async createResource(data: CreateResourceDto) {
    try {
      const resource = await this.prisma.resources.create({
        data: {
          name: data.name,
          label: data.label,
          description: data.description,
        },
      });
      return { message: 'Resource created successfully', data: resource };
    } catch (error) {
      if (error.code === 'P2002') {
        throw new RpcException({
          status: 'error',
          message: `Resource with name "${data.name}" already exists.`,
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async updateResource(id: string, data: UpdateResourceDto) {
    const exists = await this.prisma.resources.findUnique({ where: { id } });
    if (!exists) {
      throw new RpcException({
        status: 'error',
        message: 'Resource not found',
        statusCode: 404,
      });
    }
    try {
      const resource = await this.prisma.resources.update({
        where: { id },
        data: {
          name: data.name,
          label: data.label,
          description: data.description,
        },
      });
      return { message: 'Resource updated successfully', data: resource };
    } catch (error) {
      if (error.code === 'P2002') {
        throw new RpcException({
          status: 'error',
          message: `Resource name "${data.name}" already taken.`,
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  async getAllResources(page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;
    const [resources, total] = await Promise.all([
      this.prisma.resources.findMany({
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.resources.count(),
    ]);
    return {
      message: 'Resources retrieved successfully',
      data: { data: resources, total, page, limit },
    };
  }

  async getOneResource(id: string) {
    const resource = await this.prisma.resources.findUnique({ where: { id } });
    if (!resource) {
      throw new RpcException({
        status: 'error',
        message: 'Resource not found',
        statusCode: 404,
      });
    }
    return { message: 'Resource retrieved successfully', data: resource };
  }

  // ========================= USER RESOURCES =========================
  async assignMultipleResourcesToUser(data: AssignMultipleResourcesDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
    });
    if (!user) {
      throw new RpcException({
        status: 'error',
        message: 'User not found',
        statusCode: 404,
      });
    }

    // Supprimer toutes les assignations existantes
    await this.prisma.user_has_resources.deleteMany({
      where: { userId: data.userId },
    });

    // Créer les nouvelles assignations
    for (const item of data.resources) {
      const resource = await this.prisma.resources.findUnique({
        where: { id: item.resourceId },
      });
      if (!resource) {
        throw new RpcException({
          status: 'error',
          message: `Resource with id ${item.resourceId} not found`,
          statusCode: 404,
        });
      }

      await this.prisma.user_has_resources.create({
        data: {
          userId: data.userId,
          resourceId: item.resourceId,
          canCreate: item.canCreate ?? false,
          canRead: item.canRead ?? false,
          canUpdate: item.canUpdate ?? false,
          canDelete: item.canDelete ?? false,
          canManage: item.canManage ?? false,
          grantedBy: data.grantedBy,
          expiresAt: item.expiresAt,
        },
      });
    }

    return { message: 'Resource assignments processed successfully' };
  }

  async getUserResources(userId: string) {
    const userResources = await this.prisma.user_has_resources.findMany({
      where: { userId },
      include: { resources: true },
    });

    const data = userResources.map((ur) => ({
      resource: ur.resources,
      canCreate: ur.canCreate,
      canRead: ur.canRead,
      canUpdate: ur.canUpdate,
      canDelete: ur.canDelete,
      canManage: ur.canManage,
      grantedAt: ur.grantedAt,
      grantedBy: ur.grantedBy,
      expiresAt: ur.expiresAt,
    }));

    return {
      message: 'User resources retrieved successfully',
      data,
    };
  }

  async revokeResource(userId: string, resourceId: string) {
    const assignment = await this.prisma.user_has_resources.findUnique({
      where: { userId_resourceId: { userId, resourceId } },
    });
    if (!assignment) {
      throw new RpcException({
        status: 'error',
        message: 'Resource assignment not found',
        statusCode: 404,
      });
    }
    await this.prisma.user_has_resources.delete({
      where: { id: assignment.id },
    });
    return { message: 'Resource revoked successfully' };
  }

  // ========================= APP SETTINGS =========================
  async upsertAppSettings(data: UpsertAppSettingsDto) {
    const existing = await this.prisma.settings.findFirst({
      where: { key: 'app_settings' },
    });

    if (existing) {
      const settings = await this.prisma.settings.update({
        where: { id: existing.id },
        data: {
          value: JSON.stringify(data),
          updatedAt: new Date(),
        },
      });
      return {
        message: 'Application settings updated successfully',
        data: JSON.parse(settings.value),
      };
    } else {
      const settings = await this.prisma.settings.create({
        data: {
          id: crypto.randomUUID(),
          key: 'app_settings',
          value: JSON.stringify(data),
          category: 'app',
          isPublic: true,
        },
      });
      return {
        message: 'Application settings created successfully',
        data: JSON.parse(settings.value),
      };
    }
  }

  async getAppSettings() {
    const settings = await this.prisma.settings.findFirst({
      where: { key: 'app_settings' },
    });

    if (!settings) {
      return {
        message: 'Application settings not found',
        data: null,
      };
    }

    return {
      message: 'Application settings retrieved successfully',
      data: JSON.parse(settings.value),
    };
  }


  async getClientByClientId(
    clientId: string,
    lang: string = 'fr'
  ): Promise<{ message: string; data: any }> {
    console.log(`[getClientByClientId] Langue utilisée : ${lang} pour le clientId ${clientId}`);

    if (!clientId) {
      throw new RpcException({
        status: 'error',
        message: 'Client ID is required',
        statusCode: 400,
      });
    }

    // Récupérer le client depuis la table clients
    const client = await this.prisma.clients.findUnique({
      where: { clientId: clientId },
      include: {
        accounts: {
          select: {
            id: true,
            clientId: true,
            accountType: true,
            balance: true,
            currency: true,
            status: true,
            isMain: true,
          },
        },
      },
    });

    if (!client) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('client_not_found', lang),
        statusCode: 404,
      });
    }

    // Récupérer l'utilisateur lié à ce clientId
    const user = await this.prisma.user.findFirst({
      where: { clientId: clientId },
      select: {
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        photo: true,
        preferredLanguage: true,
        preferredCurrency: true,
        timezone: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      message: this.i18nService.translate('client_retrieved_success', lang),
      data: {
        client: {
          id: client.id,
          clientId: client.clientId,
          fullName: client.fullName,
          email: client.email,
          phone: client.phone,
          address: client.address,
          city: client.city,
          country: client.country,
          idNumber: client.idNumber,
          idType: client.idType,
          dateOfBirth: client.dateOfBirth,
          gender: client.gender,
          status: client.status,
          kycLevel: client.kycLevel,
          kycVerifiedAt: client.kycVerifiedAt,
          profilePicture: client.profilePicture,
          createdAt: client.createdAt,
          updatedAt: client.updatedAt,
          accounts: client.accounts,
        },
        user: user || null,
      },
    };
  }

  async listAllClients(params: {
    page: number;
    limit: number;
    search?: string;
    status?: string;
    kycLevel?: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    console.log(`[listAllClients] Langue utilisée : ${lang}`);

    const { page = 1, limit = 10, search, status, kycLevel } = params;
    const skip = (page - 1) * limit;

    // Construire la condition WHERE
    const where: any = {};

    if (status) {
      where.status = status;
    }

    if (kycLevel) {
      where.kycLevel = kycLevel;
    }

    if (search) {
      where.OR = [
        { clientId: { contains: search } },
        { fullName: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
      ];
    }

    // Récupérer les clients avec leurs comptes
    const [clients, total] = await Promise.all([
      this.prisma.clients.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          accounts: {
            select: {
              id: true,
              accountType: true,
              balance: true,
              currency: true,
              status: true,
              isMain: true,
            },
          },
        },
      }),
      this.prisma.clients.count({ where }),
    ]);

    // Récupérer les utilisateurs liés à chaque client
    const clientIds = clients.map(c => c.clientId);
    const users = await this.prisma.user.findMany({
      where: { clientId: { in: clientIds } },
      select: {
        clientId: true,
        id: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    // Mapper les utilisateurs par clientId
    const userMap = new Map();
    users.forEach(user => {
      if (user.clientId) {
        userMap.set(user.clientId, user);
      }
    });

    // Formater la réponse
    const formattedClients = clients.map(client => ({
      ...client,
      accounts: client.accounts,
      user: userMap.get(client.clientId) || null,
    }));

    // ✅ Retourner avec data.data
    return {
      message: this.i18nService.translate('clients_list_retrieved', lang),
      data: {
        data: formattedClients,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getUserAccounts(
    userId: string,
    lang: string = 'fr'
  ): Promise<{ message: string; data: any }> {
    console.log(`[getUserAccounts] Langue utilisée : ${lang} pour l'utilisateur ${userId}`);

    if (!userId) {
      throw new RpcException({
        status: 'error',
        message: 'User ID is required',
        statusCode: 400,
      });
    }

    // 1. Vérifier que l'utilisateur existe
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        clientId: true,
        email: true,
        phone: true,
        firstName: true,
        lastName: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // 2. Récupérer les comptes de l'utilisateur via clientId
    let accounts: any[] = [];

    if (user.clientId) {
      accounts = await this.prisma.account.findMany({
        where: { clientId: user.clientId },
        select: {
          id: true,
          clientId: true,
          accountNumber: true,
          accountType: true,
          balance: true,
          currency: true,
          status: true,
          isMain: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: {
          isMain: 'desc',
        },
      });
    }

    // 3. Récupérer les informations du client
    let clientInfo = null;
    if (user.clientId) {
      clientInfo = await this.prisma.clients.findUnique({
        where: { clientId: user.clientId },
        select: {
          fullName: true,
          email: true,
          phone: true,
          status: true,
          kycLevel: true,
        },
      });
    }

    return {
      message: this.i18nService.translate('user_accounts_retrieved', lang),
      data: {
        user: {
          id: user.id,
          clientId: user.clientId,
          email: user.email,
          phone: user.phone,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: `${user.firstName} ${user.lastName}`,
        },
        client: clientInfo,
        accounts: accounts,
        total: accounts.length,
        summary: {
          totalBalance: accounts.reduce((sum, acc) => sum + (acc.balance?.toNumber() || 0), 0),
          currencies: [...new Set(accounts.map(acc => acc.currency))],
          types: {
            courant: accounts.filter(a => a.accountType === 'COURANT').length,
            epargne: accounts.filter(a => a.accountType === 'EPARGNE').length,
            premium: accounts.filter(a => a.accountType === 'PREMIUM').length,
          },
        },
      },
    };
  }
  // ========================= HEALTH CHECK =========================
  async healthCheck() {
    return { status: 'ok', service: 'user-service' };
  }
}