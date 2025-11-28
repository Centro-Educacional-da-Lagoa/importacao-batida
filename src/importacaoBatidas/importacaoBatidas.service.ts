import { Injectable, HttpException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import axios, { AxiosInstance } from 'axios';
import * as path from 'path';
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

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

@Injectable()
export class ImportacaoBatidasService {
  private accessToken: string | null = null;
  private rhidApiUrl: string;
  private rhidUsername: string;
  private rhidPassword: string;
  private totvsApiUrl: string;
  private totvsBasicAuth: string;
  private pathImportacaoTotvs: string;

  private axiosInstance: AxiosInstance;

  constructor(
    private readonly googleDriveService: GoogleDriveService,
    private readonly prismaService: PrismaService,
  ) {
    const {
      RHID_API_URL,
      RHID_API_USERNAME,
      RHID_API_PASSWORD,
      URL_API_TOTVS,
      TOKEN_API_TOTVS,
      PATH_IMPORTACAO_TOTVS,
    } = process.env;

    if (!RHID_API_URL)
      throw new Error('Missing required environment variable: RHID_API_URL');
    if (!RHID_API_USERNAME)
      throw new Error(
        'Missing required environment variable: RHID_API_USERNAME',
      );
    if (!RHID_API_PASSWORD)
      throw new Error(
        'Missing required environment variable: RHID_API_PASSWORD',
      );
    if (!URL_API_TOTVS)
      throw new Error('Missing required environment variable: URL_API_TOTVS');
    if (!TOKEN_API_TOTVS)
      throw new Error('Missing required environment variable: TOKEN_API_TOTVS');
    if (!PATH_IMPORTACAO_TOTVS)
      throw new Error(
        'Missing required environment variable: PATH_IMPORTACAO_TOTVS',
      );

    this.rhidApiUrl = RHID_API_URL;
    this.rhidUsername = RHID_API_USERNAME;
    this.rhidPassword = RHID_API_PASSWORD;
    this.totvsApiUrl = URL_API_TOTVS;
    this.totvsBasicAuth = TOKEN_API_TOTVS;
    this.pathImportacaoTotvs = PATH_IMPORTACAO_TOTVS;

    this.axiosInstance = axios.create({
      timeout: 60000, // 60 segundos timeout para downloads grandes
    });
  }

  /**
   * Cron job executado a cada 2 horas
   * Processa AFD de todos os equipamentos mapeados para a data atual
   */
  // @Cron('0 */2 * * *')
  async executarImportacaoAutomatica() {
    console.log(
      '🕐 Iniciando importação automática de AFD - ' + new Date().toISOString(),
    );

    try {
      const resultado = await this.processarAfd({});

      console.log('✅ Importação automática concluída:', {
        total: resultado.totalEquipamentos,
        sucessos: resultado.sucessos,
        falhas: resultado.falhas,
      });

      if (resultado.falhas > 0) {
        console.log(
          '⚠️ Equipamentos com falha:',
          resultado.resultados
            .filter((r) => !r.sucesso)
            .map((r) => `${r.equipamentoNome} (${r.mensagem})`),
        );
      }
    } catch (error) {
      console.log(
        '🚀 ~ ImportacaoBatidasService ~ executarImportacaoAutomatica ~ error:',
        error,
      );
    }
  }

  /**
   * Método principal: processa AFD dos equipamentos especificados
   */
  async processarAfd(
    params: ProcessarAfdDto,
  ): Promise<ResultadoProcessamentoAfd> {
    const dataReferencia = params.dataReferencia || new Date();
    const equipamentosIds = params.equipamentosIds;

    const resultados: ResultadoProcessamentoEquipamento[] = [];

    try {
      // Passo 1: Autenticar na API RHiD
      await this.autenticarRhid();

      // Passo 2: Buscar equipamentos válidos
      const equipamentosValidos =
        await this.buscarEquipamentos(equipamentosIds);

      console.log(
        `🔍 ${equipamentosValidos.length} equipamento(s) válido(s) encontrado(s)`,
      );

      // Passo 3-5: Processar cada equipamento
      for (const equipamentoRhid of equipamentosValidos) {
        const equipamentoMapeado = EQUIPAMENTOS_MAPEADOS.find(
          (e) => e.id === equipamentoRhid.id,
        );

        if (!equipamentoMapeado) {
          console.log(
            `⚠️ Equipamento ${equipamentoRhid.id} não encontrado no mapeamento`,
          );
          resultados.push({
            equipamentoId: equipamentoRhid.id,
            equipamentoNome: equipamentoRhid.name,
            sucesso: false,
            etapa: 'busca',
            mensagem: 'Equipamento não mapeado nos EQUIPAMENTOS_MAPEADOS',
            dataProcessamento: new Date(),
          });
          continue;
        }

        const resultado = await this.processarEquipamento(
          equipamentoRhid,
          equipamentoMapeado,
          dataReferencia,
        );
        resultados.push(resultado);
      }
    } catch (error) {
      console.log(
        '🚀 ~ ImportacaoBatidasService ~ processarAfd ~ error:',
        error,
      );
      throw new HttpException(
        error instanceof Error ? error.message : 'Erro ao processar AFD',
        500,
      );
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
   * Processa um equipamento específico: download, salvamento e importação
   */
  private async processarEquipamento(
    equipamentoRhid: RhidDevice,
    equipamentoMapeado: EquipamentoMapeado,
    dataReferencia: Date,
  ): Promise<ResultadoProcessamentoEquipamento> {
    console.log(
      `🔧 Processando equipamento: ${equipamentoRhid.name} (ID: ${equipamentoMapeado.id})`,
    );

    const nomeArquivo = `${this.formatarDataBR(dataReferencia)} ${
      equipamentoRhid.name
    }.txt`;
    let caminhoArquivoDrive: string | undefined;

    try {
      // Passo 3: Baixar AFD
      const conteudoAfd = await this.baixarAfd(
        equipamentoMapeado.id,
        dataReferencia,
      );

      // Passo 4: Salvar arquivo no Google Drive
      caminhoArquivoDrive = await this.salvarAfdToGoogleDrive(
        conteudoAfd,
        nomeArquivo,
      );

      console.log(`💾 Arquivo salvo no Google Drive: ${caminhoArquivoDrive}`);

      // Adiciona um tempo de espera para garantir a sincronização do arquivo no servidor
      const tempoDeEspera = 5000; // 5 segundos
      console.log(
        `⏱️ Aguardando ${
          tempoDeEspera / 1000
        } segundos para sincronização do Google Drive...`,
      );
      await delay(tempoDeEspera);

      // Passo 5: Executar importação TOTVS
      const sucessoImportacao = await this.executarImportacaoTotvs(
        equipamentoMapeado,
        equipamentoRhid,
        nomeArquivo,
        dataReferencia,
        conteudoAfd,
      );

      if (!sucessoImportacao) {
        return {
          equipamentoId: equipamentoMapeado.id,
          equipamentoNome: equipamentoRhid.name,
          sucesso: false,
          etapa: 'importacao',
          mensagem: 'Importação TOTVS retornou status diferente de "1"',
          caminhoArquivo: caminhoArquivoDrive,
          dataProcessamento: new Date(),
        };
      }

      console.log(
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
      console.log(
        `🚀 ~ ImportacaoBatidasService ~ processarEquipamento ~ ${equipamentoRhid.name} ~ error:`,
        error,
      );

      const mensagemErro =
        error instanceof Error ? error.message : 'Erro desconhecido';

      return {
        equipamentoId: equipamentoMapeado.id,
        equipamentoNome: equipamentoRhid.name,
        sucesso: false,
        etapa: 'download', // Etapa pode variar, mas 'download' ou 'salvamento' são as mais prováveis
        mensagem: mensagemErro,
        caminhoArquivo: caminhoArquivoDrive, // Adiciona o link do drive mesmo em caso de falha (se disponível)
        dataProcessamento: new Date(),
      };
    }
  }

  /**
   * Passo 1: Autenticar na API RHiD
   */
  private async autenticarRhid(): Promise<void> {
    try {
      console.log('🔐 Autenticando na API RHiD...');

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

      console.log('✅ Autenticação RHiD bem-sucedida');
    } catch (error) {
      console.log(
        '🚀 ~ ImportacaoBatidasService ~ autenticarRhid ~ error:',
        error,
      );
      throw new Error(
        `Falha na autenticação RHiD: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  /**
   * Passo 2: Buscar equipamentos com paginação
   */
  private async buscarEquipamentos(
    equipamentosIds?: number[],
  ): Promise<RhidDevice[]> {
    try {
      console.log('🔍 Buscando equipamentos na API RHiD...');

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
            headers: {
              Authorization: `Bearer ${this.accessToken}`,
            },
          },
        );

        const data: RhidDevicesResponse = rhidDevicesResponseSchema.parse(
          response.data,
        );

        // Filtrar equipamentos que precisamos e que têm status OK
        for (const device of data.records) {
          if (equipamentosProcurar.includes(device.id)) {
            if (device.status === 'OK') {
              equipamentosEncontrados.push(device);
            } else {
              console.log(
                `⚠️ Equipamento ${device.id} (${device.name}) possui status inválido: ${device.status}`,
              );
            }
          }
        }

        // Verificar se encontramos todos os equipamentos necessários
        const todosEncontrados = equipamentosProcurar.every((id) =>
          equipamentosEncontrados.some((e) => e.id === id),
        );

        if (todosEncontrados || start + length >= data.totalRecords) {
          break;
        }

        start += length;
      }

      // Alertar sobre equipamentos não encontrados
      const idsEncontrados = equipamentosEncontrados.map((e) => e.id);
      const naoEncontrados = equipamentosProcurar.filter(
        (id) => !idsEncontrados.includes(id),
      );

      if (naoEncontrados.length > 0) {
        console.log(
          `⚠️ Equipamentos não encontrados na API RHiD: ${naoEncontrados.join(
            ', ',
          )}`,
        );
      }

      return equipamentosEncontrados;
    } catch (error) {
      console.log(
        '🚀 ~ ImportacaoBatidasService ~ buscarEquipamentos ~ error:',
        error,
      );
      throw new Error(
        `Falha ao buscar equipamentos: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  /**
   * Passo 3: Baixar arquivo AFD de um equipamento
   */
  private async baixarAfd(
    equipamentoId: number,
    dataReferencia: Date,
  ): Promise<string> {
    try {
      const dataIni = new Date(dataReferencia);

      const dataFinal = new Date(dataReferencia);

      const dataIniFormatada = this.formatarDataRHiD(dataIni);
      const dataFinalFormatada = this.formatarDataRHiD(dataFinal);
      console.log(
        '🚀 ~ ImportacaoBatidasService ~ baixarAfd ~ dataFinal:',
        dataIniFormatada,
      );
      console.log(
        '🚀 ~ ImportacaoBatidasService ~ baixarAfd ~ dataFinalFormatada:',
        dataFinalFormatada,
      );

      const response = await this.axiosInstance.get(
        `${this.rhidApiUrl}/report/afd/download`,
        {
          params: {
            idEquipamento: equipamentoId,
            dataIni: dataIniFormatada,
            dataFinal: dataFinalFormatada,
          },
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
          },
        },
      );

      return response.data;
    } catch (error) {
      console.log(
        `🚀 ~ ImportacaoBatidasService ~ baixarAfd ~ equipamento ${equipamentoId} ~ error:`,
        error,
      );
      throw new Error(
        `Falha ao baixar AFD: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }

  /**
   * Passo 4: Salvar arquivo AFD no Google Drive
   */
  private async salvarAfdToGoogleDrive(
    conteudo: string,
    nomeArquivo: string,
  ): Promise<string> {
    try {
      // TODO: Futuramente implementar remoção de batidas duplicadas antes de salvar
      const { webViewLink } = await this.googleDriveService.uploadOrUpdateFile(
        nomeArquivo,
        conteudo,
        'text/plain',
      );
      return webViewLink;
    } catch (error) {
      console.log(
        '🚀 ~ ImportacaoBatidasService ~ salvarAfdToGoogleDrive ~ error:',
        error,
      );
      throw new Error(
        `Falha ao salvar arquivo no Google Drive: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
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
      console.log(
        `📤 Executando importação TOTVS para equipamento ${equipamentoRhid.name}...`,
      );

      const dataInicioImportacao = this.formatarDataTotvs(
        dataReferencia,
        '00:00:00',
      );
      const dataFimImportacao = this.formatarDataTotvs(
        dataReferencia,
        '00:00:00',
      );
      const dataSistema = this.formatarDataTotvs(new Date(), '00:00:00');

      const caminhoCompleto = this.pathImportacaoTotvs + nomeArquivo;
      const filePathTotvs = caminhoCompleto;

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
        DataInicioImportacao: dataInicioImportacao,
        DataFimImportacao: dataFimImportacao,
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
              $DATASISTEMA: dataSistema,
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

      console.log(
        `📊 Resposta TOTVS para ${equipamentoRhid.name}:`,
        response.data,
      );

      // Validar se retorno é "1" (sucesso)
      sucesso = response.data === '1' || response.data === 1;

      if (sucesso) {
        console.log(
          `✅ Importação TOTVS concluída com sucesso para ${equipamentoRhid.name}`,
        );
      } else {
        console.log(
          `❌ Importação TOTVS falhou para ${equipamentoRhid.name}. Resposta: ${response.data}`,
        );
      }

      return sucesso;
    } catch (error) {
      console.log(
        `🚀 ~ ImportacaoBatidasService ~ executarImportacaoTotvs ~ ${equipamentoRhid.name} ~ error:`,
        error,
      );
      throw new Error(
        `Falha na importação TOTVS: ${
          error instanceof Error ? error.message : error
        }`,
      );
    } finally {
      try {
        // Adiciona um tempo de espera para garantir que o job foi registrado no banco de dados.
        // O tempo pode precisar de ajuste dependendo do ambiente.
        await delay(5000);

        console.log('🔍 Buscando informações do job de importação...');

        const jobResult: any[] = await this.prismaService.$queryRaw`
              SELECT TOP 1
                  jobx.IDJOB AS ID_Job,
                  exjb.status AS ID_Status_Job,
                  jobx.codusuario AS CD_Usuario,
                  jobx.datacriacao AS DH_Criacao
              FROM corpore_erp_manutencao.dbo.gjobx AS jobx (nolock)
              LEFT JOIN corpore_erp_manutencao.dbo.gjobxexecucaoview AS exjb (nolock)
                  ON jobx.idjob = exjb.idjob
              WHERE jobx.codusuario = 'PortalMatriculaInt'
                  AND jobx.classeprocesso = 'PtoProcImportacaoBatidas'
              ORDER BY jobx.datacriacao DESC
          `;

        if (jobResult && jobResult.length > 0) {
          const jobInfo = jobResult[0];
          const conteudoAfdBase64 = Buffer.from(conteudoAfd).toString('base64');

          console.log(
            `✍️  Registrando log do job ${jobInfo.ID_Job} no banco de dados...`,
          );

          await this.prismaService.$executeRaw`
              INSERT INTO BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida (
                  ID_Job,
                  CD_Coligada_Execucao,
                  NM_Equipamento,
                  TX_Arquivo,
                  ID_Status_Job,
                  CD_Usuario_Criacao,
                  DH_Criacao,
                  IN_Notificacao_Enviada,
                  IN_Importacao_Realizada
              ) VALUES (
                  ${jobInfo.ID_Job},
                  ${equipamento.CD_Coligada},
                  ${equipamentoRhid.name},
                  ${conteudoAfdBase64},
                  ${jobInfo.ID_Status_Job},
                  ${jobInfo.CD_Usuario},
                  ${jobInfo.DH_Criacao},
                  0,
                  0
              )
          `;

          console.log(
            `✅ Log do job ${jobInfo.ID_Job} registrado com sucesso.`,
          );
        } else {
          console.log(
            '⚠️ Não foi possível encontrar o job de importação para registrar o log.',
          );
        }
      } catch (logError) {
        console.error(
          '❌ Erro ao registrar o log do job de importação:',
          logError,
        );
      }
    }
  }

  /**
   * Formatar data no formato DD-MM-YYYY para nome de arquivo
   */
  private formatarDataBR(data: Date): string {
    const dia = String(data.getUTCDate()).padStart(2, '0');
    const mes = String(data.getUTCMonth() + 1).padStart(2, '0');
    const ano = data.getUTCFullYear();
    return `${dia}-${mes}-${ano}`;
  }

  /**
   * Formatar data no formato DD-MM-YYYY HH:mm para API RHiD
   */
  private formatarDataRHiD(data: Date): string {
    const mes = String(data.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(data.getUTCDate()).padStart(2, '0');
    const ano = data.getUTCFullYear();

    return `${mes}/${dia}/${ano}`;
  }

  /**
   * Formatar data no formato YYYY-MM-DDTHH:mm:ss para TOTVS
   */
  private formatarDataTotvs(data: Date, hora: string): string {
    const ano = data.getUTCFullYear();
    const mes = String(data.getUTCMonth() + 1).padStart(2, '0');
    const dia = String(data.getUTCDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}T${hora}`;
  }
}
