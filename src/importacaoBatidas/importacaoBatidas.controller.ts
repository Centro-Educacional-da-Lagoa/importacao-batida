import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpException,
} from '@nestjs/common';
import { ImportacaoBatidasService } from './importacaoBatidas.service';
import {
  ProcessarAfdDto,
  ResultadoProcessamentoAfd,
  processarAfdSchema,
} from './dto/processar-afd.dto';

@Controller('dp-rh/importacao-batidas')
export class ImportacaoBatidasController {
  constructor(
    private readonly importacaoBatidasService: ImportacaoBatidasService,
  ) {}

  /**
   * Endpoint para acionar manualmente a rotina de importação de batidas.
   * A rotina irá enfileirar jobs para cada equipamento e sua coligada invertida.
   * @returns Uma mensagem de confirmação com o número de jobs enfileirados.
   */
  @Post('executar-rotina')
  @HttpCode(202) // Accepted
  async executarRotina() {
    try {
      console.log('📥 Requisição manual para executar a rotina de importação recebida.');
      // Não aguarda a conclusão dos jobs, apenas o enfileiramento
      const resultado = await this.importacaoBatidasService.executarRotina();
      return resultado;
    } catch (error) {
      console.error('💥 Erro ao executar a rotina de importação:', error);
      throw new HttpException(
        error instanceof Error ? error.message : 'Erro ao iniciar a rotina de importação',
        500,
      );
    }
  }

  /**
   * Endpoint manual para processar importação de AFD de forma síncrona
   * Aceita parâmetros opcionais para data de referência e equipamentos específicos
   *
   * @param data - { dataReferencia?: Date, equipamentosIds?: number[] }
   * @returns Resultado detalhado do processamento de cada equipamento
   */
  @Post('processar')
  @HttpCode(200)
  async processarAfd(
    @Body() data: ProcessarAfdDto,
  ): Promise<ResultadoProcessamentoAfd> {
    try {
      // Validar dados de entrada com Zod
      const validatedData = processarAfdSchema.parse({
        ...data,
        dataReferencia: data.dataReferencia
          ? new Date(data.dataReferencia)
          : undefined,
      });

      console.log('📥 Requisição manual de importação AFD síncrona recebida:', {
        dataReferencia: validatedData.dataReferencia || 'data atual',
        equipamentosIds: validatedData.equipamentosIds || 'todos',
      });

      const resultado = await this.importacaoBatidasService.processarAfd(
        validatedData,
      );

      return resultado;
    } catch (error) {
      console.log(
        '🚀 ~ ImportacaoBatidasController ~ processarAfd ~ error:',
        error,
      );

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        error instanceof Error
          ? error.message
          : 'Erro ao processar importação AFD',
        500,
      );
    }
  }
}
