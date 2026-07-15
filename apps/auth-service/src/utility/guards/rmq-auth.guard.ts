/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
// apps/auth-service/src/utility/guards/rmq-auth.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { verify } from 'jsonwebtoken';

@Injectable()
export class RmqAuthGuard implements CanActivate {
  private readonly logger = new Logger(RmqAuthGuard.name);

  canActivate(context: ExecutionContext): boolean {
    this.logger.log('🔐 RMQ Auth Guard - Starting verification');

    // Récupérer le pattern du message
    const pattern = context.getArgByIndex(0)?.pattern;
    this.logger.log(`📨 Pattern: ${pattern}`);

    // Récupérer les données
    const data = context.switchToRpc().getData();
    this.logger.log(
      `📦 Data received: ${JSON.stringify({
        hasToken: !!data?.token,
        hasUserId: !!data?.userId,
        userId: data?.userId,
        tokenLength: data?.token?.length,
        dataKeys: data ? Object.keys(data) : [],
      })}`,
    );

    const token = data?.token;
    if (!token) {
      this.logger.error('❌ No token found in message');
      throw new UnauthorizedException('Token manquant dans le message');
    }

    // Afficher le début du token pour déboguer
    this.logger.log(`🔑 Token preview: ${token.substring(0, 50)}...`);

    // Essayer avec différentes clés possibles
    const possibleSecrets = [
      process.env.JWT_SECRET,
      process.env.ACCESS_TOKEN_SECRET_KEY,
      'secret', // fallback
    ].filter(Boolean);

    this.logger.log(`🔐 Trying ${possibleSecrets.length} possible secrets`);

    let lastError: Error | null = null;

    for (const secret of possibleSecrets) {
      try {
        this.logger.log(`🔑 Trying secret: ${secret!.substring(0, 10)}...`);

        const payload = verify(token, secret!);

        this.logger.log('✅ Token verified successfully!');
        this.logger.log(
          `📋 Payload: ${JSON.stringify({
            id: (payload as any).id,
            role: (payload as any).role,
            status: (payload as any).status,
            email: (payload as any).email,
            phone: (payload as any).phone,
          })}`,
        );

        // Vérifier les champs requis
        if (!(payload as any).id) {
          this.logger.error('❌ Missing id in payload');
          throw new UnauthorizedException('ID utilisateur manquant');
        }

        if (!(payload as any).role) {
          this.logger.error('❌ Missing role in payload');
          throw new UnauthorizedException('Rôle utilisateur manquant');
        }

        if (!(payload as any).status) {
          this.logger.error('❌ Missing status in payload');
          throw new UnauthorizedException('Statut utilisateur manquant');
        }

        // Injecter l'utilisateur dans les données
        data.currentUser = {
          id: (payload as any).id,
          email: (payload as any).email ?? null,
          phone: (payload as any).phone ?? null,
          full_name: (payload as any).full_name ?? null,
          role: (payload as any).role,
          status: (payload as any).status,
          account_number: (payload as any).account_number,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        this.logger.log(
          `✅ User ${(payload as any).id} authenticated successfully`,
        );
        return true;
      } catch (err: any) {
        lastError = err;
        this.logger.warn(
          `❌ Failed with secret ${secret!.substring(0, 10)}...: ${err.message}`,
        );
        continue;
      }
    }

    // Si on arrive ici, aucun secret n'a fonctionné
    this.logger.error('❌ All secrets failed to verify token');
    this.logger.error(`Last error: ${lastError?.message}`);

    if (lastError?.message === 'jwt expired') {
      throw new UnauthorizedException('Token expiré');
    }

    throw new UnauthorizedException(
      `Token invalide: ${lastError?.message || 'Erreur inconnue'}`,
    );
  }
}
