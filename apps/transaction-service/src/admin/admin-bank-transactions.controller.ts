// apps/transaction-service/src/admin/admin-bank-transactions.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { AdminBankTransactionsService } from './admin-bank-transactions.service';

/**
 * Messages RabbitMQ (file transaction_queue) — réservés aux ADMIN / SUPER_ADMIN
 * (le contrôle du rôle est fait dans l'API gateway).
 */
@Controller()
export class AdminBankTransactionsController {
  constructor(private readonly service: AdminBankTransactionsService) {}

  private toRpc(error: any): RpcException {
    if (error instanceof RpcException) return error;
    return new RpcException({
      status: 'error',
      message: error?.message || 'Impossible de récupérer les transactions',
      statusCode: error?.statusCode || 500,
    });
  }

  @MessagePattern('admin.bankTransactions.list')
  async list(@Payload() data: any) {
    try { return await this.service.list(data || {}); } catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('admin.bankTransactions.csv')
  async csv(@Payload() data: any) {
    try { return await this.service.csv(data || {}); } catch (e) { throw this.toRpc(e); }
  }
}
