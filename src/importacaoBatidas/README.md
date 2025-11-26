# Variáveis de Ambiente - Módulo de Importação de Batidas RHiD

## Configurações necessárias para o módulo de importação automática de AFD

Adicione as seguintes variáveis ao arquivo `.env`:

```bash
# API RHiD - Configurações de acesso
RHID_API_URL=https://api.rhid.com.br
RHID_API_USERNAME=seu_usuario_rhid
RHID_API_PASSWORD=sua_senha_rhid

# TOTVS - Configurações (já existentes no projeto)
urlAPI=http://201.148.210.189:8052/rmsrestdataserver
TotvsAPIAuthorization=Basic UG9ydGFsTWF0cmljdWxhSW50Oms4Szl5cnBINFpRVXZzVg==
```

## Configuração de Equipamentos

Edite o arquivo `src/DpRh/importacaoBatidas/constants/equipamentos.constants.ts` para adicionar os equipamentos que devem ser monitorados:

```typescript
export const EQUIPAMENTOS_MAPEADOS: EquipamentoMapeado[] = [
  {
    id: 5,
    CD_Coligada: 1,
    CD_Filial: 7,
    CD_Terminal_Coleta: 14,
    Nome: 'Nome Equipamento 1',
  },
  {
    id: 10,
    CD_Coligada: 1,
    CD_Filial: 8,
    CD_Terminal_Coleta: 15,
    Nome: 'Nome Equipamento 2',
  },
  // Adicione mais equipamentos conforme necessário
];
```

## Uso

### Importação Automática (Cron)

O módulo executa automaticamente a cada 2 horas (0 _/2 _ \* \*) e processa todos os equipamentos mapeados para a data atual.

### Importação Manual

```http
POST http://localhost:3000/dp-rh/importacao-batidas/processar
Content-Type: application/json

{
  "dataReferencia": "2025-11-24T00:00:00.000Z",
  "equipamentosIds": [5, 10]
}
```

**Parâmetros opcionais:**

- `dataReferencia`: Data para buscar as batidas (padrão: data atual)
- `equipamentosIds`: Array com IDs específicos dos equipamentos (padrão: todos os mapeados)

### Resposta

```json
{
  "dataReferencia": "2025-11-24T00:00:00.000Z",
  "totalEquipamentos": 2,
  "sucessos": 1,
  "falhas": 1,
  "resultados": [
    {
      "equipamentoId": 5,
      "equipamentoNome": "Nome Equipamento 1",
      "sucesso": true,
      "etapa": "completo",
      "mensagem": "Processamento concluído com sucesso",
      "caminhoArquivo": "\\\\22.20.223.222\\Control ID teste\\Importacao teste\\24-11-2025 Nome Equipamento 1.txt",
      "dataProcessamento": "2025-11-24T10:30:00.000Z"
    },
    {
      "equipamentoId": 10,
      "equipamentoNome": "Nome Equipamento 2",
      "sucesso": false,
      "etapa": "download",
      "mensagem": "Falha ao baixar AFD: Request timeout",
      "dataProcessamento": "2025-11-24T10:30:15.000Z"
    }
  ],
  "dataExecucao": "2025-11-24T10:30:15.000Z"
}
```

## Fluxo de Processamento

1. **Autenticação RHiD**: Obtém access token da API
2. **Busca de Equipamentos**: Consulta paginada em `/device` filtrando apenas equipamentos com status "OK"
3. **Download AFD**: Para cada equipamento válido, baixa arquivo AFD via `/report/afd/download`
4. **Salvamento**: Salva arquivo TXT no caminho UNC `\\22.20.223.222\Control ID teste\Importacao teste\`
5. **Importação TOTVS**: Dispara processo de importação na TOTVS via endpoint `executeprocess`
6. **Registro de Logs**: Registra sucessos e falhas detalhados por equipamento

## Observações

- **Duplicatas**: Placeholder incluído no código para futura implementação de remoção de batidas duplicadas
- **Caminho UNC**: O servidor Node.js deve ter acesso de rede ao caminho `\\22.20.223.222\`
- **Erros**: Falhas em equipamentos individuais não impedem o processamento dos demais
- **Timeout**: Configurado para 60 segundos para downloads de arquivos grandes
