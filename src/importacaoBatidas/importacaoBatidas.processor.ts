import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { ImportacaoBatidasService } from './importacaoBatidas.service';
import { Logger } from '@nestjs/common';
import { EquipamentoMapeado } from './constants/equipamentos.constants';

export interface ImportacaoJobData {
  equipamento: EquipamentoMapeado;
  dataReferencia: string; // ISO string
}

@Processor('importacao-batidas')
export class ImportacaoBatidasProcessor {
  private readonly logger = new Logger(ImportacaoBatidasProcessor.name);

  constructor(
    private readonly importacaoBatidasService: ImportacaoBatidasService,
  ) {}

  @Process()
  async handleImportacao(job: Job<ImportacaoJobData>) {
    const { equipamento, dataReferencia } = job.data;
    const data = new Date(dataReferencia);

    this.logger.log(
      `[JOB ${job.id}] Iniciando processamento para equipamento ID ${equipamento.id} e coligada ${equipamento.CD_Coligada} para data ${data.toISOString()}`,
    );

    try {
      // A falha em um job não interfere nos outros. O BullMQ cuidará do job falho.
      await this.importacaoBatidasService.processarUmEquipamento(
        equipamento,
        data,
      );
      this.logger.log(`[JOB ${job.id}] Processamento concluído com sucesso.`);
    } catch (error) {
      this.logger.error(
        `[JOB ${job.id}] Falha ao processar job: ${error.message}`,
        error.stack,
      );
      // Lança o erro para que o BullMQ possa lidar com as tentativas de repetição (retries)
      throw error;
    }
  }
}
