import { BrowserWindow, app } from "electron";
import fs from "node:fs";
import path from "node:path";
import keytar from "keytar";

export type TelegramBridgeStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "invalid-token"
  | "not-paired"
  | "webhook-conflict"
  | "error";

export type TelegramInteractionMode = "template" | "ai";

export interface TelegramBridgeSettings {
  enabled: boolean;
  language: "en" | "ru";
  useDefaultAI: boolean;
  aiProvider: "ollama" | "openrouter";
  localModel: string;
  cloudModel: string;
}

export interface TelegramStatusSnapshot {
  status: TelegramBridgeStatus;
  enabled: boolean;
  hasToken: boolean;
  bot?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  pairedChat?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  pairingCode?: string;
  pairingExpiresAt?: string;
  interactionMode: TelegramInteractionMode;
  message?: string;
}

interface TelegramStoredState {
  offset: number;
  interactionMode?: TelegramInteractionMode;
  pairedChat?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  bot?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  liveUiMessageId?: number;
}

interface TelegramMessageRequest {
  id: string;
  chatId: number;
  messageId: number;
  text: string;
  interactionMode: TelegramInteractionMode;
}

interface TelegramDecisionRequest {
  id: string;
  proposalId: string;
  decision: "confirm" | "cancel";
  chatId: number;
}

interface TelegramCallbackRequest {
  id: string;
  chatId: number;
  data: string;
  interactionMode: TelegramInteractionMode;
}

interface TelegramResponseButton {
  text: string;
  callbackData: string;
}

type RendererRequest =
  | { type: "message"; payload: TelegramMessageRequest }
  | { type: "decision"; payload: TelegramDecisionRequest }
  | { type: "callback"; payload: TelegramCallbackRequest };

type RendererResponse =
  | { ok: true; kind: "message"; text: string }
  | { ok: true; kind: "buttons"; text: string; buttons: TelegramResponseButton[][] }
  | { ok: true; kind: "proposal"; proposalId: string; text: string }
  | { ok: false; text: string };

const serviceName = "Aevum";
const tokenAccount = "telegram-bot-token";
const apiBase = "https://api.telegram.org";
const pairingTtlMs = 10 * 60_000;

export class TelegramBridge {
  private settings: TelegramBridgeSettings = {
    enabled: false,
    language: "en",
    useDefaultAI: true,
    aiProvider: "ollama",
    localModel: "qwen3.5:9b",
    cloudModel: "openrouter/free",
  };
  private state: TelegramStoredState = { offset: 0 };
  private status: TelegramBridgeStatus = "disabled";
  private statusMessage = "";
  private pairingCode = "";
  private pairingExpiresAt = 0;
  private pollAbort: AbortController | null = null;
  private isPolling = false;
  private sessionGeneration = 0;
  private rendererReady = false;
  private queuedRendererRequests: RendererRequest[] = [];
  private pendingRendererResponses = new Map<string, (value: RendererResponse) => void>();

  constructor(private readonly broadcast: (channel: string, payload: unknown) => void) {
    this.state = this.loadState();
  }

  async setSettings(settings: Partial<TelegramBridgeSettings>) {
    this.settings = { ...this.settings, ...settings };
    if (settings.enabled !== undefined) {
      if (!this.settings.enabled) {
        this.stopPolling();
        this.status = "disabled";
        this.broadcastStatus();
        return this.getStatusAsync();
      } else {
        await this.ensurePolling();
      }
    }
    return this.getStatusAsync();
  }

