import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../google/chat/chat.service';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface ProcessoJobData {
  ID_Job: number;
  ID_Status_Job: number;
}

interface JobStatusResult {
  ID_Status_Job: number;
}

@Processor('notificacao')
export class NotificacaoProcessor {
  private readonly logger = new Logger(NotificacaoProcessor.name);
  private readonly spaceWebhookUrl: string;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
  ) {
    const webhookUrl = this.configService.get<string>(
      'GOOGLE_CHAT_SPACE_WEBHOOK',
    );
    if (!webhookUrl) {
      throw new Error(
        'GOOGLE_CHAT_SPACE_WEBHOOK is not set in environment variables',
      );
    }
    this.spaceWebhookUrl = webhookUrl;
  }

  @Process()
  async handleNotificacao(job: Job<ProcessoJobData>) {
    const { ID_Job, ID_Status_Job: oldStatus } = job.data;
    this.logger.log(`Processando notificação para o Job ID: ${ID_Job}`);

    try {
      // Passo 1: Buscar Status Atual no Corpore
      const statusResult: JobStatusResult[] = await this.prismaService
        .$queryRaw`
        SELECT exjb.status AS ID_Status_Job
        FROM corpore_erp_manutencao.dbo.gjobxexecucaoview AS exjb (nolock)
        WHERE exjb.idjob = ${ID_Job}
      `;

      if (!statusResult || statusResult.length === 0) {
        this.logger.warn(
          `Nenhum status encontrado no Corpore para o Job ID: ${ID_Job}. Pulando.`,
        );
        return;
      }

      const newStatus = statusResult[0].ID_Status_Job;
      this.logger.log(
        `Status do Job ${ID_Job}: Antigo=${oldStatus}, Novo=${newStatus}`,
      );

      // Passo 2: Comparar e Atualizar Status se necessário
      if (newStatus !== oldStatus) {
        await this.prismaService.$executeRaw`
          UPDATE BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida
          SET ID_Status_Job = ${newStatus}
          WHERE ID_Job = ${ID_Job}
        `;
        this.logger.log(
          `Status do Processo ${ID_Job} atualizado para ${newStatus} no banco local.`,
        );
      }

      // Passo 3: Lógica de Notificação
      if (newStatus >= 3 && newStatus <= 9) {
        this.logger.log(
          `Status ${newStatus} requer notificação. Iniciando processo de envio.`,
        );

        // 1. Buscar dados completos do processo local
        const processoResult: any[] = await this.prismaService.$queryRaw`
            SELECT *
            FROM BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida
            WHERE ID_Job = ${ID_Job}
        `;
        const processoCompleto = processoResult[0];

        if (!processoCompleto) {
          throw new Error(
            `Processo ${ID_Job} não encontrado no banco de dados local.`,
          );
        }

        // 2. Formatar Mensagem
        const message = this.formatChatMessage(processoCompleto, newStatus);

        // 3. Enviar Notificação
        await this.chatService.sendChatWebhook(this.spaceWebhookUrl, message);
        this.logger.log(`Notificação para Job ${ID_Job} enviada com sucesso.`);

        // 4. Atualizar Flag
        await this.prismaService.$executeRaw`
          UPDATE BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida
          SET IN_Notificacao_Enviada = 1
          WHERE ID_Job = ${ID_Job}
        `;
        this.logger.log(
          `Flag IN_Notificacao_Enviada atualizada para o Processo ${ID_Job}.`,
        );
      } else {
        this.logger.log(
          `Status ${newStatus} não requer notificação. Finalizando processo para o Job ${ID_Job}.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Falha ao processar notificação para Job ID: ${ID_Job}. Erro: ${error.message}`,
        error.stack,
      );
      throw error; // Lança o erro para que o Bull possa tentar novamente
    }
  }

  private formatChatMessage(processo: any, status: number): string {
    const statusMap = {
      0: 'O job ainda não foi executado',
      1: 'O job está em execução',
      2: 'O job terminou normalmente a sua execução',
      3: 'A execução do job foi cancelada',
      4: 'A execução do job começou e foi interrompida',
      5: 'Erro na execução do job',
      6: 'O job foi executado com avisos',
      7: 'Houve uma falha no servidor durante a execução do job e a mesma não terminou corretamente',
      8: 'A execução do job está suspensa até ele ser habilitado novamente',
      9: 'Não foi possível executar o job por não encontrar um jobserver com afinidade disponível',
    };

    const statusText =
      statusMap[status] ||
      'Job programado para executar, conforme data programada';

    return (
      `*Notificação de Processamento de Job*

` +
      `*ID Job:* ${processo.ID_Job}
` +
      `*Coligada:* ${processo.CD_Coligada_Execucao}
` +
      `*Equipamento:* ${processo.NM_Equipamento}
` +
      `*Status:* ${statusText}
`
    );
  }
}
