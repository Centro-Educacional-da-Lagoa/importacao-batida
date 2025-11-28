import { Injectable } from '@nestjs/common';

@Injectable()
export class ChatService {
  async sendChatWebhook(spaceId: string, message: string) {
    const res = await fetch(spaceId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: message }),
    });
    return await res.json();
  }
}
