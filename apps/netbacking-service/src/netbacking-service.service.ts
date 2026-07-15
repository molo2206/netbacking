import { Injectable } from '@nestjs/common';

@Injectable()
export class NetbackingServiceService {
  getHello(): string {
    return 'Hello World!';
  }
}
