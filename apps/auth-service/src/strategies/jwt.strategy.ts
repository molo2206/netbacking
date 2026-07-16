// apps/auth-service/src/strategies/jwt.strategy.ts

import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // ✅ Ne pas ignorer l'expiration
      secretOrKey: configService.get<string>('JWT_SECRET') || 'secret',
    });
  }

  async validate(payload: any) {
    const userId = payload.sub || payload.id;
    
    if (!userId) {
      // ✅ Retourne 401 Unauthorized
      throw new UnauthorizedException('Token invalide');
    }

    return {
      id: userId,
      email: payload.email ?? null,
      phone: payload.phone ?? null,
      full_name: payload.full_name ?? null,
      role: payload.role || 'USER',
      status: payload.status || 'ACTIVE',
      account_number: payload.account_number ?? null,
      deleted: payload.deleted ?? false,
      sessionToken: payload.sessionToken,
    };
  }
}