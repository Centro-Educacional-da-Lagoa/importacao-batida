import { Injectable, Logger } from '@nestjs/common';
import { S3, Endpoint } from 'aws-sdk';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly s3: S3;

  constructor() {
    const host = process.env.VULTR_S3_HOST;
    const accessKeyId = process.env.VULTR_S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.VULTR_S3_SECRET_ACCESS_KEY;

    if (!host || !accessKeyId || !secretAccessKey) {
      this.logger.error('Missing VULTR S3 configuration');
      throw new Error('Missing VULTR S3 configuration');
    }
    // A configuração do cliente S3 fica isolada neste serviço.
    const spacesEndpoint = new Endpoint(host);
    this.s3 = new S3({
      endpoint: spacesEndpoint,
      accessKeyId: accessKeyId,
      secretAccessKey: secretAccessKey,
    });
  }

  /**
   * Faz o upload de um conteúdo de arquivo para o S3.
   * @param bucket O nome do bucket.
   * @param key O caminho completo (path + filename) do arquivo no bucket.
   * @param body O conteúdo do arquivo (string ou buffer).
   * @param contentType O MimeType do arquivo
   * @returns A resposta do S3, contendo Location, Key, Bucket, etc.
   */
  async upload(
    bucket: string,
    key: string,
    body: Buffer | string,
    contentType: string,
  ) {
    const params = {
      Bucket: bucket,
      Key: key,
      Body: body,
      ACL: 'public-read',
      ContentType: contentType,
      ContentDisposition: 'inline',
    };

    try {
      console.log(`Fazendo upload para S3: Bucket=${bucket}, Key=${key}`);
      const response = await this.s3.upload(params).promise();
      console.log(`Upload concluído com sucesso. URL: ${response.Location}`);
      return response;
    } catch (error) {
      console.error(
        `Falha no upload para S3. Bucket=${bucket}, Key=${key}`,
        error.stack,
      );
      throw new Error(`Falha no upload para o S3: ${error.message}`);
    }
  }

  // Futuramente, outros métodos como delete() podem ser adicionados aqui.
}
