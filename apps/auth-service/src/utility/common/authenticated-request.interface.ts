import { Request } from 'express';

export type CurrentUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
  full_name?: string | null;
  role: string;
  status: string;
  deleted?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface AuthenticatedRequest extends Request {
  currentUser?: CurrentUser | null;
}
