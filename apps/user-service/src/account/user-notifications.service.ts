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
import { writeAudit } from '../../../../libs/common/src/audit/write-audit';
import { getRequestContext } from '../../../../libs/common/src/context/request-context';

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
    let pushed = 0;       // push Firebase réellement envoyé
    let pushFailed = 0;   // Firebase a refusé (token invalide, configuration…)
    let noDevice = 0;     // aucun appareil enregistré (ou Firebase désactivé)
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
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const st = (r.value as any)?.status;
        if (st === 'SENT') pushed += 1;
        else if (st === 'FAILED') pushFailed += 1;
        else noDevice += 1;
      }
    }

    try {
      await writeAudit(this.prisma, {
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
      data: {
        audience,
        recipients: userIds.length,
        sent,            // enregistrées dans l'historique des notifications
        pushed,          // reçues en push sur le téléphone
        pushFailed,
        withoutPush: noDevice,
        push: this.notificationService.pushStatus(),
      },
    };
  }

  /**
   * Diagnostic des notifications push : état de Firebase, appareils enregistrés,
   * dernières notifications. Avec userId : appareils et notifications de cet utilisateur.
   */
  async pushDiagnostic(params: { userId?: string; lang?: string }) {
    const where: any = params.userId ? { userId: params.userId } : {};
    const [devicesWithToken, activeDevicesWithToken, usersWithToken, lastNotifications, byStatus] = await Promise.all([
      this.prisma.device.count({ where: { ...where, pushToken: { not: null } } }),
      this.prisma.device.count({
        where: { ...where, pushToken: { not: null }, OR: [{ isActive: true }, { isActive: null }] },
      }),
      this.prisma.device
        .groupBy({ by: ['userId'], where: { ...where, pushToken: { not: null } } })
        .then((r) => r.length)
        .catch(() => null),
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, userId: true, title: true, status: true, sentAt: true, createdAt: true },
      }),
      this.prisma.notification
        .groupBy({ by: ['status'], where, _count: { _all: true } })
        .catch(() => [] as any[]),
    ]);
    const devices = params.userId
      ? await this.prisma.device.findMany({
          where: { userId: params.userId },
          orderBy: [{ updatedAt: 'desc' }],
          take: 10,
          select: { id: true, deviceName: true, deviceType: true, isActive: true, lastUsedAt: true, updatedAt: true, pushToken: true },
        })
      : [];

    return {
      message: 'Diagnostic des notifications push',
      data: {
        firebase: this.notificationService.pushStatus(),
        devices: {
          withToken: devicesWithToken,
          activeWithToken: activeDevicesWithToken,
          usersWithToken,
          list: devices.map((d) => ({
            ...d,
            pushToken: d.pushToken ? `${d.pushToken.slice(0, 12)}…${d.pushToken.slice(-6)}` : null,
          })),
        },
        notifications: {
          byStatus: (byStatus as any[]).map((b) => ({ status: b.status, count: b._count._all })),
          last: lastNotifications,
        },
        hints: [
          'firebase = disabled : ajouter FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL et FIREBASE_PRIVATE_KEY (mêmes valeurs qu\'AccesPay) dans le .env puis redémarrer.',
          'withToken = 0 : l\'application mobile n\'a envoyé aucun token FCM (champ fcmToken à la connexion ou POST /users/me/device-token).',
          'Notifications FAILED : voir firebase.lastPushError (token invalide, projet Firebase différent de celui de l\'application…).',
        ],
      },
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
          ipAddress: params.ipAddress || getRequestContext().ipAddress || undefined,
          userAgent: getRequestContext().userAgent || undefined,
          level: 'WARN',
        },
      }),
    ]);

    return { message: this.i18nService.translate('account_deleted_success', lang), data: null };
  }
}
