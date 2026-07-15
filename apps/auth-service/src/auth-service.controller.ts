/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Controller } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
  RpcException,
} from '@nestjs/microservices';
import { AuthServiceService } from './auth-service.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@Controller()
export class AuthServiceController {
  constructor(private readonly authService: AuthServiceService) { }

  // ==================== AUTH MESSAGE PATTERNS ====================

  @MessagePattern('auth.register')
  async register(@Payload() data: RegisterDto & { ipAddress?: string; lang?: string }) {
    try {
      console.log('[AuthService] Register request received:', {
        email: data.email,
        phone: data.phone,
        hasOtpCode: !!data.otpCode,
      });

      return await this.authService.register(data, data.ipAddress);
    } catch (error) {
      console.error('[AuthService] Register failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Registration failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.login')
  async login(@Payload() data: LoginDto & { ipAddress?: string; lang?: string }) {
    try {
      console.log('[AuthService] Login request received:', {
        identifier: data.identifier,
        hasPassword: !!data.password,
        hasFcmToken: !!data.fcmToken,
        deviceInfo: data.deviceInfo,
      });

      const result = await this.authService.login(data, data.ipAddress);
      console.log('[AuthService] Login successful for:', data.identifier);
      return result;
    } catch (error) {
      console.error('[AuthService] Login failed for:', data.identifier, error);

      if (error instanceof RpcException) {
        throw error;
      }

      throw new RpcException({
        status: 'error',
        message: error.message || 'Login failed',
        statusCode: error.statusCode || error.status || 401,
      });
    }
  }

  @MessagePattern('auth.refresh')
  async refreshToken(@Payload() refreshTokenDto: RefreshTokenDto) {
    try {
      console.log('[AuthService] Refresh token request received');
      return await this.authService.refreshToken(refreshTokenDto.refreshToken);
    } catch (error) {
      console.error('[AuthService] Refresh token failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Refresh token failed',
        statusCode: 401,
      });
    }
  }

  @MessagePattern('auth.logout')
  async logout(@Payload() data: { userId: string; sessionId: string }) {
    try {
      console.log('[AuthService] Logout request received:', data.userId);
      return await this.authService.revokeSessionById(data.userId, data.sessionId);
    } catch (error) {
      console.error('[AuthService] Logout failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Logout failed',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('auth.changePassword')
  async changePassword(@Payload() data: {
    userId: string;
    currentPassword: string;
    newPassword: string;
    lang?: string;
  }) {
    try {
      console.log('[AuthService] Change password request received:', data.userId);
      return await this.authService.changePassword(
        data.userId,
        {
          currentPassword: data.currentPassword,
          newPassword: data.newPassword,
          lang: data.lang,
        },
        undefined,
      );
    } catch (error) {
      console.error('[AuthService] Change password failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Change password failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.forgotPassword')
  async forgotPassword(@Payload() data: { email: string; lang?: string }) {
    try {
      console.log('[AuthService] Forgot password request received:', data.email);
      return await this.authService.sendResetPasswordOtp(
        data.email,
        undefined,
        data.lang || 'fr',
      );
    } catch (error) {
      console.error('[AuthService] Forgot password failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Forgot password failed',
        statusCode: 400,
      });
    }
  }

 @MessagePattern('reset_password')
  async resetPassword(
    @Payload()
    data: {
      identifier: string;
      code: string;
      password: string;
      lang?: string;
    },
  ): Promise<{ message: string }> {
    console.log(
      '📝 [AuthService] Reset password request received:',
      JSON.stringify(data),
    );
    try {
      const result = await this.authService.resetPassword({
        identifier: data.identifier,
        code: data.code,
        password: data.password,
        lang: data.lang,
      });
      return result;
    } catch (error) {
      console.error('❌ [AuthService] Reset password error:', error);
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }
  
  @MessagePattern('auth.verifyOtp')
  async verifyOtp(@Payload() data: { email: string; code: string; lang?: string }) {
    try {
      console.log('[AuthService] Verify OTP request:', data.email);
      return await this.authService.verifyOtp(
        data.email,
        data.code,
        data.lang || 'fr',
      );
    } catch (error) {
      console.error('[AuthService] Verify OTP failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'OTP verification failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.sendResetOtp')
  async sendResetPasswordOtp(@Payload() data: { identifier: string; lang?: string }) {
    try {
      console.log('[AuthService] Send reset OTP request:', data.identifier);
      return await this.authService.sendResetPasswordOtp(
        data.identifier,
        undefined,
        data.lang || 'fr',
      );
    } catch (error) {
      console.error('[AuthService] Send reset OTP failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Send reset OTP failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.validateSession')
  async validateSession(@Payload() data: { userId: string; sessionToken: string }) {
    try {
      console.log('[AuthService] Validate session request received:', data.userId);
      return await this.authService.validateSession(data.userId, data.sessionToken);
    } catch (error) {
      console.error('[AuthService] Validate session failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Validate session failed',
        statusCode: 401,
      });
    }
  }

  @MessagePattern('auth.revokeSessionByToken')
  async revokeSessionByToken(@Payload() data: { userId: string; sessionToken: string }) {
    try {
      console.log('[AuthService] Revoke session by token request received:', data.userId);
      return await this.authService.revokeSessionByToken(data.userId, data.sessionToken);
    } catch (error) {
      console.error('[AuthService] Revoke session by token failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Revoke session failed',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('auth.revokeSessionById')
  async revokeSessionById(@Payload() data: { userId: string; sessionId: string; lang?: string }) {
    try {
      console.log('[AuthService] Revoke session by ID request received:', data.userId);
      return await this.authService.revokeSessionById(
        data.userId,
        data.sessionId,
        data.lang || 'fr',
      );
    } catch (error) {
      console.error('[AuthService] Revoke session by ID failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Revoke session failed',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('auth.setPassword')
  async setPassword(@Payload() data: { userId: string; newPassword: string }) {
    try {
      console.log('[AuthService] Set password request received:', data.userId);
      await this.authService.setPassword(data.userId, data.newPassword);
      return { message: 'Password set successfully' };
    } catch (error) {
      console.error('[AuthService] Set password failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Set password failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.registerDeviceToken')
  async registerDeviceToken(@Payload() data: { userId: string; fcmToken: string }) {
    try {
      console.log('[AuthService] Register device token request received:', data.userId);
      return await this.authService.registerDeviceToken(data.userId, data.fcmToken);
    } catch (error) {
      console.error('[AuthService] Register device token failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Register device token failed',
        statusCode: 400,
      });
    }
  }

  // ==================== 2FA MESSAGE PATTERNS ====================

  @MessagePattern('auth.enable2FA')
  async enableTwoFactor(@Payload() data: { userId: string }) {
    try {
      console.log('[AuthService] Enable 2FA request received:', data.userId);
      return await this.authService.enableTwoFactor(data.userId);
    } catch (error) {
      console.error('[AuthService] Enable 2FA failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Enable 2FA failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.verify2FA')
  async verifyTwoFactor(@Payload() data: { userId: string; code: string }) {
    try {
      console.log('[AuthService] Verify 2FA request received:', data.userId);
      return await this.authService.verifyTwoFactor(data.userId, data.code);
    } catch (error) {
      console.error('[AuthService] Verify 2FA failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Verify 2FA failed',
        statusCode: 401,
      });
    }
  }

  @MessagePattern('auth.disable2FA')
  async disableTwoFactor(@Payload() data: { userId: string; code: string }) {
    try {
      console.log('[AuthService] Disable 2FA request received:', data.userId);
      return await this.authService.disableTwoFactor(data.userId, data.code);
    } catch (error) {
      console.error('[AuthService] Disable 2FA failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Disable 2FA failed',
        statusCode: 400,
      });
    }
  }

  // ==================== PROFILE MESSAGE PATTERNS ====================

  @MessagePattern('auth.getProfile')
  async getProfile(@Payload() data: { userId: string }) {
    try {
      console.log('[AuthService] Get profile request received:', data.userId);
      return await this.authService.getProfile(data.userId);
    } catch (error) {
      console.error('[AuthService] Get profile failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Get profile failed',
        statusCode: 404,
      });
    }
  }

  @MessagePattern('auth.updateProfile')
  async updateProfile(@Payload() data: { userId: string; data: any }) {
    try {
      console.log('[AuthService] Update profile request received:', data.userId);
      return await this.authService.updateProfile(data.userId, data.data);
    } catch (error) {
      console.error('[AuthService] Update profile failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Update profile failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.getSessions')
  async getSessions(@Payload() data: { userId: string }) {
    try {
      console.log('[AuthService] Get sessions request received:', data.userId);
      return await this.authService.getSessions(data.userId);
    } catch (error) {
      console.error('[AuthService] Get sessions failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Get sessions failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.revokeSession')
  async revokeSession(@Payload() data: { userId: string; sessionId: string }) {
    try {
      console.log('[AuthService] Revoke session request received:', data.userId);
      return await this.authService.revokeSession(data.userId, data.sessionId);
    } catch (error) {
      console.error('[AuthService] Revoke session failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Revoke session failed',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('auth.validate')
  async validate(@Payload() data: { userId: string }) {
    try {
      console.log('[AuthService] Validate request received:', data.userId);
      return await this.authService.validateUser(data.userId);
    } catch (error) {
      console.error('[AuthService] Validate failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Validate failed',
        statusCode: 401,
      });
    }
  }

  @MessagePattern('auth.validateUser')
  async validateUser(@Payload() data: { identifier: string; password: string }) {
    try {
      console.log('[AuthService] Validate user request received:', data.identifier);
      return await this.authService.validate(data.identifier, data.password);
    } catch (error) {
      console.error('[AuthService] Validate user failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Validate user failed',
        statusCode: 401,
      });
    }
  }

  // ==================== ADMIN MESSAGE PATTERNS ====================

  @MessagePattern('auth.listAllSessions')
  async listAllSessions(@Payload() data: { page?: number; limit?: number; lang?: string }) {
    try {
      console.log('[AuthService] List all sessions request received');
      return await this.authService.listAllSessions(
        data.page,
        data.limit,
        data.lang || 'fr',
      );
    } catch (error) {
      console.error('[AuthService] List all sessions failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'List all sessions failed',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('auth.listUserSessions')
  async listUserSessions(@Payload() data: { userId: string; page?: number; limit?: number; lang?: string }) {
    try {
      console.log('[AuthService] List user sessions request received:', data.userId);
      return await this.authService.listUserSessions(
        data.userId,
        data.page,
        data.limit,
        data.lang || 'fr',
      );
    } catch (error) {
      console.error('[AuthService] List user sessions failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'List user sessions failed',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('auth.getSessionById')
  async getSessionById(@Payload() data: { sessionId: string; lang?: string }) {
    try {
      console.log('[AuthService] Get session by ID request received:', data.sessionId);
      return await this.authService.getSessionById(data.sessionId, data.lang || 'fr');
    } catch (error) {
      console.error('[AuthService] Get session by ID failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Get session by ID failed',
        statusCode: 404,
      });
    }
  }

  @MessagePattern('auth.getUserStatus')
  async getUserStatus(@Payload() data: { userId: string }) {
    try {
      console.log('[AuthService] Get user status request received:', data.userId);
      return await this.authService.getUserStatus(data.userId);
    } catch (error) {
      console.error('[AuthService] Get user status failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Get user status failed',
        statusCode: 404,
      });
    }
  }

  @MessagePattern('auth.getLoginAttempts')
  async getLoginAttempts(@Payload() data: { userId: string; page?: number; limit?: number }) {
    try {
      console.log('[AuthService] Get login attempts request received:', data.userId);
      return await this.authService.getLoginAttempts(data.userId, data.page, data.limit);
    } catch (error) {
      console.error('[AuthService] Get login attempts failed:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Get login attempts failed',
        statusCode: 500,
      });
    }
  }

  // ==================== HEALTH CHECK ====================

  @MessagePattern('auth.health')
  async healthCheck() {
    return {
      status: 'ok',
      service: 'auth-service',
      timestamp: new Date().toISOString(),
    };
  }
}