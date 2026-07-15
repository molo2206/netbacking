// apps/user-service/src/dto/user-response.dto.ts
import { UserRole, users_status } from '@prisma/client';

export class UserResponseDto {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  photo: string | null;
  role: UserRole;
  status: users_status;
  clientId: string | null;
  isEmailVerified: boolean;
  isPhoneVerified: boolean;
  isTwoFactorEnabled: boolean;
  preferredLanguage: string | null;
  preferredCurrency: string | null;
  timezone: string | null;
  pinStatus: boolean | null;
  createdAt: Date;
  updatedAt: Date;
}