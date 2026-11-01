// apps/user-service/src/user-service.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { UserServiceController } from './user-service.controller';
import { UserServiceService } from './user-service.service';
import { MailModule } from 'apps/auth-service/src/email/email.module';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { I18nModule } from '../../../libs/common/src/i18n/i18n.module';
import { PrismaService } from '../prisma/prisma.service';
import { BankModule } from 'apps/transaction-service/src/bank/bank.module';
import { UserApprovalService } from './approval/user-approval.service';
import { AdminSecurityService } from './admin/admin-security.service';
import { OperationControlsService } from './admin/operation-controls.service';
import { AdminMonitoringService } from './admin/admin-monitoring.service';

@Module({
  imports: [
    MailModule,
    ConfigModule,
    I18nModule,
    BankModule,   // ✅ AJOUTER (fournit BankService + EncryptionService)
  ],
  controllers: [UserServiceController],
  providers: [
    UserServiceService,
    UserApprovalService,
    AdminSecurityService,
    OperationControlsService,
    AdminMonitoringService,
    PrismaService,
    SmsService,
  ],
  exports: [UserServiceService, UserApprovalService, PrismaService],
})
export class UserServiceModule {}
