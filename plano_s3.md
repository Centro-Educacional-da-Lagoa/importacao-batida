# Plano de Implementação: Armazenamento de Logs em S3

Este documento descreve o plano técnico para integrar o armazenamento de arquivos de log de processos da TOTVS em um serviço de armazenamento de objetos compatível com S3 (como AWS S3 ou Vultr).

## 1. Análise do Código de Upload Existente

O módulo `@src/upload/**` fornecido usa o `aws-sdk` para se comunicar com o S3. As operações principais são:

- **Conexão:** O serviço `upload.service.ts` já configura um cliente S3 usando as variáveis de ambiente `VULTR_S3_HOST`, `VULTR_S3_ACCESS_KEY_ID`, e `VULTR_S3_SECRET_ACCESS_KEY`.
- **Upload (Criar):** A função principal é a `s3.upload(params).promise()`. Ela envia um arquivo para o S3 e, em caso de sucesso, retorna um objeto `ManagedUpload.SendData`.

O retorno do `s3.upload()` contém os dados que precisamos armazenar para gerenciar o arquivo.

## 2. O que Salvar na Tabela de Banco de Dados?

### Entendendo a 'Chave S3' (S3 Key)

Sua pergunta sobre a `S3_Key` é muito importante. É um ponto que gera confusão.

**Resposta curta:** Não, o S3 **não gera um ID único** para um arquivo como um banco de dados faz para uma nova linha (ex: `ID_Log_Arquivo`).

A `S3_Key` (ou "Chave S3") é o **nome completo do arquivo, incluindo o caminho (pastas), que nós mesmos definimos ao fazer o upload**. Pense no S3 como um HD gigante:
- O `Bucket` é o próprio HD (ex: `D:`).
- A `Key` é o caminho completo do arquivo nesse HD (ex: `D:\documentos\fiscais\nota_123.pdf`).

Quando fazemos o upload, nós **precisamos** dizer ao S3 qual o `Bucket` e qual a `Key` do arquivo. Se não fornecermos uma `Key`, o S3 não sabe como salvar o arquivo e a operação falha.

O que o S3 retorna na resposta do upload é a **confirmação** da `Key` que usamos, junto com outras informações como a URL pública (`Location`) e um `ETag` (um hash do conteúdo do arquivo). Mas o identificador principal que usaremos para ler ou deletar o arquivo é a `Key` que nós mesmos criamos.

---

Para identificar, ler e remover cada arquivo de log de forma única e segura, a sua nova tabela (ex: `TB_Mdp_Log_Arquivo_S3`) deve conter os seguintes campos:

| Nome da Coluna         | Tipo de Dado   | Descrição                                                                                                                                                             | Exemplo                                        |
| ---------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **`ID_Log_Arquivo`**   | `int`, `PK`    | Chave primária da tabela.                                                                                                                                             | `1`                                            |
| **`ID_Job`**           | `int`, `FK`    | Chave estrangeira para associar o arquivo de log ao job específico que o gerou.                                                                                       | `5060905`                                      |
| **`S3_Bucket`**        | `varchar(255)` | O nome do bucket S3 onde o arquivo está armazenado. Essencial para as operações de API.                                                                               | `importacao-batida`                            |
| **`S3_Key`**           | `varchar(1024)`| O caminho completo (`path + filename`) do objeto dentro do bucket. **Este não é um ID gerado pelo S3**, mas sim o **identificador único que nós definimos ao fazer o upload**. | `logs/job-5060905_log.txt`                     |
| **`S3_Location_Url`**  | `varchar(2048)`| A URL pública completa para acesso direto ao arquivo. Útil para links de download/visualização.                                                                       | `https://s3.host.com/bucket/caminho/arquivo.txt` |
| **`S3_Etag`**          | `varchar(255)` | (Opcional) O hash do arquivo retornado pelo S3. Útil para verificar a integridade do arquivo.                                                                         | `"a1b2c3d4e5f6..."`                          |
| **`NM_Arquivo_Original`**| `varchar(255)` | (Opcional) O nome original do log, se houver, para referência.                                                                                                    | `gjobxlog.log`                                 |
| **`DH_Criacao`**       | `datetime`     | Timestamp de quando o registro foi criado no banco de dados.                                                                                                          | `2025-11-27 10:00:00`                          |

**Conclusão:** Os campos **`S3_Bucket`** e **`S3_Key`** são **obrigatórios** para conseguir usar as funções de busca e remoção via API. `S3_Location_Url` é extremamente útil para leitura.

---

## 3. Funções a Serem Implementadas

Com base na análise, aqui estão as três funções essenciais que você precisará implementar no seu serviço.

### a. `uploadLogParaS3` (Criar)

Esta função receberá o conteúdo do log, o ID do job associado e criará o arquivo no S3 e o registro no banco.

```typescript
async function uploadLogParaS3(jobId: number, conteudoLog: string, nomeArquivo: string): Promise<any> {
  // 1. Definir os parâmetros para o S3
  const bucketName = 'importacao-batida';
  const s3Key = `logs/${nomeArquivo}`; // Estrutura de pastas conforme solicitado

  const s3Params = {
    Bucket: bucketName,
    Key: s3Key,
    Body: conteudoLog,
    ContentType: 'text/plain',
    ACL: 'public-read', // ou 'private' se o acesso for restrito
  };

  // 2. Fazer o upload para o S3
  const s3Response = await s3.upload(s3Params).promise();
  // s3Response contém: Location, Key, Bucket, ETag

  // 3. Salvar as informações no banco de dados
  const novoRegistro = await prisma.tB_Mdp_Log_Arquivo_S3.create({
    data: {
      ID_Job: jobId,
      S3_Bucket: s3Response.Bucket,
      S3_Key: s3Response.Key,
      S3_Location_Url: s3Response.Location,
      S3_Etag: s3Response.ETag,
      NM_Arquivo_Original: nomeArquivo,
    },
  });

  return novoRegistro;
}
```

### b. `buscarUrlLogS3` (Ler/Buscar)

Para buscar o arquivo, basta ler a URL que já está salva no banco. Não é necessário chamar a API do S3 se os arquivos são públicos.

```typescript
async function buscarUrlLogS3(idLogArquivo: number): Promise<string | null> {
  const registro = await prisma.tB_Mdp_Log_Arquivo_S3.findUnique({
    where: { ID_Log_Arquivo: idLogArquivo },
  });

  // Retorna a URL para ser usada em um link <a> no frontend, por exemplo
  return registro ? registro.S3_Location_Url : null;
}
```

### c. `removerLogS3` (Remover)

Esta função removerá o arquivo do S3 e, em seguida, o registro do seu banco de dados.

```typescript
async function removerLogS3(idLogArquivo: number): Promise<void> {
  // 1. Buscar as informações do arquivo no banco de dados
  const registro = await prisma.tB_Mdp_Log_Arquivo_S3.findUnique({
    where: { ID_Log_Arquivo: idLogArquivo },
  });

  if (!registro) {
    throw new Error('Arquivo de log não encontrado no banco de dados.');
  }

  // 2. Definir os parâmetros para a remoção no S3
  const s3Params = {
    Bucket: registro.S3_Bucket,
    Key: registro.S3_Key,
  };

  // 3. Chamar a função de delete do S3
  await s3.deleteObject(s3Params).promise();

  // 4. Se a remoção no S3 foi bem-sucedida, remover o registro do banco
  await prisma.tB_Mdp_Log_Arquivo_S3.delete({
    where: { ID_Log_Arquivo: idLogArquivo },
  });
}
```
