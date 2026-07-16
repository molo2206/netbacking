// apps/auth-service/src/utility/guards/jwt-auth.guard.ts

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    console.log('[JwtAuthGuard] Authorization header:', authHeader?.substring(0, 50) + '...');
    console.log('[JwtAuthGuard] URL:', request.url);

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[JwtAuthGuard] No token found');
      throw new UnauthorizedException('Token manquant');
    }

    const token = authHeader.split(' ')[1];
    console.log('[JwtAuthGuard] Token preview:', token.substring(0, 30) + '...');

    try {
      // ✅ Utiliser JwtService au lieu de jsonwebtoken.verify
      const secretKey = this.configService.get<string>('JWT_SECRET') || 'secret';
      
      const payload = this.jwtService.verify(token, {
        secret: secretKey,
      });

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

      if (err instanceof TokenExpiredError || err.name === 'TokenExpiredError') {
        throw new ForbiddenException('Token expiré');
      }
      if (err instanceof JsonWebTokenError || err.name === 'JsonWebTokenError') {
        console.error('[JwtAuthGuard] JWT Error:', err.message);
        throw new UnauthorizedException('Token invalide');
      }
      throw new UnauthorizedException('Erreur d\'authentification');
    }
  }
}