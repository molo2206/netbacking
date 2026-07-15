export class CreateUserHasResourceDto {
  userId: string;
  resourceId: string;
  canCreate?: boolean;
  canRead?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
  canManage?: boolean;
  grantedBy?: string;
  expiresAt?: Date;
}

export class UpdateUserHasResourceDto {
  canCreate?: boolean;
  canRead?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
  canManage?: boolean;
  expiresAt?: Date;
  grantedBy?: string;
}

export class GetUserHasResourcesDto {
  page?: number;
  limit?: number;
  userId?: string;
  resourceId?: string;
}
