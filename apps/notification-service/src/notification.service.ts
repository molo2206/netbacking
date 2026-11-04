/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/notification-service/src/notification.service.ts
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import { initializeApp, cert, getApps, App } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';
import * as crypto from 'crypto';
import { PrismaService } from './prisma/prisma.service';

/**
 * ═══════════════════════════════════════════════════════════════════
 * NOTIFICATIONS — procédure standard AccesFinance
 * ═══════════════════════════════════════════════════════════════════
 *  1. dédoublonnage (même utilisateur + même type + même entité en cours)
 *  2. push Firebase vers le DERNIER appareil enregistré de l'utilisateur
 *  3. token invalide → appareil désactivé
 *  4. enregistrement en base (historique « Notifications » de l'app)
 *
 * Corrections par rapport à l'ancienne version AccesFinance :
 *  - Firebase importé de façon statique (le `require` dynamique échouait
 *    après compilation webpack : « credential method not available »)
 *  - le token FCM est lu dans `pushToken` OU `deviceId` (la connexion le
 *    stockait dans `deviceId`, le service cherchait `pushToken`)
 *  - la colonne `notifications.type` n'accepte que EMAIL/SMS/PUSH/IN_APP :
 *    le type métier (transfer_sent…) est rangé dans `data.category`
 * ═══════════════════════════════════════════════════════════════════
 */
