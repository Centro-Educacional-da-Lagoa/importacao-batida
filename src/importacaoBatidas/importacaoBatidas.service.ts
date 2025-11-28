import { Injectable, HttpException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios, { AxiosInstance } from 'axios';
import {
  ProcessarAfdDto,
  ResultadoProcessamentoAfd,
  ResultadoProcessamentoEquipamento,
  RhidLoginResponse,
  RhidDevicesResponse,
  RhidDevice,
  rhidLoginResponseSchema,
  rhidDevicesResponseSchema,
} from './dto/processar-afd.dto';
import {
  EQUIPAMENTOS_MAPEADOS,
  EquipamentoMapeado,
} from './constants/equipamentos.constants';
import { GoogleDriveService } from '../google-drive/google-drive.service';
import { PrismaService } from '../prisma/prisma.service';
import { S3Service } from '../s3/s3.service';
import { randomUUID } from 'crypto';
import { getTotvsTableName } from 'src/utils/get-table-corpore';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ImportacaoJobData } from './importacaoBatidas.processor';

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

@Injectable()
export class ImportacaoBatidasService {
  private readonly logger = new Logger(ImportacaoBatidasService.name);
  private accessToken: string | null = null;
  private rhidApiUrl: string;
  private rhidUsername: string;
  private rhidPassword: string;
  private totvsApiUrl: string;
  private totvsBasicAuth: string;
  private pathImportacaoTotvs: string;
  private readonly tableCorpore: string = getTotvsTableName();

  private axiosInstance: AxiosInstance;

  constructor(
    private readonly googleDriveService: GoogleDriveService,
    private readonly prismaService: PrismaService,
    private readonly s3Service: S3Service,
    @InjectQueue('importacao-batidas')
    private readonly importacaoQueue: Queue<ImportacaoJobData>,
  ) {
    if (!process.env.RHID_API_URL)
      throw new Error('Missing required environment variable: RHID_API_URL');
    if (!process.env.RHID_API_USERNAME)
      throw new Error(
        'Missing required environment variable: RHID_API_USERNAME',
      );
    if (!process.env.RHID_API_PASSWORD)
      throw new Error(
        'Missing required environment variable: RHID_API_PASSWORD',
      );
    if (!process.env.URL_API_TOTVS)
      throw new Error('Missing required environment variable: URL_API_TOTVS');
    if (!process.env.TOKEN_API_TOTVS)
      throw new Error('Missing required environment variable: TOKEN_API_TOTVS');
    if (!process.env.PATH_IMPORTACAO_TOTVS)
      throw new Error(
        'Missing required environment variable: PATH_IMPORTACAO_TOTVS',
      );

    this.rhidApiUrl = process.env.RHID_API_URL;
    this.rhidUsername = process.env.RHID_API_USERNAME;
    this.rhidPassword = process.env.RHID_API_PASSWORD;
    this.totvsApiUrl = process.env.URL_API_TOTVS;
    this.totvsBasicAuth = process.env.TOKEN_API_TOTVS;
    this.pathImportacaoTotvs = process.env.PATH_IMPORTACAO_TOTVS;

    this.axiosInstance = axios.create({
      timeout: 60000, // 60 segundos timeout para downloads grandes
    });
  }

  /**
   * Cron job que enfileira a importação a cada 2 horas.
   */
  @Cron('0 */2 * * *')
  async agendarImportacaoAutomatica() {
    this.logger.log(
      '🕐 Agendando importação automática de AFD para todos os equipamentos.',
    );
    await this.executarRotina();
  }

