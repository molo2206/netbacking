// apps/auth-service/src/utility/decorators/current-user-decorator.ts
import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    
    console.log('[CurrentUser] Request user:', request.user);
    console.log('[CurrentUser] Request currentUser:', request.currentUser);
    
    // ✅ Essayer plusieurs sources
    const user = request.currentUser || request.user;
    
    if (!user || !user.id) {
      console.log('[CurrentUser] No valid user found');
      throw new UnauthorizedException('Utilisateur non authentifié');
    }
    
    console.log('[CurrentUser] User found:', {
      id: user.id,
      role: user.role,
    });
    
    if (data) {
      return user[data];
    }
    
    return user;
  },
);