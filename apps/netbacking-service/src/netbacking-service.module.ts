import { Module } from '@nestjs/common';
import { NetbackingServiceController } from './netbacking-service.controller';
import { NetbackingServiceService } from './netbacking-service.service';

@Module({
  imports: [],
  controllers: [NetbackingServiceController],
  providers: [NetbackingServiceService],
})
export class NetbackingServiceModule {}
