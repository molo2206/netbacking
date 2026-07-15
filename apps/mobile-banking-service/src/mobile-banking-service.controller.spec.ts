import { Test, TestingModule } from '@nestjs/testing';
import { MobileBankingServiceController } from './mobile-banking-service.controller';
import { MobileBankingServiceService } from './mobile-banking-service.service';

describe('MobileBankingServiceController', () => {
  let mobileBankingServiceController: MobileBankingServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [MobileBankingServiceController],
      providers: [MobileBankingServiceService],
    }).compile();

    mobileBankingServiceController = app.get<MobileBankingServiceController>(MobileBankingServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(mobileBankingServiceController.getHello()).toBe('Hello World!');
    });
  });
});
