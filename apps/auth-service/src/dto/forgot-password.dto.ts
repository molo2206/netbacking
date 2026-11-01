import { IsEmail, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class ForgotPasswordDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  identifier?: string;
}