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
    try {
      const result = await firstValueFrom(
        client.send(pattern, data).pipe(
          timeout(timeoutMs),
          catchError((error: any) => {
            this.logger.error(`Error in ${pattern}:`, error);

            let errorMessage = defaultMessage;
            let errorStatus = defaultStatus;

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

    // ✅ Vérifier les champs requis (clientId et password sont obligatoires)
    if (!body.clientId) {
      throw new HttpException('ClientId is required', HttpStatus.BAD_REQUEST);
    }
    if (!body.password) {
      throw new HttpException('Password is required', HttpStatus.BAD_REQUEST);
    }

    // ✅ Déterminer la plateforme depuis le header x-client
    const platform = clientHeader || body.platform || 'WEB';

    // ✅ Construire le payload
    const payload = {
      clientId: body.clientId,
      password: body.password,
      otpCode: body.otpCode || '', // ✅ otpCode optionnel
      fcmToken: body.fcmToken || null,
      phone: body.phone || null,
      email: body.email || null,
      firstName: body.firstName || null,
      lastName: body.lastName || null,
      platform: platform,
      deviceInfo: body.deviceInfo || userAgent || 'unknown',
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
      { ...body, lang },
      'Login failed',
      HttpStatus.UNAUTHORIZED
    );
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
    if (!body.email) {
      throw new HttpException('Email is required', HttpStatus.BAD_REQUEST);
    }
    const lang = langHeader || 'fr';
    return this.sendAuthMessage(
      'auth.forgotPassword',
      { email: body.email, lang },
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
    if (!body.email) {
      throw new HttpException('Email is required', HttpStatus.BAD_REQUEST);
    }
    if (!body.code) {
      throw new HttpException('OTP code is required', HttpStatus.BAD_REQUEST);
    }
    const lang = langHeader || 'fr';
    return this.sendAuthMessage(
      'auth.verifyOtp',
      {
        email: body.email,
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

  @Post('users')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async createUser(
    @CurrentUser() currentUser: any,
    @Body() body: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    if (!body.email || !body.phone || !body.password || !body.firstName || !body.lastName) {
      throw new HttpException('Missing required fields', HttpStatus.BAD_REQUEST);
    }
    return this.sendUserMessage(
      'create_user',
      { ...body, createdBy: currentUser.id },
      'Create user failed',
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
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN' && currentUser?.id !== id) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      delete body.role;
      delete body.status;
    }
    return this.sendUserMessage(
      'update_user',
      { id, ...body },
      'Update user failed',
      HttpStatus.BAD_REQUEST
    );
  }

  @Delete('users/:id')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async deleteUser(
    @Param('id') id: string,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    if (currentUser?.id === id) {
      throw new HttpException('Cannot delete yourself', HttpStatus.BAD_REQUEST);
    }
    return this.sendUserMessage(
      'delete_user',
      { id },
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
    @Body('role') role: string,
    @CurrentUser() currentUser: any,
  ) {
    if (currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Super Admin only.', HttpStatus.FORBIDDEN);
    }
    if (!role) {
      throw new HttpException('Role is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendUserMessage(
      'update_user_role',
      { id, role },
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
    @Body() body: { fcmToken: string },
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const { fcmToken } = body;
    if (!fcmToken) {
      throw new HttpException('FCM token is required', HttpStatus.BAD_REQUEST);
    }
    return this.sendAuthMessage(
      'auth.registerDeviceToken',
      { userId: currentUser.id, fcmToken },
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
  ) {
    if (currentUser?.role !== 'ADMIN' && currentUser?.role !== 'SUPER_ADMIN') {
      throw new HttpException('Access denied. Admin only.', HttpStatus.FORBIDDEN);
    }
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendUserMessage(
      'get_audit_logs',
      { page: pageNum, limit: limitNum, userId, action, entity, startDate, endDate },
      'Failed to get audit logs',
      HttpStatus.INTERNAL_SERVER_ERROR
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
    @Body() body: { accountId: string; amount: number; description?: string; reference?: string },
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.deposit',
      { ...body, initiatedBy: currentUser.id, lang },
      'Deposit failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('transactions/withdraw')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async withdraw(
    @CurrentUser() currentUser: any,
    @Body() body: { accountId: string; amount: number; description?: string },
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.withdraw',
      { ...body, initiatedBy: currentUser.id, lang },
      'Withdrawal failed',
      HttpStatus.BAD_REQUEST,
    );
  }

  @Post('transactions/transfer')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async transfer(
    @CurrentUser() currentUser: any,
    @Body() body: {
      senderAccountNumber: string;
      receiverAccountNumber: string;
      receiverName?: string;
      receiverPhone?: string;
      receiverEmail?: string;
      amount: number;
      fees?: number;
      description?: string;
      currency?: string;
      type?: transfers_type;
      platform?: transfers_platform;
    },
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';

    return this.sendTransactionMessage(
      'transaction.transfer',
      {
        senderAccountNumber: body.senderAccountNumber,
        receiverAccountNumber: body.receiverAccountNumber,
        receiverName: body.receiverName,
        receiverPhone: body.receiverPhone,
        receiverEmail: body.receiverEmail,
        amount: body.amount,
        fees: body.fees || 0,
        description: body.description,
        currency: body.currency,
        type: body.type,
        platform: body.platform,
        initiatedBy: currentUser.id,
        lang,
      },
      'Transfer failed',
      HttpStatus.BAD_REQUEST,
    );
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
      { id, lang },
      'Transaction not found',
      HttpStatus.NOT_FOUND,
    );
  }

  @Get('transactions/account/:accountNumber')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransactionsByAccount(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,  // ✅ Changé de accountId à accountNumber
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: transactions_type,
    @Query('status') status?: transactions_status,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    return this.sendTransactionMessage(
      'transaction.getByAccount',
      {
        accountNumber: accountNumber,  // ✅ Passer accountNumber
        page: pageNum,
        limit: limitNum,
        type: type,
        status: status,
        lang
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
    @Headers('lang') langHeader?: string,
  ) {
    try {
      console.log('[API Gateway] getMyTransactions called');
      console.log('[API Gateway] currentUser:', currentUser);

      if (!currentUser || !currentUser.id) {
        throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
      }

      const lang = langHeader || 'fr';
      const pageNum = page ? parseInt(page, 10) : 1;
      const limitNum = limit ? parseInt(limit, 10) : 10;

      console.log('[API Gateway] Sending to transaction service:', {
        userId: currentUser.id,
        page: pageNum,
        limit: limitNum,
        type,
        status,
        lang
      });

      const result = await this.sendTransactionMessage(
        'transaction.getByUserId',
        {
          userId: currentUser.id,
          page: pageNum,
          limit: limitNum,
          type: type,
          status: status,
          lang
        },
        'Failed to get transactions',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );

      console.log('[API Gateway] Result from transaction service:', result);
      return result;
    } catch (error) {
      console.error('[API Gateway] getMyTransactions error:', error);
      throw error;
    }
  }

  @Get('transactions/balance/:accountId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getBalance(
    @Param('accountId') accountId: string,
    @CurrentUser() currentUser: any,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    return this.sendTransactionMessage(
      'transaction.getBalance',
      { accountId, lang },
      'Failed to get balance',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Get('transactions/statement/:accountNumber')  // ✅ Changé de accountId à accountNumber
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getStatement(
    @CurrentUser() currentUser: any,
    @Param('accountNumber') accountNumber: string,  // ✅ Changé de accountId à accountNumber
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('type') type?: transactions_type,
    @Query('status') status?: transactions_status,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }

    const lang = langHeader || 'fr';
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 50;

    return this.sendTransactionMessage(
      'transaction.getStatement',
      {
        accountNumber: accountNumber,  // ✅ Passer accountNumber
        startDate,
        endDate,
        page: pageNum,
        limit: limitNum,
        type,
        status,
        lang
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
      { id, lang },
      'Transfer not found',
      HttpStatus.NOT_FOUND,
    );
  }

  @Get('transfers/account/:accountId')
  @UseGuards(JwtAuthGuard, AuthentificationGuard)
  async getTransfersByAccount(
    @Param('accountId') accountId: string,
    @CurrentUser() currentUser: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;
    return this.sendTransactionMessage(
      'transaction.getTransfersByAccount',
      { accountId, page: pageNum, limit: limitNum, lang },
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
    @Headers('lang') langHeader?: string,
  ) {
    if (!currentUser || !currentUser.id) {
      throw new HttpException('User not authenticated', HttpStatus.UNAUTHORIZED);
    }
    const lang = langHeader || 'fr';
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 10;

    return this.sendTransactionMessage(
      'transaction.getTransfersByUser',
      {
        userId: currentUser.id,
        page: pageNum,
        limit: limitNum,
        lang
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