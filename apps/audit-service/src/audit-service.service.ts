import { Injectable } from '@nestjs/common';

@Injectable()
export class AuditServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
