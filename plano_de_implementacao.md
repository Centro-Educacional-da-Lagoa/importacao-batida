# Plano de Implementação: Rotina de Notificação de Status de Job

Este documento descreve o plano técnico para implementar uma rotina automatizada que monitora processos de importação, atualiza seus status e envia notificações para um space no Google Chat.

A implementação será modular e fará uso de filas para garantir a robustez e o desacoplamento dos processos.

## Arquitetura Proposta

A solução será dividida em 3 componentes principais:

1.  **Agendador (`Scheduler`):** Um processo periódico que verifica o banco de dados em busca de trabalhos que precisam de atenção.
2.  **Fila de Processamento (`Queue`):** Uma fila (usando Bull) para gerenciar as tarefas de verificação de cada job individualmente. Isso evita sobrecarga e permite reprocessamentos.
3.  **Processador da Fila (`Consumer`):** Um worker que consome as tarefas da fila, executa a lógica de negócio (verificar status, buscar logs) e interage com serviços externos.
4.  **Serviços de Suporte:**
    *   **`PrismaService`:** O serviço existente será usado para acessar tanto o banco de dados da aplicação quanto para executar consultas brutas (`$queryRaw`) no banco de dados legado `corpore_erp_manutencao`.
    *   **`ChatService`:** O serviço existente para envio de mensagens ao Google Chat.

---

## Passo a Passo da Implementação

### 1. Estrutura do Módulo e Configuração

- **Criar novo módulo:** Toda a lógica será encapsulada em um novo módulo `NotificacaoRotinaModule`.
  - `src/notificacao-rotina/notificacao-rotina.module.ts`
  - `src/notificacao-rotina/notificacao-rotina.service.ts` (conterá o agendador)
  - `src/notificacao-rotina/notificacao.processor.ts` (conterá o consumidor da fila)

- **Configurar a Fila (Bull):**
  - Em `notificacao-rotina.module.ts`, registrar a fila: `BullModule.registerQueue({ name: 'notificacao' })`.
  - Importar o `ChatModule` e o `PrismaModule` para que seus serviços fiquem disponíveis.

- **Variáveis de Ambiente (`.env`):** Adicionar a seguinte variável para o Google Chat. A conexão com o banco de dados `corpore` já é esperada estar funcionando através do `PrismaService`.

  ```bash
  # Google Chat
  GOOGLE_CHAT_SPACE_WEBHOOK=
  ```

### 2. Acesso ao Banco de Dados Externo

- **Utilizar `PrismaService`:** Conforme o padrão já existente em `importacaoBatidas.service.ts`, as consultas ao banco de dados `corpore_erp_manutencao` serão feitas utilizando o método `this.prismaService.$queryRaw`.
- Não será criado um novo serviço de conexão ou instalado um novo driver de banco de dados. As funções para buscar status e logs do job serão métodos privados dentro do `NotificacaoProcessor`.

### 3. O Agendador (Produtor da Fila)

- **Local:** `NotificacaoRotinaService` (`src/notificacao-rotina/notificacao-rotina.service.ts`).
- **Lógica:**
    - Usar o decorador `@Cron()` (ex: `@Cron('*/5 * * * *')` para rodar a cada 5 minutos).
    - No método agendado, usar o `PrismaService` para buscar os processos na `tb_mdp_processo_importacao_batida` com os critérios:
        - `in_notificacao_enviada = false`
        - `id_status_job IN (0, 1, 3, 4, 5, 6, 7, 8, 9)`
    - Para cada processo encontrado, adicionar um job à fila `'notificacao'` com os dados do processo como payload.

### 4. O Processador da Fila (Consumidor)

- **Local:** `NotificacaoProcessor` (`src/notificacao-rotina/notificacao.processor.ts`).
- **Lógica:**
    - Usar os decoradores `@Processor('notificacao')` na classe e `@Process()` em um método para processar os jobs.
    - O método receberá o `job` da fila.
    - **Passo 1: Buscar Status Atual:** Usar `prismaService.$queryRaw` para obter o status mais recente do job no banco de dados `corpore`.
    - **Passo 2: Comparar e Atualizar Status:**
        - Se o status retornado do `corpore` for diferente do status na `tb_mdp_processo_importacao_batida`, atualizar a tabela local via `PrismaService`.
    - **Passo 3: Lógica de Notificação:**
        - Se o **novo status** (resultante da consulta ao `corpore`) estiver no intervalo de `3` a `9`:
            1.  **Buscar Dados Locais:** Obter todos os dados do processo do job, incluindo `ID_Job`, `CD_Coligada_Execucao`, `NM_Equipamento` e o `TX_Arquivo` (em Base64) da `tb_mdp_processo_importacao_batida`.
            2.  **Buscar Logs Externos:** Usar `prismaService.$queryRaw` para buscar todos os logs associados ao `ID_Job` na tabela `CORPORE_ERP_MANUTENCAO.dbo.gjobxlog`.
            3.  **Processar Arquivo de Importação (AFD):**
                - Decodificar o `TX_Arquivo` de Base64 para texto.
                - Usar o `GoogleDriveService` para fazer o upload desse conteúdo como um arquivo (ex: `AFD-Job-${ID_Job}.txt`).
                - Obter o link compartilhável (`webViewLink`) para este arquivo.
            4.  **Processar Logs:**
                - Criar uma lista de links para os logs.
                - Iterar sobre cada log retornado do `gjobxlog`.
                - Decodificar o `TX_Conteudo_Log` de Base64 para texto.
                - Fazer o upload do conteúdo do log como um arquivo (ex: `Log-${TX_Log}-Job-${ID_Job}.txt`) via `GoogleDriveService`.
                - Adicionar o `webViewLink` do log à lista.
            5.  **Formatar Mensagem para o Google Chat:**
                - Construir a string da mensagem, usando a formatação do Google Chat.
                - A mensagem deve conter:
                    - `*ID Job:* ${job.ID_Job}`
                    - `*Coligada:* ${job.CD_Coligada_Execucao}`
                    - `*Equipamento:* ${job.NM_Equipamento}`
                    - `*Status:* ${novoStatus}`
                    - `*Arquivo de Importação:* <${linkDoArquivoAfd}|Clique para ver>`
                    - `*Logs do Processo:*` (seguido por uma lista de links para cada log: `<${linkDoLog}|${nomeDoLog}>`)
            6.  **Enviar Notificação:** Passar a URL do webhook do Space e a mensagem formatada para o `chatService.sendChatWebhook`.
            7.  **Atualizar Flag:** Se o envio for bem-sucedido (`try/catch`), atualizar o campo `in_notificacao_enviada` para `true` na `tb_mdp_processo_importacao_batida` usando `PrismaService`.

### 5. Integração Final

- **Importar Módulos:** No `AppModule`, importar o `NotificacaoRotinaModule`.
- **Garantir Disponibilidade:** Assegurar que os módulos importados (`ConfigModule`, `BullModule`) estejam configurados como globais ou sejam importados onde necessário.

---

Este plano cobre todas as funcionalidades solicitadas, criando uma solução robusta e escalável para a automação da rotina de notificação.