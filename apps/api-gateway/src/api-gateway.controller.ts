/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Controller,
  Post,
  Body,
  Get,
  Patch,
  Delete,
  Param,
  HttpException,
  HttpStatus,
  UseGuards,
  Headers,
  Logger,
  Query,
  BadRequestException,
  Request,
  Res,
} from '@nestjs/common';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { CurrentUser } from 'apps/auth-service/src/utility/decorators/current-user-decorator';
import { AuthentificationGuard } from 'apps/auth-service/src/utility/guards/authentification.guard';
import { JwtAuthGuard } from 'apps/auth-service/src/utility/guards/jwt-auth.guard';
import { UpsertAppSettingsDto } from 'apps/user-service/dto/app-settings.dto';
import { CreateResourceDto } from 'apps/user-service/resources/dto/create-resource.dto';
import { UpdateResourceDto } from 'apps/user-service/resources/dto/update-resource.dto';
import { AssignMultipleResourcesDto } from 'apps/user-service/dto/assign-resource.dto';
import { firstValueFrom, catchError, timeout } from 'rxjs';
import { resolveChannel } from '../../../libs/common/src/utils/platform.util';
import { REQUEST_CONTEXT_FIELD, serializableContext } from '../../../libs/common/src/context/request-context';
import { TransferDto } from 'apps/transaction-service/dto/create-transaction.dto';
import { transactions_status, transactions_type, transfers_platform, transfers_type } from '@prisma/client';

@Controller()
export class ApiGatewayController {
  private readonly logger = new Logger(ApiGatewayController.name);

  // Clients des services
  private authClient: ClientProxy;
  private userClient: ClientProxy;
  private transactionClient: ClientProxy;

  constructor() {
    const rmqUrl = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

    // Configuration des clients
    this.authClient = this.createClient(rmqUrl, process.env.AUTH_QUEUE || 'auth_queue');
    this.userClient = this.createClient(rmqUrl, process.env.USER_QUEUE || 'user_queue');
    this.transactionClient = this.createClient(rmqUrl, process.env.TRANSACTION_QUEUE || 'transaction_queue');

    this.logger.log(`Connected to RabbitMQ at ${rmqUrl}`);
    this.logger.log(`Auth queue: ${process.env.AUTH_QUEUE || 'auth_queue'}`);
    this.logger.log(`User queue: ${process.env.USER_QUEUE || 'user_queue'}`);
    this.logger.log(`Transaction queue: ${process.env.TRANSACTION_QUEUE || 'transaction_queue'}`);
  }

