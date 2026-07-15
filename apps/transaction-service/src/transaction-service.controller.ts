// apps/transaction-service/src/transaction-service.controller.ts
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { TransactionServiceService } from './transaction-service.service';
import { 
  TransferDto, 
  DepositDto, 
  WithdrawDto,
} from '../dto/create-transaction.dto';
import { transactions_status, transactions_type } from '@prisma/client';

@Controller()
export class TransactionServiceController {
  constructor(private readonly transactionService: TransactionServiceService) {}

  // ==================== TRANSFERT ====================

  @MessagePattern('transaction.transfer')
  async transfer(@Payload() data: TransferDto & { lang?: string }) {
    try {
      return await this.transactionService.transfer(data);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Transfer failed',
        statusCode: 500,
      });
    }
  }

  // ==================== DÉPÔT ====================

  @MessagePattern('transaction.deposit')
  async deposit(@Payload() data: DepositDto & { initiatedBy?: string; lang?: string }) {
    try {
      return await this.transactionService.deposit(data);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Deposit failed',
        statusCode: 500,
      });
    }
  }

  // ==================== RETRAIT ====================

  @MessagePattern('transaction.withdraw')
  async withdraw(@Payload() data: WithdrawDto & { initiatedBy?: string; lang?: string }) {
    try {
      return await this.transactionService.withdraw(data);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Withdrawal failed',
        statusCode: 500,
      });
    }
  }

  // ==================== RELEVÉ DE COMPTE ====================

  @MessagePattern('transaction.getStatement')
  async getAccountStatement(@Payload() data: { 
    accountId: string; 
    startDate?: string; 
    endDate?: string;
    page?: number;
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    lang?: string;
  }) {
    try {
      const startDate = data.startDate ? new Date(data.startDate) : undefined;
      const endDate = data.endDate ? new Date(data.endDate) : undefined;
      
      return await this.transactionService.getAccountStatement(data.accountId, {
        startDate,
        endDate,
        page: data.page,
        limit: data.limit,
        type: data.type,
        status: data.status,
        lang: data.lang,
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get statement',
        statusCode: 500,
      });
    }
  }

  // ==================== TRANSACTIONS ====================

  @MessagePattern('transaction.getById')
  async getTransactionById(@Payload() data: { id: string; lang?: string }) {
    try {
      return await this.transactionService.getTransactionById(data.id, data.lang);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Transaction not found',
        statusCode: 404,
      });
    }
  }

  @MessagePattern('transaction.getByAccount')
  async getTransactionsByAccount(@Payload() data: { 
    accountId: string; 
    page?: number; 
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    lang?: string;
  }) {
    try {
      return await this.transactionService.getTransactionsByAccount(data.accountId, {
        page: data.page,
        limit: data.limit,
        type: data.type,
        status: data.status,
        lang: data.lang,
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get transactions',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('transaction.getByClient')
  async getTransactionsByClient(@Payload() data: { 
    clientId: string; 
    page?: number; 
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    lang?: string;
  }) {
    try {
      return await this.transactionService.getTransactionsByClient(data.clientId, {
        page: data.page,
        limit: data.limit,
        type: data.type,
        status: data.status,
        lang: data.lang,
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get transactions',
        statusCode: 500,
      });
    }
  }

  // ==================== TRANSFERTS ====================

  @MessagePattern('transaction.getTransferById')
  async getTransferById(@Payload() data: { id: string; lang?: string }) {
    try {
      return await this.transactionService.getTransferById(data.id, data.lang);
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Transfer not found',
        statusCode: 404,
      });
    }
  }

  @MessagePattern('transaction.getTransfersByAccount')
  async getTransfersByAccount(@Payload() data: { 
    accountId: string; 
    page?: number; 
    limit?: number;
    lang?: string;
  }) {
    try {
      return await this.transactionService.getTransfersByAccount(data.accountId, {
        page: data.page,
        limit: data.limit,
        lang: data.lang,
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get transfers',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('transaction.getTransfersByUser')
  async getTransfersByUser(@Payload() data: { 
    userId: string; 
    page?: number; 
    limit?: number;
    lang?: string;
  }) {
    try {
      return await this.transactionService.getTransfersByUser(data.userId, {
        page: data.page,
        limit: data.limit,
        lang: data.lang,
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get transfers',
        statusCode: 500,
      });
    }
  }

  // ==================== STATISTIQUES ====================

  @MessagePattern('transaction.getStats')
  async getTransactionStats(@Payload() data: { 
    userId: string; 
    days?: number;
    lang?: string;
  }) {
    try {
      return await this.transactionService.getTransactionStats(
        data.userId, 
        data.days || 30,
        data.lang,
      );
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get stats',
        statusCode: 500,
      });
    }
  }

  // ==================== HEALTH CHECK ====================

  @MessagePattern('transaction.health')
  async healthCheck() {
    return this.transactionService.healthCheck();
  }
}