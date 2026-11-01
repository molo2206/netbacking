import { Module } from '@nestjs/common';
import { AuditServiceController } from './audit-service.controller';
import { AuditServiceService } from './audit-service.service';

@Module({
  imports: [],
  controllers: [AuditServiceController],
  providers: [AuditServiceService],
})
export class AuditServiceModule {}
