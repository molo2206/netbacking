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

  // apps/user-service/src/user-service.service.ts

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

    // ✅ Extraire firstName et lastName de fullName
    const nameParts = data.fullName.trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    if (!existingClient) {
      // ✅ Créer le client avec firstName et lastName
      await this.prisma.clients.create({
        data: {
          id: crypto.randomUUID(),
          clientId: clientId,
          firstName: firstName,
          lastName: lastName,
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
        firstName: firstName,
        lastName: lastName,
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
        firstName: user.firstName,
        lastName: user.lastName,
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
              firstName: user.firstName,
              lastName: user.lastName,
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

    // ✅ Vérifier si le PIN est verrouillé et si le temps est écoulé
    if (user.pinLockedUntil) {
      const now = new Date();
      if (now < user.pinLockedUntil) {
        const minutesLeft = Math.ceil((user.pinLockedUntil.getTime() - now.getTime()) / 60000);
        throw new RpcException({
          status: 'error',
          message: `PIN verrouillé pour ${minutesLeft} minutes`,
          statusCode: 400,
        });
      } else {
        // ✅ Le temps est écoulé, débloquer automatiquement
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            failedPinAttempts: 0,
            pinLockedUntil: null,
            status: 'ACTIVE' as users_status, // ✅ Cast du type
          },
        });
        // Mettre à jour l'objet user pour la suite
        user.failedPinAttempts = 0;
        user.pinLockedUntil = null;
        user.status = 'ACTIVE';
      }
    }

    const hashedPin = crypto.createHash('sha256').update(pin).digest('hex');
    const isValid = user.pin === hashedPin;

    if (!isValid) {
      const newAttempts = (user.failedPinAttempts || 0) + 1;
      let pinLockedUntil: Date | null = null;
      let newStatus: users_status = user.status || 'ACTIVE';

      if (newAttempts >= 5) {
        pinLockedUntil = new Date(Date.now() + 30 * 60 * 1000);
        newStatus = 'LOCKED' as users_status; // ✅ Cast du type
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          failedPinAttempts: newAttempts,
          pinLockedUntil: pinLockedUntil,
          status: newStatus,
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
        status: 'ACTIVE' as users_status, // ✅ Cast du type
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

    // Mettre à jour le PIN
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        pin: hashedPin,
        pinStatus: true,
        failedPinAttempts: 0,
        pinLockedUntil: null,
      },
    });

    // ✅ Récupérer l'utilisateur avec ses relations
    // La relation est User → clients (via clientId) → accounts
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        sessions: {
          where: { isActive: true },
          orderBy: { createdAt: 'desc' },
        },
        user_settings: true,
      },
    });

    if (!user) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('user_not_found', lang),
        statusCode: 404,
      });
    }

    // ✅ Récupérer les comptes séparément via clientId
    let accounts: any[] = [];
    if (user.clientId) {
      accounts = await this.prisma.account.findMany({
        where: { clientId: user.clientId },
        orderBy: { isMain: 'desc' },
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

    // ✅ Construire la réponse
    return {
      message: this.i18nService.translate('pin_changed_success', lang),
      data: {
        id: user.id,
        email: user.email,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        clientId: user.clientId,
        platform: user.platform,
        isEmailVerified: user.isEmailVerified,
        isPhoneVerified: user.isPhoneVerified,
        isTwoFactorEnabled: user.isTwoFactorEnabled,
        twoFactorSecret: user.twoFactorSecret,
        lastLoginAt: user.lastLoginAt,
        pinStatus: user.pinStatus,
        accounts: accounts.map((account: any) => ({
          id: account.id,
          clientId: account.clientId,
          accountType: account.accountType,
          balance: account.balance?.toString() || '0',
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
        sessions: user.sessions?.map((session: any) => ({
          id: session.id,
          device_info: session.deviceName,
          ip_address: session.ipAddress,
          last_activity: session.lastActivity,
          created_at: session.createdAt,
          expires_at: session.expiresAt,
        })) || [],
      },
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

  // apps/user-service/src/user-service.service.ts

  // ========================= GET CLIENT BY CLIENT ID =========================
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
          firstName: client.firstName,
          lastName: client.lastName,
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

  // apps/transaction-service/src/transaction-service.service.ts

  async getCheckbooksByAccount(data: {
    accountNumber: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';

    try {
      // 1. Récupérer le compte
      const account = await this.prisma.account.findUnique({
        where: { accountNumber: data.accountNumber },
        select: {
          id: true,
          accountNumber: true,
          balance: true,
          currency: true
        },
      });

      if (!account) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_not_found', lang),
          statusCode: 404,
        });
      }

      // 2. Récupérer les chéquiers sans les chèques
      const checkbooks = await this.prisma.checkbooks.findMany({
        where: { accountId: account.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          accountId: true,
          checkNumberStart: true,
          checkNumberEnd: true,
          totalChecks: true,
          usedChecks: true,
          remainingChecks: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      return {
        success: true,
        message: this.i18nService.translate('checkbooks_retrieved', lang),
        data: {
          accountNumber: account.accountNumber,
          balance: account.balance,
          currency: account.currency,
          checkbooks: checkbooks,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[Get Checkbooks By Account] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('checkbooks_retrieve_failed', lang),
        statusCode: 500,
      });
    }
  }

  // apps/user-service/src/user-service.service.ts

  async requestCheckbook(data: {
    accountNumber: string;
    pickUpBranch: string;
    numberOfCheckbookLeaves: number;
    numberofcheckbooks?: number;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';

    try {
      // 1. Vérifier le compte
      const account = await this.prisma.account.findUnique({
        where: { accountNumber: data.accountNumber },
      });

      if (!account) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_not_found', lang),
          statusCode: 404,
        });
      }

      if (account.status !== 'ACTIVE') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('account_inactive', lang),
          statusCode: 403,
        });
      }

      // 2. Vérifier les champs obligatoires
      if (!data.pickUpBranch) {
        throw new RpcException({
          status: 'error',
          message: 'L\'agence de retrait est requise',
          statusCode: 400,
        });
      }

      if (!data.numberOfCheckbookLeaves || data.numberOfCheckbookLeaves < 1) {
        throw new RpcException({
          status: 'error',
          message: 'Le nombre de feuillets doit être supérieur à 0',
          statusCode: 400,
        });
      }

      const numberofcheckbooks = data.numberofcheckbooks || 1;

      if (numberofcheckbooks < 1) {
        throw new RpcException({
          status: 'error',
          message: 'Le nombre de chéquiers doit être supérieur à 0',
          statusCode: 400,
        });
      }

      const createdCheckbooks: any[] = [];

      for (let cb = 0; cb < numberofcheckbooks; cb++) {
        const lastCheckbook = await this.prisma.checkbooks.findFirst({
          where: { accountId: account.id },
          orderBy: { checkNumberEnd: 'desc' },
        });

        const start = lastCheckbook ? lastCheckbook.checkNumberEnd + 1 : 1;
        const end = start + data.numberOfCheckbookLeaves - 1;
        const totalChecks = data.numberOfCheckbookLeaves;

        // ✅ Correction: utiliser seulement 'ACTIVE'
        const existingCheckbook = await this.prisma.checkbooks.findFirst({
          where: {
            accountId: account.id,
            OR: [
              {
                AND: [
                  { checkNumberStart: { lte: end } },
                  { checkNumberEnd: { gte: start } },
                ],
              },
            ],
            status: 'ACTIVE', // ✅ Supprimer 'REQUESTED'
          },
        });

        if (existingCheckbook) {
          throw new RpcException({
            status: 'error',
            message: `Des numéros de chèque sont déjà utilisés (${existingCheckbook.checkNumberStart} - ${existingCheckbook.checkNumberEnd})`,
            statusCode: 400,
          });
        }

        const checks: any[] = [];
        for (let i = start; i <= end; i++) {
          checks.push({
            checkNumber: i,
            amount: null,
            beneficiary: null,
            issueDate: null,
            dueDate: null,
            description: null,
            status: 'PENDING',
            usedAt: null,
          });
        }

        // ✅ Correction: utiliser 'ACTIVE' au lieu de 'REQUESTED'
        const checkbook = await this.prisma.checkbooks.create({
          data: {
            id: crypto.randomUUID(),
            accountId: account.id,
            checkNumberStart: start,
            checkNumberEnd: end,
            totalChecks: totalChecks,
            usedChecks: 0,
            remainingChecks: totalChecks,
            status: 'ACTIVE', // ✅ Remplacer 'REQUESTED' par 'ACTIVE'
            checks: JSON.stringify(checks),
            pickUpBranch: data.pickUpBranch,
            numberOfCheckbookLeaves: data.numberOfCheckbookLeaves,
          },
        });

        createdCheckbooks.push({
          id: checkbook.id,
          checkNumberStart: checkbook.checkNumberStart,
          checkNumberEnd: checkbook.checkNumberEnd,
          numberOfCheckbookLeaves: checkbook.numberOfCheckbookLeaves,
          status: checkbook.status,
          createdAt: checkbook.createdAt,
        });
      }

      return {
        success: true,
        message: `${numberofcheckbooks} chéquier(s) demandé(s) avec succès`,
        data: {
          accountNumber: account.accountNumber,
          pickUpBranch: data.pickUpBranch,
          numberOfCheckbookLeaves: data.numberOfCheckbookLeaves,
          numberofcheckbooks: numberofcheckbooks,
          checkbooks: createdCheckbooks,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[Request Checkbook] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('checkbook_request_failed', lang),
        statusCode: 500,
      });
    }
  }
  // 2. Voir le statut d'un chéquier
  async getCheckbookStatus(data: {
    checkbookId: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';

    try {
      const checkbook = await this.prisma.checkbooks.findUnique({
        where: { id: data.checkbookId },
      });

      if (!checkbook) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('checkbook_not_found', lang),
          statusCode: 404,
        });
      }

      // Parser les chèques pour les statistiques
      const checks = checkbook.checks ? JSON.parse(checkbook.checks as string) : [];
      const pendingChecks = checks.filter((c: any) => c.status === 'PENDING').length;
      const usedChecks = checks.filter((c: any) => c.status === 'USED').length;
      const cancelledChecks = checks.filter((c: any) => c.status === 'CANCELLED').length;

      // Récupérer le compte
      const account = await this.prisma.account.findUnique({
        where: { id: checkbook.accountId },
        select: { accountNumber: true, clientId: true },
      });

      const usagePercentage = checkbook.totalChecks > 0
        ? Math.round((checkbook.usedChecks / checkbook.totalChecks) * 100)
        : 0;

      // Déterminer le statut global
      let globalStatus = checkbook.status;
      if (checkbook.status === 'ACTIVE' && checkbook.remainingChecks === 0) {
        globalStatus = 'COMPLETED';
      }

      return {
        success: true,
        message: this.i18nService.translate('checkbook_status_retrieved', lang),
        data: {
          id: checkbook.id,
          accountNumber: account?.accountNumber,
          checkNumberStart: checkbook.checkNumberStart,
          checkNumberEnd: checkbook.checkNumberEnd,
          totalChecks: checkbook.totalChecks,
          usedChecks: checkbook.usedChecks,
          remainingChecks: checkbook.remainingChecks,
          status: globalStatus,
          usagePercentage,
          summary: {
            pending: pendingChecks,
            used: usedChecks,
            cancelled: cancelledChecks,
          },
          createdAt: checkbook.createdAt,
          updatedAt: checkbook.updatedAt,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[Get Checkbook Status] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('checkbook_status_failed', lang),
        statusCode: 500,
      });
    }
  }

  // 3. Bloquer un chéquier
  async blockCheckbook(data: {
    checkbookId: string;
    reason?: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';

    try {
      const checkbook = await this.prisma.checkbooks.findUnique({
        where: { id: data.checkbookId },
      });

      if (!checkbook) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('checkbook_not_found', lang),
          statusCode: 404,
        });
      }

      if (checkbook.status === 'CANCELLED') {
        throw new RpcException({
          status: 'error',
          message: 'Ce chéquier est déjà annulé',
          statusCode: 400,
        });
      }

      if (checkbook.status === 'COMPLETED') {
        throw new RpcException({
          status: 'error',
          message: 'Ce chéquier est déjà complété',
          statusCode: 400,
        });
      }

      // Bloquer le chéquier
      const updatedCheckbook = await this.prisma.checkbooks.update({
        where: { id: data.checkbookId },
        data: {
          status: 'CANCELLED',
          updatedAt: new Date(),
        },
      });

      // Annuler tous les chèques en attente
      if (updatedCheckbook.checks) {
        let checks = JSON.parse(updatedCheckbook.checks as string);
        checks = checks.map((c: any) => {
          if (c.status === 'PENDING') {
            return { ...c, status: 'CANCELLED' };
          }
          return c;
        });
        await this.prisma.checkbooks.update({
          where: { id: data.checkbookId },
          data: { checks: JSON.stringify(checks) },
        });
      }

      // ✅ Audit log - 4 arguments seulement
      await this.logAudit(
        checkbook.accountId,    // userId
        'BLOCK_CHECKBOOK',      // action
        {                       // details
          checkbookId: data.checkbookId,
          reason: data.reason || 'No reason provided',
        },
        'CHECKBOOK'             // entity
        // ❌ Supprimé: data.checkbookId (5ème argument)
      );

      return {
        success: true,
        message: this.i18nService.translate('checkbook_blocked', lang),
        data: {
          id: updatedCheckbook.id,
          status: updatedCheckbook.status,
          updatedAt: updatedCheckbook.updatedAt,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[Block Checkbook] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('checkbook_block_failed', lang),
        statusCode: 500,
      });
    }
  }
  // ========================= LIST ALL CLIENTS =========================
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

    const where: any = {};
    if (status) where.status = status;
    if (kycLevel) where.kycLevel = kycLevel;
    if (search) {
      where.OR = [
        { clientId: { contains: search } },
        { firstName: { contains: search } },
        { lastName: { contains: search } },
        { email: { contains: search } },
        { phone: { contains: search } },
      ];
    }

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

    const userMap = new Map();
    users.forEach(user => {
      if (user.clientId) {
        userMap.set(user.clientId, user);
      }
    });

    const formattedClients = clients.map(client => ({
      id: client.id,
      clientId: client.clientId,
      firstName: client.firstName,
      lastName: client.lastName,
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
      user: userMap.get(client.clientId) || null,
    }));

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

  // ========================= GET USER ACCOUNTS =========================
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

    return {
      message: this.i18nService.translate('user_accounts_retrieved', lang),
      data: accounts,
    };
  }

  async getAccountByNumber(
    accountNumber: string,
    lang: string = 'fr'
  ): Promise<{ message: string; data: any }> {
    console.log(`[getAccountByNumber] Langue utilisée : ${lang} pour le compte ${accountNumber}`);

    if (!accountNumber) {
      throw new RpcException({
        status: 'error',
        message: 'Account number is required',
        statusCode: 400,
      });
    }

    // Récupérer le compte par son numéro
    const account = await this.prisma.account.findFirst({
      where: { accountNumber: accountNumber },
      include: {
        clients: {
          select: {
            id: true,
            clientId: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            address: true,
            city: true,
            country: true,
            status: true,
            kycLevel: true,
            profilePicture: true,
          },
        },
      },
    });

    if (!account) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('account_not_found_with_number', lang, {
          accountNumber: accountNumber
        }),
        statusCode: 404,
      });
    }

    // Récupérer l'utilisateur lié à ce compte
    const user = await this.prisma.user.findFirst({
      where: { clientId: account.clientId },
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
      message: this.i18nService.translate('account_retrieved', lang),
      data: {
        id: account.id,
        clientId: account.clientId,
        accountNumber: account.accountNumber,
        accountType: account.accountType,
        balance: account.balance,
        currency: account.currency,
        status: account.status,
        isMain: account.isMain,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        client: account.clients ? {
          id: account.clients.id,
          clientId: account.clients.clientId,
          firstName: account.clients.firstName,
          lastName: account.clients.lastName,
          fullName: `${account.clients.firstName || ''} ${account.clients.lastName || ''}`.trim(),
          email: account.clients.email,
          phone: account.clients.phone,
          address: account.clients.address,
          city: account.clients.city,
          country: account.clients.country,
          status: account.clients.status,
          kycLevel: account.clients.kycLevel,
          profilePicture: account.clients.profilePicture,
        } : null,
        user: user ? {
          id: user.id,
          email: user.email,
          phone: user.phone,
          firstName: user.firstName,
          lastName: user.lastName,
          fullName: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
          role: user.role,
          status: user.status,
          photo: user.photo,
          preferredLanguage: user.preferredLanguage,
          preferredCurrency: user.preferredCurrency,
          timezone: user.timezone,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        } : null,
      },
    };
  }
  // ========================= HEALTH CHECK =========================
  async healthCheck() {
    return { status: 'ok', service: 'user-service' };
  }
}