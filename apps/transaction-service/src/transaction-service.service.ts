// apps/transaction-service/src/transaction-service.service.ts
/* eslint-disable prettier/prettier */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { PrismaService } from '../prisma/prisma.service';
import {
  transactions_type,
  transactions_status,
  transfers_status,
  transfers_type,
  transfers_platform
} from '@prisma/client';
import * as crypto from 'crypto';
import { Decimal } from '@prisma/client/runtime/library';
import { I18nService } from '../../../libs/common/src/i18n/i18n.service';
import { NotificationHelper } from 'apps/notification-service/src/helpers/NotificationHelper';
import { NotificationType } from 'apps/notification-service/src/type/notification-type';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';

@Injectable()
export class TransactionServiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i18nService: I18nService,
    private readonly notificationHelper: NotificationHelper,
    private readonly smsService: SmsService,
  ) { }

  // ========================= UTILITAIRES =========================

  private generateTransactionReference(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `TRX-${timestamp}-${random}`;
  }

  private generateTransferReference(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `TRF-${timestamp}-${random}`;
  }

  private async logAudit(
    userId: string | null,
    action: string,
    details: any,
    entity: string,
    entityId: string | null = null,
  ) {
    try {
      await this.prisma.auditLog.create({
        data: {
          userId: userId || undefined,
          action,
          message: details ? JSON.stringify(details) : null,
          entity,
          entityId: entityId || undefined,
          level: 'INFO',
        },
      });
    } catch (err) {
      console.error('Audit log failed:', err);
    }
  }

  private async shouldSendSms(userId: string): Promise<boolean> {
    const settings = await this.prisma.user_settings.findUnique({
      where: { user_id: userId },
      select: { sms_notifications: true },
    });
    return settings?.sms_notifications ?? true;
  }

  private async shouldSendPush(userId: string): Promise<boolean> {
    const settings = await this.prisma.user_settings.findUnique({
      where: { user_id: userId },
      select: { push_notifications: true },
    });
    return settings?.push_notifications ?? true;
  }

  private async getUserLanguage(userId: string): Promise<string> {
    const settings = await this.prisma.user_settings.findUnique({
      where: { user_id: userId },
      select: { language: true },
    });
    return settings?.language ?? 'fr';
  }

  // ========================= CRÉATION DE TRANSACTION =========================
  async createTransaction(data: {
    accountId: string;
    type: transactions_type;
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    description?: string;
    reference?: string;
    status?: transactions_status;
    transferId?: string;
  }) {
    const reference = data.reference || this.generateTransactionReference();

    const transferId = data.transferId || `TEMP-${crypto.randomUUID()}`;

    return this.prisma.transaction.create({
      data: {
        id: crypto.randomUUID(),
        accountId: data.accountId,
        type: data.type,
        amount: new Decimal(data.amount),
        balanceBefore: new Decimal(data.balanceBefore),
        balanceAfter: new Decimal(data.balanceAfter),
        reference: reference,
        description: data.description,
        status: data.status || transactions_status.COMPLETED,
        transferId: transferId,
      },
    });
  }

  // ========================= TRANSFERT =========================

  async transfer(data: {
    senderAccountId: string;
    receiverAccountId: string;
    receiverName: string;
    receiverPhone?: string;
    receiverEmail?: string;
    amount: number;
    fees?: number;
    description?: string;
    currency?: string;
    type?: transfers_type;
    initiatedBy: string;
    platform?: transfers_platform;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';

    try {
      // 1. Vérifier que les comptes existent
      const senderAccount = await this.prisma.account.findUnique({
        where: { id: data.senderAccountId },
        include: { clients: true },
      });

      if (!senderAccount) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_sender_account_not_found', lang),
          statusCode: 404,
        });
      }

      if (senderAccount.status !== 'ACTIVE') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_sender_account_inactive', lang),
          statusCode: 403,
        });
      }

      const receiverAccount = await this.prisma.account.findUnique({
        where: { id: data.receiverAccountId },
        include: { clients: true },
      });

      if (!receiverAccount) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_receiver_account_not_found', lang),
          statusCode: 404,
        });
      }

      if (receiverAccount.status !== 'ACTIVE') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_receiver_account_inactive', lang),
          statusCode: 403,
        });
      }

      // 2. Vérifier le solde de l'émetteur
      const senderBalance = senderAccount.balance?.toNumber() || 0;
      const totalAmount = data.amount + (data.fees || 0);

      if (senderBalance < totalAmount) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_insufficient_balance', lang),
          statusCode: 400,
        });
      }

      // 3. Générer la référence
      const reference = this.generateTransferReference();

      // 4. Créer le transfert
      const transfer = await this.prisma.transfer.create({
        data: {
          id: crypto.randomUUID(),
          reference,
          senderAccountId: data.senderAccountId,
          receiverAccountId: data.receiverAccountId,
          receiverName: data.receiverName,
          receiverPhone: data.receiverPhone,
          receiverEmail: data.receiverEmail,
          amount: new Decimal(data.amount),
          fees: data.fees ? new Decimal(data.fees) : new Decimal(0),
          totalAmount: new Decimal(totalAmount),
          currency: data.currency || 'XAF',
          platform: data.platform || transfers_platform.WEB,
          type: data.type || transfers_type.INTERNAL,
          status: transfers_status.PENDING,
          description: data.description,
          initiatedBy: data.initiatedBy,
        },
      });

      // 5. Traiter le transfert (débit crédit)
      const newSenderBalance = senderBalance - totalAmount;
      const receiverBalance = receiverAccount.balance?.toNumber() || 0;
      const newReceiverBalance = receiverBalance + data.amount;

      // 6. Mettre à jour les comptes
      const [senderTx, receiverTx] = await this.prisma.$transaction([
        this.prisma.account.update({
          where: { id: data.senderAccountId },
          data: {
            balance: new Decimal(newSenderBalance),
            updatedAt: new Date(),
          },
        }),
        this.prisma.account.update({
          where: { id: data.receiverAccountId },
          data: {
            balance: new Decimal(newReceiverBalance),
            updatedAt: new Date(),
          },
        }),
        // Créer la transaction pour l'émetteur (débit)
        this.prisma.transaction.create({
          data: {
            id: crypto.randomUUID(),
            accountId: data.senderAccountId,
            transferId: transfer.id,
            type: transactions_type.TRANSFER,
            amount: new Decimal(totalAmount),
            balanceBefore: new Decimal(senderBalance),
            balanceAfter: new Decimal(newSenderBalance),
            reference: `DEBIT-${reference}`,
            description: `Transfer to ${data.receiverName}`,
            status: transactions_status.COMPLETED,
          },
        }),
        // Créer la transaction pour le destinataire (crédit)
        this.prisma.transaction.create({
          data: {
            id: crypto.randomUUID(),
            accountId: data.receiverAccountId,
            transferId: transfer.id,
            type: transactions_type.TRANSFER,
            amount: new Decimal(data.amount),
            balanceBefore: new Decimal(receiverBalance),
            balanceAfter: new Decimal(newReceiverBalance),
            reference: `CREDIT-${reference}`,
            description: `Transfer from ${senderAccount.clients?.fullName || 'Unknown'}`,
            status: transactions_status.COMPLETED,
          },
        }),
        // Mettre à jour le statut du transfert
        this.prisma.transfer.update({
          where: { id: transfer.id },
          data: {
            status: transfers_status.COMPLETED,
            completedAt: new Date(),
          },
        }),
      ]);

      // 7. Audit
      await this.logAudit(
        data.initiatedBy,
        'TRANSFER',
        {
          from: data.senderAccountId,
          to: data.receiverAccountId,
          amount: data.amount,
          fees: data.fees || 0,
          reference,
        },
        'TRANSFER',
        transfer.id,
      );

      // 8. Récupérer le transfert complet
      const completedTransfer = await this.prisma.transfer.findUnique({
        where: { id: transfer.id },
        include: {
          senderAccount: {
            include: {
              clients: true,
            },
          },
          receiverAccount: {
            include: {
              clients: true,
            },
          },
          senderUser: true,
          transaction: true,
        },
      });

      // 9. Notifications
      try {
        // Notification pour l'émetteur
        const senderLang = await this.getUserLanguage(data.initiatedBy);
        await this.notificationHelper.notify(
          data.initiatedBy,
          NotificationType.TRANSFER_SENT,
          {
            amount: data.amount,
            fees: data.fees || 0,
            receiverName: data.receiverName,
            reference: reference,
            currency: data.currency || 'XAF',
          },
          'TRANSFER',
          transfer.id,
          senderLang,
        );

        // Notification pour le destinataire (si c'est un utilisateur)
        if (receiverAccount.clients?.clientId) {
          const receiverUser = await this.prisma.user.findFirst({
            where: { clientId: receiverAccount.clients.clientId },
          });
          if (receiverUser) {
            const receiverLang = await this.getUserLanguage(receiverUser.id);
            await this.notificationHelper.notify(
              receiverUser.id,
              NotificationType.TRANSFER_RECEIVED,
              {
                amount: data.amount,
                senderName: senderAccount.clients?.fullName || 'Unknown',
                reference: reference,
                currency: data.currency || 'XAF',
              },
              'TRANSFER',
              transfer.id,
              receiverLang,
            );
          }
        }

        // SMS pour l'émetteur
        const senderSmsEnabled = await this.shouldSendSms(data.initiatedBy);
        if (senderSmsEnabled) {
          const senderUser = await this.prisma.user.findUnique({
            where: { id: data.initiatedBy },
            select: { phone: true, firstName: true, lastName: true },
          });
          if (senderUser?.phone) {
            const smsText = this.i18nService.translate('transfer_sender_sms', senderLang, {
              full_name: `${senderUser.firstName} ${senderUser.lastName}`,
              amount: data.amount,
              receiverName: data.receiverName,
              reference: reference,
            });
            await this.smsService.sendSms(senderUser.phone, smsText);
          }
        }
      } catch (notifError) {
        console.error('[Notifications] Transfer notification error:', notifError);
      }

      return {
        success: true,
        message: this.i18nService.translate('transfer_success', lang),
        data: completedTransfer,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('transfer_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= DÉPÔT =========================

  async deposit(data: {
    accountId: string;
    amount: number;
    description?: string;
    reference?: string;
    initiatedBy?: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';

    try {
      const account = await this.prisma.account.findUnique({
        where: { id: data.accountId },
        include: { clients: true },
      });

      if (!account) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('deposit_account_not_found', lang),
          statusCode: 404,
        });
      }

      if (account.status !== 'ACTIVE') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('deposit_account_inactive', lang),
          statusCode: 403,
        });
      }

      const currentBalance = account.balance?.toNumber() || 0;
      const newBalance = currentBalance + data.amount;

      await this.prisma.account.update({
        where: { id: data.accountId },
        data: {
          balance: new Decimal(newBalance),
          updatedAt: new Date(),
        },
      });

      const transaction = await this.createTransaction({
        accountId: data.accountId,
        type: transactions_type.DEPOSIT,
        amount: data.amount,
        balanceBefore: currentBalance,
        balanceAfter: newBalance,
        description: data.description || `Deposit of ${data.amount}`,
        reference: data.reference,
        status: transactions_status.COMPLETED,
      });

      await this.logAudit(
        data.initiatedBy || null,
        'DEPOSIT',
        { accountId: data.accountId, amount: data.amount, newBalance },
        'ACCOUNT',
        data.accountId,
      );

      // Notifications
      try {
        if (data.initiatedBy) {
          const userLang = await this.getUserLanguage(data.initiatedBy);
          await this.notificationHelper.notify(
            data.initiatedBy,
            NotificationType.DEPOSIT_SUCCESS,
            {
              amount: data.amount,
              accountId: data.accountId,
              newBalance: newBalance,
              currency: account.currency || 'XAF',
            },
            'TRANSACTION',
            transaction.id,
            userLang,
          );

          // SMS
          const smsEnabled = await this.shouldSendSms(data.initiatedBy);
          if (smsEnabled) {
            const user = await this.prisma.user.findUnique({
              where: { id: data.initiatedBy },
              select: { phone: true, firstName: true, lastName: true },
            });
            if (user?.phone) {
              const smsText = this.i18nService.translate('deposit_sms', userLang, {
                full_name: `${user.firstName} ${user.lastName}`,
                amount: data.amount,
                newBalance: newBalance,
              });
              await this.smsService.sendSms(user.phone, smsText);
            }
          }
        }
      } catch (notifError) {
        console.error('[Notifications] Deposit notification error:', notifError);
      }

      return {
        success: true,
        message: this.i18nService.translate('deposit_success', lang),
        data: transaction,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('deposit_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= RETRAIT =========================

  async withdraw(data: {
    accountId: string;
    amount: number;
    description?: string;
    initiatedBy?: string;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';

    try {
      const account = await this.prisma.account.findUnique({
        where: { id: data.accountId },
        include: { clients: true },
      });

      if (!account) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('withdraw_account_not_found', lang),
          statusCode: 404,
        });
      }

      if (account.status !== 'ACTIVE') {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('withdraw_account_inactive', lang),
          statusCode: 403,
        });
      }

      const currentBalance = account.balance?.toNumber() || 0;
      if (currentBalance < data.amount) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('withdraw_insufficient_balance', lang),
          statusCode: 400,
        });
      }

      const newBalance = currentBalance - data.amount;

      await this.prisma.account.update({
        where: { id: data.accountId },
        data: {
          balance: new Decimal(newBalance),
          updatedAt: new Date(),
        },
      });

      const transaction = await this.createTransaction({
        accountId: data.accountId,
        type: transactions_type.WITHDRAWAL,
        amount: data.amount,
        balanceBefore: currentBalance,
        balanceAfter: newBalance,
        description: data.description || `Withdrawal of ${data.amount}`,
        status: transactions_status.COMPLETED,
      });

      await this.logAudit(
        data.initiatedBy || null,
        'WITHDRAWAL',
        { accountId: data.accountId, amount: data.amount, newBalance },
        'ACCOUNT',
        data.accountId,
      );

      // Notifications
      try {
        if (data.initiatedBy) {
          const userLang = await this.getUserLanguage(data.initiatedBy);
          await this.notificationHelper.notify(
            data.initiatedBy,
            NotificationType.CASHOUT_SUCCESS,
            {
              amount: data.amount,
              accountId: data.accountId,
              newBalance: newBalance,
              currency: account.currency || 'XAF',
            },
            'TRANSACTION',
            transaction.id,
            userLang,
          );

          // SMS
          const smsEnabled = await this.shouldSendSms(data.initiatedBy);
          if (smsEnabled) {
            const user = await this.prisma.user.findUnique({
              where: { id: data.initiatedBy },
              select: { phone: true, firstName: true, lastName: true },
            });
            if (user?.phone) {
              const smsText = this.i18nService.translate('withdraw_sms', userLang, {
                full_name: `${user.firstName} ${user.lastName}`,
                amount: data.amount,
                newBalance: newBalance,
              });
              await this.smsService.sendSms(user.phone, smsText);
            }
          }
        }
      } catch (notifError) {
        console.error('[Notifications] Withdraw notification error:', notifError);
      }

      return {
        success: true,
        message: this.i18nService.translate('withdraw_success', lang),
        data: transaction,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('withdraw_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= RELEVÉ DE COMPTE (STATEMENT) =========================

  async getAccountStatement(accountId: string, params?: {
    startDate?: Date;
    endDate?: Date;
    page?: number;
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    lang?: string;
  }) {
    const lang = params?.lang || 'fr';
    const page = params?.page || 1;
    const limit = params?.limit || 50;
    const skip = (page - 1) * limit;

    const where: any = { accountId };

    if (params?.startDate) {
      where.createdAt = { ...where.createdAt, gte: params.startDate };
    }
    if (params?.endDate) {
      where.createdAt = { ...where.createdAt, lte: params.endDate };
    }
    if (params?.type) {
      where.type = params.type;
    }
    if (params?.status) {
      where.status = params.status;
    }

    const [account, transactions, total] = await Promise.all([
      this.prisma.account.findUnique({
        where: { id: accountId },
        include: { clients: true },
      }),
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          account: {
            include: {
              clients: true,
            },
          },
          transfer: {
            include: {
              senderAccount: {
                include: {
                  clients: true,
                },
              },
              receiverAccount: {
                include: {
                  clients: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    if (!account) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('statement_not_found', lang),
        statusCode: 404,
      });
    }

    // Calcul des totaux
    const totalDebit = transactions
      .filter(t => t.type === transactions_type.WITHDRAWAL || t.type === transactions_type.TRANSFER)
      .reduce((sum, t) => sum + t.amount.toNumber(), 0);

    const totalCredit = transactions
      .filter(t => t.type === transactions_type.DEPOSIT)
      .reduce((sum, t) => sum + t.amount.toNumber(), 0);

    return {
      account: {
        id: account.id,
        clientId: account.clientId,
        clientName: account.clients?.fullName || 'Unknown',
        balance: account.balance?.toNumber() || 0,
        currency: account.currency,
      },
      statement: {
        transactions,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        summary: {
          totalTransactions: total,
          totalDebit,
          totalCredit,
          netChange: totalCredit - totalDebit,
          startDate: params?.startDate || null,
          endDate: params?.endDate || null,
        },
      },
    };
  }

  // ========================= RÉCUPÉRATION DES TRANSACTIONS =========================

  async getTransactionById(id: string, lang: string = 'fr') {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        account: {
          include: {
            clients: true,
          },
        },
        transfer: {
          include: {
            senderAccount: {
              include: {
                clients: true,
              },
            },
            receiverAccount: {
              include: {
                clients: true,
              },
            },
          },
        },
      },
    });

    if (!transaction) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('transaction_not_found', lang),
        statusCode: 404,
      });
    }

    return transaction;
  }

  async getTransactionsByAccount(accountId: string, params?: {
    page?: number;
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    lang?: string;
  }) {
    const lang = params?.lang || 'fr';
    const page = params?.page || 1;
    const limit = params?.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = { accountId };
    if (params?.type) where.type = params.type;
    if (params?.status) where.status = params.status;

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          account: {
            include: {
              clients: true,
            },
          },
          transfer: {
            include: {
              senderAccount: {
                include: {
                  clients: true,
                },
              },
              receiverAccount: {
                include: {
                  clients: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      data: transactions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getTransactionsByClient(clientId: string, params?: {
    page?: number;
    limit?: number;
    type?: transactions_type;
    status?: transactions_status;
    lang?: string;
  }) {
    const lang = params?.lang || 'fr';
    const accounts = await this.prisma.account.findMany({
      where: { clientId },
      select: { id: true },
    });

    const accountIds = accounts.map(a => a.id);

    const page = params?.page || 1;
    const limit = params?.limit || 10;
    const skip = (page - 1) * limit;

    const where: any = { accountId: { in: accountIds } };
    if (params?.type) where.type = params.type;
    if (params?.status) where.status = params.status;

    const [transactions, total] = await Promise.all([
      this.prisma.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          account: {
            include: {
              clients: true,
            },
          },
          transfer: {
            include: {
              senderAccount: {
                include: {
                  clients: true,
                },
              },
              receiverAccount: {
                include: {
                  clients: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.transaction.count({ where }),
    ]);

    return {
      data: transactions,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ========================= RÉCUPÉRATION DES TRANSFERTS =========================

  async getTransferById(id: string, lang: string = 'fr') {
    const transfer = await this.prisma.transfer.findUnique({
      where: { id },
      include: {
        senderAccount: {
          include: {
            clients: true,
          },
        },
        receiverAccount: {
          include: {
            clients: true,
          },
        },
        senderUser: true,
        transaction: true,
        notifications: true,
      },
    });

    if (!transfer) {
      throw new RpcException({
        status: 'error',
        message: this.i18nService.translate('transfer_not_found', lang),
        statusCode: 404,
      });
    }

    return transfer;
  }

  async getTransfersByAccount(accountId: string, params?: { page?: number; limit?: number; lang?: string }) {
    const lang = params?.lang || 'fr';
    const page = params?.page || 1;
    const limit = params?.limit || 10;
    const skip = (page - 1) * limit;

    const [transfers, total] = await Promise.all([
      this.prisma.transfer.findMany({
        where: {
          OR: [
            { senderAccountId: accountId },
            { receiverAccountId: accountId },
          ],
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          senderAccount: {
            include: {
              clients: true,
            },
          },
          receiverAccount: {
            include: {
              clients: true,
            },
          },
          senderUser: true,
          transaction: true,
        },
      }),
      this.prisma.transfer.count({
        where: {
          OR: [
            { senderAccountId: accountId },
            { receiverAccountId: accountId },
          ],
        },
      }),
    ]);

    return {
      data: transfers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getTransfersByUser(userId: string, params?: { page?: number; limit?: number; lang?: string }) {
    const lang = params?.lang || 'fr';
    const page = params?.page || 1;
    const limit = params?.limit || 10;
    const skip = (page - 1) * limit;

    const [transfers, total] = await Promise.all([
      this.prisma.transfer.findMany({
        where: { initiatedBy: userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          senderAccount: {
            include: {
              clients: true,
            },
          },
          receiverAccount: {
            include: {
              clients: true,
            },
          },
          senderUser: true,
          transaction: true,
        },
      }),
      this.prisma.transfer.count({ where: { initiatedBy: userId } }),
    ]);

    return {
      data: transfers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  // ========================= STATISTIQUES =========================

  async getTransactionStats(userId: string, days: number = 30, lang: string = 'fr') {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const accounts = await this.prisma.account.findMany({
      where: { clientId: userId },
      select: { id: true },
    });

    const accountIds = accounts.map(a => a.id);

    const [totalTransactions, totalAmount, byType, recent] = await Promise.all([
      this.prisma.transaction.count({
        where: {
          accountId: { in: accountIds },
          createdAt: { gte: startDate },
        },
      }),
      this.prisma.transaction.aggregate({
        where: {
          accountId: { in: accountIds },
          createdAt: { gte: startDate },
        },
        _sum: {
          amount: true,
        },
      }),
      this.prisma.transaction.groupBy({
        by: ['type'],
        where: {
          accountId: { in: accountIds },
          createdAt: { gte: startDate },
        },
        _count: true,
        _sum: {
          amount: true,
        },
      }),
      this.prisma.transaction.findMany({
        where: {
          accountId: { in: accountIds },
          createdAt: { gte: startDate },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          account: {
            include: {
              clients: true,
            },
          },
          transfer: {
            include: {
              senderAccount: {
                include: {
                  clients: true,
                },
              },
              receiverAccount: {
                include: {
                  clients: true,
                },
              },
            },
          },
        },
      }),
    ]);

    return {
      period: `${days} ${this.i18nService.translate('stats_period', lang)}`,
      totalTransactions,
      totalAmount: totalAmount._sum.amount?.toNumber() || 0,
      byType: byType.map(item => ({
        type: this.i18nService.translate(`transaction_type_${item.type}`, lang),
        count: item._count,
        amount: item._sum.amount?.toNumber() || 0,
      })),
      recent,
    };
  }

  // ========================= HEALTH CHECK =========================

  async healthCheck() {
    return { status: 'ok', service: 'transaction-service' };
  }
}