import { SetMetadata } from '@nestjs/common';

export const AuthorizeRoles = (roles: string | string[]) =>
  SetMetadata('allowedRoles', Array.isArray(roles) ? roles : [roles]);