@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private readonly pendingNotifications = new Map<string, Promise<any>>();
  private firebaseApp: App | null = null;
  private messaging: Messaging | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.initializeFirebase();
  }

  // ─────────────────────────── Firebase ───────────────────────────

  private initializeFirebase() {
    try {
      const existing = getApps();
      if (existing.length > 0) {
        this.firebaseApp = existing[0];
      } else {
        const projectId = process.env.FIREBASE_PROJECT_ID;
        const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
        const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

        if (!projectId || !clientEmail || !privateKey) {
          this.logger.warn(
            '⚠️ FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY manquants : push désactivé (les notifications restent enregistrées).',
          );
          return;
        }
        this.firebaseApp = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
      }
      this.messaging = getMessaging(this.firebaseApp);
      this.logger.log('✅ Firebase Admin initialisé');
    } catch (error) {
      this.firebaseApp = null;
      this.messaging = null;
      this.logger.error(`❌ Initialisation Firebase impossible : ${error?.message || error}`);
    }
  }

  get firebaseReady(): boolean {
    return !!this.messaging;
  }

  private ensureStringValues(obj: any): Record<string, string> {
    const result: Record<string, string> = {};
    if (!obj) return result;
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined || value === null) continue;
      result[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return result;
  }

  /** Un token FCM ressemble à « xxxx:APA91b… » (> 100 caractères). */
  private looksLikeFcmToken(value?: string | null): boolean {
    return !!value && value.length > 100 && value.includes(':');
  }

  /** Dernier token de l'utilisateur (un seul appareil, le plus récent). */
  private async latestToken(userId: string): Promise<{ token: string; deviceRowId: string } | null> {
    const devices = await this.prisma.device.findMany({
      where: { userId, OR: [{ isActive: true }, { isActive: null }] },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 10,
      select: { id: true, deviceId: true, pushToken: true },
    });
    for (const d of devices) {
      const token = d.pushToken || (this.looksLikeFcmToken(d.deviceId) ? d.deviceId : null);
      if (token) return { token, deviceRowId: d.id };
    }
    return null;
  }

  // ─────────────────────────── envoi ───────────────────────────

  async sendNotificationToUser(
    userId: string,
    title: string,
    body: string,
    type: string,
    data?: any,
  ) {
    const entityId = data?.entityId;
    let dedupKey = `${userId}:${type}`;
    if (entityId) dedupKey += `:${entityId}`;

    if (this.pendingNotifications.has(dedupKey)) {
      this.logger.log(`⏳ [DEDUP] Notification déjà en cours pour ${dedupKey}`);
      return this.pendingNotifications.get(dedupKey);
    }

    const promise = this._sendNotification(userId, title, body, type, data).finally(() => {
      setTimeout(() => this.pendingNotifications.delete(dedupKey), 2000);
    });
    this.pendingNotifications.set(dedupKey, promise);
    return promise;
  }

  private async _sendNotification(
    userId: string,
    title: string,
    body: string,
    category: string,
    data?: any,
  ) {
    const target = await this.latestToken(userId);
    let pushStatus: 'SENT' | 'FAILED' | 'PENDING' = 'PENDING';

    if (target && this.messaging) {
      try {
        await this.messaging.send({
          token: target.token,
          notification: { title, body },
          data: this.ensureStringValues({ ...(data || {}), category }),
          android: { priority: 'high', notification: { sound: 'default' } },
          apns: { payload: { aps: { sound: 'default' } } },
        });
        pushStatus = 'SENT';
        this.logger.log(`✅ [FCM] Push envoyé à ${userId} (${category})`);
      } catch (error) {
        pushStatus = 'FAILED';
        const code = error?.code || error?.errorInfo?.code;
        this.logger.error(`❌ [FCM] ${code || ''} ${error?.message || error}`);
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token'
        ) {
          this.logger.log(`🗑️ [FCM] Token invalide désactivé pour ${userId}`);
          this.prisma.device
            .update({ where: { id: target.deviceRowId }, data: { isActive: false } })
            .catch((e) => this.logger.error(e?.message || e));
        }
      }
    } else if (!target) {
      this.logger.log(`⚠️ [PUSH] Aucun appareil enregistré pour ${userId}`);
    } else {
      this.logger.warn('⚠️ [PUSH] Firebase indisponible : notification enregistrée sans push');
    }

    // Sauvegarde en base (toujours) — `type` = canal, `data.category` = type métier
    const notification = await this.prisma.notification.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        type: 'PUSH',
        title: String(title || '').slice(0, 255),
        content: String(body || ''),
        data: JSON.stringify({ ...(data || {}), category }),
        status: pushStatus === 'SENT' ? 'SENT' : pushStatus === 'FAILED' ? 'FAILED' : 'PENDING',
        sentAt: pushStatus === 'SENT' ? new Date() : null,
        createdAt: new Date(),
      },
    });

    this.logger.log(`💾 [DB] Notification enregistrée : ${notification.id}`);
    return this.toResponse(notification);
  }

  async sendNotification(data: { userId: string; title: string; body: string; type?: string; data?: any }) {
    try {
      const notification = await this.sendNotificationToUser(
        data.userId,
        data.title,
        data.body,
        data.type || 'system',
        data.data,
      );
      return { success: true, notification };
    } catch (error) {
      this.logger.error(`❌ Send notification error: ${error.message}`);
      throw new RpcException({
        status: 'error',
        message: error.message || 'Failed to send notification',
        statusCode: 500,
      });
    }
  }

  // ─────────────────────────── lecture ───────────────────────────

  /** Format renvoyé aux apps (champs snake_case + équivalents camelCase). */
  private toResponse(n: any) {
    let data: any = null;
    try {
      data = n.data ? JSON.parse(n.data) : null;
    } catch {
      data = n.data;
    }
    const hasSeen = n.status === 'READ' || !!n.readAt;
    return {
      id: n.id,
      title: n.title,
      body: n.content,
      type: data?.category || n.type,
      data,
      has_seen: hasSeen,
      hasSeen,
      status: n.status,
      readAt: n.readAt,
      created_at: n.createdAt,
      createdAt: n.createdAt,
    };
  }

  async listUserNotifications(userId: string, page: number = 1, limit: number = 10, onlyUnread = false) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.min(100, Math.max(1, Number(limit) || 10));
    const where: any = { userId, ...(onlyUnread ? { status: { not: 'READ' } } : {}) };

    const [notifications, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (p - 1) * l,
        take: l,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, status: { not: 'READ' } } }),
    ]);

    return {
      message: 'Notifications retrieved',
      data: notifications.map((n) => this.toResponse(n)),
      total,
      unreadCount,
      page: p,
      limit: l,
      totalPages: Math.ceil(total / l),
    };
  }

  async getUserNotifications(userId: string, page: number = 1, limit: number = 10) {
    return this.listUserNotifications(userId, page, limit);
  }

  async markNotificationAsSeen(notificationId: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!notification) {
      throw new RpcException({ status: 'error', message: 'Notification not found', statusCode: 404 });
    }
    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: { status: 'READ', readAt: new Date() },
    });
    return { message: 'Notification marked as read', data: this.toResponse(updated) };
  }

  async markAllNotificationsAsSeen(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, status: { not: 'READ' } },
      data: { status: 'READ', readAt: new Date() },
    });
    return { message: `${result.count} notification(s) marked as read`, count: result.count };
  }

  async deleteNotification(notificationId: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!notification) {
      throw new RpcException({ status: 'error', message: 'Notification not found', statusCode: 404 });
    }
    await this.prisma.notification.delete({ where: { id: notificationId } });
    return { success: true, message: 'Notification deleted successfully' };
  }

  async deleteAllNotifications(userId: string) {
    const result = await this.prisma.notification.deleteMany({ where: { userId } });
    return { success: true, message: `${result.count} notification(s) deleted`, count: result.count };
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, status: { not: 'READ' } },
    });
    return { unreadCount: count };
  }

  async healthCheck() {
    return {
      status: 'ok',
      service: 'notification-service',
      firebase: this.firebaseReady ? 'connected' : 'disabled',
      timestamp: new Date().toISOString(),
    };
  }
}
