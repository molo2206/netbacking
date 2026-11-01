// dto/register.dto.ts
import { IsEmail, IsNotEmpty, IsOptional, IsString, MinLength, IsPhoneNumber } from 'class-validator';

export class RegisterDto {

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;  // ✅ Rendre optionnel

  @IsString()
  @IsNotEmpty({ message: 'Password is required' })
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  password!: string;

  @IsOptional()
  @IsString()
  firstName?: string;  // ✅ Rendre optionnel

  @IsOptional()
  @IsString()
  lastName?: string;   // ✅ Rendre optionnel

  @IsNotEmpty({ message: 'ClientId is required' })
  @IsString()
  clientId!: string;   // ✅ Rendre requis

  @IsOptional()
  @IsString()
  referralCode?: string;

  @IsOptional()
  @IsString()
  otpCode?: string;

  @IsOptional()
  @IsString()
  fcmToken?: string;

  @IsOptional()
  @IsString()
  deviceInfo?: string;

  @IsOptional()
  @IsString()
  platform?: string;

  @IsOptional()
  @IsString()
  lang?: string;
}