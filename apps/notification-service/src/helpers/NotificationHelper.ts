// apps/notification-service/src/helpers/NotificationHelper.ts
import { Injectable } from '@nestjs/common';
import { I18nService } from '@app/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '../type/notification-type';

@Injectable()
export class NotificationHelper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly i18nService: I18nService,
  ) {}

  async notify(
    userId: string,
    type: NotificationType,
    data?: any,
    entity?: string,
    entityId?: string,
    lang: string = 'fr',
  ) {
    const { title, body } = this.getTranslatedContent(type, data, lang);

    try {
      await this.prisma.notification.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          type: type as any,
          title,
          content: body,
          data: data ? JSON.stringify(data) : null,
          status: 'PENDING',
          createdAt: new Date(),
        },
      });
    } catch (err) {
      console.error('❌ Notification error:', err);
    }
  }

  private getTranslatedContent(
    type: NotificationType,
    data: any,
    lang: string,
  ) {
    let titleKey: string, bodyKey: string;

    switch (type) {
      // Transactions
      case NotificationType.DEPOSIT_SUCCESS:
        titleKey = 'notifications.deposit_success.title';
        bodyKey = 'notifications.deposit_success.body';
        break;
      case NotificationType.CASHOUT_SUCCESS:
        titleKey = 'notifications.cashout_success.title';
        bodyKey = 'notifications.cashout_success.body';
        break;
      case NotificationType.TRANSFER_SENT:
        titleKey = 'notifications.transfer_sent.title';
        bodyKey = 'notifications.transfer_sent.body';
        break;
      case NotificationType.TRANSFER_RECEIVED:
        titleKey = 'notifications.transfer_received.title';
        bodyKey = 'notifications.transfer_received.body';
        break;
      case NotificationType.PAYMENT_SENT:
        titleKey = 'notifications.payment_sent.title';
        bodyKey = 'notifications.payment_sent.body';
        break;
      case NotificationType.PAYMENT_RECEIVED:
        titleKey = 'notifications.payment_received.title';
        bodyKey = 'notifications.payment_received.body';
        break;
      
      // Sécurité
      case NotificationType.SECURITY_ALERT:
        titleKey = 'notifications.security_alert.title';
        bodyKey = 'notifications.security_alert.body';
        break;
      case NotificationType.LOGIN_ALERT:
        titleKey = 'notifications.login_alert.title';
        bodyKey = 'notifications.login_alert.body';
        break;
      
      // Système
      case NotificationType.SYSTEM:
        titleKey = 'notifications.system.title';
        bodyKey = 'notifications.system.body';
        break;
      case NotificationType.MAINTENANCE:
        titleKey = 'notifications.maintenance.title';
        bodyKey = 'notifications.maintenance.body';
        break;
      
      // Promotions
      case NotificationType.PROMO:
        titleKey = 'notifications.promo.title';
        bodyKey = 'notifications.promo.body';
        break;
      
      default:
        titleKey = 'notifications.default.title';
        bodyKey = 'notifications.default.body';
    }

    const title = this.i18nService.translate(titleKey, lang);
    const body = this.i18nService.translate(bodyKey, lang, {
      amount: data?.amount,
      currency: data?.currency || 'CDF',
      receiverName: data?.receiverName,
      senderName: data?.senderName,
      merchantName: data?.merchantName,
      ipAddress: data?.ipAddress,
      deviceName: data?.deviceName,
      time: data?.time,
    });

    return { title, body };
  }
}