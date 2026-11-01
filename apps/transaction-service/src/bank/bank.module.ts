import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BankService } from './bank.service';
import { EncryptionService } from './encryption.service';

@Module({
  imports: [ConfigModule],
  providers: [BankService, EncryptionService],
  exports: [BankService, EncryptionService],
})
export class BankModule {}