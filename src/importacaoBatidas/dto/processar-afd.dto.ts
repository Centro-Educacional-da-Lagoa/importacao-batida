import { z } from 'zod';

// Schema para parâmetros de entrada da função processarAfd
export const processarAfdSchema = z.object({
  dataReferencia: z.date().optional(),
  equipamentosIds: z.array(z.number()).optional(),
});

export type ProcessarAfdDto = z.infer<typeof processarAfdSchema>;

// Schema para resposta de login RHiD
export const rhidLoginResponseSchema = z.object({
  accessToken: z.string(),
});

export type RhidLoginResponse = z.infer<typeof rhidLoginResponseSchema>;

// Schema para dispositivo retornado pela API RHiD
export const rhidDeviceSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string(),
});

export type RhidDevice = z.infer<typeof rhidDeviceSchema>;

// Schema para resposta paginada de dispositivos
export const rhidDevicesResponseSchema = z.object({
  records: z.array(rhidDeviceSchema),
  totalRecords: z.number(),
});

export type RhidDevicesResponse = z.infer<typeof rhidDevicesResponseSchema>;

// Tipo para resultado de processamento de cada equipamento
export interface ResultadoProcessamentoEquipamento {
  equipamentoId: number;
  equipamentoNome: string;
  sucesso: boolean;
  etapa: 'busca' | 'download' | 'salvamento' | 'importacao' | 'completo';
  mensagem: string;
  caminhoArquivo?: string;
  dataProcessamento: Date;
}

// Tipo para resposta completa do processamento
export interface ResultadoProcessamentoAfd {
  dataReferencia: Date;
  totalEquipamentos: number;
  sucessos: number;
  falhas: number;
  resultados: ResultadoProcessamentoEquipamento[];
  dataExecucao: Date;
}
