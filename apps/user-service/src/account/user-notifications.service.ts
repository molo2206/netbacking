/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/user-service/src/account/user-notifications.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import * as bcrypt from 'bcrypt';
import { users_status } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { I18nService } from '../../../../libs/common/src/i18n/i18n.service';
import { NotificationService } from 'apps/notification-service/src/notification.service';

/**
 * ═══════════════════════════════════════════════════════════════════
 * NOTIFICATIONS DE L'UTILISATEUR + SUPPRESSION DE SON COMPTE
 * (routes standard AccesFinance)
 * ═══════════════════════════════════════════════════════════════════
 */
@Injectable()
export class UserNotificationsService {
  private readonly logger = new Logger(UserNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly i18nService: I18nService,
    private readonly notificationService: NotificationService,
  ) {}

  private rpcError(message: string, statusCode: number) {
    return new RpcException({ status: 'error', message, statusCode });
  }

  // ─────────────────────────── notifications ───────────────────────────

  list(params: { userId: string; page?: number; limit?: number; unreadOnly?: boolean }) {
    return this.notificationService.listUserNotifications(
      params.userId,
      params.page,
      params.limit,
      params.unreadOnly === true,
    );
  }

  unreadCount(params: { userId: string }) {
    return this.notificationService.getUnreadCount(params.userId);
  }

  markSeen(params: { notificationId: string; userId: string }) {
    return this.notificationService.markNotificationAsSeen(params.notificationId, params.userId);
  }

  markAllSeen(params: { userId: string }) {
    return this.notificationService.markAllNotificationsAsSeen(params.userId);
  }

  remove(params: { notificationId: string; userId: string }) {
    return this.notificationService.deleteNotification(params.notificationId, params.userId);
  }

  /**
   * Envoi par l'admin : à un utilisateur, ou à un groupe
   * (ALL = tous les clients actifs, MOBILE / WEB = selon la plateforme d'inscription).
   */
  async adminSend(params: {
    adminId: string;
    userId?: string;
    audience?: 'USER' | 'ALL' | 'MOBILE' | 'WEB';
    title: string;
    body: string;
    lang?: string;
  }) {
    const lang = params.lang || 'fr';
    const title = String(params.title || '').trim();
    const body = String(params.body || '').trim();
    if (!title || !body) throw this.rpcError(this.i18nService.translate('admin_notification_required', lang), 400);

    const audience = params.userId ? 'USER' : (params.audience || 'ALL');
    let userIds: string[] = [];

    if (audience === 'USER') {
      const user = await this.prisma.user.findUnique({ where: { id: params.userId! }, select: { id: true } });
      if (!user) throw this.rpcError(this.i18nService.translate('user_not_found', lang), 404);
      userIds = [user.id];
    } else {
      const users = await this.prisma.user.findMany({
        where: {
          status: users_status.ACTIVE,
          deletedAt: null,
          role: 'USER',
          ...(audience === 'MOBILE' ? { platform: 'MOBILE' } : {}),
          ...(audience === 'WEB' ? { platform: 'WEB' } : {}),
        },
        select: { id: true },
      });
      userIds = users.map((u) => u.id);
    }

    let sent = 0;
    const batchSize = 20;
    for (let i = 0; i < userIds.length; i += batchSize) {
      const batch = userIds.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map((id) =>
          this.notificationService.sendNotificationToUser(id, title, body, 'system', {
            entity: 'ADMIN_MESSAGE',
            sentBy: params.adminId,
          }),
        ),
      );
      sent += results.filter((r) => r.status === 'fulfilled').length;
    }

    try {
      await this.prisma.auditLog.create({
        data: {
          userId: params.adminId,
          action: 'ADMIN_SEND_NOTIFICATION',
          entity: 'NOTIFICATION',
          message: JSON.stringify({ audience, userId: params.userId || null, title, recipients: userIds.length, sent }),
          level: 'INFO',
        },
      });
    } catch (err) {
      this.logger.error(`Audit log failed: ${err?.message || err}`);
    }

    return {
      message: this.i18nService.translate('admin_notification_sent', lang, { count: sent }),
      data: { audience, recipients: userIds.length, sent },
    };
  }

  // ─────────────────────────── suppression du compte ───────────────────────────

  /**
   * Suppression de son propre compte (mot de passe exigé).
   * Le compte bancaire n'est PAS touché : seul l'accès à l'application est supprimé.
   * Le code client et le téléphone sont libérés pour permettre une nouvelle inscription.
   */
  async deleteOwnAccount(params: { id: string; password: string; lang?: string; ipAddress?: string }) {
    const lang = params.lang || 'fr';
    const user = await this.prisma.user.findUnique({ where: { id: params.id } });
    if (!user || user.deletedAt) throw this.rpcError(this.i18nService.translate('user_not_found', lang), 404);
    if (user.role === 'SUPER_ADMIN') {
      throw this.rpcError(this.i18nService.translate('account_delete_super_admin', lang), 403);
    }

    const ok = params.password && user.password ? await bcrypt.compare(params.password, user.password) : false;
    if (!ok) throw this.rpcError(this.i18nService.translate('account_delete_wrong_password', lang), 400);

    const stamp = Date.now();
    let metadata: any = {};
    try { metadata = user.metadata ? JSON.parse(user.metadata) : {}; } catch { metadata = {}; }
    metadata.deletedAccount = {
      clientId: user.clientId,
      phone: user.phone,
      email: user.email,
      deletedAt: new Date(stamp).toISOString(),
    };

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          status: users_status.DELETED,
          deletedAt: new Date(stamp),
          clientId: null,
          phone: `deleted-${stamp}-${user.phone}`.slice(0, 50),
          pin: null,
          pinStatus: false,
          metadata: JSON.stringify(metadata),
        },
      }),
      this.prisma.session.updateMany({
        where: { userId: user.id, isActive: true },
        data: { isActive: false, logoutAt: new Date(stamp) },
      }),
      this.prisma.device.updateMany({ where: { userId: user.id }, data: { isActive: false } }),
      this.prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'DELETE_OWN_ACCOUNT',
          entity: 'USER',
          entityId: user.id,
          message: JSON.stringify({ clientId: user.clientId }),
          ipAddress: params.ipAddress || undefined,
          level: 'WARN',
        },
      }),
    ]);

    return { message: this.i18nService.translate('account_deleted_success', lang), data: null };
  }
}