  async connectToken(value: unknown) {
    const token = typeof value === "string" ? value.trim() : "";
    this.status = "connecting";
    this.statusMessage = "";
    this.broadcastStatus();

    this.stopPolling();

    if (!isTelegramToken(token)) {
      this.status = "invalid-token";
      this.statusMessage = "Invalid Telegram bot token.";
      this.broadcastStatus();
      return { ok: false, ...(await this.getStatusAsync()) };
    }

    const bot = await this.telegramRequestWithToken(token, "getMe", {});
    if (!bot.ok || !isRecord(bot.result)) {
      this.status = "invalid-token";
      this.statusMessage = readTelegramDescription(bot) || "Telegram rejected this bot token.";
      this.broadcastStatus();
      return { ok: false, ...(await this.getStatusAsync()) };
    }

    await keytar.setPassword(serviceName, tokenAccount, token);
    this.state.bot = {
      id: typeof bot.result.id === "number" ? bot.result.id : 0,
      username: typeof bot.result.username === "string" ? bot.result.username : undefined,
      firstName: typeof bot.result.first_name === "string" ? bot.result.first_name : undefined,
    };
    this.state.pairedChat = undefined;
    this.state.interactionMode = "template";
    this.state.offset = 0;
    this.state.liveUiMessageId = undefined;
    this.saveState();
    this.ensurePairingCode();
    await this.ensurePolling();
    this.broadcastStatus();
    return { ok: true, ...(await this.getStatusAsync()) };
  }

  async disconnect() {
    this.stopPolling();
    await keytar.deletePassword(serviceName, tokenAccount);
    this.state = { offset: 0 };
    this.pairingCode = "";
    this.pairingExpiresAt = 0;
    this.status = "disabled";
    this.statusMessage = "";
    this.saveState();
    this.broadcastStatus();
    return { ok: true, ...(await this.getStatusAsync()) };
  }

  async unpair() {
    this.stopPolling();
    this.state.pairedChat = undefined;
    this.state.interactionMode = "template";
    this.state.liveUiMessageId = undefined;
    this.ensurePairingCode(true);
    this.saveState();
    if (this.settings.enabled && await this.hasToken()) {
      this.status = "not-paired";
      await this.ensurePolling();
    } else {
      this.status = "disabled";
    }
    this.broadcastStatus();
    return { ok: true, ...(await this.getStatusAsync()) };
  }

  async reconnectPolling() {
    this.stopPolling();
    const result = await this.telegramRequest("deleteWebhook", { drop_pending_updates: false });
    if (!result.ok) {
      this.status = "error";
      this.statusMessage = readTelegramDescription(result) || "Could not clear Telegram webhook.";
      this.broadcastStatus();
      return { ok: false, ...(await this.getStatusAsync()) };
    }
    await this.ensurePolling();
    return { ok: true, ...(await this.getStatusAsync()) };
  }

  getStatus(): TelegramStatusSnapshot {
    const hasPairing = Boolean(this.pairingCode && this.pairingExpiresAt > Date.now() && !this.state.pairedChat);
    return {
      status: this.status,
      enabled: this.settings.enabled,
      hasToken: false,
      bot: this.state.bot,
      pairedChat: this.state.pairedChat,
      pairingCode: hasPairing ? this.pairingCode : undefined,
      pairingExpiresAt: hasPairing ? new Date(this.pairingExpiresAt).toISOString() : undefined,
      interactionMode: this.currentInteractionMode(),
      message: this.statusMessage || undefined,
    };
  }

  async getStatusAsync() {
    return { ...this.getStatus(), hasToken: await this.hasToken() };
  }

  markRendererReady() {
    this.rendererReady = true;
    const queued = [...this.queuedRendererRequests];
    this.queuedRendererRequests = [];
    queued.forEach((request) => this.sendRendererRequest(request));
    return { ok: true };
  }

  handleRendererResponse(value: unknown) {
    if (!isRecord(value) || typeof value.id !== "string") return { ok: false };
    const resolver = this.pendingRendererResponses.get(value.id);
    if (!resolver) return { ok: false };
    this.pendingRendererResponses.delete(value.id);
    resolver(readRendererResponse(value.response));
    return { ok: true };
  }

  stop() {
    this.stopPolling();
    for (const resolve of this.pendingRendererResponses.values()) {
      resolve({ ok: false, text: this.copy("telegram.error.rendererUnavailable") });
    }
    this.pendingRendererResponses.clear();
  }

