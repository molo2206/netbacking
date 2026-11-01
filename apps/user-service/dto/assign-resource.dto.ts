// DTO pour l'assignation unitaire
export class AssignResourceDto {
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

// DTO pour un item dans l'assignation multiple
export class AssignResourceItemDto {
  resourceId: string;
  canCreate?: boolean;
  canRead?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
  canManage?: boolean;
  expiresAt?: Date;
}

// DTO pour l'assignation multiple
export class AssignMultipleResourcesDto {
  userId: string;
  resources: AssignResourceItemDto[];
  grantedBy?: string;
}
