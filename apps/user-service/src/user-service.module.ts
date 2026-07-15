// apps/user-service/src/user-service.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config'; // Ajoutez ceci
import { UserServiceController } from './user-service.controller';
import { UserServiceService } from './user-service.service';
import { MailModule } from 'apps/auth-service/src/email/email.module';
import { SmsService } from 'apps/auth-service/src/sms/sms.service';
import { I18nModule } from '../../../libs/common/src/i18n/i18n.module';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [
    MailModule,
    ConfigModule, // Ajoutez ConfigModule
    I18nModule
  ],
  controllers: [UserServiceController],
  providers: [UserServiceService, PrismaService, SmsService],
  exports: [UserServiceService, PrismaService],
})
export class UserServiceModule {}