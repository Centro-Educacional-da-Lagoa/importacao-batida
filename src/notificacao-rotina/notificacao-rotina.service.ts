import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

@Injectable()
export class NotificacaoRotinaService {
  private readonly logger = new Logger(NotificacaoRotinaService.name);

  constructor(
    private readonly prismaService: PrismaService,
    @InjectQueue('notificacao') private readonly notificacaoQueue: Queue,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async handleCron() {
    this.logger.log('Iniciando rotina de verificação de status de jobs...');

    try {
      const processos: any[] = await this.prismaService.$queryRaw`
        SELECT
          ID_Job,
          ID_Status_Job,
          TX_S3_URL_Arquivo
        FROM
          BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida
        WHERE
          IN_Notificacao_Enviada = 0
          AND ID_Status_Job IN (0, 1, 3, 4, 5, 6, 7, 8, 9)
      `;

      this.logger.log(
        `Encontrados ${processos.length} processos para verificação.`,
      );

      for (const processo of processos) {
        this.logger.log(`Adicionando job à fila: ${JSON.stringify(processo)}`);
        const job = await this.notificacaoQueue.add(processo, {
          jobId: `notificacao-job-${processo.ID_Job}`,
          attempts: 3, // Tenta reprocessar 3 vezes em caso de falha
          backoff: {
            type: 'exponential',
            delay: 10000, // 10 segundos de backoff
          },
        });
        this.logger.log(`Job adicionado com sucesso. ID da fila: ${job.id}`);
      }
    } catch (error) {
      this.logger.error(
        'Erro ao buscar ou adicionar processos à fila de notificação.',
        error.stack,
      );
    }
  }
}
