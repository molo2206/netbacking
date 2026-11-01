import { Module } from '@nestjs/common';
import { MobileBankingServiceController } from './mobile-banking-service.controller';
import { MobileBankingServiceService } from './mobile-banking-service.service';

@Module({
  imports: [],
  controllers: [MobileBankingServiceController],
  providers: [MobileBankingServiceService],
})
export class MobileBankingServiceModule {}
