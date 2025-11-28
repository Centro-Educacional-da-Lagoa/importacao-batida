import { Module, Global } from '@nestjs/common';
import { ChatService } from './chat.service';

@Global()
@Module({
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}