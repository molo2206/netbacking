/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-return */
// apps/user-service/src/user-service.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { UserServiceService } from './user-service.service';
import { CreateUserDto } from '../dto/create-user.dto';
import { CreateUserFromAccountDto } from '../dto/create-user-from-account.dto';
import { UpdateUserSettingsDto } from '../dto/user-settings.dto';
import { CreateResourceDto } from '../resources/dto/create-resource.dto';
import { UpdateResourceDto } from '../resources/dto/update-resource.dto';
import { AssignMultipleResourcesDto } from '../dto/assign-resource.dto';
import { UpsertAppSettingsDto } from '../dto/app-settings.dto';
import { UpdateUserDto } from '../dto/update-user.dto';
import { UserApprovalService } from './approval/user-approval.service';
import { AdminSecurityService } from './admin/admin-security.service';
import type { AdminActionInput } from './admin/admin-security.service';
import { OperationControlsService } from './admin/operation-controls.service';
import { AdminMonitoringService } from './admin/admin-monitoring.service';
import { AdminStatsService } from './admin/admin-stats.service';
import { UserNotificationsService } from './account/user-notifications.service';

@Controller()
export class UserServiceController {
  constructor(
    private readonly userService: UserServiceService,
    private readonly approvalService: UserApprovalService,
    private readonly adminSecurity: AdminSecurityService,
    private readonly operationControls: OperationControlsService,
    private readonly adminMonitoring: AdminMonitoringService,
    private readonly adminStats: AdminStatsService,
    private readonly userNotifications: UserNotificationsService,
  ) { }

  // ==================== NOTIFICATIONS DE L'UTILISATEUR ====================

