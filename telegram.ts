/**
 * Telegram Bot API minimal (fetch natif, zéro dépendance) : file d'envoi
 * cadencée (~1 msg/s — limite Telegram ~30/s, mais on reste poli) + polling
 * getUpdates pour les commandes (/start /ping /status).
 */
const API = (token: string, method: string) => `https://api.telegram.org/bot${token}/${method}`;

export class Telegram {
  private queue: Array<{ text: string; chatId: string }> = [];
  private flushing = false;
  private offset = 0;
  /** Derniers messages envoyés (anti-spam / debug /status). */
  readonly sentLog: Array<{ at: number; text: string }> = [];

  constructor(
    private readonly token: string | undefined,
    private readonly chatId: string | undefined,
    private readonly dryRun: boolean,
  ) {}

  get enabled(): boolean {
    return !this.dryRun && !!this.token && !!this.chatId;
  }

  /** Enfile un message (départ immédiat en arrière-plan). */
  send(text: string): void {
    const stamp = `[${new Date().toISOString().slice(11, 19)}] ${text}`;
    console.log(stamp.replace(/\n/g, ' | '));
    this.sentLog.push({ at: Date.now(), text });
    if (this.sentLog.length > 200) this.sentLog.splice(0, this.sentLog.length - 200);
    if (!this.enabled) return;
    this.queue.push({ text, chatId: this.chatId! });
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const msg = this.queue.shift()!;
        try {
          const res = await fetch(API(this.token!, 'sendMessage'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: msg.chatId, text: msg.text, disable_web_page_preview: true }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) console.error(`[telegram] sendMessage HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        } catch (err) {
          console.error('[telegram] send failed:', err instanceof Error ? err.message : err);
        }
        await new Promise((r) => setTimeout(r, 1100));
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Polling des commandes — appelle le handler, gère l'offset. */
  async pollCommands(handler: (command: string, chatId: string) => void): Promise<void> {
    if (!this.token) return;
    try {
      const res = await fetch(`${API(this.token, 'getUpdates')}?timeout=25&offset=${this.offset}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as {
        ok: boolean;
        result?: Array<{ update_id: number; message?: { chat: { id: number }; text?: string } }>;
      };
      for (const upd of json.result ?? []) {
        this.offset = upd.update_id + 1;
        const text = upd.message?.text?.trim() ?? '';
        if (text.startsWith('/')) handler(text.split(/\s+/)[0], String(upd.message?.chat.id ?? ''));
      }
    } catch {
      // timeout réseau / démarrage à froid — la boucle rappellera
    }
  }

  async reply(chatId: string, text: string): Promise<void> {
    if (!this.token) return;
    try {
      await fetch(API(this.token, 'sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      console.error('[telegram] reply failed:', err instanceof Error ? err.message : err);
    }
  }
}
