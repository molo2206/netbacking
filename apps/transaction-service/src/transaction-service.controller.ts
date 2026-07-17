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
  constructor(private readonly transactionService: TransactionServiceService) { }

  // ==================== TRANSFERT ====================

  @MessagePattern('transaction.transfer')
  async transfer(@Payload() data: TransferDto & { lang?: string }) {
    try {
      // ✅ S'assurer que initiatedBy est présent
      if (!data.initiatedBy) {
        throw new RpcException({
          status: 'error',
          message: 'User not authenticated',
          statusCode: 401,
        });
      }

      // Appeler le service
      const result = await this.transactionService.transfer({
        senderAccountId: data.senderAccountId,
        receiverAccountId: data.receiverAccountId,
        receiverName: data.receiverName,
        receiverPhone: data.receiverPhone,
        receiverEmail: data.receiverEmail,
        amount: data.amount,
        fees: data.fees,
        description: data.description,
        currency: data.currency,
        type: data.type,
        platform: data.platform,
        initiatedBy: data.initiatedBy, // ✅ Maintenant défini
        lang: data.lang || 'fr',
      });

      return {
        success: true,
        message: result.message || 'Transfert effectué avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] Transfer error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Transfer failed',
        statusCode: error.statusCode || 500,
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
      if (!data.accountId) {
        throw new RpcException({
          status: 'error',
          message: 'Account ID is required',
          statusCode: 400,
        });
      }

      const startDate = data.startDate ? new Date(data.startDate) : undefined;
      const endDate = data.endDate ? new Date(data.endDate) : undefined;

      const result = await this.transactionService.getAccountStatement(
        data.accountId,
        {
          startDate,
          endDate,
          page: data.page || 1,
          limit: data.limit || 50,
          type: data.type,
          status: data.status,
          lang: data.lang || 'fr',
        }
      );

      return {
        success: true,
        message: result.message || 'Relevé de compte récupéré avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] getAccountStatement error:', error);
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
      if (!data.accountId) {
        throw new RpcException({
          status: 'error',
          message: 'Account ID is required',
          statusCode: 400,
        });
      }

      const result = await this.transactionService.getTransactionsByAccount(
        data.accountId,
        {
          page: data.page || 1,
          limit: data.limit || 10,
          type: data.type,
          status: data.status,
          lang: data.lang || 'fr',
        }
      );

      return {
        success: true,
        message: result.message || 'Liste des transactions récupérée avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] getTransactionsByAccount error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get transactions',
        statusCode: 500,
      });
    }
  }

  // Dans TransactionServiceController
  @MessagePattern('transaction.getByUserId')
  async getTransactionsByUserId(@Payload() data: {
    userId: string;
    page?: number;
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    lang?: string;
  }) {
    try {
      console.log('[Controller] getTransactionsByUserId received:', data);

      if (!data.userId) {
        throw new RpcException({
          status: 'error',
          message: 'User ID is required',
          statusCode: 400,
        });
      }

      const result = await this.transactionService.getTransactionsByUserId(
        data.userId,
        {
          page: data.page || 1,
          limit: data.limit || 10,
          type: data.type,
          status: data.status,
          lang: data.lang || 'fr',
        }
      );

      console.log('[Controller] getTransactionsByUserId result:', result);

      return {
        success: true,
        message: result.message || 'Liste des transactions récupérée avec succès',
        data: result.data,
      };
    } catch (error) {
      console.error('[Controller] getTransactionsByUserId error:', error);
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
      if (!data.userId) {
        throw new RpcException({
          status: 'error',
          message: 'User ID is required',
          statusCode: 400,
        });
      }

      const result = await this.transactionService.getTransfersByUser(
        data.userId,
        {
          page: data.page || 1,
          limit: data.limit || 10,
          lang: data.lang || 'fr',
        }
      );

      return {
        success: true,
        message: result.message || 'Liste des transferts récupérée avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] getTransfersByUser error:', error);
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

  // ==================== BÉNÉFICIAIRES ====================
  @MessagePattern('transaction.listBeneficiaries')
  async listBeneficiaries(@Payload() data: {
    userId: string;
    page?: number;
    limit?: number;
    search?: string;
    isFavorite?: boolean;
    lang?: string;
  }) {
    try {
      // Vérifier que userId est présent
      if (!data.userId) {
        throw new RpcException({
          status: 'error',
          message: 'User ID is required',
          statusCode: 400,
        });
      }

      // Appeler le service
      const result = await this.transactionService.listBeneficiaries({
        userId: data.userId,
        page: data.page || 1,
        limit: data.limit || 10,
        search: data.search,
        isFavorite: data.isFavorite,
        lang: data.lang || 'fr',
      });

      return {
        success: true,
        message: result.message || 'Liste des bénéficiaires récupérée avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] listBeneficiaries error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to list beneficiaries',
        statusCode: error.statusCode || 500,
      });
    }
  }

  @MessagePattern('transaction.getBeneficiaryById')
  async getBeneficiaryById(@Payload() data: {
    id: string;
    userId: string;
    lang?: string;
  }) {
    try {
      if (!data.id) {
        throw new RpcException({
          status: 'error',
          message: 'Beneficiary ID is required',
          statusCode: 400,
        });
      }

      if (!data.userId) {
        throw new RpcException({
          status: 'error',
          message: 'User ID is required',
          statusCode: 400,
        });
      }

      return await this.transactionService.getBeneficiaryById(
        data.id,
        data.userId,
        data.lang || 'fr'
      );
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get beneficiary',
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