// apps/notification-service/src/notification.module.ts
import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { NotificationHelper } from './helpers/NotificationHelper';
import { PrismaService } from './prisma/prisma.service';
import { I18nModule } from '../../../libs/common/src/i18n/i18n.module';

@Module({
  imports: [I18nModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationHelper,
    PrismaService,
  ],
  exports: [
    NotificationService,
    NotificationHelper,
    PrismaService,
  ],
})
export class NotificationModule {}