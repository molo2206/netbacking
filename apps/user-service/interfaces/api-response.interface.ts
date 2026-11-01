// apps/user-service/src/interfaces/api-response.interface.ts
export interface ApiResponse<T> {
  message: string;
  data: T;
}

export interface RpcError {
  status?: string;
  message?: string;
  statusCode?: number;
}
