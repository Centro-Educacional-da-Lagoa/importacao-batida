import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GoogleDriveModule } from './google-drive/google-drive.module';
import { ImportacaoBatidasModule } from './importacaoBatidas/importacaoBatidas.module';
import { AuthModule } from './auth/auth.module';
import { APP_GUARD } from '@nestjs/core';
import { ApiKeyGuard } from './auth/api-key.guard';
import { ScheduleModule } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { PrismaModule } from './prisma/prisma.module';
import { NotificacaoRotinaModule } from './notificacao-rotina/notificacao-rotina.module';
import { ChatModule } from './google/chat/chat.module';
import { S3Module } from './s3/s3.module';

@Module({
  imports: [
    AuthModule,
    GoogleDriveModule,
    ImportacaoBatidasModule,
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true, // Garante que as variáveis estejam disponíveis globalmente
    }),
    BullModule.forRoot({
      redis: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
        password: process.env.REDIS_PASSWORD,
      },
    }),
    PrismaModule,
    NotificacaoRotinaModule,
    ChatModule,
    S3Module,
  ],

  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
  ],
})
export class AppModule {}
