import { Controller, Get } from '@nestjs/common';
import { AuditServiceService } from './audit-service.service';

@Controller()
export class AuditServiceController {
  constructor(private readonly auditServiceService: AuditServiceService) {}

  @Get()
  getHello(): string {
    return this.auditServiceService.getHello();
  }
}
