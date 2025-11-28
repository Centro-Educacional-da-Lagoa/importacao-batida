import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from '../google/chat/chat.service';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Service } from '../s3/s3.service';
import { randomUUID } from 'crypto';

interface ProcessoJobData {
  ID_Job: number;
  ID_Status_Job: number;
}

interface JobStatusResult {
  ID_Status_Job: number;
}

interface JobLogResult {
  NM_Log: string;
  TX_Conteudo_Log: string;
}

interface LogS3Info {
  nome: string;
  url: string;
}

@Processor('notificacao')
export class NotificacaoProcessor {
  private readonly logger = new Logger(NotificacaoProcessor.name);
  private readonly spaceWebhookUrl: string;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly chatService: ChatService,
    private readonly configService: ConfigService,
    private readonly s3Service: S3Service,
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

      if (newStatus >= 3 && newStatus <= 9) {
        this.logger.log(
          `Status ${newStatus} requer notificação. Iniciando processo de envio.`,
        );

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

        if (processoCompleto.IN_Notificacao_Enviada) {
          this.logger.warn(
            `Notificação para Job ${ID_Job} já foi enviada. Pulando.`,
          );
          return;
        }

        let logsS3: LogS3Info[] = [];
        try {
          logsS3 = await this.processarLogsDoJob(ID_Job, processoCompleto);
        } catch (error) {
          this.logger.error(
            `Falha ao processar logs para o Job ID: ${ID_Job}. Erro: ${error.message}`,
            error.stack,
          );
        }

        const message = this.formatChatMessage(
          processoCompleto,
          newStatus,
          logsS3,
        );

        await this.chatService.sendChatWebhook(this.spaceWebhookUrl, message);
        this.logger.log(`Notificação para Job ${ID_Job} enviada com sucesso.`);

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
      throw error;
    }
  }

  private async processarLogsDoJob(
    idJob: number,
    processo: any,
  ): Promise<LogS3Info[]> {
    this.logger.log(`Iniciando processamento de logs para o Job ID: ${idJob}`);
    const logsS3: LogS3Info[] = [];

    try {
      const jobLogs: JobLogResult[] = await this.prismaService.$queryRaw`
        SELECT logname AS NM_Log, logtext AS TX_Conteudo_Log
        FROM CORPORE_ERP_MANUTENCAO.dbo.gjobxlog
        WHERE IDJOB = ${idJob}
      `;

      if (!jobLogs || jobLogs.length === 0) {
        this.logger.log(`Nenhum log encontrado para o Job ID: ${idJob}.`);
        return logsS3;
      }

      this.logger.log(
        `Encontrados ${jobLogs.length} logs para o Job ID: ${idJob}`,
      );

      const dataFormatada = this.formatarDataBR(processo.DH_Criacao);

      for (const log of jobLogs) {
        const logExistente: any[] = await this.prismaService.$queryRaw`
          SELECT 1
          FROM BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida_Log
          WHERE ID_Job = ${idJob} AND NM_Log = ${log.NM_Log}
        `;

        if (logExistente.length > 0) {
          this.logger.log(
            `Log "${log.NM_Log}" para o Job ID: ${idJob} já existe no banco. Pulando.`,
          );
          continue;
        }

        const conteudoLog = Buffer.from(log.TX_Conteudo_Log, 'latin1').toString(
          'utf8',
        );

        const nomeArquivoLog = `${dataFormatada} ${
          processo.NM_Equipamento
        } Log ${log.NM_Log.replace(/\.[^/.]+$/, '')} ${randomUUID()}.txt`;

        const bucket = this.configService.get<string>('VULTR_S3_BUCKET_NAME');
        if (!bucket) {
          throw new Error(
            'VULTR_S3_BUCKET_NAME não configurado nas variáveis de ambiente.',
          );
        }

        const pasta = 'logs-importacao';
        const s3Key = `${pasta}/${nomeArquivoLog}`;

        const s3Response = await this.s3Service.upload(
          bucket,
          s3Key,
          conteudoLog,
          'text/plain; charset=utf-8',
        );

        await this.prismaService.$executeRaw`
          INSERT INTO BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida_Log (
            ID_Job,
            NM_Log,
            NM_S3_Bucket_Arquivo,
            CD_S3_Key_Arquivo,
            TX_S3_URL_Arquivo
          ) VALUES (
            ${idJob},
            ${log.NM_Log},
            ${s3Response.Bucket},
            ${s3Response.Key},
            ${s3Response.Location}
          )
        `;
        this.logger.log(
          `Log "${log.NM_Log}" para o Job ID: ${idJob} salvo no S3 e registrado no banco.`,
        );

        logsS3.push({ nome: log.NM_Log, url: s3Response.Location });
      }
    } catch (error) {
      this.logger.error(
        `Erro ao processar logs para o Job ID: ${idJob}. Erro: ${error.message}`,
        error.stack,
      );
    }

    return logsS3;
  }

  private formatarDataBR(data: Date): string {
    const dia = String(data.getDate()).padStart(2, '0');
    const mes = String(data.getMonth() + 1).padStart(2, '0');
    const ano = data.getFullYear();
    return `${dia}-${mes}-${ano}`;
  }

  private formatChatMessage(
    processo: any,
    status: number,
    logs: LogS3Info[],
  ): string {
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

    let message =
      `*Notificação de Processamento de Job*

` +
      `*ID Job:* ${processo.ID_Job}
` +
      `*Coligada:* ${processo.CD_Coligada_Execucao}
` +
      `*Equipamento:* ${processo.NM_Equipamento}
` +
      `*Status:* ${statusText}
`;

    if (processo.TX_S3_URL_Arquivo) {
      message += `*Arquivo AFD Importado:* <${processo.TX_S3_URL_Arquivo}|Visualizar Arquivo>\n`;
    }

    if (logs && logs.length > 0) {
      message += `*Logs do Processo:*
`;
      logs.forEach((log) => {
        message += `- <${log.url}|${log.nome}>\n`;
      });
    }

    return message;
  }
}