  private async ensurePolling() {
    if (!this.settings.enabled) return;
    const token = await this.getToken();
    if (!token) {
      this.status = "disabled";
      this.broadcastStatus();
      return;
    }

    const webhookInfo = await this.telegramRequest("getWebhookInfo", {});
    if (webhookInfo.ok && isRecord(webhookInfo.result) && typeof webhookInfo.result.url === "string" && webhookInfo.result.url.trim()) {
      this.stopPolling();
      this.status = "webhook-conflict";
      this.statusMessage = "Telegram webhook is configured. Long polling is paused.";
      this.broadcastStatus();
      return;
    }

    if (!this.state.pairedChat) {
      this.ensurePairingCode();
      this.status = "not-paired";
      this.broadcastStatus();
    } else {
      this.status = "connected";
      this.broadcastStatus();
    }

    if (!this.isPolling) {
      void this.pollLoop();
    }
  }

  private async pollLoop() {
    if (this.isPolling) return;
    this.isPolling = true;

    this.sessionGeneration += 1;
    const currentGeneration = this.sessionGeneration;
    const abortController = new AbortController();
    this.pollAbort = abortController;
    const signal = abortController.signal;

    const sessionStartTime = Math.floor(Date.now() / 1000);

    while (this.settings.enabled && this.sessionGeneration === currentGeneration && !signal.aborted) {
      try {
        const response = await this.telegramRequest("getUpdates", {
          offset: this.state.offset || undefined,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        }, signal);

        if (signal.aborted || this.sessionGeneration !== currentGeneration) break;

        if (!response.ok) {
          if (signal.aborted || this.sessionGeneration !== currentGeneration) break;
          
          this.status = response.error_code === 409 ? "webhook-conflict" : "reconnecting";
          this.statusMessage = readTelegramDescription(response) || "Telegram polling failed.";
          this.broadcastStatus();

          try {
            await delayWithSignal(3000, signal);
          } catch {
            break;
          }
          continue;
        }

        if (this.status === "reconnecting" || this.status === "error") {
          this.status = this.state.pairedChat ? "connected" : "not-paired";
          this.statusMessage = "";
          this.broadcastStatus();
        }

        if (Array.isArray(response.result)) {
          for (const update of response.result) {
            if (signal.aborted || this.sessionGeneration !== currentGeneration) break;

            const isBacklog = checkIfBacklog(update, sessionStartTime);
            if (!isBacklog) {
              await this.handleUpdate(update);
            }

            const updateId = isRecord(update) && typeof update.update_id === "number" ? update.update_id : null;
            if (updateId !== null) {
              this.state.offset = Math.max(this.state.offset, updateId + 1);
              this.saveState();
            }
          }
        }
      } catch (error) {
        if (signal.aborted || this.sessionGeneration !== currentGeneration) break;
        
        this.status = "reconnecting";
        this.statusMessage = error instanceof Error ? sanitizeMessage(error.message) : "Telegram polling failed.";
        this.broadcastStatus();

        try {
          await delayWithSignal(3000, signal);
        } catch {
          break;
        }
      }
    }

    if (this.pollAbort === abortController) {
      this.pollAbort = null;
    }
    if (this.sessionGeneration === currentGeneration) {
      this.isPolling = false;
    }
  }

  private async handleUpdate(update: unknown) {
    if (!isRecord(update)) return;
    if (isRecord(update.callback_query)) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    if (isRecord(update.message)) {
      await this.handleMessage(update.message);
    }
  }

