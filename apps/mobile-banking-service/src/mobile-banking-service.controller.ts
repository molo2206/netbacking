import { Controller, Get } from '@nestjs/common';
import { MobileBankingServiceService } from './mobile-banking-service.service';

@Controller()
export class MobileBankingServiceController {
  constructor(private readonly mobileBankingServiceService: MobileBankingServiceService) {}

  @Get()
  getHello(): string {
    return this.mobileBankingServiceService.getHello();
  }
}
