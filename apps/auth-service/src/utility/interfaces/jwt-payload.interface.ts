// apps/auth-service/src/utility/interfaces/jwt-payload.interface.ts
export interface JwtPayload {
  id: string;
  email?: string;
  phone?: string;
  full_name?: string;
  role: string; // Champ requis
  status: string; // Champ requis
  account_number?: string; // Optionnel
  branch?: string;
  merchantCode?: string;
  businessName?: string;
  passwordStatus?: string;
  pinstatus?: boolean;
  iat?: number;
  exp?: number;
}

// Exporter un type pour CurrentUser
export type CurrentUser = {
  id: string;
  email: string | null;
  phone: string | null;
  full_name: string | null;
  role: string;
  status: string;
  deleted: boolean;
  account_number: string | null;
  branch?: string | null;
  merchantCode?: string | null;
  businessName?: string | null;
  passwordStatus?: string | null;
  pinstatus?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};