  private async handleMessage(message: Record<string, unknown>) {
    if (!this.settings.enabled) return;
    if (!isRecord(message.chat) || message.chat.type !== "private" || typeof message.chat.id !== "number") return;
    if (typeof message.text !== "string" || typeof message.message_id !== "number") return;
    const chatId = message.chat.id;
    const text = message.text.trim();
    if (!text) return;

    if (!this.state.pairedChat) {
      this.ensurePairingCode();
      if (this.isPairingCode(text)) {
        this.state.pairedChat = {
          id: chatId,
          username: isRecord(message.from) && typeof message.from.username === "string" ? message.from.username : undefined,
          firstName: isRecord(message.from) && typeof message.from.first_name === "string" ? message.from.first_name : undefined,
        };
        this.state.interactionMode = "template";
        this.pairingCode = "";
        this.pairingExpiresAt = 0;
        this.status = "connected";
        this.state.liveUiMessageId = undefined;
        this.saveState();
        this.broadcastStatus();

        const menuMarkup = this.templateMenuMarkup();
        const sentMsg = await this.sendMessage(chatId, this.copy("telegram.reply.paired"), menuMarkup);
        if (sentMsg && typeof sentMsg.message_id === "number") {
          this.state.liveUiMessageId = sentMsg.message_id;
          this.saveState();
        }
      } else {
        await this.sendMessage(chatId, this.copy("telegram.reply.pairRequired"));
      }
      return;
    }

    if (this.state.pairedChat.id !== chatId) {
      await this.sendMessage(chatId, this.copy("telegram.reply.unauthorized"));
      return;
    }

    const isAiRequest = this.currentInteractionMode() === "ai" &&
      text !== "/start" && text !== "/menu" && text !== "menu" && text !== "меню";

    let thinkingMessageId: number | undefined;
    if (isAiRequest) {
      void this.telegramRequest("sendChatAction", { chat_id: chatId, action: "typing" });

      const thinkingText = this.copy("telegram.thinking");
      const sentMsg = await this.sendMessage(chatId, thinkingText);
      if (sentMsg && typeof sentMsg.message_id === "number") {
        thinkingMessageId = sentMsg.message_id;
      }
    }

    const request: TelegramMessageRequest = {
      id: createRequestId(),
      chatId,
      messageId: message.message_id,
      text,
      interactionMode: this.currentInteractionMode(),
    };
    try {
      const response = await this.requestRenderer({ type: "message", payload: request });
      
      // Safety guard: if bot was disabled or unpaired during rendering, abort and delete thinking message
      if (!this.settings.enabled || !this.state.pairedChat || this.state.pairedChat.id !== chatId) {
        if (thinkingMessageId) {
          await this.deleteMessage(chatId, thinkingMessageId);
        }
        return;
      }

      await this.deliverRendererResponse(chatId, response, thinkingMessageId);
    } catch (error) {
      if (thinkingMessageId) {
        const errText = error instanceof Error ? error.message : "Error";
        await this.editMessageText(chatId, thinkingMessageId, errText);
      }
    }
  }