  /**
   * Lógica principal da rotina: busca equipamentos e os enfileira para processamento.
   * Inclui a lógica de inversão de coligada.
   */
  async executarRotina(): Promise<{
    message: string;
    jobsEnfileirados: number;
  }> {
    const dataReferencia = new Date();
    let jobsEnfileirados = 0;

    for (const equipamento of EQUIPAMENTOS_MAPEADOS) {
      // Enfileirar para a coligada original
      await this.adicionarJobFila(equipamento, dataReferencia);
      jobsEnfileirados++;

      // Lógica de inversão de coligada
      const coligadaInvertida = this.getColigadaInvertida(
        equipamento.CD_Coligada,
      );
      if (coligadaInvertida) {
        const equipamentoInvertido = {
          ...equipamento,
          CD_Coligada: coligadaInvertida,
        };
        await this.adicionarJobFila(equipamentoInvertido, dataReferencia);
        jobsEnfileirados++;
      }
    }

    this.logger.log(
      `${jobsEnfileirados} jobs foram enfileirados para processamento.`,
    );
    return {
      message: `${jobsEnfileirados} jobs enfileirados com sucesso.`,
      jobsEnfileirados,
    };
  }

  private getColigadaInvertida(coligada: number): number | null {
    if (coligada === 1) return 5;
    if (coligada === 5) return 1;
    return null;
  }