  private createClient(rmqUrl: string, queue: string): ClientProxy {
    return ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [rmqUrl],
        queue: queue,
        queueOptions: { durable: false },
        persistent: true,
        noAck: true,
      },
    });
  }

  // ==================== MÉTHODES D'ENVOI ====================

  private async sendMessage<T>(
    client: ClientProxy,
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000
  ): Promise<T> {
    this.logger.debug(`Sending message to ${pattern}:`, data);
    // ✅ Contexte de la requête (IP, appareil, navigateur, OS, plateforme) joint au message :
    //    retiré par le microservice avant le handler, utilisé pour les audits
    const payload =
      data && typeof data === 'object' && !Array.isArray(data)
        ? { ...data, [REQUEST_CONTEXT_FIELD]: serializableContext() }
        : data;
    try {
      const result = await firstValueFrom(
        client.send(pattern, payload).pipe(
          timeout(timeoutMs),
          catchError((error: any) => {
            this.logger.error(`Error in ${pattern}:`, error);

            let errorMessage = defaultMessage;
            let errorStatus = defaultStatus;
            // ✅ Code métier (ACCOUNT_PENDING_APPROVAL, TEMP_PASSWORD_EXPIRED, …) transmis au front
            const errorCode: string | undefined =
              (error && (error.code || error.response?.code)) || undefined;

            if (error) {
              if (error.response) {
                if (typeof error.response === 'object') {
                  errorMessage = error.response.message || error.response.error || defaultMessage;
                  const statusCode = error.response.statusCode || error.response.status;
                  errorStatus = typeof statusCode === 'number' ? statusCode : defaultStatus;
                } else if (typeof error.response === 'string') {
                  errorMessage = error.response;
                  errorStatus = typeof error.status === 'number' ? error.status : defaultStatus;
                }
              } else if (error.message) {
                errorMessage = error.message;
                const statusCode = error.statusCode || error.status;
                errorStatus = typeof statusCode === 'number' ? statusCode : defaultStatus;
              }
            }

            if (typeof errorStatus !== 'number') {
              errorStatus = defaultStatus;
            }

            throw new HttpException(
              {
                status: 'error',
                message: errorMessage,
                statusCode: errorStatus,
                ...(typeof errorCode === 'string' && { code: errorCode }),
              },
              errorStatus,
            );
          }),
        ),
      );
      return result as T;
    } catch (error) {
      this.logger.error(`Failed to send message ${pattern}:`, error);
      throw error;
    }
  }

  private async sendAuthMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000
  ): Promise<T> {
    return this.sendMessage(this.authClient, pattern, data, defaultMessage, defaultStatus, timeoutMs);
  }

  private async sendUserMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000
  ): Promise<T> {
    return this.sendMessage(this.userClient, pattern, data, defaultMessage, defaultStatus, timeoutMs);
  }

  private async sendTransactionMessage<T>(
    pattern: string,
    data: any,
    defaultMessage: string,
    defaultStatus: number,
    timeoutMs: number = 120000
  ): Promise<T> {
    return this.sendMessage(this.transactionClient, pattern, data, defaultMessage, defaultStatus, timeoutMs);
  }

  // ==================== AUTH ENDPOINTS ====================

  // apps/api-gateway/src/api-gateway.controller.ts

  @Post('auth/register')
  async register(
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('x-client') clientHeader?: string,
  ) {
    const lang = langHeader || 'fr';

    // ✅ Seul le clientId est requis : le client ne choisit PLUS son mot de passe.
    //    La demande passe en attente d'approbation ; après approbation par un admin,
    //    un mot de passe temporaire est envoyé par SMS/email.
    if (!body.clientId) {
      throw new HttpException('ClientId is required', HttpStatus.BAD_REQUEST);
    }

    // ✅ Déterminer la plateforme depuis le header x-client
    // Plateforme : header x-client, sinon body, sinon déduite du user-agent par auth-service
    const platform = clientHeader || body.platform || '';

    // ✅ Construire le payload
    const payload = {
      clientId: String(body.clientId).trim(),
      otpCode: body.otpCode || '', // ✅ otpCode optionnel
      fcmToken: body.fcmToken || null,
      phone: body.phone || null,
      email: body.email || null,
      firstName: body.firstName || null,
      lastName: body.lastName || null,
      platform: platform,
      deviceInfo: body.deviceInfo || userAgent || 'unknown',
      userAgent: userAgent || null,          // ✅ canal d'inscription (Mobile / Net Banking)
      referralCode: body.referralCode || null,
      lang: lang,
    };

    return this.sendAuthMessage(
      'auth.register',
      payload,
      'Registration failed',
      HttpStatus.BAD_REQUEST
    );
  }
  @Post('auth/login')
  async login(
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Headers('x-client') clientHeader?: string,
    @Headers('user-agent') userAgentHeader?: string,
    @Request() req?: any,
  ) {
    const lang = langHeader || 'fr';

    if (!body.identifier) {
      throw new HttpException('Identifier is required', HttpStatus.BAD_REQUEST);
    }
    if (!body.password) {
      throw new HttpException('Password is required', HttpStatus.BAD_REQUEST);
    }

    return this.sendAuthMessage(
      'auth.login',
      {
        ...body,
        lang,
        // ✅ Token FCM : fcmToken (standard) ou deviceToken / pushToken
        fcmToken: body.fcmToken || body.deviceToken || body.pushToken || undefined,
        // ✅ Plateforme (MOBILE / WEB) pour les statistiques admin
        platform: body.platform || clientHeader || undefined,
        userAgent: body.userAgent || userAgentHeader || undefined,
        ipAddress: body.ipAddress || req?.ip || undefined,
      },
      'Login failed',
      HttpStatus.UNAUTHORIZED
    );
  }

  /**
   * OTP de connexion Web : quand /auth/login répond { requiresOtp: true, challengeId },
   * le front envoie ici le code reçu par SMS / e-mail.
   * Body : { challengeId, otpCode, rememberMe? }  → même réponse qu'une connexion réussie.
   */
  @Post('auth/login/verify-otp')
  async loginVerifyOtp(
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Headers('x-client') clientHeader?: string,
    @Headers('user-agent') userAgentHeader?: string,
    @Request() req?: any,
  ) {
    if (!body?.challengeId || !body?.otpCode) {
      throw new HttpException('challengeId et otpCode sont obligatoires', HttpStatus.BAD_REQUEST);
    }
    return this.sendAuthMessage(
      'auth.loginVerifyOtp',
      {
        challengeId: String(body.challengeId),
        otpCode: String(body.otpCode),
        rememberMe: body.rememberMe,
        deviceId: body.deviceId,
        deviceInfo: body.deviceInfo,
        fcmToken: body.fcmToken || body.deviceToken || body.pushToken || undefined,
        platform: body.platform || clientHeader || undefined,
        userAgent: userAgentHeader || undefined,
        ipAddress: req?.ip || undefined,
        lang: langHeader || 'fr',
      },
      'OTP verification failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  /** Renvoi du code de connexion. Body : { challengeId } */
  @Post('auth/login/resend-otp')
  async loginResendOtp(
    @Body() body: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (!body?.challengeId) {
      throw new HttpException('challengeId est obligatoire', HttpStatus.BAD_REQUEST);
    }
    return this.sendAuthMessage(
      'auth.loginResendOtp',
      { challengeId: String(body.challengeId), lang: langHeader || 'fr' },
      'OTP resend failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  // ── Appareils de confiance (« Se souvenir de moi ») ──

  @Get('users/me/trusted-devices')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async myTrustedDevices(@CurrentUser() currentUser: any) {
    return this.sendAuthMessage('auth.trustedDevices.list', { userId: currentUser.id }, 'Failed to get trusted devices', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  @Delete('users/me/trusted-devices')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async revokeAllMyTrustedDevices(@CurrentUser() currentUser: any) {
    return this.sendAuthMessage('auth.trustedDevices.revoke', { userId: currentUser.id }, 'Failed to revoke trusted devices', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  @Delete('users/me/trusted-devices/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async revokeMyTrustedDevice(@CurrentUser() currentUser: any, @Param('id') id: string) {
    return this.sendAuthMessage('auth.trustedDevices.revoke', { userId: currentUser.id, id }, 'Failed to revoke trusted device', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  /** Admin : retire tous les appareils de confiance d'un utilisateur (OTP redemandé partout). */
  @Delete('admin/users/:userId/trusted-devices')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminRevokeTrustedDevices(@CurrentUser() currentUser: any, @Param('userId') userId: string) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendAuthMessage('auth.trustedDevices.revoke', { userId }, 'Failed to revoke trusted devices', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  @Post('auth/refresh')
  async refresh(@Body('refreshToken') refreshToken: string) {
    if (!refreshToken) {
      throw new HttpException('Refresh token is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendAuthMessage(
      'auth.refresh',
      { refreshToken },
      'Refresh failed',
      HttpStatus.UNAUTHORIZED
    );
  }

  @Post('auth/logout')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async logout(
    @Request() req: any,
    @Body() body: { sessionId: string },
    @Headers('lang') langHeader?: string,
  ) {
    const user = req.user || req.currentUser;

    if (!user || !user.id || user.id === null) {
      throw new HttpException('Utilisateur non authentifié', HttpStatus.UNAUTHORIZED);
    }

    const { sessionId } = body;
    if (!sessionId) {
      throw new HttpException('sessionId requis', HttpStatus.BAD_REQUEST);
    }

    const lang = langHeader || 'fr';

    return this.sendAuthMessage(
      'auth.logout',
      { userId: user.id, sessionId, lang },
      'Échec de la déconnexion',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Post('auth/change-password')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async changePassword(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Headers('user-agent') userAgent?: string,
    @Request() req?: any,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const currentPassword = body.currentPassword || body.currentPswd;
    const newPassword = body.newPassword || body.newPswd;

    if (!currentPassword) {
      throw new HttpException('Current password is required', HttpStatus.BAD_REQUEST);
    }
    if (!newPassword) {
      throw new HttpException('New password is required', HttpStatus.BAD_REQUEST);
    }
    if (currentPassword === newPassword) {
      throw new HttpException('New password must be different from current password', HttpStatus.BAD_REQUEST);
    }

    const lang = langHeader || 'fr';

    return this.sendAuthMessage(
      'auth.changePassword',
      {
        userId: currentUser.id,
        currentPassword,
        newPassword,
        lang,
        deviceInfo: body.deviceInfo || userAgent || null,
        ipAddress: req?.ip || null,
      },
      'Change password failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Post('auth/forgot-password')
  async forgotPassword(
    @Body() body: any,
    @Headers('lang') langHeader?: string,
  ) {
    // ✅ SUPPRIMEZ LA VALIDATION - PASSEZ DIRECTEMENT
    const lang = langHeader || 'fr';

    return this.sendAuthMessage(
      'auth.forgotPassword',
      { email: body.identifier || body.email, lang },  // ← Envoie l'identifiant
      'Forgot password failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Post('auth/reset-password')
  async resetPassword(
    @Body()
    body: {
      identifier: string;
      code: string;
      password?: string;
      newPassword?: string;
    },
    @Headers('lang') langHeader?: string,
  ): Promise<{ message: string }> {
    const password = body.password || body.newPassword;
    if (!password) {
      throw new HttpException(
        'Le nouveau mot de passe est requis',
        HttpStatus.BAD_REQUEST,
      );
    }
    const lang = langHeader || 'fr';
    return this.sendAuthMessage<{ message: string }>(
      'reset_password',
      {
        identifier: body.identifier,
        code: body.code,
        password,
        lang,
      },
      'Échec réinitialisation mot de passe',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('auth/verify-otp')
  async verifyOtp(
    @Body() body: any,
    @Headers('lang') langHeader?: string,
  ) {
    // ✅ Accepter "identifier" ou "email"
    const email = body.identifier || body.email;

    if (!email) {
      throw new HttpException('Email or identifier is required', HttpStatus.BAD_REQUEST);
    }
    if (!body.code) {
      throw new HttpException('OTP code is required', HttpStatus.BAD_REQUEST);
    }

    const lang = langHeader || 'fr';
    return this.sendAuthMessage(
      'auth.verifyOtp',
      {
        email: email,
        code: body.code,
        lang
      },
      'OTP verification failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Post('auth/send-reset-otp')
  async sendResetOtp(
    @Body() body: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (!body.identifier) {
      throw new HttpException('Identifier is required', HttpStatus.BAD_REQUEST);
    }
    const lang = langHeader || 'fr';
    return this.sendAuthMessage(
      'auth.sendResetOtp',
      {
        identifier: body.identifier,
        lang
      },
      'Send reset OTP failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Post('auth/enable-2fa')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async enableTwoFactor(@CurrentUser() currentUser: any) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendAuthMessage(
      'auth.enable2FA',
      { userId: currentUser.id },
      'Enable 2FA failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Post('auth/verify-2fa')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async verifyTwoFactor(
    @CurrentUser() currentUser: any,
    @Body('code') code: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    if (!code) {
      throw new HttpException('2FA code is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendAuthMessage(
      'auth.verify2FA',
      {
        userId: currentUser.id,
        code
      },
      'Verify 2FA failed',
      HttpStatus.UNAUTHORIZED
    );
  }

  @Post('auth/disable-2fa')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async disableTwoFactor(
    @CurrentUser() currentUser: any,
    @Body('code') code: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    if (!code) {
      throw new HttpException('2FA code is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendAuthMessage(
      'auth.disable2FA',
      {
        userId: currentUser.id,
        code
      },
      'Disable 2FA failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Get('auth/sessions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getSessions(@CurrentUser() currentUser: any) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendAuthMessage(
      'auth.getSessions',
      { userId: currentUser.id },
      'Get sessions failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Delete('auth/sessions/:sessionId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async revokeSession(
    @CurrentUser() currentUser: any,
    @Param('sessionId') sessionId: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    if (!sessionId) {
      throw new HttpException('Session ID is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendAuthMessage(
      'auth.revokeSession',
      {
        userId: currentUser.id,
        sessionId
      },
      'Revoke session failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Get('auth/profile')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getProfile(@CurrentUser() currentUser: any) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendAuthMessage(
      'auth.getProfile',
      { userId: currentUser.id },
      'Get profile failed',
      HttpStatus.NOT_FOUND
    );
  }

  @Patch('auth/profile')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateProfile(
    @CurrentUser() currentUser: any,
    @Body() body: any,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendAuthMessage(
      'auth.updateProfile',
      {
        userId: currentUser.id,
        data: body
      },
      'Update profile failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Post('auth/validate')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async validate(@CurrentUser() currentUser: any) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendAuthMessage(
      'auth.validate',
      { userId: currentUser.id },
      'Validate failed',
      HttpStatus.UNAUTHORIZED
    );
  }

  // ==================== USER ENDPOINTS ====================

  // ---- Gestion des utilisateurs ----

  @Get('users')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUsers(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendUserMessage(
      'list_users',
      { page: pageNum, limit: limitNum, role, status },
      'Get users failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Get('users/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUser(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN' && currentUser?.id !== id) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_user',
      { id },
      'User not found',
      HttpStatus.NOT_FOUND
    );
  }

  // ✅ Création d'un utilisateur côté admin → compte APPROUVÉ directement.
  //    - avec clientId : identité reprise de l'API bancaire
  //    - sans clientId : firstName + lastName + phone obligatoires (comptes internes)
  //    Un mot de passe TEMPORAIRE est généré et envoyé par SMS/email.
  @Post('users')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createUser(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Request() req?: any,
  ) {
    return this.adminCreateUserInternal(currentUser, body, langHeader, req);
  }

  @Post('admin/users')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminCreateUser(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Request() req?: any,
  ) {
    return this.adminCreateUserInternal(currentUser, body, langHeader, req);
  }

  private async adminCreateUserInternal(currentUser: any, body: any, langHeader?: string, req?: any) {
    this.assertAdmin(currentUser);

    const hasClientId = !!(body?.clientId && String(body.clientId).trim());
    const hasIdentity = !!((body?.firstName && body?.lastName) || body?.fullName) && !!body?.phone;
    if (!hasClientId && !hasIdentity) {
      throw new HttpException(
        'clientId OR (firstName, lastName, phone) is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Seul un SUPER_ADMIN peut créer un ADMIN / SUPER_ADMIN
    const requestedRole = String(body?.role || 'USER').toUpperCase();
    if (['ADMIN', 'SUPER_ADMIN'].includes(requestedRole) && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Only a Super Admin can create administrators', HttpStatus.FORBIDDEN);
    }

    const { password, ...safeBody } = body || {};

    return this.sendUserMessage(
      'create_user',
      {
        ...safeBody,
        role: requestedRole,
        createdBy: currentUser.id,
        lang: langHeader || body?.lang || 'fr',
        ipAddress: req?.ip || null,
      },
      'Create user failed',
      HttpStatus.BAD_REQUEST
    );
  }

  private assertAdmin(currentUser: any) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
  }

  private assertSuperAdmin(currentUser: any) {
    if (currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Super admin only.', HttpStatus.FORBIDDEN);
    }
  }

  private toInt(value: any, fallback: number): number {
    const n = parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /** Envoie un fichier CSV produit par un microservice ({ filename, contentType, content }). */
  private sendCsv(res: any, result: any) {
    const file = result?.data ?? result;
    res.setHeader('Content-Type', file?.contentType || 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file?.filename || 'export.csv'}"`);
    res.setHeader('X-Total-Rows', String(file?.rows ?? ''));
    res.send(file?.content ?? '');
  }

  // ==================== APPROBATION DES INSCRIPTIONS (ADMIN) ====================

  // Liste des demandes d'inscription en attente
  @Get('admin/registrations')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listPendingRegistrations(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'list_pending_registrations',
      {
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 10,
        search,
        lang: langHeader || 'fr',
      },
      'Failed to get pending registrations',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  // Approuver → statut ACTIVE + mot de passe temporaire envoyé (SMS + email)
  @Post('admin/users/:id/approve')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async approveUser(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
    @Request() req?: any,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'approve_user',
      { id, approverId: currentUser.id, lang: langHeader || 'fr', ipAddress: req?.ip || null },
      'Approve user failed',
      HttpStatus.BAD_REQUEST
    );
  }

  // Refuser une demande d'inscription
  @Post('admin/users/:id/reject')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async rejectUser(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
    @Request() req?: any,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'reject_user',
      {
        id,
        rejecterId: currentUser.id,
        reason: body?.reason,
        lang: langHeader || 'fr',
        ipAddress: req?.ip || null,
      },
      'Reject user failed',
      HttpStatus.BAD_REQUEST
    );
  }

  // Renvoyer un nouveau mot de passe temporaire (perdu / expiré / SMS non reçu)
  @Post('admin/users/:id/resend-temp-password')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async resendTemporaryPassword(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
    @Request() req?: any,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'resend_temp_password',
      { id, adminId: currentUser.id, lang: langHeader || 'fr', ipAddress: req?.ip || null },
      'Resend temporary password failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Patch('users/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateUser(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() currentUser: any,
  ) {
    // ✅ PATCH /users/me est déclaré après /users/:id : sans ceci, « me » était pris pour un id
    if (id === 'me') return this.updateMyProfile(currentUser, body);

    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN' && currentUser?.id !== id) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      delete body.role;
      delete body.status;
    }

    // ✅ Changement de rôle : mêmes règles que PATCH /users/:id/role (SUPER_ADMIN uniquement,
    //    pas son propre rôle, dernier super administrateur protégé, audit)
    let roleResult: any = null;
    if (body && body.role !== undefined && body.role !== null && body.role !== '') {
      if (currentUser?.role !== 'SUPER_ADMIN') {
        throw new HttpException('Access denied. Only a Super Admin can change roles.', HttpStatus.FORBIDDEN);
      }
      roleResult = await this.sendUserMessage(
        'update_user_role',
        { id, role: body.role, requesterId: currentUser.id, lang: body.lang || 'fr' },
        'Update user role failed',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (body) delete body.role;
    const rest = Object.keys(body || {}).filter((k) => k !== 'lang');
    if (roleResult && !rest.length) return roleResult;

    return this.sendUserMessage(
      'update_user',
      { id, ...body },
      'Update user failed',
      HttpStatus.BAD_REQUEST
    );
  }

  /**
   * Suppression DÉFINITIVE d'un utilisateur (ligne supprimée de la table users).
   * L'historique (audit, activité, transferts) est conservé ; l'accès est coupé.
   * Body facultatif : { reason }
   */
  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteUser(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
    @Body() body?: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    if (currentUser?.id === id) {
      throw new HttpException('Cannot delete yourself', HttpStatus.BAD_REQUEST);
    }
    return this.sendUserMessage(
      'delete_user',
      { id, requesterId: currentUser.id, reason: body?.reason, lang: langHeader || 'fr' },
      'Delete user failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Get('users/profile/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserProfile(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN' && currentUser?.id !== id) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_user',
      { id },
      'Profile not found',
      HttpStatus.NOT_FOUND
    );
  }

  @Get('users/me')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyProfile(@CurrentUser() currentUser: any) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendUserMessage(
      'get_user',
      { id: currentUser.id },
      'Get my profile failed',
      HttpStatus.NOT_FOUND
    );
  }

  @Patch('users/me')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMyProfile(
    @CurrentUser() currentUser: any,
    @Body() body: any,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    delete body.role;
    delete body.status;
    return this.sendUserMessage(
      'update_user',
      { id: currentUser.id, ...body },
      'Update my profile failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Get('users/email/:email')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserByEmail(
    @Param('email') email: string,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_user_by_email',
      { email },
      'User not found',
      HttpStatus.NOT_FOUND
    );
  }

  @Get('users/phone/:phone')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserByPhone(
    @Param('phone') phone: string,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_user_by_phone',
      { phone },
      'User not found',
      HttpStatus.NOT_FOUND
    );
  }

  @Patch('users/:id/status')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateUserStatus(
    @Param('id') id: string,
    @Body('status') status: string,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    if (!status) {
      throw new HttpException('Status is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendUserMessage(
      'update_user_status',
      { id, status, requesterId: currentUser.id },
      'Update user status failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Patch('users/:id/role')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateUserRole(
    @Param('id') id: string,
    @Body() body: any,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Super Admin only.', HttpStatus.FORBIDDEN);
    }
    const role = body?.role ?? body?.newRole;
    if (!role) {
      throw new HttpException('Role is required', HttpStatus.BAD_REQUEST);
    }
    // ✅ requesterId : contrôles côté service (pas son propre rôle, dernier super admin…)
    return this.sendUserMessage(
      'update_user_role',
      { id, role, requesterId: currentUser.id, reason: body?.reason, lang: langHeader || 'fr' },
      'Update user role failed',
      HttpStatus.BAD_REQUEST
    );
  }

  // ---- Gestion du PIN ----

  @Post('users/me/pin')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async setPin(
    @CurrentUser() currentUser: any,
    @Body() body: { pin: string },
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const { pin } = body;
    if (!pin) {
      throw new HttpException('PIN is required', HttpStatus.BAD_REQUEST);
    }
    if (!/^\d{4}$/.test(pin)) {
      throw new HttpException('PIN must be 4 digits', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'change_pin',
      { id: currentUser.id, pin },
      'Failed to set PIN',
      HttpStatus.BAD_REQUEST
    );
  }

  @Post('users/me/update-pin')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updatePin(
    @CurrentUser() currentUser: any,
    @Body() body: { oldPin: string; newPin: string },
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const { oldPin, newPin } = body;
    if (!oldPin || !newPin) {
      throw new HttpException('Old PIN and new PIN are required', HttpStatus.BAD_REQUEST);
    }
    if (!/^\d{4}$/.test(oldPin) || !/^\d{4}$/.test(newPin)) {
      throw new HttpException('PIN must be 4 digits', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'update_pin',
      { id: currentUser.id, oldPin, newPin },
      'Failed to update PIN',
      HttpStatus.BAD_REQUEST
    );
  }

  @Post('users/me/verify-pin')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async verifyPin(
    @CurrentUser() currentUser: any,
    @Body() body: { pin: string },
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const { pin } = body;
    if (!pin) {
      throw new HttpException('PIN is required', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'verify_pin',
      { userId: currentUser.id, pin },
      'PIN verification failed',
      HttpStatus.BAD_REQUEST
    );
  }

  // ---- Paramètres utilisateur ----
  @Get('users/me/settings')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMySettings(@CurrentUser() currentUser: any) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendUserMessage(
      'get_user_settings',
      { userId: currentUser.id },
      'Failed to get settings',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  @Patch('users/me/settings')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMySettings(
    @CurrentUser() currentUser: any,
    @Body() body: any,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendUserMessage(
      'update_user_settings',
      { userId: currentUser.id, settings: body },
      'Failed to update settings',
      HttpStatus.BAD_REQUEST
    );
  }

  @Patch('users/me/settings/theme')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMyTheme(
    @CurrentUser() currentUser: any,
    @Body('theme') theme: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    if (!theme || !['system', 'light', 'dark'].includes(theme)) {
      throw new HttpException('Theme must be system, light, or dark', HttpStatus.BAD_REQUEST);
    }
    return this.sendUserMessage(
      'update_user_settings',
      { userId: currentUser.id, settings: { theme } },
      'Failed to update theme',
      HttpStatus.BAD_REQUEST
    );
  }

  @Patch('users/me/settings/language')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMyLanguage(
    @CurrentUser() currentUser: any,
    @Body('language') language: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    if (!language) {
      throw new HttpException('Language is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendUserMessage(
      'update_user_settings',
      { userId: currentUser.id, settings: { language } },
      'Failed to update language',
      HttpStatus.BAD_REQUEST
    );
  }

  @Patch('users/me/settings/notifications')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMyNotifications(
    @CurrentUser() currentUser: any,
    @Body() body: {
      email_notifications?: boolean;
      sms_notifications?: boolean;
      push_notifications?: boolean;
    },
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    return this.sendUserMessage(
      'update_user_settings',
      { userId: currentUser.id, settings: body },
      'Failed to update notifications',
      HttpStatus.BAD_REQUEST
    );
  }

  // ---- Admin Dashboard ----

  @Get('admin/dashboard')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAdminDashboard(
    @CurrentUser() currentUser: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_admin_dashboard',
      { startDate, endDate },
      'Failed to get dashboard',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  // ---- Device Token ----

  @Post('users/me/device-token')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async registerDeviceToken(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('x-client') clientHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    // ✅ Noms de champ acceptés : fcmToken (standard), token, deviceToken, pushToken
    const fcmToken = String(body?.fcmToken || body?.deviceToken || body?.pushToken || body?.token || '').trim();
    if (!fcmToken) {
      throw new HttpException('FCM token is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendAuthMessage(
      'auth.registerDeviceToken',
      {
        userId: currentUser.id,
        fcmToken,
        platform: body?.platform || clientHeader || 'MOBILE',
        deviceName: body?.deviceName,
      },
      'Failed to register device token',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  // ---- Admin Users Links ----

  @Get('admin/users/links')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listUsersLinks(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendUserMessage(
      'list_users_links',
      { page: pageNum, limit: limitNum, role, status },
      'Failed to get users links',
      HttpStatus.BAD_REQUEST
    );
  }

  // ==================== GESTION DES RESSOURCES ====================

  @Post('admin/resources')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createResource(
    @CurrentUser() currentUser: any,
    @Body() dto: CreateResourceDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'create_resource',
      dto,
      'Failed to create resource',
      HttpStatus.BAD_REQUEST
    );
  }

  @Patch('admin/resources/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateResource(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Body() dto: UpdateResourceDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'update_resource',
      { id, ...dto },
      'Failed to update resource',
      HttpStatus.BAD_REQUEST
    );
  }

  @Get('admin/resources')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAllResources(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendUserMessage(
      'get_all_resources',
      { page: pageNum, limit: limitNum },
      'Failed to get resources',
      HttpStatus.BAD_REQUEST
    );
  }

  @Get('admin/resources/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getOneResource(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_one_resource',
      { id },
      'Resource not found',
      HttpStatus.NOT_FOUND
    );
  }

  // ==================== ASSIGNATION RESSOURCES - UTILISATEURS ====================

  @Post('admin/users/assign-resource')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async assignMultipleResourcesToUser(
    @CurrentUser() currentUser: any,
    @Body() dto: AssignMultipleResourcesDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    if (!dto.grantedBy) dto.grantedBy = currentUser.id;
    return this.sendUserMessage(
      'assign_resource_to_user',
      dto,
      'Échec de l\'attribution multiple',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/users/:userId/resources')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserResources(
    @CurrentUser() currentUser: any,
    @Param('userId') userId: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_user_resources',
      { userId },
      'Failed to get user resources',
      HttpStatus.BAD_REQUEST
    );
  }

  @Delete('admin/users/:userId/resources/:resourceId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async revokeResource(
    @CurrentUser() currentUser: any,
    @Param('userId') userId: string,
    @Param('resourceId') resourceId: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'revoke_resource',
      { userId, resourceId },
      'Failed to revoke resource',
      HttpStatus.BAD_REQUEST
    );
  }

  // ==================== APP SETTINGS ====================

  @Post('admin/settings/app')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async upsertAppSettings(
    @CurrentUser() currentUser: any,
    @Body() dto: UpsertAppSettingsDto,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'upsert_app_settings',
      dto,
      'Échec de mise à jour',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/settings/app')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAppSettings(@CurrentUser() currentUser: any) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_app_settings',
      {},
      'Échec de récupération',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('settings/app/public')
  async getPublicAppSettings() {
    try {
      const result = await firstValueFrom(
        this.userClient.send('get_app_settings', {}).pipe(timeout(10000)),
      );
      return result;
    } catch (err) {
      this.logger.error(`RPC error: ${err.message}`);
      throw new HttpException(
        'Service error: ' + err.message,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ==================== SESSIONS ADMIN ====================

  @Get('admin/sessions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listAllSessions(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendAuthMessage(
      'auth.listAllSessions',
      { page: pageNum, limit: limitNum },
      'Failed to list all sessions',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  @Get('users/me/sessions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMySessions(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const result = await this.sendAuthMessage<{
      message: string;
      data: any[];
      total: number;
      page: number;
      limit: number;
    }>(
      'auth.listUserSessions',
      { userId: currentUser.id, page: pageNum, limit: limitNum },
      'Échec de récupération des sessions',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return {
      message: result.message,
      data: {
        data: result.data,
        total: result.total,
        page: result.page,
        limit: result.limit,
      },
    };
  }

  @Get('admin/sessions/:sessionId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getSessionById(
    @CurrentUser() currentUser: any,
    @Param('sessionId') sessionId: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendAuthMessage(
      'auth.getSessionById',
      { sessionId },
      'Session not found',
      HttpStatus.NOT_FOUND
    );
  }

  @Delete('admin/sessions/:sessionId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminRevokeSession(
    @CurrentUser() currentUser: any,
    @Param('sessionId') sessionId: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendAuthMessage(
      'auth.revokeSessionById',
      { sessionId, lang: 'fr' },
      'Failed to revoke session',
      HttpStatus.BAD_REQUEST
    );
  }

  // ==================== AUDIT LOGS ====================

  @Get('admin/audit-logs')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAuditLogs(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('entity') entity?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query() extra?: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendUserMessage(
      'get_audit_logs',
      {
        page: pageNum, limit: limitNum, userId, action, entity, startDate, endDate,
        // ✅ Filtres d'origine : plateforme, type d'appareil, OS, IP, niveau, recherche
        platform: extra?.platform, deviceType: extra?.deviceType, os: extra?.os,
        ipAddress: extra?.ipAddress, level: extra?.level, search: extra?.search, entityId: extra?.entityId,
      },
      'Failed to get audit logs',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  /**
   * Historique d'activité : TOUTES les actions des utilisateurs connectés
   * (qui, quand, quelle action, résultat, appareil, plateforme).
   * Filtres : userId, platform (MOBILE|WEB|BACK_OFFICE|API), method (POST|PUT|PATCH|DELETE|GET),
   *           activityType, success (true|false), search, startDate, endDate, page, limit
   */
  @Get('admin/activity-logs')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getActivityLogs(
    @CurrentUser() currentUser: any,
    @Query() query: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_activity_logs',
      {
        page: this.toInt(query.page, 1),
        limit: this.toInt(query.limit, 20),
        userId: query.userId,
        platform: query.platform,
        method: query.method,
        activityType: query.activityType,
        success: query.success,
        search: query.search,
        startDate: query.startDate || query.from,
        endDate: query.endDate || query.to,
      },
      'Failed to get activity logs',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Patch('admin/audit-logs/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteAuditLogById(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Accès interdit', HttpStatus.FORBIDDEN);
    }
    if (!id) {
      throw new HttpException('ID du log requis', HttpStatus.BAD_REQUEST);
    }
    const result = await this.sendUserMessage<{ message: string }>(
      'delete_audit_log_by_id',
      { id },
      'Failed to delete audit log',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return result;
  }

  @Get('admin/audit-logs/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAuditLogById(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_audit_log',
      { id },
      'Audit log not found',
      HttpStatus.NOT_FOUND
    );
  }

  @Get('admin/audit/user/:userId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserAuditLogs(
    @CurrentUser() currentUser: any,
    @Param('userId') userId: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendUserMessage(
      'get_user_audit_logs',
      { userId, page: pageNum, limit: limitNum },
      'Failed to get user audit logs',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  @Get('admin/audit/actions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAuditActions(@CurrentUser() currentUser: any) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_audit_actions',
      {},
      'Failed to get audit actions',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  @Get('admin/audit/entities')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAuditEntities(@CurrentUser() currentUser: any) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendUserMessage(
      'get_audit_entities',
      {},
      'Failed to get audit entities',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  @Get('admin/audit/stats')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAuditStats(
    @CurrentUser() currentUser: any,
    @Query('days') days?: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    const daysNum = days ? parseInt(days, 10) : 7;
    return this.sendUserMessage(
      'get_audit_stats',
      { days: daysNum },
      'Failed to get audit stats',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  // ==================== USER STATUS ADMIN ====================

  @Get('admin/users/:userId/status')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getUserStatus(
    @CurrentUser() currentUser: any,
    @Param('userId') userId: string,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    return this.sendAuthMessage(
      'auth.getUserStatus',
      { userId },
      'Failed to get user status',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  @Get('auth/login-attempts')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyLoginAttempts(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 20;
    return this.sendAuthMessage(
      'auth.getLoginAttempts',
      { userId: currentUser.id, page: pageNum, limit: limitNum },
      'Failed to get login attempts',
      HttpStatus.BAD_REQUEST,
    );
  }

  // ==================== TRANSACTION ENDPOINTS ====================

  @Post('transactions/deposit')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deposit(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Headers('x-client') clientHeader?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('authorization') authorization?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    const ch = await this.operationChannel(body, clientHeader, userAgent, authorization);
    return this.sendTransactionMessage(
      'transaction.deposit',
      { ...body, ...ch, initiatedBy: currentUser.id, lang },
      'Deposit failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('transactions/withdraw')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async withdraw(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Headers('x-client') clientHeader?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('authorization') authorization?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    const ch = await this.operationChannel(body, clientHeader, userAgent, authorization);
    return this.sendTransactionMessage(
      'transaction.withdraw',
      { ...body, ...ch, initiatedBy: currentUser.id, lang },
      'Withdrawal failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Transfert protégé par OTP (même comportement mobile et web).
   *  1er appel SANS code        → { requiresOtp: true } + SMS envoyé
   *  2e appel AVEC otpCode (6 chiffres) → transfert exécuté
   * Le code est accepté sous les noms : otpCode, otp, code, otp_code, verificationCode.
   */
  @Post('transactions/transfer')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async transfer(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Headers('x-client') clientHeader?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('authorization') authorization?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    const otpCode = this.pickTransferOtp(body);
    const ch = await this.operationChannel(body, clientHeader, userAgent, authorization);
    const { otp, code, otp_code, verificationCode, pin, ...rest } = body || {};
    return this.sendTransactionMessage(
      'transaction.transfer',
      {
        ...rest,
        ...ch,
        otpCode,
        initiatedBy: currentUser.id,
        lang,
        client: clientHeader || this.detectClient(userAgent),
      },
      'Transfer failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Demander (ou redemander) le code OTP d'un transfert sans l'exécuter.
   * Body : le même que pour le transfert (comptes, montant, devise), sans otpCode.
   */
  @Post('transactions/transfer/request-otp')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async requestTransferOtp(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Headers('x-client') clientHeader?: string,
    @Headers('user-agent') userAgent?: string,
    @Headers('authorization') authorization?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    const { otpCode, otp, code, otp_code, verificationCode, pin, ...rest } = body || {};
    const ch = await this.operationChannel(body, clientHeader, userAgent, authorization);
    return this.sendTransactionMessage(
      'transaction.transfer',
      {
        ...rest,
        ...ch,
        otpCode: undefined,
        forceNewOtp: true,
        initiatedBy: currentUser.id,
        lang,
        client: clientHeader || this.detectClient(userAgent),
      },
      'OTP request failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  /** Code OTP envoyé par le front, quel que soit le nom du champ. */
  private pickTransferOtp(body: any): string | undefined {
    if (!body) return undefined;
    const raw = [body.otpCode, body.otp, body.code, body.otp_code, body.verificationCode]
      .find((v) => v !== undefined && v !== null && String(v).trim() !== '' &&
        !['null', 'undefined'].includes(String(v).trim().toLowerCase()));
    return raw === undefined ? undefined : String(raw).trim();
  }

  /**
   * Canal d'une opération : MOBILE (Mobile Banking) ou WEB (Net Banking).
   * x-client → platform du body → plateforme de la session → user-agent.
   * `platform` = valeur attendue par la banque (Mobile / Online).
   */
  private async operationChannel(body: any, clientHeader?: string, userAgent?: string, authorization?: string) {
    const channel = await resolveChannel({
      client: clientHeader,
      platform: body?.platform,
      token: authorization,
      userAgent,
    });
    return {
      channel,
      platform: channel === 'WEB' ? 'Online' : 'Mobile',
    };
  }

  /** Mobile ou web, déduit du user-agent (pour les logs). */
  private detectClient(userAgent?: string): string {
    const ua = String(userAgent || '').toLowerCase();
    if (!ua) return 'inconnu';
    if (/okhttp|dart|cfnetwork|react-native|expo|android|iphone|ipad/.test(ua) && !/mozilla.*(windows|macintosh|x11)/.test(ua)) return 'mobile';
    if (/mozilla|chrome|safari|firefox|edge/.test(ua)) return 'web';
    return ua.slice(0, 40);
  }

  @Get('transactions/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransaction(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.getById',
      { id, userId: currentUser.id, lang },
      'Transaction not found',
      HttpStatus.NOT_FOUND,
    );
  }

  @Get('transactions/account/:accountNumber')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransactionsByAccount(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,   // ← INCHANGÉ
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: transactions_type,
    @Query('status') status?: transactions_status,
    @Query('movement') movement?: 'CREDIT' | 'DEBIT',       // ← ajouté, optionnel
    @Query('startDate') startDate?: string,                 // ← ajouté, optionnel
    @Query('endDate') endDate?: string,                     // ← ajouté, optionnel
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.getByAccount',
      {
        accountNumber,
        userId: currentUser.id,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 10,
        type,
        status,
        movement,
        startDate,
        endDate,
        lang,
      },
      'Failed to get transactions',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('transactions/client/me')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyTransactions(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: transactions_type,
    @Query('status') status?: transactions_status,
    @Query('movement') movement?: 'CREDIT' | 'DEBIT',       // ← ajouté
    @Query('startDate') startDate?: string,                 // ← ajouté
    @Query('endDate') endDate?: string,                     // ← ajouté
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.getByUserId',
      {
        userId: currentUser.id,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 10,
        type,
        status,
        movement,
        startDate,
        endDate,
        lang,
      },
      'Failed to get transactions',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('transactions/balance/:accountNumber')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getBalance(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendTransactionMessage(
      'transaction.getBalance',
      {
        accountNumber: accountNumber,
        userId: currentUser.id,
        lang,
      },
      'Failed to get balance',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('transactions/account/id/:accountId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAccountById(
    @CurrentUser() currentUser: any,
    @Param('accountId') accountId: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendTransactionMessage(
      'transaction.getAccountById',
      {
        accountId: accountId,
        userId: currentUser.id,
        lang,
      },
      'Failed to get account',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('transactions/statement/:accountNumber')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getStatement(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: transactions_type,
    @Query('status') status?: transactions_status,
    @Query('movement') movement?: 'CREDIT' | 'DEBIT',       // ← ajouté
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.getStatement',
      {
        accountNumber,
        userId: currentUser.id,
        startDate,
        endDate,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 50,
        type,
        status,
        movement,
        lang,
      },
      'Failed to get statement',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('transactions/stats/me')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyTransactionStats(
    @CurrentUser() currentUser: any,
    @Query('days') days?: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    const daysNum = days ? parseInt(days, 10) : 30;
    return this.sendTransactionMessage(
      'transaction.getStats',
      { userId: currentUser.id, days: daysNum, lang },
      'Failed to get stats',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // ==================== TRANSFERTS ====================

  @Get('transfers/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransfer(
    @CurrentUser() currentUser: any,
    @Param('id') id: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.getTransferById',
      { id, userId: currentUser.id, lang },
      'Transfer not found',
      HttpStatus.NOT_FOUND,
    );
  }
  @Get('transfers/account/:accountId')                       // ← URL INCHANGÉE
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransfersByAccount(
    @Param('accountId') accountId: string,                   // ← INCHANGÉ
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,                        // ← ajouté, optionnel
    @Query('startDate') startDate?: string,                  // ← ajouté, optionnel
    @Query('endDate') endDate?: string,                      // ← ajouté, optionnel
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.getTransfersByAccount',
      {
        accountNumber: accountId,                            // ← le microservice attend accountNumber
        userId: currentUser.id,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 10,
        status,
        startDate,
        endDate,
        lang,
      },
      'Failed to get transfers',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('transfers/user/me')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyTransfers(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,                        // ← ajouté
    @Query('startDate') startDate?: string,                  // ← ajouté
    @Query('endDate') endDate?: string,                      // ← ajouté
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.getTransfersByUser',
      {
        userId: currentUser.id,
        page: page ? parseInt(page, 10) : 1,
        limit: limit ? parseInt(limit, 10) : 10,
        status,
        startDate,
        endDate,
        lang,
      },
      'Failed to get transfers',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('clients/:clientId')
  async getClientByClientId(
    @Param('clientId') clientId: string,
    @Headers('lang') langHeader?: string,
  ) {
    const lang = langHeader || 'fr';
    return this.sendUserMessage(
      'get_client_by_client_id',
      { clientId, lang },
      'Failed to get client',
      HttpStatus.NOT_FOUND
    );
  }

  @Get('users/clients')
  async listAllClients(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('kycLevel') kycLevel?: string,
    @Headers('lang') langHeader?: string,
  ) {

    const lang = langHeader || 'fr';
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    return this.sendUserMessage(
      'list_all_clients',
      {
        page: pageNum,
        limit: limitNum,
        search,
        status,
        kycLevel,
        lang
      },
      'Failed to list clients',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  @Get('users/me/accounts')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyAccounts(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendUserMessage(
      'get_user_accounts',
      { userId: currentUser.id, lang },
      'Failed to get accounts',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }

  @Get('accounts/:accountNumber')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getAccountByNumber(
    @Param('accountNumber') accountNumber: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendUserMessage(
      'get_account_by_number',
      { accountNumber, lang },
      'Failed to get account',
      HttpStatus.NOT_FOUND
    );
  }

  @Post('beneficiaries')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createBeneficiary(
    @CurrentUser() currentUser: any,
    @Body() body: {
      accountNumber: string;
      accountName: string;
      bankName?: string;
      phone?: string;
      email?: string;
      nickname?: string;
      isFavorite?: boolean;
    },
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendTransactionMessage(
      'transaction.createBeneficiary',
      {
        userId: currentUser.id,
        accountNumber: body.accountNumber,
        accountName: body.accountName,
        bankName: body.bankName,
        phone: body.phone,
        email: body.email,
        nickname: body.nickname,
        isFavorite: body.isFavorite || false,
        lang,
      },
      'Failed to create beneficiary',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Patch('beneficiaries/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateBeneficiary(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
    @Body() body: {
      accountName?: string;
      bankName?: string;
      phone?: string;
      email?: string;
      nickname?: string;
      isFavorite?: boolean;
    },
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendTransactionMessage(
      'transaction.updateBeneficiary',
      {
        id,
        userId: currentUser.id,
        ...body,
        lang,
      },
      'Failed to update beneficiary',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Delete('beneficiaries/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteBeneficiary(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendTransactionMessage(
      'transaction.deleteBeneficiary',
      {
        id,
        userId: currentUser.id,
        lang,
      },
      'Failed to delete beneficiary',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('beneficiaries')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async listBeneficiaries(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('isFavorite') isFavorite?: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    const isFavoriteBool = isFavorite !== undefined ? isFavorite === 'true' : undefined;

    return this.sendTransactionMessage(
      'transaction.listBeneficiaries',
      {
        userId: currentUser.id,
        page: pageNum,
        limit: limitNum,
        search,
        isFavorite: isFavoriteBool,
        lang,
      },
      'Failed to list beneficiaries',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('beneficiaries/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getBeneficiary(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendTransactionMessage(
      'transaction.getBeneficiaryById',
      {
        id,
        userId: currentUser.id,
        lang,
      },
      'Beneficiary not found',
      HttpStatus.NOT_FOUND,
    );
  }

  @Get('checkbooks/account/:accountNumber')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getCheckbooksByAccount(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendUserMessage(
      'getCheckbooksByAccount',
      {
        accountNumber,
        lang,
      },
      'Failed to get checkbooks',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Post('checkbooks/request')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async requestCheckbook(
    @CurrentUser() currentUser: any,
    @Body() body: {
      accountNumber: string;
      pickUpBranch: string;
      numberOfCheckbookLeaves: number;
      numberofcheckbooks?: number;
    },
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    // Vérifier les champs obligatoires
    if (!body.accountNumber) {
      throw new HttpException('Account number is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.pickUpBranch) {
      throw new HttpException('Pick up branch is required', HttpStatus.BAD_REQUEST);
    }

    if (!body.numberOfCheckbookLeaves || body.numberOfCheckbookLeaves < 1) {
      throw new HttpException('Number of checkbook leaves must be greater than 0', HttpStatus.BAD_REQUEST);
    }

    return this.sendUserMessage(
      'requestCheckbook',
      {
        accountNumber: body.accountNumber,
        pickUpBranch: body.pickUpBranch,
        numberOfCheckbookLeaves: body.numberOfCheckbookLeaves,
        numberofcheckbooks: body.numberofcheckbooks || 1,
        lang,
      },
      'Failed to request checkbook',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Get('checkbooks/:checkbookId/status')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getCheckbookStatus(
    @CurrentUser() currentUser: any,
    @Param('checkbookId') checkbookId: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendUserMessage(
      'getCheckbookStatus',
      {
        checkbookId,
        lang,
      },
      'Failed to get checkbook status',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // 3. Bloquer un chéquier
  @Post('checkbooks/:checkbookId/block')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async blockCheckbook(
    @CurrentUser() currentUser: any,
    @Param('checkbookId') checkbookId: string,
    @Body() body: { reason?: string },
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';

    return this.sendUserMessage(
      'blockCheckbook',
      {
        checkbookId,
        reason: body.reason,
        lang,
      },
      'Failed to block checkbook',
      HttpStatus.BAD_REQUEST,
    );
  }
  // ═════════════════════════════════════════════════════════════════════
  // NOTIFICATIONS DE L'UTILISATEUR (routes standard AccesFinance)
  // ═════════════════════════════════════════════════════════════════════

  @Get('users/me/notifications')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyNotifications(
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('unreadOnly') unreadOnly?: string,
  ) {
    const result: any = await this.sendUserMessage(
      'notifications.list',
      {
        userId: currentUser.id,
        page: this.toInt(page, 1),
        limit: this.toInt(limit, 10),
        unreadOnly: unreadOnly === 'true',
      },
      'Échec de récupération des notifications',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return {
      message: result.message,
      data: {
        data: result.data,
        total: result.total,
        unreadCount: result.unreadCount,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    };
  }

  @Get('users/me/notifications/unread-count')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyUnreadNotifications(@CurrentUser() currentUser: any) {
    const result: any = await this.sendUserMessage(
      'notifications.unreadCount',
      { userId: currentUser.id },
      'Échec du comptage des notifications',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return { message: 'OK', data: result };
  }

  @Patch('users/me/notifications/read-all')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async markAllMyNotificationsAsRead(@CurrentUser() currentUser: any) {
    return this.sendUserMessage(
      'notifications.markAllSeen',
      { userId: currentUser.id },
      'Échec du marquage de toutes les notifications',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Patch('users/me/notifications/:id/read')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async markMyNotificationAsRead(
    @CurrentUser() currentUser: any,
    @Param('id') notificationId: string,
  ) {
    if (!notificationId) {
      throw new HttpException('ID de notification requis', HttpStatus.BAD_REQUEST);
    }
    return this.sendUserMessage(
      'notifications.markSeen',
      { notificationId, userId: currentUser.id },
      'Échec du marquage de la notification',
      HttpStatus.NOT_FOUND,
    );
  }

  @Delete('users/me/notifications/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteMyNotification(
    @CurrentUser() currentUser: any,
    @Param('id') notificationId: string,
  ) {
    return this.sendUserMessage(
      'notifications.delete',
      { notificationId, userId: currentUser.id },
      'Échec de la suppression de la notification',
      HttpStatus.NOT_FOUND,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // PROFIL & COMPTE (routes standard AccesFinance)
  // ═════════════════════════════════════════════════════════════════════

  @Get('users/me/profile')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getMyProfileAlias(@CurrentUser() currentUser: any) {
    return this.sendUserMessage(
      'get_user',
      { id: currentUser.id },
      'User not found',
      HttpStatus.NOT_FOUND,
    );
  }

  @Patch('users/me/profile')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async updateMyProfileAlias(@CurrentUser() currentUser: any, @Body() body: any) {
    const data = { ...(body || {}) };
    for (const k of ['role', 'status', 'password', 'pin', 'clientId', 'id']) delete data[k];
    return this.sendUserMessage(
      'update_user',
      { id: currentUser.id, ...data },
      'Update my profile failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  // Suppression de son accès à l'application (le compte bancaire n'est pas touché)
  @Delete('users/me/account')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteMyAccount(
    @CurrentUser() currentUser: any,
    @Body() body: { password: string },
    @Headers('lang') langHeader?: string,
    @Request() req?: any,
  ) {
    if (!body?.password || !String(body.password).trim()) {
      throw new HttpException('Le mot de passe est requis pour supprimer votre compte', HttpStatus.BAD_REQUEST);
    }
    const lang = ['fr', 'en', 'sw'].includes(langHeader || '') ? langHeader : 'fr';
    return this.sendUserMessage(
      'delete_own_account',
      { id: currentUser.id, password: body.password, lang, ipAddress: req?.ip || null },
      'Échec de la suppression du compte',
      HttpStatus.BAD_REQUEST,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // RELEVÉ DE COMPTE PDF (gabarit officiel AccesFinance)
  //   ?startDate=AAAA-MM-JJ&endDate=AAAA-MM-JJ   (optionnels)
  //   ?format=base64   → JSON { filename, pdfBase64 } au lieu du fichier
  //   ?sendEmail=true  → le PDF est aussi envoyé à l'email du client
  // ═════════════════════════════════════════════════════════════════════

  private async sendStatement(res: any, payload: any, format?: string) {
    const result: any = await this.sendTransactionMessage(
      'transaction.statementPdf',
      payload,
      'Erreur génération relevé',
      HttpStatus.INTERNAL_SERVER_ERROR,
      300000,
    );
    const file = result?.data ?? result;
    if (format === 'base64' || format === 'json') {
      return res.json({ message: result?.message, data: file });
    }
    const pdf = Buffer.from(file.pdfBase64, 'base64');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Content-Length', pdf.length);
    if (file.emailSent !== null && file.emailSent !== undefined) {
      res.setHeader('X-Email-Sent', String(file.emailSent));
    }
    return res.end(pdf);
  }

  @Get('transactions/statement/:accountNumber/download')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async downloadStatement(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,
    @Res() res: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('format') format?: string,
    @Query('sendEmail') sendEmail?: string,
    @Headers('lang') langHeader?: string,
  ) {
    return this.sendStatement(res, {
      accountNumber,
      userId: currentUser.id,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      sendEmail: sendEmail === 'true',
      lang: langHeader || 'fr',
    }, format);
  }

  @Get('admin/accounts/:accountNumber/statement/download')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminDownloadStatement(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,
    @Res() res: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('format') format?: string,
    @Query('sendEmail') sendEmail?: string,
    @Query('email') email?: string,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendStatement(res, {
      accountNumber,
      userId: currentUser.id, // admin : contrôle d'appartenance levé côté service
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      sendEmail: sendEmail === 'true',
      email: email || undefined,
      lang: langHeader || 'fr',
    }, format);
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — STATISTIQUES : utilisateurs mobile / web, volumes de transactions
  // Filtres transactions : from, to (AAAA-MM-JJ), type (TRANSFER,DEPOSIT,WITHDRAWAL),
  //   currency (USD|CDF), platform (MOBILE|WEB), status, userId, accountNumber,
  //   minAmount, maxAmount, search, groupBy (day|week|month), sort, page, limit
  // ═════════════════════════════════════════════════════════════════════

  private transactionFilters(query: any, lang?: string) {
    return {
      from: query.from || query.startDate,
      to: query.to || query.endDate,
      type: query.type,
      currency: query.currency,
      platform: query.platform,
      status: query.status,
      userId: query.userId,
      accountNumber: query.accountNumber,
      minAmount: query.minAmount,
      maxAmount: query.maxAmount,
      search: query.search,
      groupBy: query.groupBy,
      sort: query.sort,
      page: this.toInt(query.page, 1),
      limit: this.toInt(query.limit, 20),
      lang: lang || 'fr',
    };
  }

  @Get('admin/stats/users')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminStatsUsers(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.stats.users',
      { from: query.from, to: query.to, lang: langHeader || 'fr' },
      'Failed to get user stats', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/stats/transactions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminStatsTransactions(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.stats.transactions', this.transactionFilters(query, langHeader),
      'Failed to get transaction stats', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — TOUTES LES TRANSACTIONS BANCAIRES (tous les clients, tous les comptes)
  //   Filtres : from, to (AAAA-MM-JJ, défaut 30 derniers jours, max 366 j),
  //   clientId, userId, accountNumber, type, movement (CREDIT|DEBIT), status,
  //   currency (USD|CDF), minAmount, maxAmount, search,
  //   sort (date_desc|date_asc|amount_desc|amount_asc), page, limit,
  //   refresh=true (ignorer le cache de 2 min)
  // ═════════════════════════════════════════════════════════════════════

  private bankTransactionFilters(query: any, lang?: string) {
    return {
      from: query.from || query.startDate,
      to: query.to || query.endDate,
      clientId: query.clientId,
      userId: query.userId,
      accountNumber: query.accountNumber,
      type: query.type,
      movement: query.movement,
      status: query.status,
      currency: query.currency,
      minAmount: query.minAmount,
      maxAmount: query.maxAmount,
      search: query.search,
      sort: query.sort,
      refresh: query.refresh === 'true',
      page: this.toInt(query.page, 1),
      limit: this.toInt(query.limit, 20),
      lang: lang || 'fr',
    };
  }

  @Get('admin/transactions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminListTransactions(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.bankTransactions.list', this.bankTransactionFilters(query, langHeader),
      'Échec de la récupération des transactions', HttpStatus.INTERNAL_SERVER_ERROR,
      300000,
    );
  }

  @Get('admin/transactions/export')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminExportTransactions(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Res() res: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    const result = await this.sendTransactionMessage(
      'admin.bankTransactions.csv', this.bankTransactionFilters(query, langHeader),
      'Failed to export transactions', HttpStatus.INTERNAL_SERVER_ERROR,
      300000,
    );
    return this.sendCsv(res, result);
  }

  // Opérations faites via l'application (avec la plateforme MOBILE / WEB)
  @Get('admin/transactions/app')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminListAppTransactions(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.transactions.list', this.transactionFilters(query, langHeader),
      'Échec de la récupération des transactions', HttpStatus.BAD_REQUEST,
    );
  }

  @Get('admin/transactions/app/export')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminExportAppTransactions(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Res() res: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    const result = await this.sendUserMessage(
      'admin.transactions.csv', this.transactionFilters(query, langHeader),
      'Failed to export transactions', HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return this.sendCsv(res, result);
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — LIMITES PAR UTILISATEUR (priment sur admin/settings/operations)
  //   body PATCH : { "USD": { "maxPerOperation": 5000, "maxDailyPerUser": 20000 },
  //                  "CDF": { … }, "transfersEnabled": false, "note": "…" }
  // ═════════════════════════════════════════════════════════════════════

  @Get('admin/settings/limits/:userId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminGetUserLimits(
    @Param('userId') userId: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage('admin.limits.get', { userId, lang: langHeader || 'fr' },
      'Failed to get limits', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  @Patch('admin/settings/limits/:userId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminUpdateUserLimits(
    @Param('userId') userId: string,
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Request() req?: any,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage('admin.limits.update',
      { userId, adminId: currentUser.id, patch: body || {}, lang: langHeader || 'fr', ipAddress: req?.ip || null },
      'Failed to update limits', HttpStatus.BAD_REQUEST);
  }

  @Delete('admin/settings/limits/:userId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminResetUserLimits(
    @Param('userId') userId: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage('admin.limits.reset', { userId, adminId: currentUser.id, lang: langHeader || 'fr' },
      'Failed to reset limits', HttpStatus.BAD_REQUEST);
  }

  // Paramètres généraux (mêmes données que admin/settings/app)
  @Get('admin/settings/general')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminGetGeneralSettings(@CurrentUser() currentUser: any) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage('get_app_settings', {}, 'Failed to get settings', HttpStatus.INTERNAL_SERVER_ERROR);
  }

  @Patch('admin/settings/general')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminUpdateGeneralSettings(@CurrentUser() currentUser: any, @Body() body: any) {
    this.assertAdmin(currentUser);
    // Fusion avec les paramètres existants (upsert_app_settings remplace tout)
    const current: any = await this.sendUserMessage(
      'get_app_settings', {}, 'Failed to get settings', HttpStatus.INTERNAL_SERVER_ERROR,
    );
    const merged = { ...(current?.data || {}), ...(body || {}) };
    return this.sendUserMessage('upsert_app_settings', merged, 'Failed to update settings', HttpStatus.BAD_REQUEST);
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — NOTIFICATIONS & EMAIL
  // ═════════════════════════════════════════════════════════════════════

  // Diagnostic du push : état de Firebase, appareils avec token, dernières notifications
  //   ?userId=… pour un utilisateur précis
  @Get('admin/notifications/push-status')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminPushStatus(
    @CurrentUser() currentUser: any,
    @Query('userId') userId?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.notifications.pushStatus',
      { userId: userId || undefined },
      'Failed to get push status', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // body : { title, body, userId? , audience?: 'ALL' | 'MOBILE' | 'WEB' }
  @Post('admin/notifications/send')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminSendNotification(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    if (!body?.userId && body?.audience && body.audience !== 'USER') this.assertSuperAdmin(currentUser);
    if (!body?.userId && !body?.audience) this.assertSuperAdmin(currentUser);
    return this.sendUserMessage(
      'admin.notifications.send',
      {
        adminId: currentUser.id,
        userId: body?.userId,
        audience: body?.audience,
        title: body?.title,
        body: body?.body,
        lang: langHeader || 'fr',
      },
      'Failed to send notification', HttpStatus.BAD_REQUEST,
      300000,
    );
  }

  // État de l'envoi d'emails (?verify=false pour ne pas tester la connexion SMTP)
  @Get('admin/monitoring/email')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminEmailStatus(
    @CurrentUser() currentUser: any,
    @Query('verify') verify?: string,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.monitoring.email', { verify: verify !== 'false', lang: langHeader || 'fr' },
      'Failed to get email status', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // Email de test — body : { "to": "adresse@exemple.com" }
  @Post('admin/monitoring/email/test')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminEmailTest(
    @CurrentUser() currentUser: any,
    @Body() body: { to?: string },
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.monitoring.emailTest',
      { to: body?.to || currentUser.email, adminId: currentUser.id, lang: langHeader || 'fr' },
      'Failed to send test email', HttpStatus.BAD_GATEWAY,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — CLIENTS & COMPTES BANCAIRES
  // ═════════════════════════════════════════════════════════════════════

  @Get('admin/clients/:clientId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminGetClient(
    @Param('clientId') clientId: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.clients.get', { clientId, lang: langHeader || 'fr' },
      'Failed to get client', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/accounts/:accountNumber')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminGetAccount(
    @Param('accountNumber') accountNumber: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.accounts.get', { accountNumber, lang: langHeader || 'fr' },
      'Failed to get account', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/accounts/:accountNumber/transactions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminAccountTransactions(
    @Param('accountNumber') accountNumber: string,
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.accounts.transactions',
      {
        accountNumber,
        page: this.toInt(query.page, 1),
        limit: this.toInt(query.limit, 20),
        type: query.type,
        status: query.status,
        movement: query.movement,
        startDate: query.startDate,
        endDate: query.endDate,
        lang: langHeader || 'fr',
      },
      'Failed to get transactions', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/accounts/:accountNumber/transactions/export')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminAccountTransactionsExport(
    @Param('accountNumber') accountNumber: string,
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Res() res: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    const result = await this.sendTransactionMessage(
      'admin.accounts.transactionsCsv',
      {
        accountNumber,
        type: query.type,
        status: query.status,
        movement: query.movement,
        startDate: query.startDate,
        endDate: query.endDate,
        lang: langHeader || 'fr',
      },
      'Failed to export transactions', HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return this.sendCsv(res, result);
  }

  @Get('admin/accounts/:accountNumber/statement')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminAccountStatement(
    @Param('accountNumber') accountNumber: string,
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.accounts.statement',
      {
        accountNumber,
        page: this.toInt(query.page, 1),
        limit: this.toInt(query.limit, 50),
        type: query.type,
        status: query.status,
        movement: query.movement,
        startDate: query.startDate,
        endDate: query.endDate,
        lang: langHeader || 'fr',
      },
      'Failed to get statement', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/users/:userId/transactions')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminUserTransactions(
    @Param('userId') userId: string,
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.users.transactions',
      {
        userId,
        page: this.toInt(query.page, 1),
        limit: this.toInt(query.limit, 20),
        type: query.type,
        status: query.status,
        movement: query.movement,
        startDate: query.startDate,
        endDate: query.endDate,
        lang: langHeader || 'fr',
      },
      'Failed to get transactions', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/users/:userId/beneficiaries')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminUserBeneficiaries(
    @Param('userId') userId: string,
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.users.beneficiaries',
      {
        userId,
        page: this.toInt(query.page, 1),
        limit: this.toInt(query.limit, 20),
        search: query.search,
        lang: langHeader || 'fr',
      },
      'Failed to get beneficiaries', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/transactions/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminGetTransaction(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
    @Query('accountNumber') accountNumber?: string,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.transactions.get', { id, accountNumber, lang: langHeader || 'fr' },
      'Transaction not found', HttpStatus.NOT_FOUND,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — SÉCURITÉ DES COMPTES
  //   body (optionnel) : { "reason": "...", "notify": true }
  // ═════════════════════════════════════════════════════════════════════

  @Get('admin/users/:userId/security')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminSecurityOverview(
    @Param('userId') userId: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.security.overview', { userId, lang: langHeader || 'fr' },
      'Failed to get security overview', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  private adminSecurityAction(
    pattern: string,
    userId: string,
    currentUser: any,
    body: any,
    lang: string,
    req: any,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      pattern,
      {
        userId,
        adminId: currentUser.id,
        reason: body?.reason,
        notify: body?.notify,
        lang,
        ipAddress: req?.ip || null,
      },
      'Admin security action failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('admin/users/:userId/unlock-pin')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminUnlockPin(
    @Param('userId') userId: string, @CurrentUser() currentUser: any, @Body() body: any,
    @Headers('lang') langHeader?: string, @Request() req?: any,
  ) {
    return this.adminSecurityAction('admin.security.unlockPin', userId, currentUser, body, langHeader || 'fr', req);
  }

  @Post('admin/users/:userId/reset-pin')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminResetPin(
    @Param('userId') userId: string, @CurrentUser() currentUser: any, @Body() body: any,
    @Headers('lang') langHeader?: string, @Request() req?: any,
  ) {
    return this.adminSecurityAction('admin.security.resetPin', userId, currentUser, body, langHeader || 'fr', req);
  }

  @Post('admin/users/:userId/block')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminBlockUser(
    @Param('userId') userId: string, @CurrentUser() currentUser: any, @Body() body: any,
    @Headers('lang') langHeader?: string, @Request() req?: any,
  ) {
    return this.adminSecurityAction('admin.security.block', userId, currentUser, body, langHeader || 'fr', req);
  }

  @Post('admin/users/:userId/unblock')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminUnblockUser(
    @Param('userId') userId: string, @CurrentUser() currentUser: any, @Body() body: any,
    @Headers('lang') langHeader?: string, @Request() req?: any,
  ) {
    return this.adminSecurityAction('admin.security.unblock', userId, currentUser, body, langHeader || 'fr', req);
  }

  @Post('admin/users/:userId/force-logout')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminForceLogout(
    @Param('userId') userId: string, @CurrentUser() currentUser: any, @Body() body: any,
    @Headers('lang') langHeader?: string, @Request() req?: any,
  ) {
    return this.adminSecurityAction('admin.security.forceLogout', userId, currentUser, body, langHeader || 'fr', req);
  }

  @Post('admin/users/:userId/reset-password')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminResetPassword(
    @Param('userId') userId: string, @CurrentUser() currentUser: any, @Body() body: any,
    @Headers('lang') langHeader?: string, @Request() req?: any,
  ) {
    return this.adminSecurityAction('admin.security.resetPassword', userId, currentUser, body, langHeader || 'fr', req);
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — CONTRÔLE DES OPÉRATIONS (maintenance, activation, plafonds)
  // ═════════════════════════════════════════════════════════════════════

  @Get('admin/settings/operations')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminGetOperationControls(
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.controls.get', { lang: langHeader || 'fr' },
      'Failed to get operation controls', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Patch('admin/settings/operations')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminUpdateOperationControls(
    @CurrentUser() currentUser: any,
    @Body() body: any,
    @Headers('lang') langHeader?: string,
    @Request() req?: any,
  ) {
    this.assertSuperAdmin(currentUser);
    return this.sendUserMessage(
      'admin.controls.update',
      { adminId: currentUser.id, patch: body || {}, lang: langHeader || 'fr', ipAddress: req?.ip || null },
      'Failed to update operation controls', HttpStatus.BAD_REQUEST,
    );
  }

  // Public (sans connexion) : les apps savent si une opération est ouverte / la maintenance
  @Get('settings/operations/public')
  async publicOperationControls(@Headers('lang') langHeader?: string) {
    return this.sendUserMessage(
      'controls.public', { lang: langHeader || 'fr' },
      'Failed to get operation controls', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — SUPERVISION & RAPPORTS
  // ═════════════════════════════════════════════════════════════════════

  // ?live=false pour ne pas appeler la banque (statistiques seulement)
  @Get('admin/monitoring/bank')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminBankHealth(
    @CurrentUser() currentUser: any,
    @Query('live') live?: string,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendTransactionMessage(
      'admin.monitoring.bankHealth',
      { live: live !== 'false', lang: langHeader || 'fr' },
      'Failed to get bank health', HttpStatus.INTERNAL_SERVER_ERROR,
      60000,
    );
  }

  @Get('admin/monitoring/sms')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminSmsLogs(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.monitoring.smsLogs',
      {
        page: this.toInt(query.page, 1),
        limit: this.toInt(query.limit, 20),
        status: query.status,
        phone: query.phone,
        from: query.from,
        to: query.to,
        lang: langHeader || 'fr',
      },
      'Failed to get SMS logs', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  // ADMIN — RAPPORTS SÉPARÉS : MOBILE BANKING / NET BANKING
  //   Filtres opérations : from, to (AAAA-MM-JJ, défaut 30 derniers jours),
  //   type (TRANSFER,DEPOSIT,WITHDRAWAL), currency, status, userId, accountNumber,
  //   minAmount, maxAmount, search, groupBy (day|week|month), sort, page, limit
  //   Comptes : from, to, channel (MOBILE|WEB), status, search, page, limit
  // ═════════════════════════════════════════════════════════════════════

  /** Les deux canaux côte à côte : opérations, comptes créés, utilisateurs actifs. */
  @Get('admin/reports/channels')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminChannelsReport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.reports.channels', this.transactionFilters(query, langHeader),
      'Failed to get channels report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /** Rapport Mobile Banking (opérations + comptes créés sur l'application mobile). */
  @Get('admin/reports/mobile-banking')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminMobileBankingReport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.reports.channel', { ...this.transactionFilters(query, langHeader), channel: 'MOBILE' },
      'Failed to get Mobile Banking report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /** Rapport Net Banking (opérations + comptes créés sur le site web). */
  @Get('admin/reports/net-banking')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminNetBankingReport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.reports.channel', { ...this.transactionFilters(query, langHeader), channel: 'WEB' },
      'Failed to get Net Banking report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/reports/mobile-banking/export')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminMobileBankingExport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Res() res: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    const result = await this.sendUserMessage(
      'admin.reports.channelCsv', { ...this.transactionFilters(query, langHeader), channel: 'MOBILE' },
      'Failed to export Mobile Banking report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return this.sendCsv(res, result);
  }

  @Get('admin/reports/net-banking/export')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminNetBankingExport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Res() res: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    const result = await this.sendUserMessage(
      'admin.reports.channelCsv', { ...this.transactionFilters(query, langHeader), channel: 'WEB' },
      'Failed to export Net Banking report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return this.sendCsv(res, result);
  }

  private accountReportFilters(query: any, lang?: string) {
    return {
      from: query.from || query.startDate,
      to: query.to || query.endDate,
      channel: query.channel || query.platform,
      status: query.status,
      search: query.search,
      page: this.toInt(query.page, 1),
      limit: this.toInt(query.limit, 20),
      lang: lang || 'fr',
    };
  }

  /** Comptes créés, par canal : ?channel=MOBILE (Mobile Banking) ou WEB (Net Banking). */
  @Get('admin/reports/accounts')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminAccountsReport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.reports.accounts', this.accountReportFilters(query, langHeader),
      'Failed to get accounts report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/reports/accounts/export')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminAccountsExport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Res() res: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    const result = await this.sendUserMessage(
      'admin.reports.accountsCsv', this.accountReportFilters(query, langHeader),
      'Failed to export accounts report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return this.sendCsv(res, result);
  }

  @Get('admin/reports/operations')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminOperationsReport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    return this.sendUserMessage(
      'admin.reports.operations',
      {
        from: query.from,
        to: query.to,
        action: query.action,
        currency: query.currency,
        userId: query.userId,
        lang: langHeader || 'fr',
      },
      'Failed to get report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('admin/reports/operations/export')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async adminOperationsExport(
    @CurrentUser() currentUser: any,
    @Query() query: any,
    @Res() res: any,
    @Headers('lang') langHeader?: string,
  ) {
    this.assertAdmin(currentUser);
    const result = await this.sendUserMessage(
      'admin.reports.operationsCsv',
      {
        from: query.from,
        to: query.to,
        action: query.action,
        currency: query.currency,
        userId: query.userId,
        lang: langHeader || 'fr',
      },
      'Failed to export report', HttpStatus.INTERNAL_SERVER_ERROR,
    );
    return this.sendCsv(res, result);
  }

  // ==================== HEALTH CHECK ====================

  @Get('health')
  async healthCheck() {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        auth: true,
        user: true,
        transaction: true,
      },
    };
  }
}
