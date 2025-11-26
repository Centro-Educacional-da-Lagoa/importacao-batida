import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { GoogleDriveModule } from '../google-drive/google-drive.module';
import { ImportacaoBatidasController } from './importacaoBatidas.controller';
import { ImportacaoBatidasService } from './importacaoBatidas.service';

@Module({
  imports: [ScheduleModule.forRoot(), GoogleDriveModule],
  controllers: [ImportacaoBatidasController],
  providers: [ImportacaoBatidasService],
  exports: [ImportacaoBatidasService],
})
export class ImportacaoBatidasModule {}