  private async handleCallbackQuery(query: Record<string, unknown>) {
    const callbackId = typeof query.id === "string" ? query.id : "";
    const data = typeof query.data === "string" ? query.data : "";
    const chat = isRecord(query.message) && isRecord(query.message.chat) ? query.message.chat : null;
    const chatId = chat && typeof chat.id === "number" ? chat.id : null;

    if (!callbackId || !chatId) return;
    if (!this.settings.enabled) {
      await this.answerCallback(callbackId, "Disabled");
      return;
    }

    let answered = false;
    const answer = async (text: string) => {
      if (answered) return;
      answered = true;
      await this.answerCallback(callbackId, text);
    };

    try {
      if (!this.state.pairedChat || this.state.pairedChat.id !== chatId) {
        await answer(this.copy("telegram.reply.unauthorized"));
        return;
      }

      // Mode checking guard to prevent old mode-menu buttons from corrupting the current mode
      const isAiMode = this.currentInteractionMode() === "ai";
      const isTemplateButton = data === "tg:today" || data === "tg:upcoming" || data === "tg:create" || data.startsWith("tg:create:");
      const isAiButton = data === "tg:ai:help" || data.startsWith("tg:ai:");
      
      if (isAiMode && isTemplateButton) {
        await answer(this.copy("telegram.error.wrongMode"));
        await this.editReplyMarkup(query.message, undefined);
        return;
      }
      if (!isAiMode && isAiButton) {
        await answer(this.copy("telegram.error.wrongMode"));
        await this.editReplyMarkup(query.message, undefined);
        return;
      }

      const decisionMatch = /^tg:(confirm|cancel):([A-Za-z0-9_-]{8,80})$/.exec(data);
      if (decisionMatch) {
        const decision = decisionMatch[1];
        const proposalId = decisionMatch[2];
        await answer(decision === "confirm" ? this.copy("telegram.callback.confirming") : this.copy("telegram.callback.canceling"));
        
        // Remove buttons immediately to prevent double-tap
        await this.editReplyMarkup(query.message, undefined);

        // Request renderer to apply or cancel
        const response = await this.requestRenderer({
          type: "decision",
          payload: {
            id: createRequestId(),
            proposalId,
            decision: decision === "confirm" ? "confirm" : "cancel",
            chatId,
          },
        });

        // Edit the original preview message to show final state
        if (isRecord(query.message) && typeof query.message.message_id === "number" && typeof query.message.text === "string") {
          const originalText = query.message.text;
          const cleanText = originalText
            .replace(/\nНичего не будет создано без подтверждения\..*/g, "")
            .replace(/\nNothing will be created without confirmation\..*/g, "")
            .replace(/\nПрименить это расписание\?.*/g, "")
            .replace(/\nApply this schedule\?.*/g, "")
            .replace(/\nУдаления необратимы\. Применить\?.*/g, "")
            .replace(/\nDeletes are permanent\. Apply\?.*/g, "");

          let statusIndicator = "";
          if (decision === "cancel") {
            statusIndicator = this.settings.language === "ru" ? "\n\n❌ Отменено" : "\n\n❌ Cancelled";
          } else if (response.ok) {
            statusIndicator = this.settings.language === "ru" ? "\n\n✅ Подтверждено" : "\n\n✅ Confirmed";
          } else if (response.text.includes("expired") || response.text.includes("истекл")) {
            statusIndicator = this.settings.language === "ru" ? "\n\n⚠️ Истекло" : "\n\n⚠️ Expired";
          } else {
            statusIndicator = this.settings.language === "ru" ? "\n\n⚠️ Ошибка применимости" : "\n\n⚠️ Failed to apply";
          }
          await this.editMessageText(chatId, query.message.message_id, cleanText + statusIndicator);
        }

        // Send the feedback message (cancellation or success summary)
        await this.deliverRendererResponse(chatId, response);

        // In Template Mode, return the user to the main menu
        if (this.currentInteractionMode() === "template") {
          const menuResponse = await this.requestRenderer({
            type: "callback",
            payload: {
              id: createRequestId(),
              chatId,
              data: "tg:menu",
              interactionMode: "template",
            },
          });
          await this.deliverRendererResponse(chatId, menuResponse);
        }
        return;
      }

      const modeMatch = /^tg:mode:(template|ai)$/.exec(data);
      if (modeMatch) {
        this.state.interactionMode = modeMatch[1] === "ai" ? "ai" : "template";
        if (isRecord(query.message) && typeof query.message.message_id === "number") {
          this.state.liveUiMessageId = query.message.message_id;
        }
        this.saveState();
        this.broadcastStatus();
        await answer(this.copy(modeMatch[1] === "ai" ? "telegram.callback.aiMode" : "telegram.callback.templateMode"));

        const response = await this.requestRenderer({
          type: "callback",
          payload: {
            id: createRequestId(),
            chatId,
            data,
            interactionMode: this.currentInteractionMode(),
          },
        });
        await this.deliverRendererResponse(chatId, response);
        return;
      }

      if (!isSafeTelegramCallbackData(data)) {
        await answer(this.copy("telegram.error.expired"));
        return;
      }

      await answer(this.copy("telegram.callback.opening"));
      
      if (isRecord(query.message) && typeof query.message.message_id === "number") {
        this.state.liveUiMessageId = query.message.message_id;
        this.saveState();
      }

      const response = await this.requestRenderer({
        type: "callback",
        payload: {
          id: createRequestId(),
          chatId,
          data,
          interactionMode: this.currentInteractionMode(),
        },
      });
      await this.deliverRendererResponse(chatId, response);
    } catch (error) {
      console.error("[TelegramBridge] Callback handling failed:", error);
      await answer(this.copy("telegram.error.expired"));
    }
  }

