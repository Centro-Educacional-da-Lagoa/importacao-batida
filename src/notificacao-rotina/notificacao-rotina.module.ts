import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { NotificacaoRotinaService } from './notificacao-rotina.service';
import { NotificacaoProcessor } from './notificacao.processor';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'notificacao',
    }),
  ],
  providers: [NotificacaoRotinaService, NotificacaoProcessor],
})
export class NotificacaoRotinaModule {}