  @MessagePattern('notifications.list')
  async notificationsList(@Payload() data: { userId: string; page?: number; limit?: number; unreadOnly?: boolean }) {
    try { return await this.userNotifications.list(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('notifications.unreadCount')
  async notificationsUnreadCount(@Payload() data: { userId: string }) {
    try { return await this.userNotifications.unreadCount(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('notifications.markSeen')
  async notificationsMarkSeen(@Payload() data: { notificationId: string; userId: string }) {
    try { return await this.userNotifications.markSeen(data); } catch (e) { throw this.toRpcError(e, 404); }
  }

  @MessagePattern('notifications.markAllSeen')
  async notificationsMarkAllSeen(@Payload() data: { userId: string }) {
    try { return await this.userNotifications.markAllSeen(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('notifications.delete')
  async notificationsDelete(@Payload() data: { notificationId: string; userId: string }) {
    try { return await this.userNotifications.remove(data); } catch (e) { throw this.toRpcError(e, 404); }
  }

  @MessagePattern('admin.notifications.pushStatus')
  async adminPushStatus(@Payload() data: any) {
    try { return await this.userNotifications.pushDiagnostic(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.notifications.send')
  async adminSendNotification(@Payload() data: any) {
    try { return await this.userNotifications.adminSend(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('delete_own_account')
  async deleteOwnAccount(@Payload() data: { id: string; password: string; lang?: string; ipAddress?: string }) {
    try { return await this.userNotifications.deleteOwnAccount(data); } catch (e) { throw this.toRpcError(e); }
  }

  // ==================== ADMIN : STATISTIQUES ====================

  @MessagePattern('admin.stats.users')
  async adminStatsUsers(@Payload() data: any) {
    try { return await this.adminStats.usersByPlatform(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.stats.transactions')
  async adminStatsTransactions(@Payload() data: any) {
    try { return await this.adminStats.transactionVolumes(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  // ==================== ADMIN : RAPPORTS MOBILE BANKING / NET BANKING ====================

  @MessagePattern('admin.reports.channels')
  async adminChannelsReport(@Payload() data: any) {
    try { return await this.adminStats.channelsComparison(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.reports.channel')
  async adminChannelReport(@Payload() data: any) {
    try { return await this.adminStats.channelReport(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.reports.channelCsv')
  async adminChannelCsv(@Payload() data: any) {
    try { return await this.adminStats.channelCsv(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.reports.accounts')
  async adminAccountsReport(@Payload() data: any) {
    try { return await this.adminStats.accountsByChannel(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.reports.accountsCsv')
  async adminAccountsCsv(@Payload() data: any) {
    try { return await this.adminStats.accountsCsv(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.transactions.list')
  async adminTransactionsList(@Payload() data: any) {
    try { return await this.adminStats.listTransactions(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.transactions.csv')
  async adminTransactionsCsv(@Payload() data: any) {
    try { return await this.adminStats.transactionsCsv(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.monitoring.email')
  async adminEmailStatus(@Payload() data: { verify?: boolean; lang?: string }) {
    try { return await this.adminStats.emailStatus(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.monitoring.emailTest')
  async adminEmailTest(@Payload() data: { to: string; adminId: string; lang?: string }) {
    try { return await this.adminStats.sendTestEmail(data); } catch (e) { throw this.toRpcError(e); }
  }

  // ==================== ADMIN : SÉCURITÉ DES COMPTES ====================

  @MessagePattern('admin.security.overview')
  async adminSecurityOverview(@Payload() data: { userId: string; lang?: string }) {
    try { return await this.adminSecurity.overview(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.security.unlockPin')
  async adminUnlockPin(@Payload() data: AdminActionInput) {
    try { return await this.adminSecurity.unlockPin(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.security.resetPin')
  async adminResetPin(@Payload() data: AdminActionInput) {
    try { return await this.adminSecurity.resetPin(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.security.block')
  async adminBlockUser(@Payload() data: AdminActionInput) {
    try { return await this.adminSecurity.block(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.security.unblock')
  async adminUnblockUser(@Payload() data: AdminActionInput) {
    try { return await this.adminSecurity.unblock(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.security.forceLogout')
  async adminForceLogout(@Payload() data: AdminActionInput) {
    try { return await this.adminSecurity.forceLogout(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.security.resetPassword')
  async adminResetPassword(@Payload() data: AdminActionInput) {
    try { return await this.adminSecurity.resetPassword(data); } catch (e) { throw this.toRpcError(e); }
  }

  // ==================== ADMIN : CONTRÔLE DES OPÉRATIONS ====================

  @MessagePattern('admin.controls.get')
  async adminGetControls(@Payload() data: { lang?: string }) {
    try { return await this.operationControls.get(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.controls.update')
  async adminUpdateControls(@Payload() data: { adminId: string; patch: any; lang?: string; ipAddress?: string }) {
    try { return await this.operationControls.update(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.limits.get')
  async adminGetUserLimits(@Payload() data: { userId: string; lang?: string }) {
    try { return await this.operationControls.getUserLimits(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.limits.update')
  async adminUpdateUserLimits(@Payload() data: any) {
    try { return await this.operationControls.updateUserLimits(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.limits.reset')
  async adminResetUserLimits(@Payload() data: any) {
    try { return await this.operationControls.resetUserLimits(data); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('controls.public')
  async publicControls(@Payload() data: { lang?: string }) {
    try { return await this.operationControls.getPublic(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  // ==================== ADMIN : SUPERVISION & RAPPORTS ====================

  @MessagePattern('admin.monitoring.smsLogs')
  async adminSmsLogs(@Payload() data: any) {
    try { return await this.adminMonitoring.smsLogs(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.reports.operations')
  async adminOperationsReport(@Payload() data: any) {
    try { return await this.adminMonitoring.operationsReport(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  @MessagePattern('admin.reports.operationsCsv')
  async adminOperationsCsv(@Payload() data: any) {
    try { return await this.adminMonitoring.operationsCsv(data || {}); } catch (e) { throw this.toRpcError(e); }
  }

  private toRpcError(error: any, fallbackStatus: number = 400): RpcException {
    if (error instanceof RpcException) return error;
    return new RpcException({
      status: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      statusCode: fallbackStatus,
    });
  }

  // ==================== COMMANDES AVEC TRADUCTION ====================

  // ✅ Création côté admin → compte APPROUVÉ directement + mot de passe temporaire envoyé
  @MessagePattern('create_user')
  async createUser(@Payload() data: CreateUserDto & { ipAddress?: string }) {
    const lang = data.lang || 'fr';
    try {
      return await this.approvalService.adminCreateUser({ ...data, lang }, data.ipAddress);
    } catch (error) {
      throw this.toRpcError(error);
    }
  }

  // ✅ Création depuis un client bancaire → même flux (vérification banque + approbation directe)
  @MessagePattern('create_user_from_account')
  async createUserFromAccount(@Payload() data: CreateUserFromAccountDto & { ipAddress?: string }) {
    const lang = data.lang || 'fr';
    try {
      return await this.approvalService.adminCreateUser(
        {
          clientId: data.clientId,
          fullName: data.fullName,
          email: data.email,
          phone: data.phone,
          role: data.role,
          createdBy: data.createdBy,
          lang,
        },
        data.ipAddress,
      );
    } catch (error) {
      throw this.toRpcError(error);
    }
  }

  @MessagePattern('update_user')
  async updateUser(@Payload() data: { id: string } & UpdateUserDto) {
    const { id, ...updateData } = data;
    const lang = updateData.lang || 'fr';
    console.log('🔍 Langue reçue par update_user :', lang);
    try {
      return await this.userService.updateUser(id, updateData, lang);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  // ✅ Handler manquant : la route PATCH /users/:id/role envoyait ce message
  //    sans que personne ne l'écoute → la modification du rôle échouait toujours.
  @MessagePattern('update_user_role')
  async updateUserRole(
    @Payload() data: { id: string; role: string; requesterId: string; lang?: string; reason?: string },
  ) {
    try {
      return await this.userService.updateUserRole(data);
    } catch (error) {
      throw this.toRpcError(error);
    }
  }

  @MessagePattern('update_user_status')
  async updateUserStatus(
    @Payload()
    data: {
      id: string;
      status: string;
      requesterId: string;
      lang?: string;
    },
  ) {
    const lang = data.lang || 'fr';
    try {
      // ✅ Passer un compte EN ATTENTE à ACTIVE = l'approuver
      //    (génère et envoie le mot de passe temporaire au lieu d'activer "à vide")
      if (String(data.status || '').trim().toUpperCase() === 'ACTIVE') {
        const current = await this.userService.getUser(data.id, lang);
        if (current?.data?.status === 'PENDING_VERIFICATION') {
          return await this.approvalService.approveUser({
            id: data.id,
            approverId: data.requesterId,
            lang,
          });
        }
      }
      return await this.userService.updateUserStatus(
        data.id,
        data.status,
        data.requesterId,
        lang,
      );
    } catch (error) {
      throw this.toRpcError(error);
    }
  }

  // ==================== APPROBATION DES COMPTES ====================

  @MessagePattern('list_pending_registrations')
  async listPendingRegistrations(
    @Payload() data: { page?: number; limit?: number; search?: string; lang?: string },
  ) {
    try {
      return await this.approvalService.listPendingRegistrations(data || {});
    } catch (error) {
      throw this.toRpcError(error, 500);
    }
  }

  @MessagePattern('approve_user')
  async approveUser(
    @Payload() data: { id: string; approverId: string; lang?: string; ipAddress?: string },
  ) {
    try {
      return await this.approvalService.approveUser(data);
    } catch (error) {
      throw this.toRpcError(error);
    }
  }

  @MessagePattern('reject_user')
  async rejectUser(
    @Payload() data: { id: string; rejecterId: string; reason?: string; lang?: string; ipAddress?: string },
  ) {
    try {
      return await this.approvalService.rejectUser(data);
    } catch (error) {
      throw this.toRpcError(error);
    }
  }

  @MessagePattern('resend_temp_password')
  async resendTemporaryPassword(
    @Payload() data: { id: string; adminId: string; lang?: string; ipAddress?: string },
  ) {
    try {
      return await this.approvalService.resendTemporaryPassword(data);
    } catch (error) {
      throw this.toRpcError(error);
    }
  }

  @MessagePattern('delete_user')
  async deleteUser(@Payload() data: { id: string; lang?: string; requesterId?: string; reason?: string }) {
    const lang = data.lang || 'fr';
    try {
      // ✅ Suppression DÉFINITIVE (historique conservé) — voir UserServiceService.deleteUser
      return await this.userService.deleteUser(data.id, lang, data.requesterId, data.reason);
    } catch (error) {
      throw this.toRpcError(error);
    }
  }

  @MessagePattern('change_pin')
  async changePin(@Payload() data: { id: string; pin: string; lang?: string }) {
    const lang = data.lang || 'fr';
    console.log('🔍 Langue reçue par change_pin :', lang);
    try {
      return await this.userService.changePin(data.id, data.pin, lang);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('update_pin')
  async updatePin(
    @Payload()
    data: {
      id: string;
      oldPin: string;
      newPin: string;
      lang?: string;
    },
  ) {
    const lang = data.lang || 'fr';
    console.log('🔍 Langue reçue par update_pin :', lang);
    try {
      return await this.userService.updatePin(
        data.id,
        data.oldPin,
        data.newPin,
        lang,
      );
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('verify_pin')
  async verifyPin(
    @Payload() data: { userId: string; pin: string; lang?: string },
  ) {
    const lang = data.lang || 'fr';
    console.log('🔍 Langue reçue par verify_pin :', lang);

    try {
      return await this.userService.verifyPin(data.userId, data.pin, lang);
    } catch (error: any) {
      if (error instanceof RpcException) {
        throw error;
      }

      throw new RpcException({
        status: 'error',
        message: error?.message || 'Unknown error',
        statusCode: error?.statusCode || 500,
      });
    }
  }

  @MessagePattern('getCheckbooksByAccount')
  async getCheckbooksByAccount(@Payload() data: {
    accountNumber: string;
    lang?: string;
  }) {
    try {
      if (!data.accountNumber) {
        throw new RpcException({
          status: 'error',
          message: 'Account number is required',
          statusCode: 400,
        });
      }

      const result = await this.userService.getCheckbooksByAccount({
        accountNumber: data.accountNumber,
        lang: data.lang || 'fr',
      });

      return {
        success: true,
        message: result.message || 'Chéquiers récupérés avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get checkbooks',
        statusCode: 500,
      });
    }
  }

  // apps/transaction-service/src/transaction-service.controller.ts

  @MessagePattern('requestCheckbook')
  async requestCheckbook(@Payload() data: {
    accountNumber: string;
    pickUpBranch: string;
    numberOfCheckbookLeaves: number;
    numberofcheckbooks?: number;
    lang?: string;
  }) {
    try {
      if (!data.accountNumber) {
        throw new RpcException({
          status: 'error',
          message: 'Account number is required',
          statusCode: 400,
        });
      }

      if (!data.pickUpBranch) {
        throw new RpcException({
          status: 'error',
          message: 'Pick up branch is required',
          statusCode: 400,
        });
      }

      if (!data.numberOfCheckbookLeaves || data.numberOfCheckbookLeaves < 1) {
        throw new RpcException({
          status: 'error',
          message: 'Number of checkbook leaves must be greater than 0',
          statusCode: 400,
        });
      }

      const result = await this.userService.requestCheckbook(data);
      return {
        success: true,
        message: result.message || 'Demande de chéquier effectuée avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] requestCheckbook error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to request checkbook',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('getCheckbookStatus')
  async getCheckbookStatus(@Payload() data: {
    checkbookId: string;
    lang?: string;
  }) {
    try {
      if (!data.checkbookId) {
        throw new RpcException({
          status: 'error',
          message: 'Checkbook ID is required',
          statusCode: 400,
        });
      }

      const result = await this.userService.getCheckbookStatus({
        checkbookId: data.checkbookId,
        lang: data.lang || 'fr',
      });

      return {
        success: true,
        message: result.message || 'Statut du chéquier récupéré avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] getCheckbookStatus error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get checkbook status',
        statusCode: 500,
      });
    }
  }
  @MessagePattern('blockCheckbook')
  async blockCheckbook(@Payload() data: {
    checkbookId: string;
    reason?: string;
    lang?: string;
  }) {
    try {
      if (!data.checkbookId) {
        throw new RpcException({
          status: 'error',
          message: 'Checkbook ID is required',
          statusCode: 400,
        });
      }

      const result = await this.userService.blockCheckbook({
        checkbookId: data.checkbookId,
        reason: data.reason,
        lang: data.lang || 'fr',
      });

      return {
        success: true,
        message: result.message || 'Chéquier bloqué avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] blockCheckbook error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to block checkbook',
        statusCode: 500,
      });
    }
  }
  // ==================== REQUÊTES GET (lecture seule, traduction minimale) ====================

  @MessagePattern('get_user')
  async getUser(@Payload() data: { id: string; lang?: string }) {
    try {
      return await this.userService.getUser(data.id, data.lang);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 404,
      });
    }
  }

  @MessagePattern('get_user_by_email')
  async getUserByEmail(@Payload() data: { email: string; lang?: string }) {
    try {
      return await this.userService.getUserByEmail(data.email, data.lang);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 404,
      });
    }
  }

  @MessagePattern('get_user_by_phone')
  async getUserByPhone(@Payload() data: { phone: string; lang?: string }) {
    try {
      return await this.userService.getUserByPhone(data.phone, data.lang);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 404,
      });
    }
  }

  @MessagePattern('list_users')
  async listUsers(
    @Payload()
    data: {
      page: number;
      limit: number;
      role?: string;
      status?: string;
      lang?: string;
    },
  ) {
    try {
      return await this.userService.listUsers(data);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('list_users_links')
  async listUsersLinks(
    @Payload()
    data: {
      page: number;
      limit: number;
      role?: string;
      status?: string;
      lang?: string;
    },
  ) {
    try {
      return await this.userService.listUsersLinks(data);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_user_settings')
  async getUserSettings(@Payload() data: { userId: string }) {
    return this.userService.getUserSettings(data.userId);
  }

  @MessagePattern('update_user_settings')
  async updateUserSettings(
    @Payload() data: { userId: string; settings: UpdateUserSettingsDto },
  ) {
    return this.userService.updateUserSettings(data.userId, data.settings);
  }

  @MessagePattern('get_admin_dashboard')
  async getAdminDashboard(
    @Payload() payload: { startDate?: string; endDate?: string },
  ) {
    const startDate = payload.startDate
      ? new Date(payload.startDate)
      : undefined;
    const endDate = payload.endDate ? new Date(payload.endDate) : undefined;
    return this.userService.getAdminDashboard({ startDate, endDate });
  }

  // ==================== GESTION DES RESSOURCES ====================

  @MessagePattern('create_resource')
  async createResource(@Payload() data: CreateResourceDto) {
    try {
      return await this.userService.createResource(data);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('update_resource')
  async updateResource(@Payload() data: { id: string } & UpdateResourceDto) {
    const { id, ...rest } = data;
    try {
      return await this.userService.updateResource(id, rest);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_all_resources')
  async getAllResources(@Payload() data: { page?: number; limit?: number }) {
    const page = data?.page || 1;
    const limit = data?.limit || 10;
    try {
      return await this.userService.getAllResources(page, limit);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_one_resource')
  async getOneResource(@Payload() data: { id: string }) {
    try {
      return await this.userService.getOneResource(data.id);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 404,
      });
    }
  }

  // ==================== ASSIGNATION RESSOURCES - UTILISATEURS ====================

  @MessagePattern('assign_resource_to_user')
  async assignMultipleResourcesToUser(
    @Payload() data: AssignMultipleResourcesDto,
  ) {
    try {
      return await this.userService.assignMultipleResourcesToUser(data);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('get_user_resources')
  async getUserResources(@Payload() data: { userId: string }) {
    try {
      return await this.userService.getUserResources(data.userId);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('revoke_resource')
  async revokeResource(
    @Payload() data: { userId: string; resourceId: string },
  ) {
    try {
      return await this.userService.revokeResource(
        data.userId,
        data.resourceId,
      );
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('upsert_app_settings')
  async upsertAppSettings(@Payload() data: UpsertAppSettingsDto) {
    try {
      return await this.userService.upsertAppSettings(data);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 500,
      });
    }
  }

  @MessagePattern('get_app_settings')
  async getAppSettings() {
    try {
      return await this.userService.getAppSettings();
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error.message,
        statusCode: 500,
      });
    }
  }

  @MessagePattern('get_client_by_client_id')
  async getClientByClientId(@Payload() data: { clientId: string; lang?: string }) {
    const lang = data.lang || 'fr';
    try {
      return await this.userService.getClientByClientId(data.clientId, lang);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get client',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('get_user_accounts')
  async getUserAccounts(@Payload() data: { userId: string; lang?: string }) {
    const lang = data.lang || 'fr';
    try {
      return await this.userService.getUserAccounts(data.userId, lang);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get user accounts',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('list_all_clients')
  async listAllClients(@Payload() data: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    kycLevel?: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';
    try {
      return await this.userService.listAllClients({
        page: data.page || 1,
        limit: data.limit || 10,
        search: data.search,
        status: data.status,
        kycLevel: data.kycLevel,
        lang,
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to list clients',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('get_account_by_number')
  async getAccountByNumber(@Payload() data: { accountNumber: string; lang?: string }) {
    const lang = data.lang || 'fr';
    try {
      return await this.userService.getAccountByNumber(data.accountNumber, lang);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get account',
        statusCode: 500,
      });
    }
  }
  @MessagePattern('health_check')
  async healthCheck() {
    return { status: 'ok', service: 'user-service' };
  }
}
