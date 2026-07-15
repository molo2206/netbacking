/* eslint-disable @typescript-eslint/no-base-to-string */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';
import { RpcException } from '@nestjs/microservices';
import * as crypto from 'crypto';

@Injectable()
export class NotificationService implements OnModuleInit {
  private readonly logger = new Logger(NotificationService.name);
  private readonly pendingNotifications = new Map<string, Promise<any>>();
  private firebaseInitialized = false;
  private admin: any = null;

  constructor(private readonly prisma: PrismaService) { }

  onModuleInit() {
    this.initializeFirebase();
  }

  private initializeFirebase() {
    try {
      // Essayer d'importer firebase-admin dynamiquement
      try {
        this.admin = require('firebase-admin');
      } catch (importError) {
        this.logger.warn('⚠️ Firebase Admin package not installed. Push notifications disabled.');
        return;
      }

      // Vérifier si l'import a réussi
      if (!this.admin) {
        this.logger.warn('⚠️ Firebase Admin import failed. Push notifications disabled.');
        return;
      }

      // Vérifier si Firebase est déjà initialisé
      if (this.admin.apps && this.admin.apps.length > 0) {
        this.firebaseInitialized = true;
        this.logger.log('✅ Firebase Admin already initialized');
        return;
      }

      // Vérifier les credentials
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

      if (!projectId || !clientEmail || !privateKey) {
        this.logger.warn('⚠️ Firebase credentials missing. Push notifications disabled.');
        this.logger.warn('Please set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
        return;
      }

      // Vérifier que credential existe
      if (!this.admin.credential || !this.admin.credential.cert) {
        this.logger.warn('⚠️ Firebase credential method not available. Push notifications disabled.');
        return;
      }

      // Initialiser Firebase
      const serviceAccount = {
        projectId,
        clientEmail,
        privateKey,
      };

      this.admin.initializeApp({
        credential: this.admin.credential.cert(serviceAccount),
      });

      this.firebaseInitialized = true;
      this.logger.log('✅ Firebase Admin initialized successfully');
    } catch (error) {
      this.logger.error(`❌ Failed to initialize Firebase: ${error.message}`);
      this.firebaseInitialized = false;
    }
  }

  private ensureStringValues(obj: any): Record<string, string> {
    const result: Record<string, string> = {};
    if (!obj) return result;
    for (const [key, value] of Object.entries(obj)) {
      result[key] =
        typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return result;
  }

  // ==================== ENVOI ====================

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
      this.logger.log(`⏳ [DEDUP] Attente de la notification en cours pour ${dedupKey}`);
      return this.pendingNotifications.get(dedupKey);
    }

    const promise = this._sendNotification(
      userId,
      title,
      body,
      type,
      data,
    ).finally(() => {
      setTimeout(() => this.pendingNotifications.delete(dedupKey), 2000);
    });
    this.pendingNotifications.set(dedupKey, promise);
    return promise;
  }

