# Plano de Implementação: Armazenamento de Arquivos de Importação em S3 (Revisado)

Este documento descreve o plano revisado para armazenar os arquivos de importação (AFD) em S3, focando em uma arquitetura limpa e dedicada para esta funcionalidade.

## 1. Objetivo

O objetivo é alterar o `ImportacaoBatidasService` para que o arquivo AFD seja enviado para um bucket S3. As informações de referência (bucket, chave, URL) serão salvas na tabela `TB_MDP_Processo_Importacao_Batida`, substituindo o armazenamento do arquivo em Base64 na própria tabela.

## 2. Refatoração: Criação de um Módulo S3 Dedicado

Em vez de usar e adaptar o módulo `@src/upload` (que contém muitas funcionalidades desnecessárias para este projeto, como manipulação de `multer`, otimização de PDFs/imagens e rotas de controller), o plano agora é **criar um módulo novo e enxuto, dedicado exclusivamente à comunicação com o S3.**

**Vantagens:**
- **Código Limpo:** O novo módulo terá apenas o que é necessário para o upload.
- **Manutenção Simplificada:** Fica mais fácil de entender e dar manutenção.
- **Reutilização:** Um serviço de S3 genérico pode ser facilmente reutilizado em outras partes da aplicação no futuro.

**Ação:** Criar uma nova pasta `src/s3` com os arquivos `s3.module.ts` e `s3.service.ts`.

## 3. Implementação do Novo Módulo S3

### a. `s3.service.ts`

Este serviço irá conter a configuração do cliente S3 e os métodos para interagir com o bucket.

```typescript
// src/s3/s3.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { S3, Endpoint } from 'aws-sdk';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3: S3;

  constructor() {
    // A configuração do cliente S3 fica isolada neste serviço.
    const spacesEndpoint = new Endpoint(process.env.VULTR_S3_HOST);
    this.s3 = new S3({
      endpoint: spacesEndpoint,
      accessKeyId: process.env.VULTR_S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.VULTR_S3_SECRET_ACCESS_KEY,
    });
  }

  /**
   * Faz o upload de um conteúdo de arquivo para o S3.
   * @param bucket O nome do bucket.
   * @param key O caminho completo (path + filename) do arquivo no bucket.
   * @param body O conteúdo do arquivo (string ou buffer).
   * @returns A resposta do S3, contendo Location, Key, Bucket, etc.
   */
  async upload(bucket: string, key: string, body: Buffer | string, contentType: string) {
    const params = {
      Bucket: bucket,
      Key: key,
      Body: body,
      ACL: 'public-read',
      ContentType: contentType,
      ContentDisposition: 'inline',
    };

    try {
      this.logger.log(`Fazendo upload para S3: Bucket=${bucket}, Key=${key}`);
      const response = await this.s3.upload(params).promise();
      this.logger.log(`Upload concluído com sucesso. URL: ${response.Location}`);
      return response;
    } catch (error) {
      this.logger.error(`Falha no upload para S3. Bucket=${bucket}, Key=${key}`, error.stack);
      throw new Error(`Falha no upload para o S3: ${error.message}`);
    }
  }

  // Futuramente, outros métodos como delete() podem ser adicionados aqui.
}
```

### b. `s3.module.ts`

Este módulo irá prover o `S3Service` para o resto da aplicação. Vamos marcá-lo como `@Global` para que o `S3Service` possa ser injetado em qualquer lugar sem a necessidade de importar o `S3Module` em cada módulo específico.

```typescript
// src/s3/s3.module.ts
import { Module, Global } from '@nestjs/common';
import { S3Service } from './s3.service';

@Global()
@Module({
  providers: [S3Service],
  exports: [S3Service],
})
export class S3Module {}
```

## 4. Plano de Alterações em `ImportacaoBatidasService`

Com o novo `S3Service` disponível, a integração fica muito mais limpa.

### a. Injetar `S3Service` e `ConfigService`
- No construtor de `ImportacaoBatidasService`, injete os serviços necessários.

```typescript
// src/importacaoBatidas/importacaoBatidas.service.ts
import { S3Service } from '../s3/s3.service';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';


// ...

export class ImportacaoBatidasService {
  // ...
  constructor(
    // ... outros serviços
    private readonly s3Service: S3Service,
    private readonly configService: ConfigService,
  ) {
    // ...
  }
  // ...
}
```

### b. Modificar o método `executarImportacaoTotvs`
A alteração principal continua no bloco `finally` deste método.

```typescript
// Dentro do método executarImportacaoTotvs, no bloco finally

// ...
} finally {
  try {
    // ... (busca do jobResult)

    if (jobResult && jobResult.length > 0) {
      const jobInfo = jobResult[0];

      // --- INÍCIO DA NOVA LÓGICA ---

      // 1. Construir o nome do arquivo para o S3
      const dataFormatada = this.formatarDataBR(dataReferencia);
      const nomeArquivoS3 = `${dataFormatada} ${equipamentoRhid.name} ${randomUUID()}.txt`;

      // 2. Fazer o upload do arquivo AFD para o S3
      const bucket = this.configService.get<string>('S3_BUCKET_NAME');
      if (!bucket) {
        throw new Error('S3_BUCKET_NAME não está configurado nas variáveis de ambiente.');
      }
      
      const pasta = 'afd-importacao';
      const s3Key = `${pasta}/${nomeArquivoS3}`;

      const s3Response = await this.s3Service.upload(
        bucket,
        s3Key,
        conteudoAfd,
        'text/plain',
      );

      // 3. Modificar o INSERT para incluir os dados do S3
      await this.prismaService.$executeRaw`
          INSERT INTO BD_SINERGIA.dbo.TB_MDP_Processo_Importacao_Batida (
              ID_Job, ..., NM_S3_Bucket_Arquivo, CD_S3_Key_Arquivo, TX_S3_URL_Arquivo
          ) VALUES (
              ${jobInfo.ID_Job}, ..., ${s3Response.Bucket}, ${s3Response.Key}, ${s3Response.Location}
          )
      `;
      // ... (Resto dos campos do INSERT)

      // --- FIM DA NOVA LÓGICA ---
    }
    // ...
  } catch (logError) {
    // ...
  }
}
```

## 5. Adicionar Variável de Ambiente

Adicione a seguinte linha ao seu arquivo `.env` para configurar o nome do bucket.

```
S3_BUCKET_NAME=importacao-batida
```

## 6. Limpeza Final

Após a implementação e teste da nova estrutura, o diretório `@src/upload` pode ser **removido** do projeto para evitar confusão e manter a base de código limpa.