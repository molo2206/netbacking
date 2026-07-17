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
  transfers_platform,
  transactions_movement,
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

  private async saveBeneficiary(
    userId: string,
    accountNumber: string,
    accountName: string,
    bankName: string | undefined,
    phone: string | undefined,
    email: string | undefined,
    nickname: string
  ) {
    try {
      // Vérifier si le bénéficiaire existe déjà
      const existingBeneficiary = await this.prisma.beneficiary.findUnique({
        where: {
          userId_accountNumber: {
            userId: userId,
            accountNumber: accountNumber,
          },
        },
      });

      if (!existingBeneficiary) {
        // Créer le bénéficiaire
        await this.prisma.beneficiary.create({
          data: {
            id: crypto.randomUUID(),
            userId: userId,
            accountNumber: accountNumber,
            accountName: accountName,
            bankName: bankName || null,
            phone: phone || null,
            email: email || null,
            nickname: nickname || accountName,
            isFavorite: false,
          },
        });
      } else {
        // Mettre à jour les informations du bénéficiaire existant
        await this.prisma.beneficiary.update({
          where: {
            userId_accountNumber: {
              userId: userId,
              accountNumber: accountNumber,
            },
          },
          data: {
            accountName: accountName,
            bankName: bankName || existingBeneficiary.bankName,
            phone: phone || existingBeneficiary.phone,
            email: email || existingBeneficiary.email,
            updatedAt: new Date(),
          },
        });
      }
    } catch (error) {
      console.error('[Save Beneficiary] Error:', error);
      // Ne pas bloquer le transfert si l'enregistrement du bénéficiaire échoue
    }
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
    receiverName?: string;
    receiverPhone?: string;
    receiverEmail?: string;
    amount: number;
    fees?: number;
    description?: string;
    currency?: string;
    type?: transfers_type;
    platform?: transfers_platform;
    initiatedBy: string;
    lang?: string;
    saveBeneficiary?: boolean;
  }) {
    const lang = data.lang || 'fr';
    const shouldSaveBeneficiary = data.saveBeneficiary !== false;

    try {
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

      const currency = data.currency || senderAccount.currency || 'XAF';

      if (senderAccount.currency !== receiverAccount.currency) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_currency_mismatch', lang),
          statusCode: 400,
        });
      }

      const senderBalance = senderAccount.balance?.toNumber() || 0;
      const fees = data.fees || 0;
      const totalAmount = data.amount + fees;

      if (senderBalance < totalAmount) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_insufficient_balance', lang),
          statusCode: 400,
        });
      }

      const reference = this.generateTransferReference();

      let receiverName = data.receiverName || 'Unknown';
      let receiverAccountNumber = receiverAccount.accountNumber ||
        `ACCT-${receiverAccount.id.substring(0, 8)}`;
      let receiverBankName = 'Banque inconnue';
      let receiverPhone = data.receiverPhone || null;
      let receiverEmail = data.receiverEmail || null;

      if (receiverAccount.clients) {
        const client = receiverAccount.clients;

        if (!data.receiverName) {
          receiverName = client.firstName && client.lastName
            ? `${client.firstName} ${client.lastName}`
            : client.firstName || client.lastName || 'Unknown';
        }

        if (!data.receiverPhone && client.phone) {
          receiverPhone = client.phone;
        }

        if (!data.receiverEmail && client.email) {
          receiverEmail = client.email;
        }
      }

      // 1. Créer le transfert
      const transfer = await this.prisma.transfer.create({
        data: {
          id: crypto.randomUUID(),
          reference,
          senderAccountId: data.senderAccountId,
          receiverAccountId: data.receiverAccountId,
          receiverName: receiverName,
          receiverPhone: receiverPhone,
          receiverEmail: receiverEmail,
          amount: new Decimal(data.amount),
          fees: new Decimal(fees),
          totalAmount: new Decimal(totalAmount),
          currency: currency,
          platform: data.platform || transfers_platform.WEB,
          type: data.type || transfers_type.INTERNAL,
          status: transfers_status.PENDING,
          description: data.description,
          initiatedBy: data.initiatedBy,
        },
      });

      const newSenderBalance = senderBalance - totalAmount;
      const receiverBalance = receiverAccount.balance?.toNumber() || 0;
      const newReceiverBalance = receiverBalance + data.amount;

      // 2. Mettre à jour les comptes et créer les transactions avec le même transferId
      await this.prisma.$transaction(async (prisma) => {
        // Mettre à jour le compte expéditeur
        await prisma.account.update({
          where: { id: data.senderAccountId },
          data: {
            balance: new Decimal(newSenderBalance),
            updatedAt: new Date(),
          },
        });

        // Mettre à jour le compte bénéficiaire
        await prisma.account.update({
          where: { id: data.receiverAccountId },
          data: {
            balance: new Decimal(newReceiverBalance),
            updatedAt: new Date(),
          },
        });

        // ✅ Transaction DEBIT avec le transfer.id
        await prisma.transaction.create({
          data: {
            id: crypto.randomUUID(),
            accountId: data.senderAccountId,
            transferId: transfer.id, // Utiliser l'ID du transfert créé
            type: transactions_type.TRANSFER,
            amount: new Decimal(totalAmount),
            balanceBefore: new Decimal(senderBalance),
            balanceAfter: new Decimal(newSenderBalance),
            reference: `DEBIT-${reference}`,
            description: `Transfer to ${receiverName}`,
            status: transactions_status.COMPLETED,
            movement: transactions_movement.DEBIT,
          },
        });

        // ✅ Transaction CREDIT avec le transfer.id
        await prisma.transaction.create({
          data: {
            id: crypto.randomUUID(),
            accountId: data.receiverAccountId,
            transferId: transfer.id, // Utiliser le même ID
            type: transactions_type.TRANSFER,
            amount: new Decimal(data.amount),
            balanceBefore: new Decimal(receiverBalance),
            balanceAfter: new Decimal(newReceiverBalance),
            reference: `CREDIT-${reference}`,
            description: `Transfer from ${senderAccount.clients?.firstName || 'Unknown'} ${senderAccount.clients?.lastName || ''}`.trim(),
            status: transactions_status.COMPLETED,
            movement: transactions_movement.CREDIT,
          },
        });

        // Mettre à jour le statut du transfert
        await prisma.transfer.update({
          where: { id: transfer.id },
          data: {
            status: transfers_status.COMPLETED,
            completedAt: new Date(),
          },
        });
      });

      // Enregistrement du bénéficiaire
      if (shouldSaveBeneficiary && receiverAccountNumber && receiverName) {
        try {
          await this.saveBeneficiary(
            data.initiatedBy,
            receiverAccountNumber,
            receiverName,
            receiverBankName,
            receiverPhone || undefined,
            receiverEmail || undefined,
            receiverName
          );
        } catch (beneficiaryError) {
          console.error('[Transfer] Failed to save beneficiary:', beneficiaryError);
        }
      }

      // Audit log
      await this.logAudit(
        data.initiatedBy,
        'TRANSFER',
        {
          from: data.senderAccountId,
          to: data.receiverAccountId,
          amount: data.amount,
          fees: fees,
          reference,
          currency,
          beneficiarySaved: shouldSaveBeneficiary,
        },
        'TRANSFER',
        transfer.id,
      );

      // Récupérer le transfert complété
      const completedTransfer = await this.prisma.transfer.findUnique({
        where: { id: transfer.id },
        include: {
          senderAccount: {
            include: { clients: true },
          },
          receiverAccount: {
            include: { clients: true },
          },
          senderUser: true,
          transaction: true,
        },
      });

      if (!completedTransfer) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('transfer_not_found', lang),
          statusCode: 404,
        });
      }

      // Notifications
      try {
        const senderLang = await this.getUserLanguage(data.initiatedBy);

        const senderFullName = senderAccount.clients?.firstName && senderAccount.clients?.lastName
          ? `${senderAccount.clients.firstName} ${senderAccount.clients.lastName}`
          : 'Unknown';

        await this.notificationHelper.notify(
          data.initiatedBy,
          NotificationType.TRANSFER_SENT,
          {
            amount: data.amount,
            fees: fees,
            receiverName: receiverName,
            reference: reference,
            currency: currency,
          },
          'TRANSFER',
          transfer.id,
          senderLang,
        );

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
                senderName: senderFullName,
                reference: reference,
                currency: currency,
              },
              'TRANSFER',
              transfer.id,
              receiverLang,
            );
          }
        }
      } catch (notifError) {
        console.error('[Notifications] Transfer notification error:', notifError);
      }

      return {
        success: true,
        message: this.i18nService.translate('transfer_success', lang),
        data: {
          transferId: completedTransfer.id,
          reference: completedTransfer.reference,
          senderAccountId: completedTransfer.senderAccountId,
          receiverAccountId: completedTransfer.receiverAccountId,
          receiverName: completedTransfer.receiverName,
          amount: completedTransfer.amount,
          fees: completedTransfer.fees,
          totalAmount: completedTransfer.totalAmount,
          currency: completedTransfer.currency,
          status: completedTransfer.status,
          description: completedTransfer.description,
          createdAt: completedTransfer.createdAt,
          senderBalance: newSenderBalance,
          receiverBalance: newReceiverBalance,
          beneficiarySaved: shouldSaveBeneficiary,
        },
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      console.error('[Transfer] Error:', error);
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

          const smsEnabled = await this.shouldSendSms(data.initiatedBy);
          if (smsEnabled) {
            const user = await this.prisma.user.findUnique({
              where: { id: data.initiatedBy },
              select: { phone: true, firstName: true, lastName: true },
            });
            if (user?.phone) {
              const smsText = this.i18nService.translate('deposit_sms', userLang, {
                firstName: user.firstName,
                lastName: user.lastName,
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

          const smsEnabled = await this.shouldSendSms(data.initiatedBy);
          if (smsEnabled) {
            const user = await this.prisma.user.findUnique({
              where: { id: data.initiatedBy },
              select: { phone: true, firstName: true, lastName: true },
            });
            if (user?.phone) {
              const smsText = this.i18nService.translate('withdraw_sms', userLang, {
                firstName: user.firstName,
                lastName: user.lastName,
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

    const totalDebit = transactions
      .filter(t => t.type === transactions_type.WITHDRAWAL || t.type === transactions_type.TRANSFER)
      .reduce((sum, t) => sum + t.amount.toNumber(), 0);

    const totalCredit = transactions
      .filter(t => t.type === transactions_type.DEPOSIT)
      .reduce((sum, t) => sum + t.amount.toNumber(), 0);

    // ✅ Utiliser firstName et lastName
    const clientName = account.clients
      ? `${account.clients.firstName || ''} ${account.clients.lastName || ''}`.trim()
      : 'Unknown';

    return {
      account: {
        id: account.id,
        clientId: account.clientId,
        clientName: clientName,
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

    // ✅ Formater la réponse sans fullName
    return {
      success: true,
      message: this.i18nService.translate('transaction_retrieved', lang),
      data: {
        id: transaction.id,
        transferId: transaction.transferId,
        accountId: transaction.accountId,
        type: transaction.type,
        status: transaction.status,
        amount: transaction.amount,
        balanceBefore: transaction.balanceBefore,
        balanceAfter: transaction.balanceAfter,
        reference: transaction.reference,
        description: transaction.description,
        createdAt: transaction.createdAt,
        account: transaction.account ? {
          id: transaction.account.id,
          clientId: transaction.account.clientId,
          accountType: transaction.account.accountType,
          currency: transaction.account.currency,
          status: transaction.account.status,
          client: transaction.account.clients ? {
            id: transaction.account.clients.id,
            clientId: transaction.account.clients.clientId,
            firstName: transaction.account.clients.firstName,
            lastName: transaction.account.clients.lastName,
            email: transaction.account.clients.email,
            phone: transaction.account.clients.phone,
          } : null,
        } : null,
        transfer: transaction.transfer ? {
          id: transaction.transfer.id,
          reference: transaction.transfer.reference,
          senderAccountId: transaction.transfer.senderAccountId,
          receiverAccountId: transaction.transfer.receiverAccountId,
          receiverName: transaction.transfer.receiverName,
          receiverPhone: transaction.transfer.receiverPhone,
          receiverEmail: transaction.transfer.receiverEmail,
          amount: transaction.transfer.amount,
          fees: transaction.transfer.fees,
          totalAmount: transaction.transfer.totalAmount,
          currency: transaction.transfer.currency,
          status: transaction.transfer.status,
          description: transaction.transfer.description,
          createdAt: transaction.transfer.createdAt,
          completedAt: transaction.transfer.completedAt,
          senderAccount: transaction.transfer.senderAccount ? {
            id: transaction.transfer.senderAccount.id,
            clientId: transaction.transfer.senderAccount.clientId,
            accountType: transaction.transfer.senderAccount.accountType,
            currency: transaction.transfer.senderAccount.currency,
            status: transaction.transfer.senderAccount.status,
            client: transaction.transfer.senderAccount.clients ? {
              id: transaction.transfer.senderAccount.clients.id,
              clientId: transaction.transfer.senderAccount.clients.clientId,
              firstName: transaction.transfer.senderAccount.clients.firstName,
              lastName: transaction.transfer.senderAccount.clients.lastName,
              email: transaction.transfer.senderAccount.clients.email,
              phone: transaction.transfer.senderAccount.clients.phone,
            } : null,
          } : null,
          receiverAccount: transaction.transfer.receiverAccount ? {
            id: transaction.transfer.receiverAccount.id,
            clientId: transaction.transfer.receiverAccount.clientId,
            accountType: transaction.transfer.receiverAccount.accountType,
            currency: transaction.transfer.receiverAccount.currency,
            status: transaction.transfer.receiverAccount.status,
            client: transaction.transfer.receiverAccount.clients ? {
              id: transaction.transfer.receiverAccount.clients.id,
              clientId: transaction.transfer.receiverAccount.clients.clientId,
              firstName: transaction.transfer.receiverAccount.clients.firstName,
              lastName: transaction.transfer.receiverAccount.clients.lastName,
              email: transaction.transfer.receiverAccount.clients.email,
              phone: transaction.transfer.receiverAccount.clients.phone,
            } : null,
          } : null,
        } : null,
      },
    };
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

    try {
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
        success: true,
        message: this.i18nService.translate('transfers_list_success', lang),
        data: {
          data: transfers,
          total: total,
          page: page,
          limit: limit,
          totalPages: Math.ceil(total / limit),
          hasNextPage: page * limit < total,
          hasPreviousPage: page > 1,
        },
      };
    } catch (error) {
      console.error('[Get Transfers By User] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('transfers_list_failed', lang),
        statusCode: 500,
      });
    }
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

  async listBeneficiaries(data: {
    userId: string;
    page?: number;
    limit?: number;
    search?: string;
    isFavorite?: boolean;
    lang?: string;
  }) {
    const lang = data.lang || 'fr';
    const page = data.page || 1;
    const limit = data.limit || 10;
    const skip = (page - 1) * limit;

    try {
      // Construire les filtres
      const where: any = {
        userId: data.userId,
      };

      // Filtre par recherche
      if (data.search) {
        where.OR = [
          { accountName: { contains: data.search, mode: 'insensitive' } },
          { accountNumber: { contains: data.search, mode: 'insensitive' } },
          { bankName: { contains: data.search, mode: 'insensitive' } },
          { nickname: { contains: data.search, mode: 'insensitive' } },
          { phone: { contains: data.search, mode: 'insensitive' } },
          { email: { contains: data.search, mode: 'insensitive' } },
        ];
      }

      // Filtre par favoris
      if (data.isFavorite !== undefined) {
        where.isFavorite = data.isFavorite;
      }

      // Récupérer les bénéficiaires avec pagination
      const [beneficiaries, total] = await this.prisma.$transaction([
        this.prisma.beneficiary.findMany({
          where,
          orderBy: {
            createdAt: 'desc', // Ordre décroissant (du plus récent au plus ancien)
          },
          skip,
          take: limit,
        }),
        this.prisma.beneficiary.count({ where }),
      ]);

      return {
        success: true,
        message: this.i18nService.translate('beneficiaries_list_success', lang),
        data: {
          data: beneficiaries, // Le tableau des bénéficiaires
          total: total, // Nombre total
          page: page, // Page actuelle
          limit: limit, // Nombre par page
          totalPages: Math.ceil(total / limit), // Nombre total de pages
        },
      };
    } catch (error) {
      console.error('[List Beneficiaries] Error:', error);
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('beneficiaries_list_failed', lang),
        statusCode: 500,
      });
    }
  }

  async getBeneficiaryById(id: string, userId: string, lang: string) {
    try {
      const beneficiary = await this.prisma.beneficiary.findUnique({
        where: {
          id: id,
        },
      });

      if (!beneficiary) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('beneficiary_not_found', lang),
          statusCode: 404,
        });
      }

      // Vérifier que le bénéficiaire appartient à l'utilisateur
      if (beneficiary.userId !== userId) {
        throw new RpcException({
          status: 'error',
          message: this.i18nService.translate('beneficiary_access_denied', lang),
          statusCode: 403,
        });
      }

      return {
        success: true,
        message: this.i18nService.translate('beneficiary_found', lang),
        data: beneficiary,
      };
    } catch (error) {
      if (error instanceof RpcException) throw error;
      throw new RpcException({
        status: 'error',
        message: error.message || this.i18nService.translate('beneficiary_get_failed', lang),
        statusCode: 500,
      });
    }
  }

  // ========================= HEALTH CHECK =========================
  async healthCheck() {
    return { status: 'ok', service: 'transaction-service' };
  }
}