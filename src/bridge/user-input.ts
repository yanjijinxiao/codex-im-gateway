import crypto from "node:crypto";

import type {
  CodexUserInputAnswer,
  CodexUserInputQuestion,
  CodexUserInputRequest
} from "../codex/app-server-runner.js";
import { createChoiceCard, type ChannelActionCard } from "../channels/action-card.js";

type PendingChoice = {
  senderId: string;
  options: string[];
  resolve: (answer: string | undefined) => void;
  timer: NodeJS.Timeout;
};

export class ChannelUserInputController {
  private readonly pending = new Map<string, PendingChoice>();

  constructor(
    private readonly sendCard: (senderId: string, card: ChannelActionCard) => Promise<void>,
    private readonly defaultTimeoutMs = 5 * 60_000
  ) {}

  async request(senderId: string, request: CodexUserInputRequest): Promise<CodexUserInputAnswer> {
    const answers: CodexUserInputAnswer = {};
    for (const [index, question] of request.questions.entries()) {
      const answer = await this.ask(
        senderId,
        question,
        index,
        request.questions.length,
        request.autoResolutionMs ?? this.defaultTimeoutMs
      );
      if (answer === undefined) return answers;
      answers[question.id] = { answers: [answer] };
    }
    return answers;
  }

  answer(senderId: string, arg: string): string {
    const [requestId, rawIndex] = arg.trim().split(/\s+/, 2);
    const pending = requestId ? this.pending.get(requestId) : undefined;
    const index = Number(rawIndex);
    if (!pending || pending.senderId !== senderId || !Number.isInteger(index)) {
      return "这个交互选项已失效，请等待 Codex 重新发起确认。";
    }
    const answer = pending.options[index];
    if (answer === undefined) return "这个选项不存在，请使用卡片上的按钮。";
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(answer);
    return "已记录选择，Codex 将继续处理。";
  }

  cancelSender(senderId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.senderId !== senderId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
  }

  close(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    this.pending.clear();
  }

  private async ask(
    senderId: string,
    question: CodexUserInputQuestion,
    index: number,
    total: number,
    timeoutMs: number
  ): Promise<string | undefined> {
    const options = question.options ?? [];
    if (!options.length) return undefined;
    const requestId = `U${crypto.randomBytes(6).toString("base64url")}`;
    const answer = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(undefined);
      }, Math.max(1_000, timeoutMs));
      this.pending.set(requestId, {
        senderId,
        options: options.map((option) => option.label),
        resolve,
        timer
      });
    });
    await this.sendCard(senderId, createChoiceCard({
      title: `${question.header}${total > 1 ? ` · ${index + 1}/${total}` : ""}`,
      body: [
        question.question,
        ...options.map((option) => `**${option.label}**\n${option.description}`)
      ].join("\n\n"),
      fallbackText: `Codex 正在等待选择：${question.question}`,
      choices: options.map((option, optionIndex) => ({
        label: option.label,
        command: "answer",
        arg: `${requestId} ${optionIndex}`,
        style: optionIndex === 0 ? "primary" : "default"
      }))
    }));
    return answer;
  }
}
