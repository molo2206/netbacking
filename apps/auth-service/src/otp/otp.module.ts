import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { SmsModule } from '../sms/sms.module';

@Module({
  imports: [SmsModule],
  providers: [OtpService],
  exports: [OtpService],
})
export class OtpModule {}
