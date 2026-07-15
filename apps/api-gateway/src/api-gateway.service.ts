/* eslint-disable prettier/prettier */
import { Injectable } from '@nestjs/common';

@Injectable()
export class ApiGatewayService {
  healthCheck(): string {
    return 'API Gateway is running!';
  }

  getVersion(): string {
    return '1.0.0';
  }
}