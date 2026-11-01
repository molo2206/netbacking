import { SetMetadata } from '@nestjs/common';

export const PERMISSION_METADATA = 'permissions';

export interface Permission {
  resource: string;
  action: 'canCreate' | 'canRead' | 'canUpdate' | 'canDelete' | 'canManage';
}

// Accepte une permission unique ou un tableau
export const Permissions = (permissions: Permission | Permission[]) =>
  SetMetadata(
    PERMISSION_METADATA,
    Array.isArray(permissions) ? permissions : [permissions],
  );
