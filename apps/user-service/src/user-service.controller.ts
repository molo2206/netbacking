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

@Controller()
export class UserServiceController {
  constructor(private readonly userService: UserServiceService) { }

  // ==================== COMMANDES AVEC TRADUCTION ====================

  @MessagePattern('create_user')
  async createUser(@Payload() data: CreateUserDto) {
    const lang = data.lang || 'fr';
    console.log('🔍 Langue reçue par create_user :', lang);
    data.lang = lang; // Injection pour le service
    try {
      return await this.userService.createUser(data);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Unknown error',
        statusCode: 400,
      });
    }
  }

  @MessagePattern('create_user_from_account')
  async createUserFromAccount(@Payload() data: CreateUserFromAccountDto) {
    const lang = data.lang || 'fr';
    console.log('🔍 Langue reçue par create_user_from_account :', lang);
    data.lang = lang;
    try {
      return await this.userService.createUserFromAccount(data);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
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

  @MessagePattern('update_user_status') // changer en minuscules
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
    console.log('🔍 Langue reçue par update_user_status :', lang);
    try {
      return await this.userService.updateUserStatus(
        data.id,
        data.status,
        data.requesterId,
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

  @MessagePattern('delete_user')
  async deleteUser(@Payload() data: { id: string; lang?: string }) {
    const lang = data.lang || 'fr';
    console.log('🔍 Langue reçue par delete_user :', lang);
    try {
      return await this.userService.deleteUser(data.id, lang);
    } catch (error) {
      throw new RpcException({
        status: 'error',
        message: error instanceof Error ? error.message : 'Unknown error',
        statusCode: 400,
      });
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
  @MessagePattern('health_check')
  async healthCheck() {
    return { status: 'ok', service: 'user-service' };
  }
}
