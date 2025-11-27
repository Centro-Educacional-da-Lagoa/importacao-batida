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
import { PrismaService } from './prisma/prisma.service';

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
  ],

  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ApiKeyGuard,
    },
    PrismaService,
  ],
  exports: [PrismaService],
})
export class AppModule {}
