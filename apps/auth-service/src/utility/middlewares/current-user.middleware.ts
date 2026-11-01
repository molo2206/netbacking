// apps/auth-service/src/utility/middlewares/current-user.middleware.ts

import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { verify, TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CurrentUserMiddleware implements NestMiddleware {
  constructor(private readonly configService: ConfigService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    console.log('=== CURRENT USER MIDDLEWARE ===');

    const authHeader = req.headers.authorization;
    console.log('Auth header exists:', !!authHeader);

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('No Bearer token, setting currentUser to null');
      (req as any).currentUser = null;
      return next();
    }

    const token = authHeader.split(' ')[1];
    console.log('Token preview:', token.substring(0, 50) + '...');

    try {
      const secretKey = this.configService.get<string>('JWT_SECRET') || 'secret';
      const payload = verify(token, secretKey) as any;

      console.log('Token payload:', {
        id: payload.id,
        role: payload.role,
        status: payload.status,
      });

      if (!payload.id) {
        console.error('Missing id in payload');
        throw new UnauthorizedException('Token invalide: ID manquant');
      }

      (req as any).currentUser = {
        id: payload.id,
        email: payload.email ?? null,
        phone: payload.phone ?? null,
        full_name: payload.full_name ?? null,
        role: payload.role,
        status: payload.status,
        account_number: payload.account_number ?? null,
        deleted: payload.deleted ?? false,
        createdAt: payload.createdAt ? new Date(payload.createdAt) : new Date(),
        updatedAt: payload.updatedAt ? new Date(payload.updatedAt) : new Date(),
      };

      console.log('✅ Current user set from token:', {
        id: (req as any).currentUser.id,
        role: (req as any).currentUser.role,
        status: (req as any).currentUser.status,
      });

      next();
    } catch (err) {
      console.error('Token verification failed:', err.message);
      
      // ✅ Token expiré → 401 Unauthorized
      if (err instanceof TokenExpiredError) {
        throw new UnauthorizedException('Token expiré');
      }
      
      // ✅ Token invalide → 401 Unauthorized
      if (err instanceof JsonWebTokenError) {
        throw new UnauthorizedException('Token invalide');
      }
      
      throw new UnauthorizedException('Erreur d\'authentification');
    }
  }
}