// apps/transaction-service/src/dto/create-transaction.dto.ts

import { IsString, IsNumber, IsOptional, IsEnum, IsNotEmpty, Min, IsBoolean } from 'class-validator';
import { transactions_type, transactions_status, transfers_type, transfers_platform, transactions_movement } from '@prisma/client';

export class CreateTransactionDto {
  @IsNotEmpty()
  @IsString()
  accountId: string;

  @IsNotEmpty()
  @IsEnum(transactions_type)
  type: transactions_type;

  @IsNotEmpty()
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsEnum(transactions_status)
  status?: transactions_status;

  @IsOptional()
  @IsString()
  transferId?: string;

  // ✅ Ajout du mouvement
  @IsOptional()
  @IsEnum(transactions_movement)
  movement?: transactions_movement;
}

export class TransferDto {
  @IsNotEmpty()
  @IsString()
  senderAccountNumber: string;

  @IsNotEmpty()
  @IsString()
  receiverAccountNumber: string;

  @IsOptional()
  @IsString()
  receiverName?: string;

  @IsOptional()
  @IsString()
  receiverPhone?: string;

  @IsOptional()
  @IsString()
  receiverEmail?: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsNumber()
  fees?: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsEnum(transfers_type)
  type?: transfers_type;

  @IsOptional()
  @IsEnum(transfers_platform)
  platform?: transfers_platform;

  @IsOptional()
  @IsString()
  initiatedBy?: string;

  @IsOptional()
  @IsBoolean()
  saveBeneficiary?: boolean;  // ✅ Ajout du champ
}

export class DepositDto {
  @IsNotEmpty()
  @IsString()
  accountId: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  reference?: string;
}

export class WithdrawDto {
  @IsNotEmpty()
  @IsString()
  accountId: string;

  @IsNotEmpty()
  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsString()
  description?: string;
}

export class TransactionFilterDto {
  @IsOptional()
  @IsString()
  accountId?: string;

  @IsOptional()
  @IsEnum(transactions_type)
  type?: transactions_type;

  @IsOptional()
  @IsEnum(transactions_status)
  status?: transactions_status;

  @IsOptional()
  @IsEnum(transactions_movement)
  movement?: transactions_movement;

  @IsOptional()
  startDate?: Date;

  @IsOptional()
  endDate?: Date;

  @IsOptional()
  @IsNumber()
  page?: number;

  @IsOptional()
  @IsNumber()
  limit?: number;
}