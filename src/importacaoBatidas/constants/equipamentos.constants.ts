export interface EquipamentoMapeado {
  id: number;
  CD_Coligada: number;
  CD_Filial: number;
  CD_Terminal_Coleta: number;
}

export const EQUIPAMENTOS_MAPEADOS: EquipamentoMapeado[] = [
  {
    id: 6,
    CD_Coligada: 1,
    CD_Filial: 2,
    CD_Terminal_Coleta: 9006,
  },
  {
    id: 1,
    CD_Coligada: 5,
    CD_Filial: 1,
    CD_Terminal_Coleta: 9003,
  },
  {
    id: 2,
    CD_Coligada: 5,
    CD_Filial: 1,
    CD_Terminal_Coleta: 9004,
  },
  {
    id: 9,
    CD_Coligada: 1,
    CD_Filial: 5,
    CD_Terminal_Coleta: 9005,
  },
  {
    id: 3,
    CD_Coligada: 1,
    CD_Filial: 1,
    CD_Terminal_Coleta: 9007,
  },
  {
    id: 4,
    CD_Coligada: 1,
    CD_Filial: 7,
    CD_Terminal_Coleta: 9001,
  },
  {
    id: 5,
    CD_Coligada: 1,
    CD_Filial: 7,
    CD_Terminal_Coleta: 9002,
  },
];
