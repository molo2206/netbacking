// dto/verify-otp.dto.ts
import { IsNotEmpty, IsString, IsIn } from 'class-validator';

export class VerifyOtpDto {
  @IsString()
  @IsNotEmpty({ message: 'User ID is required' })
  userId!: string;

  @IsString()
  @IsNotEmpty({ message: 'OTP code is required' })
  otp!: string;

  @IsString()
  @IsNotEmpty({ message: 'OTP type is required' })
  @IsIn(['EMAIL', 'SMS'], { message: 'OTP type must be EMAIL or SMS' })
  type!: 'EMAIL' | 'SMS';
}