  private async adicionarJobFila(
    equipamento: EquipamentoMapeado,
    dataReferencia: Date,
  ) {
    const jobData: ImportacaoJobData = {
      equipamento,
      dataReferencia: dataReferencia.toISOString(),
    };
    const jobId = `importacao-${equipamento.id}-${equipamento.CD_Coligada}-${dataReferencia.getTime()}`;

    await this.importacaoQueue.add(jobData, {
      jobId,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60000, // 1 minuto
      },
    });
    this.logger.log(`Job ${jobId} adicionado à fila.`);
  }

  /**
   * Método para processamento síncrono, utilizado pelo endpoint manual.
   */
  async processarAfd(
    params: ProcessarAfdDto,
  ): Promise<ResultadoProcessamentoAfd> {
    const dataReferencia = params.dataReferencia || new Date();
    const equipamentosIds = params.equipamentosIds;
    const resultados: ResultadoProcessamentoEquipamento[] = [];

    await this.autenticarRhid();

    const equipamentosParaProcessar = equipamentosIds
      ? EQUIPAMENTOS_MAPEADOS.filter((e) => equipamentosIds.includes(e.id))
      : EQUIPAMENTOS_MAPEADOS;

    for (const equipamentoMapeado of equipamentosParaProcessar) {
      const resultado = await this.processarUmEquipamento(
        equipamentoMapeado,
        dataReferencia,
      );
      resultados.push(resultado);
    }

    const sucessos = resultados.filter((r) => r.sucesso).length;
    const falhas = resultados.filter((r) => !r.sucesso).length;

    return {
      dataReferencia,
      totalEquipamentos: resultados.length,
      sucessos,
      falhas,
      resultados,
      dataExecucao: new Date(),
    };
  }

  /**
   * Processa um único equipamento. Chamado pelo Processor da fila.
   */
  async processarUmEquipamento(
    equipamentoMapeado: EquipamentoMapeado,
    dataReferencia: Date,
  ): Promise<ResultadoProcessamentoEquipamento> {
    try {
      if (!this.accessToken) {
        this.logger.log(
          'Token de acesso expirado ou inválido. Reautenticando...',
        );
        await this.autenticarRhid();
      }

      const equipamentosRhid = await this.buscarEquipamentos([
        equipamentoMapeado.id,
      ]);
      const equipamentoRhid = equipamentosRhid[0];

      if (!equipamentoRhid) {
        throw new Error(
          `Equipamento RHID com ID ${equipamentoMapeado.id} não encontrado ou com status inválido.`,
        );
      }

      return await this.processarEquipamento(
        equipamentoRhid,
        equipamentoMapeado,
        dataReferencia,
      );
    } catch (error) {
      this.logger.error(
        `Falha ao processar equipamento ${equipamentoMapeado.id}: ${error.message}`,
      );
      return {
        equipamentoId: equipamentoMapeado.id,
        equipamentoNome: `Equipamento Mapeado ID ${equipamentoMapeado.id}`,
        sucesso: false,
        etapa: 'busca',
        mensagem: error.message,
        dataProcessamento: new Date(),
      };
    }
  }

  /**
   * Lógica de processamento de um equipamento: download, salvamento e importação.
   */
  private async processarEquipamento(
    equipamentoRhid: RhidDevice,
    equipamentoMapeado: EquipamentoMapeado,
    dataReferencia: Date,
  ): Promise<ResultadoProcessamentoEquipamento> {
    this.logger.log(
      `🔧 Processando equipamento: ${equipamentoRhid.name} (ID: ${equipamentoMapeado.id}, Coligada: ${equipamentoMapeado.CD_Coligada})`,
    );

    const nomeArquivo = `${this.formatarDataBR(dataReferencia)} ${
      equipamentoRhid.name
    }.txt`;
    let caminhoArquivoDrive: string | undefined;

    try {
      const conteudoAfd = await this.baixarAfd(
        equipamentoMapeado.id,
        dataReferencia,
      );

      caminhoArquivoDrive = await this.salvarAfdToGoogleDrive(
        conteudoAfd,
        nomeArquivo,
      );
      this.logger.log(
        `💾 Arquivo salvo no Google Drive: ${caminhoArquivoDrive}`,
      );

      await delay(5000); // Espera para sincronização do Google Drive

      const sucessoImportacao = await this.executarImportacaoTotvs(
        equipamentoMapeado,
        equipamentoRhid,
        nomeArquivo,
        dataReferencia,
        conteudoAfd,
      );

      if (!sucessoImportacao) {
        throw new Error('Importação TOTVS retornou status diferente de "1"');
      }

      this.logger.log(
        `✅ Equipamento ${equipamentoRhid.name} processado com sucesso`,
      );

      return {
        equipamentoId: equipamentoMapeado.id,
        equipamentoNome: equipamentoRhid.name,
        sucesso: true,
        etapa: 'completo',
        mensagem: 'Processamento concluído com sucesso',
        caminhoArquivo: caminhoArquivoDrive,
        dataProcessamento: new Date(),
      };
    } catch (error) {
      this.logger.error(
        `❌ Erro no processamento do equipamento ${equipamentoRhid.name}: ${error.message}`,
      );

      return {
        equipamentoId: equipamentoMapeado.id,
        equipamentoNome: equipamentoRhid.name,
        sucesso: false,
        etapa: 'importacao', // Assumindo que a falha pode ocorrer em qualquer etapa
        mensagem: error.message,
        caminhoArquivo: caminhoArquivoDrive,
        dataProcessamento: new Date(),
      };
    }
  }

  /**
   * Passo 1: Autenticar na API RHiD
   */
  private async autenticarRhid(): Promise<void> {
    try {
      this.logger.log('🔐 Autenticando na API RHiD...');
      const response = await this.axiosInstance.post(
        `${this.rhidApiUrl}/login`,
        {
          email: this.rhidUsername,
          password: this.rhidPassword,
        },
      );
      const loginData: RhidLoginResponse = rhidLoginResponseSchema.parse(
        response.data,
      );
      this.accessToken = loginData.accessToken;
      this.logger.log('✅ Autenticação RHiD bem-sucedida');
    } catch (error) {
      this.accessToken = null; // Garante que o token seja invalidado em caso de falha
      this.logger.error(`Falha na autenticação RHiD: ${error.message}`);
      throw new Error(`Falha na autenticação RHiD: ${error.message}`);
    }
  }

  /**
   * Passo 2: Buscar equipamentos com paginação
   */
  private async buscarEquipamentos(
    equipamentosIds?: number[],
  ): Promise<RhidDevice[]> {
    this.logger.log('🔍 Buscando equipamentos na API RHiD...');
    const equipamentosProcurar =
      equipamentosIds || EQUIPAMENTOS_MAPEADOS.map((e) => e.id);
    const equipamentosEncontrados: RhidDevice[] = [];
    let start = 0;
    const length = 100;

    while (true) {
      const response = await this.axiosInstance.get(
        `${this.rhidApiUrl}/device`,
        {
          params: { start, length },
          headers: { Authorization: `Bearer ${this.accessToken}` },
        },
      );
      const data: RhidDevicesResponse = rhidDevicesResponseSchema.parse(
        response.data,
      );

      for (const device of data.records) {
        if (equipamentosProcurar.includes(device.id)) {
          if (device.status === 'OK') {
            equipamentosEncontrados.push(device);
          } else {
            this.logger.warn(
              `⚠️ Equipamento ${device.id} (${device.name}) com status inválido: ${device.status}`,
            );
          }
        }
      }

      if (
        start + length >= data.totalRecords ||
        equipamentosEncontrados.length >= equipamentosProcurar.length
      ) {
        break;
      }
      start += length;
    }

    const idsEncontrados = equipamentosEncontrados.map((e) => e.id);
    const naoEncontrados = equipamentosProcurar.filter(
      (id) => !idsEncontrados.includes(id),
    );
    if (naoEncontrados.length > 0) {
      this.logger.warn(
        `⚠️ Equipamentos não encontrados na API RHiD: ${naoEncontrados.join(', ')}`,
      );
    }

    return equipamentosEncontrados;
  }

  /**
   * Passo 3: Baixar arquivo AFD de um equipamento
   */
  private async baixarAfd(
    equipamentoId: number,
    dataReferencia: Date,
  ): Promise<string> {
    const dataFormatada = this.formatarDataRHiD(dataReferencia);
    this.logger.log(`DOWNLOADING ${dataFormatada}`);
    const response = await this.axiosInstance.get(
      `${this.rhidApiUrl}/report/afd/download`,
      {
        params: {
          idEquipamento: equipamentoId,
          dataIni: dataFormatada,
          dataFinal: dataFormatada,
        },
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      },
    );
    return response.data;
  }

  /**
   * Passo 4: Salvar arquivo AFD no Google Drive
   */
  private async salvarAfdToGoogleDrive(
    conteudo: string,
    nomeArquivo: string,
  ): Promise<string> {
    const { webViewLink } = await this.googleDriveService.uploadOrUpdateFile(
      nomeArquivo,
      conteudo,
      'text/plain',
    );
    return webViewLink;
  }

  /**
   * Passo 5: Executar importação na TOTVS
   */
  private async executarImportacaoTotvs(
    equipamento: EquipamentoMapeado,
    equipamentoRhid: RhidDevice,
    nomeArquivo: string,
    dataReferencia: Date,
    conteudoAfd: string,
  ): Promise<boolean> {
    let sucesso = false;
    try {
      this.logger.log(
        `📤 Executando importação TOTVS para ${equipamentoRhid.name} na coligada ${equipamento.CD_Coligada}...`,
      );

      const dataFormatadaTotvs = this.formatarDataTotvs(
        dataReferencia,
        '00:00:00',
      );
      const payload = this.construirPayloadTotvs(
        equipamento,
        nomeArquivo,
        dataFormatadaTotvs,
      );

      const response = await this.axiosInstance.post(
        `${this.totvsApiUrl}/rest/restprocess/executeprocess/PtoProcImportacaoBatidas`,
        payload,
        {
          headers: {
            Authorization: `Basic ${this.totvsBasicAuth}`,
            'Content-Type': 'text/plain',
          },
        },
      );

      this.logger.log(
        `📊 Resposta TOTVS para ${equipamentoRhid.name}: ${response.data}`,
      );
      sucesso = response.data === '1' || response.data === 1;

      if (!sucesso) {
        this.logger.error(
          `❌ Importação TOTVS falhou para ${equipamentoRhid.name}. Resposta: ${response.data}`,
        );
      }
      return sucesso;
    } catch (error) {
      this.logger.error(
        `💣 Falha catastrófica na importação TOTVS para ${equipamentoRhid.name}: ${error.message}`,
      );
      throw error;
    } finally {
      await this.registrarLogImportacao(
        equipamento,
        equipamentoRhid,
        dataReferencia,
        conteudoAfd,
      );
    }
  }

  private construirPayloadTotvs(
    equipamento: EquipamentoMapeado,
    nomeArquivo: string,
    dataFormatada: string,
  ) {
    const filePathTotvs = this.pathImportacaoTotvs + nomeArquivo;
    const payload = {
      ActionModule: 'A',
      ActionName: 'PtoActionProcImportacaoBatidas',
      ProcessName: 'Importação de Batidas',
      ServerName: 'PtoProcImportacaoBatidas',
      CodUsuario: 'PortalMatriculaInt',
      Context: {
        _params: {
          $EXERCICIOFISCAL: -1,
          $CODLOCPRT: -1,
          $CODTIPOCURSO: 1,
          $EDUTIPOUSR: '-1',
          $CODUNIDADEBIB: -1,
          $CODCOLIGADA: equipamento.CD_Coligada,
          $RHTIPOUSR: '-1',
          $CODIGOEXTERNO: '-1',
          $CODSISTEMA: 'A',
          $CODUSUARIOSERVICO: '',
          $CODUSUARIO: 'PortalMatriculaInt',
          $IDPRJ: -1,
          $CHAPAFUNCIONARIO: '-1',
        },
      },
      CodColigada: equipamento.CD_Coligada,
      CodigoLayoutRelogio: '001',
      DataInicioImportacao: dataFormatada,
      DataFimImportacao: dataFormatada,
      AcertaNatureza: 'ConsiderandoJornada',
      ConsideraPerfilCadastrado: true,
      ConsideraNaturezaFixa: false,
      ConsideraUltimaLinhaParaImportacao: false,
      AtualizaUltimoNSRDisposisitovosCarol: false,
      ExibeInatividadeFuncionario: false,
      DesabilitarFracionamentoJob: false,
      FromFracionamentoJob: false,
      SaveLogInDatabase: true,
      SaveParamsExecution: false,
      UseJobMonitor: true,
      OnlineMode: false,
      SyncExecution: false,
      NotifyEmail: false,
      NotifyFluig: false,
      PrimaryKeyList: [],
      PrimaryKeyNames: [],
      FilePath: filePathTotvs,
      NaturezaFixa: 'Saida',
      TipoImportacao: 'Arquivo',
      TerminalColeta: equipamento.CD_Terminal_Coleta.toString(),
      TempoMinimoEntreBatidas: '00:00',
      TipoLayout: 'None',
      PriorizaCracha: false,
      RecalculaAposImportacao: false,
      ImportarBatidasAPI: false,
      QuebraSecao: '???????????????',
      Selecao: {
        Chapa: [],
        CodRecebimento: 'DHMOPQST',
        CodSituacao: 'ADEFILMOPRSTUVWZ',
        CodTipo: 'ABCDEFIMNOPRSUXZ',
        NaoUsaCodReceb: false,
        NaoUsaSituacao: false,
        NaoUsaTipoFunc: false,
        Contexto: {
          _params: {
            $EXERCICIOFISCAL: -1,
            $CODLOCPRT: -1,
            $CODTIPOCURSO: 1,
            $EDUTIPOUSR: '-1',
            $CODUNIDADEBIB: -1,
            $CODCOLIGADA: equipamento.CD_Coligada,
            $DATASISTEMA: this.formatarDataTotvs(new Date(), '00:00:00'),
            $RHTIPOUSR: '-1',
            $CODIGOEXTERNO: '-1',
            $CODSISTEMA: 'A',
            $CODUSUARIOSERVICO: '',
            $CODUSUARIO: 'PortalMatriculaInt',
            $IDPRJ: -1,
            $CHAPAFUNCIONARIO: '-1',
          },
        },
      },
    };

    return payload;
  }

  private async registrarLogImportacao(
    equipamento: EquipamentoMapeado,
    equipamentoRhid: RhidDevice,
    dataReferencia: Date,
    conteudoAfd: string,
  ) {
    try {
      await delay(5000); // Espera para o job ser registrado no banco
      this.logger.log('🔍 Buscando informações do job de importação...');

      const query = `
              SELECT TOP 1
                  jobx.IDJOB AS ID_Job,
                  exjb.status AS ID_Status_Job,
                  jobx.codusuario AS CD_Usuario,
                  jobx.datacriacao AS DH_Criacao
              FROM ${this.tableCorpore}.dbo.gjobx AS jobx (nolock)
              LEFT JOIN ${this.tableCorpore}.dbo.gjobxexecucaoview AS exjb (nolock)
                  ON jobx.idjob = exjb.idjob
              WHERE jobx.codusuario = 'PortalMatriculaInt'
                  AND jobx.classeprocesso = 'PtoProcImportacaoBatidas'
              ORDER BY jobx.datacriacao DESC
          `;
      const jobResult: any[] = await this.prismaService.$queryRawUnsafe(query);

      if (!jobResult || jobResult.length === 0) {
        this.logger.warn(
          '⚠️ Não foi possível encontrar o job de importação para registrar o log.',
        );
        return;
      }

      const jobInfo = jobResult[0];
      let s3Bucket: string | null = null;
      let s3Key: string | null = null;
      let s3Location: string | null = null;

      try {
        const nomeArquivoS3 = `${this.formatarDataBR(dataReferencia)} ${
          equipamentoRhid.name
        } ${randomUUID()}.txt`;
        const bucket = process.env.VULTR_S3_BUCKET_NAME;
        if (!bucket) throw new Error('VULTR_S3_BUCKET_NAME não configurado');

        const key = `afd-importacao/${nomeArquivoS3}`;
        const s3Response = await this.s3Service.upload(
          bucket,
          key,
          conteudoAfd,
          'text/plain',
        );
        s3Bucket = s3Response.Bucket;
        s3Key = s3Response.Key;
        s3Location = s3Response.Location;
      } catch (s3Error) {
        this.logger.error(
          `❌ Erro ao fazer upload do arquivo para o S3: ${s3Error.message}`,
        );
      }

      this.logger.log(
        `✍️  Registrando log do job ${jobInfo.ID_Job} no banco de dados...`,
      );
      await this.prismaService.$executeRaw`
            INSERT INTO BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida (
                ID_Job,
                CD_Coligada_Execucao,
                NM_Equipamento,
                ID_Status_Job,
                IN_Importacao_Realizada,
                NM_S3_Bucket_Arquivo,
                CD_S3_Key_Arquivo,
                TX_S3_URL_Arquivo,
                CD_Usuario_Criacao,
                DH_Criacao,
                IN_Notificacao_Enviada
            ) VALUES (
                ${jobInfo.ID_Job},
                ${equipamento.CD_Coligada.toString()},
                ${equipamentoRhid.name},
                ${jobInfo.ID_Status_Job},
                1, 
                ${s3Bucket},
                ${s3Key},
                ${s3Location},
                ${jobInfo.CD_Usuario},
                ${jobInfo.DH_Criacao},
                0
            )
        `;

      this.logger.log(
        `✅ Log do job ${jobInfo.ID_Job} registrado com sucesso.`,
      );
    } catch (logError) {
      this.logger.error(
        `❌ Erro ao registrar o log do job de importação: ${logError.message}`,
      );
    }
  }

  /**
   * Formata data para nome de arquivo (DD-MM-YYYY)
   */
  private formatarDataBR(data: Date): string {
    return `${String(data.getUTCDate()).padStart(2, '0')}-${String(
      data.getUTCMonth() + 1,
    ).padStart(2, '0')}-${data.getUTCFullYear()}`;
  }

  /**
   * Formata data para API RHiD (MM/DD/YYYY)
   */
  private formatarDataRHiD(data: Date): string {
    return `${String(data.getUTCMonth() + 1).padStart(2, '0')}/${String(
      data.getUTCDate(),
    ).padStart(2, '0')}/${data.getUTCFullYear()}`;
  }

  /**
   * Formata data para TOTVS (YYYY-MM-DDTHH:mm:ss)
   */
  private formatarDataTotvs(data: Date, hora: string): string {
    return `${data.getUTCFullYear()}-${String(data.getUTCMonth() + 1).padStart(
      2,
      '0',
    )}-${String(data.getUTCDate()).padStart(2, '0')}T${hora}`;
  }
}
