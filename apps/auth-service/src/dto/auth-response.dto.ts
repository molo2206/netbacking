// dto/auth-response.dto.ts
export class AuthResponseDto {
  accessToken: string;
  refreshToken: string;
  data: {
    id: string;
    email: string | null;
    phone: string | null;
    full_name: string | null;
    role: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
  };
  message?: string;
  sessionId?: string;
  sessions?: any[];
  clientId?: string;
}