  private async deliverRendererResponse(chatId: number, response: RendererResponse, editMessageId?: number) {
    const text = sanitizeTelegramText(response.text);

    // 1. Classification check
    // - final_result, security_error, pairing_confirmation (ok === false or kind === "message")
    if (!response.ok || response.kind === "message") {
      if (editMessageId) {
        const edited = await this.editMessageText(chatId, editMessageId, text);
        if (edited) return;
      }
      await this.sendMessage(chatId, text);
      return;
    }

    // - transient menus/wizard/status (kind === "buttons")
    if (response.kind === "buttons") {
      const replyMarkup = {
        inline_keyboard: response.buttons.map((row) => row.map((button) => ({
          text: sanitizeTelegramText(button.text).slice(0, 64),
          callback_data: button.callbackData,
        }))),
      };

      if (editMessageId) {
        const edited = await this.editMessageText(chatId, editMessageId, text, replyMarkup);
        if (edited) return;
      }

      await this.sendOrEditLiveUiMessage(chatId, text, replyMarkup);
      return;
    }

    // - pending_action_preview (kind === "proposal")
    const replyMarkup = {
      inline_keyboard: [[
        { text: this.copy("telegram.button.confirm"), callback_data: `tg:confirm:${response.proposalId}` },
        { text: this.copy("telegram.button.cancel"), callback_data: `tg:cancel:${response.proposalId}` },
      ]],
    };

    if (editMessageId) {
      const edited = await this.editMessageText(chatId, editMessageId, text, replyMarkup);
      if (edited) return;
    }

    await this.sendMessage(chatId, text, replyMarkup);
  }

  private async sendOrEditLiveUiMessage(chatId: number, text: string, replyMarkup?: unknown) {
    if (this.state.liveUiMessageId) {
      const success = await this.editMessageText(chatId, this.state.liveUiMessageId, text, replyMarkup);
      if (success) {
        return;
      }
    }
    const msg = await this.sendMessage(chatId, text, replyMarkup);
    if (msg && typeof msg.message_id === "number") {
      this.state.liveUiMessageId = msg.message_id;
      this.saveState();
    }
  }

