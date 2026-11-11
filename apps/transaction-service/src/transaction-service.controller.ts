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
import { transactions_status, transactions_type, transfers_platform, transfers_type } from '@prisma/client';

@Controller()
export class TransactionServiceController {
  constructor(private readonly transactionService: TransactionServiceService) { }

  // ==================== TRANSFERT ====================
  @MessagePattern('transaction.transfer')
  async transfer(@Payload() data: {
    senderAccountNumber: string;
    receiverAccountNumber: string;
    receiverName?: string;
    receiverPhone?: string;
    receiverEmail?: string;
    amount: number;
    fees?: number;
    description?: string;
    currency?: 'USD' | 'CDF';
    platform?: 'Mobile' | 'Online';
    initiatedBy: string;
    lang?: string;
    saveBeneficiary?: boolean;
    otpCode?: string;                     // ✅ Seule protection du transfert (plus de PIN)
    forceNewOtp?: boolean;
    client?: string;
    channel?: string;                     // MOBILE (Mobile Banking) / WEB (Net Banking)
  }) {
    try {
      if (!data.initiatedBy) {
        throw new RpcException({
          status: 'error',
          message: 'User not authenticated',
          statusCode: 401,
        });
      }

      const result = await this.transactionService.transfer({
        senderAccountNumber: data.senderAccountNumber,
        receiverAccountNumber: data.receiverAccountNumber,
        receiverName: data.receiverName,
        receiverPhone: data.receiverPhone,
        receiverEmail: data.receiverEmail,
        amount: data.amount,
        fees: data.fees,
        description: data.description,
        currency: data.currency,
        platform: data.platform || 'Mobile',
        initiatedBy: data.initiatedBy,
        lang: data.lang || 'fr',
        saveBeneficiary: data.saveBeneficiary,
        otpCode: data.otpCode,             // ✅ AJOUT
        forceNewOtp: data.forceNewOtp,     // route /transactions/transfer/request-otp
        client: data.client,
        channel: data.channel,
      });

      // Étape 1 : OTP envoyé → on le signale clairement au front
      if ((result as any)?.requiresOtp) {
        return {
          success: true,
          requiresOtp: true,
          message: result.message,
          phone: (result as any).phone ?? null,
          expiresIn: (result as any).expiresIn ?? null,
          data: null,
        };
      }

      return {
        success: true,
        message: result.message || 'Transfert effectué avec succès',
        data: (result as any).data,
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

  // ==================== DÉPÔT ====================
  @MessagePattern('transaction.deposit')
  async deposit(@Payload() data: {
    accountNumber: string;              // ← accountNumber (banque)
    amount: number;
    currency?: 'USD' | 'CDF';           // ← ajouté
    description?: string;
    initiatedBy?: string;
    lang?: string;
    platform?: 'Mobile' | 'Online';     // ← ajouté
    channel?: string;                   // MOBILE (Mobile Banking) / WEB (Net Banking)
  }) {
    try {
      if (!data.accountNumber) {
        throw new RpcException({
          status: 'error',
          message: 'Account number is required',
          statusCode: 400,
        });
      }
      if (!data.amount || data.amount <= 0) {
        throw new RpcException({
          status: 'error',
          message: 'Amount must be greater than zero',
          statusCode: 400,
        });
      }

      return await this.transactionService.deposit({
        accountNumber: data.accountNumber,
        amount: data.amount,
        currency: data.currency,
        description: data.description,
        initiatedBy: data.initiatedBy,
        lang: data.lang || 'fr',
        platform: data.platform || 'Mobile',
        channel: data.channel,
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] Deposit error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Deposit failed',
        statusCode: error.statusCode || 500,
      });
    }
  }

  // ==================== RETRAIT ====================
  @MessagePattern('transaction.withdraw')
  async withdraw(@Payload() data: {
    accountNumber: string;              // ← accountNumber (banque)
    amount: number;
    currency?: 'USD' | 'CDF';           // ← ajouté
    description?: string;
    initiatedBy?: string;
    lang?: string;
    platform?: 'Mobile' | 'Online';     // ← ajouté
    channel?: string;                   // MOBILE (Mobile Banking) / WEB (Net Banking)
  }) {
    try {
      if (!data.accountNumber) {
        throw new RpcException({
          status: 'error',
          message: 'Account number is required',
          statusCode: 400,
        });
      }
      if (!data.amount || data.amount <= 0) {
        throw new RpcException({
          status: 'error',
          message: 'Amount must be greater than zero',
          statusCode: 400,
        });
      }

      return await this.transactionService.withdraw({
        accountNumber: data.accountNumber,
        amount: data.amount,
        currency: data.currency,
        description: data.description,
        initiatedBy: data.initiatedBy,
        lang: data.lang || 'fr',
        platform: data.platform || 'Mobile',
        channel: data.channel,
      });
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] Withdraw error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Withdrawal failed',
        statusCode: error.statusCode || 500,
      });
    }
  }

  // ==================== RELEVÉ DE COMPTE ====================@MessagePattern('transaction.getStatement')
  // ==================== RELEVÉ DE COMPTE ====================
  @MessagePattern('transaction.getStatement')
  async getAccountStatement(@Payload() data: {
    accountNumber: string;
    userId?: string;
    startDate?: string;                 // ← 'yyyy-MM-dd'
    endDate?: string;                   // ← 'yyyy-MM-dd'
    page?: number;
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    movement?: 'CREDIT' | 'DEBIT';      // ← ajouté (filtre banque)
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

      const result = await this.transactionService.getAccountStatement(
        data.accountNumber,
        {
          startDate: data.startDate,
          endDate: data.endDate,
          page: data.page || 1,
          limit: data.limit || 50,
          type: data.type,
          status: data.status,
          movement: data.movement,
          lang: data.lang || 'fr',
          userId: data.userId,
        },
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
        statusCode: error.statusCode || 500,
      });
    }
  }
  // ==================== TRANSACTIONS ====================

  @MessagePattern('transaction.getById')
  async getTransactionById(@Payload() data: { id: string; userId?: string; lang?: string }) {
    try {
      return await this.transactionService.getTransactionById(data.id, data.lang, data.userId);
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
    accountNumber: string;
    userId?: string;
    page?: number;
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    movement?: 'CREDIT' | 'DEBIT';      // ← ajouté
    startDate?: string;                 // ← ajouté
    endDate?: string;                   // ← ajouté
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

      const result = await this.transactionService.getTransactionsByAccount(
        data.accountNumber,
        {
          page: data.page || 1,
          limit: data.limit || 10,
          type: data.type,
          status: data.status,
          movement: data.movement,
          startDate: data.startDate,
          endDate: data.endDate,
          lang: data.lang || 'fr',
          userId: data.userId,
        },
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
        statusCode: error.statusCode || 500,
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
    movement?: 'CREDIT' | 'DEBIT';      // ← ajouté
    startDate?: string;                 // ← ajouté
    endDate?: string;                   // ← ajouté
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

      const result = await this.transactionService.getTransactionsByUserId(
        data.userId,
        {
          page: data.page || 1,
          limit: data.limit || 10,
          type: data.type,
          status: data.status,
          movement: data.movement,
          startDate: data.startDate,
          endDate: data.endDate,
          lang: data.lang || 'fr',
        },
      );

      return {
        success: true,
        message: result.message || 'Liste des transactions récupérée avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] getTransactionsByUserId error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get transactions',
        statusCode: error.statusCode || 500,
      });
    }
  }
  // ==================== TRANSFERTS ====================

  @MessagePattern('transaction.getTransferById')
  async getTransferById(@Payload() data: { id: string; userId?: string; lang?: string }) {
    try {
      return await this.transactionService.getTransferById(data.id, data.lang, data.userId);
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
    accountNumber: string;              // ← accountNumber (était accountId)
    userId?: string;
    page?: number;
    limit?: number;
    status?: string;                    // ← ajouté
    startDate?: string;                 // ← ajouté
    endDate?: string;                   // ← ajouté
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

      return await this.transactionService.getTransfersByAccount(
        data.accountNumber,
        {
          page: data.page,
          limit: data.limit,
          status: data.status,
          startDate: data.startDate,
          endDate: data.endDate,
          lang: data.lang,
          userId: data.userId,
        },
      );
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] getTransfersByAccount error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get transfers',
        statusCode: error.statusCode || 500,
      });
    }
  }

  @MessagePattern('transaction.getTransfersByUser')
  async getTransfersByUser(@Payload() data: {
    userId: string;
    page?: number;
    limit?: number;
    status?: string;                    // ← ajouté
    startDate?: string;                 // ← ajouté
    endDate?: string;                   // ← ajouté
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
          status: data.status,
          startDate: data.startDate,
          endDate: data.endDate,
          lang: data.lang || 'fr',
        },
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
        statusCode: error.statusCode || 500,
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


  // apps/transaction-service/src/transaction-service.controller.ts

  // ==================== BÉNÉFICIAIRES ====================

  // 1. CRÉER UN BÉNÉFICIAIRE
  @MessagePattern('transaction.createBeneficiary')
  async createBeneficiary(@Payload() data: {
    userId: string;
    accountNumber: string;
    accountName: string;
    bankName?: string;
    phone?: string;
    email?: string;
    nickname?: string;
    isFavorite?: boolean;
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

      if (!data.accountNumber) {
        throw new RpcException({
          status: 'error',
          message: 'Account number is required',
          statusCode: 400,
        });
      }

      if (!data.accountName) {
        throw new RpcException({
          status: 'error',
          message: 'Account name is required',
          statusCode: 400,
        });
      }

      const result = await this.transactionService.createBeneficiary(data);
      return {
        success: true,
        message: result.message || 'Bénéficiaire créé avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] createBeneficiary error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to create beneficiary',
        statusCode: 500,
      });
    }
  }

  // 4. METTRE À JOUR UN BÉNÉFICIAIRE
  @MessagePattern('transaction.updateBeneficiary')
  async updateBeneficiary(@Payload() data: {
    id: string;
    userId: string;
    accountName?: string;
    bankName?: string;
    phone?: string;
    email?: string;
    nickname?: string;
    isFavorite?: boolean;
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

      const result = await this.transactionService.updateBeneficiary(data);
      return {
        success: true,
        message: result.message || 'Bénéficiaire mis à jour avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] updateBeneficiary error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to update beneficiary',
        statusCode: 500,
      });
    }
  }

  // 5. SUPPRIMER UN BÉNÉFICIAIRE
  @MessagePattern('transaction.deleteBeneficiary')
  async deleteBeneficiary(@Payload() data: {
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

      const result = await this.transactionService.deleteBeneficiary(data);
      return {
        success: true,
        message: result.message || 'Bénéficiaire supprimé avec succès',
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] deleteBeneficiary error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to delete beneficiary',
        statusCode: 500,
      });
    }
  }

  // 6. AJOUTER/SUPPRIMER DES FAVORIS
  @MessagePattern('transaction.toggleFavorite')
  async toggleFavorite(@Payload() data: {
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

      const result = await this.transactionService.toggleFavorite(data);
      return {
        success: true,
        message: result.message,
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] toggleFavorite error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to toggle favorite',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('transaction.getBalance')
  async getBalance(@Payload() data: {
    accountNumber: string;
    userId: string;
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

      if (!data.userId) {
        throw new RpcException({
          status: 'error',
          message: 'User ID is required',
          statusCode: 400,
        });
      }

      const result = await this.transactionService.getBalance({
        accountNumber: data.accountNumber,
        userId: data.userId,
        lang: data.lang || 'fr',
      });

      return {
        success: true,
        message: result.message || 'Balance récupérée avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[TransactionController] getBalance error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get balance',
        statusCode: 500,
      });
    }
  }

  @MessagePattern('transaction.getAccountById')
  async getAccountById(@Payload() data: {
    accountId: string;
    userId: string;
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

      if (!data.userId) {
        throw new RpcException({
          status: 'error',
          message: 'User ID is required',
          statusCode: 400,
        });
      }

      const result = await this.transactionService.getAccountById(data);
      return {
        success: true,
        message: result.message || 'Compte récupéré avec succès',
        data: result.data,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to get account',
        statusCode: 500,
      });
    }
  }
  // ==================== ADMIN : CLIENTS & COMPTES ====================
  // ⚠️ Réservé aux ADMIN / SUPER_ADMIN (contrôle fait dans l'API gateway)

  private toRpc(error: any, fallback = 500) {
    if (error instanceof RpcException) return error;
    return new RpcException({
      status: 'error',
      message: error?.message || 'Admin operation failed',
      statusCode: error?.statusCode || fallback,
    });
  }

  @MessagePattern('admin.clients.get')
  async adminGetClient(@Payload() data: { clientId: string; lang?: string }) {
    try { return await this.transactionService.adminGetClient(data.clientId, data.lang); }
    catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('admin.accounts.get')
  async adminGetAccount(@Payload() data: { accountNumber: string; lang?: string }) {
    try { return await this.transactionService.adminGetAccount(data.accountNumber, data.lang); }
    catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('admin.accounts.transactions')
  async adminAccountTransactions(@Payload() data: any) {
    try { return await this.transactionService.adminAccountTransactions(data.accountNumber, data); }
    catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('admin.accounts.transactionsCsv')
  async adminAccountTransactionsCsv(@Payload() data: any) {
    try { return await this.transactionService.adminAccountTransactionsCsv(data.accountNumber, data); }
    catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('admin.accounts.statement')
  async adminAccountStatement(@Payload() data: any) {
    try { return await this.transactionService.adminAccountStatement(data.accountNumber, data); }
    catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('admin.users.transactions')
  async adminUserTransactions(@Payload() data: any) {
    try { return await this.transactionService.adminUserTransactions(data.userId, data); }
    catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('admin.users.beneficiaries')
  async adminUserBeneficiaries(@Payload() data: any) {
    try { return await this.transactionService.adminUserBeneficiaries(data); }
    catch (e) { throw this.toRpc(e); }
  }

  @MessagePattern('admin.transactions.get')
  async adminGetTransaction(@Payload() data: { id: string; accountNumber?: string; lang?: string }) {
    try { return await this.transactionService.adminGetTransaction(data.id, data.accountNumber, data.lang); }
    catch (e) { throw this.toRpc(e, 404); }
  }

  // ==================== RELEVÉ PDF ====================

  @MessagePattern('transaction.statementPdf')
  async statementPdf(@Payload() data: {
    accountNumber: string; userId?: string; startDate?: string; endDate?: string;
    lang?: string; sendEmail?: boolean; email?: string;
  }) {
    try { return await this.transactionService.generateStatementPdf(data); }
    catch (e) { throw this.toRpc(e); }
  }

  // ==================== ADMIN : SANTÉ API BANQUE ====================

  @MessagePattern('admin.monitoring.bankHealth')
  async adminBankHealth(@Payload() data: { live?: boolean; lang?: string }) {
    try { return await this.transactionService.adminBankHealth(data || {}); }
    catch (e) { throw this.toRpc(e); }
  }

  // ==================== HEALTH CHECK ====================

  @MessagePattern('transaction.health')
  async healthCheck() {
    return this.transactionService.healthCheck();
  }
}