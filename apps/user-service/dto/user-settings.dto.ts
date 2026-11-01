// apps/user-service/src/dto/user-settings.dto.ts
import { IsOptional, IsString, IsBoolean, IsEnum } from 'class-validator';

export enum UserSettingsTheme {
  SYSTEM = 'system',
  LIGHT = 'light',
  DARK = 'dark',
}

export class UpdateUserSettingsDto {
  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsEnum(UserSettingsTheme)
  theme?: UserSettingsTheme;

  @IsOptional()
  @IsBoolean()
  email_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  sms_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  push_notifications?: boolean;

  @IsOptional()
  @IsBoolean()
  two_factor_enabled?: boolean;

  @IsOptional()
  @IsString()
  last_device?: string;
}