import { Controller, Get } from '@nestjs/common';
import { NetbackingServiceService } from './netbacking-service.service';

@Controller()
export class NetbackingServiceController {
  constructor(private readonly netbackingServiceService: NetbackingServiceService) {}

  @Get()
  getHello(): string {
    return this.netbackingServiceService.getHello();
  }
}
