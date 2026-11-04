// apps/user-service/src/audit/audit-log.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { AuditLogService } from './audit-log.service';

/**
 * Messages RabbitMQ (file user_queue) envoyés par l'API gateway
 * pour les routes admin/audit-logs et admin/audit/*.
 */
@Controller()
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  private toRpc(error: any, fallback = 500): RpcException {
    if (error instanceof RpcException) return error;
    return new RpcException({
      status: 'error',
      message: error?.message || "Erreur du journal d'audit",
      statusCode: fallback,
    });
  }

  @MessagePattern('get_audit_logs')
  async getAuditLogs(@Payload() data: any) {
    try { return await this.auditLogService.list(data || {}); } catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('get_audit_log')
  async getAuditLog(@Payload() data: { id: string }) {
    try { return await this.auditLogService.getById(data?.id); } catch (e) { throw this.toRpc(e, 404); }
  }

  @MessagePattern('get_user_audit_logs')
  async getUserAuditLogs(@Payload() data: { userId: string; page?: number; limit?: number }) {
    try { return await this.auditLogService.listForUser(data); } catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('get_audit_actions')
  async getAuditActions() {
    try { return await this.auditLogService.actions(); } catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('get_audit_entities')
  async getAuditEntities() {
    try { return await this.auditLogService.entities(); } catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('get_audit_stats')
  async getAuditStats(@Payload() data: { days?: number }) {
    try { return await this.auditLogService.stats(data || {}); } catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('delete_audit_log_by_id')
  async deleteAuditLog(@Payload() data: { id: string; adminId?: string }) {
    try { return await this.auditLogService.deleteById(data); } catch (e) { throw this.toRpc(e); }
  }
}
