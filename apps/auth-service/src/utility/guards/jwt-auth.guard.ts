// apps/auth-service/src/utility/guards/jwt-auth.guard.ts
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { verify, TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';
import { I18nService } from '@app/common';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly i18nService: I18nService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;
    const lang = request.headers['lang'] || 'fr';

    console.log('[JwtAuthGuard] Authorization header:', authHeader?.substring(0, 50) + '...');
    console.log('[JwtAuthGuard] URL:', request.url);

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[JwtAuthGuard] No token found');
      throw new UnauthorizedException('Token manquant');
    }

    const token = authHeader.split(' ')[1];
    console.log('[JwtAuthGuard] Token preview:', token.substring(0, 30) + '...');

    try {
      const secretKey = this.configService.get<string>('JWT_SECRET') || 'secret';
      console.log('[JwtAuthGuard] Using secret key');

      const payload = verify(token, secretKey) as any;

      console.log('[JwtAuthGuard] Payload verified:', {
        sub: payload.sub,
        id: payload.id,
        role: payload.role,
        email: payload.email,
      });

      // ✅ Récupérer l'ID depuis sub ou id
      const userId = payload.sub || payload.id;

      if (!userId) {
        console.log('[JwtAuthGuard] No user ID found in payload');
        throw new UnauthorizedException('Payload JWT invalide');
      }

      // ✅ Attacher l'utilisateur à la requête
      const user = {
        id: userId,
        email: payload.email ?? null,
        phone: payload.phone ?? null,
        full_name: payload.full_name ?? null,
        role: payload.role || 'USER',
        status: payload.status || 'ACTIVE',
        account_number: payload.account_number ?? null,
        deleted: payload.deleted ?? false,
        sessionToken: payload.sessionToken,
        createdAt: payload.createdAt ? new Date(payload.createdAt) : new Date(),
        updatedAt: payload.updatedAt ? new Date(payload.updatedAt) : new Date(),
      };

      request.currentUser = user;
      request.user = user;

      console.log('[JwtAuthGuard] User attached:', {
        id: user.id,
        role: user.role,
        status: user.status,
      });

      return true;
    } catch (err) {
      console.error('[JwtAuthGuard] Error:', err.message);

      if (err instanceof TokenExpiredError) {
        throw new ForbiddenException('Token expiré');
      }
      if (err instanceof JsonWebTokenError) {
        console.error('[JwtAuthGuard] JWT Error:', err.message);
        throw new UnauthorizedException('Token invalide');
      }
      throw new UnauthorizedException('Erreur d\'authentification');
    }
  }
}