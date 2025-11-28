import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { NotificacaoRotinaService } from './notificacao-rotina.service';
import { NotificacaoProcessor } from './notificacao.processor';
import { S3Module } from '../s3/s3.module';
import { ChatModule } from '../google/chat/chat.module';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'notificacao',
    }),
    S3Module,
    ChatModule,
  ],
  providers: [NotificacaoRotinaService, NotificacaoProcessor],
})
export class NotificacaoRotinaModule {}