  private async _sendNotification(
    userId: string,
    title: string,
    body: string,
    type: string,
    data?: any,
  ) {
    // 1. Récupérer les tokens FCM depuis la table Device
    const devices = await this.prisma.device.findMany({
      where: {
        userId,
        isActive: true,
        pushToken: { not: null },
      },
      select: { pushToken: true },
    });

    const tokens = devices
      .map(d => d.pushToken)
      .filter((token): token is string => !!token);

    this.logger.log(`📱 [PUSH] User ${userId} – ${tokens.length} token(s)`);

    // 2. Envoyer via Firebase (si disponible)
    if (tokens.length > 0 && this.firebaseInitialized && this.admin) {
      try {
        // Vérifier que messaging est disponible
        if (!this.admin.messaging) {
          this.logger.warn('⚠️ admin.messaging() not available');
          throw new Error('admin.messaging() not available');
        }

        const stringData = data ? this.ensureStringValues(data) : {};
        const messages = tokens.map((token) => ({
          token,
          notification: { title, body },
          data: stringData,
        }));

        const response = await this.admin.messaging().sendEach(messages);
        this.logger.log(`✅ [FCM] Envoyé: ${response.successCount || 0}/${tokens.length}`);

        if (response.responses) {
          response.responses.forEach((resp: any, idx: number) => {
            if (
              !resp.success &&
              resp.error?.code === 'messaging/registration-token-not-registered'
            ) {
              this.logger.log(`🗑️ [FCM] Token invalide pour user ${userId}`);
              this.prisma.device.updateMany({
                where: { pushToken: tokens[idx] },
                data: { isActive: false },
              }).catch((e) => this.logger.error(e));
            }
          });
        }
      } catch (error) {
        this.logger.error(`❌ [FCM] Erreur d'envoi: ${error.message}`);
      }
    } else {
      if (tokens.length === 0) {
        this.logger.log(`⚠️ [PUSH] Aucun token pour l'utilisateur ${userId}`);
      } else {
        this.logger.warn(`⚠️ [PUSH] Firebase non disponible`);
      }
    }

    // 3. Sauvegarde en base (toujours effectuée)
    const notification = await this.prisma.notification.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        type: type as any,
        title,
        content: body,
        data: data ? JSON.stringify(data) : null,
        status: tokens.length > 0 && this.firebaseInitialized ? 'SENT' : 'PENDING',
        sentAt: tokens.length > 0 && this.firebaseInitialized ? new Date() : null,
        createdAt: new Date(),
      },
    });

    this.logger.log(`💾 [DB] Notification enregistrée : ${notification.id}`);
    return notification;
  }

  // ==================== AUTRES MÉTHODES ====================

  async sendNotification(data: {
    userId: string;
    title: string;
    body: string;
    type?: string;
    data?: any;
  }) {
    try {
      const notification = await this.sendNotificationToUser(
        data.userId,
        data.title,
        data.body,
        data.type || 'IN_APP',
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

  async listUserNotifications(userId: string, page: number = 1, limit: number = 10) {
    const skip = (page - 1) * limit;

    const [notifications, total] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);

    return {
      message: 'Notifications retrieved',
      data: notifications,
      total,
      page,
      limit,
    };
  }

  async getUserNotifications(userId: string, page: number = 1, limit: number = 10) {
    return this.listUserNotifications(userId, page, limit);
  }

  async markNotificationAsSeen(notificationId: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: {
        id: notificationId,
        userId,
      },
    });

    if (!notification) {
      throw new RpcException({
        status: 'error',
        message: 'Notification not found',
        statusCode: 404,
      });
    }

    const updated = await this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        status: 'READ',
        readAt: new Date(),
      },
    });

    return {
      message: 'Notification marked as read',
      data: updated,
    };
  }

  async markAllNotificationsAsSeen(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        userId,
        status: { not: 'READ' },
      },
      data: {
        status: 'READ',
        readAt: new Date(),
      },
    });

    return {
      message: `${result.count} notification(s) marked as read`,
      count: result.count,
    };
  }

  async deleteNotification(notificationId: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });

    if (!notification) {
      throw new RpcException({
        status: 'error',
        message: 'Notification not found',
        statusCode: 404,
      });
    }

    await this.prisma.notification.delete({
      where: { id: notificationId },
    });

    return {
      success: true,
      message: 'Notification deleted successfully',
    };
  }

  async deleteAllNotifications(userId: string) {
    const result = await this.prisma.notification.deleteMany({
      where: { userId },
    });

    return {
      success: true,
      message: `${result.count} notification(s) deleted`,
      count: result.count,
    };
  }

  async getUnreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: {
        userId,
        status: { not: 'READ' },
      },
    });

    return {
      unreadCount: count,
    };
  }

  async healthCheck() {
    return {
      status: 'ok',
      service: 'notification-service',
      firebase: this.firebaseInitialized ? 'connected' : 'disabled',
      timestamp: new Date().toISOString(),
    };
  }
}