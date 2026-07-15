// apps/transaction-service/src/transaction-service.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TransactionServiceController } from './transaction-service.controller';
import { TransactionServiceService } from './transaction-service.service';
import { I18nModule } from '../../../libs/common/src/i18n/i18n.module';
import { NotificationModule } from 'apps/notification-service/src/notification.module';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [
    ConfigModule,
    I18nModule,
    NotificationModule,
  ],
  controllers: [TransactionServiceController],
  providers: [
    TransactionServiceService,
    PrismaService,
    SmsService,
  ],
  exports: [TransactionServiceService, PrismaService],
})
export class TransactionServiceModule {}