// libs/common/src/i18n/i18n.module.ts
import { Module, Global } from '@nestjs/common';
import { I18nService } from './i18n.service';

@Global()
@Module({
  providers: [
    {
      provide: I18nService,
      useClass: I18nService,
    },
  ],
  exports: [I18nService],
})
export class I18nModule {}