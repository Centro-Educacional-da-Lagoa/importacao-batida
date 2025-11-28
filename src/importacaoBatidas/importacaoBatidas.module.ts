import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ImportacaoBatidasController } from './importacaoBatidas.controller';
import { ImportacaoBatidasService } from './importacaoBatidas.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [ImportacaoBatidasController],
  providers: [ImportacaoBatidasService],
  exports: [ImportacaoBatidasService],
})
export class ImportacaoBatidasModule {}
