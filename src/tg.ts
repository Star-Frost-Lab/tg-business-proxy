const TG_BASE = 'https://api.telegram.org';

export class TelegramAPI {
  constructor(private token: string) {}

  /** 调用任意 Telegram Bot API 方法 */
  async call(method: string, params: Record<string, any> = {}): Promise<any> {
    const url = `${TG_BASE}/bot${this.token}/${method}`;

    // 过滤 undefined/null 值
    const cleaned: Record<string, any> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) cleaned[k] = v;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleaned),
    });

    const result = await response.json() as any;
    return result;
  }

  async getMe() { return this.call('getMe'); }
  async getWebhookInfo() { return this.call('getWebhookInfo'); }

  async setWebhook(webhookUrl: string, secret: string) {
    return this.call('setWebhook', {
      url: webhookUrl,
      secret_token: secret,
      allowed_updates: [
        'business_connection',
        'business_message',
        'edited_business_message',
        'deleted_business_messages',
        'guest_message',
        'message',
      ],
      drop_pending_updates: false,
    });
  }

  async deleteWebhook() {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  async sendMessage(p: Record<string, any>) { return this.call('sendMessage', p); }
  async editMessageText(p: Record<string, any>) { return this.call('editMessageText', p); }
  async deleteMessage(p: Record<string, any>) { return this.call('deleteMessage', p); }
  async getBusinessConnection(id: string) { return this.call('getBusinessConnection', { business_connection_id: id }); }
  async readBusinessMessage(p: Record<string, any>) { return this.call('readBusinessMessage', p); }
  async deleteBusinessMessages(p: Record<string, any>) { return this.call('deleteBusinessMessages', p); }
}
