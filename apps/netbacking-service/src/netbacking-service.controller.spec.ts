import { Test, TestingModule } from '@nestjs/testing';
import { NetbackingServiceController } from './netbacking-service.controller';
import { NetbackingServiceService } from './netbacking-service.service';

describe('NetbackingServiceController', () => {
  let netbackingServiceController: NetbackingServiceController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [NetbackingServiceController],
      providers: [NetbackingServiceService],
    }).compile();

    netbackingServiceController = app.get<NetbackingServiceController>(NetbackingServiceController);
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(netbackingServiceController.getHello()).toBe('Hello World!');
    });
  });
});
