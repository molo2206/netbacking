import { Injectable } from '@nestjs/common';

@Injectable()
export class MobileBankingServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
