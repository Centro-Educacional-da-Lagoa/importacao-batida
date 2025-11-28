import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ImportacaoBatidasController } from './importacaoBatidas.controller';
import { ImportacaoBatidasService } from './importacaoBatidas.service';
import { ImportacaoBatidasProcessor } from './importacaoBatidas.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'importacao-batidas',
    }),
  ],
  controllers: [ImportacaoBatidasController],
  providers: [ImportacaoBatidasService, ImportacaoBatidasProcessor],
  exports: [ImportacaoBatidasService],
})
export class ImportacaoBatidasModule {}
