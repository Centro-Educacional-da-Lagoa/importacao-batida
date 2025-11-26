# Plano de Implementação: Integração com Google Drive para Importação de Batidas

## 1. Visão Geral

Este documento descreve o plano para refatorar o módulo `importacaoBatidas` para utilizar o Google Drive como o **único repositório** para salvar os arquivos AFD (Arquivo Fonte de Dados).

O novo fluxo será:
1.  O arquivo AFD é baixado do RHiD.
2.  O conteúdo do arquivo é **exclusivamente salvo no Google Drive**, com uma lógica para criar o arquivo se ele não existir ou atualizá-lo se já existir.
3.  Ao chamar a API do TOTVS, o `FilePath` será construído dinamicamente a partir de uma variável de ambiente (`PATH_IMPORTACAO_TOTVS`) e o nome do arquivo.

Esta abordagem desacola a aplicação da escrita em sistemas de arquivos locais ou de rede, delegando a responsabilidade de disponibilizar o arquivo para o TOTVS a um processo externo (ex: um cliente Google Drive Sync em um servidor). A aplicação apenas notifica o TOTVS sobre o local esperado do arquivo.

## 2. Estrutura de Módulos e Arquivos

A estrutura proposta permanece:
```
src/
├── app.module.ts
├── ...
├── google-drive/
│   ├── google-drive.module.ts
│   └── google-drive.service.ts
└── importacaoBatidas/
    ├── ...
```

## 3. Plano de Implementação

### Passo 1: Configuração do Ambiente

1.  **Instalar Dependências**:
    ```bash
    yarn add googleapis google-auth-library
    ```
2.  **Variáveis de Ambiente**: Adicionar/atualizar as seguintes variáveis no arquivo `.env`.
    ```env
    # Google Drive API
    GOOGLE_SERVICE_ACCOUNT_EMAIL=seu-service-account-email@seu-projeto.iam.gserviceaccount.com
    GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nSUA_CHAVE_PRIVADA\n-----END PRIVATE KEY-----\n"
    GOOGLE_DRIVE_FOLDER_ID=id_da_pasta_no_google_drive

    # Caminho base que o TOTVS usará para encontrar o arquivo.
    # A aplicação NÃO escreverá neste caminho.
    PATH_IMPORTACAO_TOTVS=\\servidor-totvs\share\importacao\
    ```

### Passo 2: Criar o `GoogleDriveModule`

1.  **Criar `src/google-drive/google-drive.service.ts`**:
    - Implementar a classe `GoogleDriveService`.
    - No construtor, inicializar o cliente da API do Google Drive (`google.auth.JWT`).
    - Criar um método `uploadOrUpdateFile(fileName: string, content: string, mimeType: string): Promise<{id: string, webViewLink: string}>`. A lógica será:
        a. **Buscar arquivo existente**: Usar `drive.files.list` com o parâmetro `q` para buscar um arquivo com o mesmo `fileName` dentro do `GOOGLE_DRIVE_FOLDER_ID`.
        b. **Atualizar ou Criar**:
           - Se o arquivo for encontrado, usar `drive.files.update` para atualizar seu conteúdo.
           - Se não for encontrado, usar `drive.files.create` para criar um novo arquivo.
        c. **Retornar Metadados**: Após a operação, retornar `id` e `webViewLink` do arquivo como confirmação.

2.  **Criar `src/google-drive/google-drive.module.ts`**:
    - Declarar o `GoogleDriveModule`, prover e exportar o `GoogleDriveService`.

### Passo 3: Integrar `GoogleDriveService` em `ImportacaoBatidasModule`

1.  **Atualizar `src/importacaoBatidas/importacaoBatidas.module.ts`**:
    - Importar o `GoogleDriveModule`.

2.  **Atualizar `src/importacaoBatidas/importacaoBatidas.service.ts`**:
    - Injetar `GoogleDriveService` no construtor.
    - **Remover completamente** as dependências e lógicas relacionadas a `fs` e `smb2` e as variáveis de ambiente `UNC_PATH`, `SMB_USERNAME`, `SMB_PASSWORD`, e `SMB_DOMAIN`.
    - Renomear o método `salvarAfd` para `salvarAfdToGoogleDrive`.
        - Este método chamará `this.googleDriveService.uploadOrUpdateFile()` e retornará o `webViewLink` do arquivo.
    - **Refatorar `executarImportacaoTotvs`**:
        - O método não receberá mais o `caminhoArquivo` como parâmetro. Ele receberá o `nomeArquivo`.
        - Dentro do método, o `filePathTotvs` será construído assim: `const filePathTotvs = path.join(process.env.PATH_IMPORTACAO_TOTVS, nomeArquivo);`.
    - **Refatorar `processarEquipamento`**:
        a. Após baixar o `conteudoAfd`, gerar o `nomeArquivo`.
        b. Chamar `salvarAfdToGoogleDrive(conteudoAfd, nomeArquivo)` para salvar o arquivo no Google Drive e obter o `caminhoDrive`.
        c. Chamar `executarImportacaoTotvs` passando o `equipamentoMapeado`, `equipamentoRhid`, `nomeArquivo` e `dataReferencia`.
        d. No objeto de resultado final (`ResultadoProcessamentoEquipamento`), o campo `caminhoArquivo` será o `caminhoDrive` retornado na etapa 'b'.

## 4. Análise de Impacto

- **Remoção de Complexidade**: A lógica de escrita em sistemas de arquivos locais/de rede é removida, simplificando o código e as dependências (`fs`, `smb2`).
- **`importacaoBatidas.service.ts`**: A principal mudança é a simplificação do salvamento e a alteração na construção do payload para o TOTVS.
- **`dto/processar-afd.dto.ts`**: O campo `caminhoArquivo` na interface `ResultadoProcessamentoEquipamento` conterá a URL do arquivo no Google Drive, servindo como um link de referência permanente e auditável.
- **Dependência Externa**: O sucesso da importação no TOTVS passa a depender de um **processo externo** que sincroniza os arquivos do Google Drive para o caminho `PATH_IMPORTACAO_TOTVS`. A aplicação não terá controle ou visibilidade sobre essa sincronização.

## 5. Próximos Passos

1.  Implementar o `GoogleDriveModule` e o `GoogleDriveService` com a lógica de criar/atualizar.
2.  Refatorar o `ImportacaoBatidasService` para remover a escrita em arquivo local e integrar o `GoogleDriveService`.
3.  Ajustar a chamada ao `executarImportacaoTotvs` para construir o caminho dinamicamente.
4.  Testar o fluxo de ponta a ponta.
5.  Atualizar a documentação (README.md) para refletir as novas variáveis de ambiente e o fluxo de trabalho.