  private async editMessageText(chatId: number, messageId: number, text: string, replyMarkup?: unknown): Promise<boolean> {
    try {
      const res = await this.telegramRequest("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text: sanitizeTelegramText(text),
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
        disable_web_page_preview: true,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async deleteMessage(chatId: number, messageId: number): Promise<boolean> {
    try {
      const res = await this.telegramRequest("deleteMessage", {
        chat_id: chatId,
        message_id: messageId,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async requestRenderer(request: RendererRequest): Promise<RendererResponse> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.pendingRendererResponses.delete(request.payload.id);
        resolve({ ok: false, text: this.copy("telegram.error.rendererTimeout") });
      }, 45_000);
      this.pendingRendererResponses.set(request.payload.id, (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
      if (this.rendererReady && BrowserWindow.getAllWindows().length > 0) {
        this.sendRendererRequest(request);
      } else {
        this.queuedRendererRequests.push(request);
      }
    });
  }

  private sendRendererRequest(request: RendererRequest) {
    const channel = request.type === "message"
      ? "telegram:message-request"
      : request.type === "decision"
        ? "telegram:decision-request"
        : "telegram:callback-request";
    this.broadcast(channel, request.payload);
  }

  private async sendMessage(chatId: number, text: string, replyMarkup?: unknown): Promise<any> {
    const res = await this.telegramRequest("sendMessage", {
      chat_id: chatId,
      text: sanitizeTelegramText(text),
      reply_markup: replyMarkup,
      disable_web_page_preview: true,
    });
    return res.ok ? res.result : null;
  }

  private async answerCallback(callbackQueryId: string, text: string) {
    await this.telegramRequest("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: sanitizeTelegramText(text).slice(0, 180),
      show_alert: false,
    });
  }

  private async editReplyMarkup(message: unknown, replyMarkup: unknown) {
    if (!isRecord(message) || !isRecord(message.chat) || typeof message.chat.id !== "number" || typeof message.message_id !== "number") return;
    await this.telegramRequest("editMessageReplyMarkup", {
      chat_id: message.chat.id,
      message_id: message.message_id,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  }

  private stopPolling() {
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.isPolling = false;
  }

  private currentInteractionMode(): TelegramInteractionMode {
    return this.state.interactionMode === "ai" ? "ai" : "template";
  }

  private templateMenuMarkup() {
    return {
      inline_keyboard: [
        [
          { text: this.copy("telegram.menu.today"), callback_data: "tg:today" },
          { text: this.copy("telegram.menu.upcoming"), callback_data: "tg:upcoming" },
        ],
        [{ text: this.copy("telegram.menu.create"), callback_data: "tg:create" }],
        [{ text: this.copy("telegram.menu.aiMode"), callback_data: "tg:mode:ai" }],
      ],
    };
  }

  private ensurePairingCode(force = false) {
    if (!force && this.pairingCode && this.pairingExpiresAt > Date.now()) return;
    this.pairingCode = createPairingCode();
    this.pairingExpiresAt = Date.now() + pairingTtlMs;
  }

  private isPairingCode(value: string) {
    return Boolean(this.pairingCode && this.pairingExpiresAt > Date.now() && value.trim().toUpperCase() === this.pairingCode);
  }

  private async telegramRequest(method: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const token = await this.getToken();
    if (!token) return { ok: false, error_code: 401, description: "Telegram bot token is not configured." };
    return this.telegramRequestWithToken(token, method, body, signal);
  }

  private async telegramRequestWithToken(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    return (await response.json()) as { ok: boolean; result?: unknown; error_code?: number; description?: string };
  }

  private async getToken() {
    return keytar.getPassword(serviceName, tokenAccount);
  }

  private async hasToken() {
    return Boolean(await this.getToken());
  }

  private loadState(): TelegramStoredState {
    try {
      const file = this.statePath();
      if (!fs.existsSync(file)) return { offset: 0 };
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
      if (!isRecord(parsed)) return { offset: 0 };
      return {
        offset: typeof parsed.offset === "number" ? parsed.offset : 0,
        interactionMode: parsed.interactionMode === "ai" ? "ai" : "template",
        pairedChat: readStoredChat(parsed.pairedChat),
        bot: readStoredBot(parsed.bot),
        liveUiMessageId: typeof parsed.liveUiMessageId === "number" ? parsed.liveUiMessageId : undefined,
      };
    } catch {
      return { offset: 0 };
    }
  }

  private saveState() {
    try {
      fs.mkdirSync(path.dirname(this.statePath()), { recursive: true });
      fs.writeFileSync(this.statePath(), JSON.stringify(this.state, null, 2), "utf8");
    } catch {
      // Non-critical; polling can continue, but duplicates may be possible after restart.
    }
  }

  private statePath() {
    return path.join(app.getPath("userData"), "telegram-bridge-state.json");
  }

  private broadcastStatus() {
    void this.getStatusAsync().then((status) => this.broadcast("telegram:status", status));
  }

  private copy(key: string) {
    const ru = this.settings.language === "ru";
    const messages: Record<string, [string, string]> = {
      "telegram.reply.paired": ["Telegram Assistant is paired with Aevum. Template Mode is active.", "Telegram-ассистент подключен к Aevum. Обычный режим активен."],
      "telegram.reply.pairRequired": ["Open Aevum Settings and send the current pairing code here.", "Откройте настройки Aevum и отправьте сюда текущий код привязки."],
      "telegram.reply.unauthorized": ["This chat is not authorized for this Aevum bot.", "Этот чат не авторизован для этого бота Aevum."],
      "telegram.button.confirm": ["Confirm", "Подтвердить"],
      "telegram.button.cancel": ["Cancel", "Отменить"],
      "telegram.callback.confirming": ["Applying...", "Применяю..."],
      "telegram.callback.canceling": ["Canceling...", "Отменяю..."],
      "telegram.callback.opening": ["Opening...", "Открываю..."],
      "telegram.callback.aiMode": ["AI Mode enabled.", "Режим ИИ включен."],
      "telegram.callback.templateMode": ["Template Mode enabled.", "Обычный режим включен."],
      "telegram.menu.today": ["Today", "Сегодня"],
      "telegram.menu.upcoming": ["Upcoming", "Предстоящее"],
      "telegram.menu.create": ["Create task", "Создать задачу"],
      "telegram.menu.aiMode": ["Switch to AI Mode", "Переключиться в режим ИИ"],
      "telegram.error.expired": ["This confirmation has expired.", "Это подтверждение истекло."],
      "telegram.error.rendererUnavailable": ["Aevum is still starting. Try again in a moment.", "Aevum еще запускается. Попробуйте через несколько секунд."],
      "telegram.error.rendererTimeout": ["Aevum did not answer in time. Try again.", "Aevum не ответил вовремя. Попробуйте снова."],
      "telegram.error.wrongMode": ["This button belongs to a different mode.", "Эта кнопка относится к другому режиму."],
      "telegram.thinking": ["🔎 Thinking...", "🔎 Думаю..."],
    };
    return messages[key]?.[ru ? 1 : 0] ?? key;
  }
}

function readRendererResponse(value: unknown): RendererResponse {
  if (!isRecord(value)) return { ok: false, text: "Aevum returned an unexpected response." };
  if (value.ok === true && value.kind === "proposal" && typeof value.proposalId === "string" && typeof value.text === "string") {
    return { ok: true, kind: "proposal", proposalId: value.proposalId, text: value.text };
  }
  if (value.ok === true && value.kind === "buttons" && typeof value.text === "string" && Array.isArray(value.buttons)) {
    const buttons = readTelegramButtons(value.buttons);
    if (buttons.length) return { ok: true, kind: "buttons", text: value.text, buttons };
  }
  if (value.ok === true && value.kind === "message" && typeof value.text === "string") {
    return { ok: true, kind: "message", text: value.text };
  }
  return { ok: false, text: typeof value.text === "string" ? value.text : "Aevum could not handle that Telegram request." };
}

function readTelegramButtons(value: unknown[]): TelegramResponseButton[][] {
  return value
    .map((row) => Array.isArray(row)
      ? row
        .map((button) => {
          if (!isRecord(button) || typeof button.text !== "string" || typeof button.callbackData !== "string") return null;
          if (!isSafeTelegramCallbackData(button.callbackData)) return null;
          return { text: button.text, callbackData: button.callbackData };
        })
        .filter((button): button is TelegramResponseButton => Boolean(button))
      : [])
    .filter((row) => row.length > 0)
    .slice(0, 8);
}

function readStoredChat(value: unknown): TelegramStoredState["pairedChat"] {
  if (!isRecord(value) || typeof value.id !== "number") return undefined;
  return {
    id: value.id,
    username: typeof value.username === "string" ? value.username : undefined,
    firstName: typeof value.firstName === "string" ? value.firstName : undefined,
  };
}

function readStoredBot(value: unknown): TelegramStoredState["bot"] {
  if (!isRecord(value) || typeof value.id !== "number") return undefined;
  return {
    id: value.id,
    username: typeof value.username === "string" ? value.username : undefined,
    firstName: typeof value.firstName === "string" ? value.firstName : undefined,
  };
}

function readTelegramDescription(value: unknown) {
  return isRecord(value) && typeof value.description === "string" ? sanitizeMessage(value.description) : "";
}

function isTelegramToken(value: string) {
  return /^\d{6,20}:[A-Za-z0-9_-]{30,}$/.test(value);
}

function isSafeTelegramCallbackData(value: string) {
  return /^tg:[A-Za-z0-9:_-]{1,90}$/.test(value);
}

function createPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function createRequestId() {
  return `tg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeTelegramText(value: string) {
  return sanitizeMessage(value)
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-[redacted]")
    .replace(/\b\d{6,20}:[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]")
    .replace(/<(?:think|thought|analysis)>[\s\S]*?<\/(?:think|thought|analysis)>/gi, "")
    .replace(/<(?:think|thought|analysis)>[\s\S]*/gi, "")
    .slice(0, 3500);
}

function sanitizeMessage(value: string) {
  return value.replace(/\s+\n/g, "\n").replace(/\n{4,}/g, "\n\n").trim() || "OK";
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException("Aborted", "AbortError"));
    }
    const timeout = setTimeout(() => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    }
    if (signal) {
      signal.addEventListener("abort", onAbort);
    }
  });
}

function checkIfBacklog(update: unknown, sessionStartTime: number): boolean {
  if (!isRecord(update)) return true;
  if (isRecord(update.message)) {
    const date = typeof update.message.date === "number" ? update.message.date : 0;
    return date < sessionStartTime;
  }
  return false;
}
