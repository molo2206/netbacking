// apps/notification-service/src/helpers/NotificationHelper.ts
import { Injectable, Logger } from '@nestjs/common';
import { I18nService } from '@app/common';
import { NotificationType } from '../type/notification-type';
import { NotificationService } from '../notification.service';

/**
 * ═══════════════════════════════════════════════════════════════════
 * NOTIFICATION HELPER — procédure standard AccesFinance
 * ═══════════════════════════════════════════════════════════════════
 *   notify(userId, type, data, entity, entityId, lang)
 *     1. titre + message traduits dans la langue de l'utilisateur
 *     2. NotificationService : push Firebase + historique en base
 *
 * Envoi se fait dans le même processus
 * (pas de passage par la file `notification_queue`), car le service de
 * notification ne tourne pas comme un processus séparé sur le serveur.
 * Résultat identique pour l'utilisateur, une étape réseau en moins.
 * ═══════════════════════════════════════════════════════════════════
 */
@Injectable()
export class NotificationHelper {
  private readonly logger = new Logger(NotificationHelper.name);

  constructor(
    private readonly notificationService: NotificationService,
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
    if (!userId) return;
    const { title, body } = this.getTranslatedContent(type, data, lang);

    const pushData: Record<string, any> = { ...(data || {}) };
    if (entity) pushData.entity = entity;
    if (entityId) pushData.entityId = entityId;

    try {
      await this.notificationService.sendNotificationToUser(userId, title, body, type, pushData);
    } catch (err) {
      this.logger.error(`❌ Notification ${type} pour ${userId} : ${err?.message || err}`);
    }
  }

  private keysFor(type: NotificationType, data: any): string {
    switch (type) {
      // ── Types génériques (procédure standard) ──
      case NotificationType.TRANSACTION:
        if (data?.operationType === 'deposit' || data?.operationType === 'topup') return 'deposit_success';
        if (data?.operationType === 'withdrawal' || data?.operationType === 'cashout') return 'cashout_success';
        return 'transaction';
      case NotificationType.TRANSFER:
        if (data?.direction === 'sent') return 'transfer_sent';
        if (data?.direction === 'received') return 'transfer_received';
        return 'transfer';
      case NotificationType.PAYMENT:
        if (data?.direction === 'sent') return 'payment_sent';
        if (data?.direction === 'received') return 'payment_received';
        return 'payment';
      case NotificationType.SECURITY:
        return data?.event ? `security.${data.event}` : 'security_alert';

      // ── Types précis ──
      case NotificationType.DEPOSIT_SUCCESS: return 'deposit_success';
      case NotificationType.CASHOUT_SUCCESS: return 'cashout_success';
      case NotificationType.TRANSFER_SENT: return 'transfer_sent';
      case NotificationType.TRANSFER_RECEIVED: return 'transfer_received';
      case NotificationType.PAYMENT_SENT: return 'payment_sent';
      case NotificationType.PAYMENT_RECEIVED: return 'payment_received';
      case NotificationType.ACCOUNT_LOCKED: return 'account_locked';
      case NotificationType.ACCOUNT_UNLOCKED: return 'account_unlocked';
      case NotificationType.PASSWORD_CHANGED: return 'password_changed';
      case NotificationType.PIN_CHANGED: return 'pin_changed';
      case NotificationType.PIN_CREATED: return 'pin_created';
      case NotificationType.LOGIN_ALERT: return 'login_alert';
      case NotificationType.LOGIN_FAILED: return 'login_failed';
      case NotificationType.SECURITY_ALERT: return 'security_alert';
      case NotificationType.TWO_FA_ENABLED: return 'two_fa_enabled';
      case NotificationType.TWO_FA_DISABLED: return 'two_fa_disabled';
      case NotificationType.SUSPICIOUS_ACTIVITY: return 'suspicious_activity';
      case NotificationType.SYSTEM: return 'system';
      case NotificationType.MAINTENANCE: return 'maintenance';
      case NotificationType.UPDATE_AVAILABLE: return 'update_available';
      case NotificationType.PROMO: return 'promo';
      case NotificationType.OFFER_AVAILABLE: return 'offer_available';
      case NotificationType.REFERRAL_BONUS: return 'referral_bonus';
      default: return 'default';
    }
  }

  private getTranslatedContent(type: NotificationType, data: any, lang: string) {
    const key = this.keysFor(type, data);
    const params = {
      amount: data?.amount ?? '',
      currency: data?.currency || 'USD',
      receiverName: data?.receiverName || data?.toName || '',
      senderName: data?.senderName || data?.fromName || '',
      accountNumber: data?.accountNumber || '',
      receiverAccountNumber: data?.receiverAccountNumber || '',
      senderAccountNumber: data?.senderAccountNumber || '',
      reference: data?.reference || '',
      balance: data?.balance ?? '',
      merchantName: data?.merchantName || '',
      customerName: data?.customerName || '',
      ipAddress: data?.ipAddress || '',
      deviceName: data?.deviceName || '',
      time: data?.time || '',
      message: data?.message || '',
      reason: data?.reason || '',
    };

    let title = this.i18nService.translate(`notifications.${key}.title`, lang, params);
    let body = this.i18nService.translate(`notifications.${key}.body`, lang, params);

    // Clé absente → texte par défaut plutôt que la clé brute
    if (title === `notifications.${key}.title`) {
      title = this.i18nService.translate('notifications.default.title', lang);
    }
    if (body === `notifications.${key}.body`) {
      body = data?.message || this.i18nService.translate('notifications.default.body', lang);
    }
    return { title, body: body.replace(/\s+/g, ' ').trim() };
  }
}
