/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/require-await */
// apps/notification-service/src/notification.controller.ts
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { NotificationService } from './notification.service';

@Controller()
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @MessagePattern('send_notification')
  async sendNotification(@Payload() payload: any) {
    console.log('[Notification] Received send_notification:', payload);
    const { userId, title, body, type, data } = payload;
    return this.notificationService.sendNotificationToUser(
      userId,
      title,
      body,
      type,
      data,
    );
  }

  @MessagePattern('list_user_notifications')
  async listUserNotifications(
    @Payload() payload: { userId: string; page?: number; limit?: number },
  ) {
    return this.notificationService.listUserNotifications(
      payload.userId,
      payload.page,
      payload.limit,
    );
  }

  @MessagePattern('mark_notification_seen')
  async markNotificationSeen(
    @Payload() data: { notificationId: string; userId: string },
  ) {
    return this.notificationService.markNotificationAsSeen(
      data.notificationId,
      data.userId,
    );
  }

  @MessagePattern('mark_all_notifications_seen')
  async markAllNotificationsSeen(@Payload() data: { userId: string }) {
    return this.notificationService.markAllNotificationsAsSeen(data.userId);
  }

  @MessagePattern('health_check')
  async healthCheck() {
    return { status: 'ok', service: 'notification-service' };
  }
}
