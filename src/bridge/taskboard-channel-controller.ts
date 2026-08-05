import { createTaskCard, createTaskFormCard, createTaskOverviewCard } from "../channels/task-card.js";
import type { TaskboardClient, TaskboardIssue } from "../taskboard/client.js";
import type { NormalizedWeixinMessage } from "../weixin/messages.js";
import { parseTaskboardChannelCommand, type TaskboardSubmission } from "./taskboard-channel-command.js";
import { TaskboardSubmissionDeduplicator } from "./taskboard-channel-dedup.js";
import {
  latestTaskboardComment,
  resolveTaskboardChannelContext,
  resolveTaskboardTarget,
  taskboardBaseUrl,
  type TaskboardChannelContext
} from "./taskboard-channel-context.js";
import { handleLegacyTaskboardCommand } from "./taskboard-channel-legacy.js";
import { executeTaskboardSubmission } from "./taskboard-channel-submit.js";
import type {
  TaskboardChannelControllerOptions,
  TaskboardOverviewInput,
  TaskboardShowIssueInput
} from "./taskboard-channel-types.js";

export type { TaskboardChannelControllerOptions } from "./taskboard-channel-types.js";

export class TaskboardChannelController {
  private readonly submissionDedup = new TaskboardSubmissionDeduplicator();

  constructor(private readonly options: TaskboardChannelControllerOptions) {}

  async handle(message: NormalizedWeixinMessage, raw: string): Promise<void> {
    const client = this.options.client;
    if (!client) {
      await this.options.replyText(message.senderId, "Taskboard 未启用或当前不可用，请在管理页检查本地服务连接。");
      return;
    }
    const context = await resolveTaskboardChannelContext(this.options, client, message.senderId);
    if (!context) return;
    const command = parseTaskboardChannelCommand(raw);
    switch (command.kind) {
      case "list":
        await this.showOverview({ message, context, filter: command.filter, page: command.page });
        return;
      case "form":
        await this.showForm(message, context, command);
        return;
      case "submit":
        await this.submit(message, context, command.submission);
        return;
      case "legacy":
        await handleLegacyTaskboardCommand({
          message,
          input: command.input,
          context,
          options: this.options,
          showIssue: (issue, note) => this.showIssue({ message, context, issue, ...(note ? { note } : {}) }),
          showOverview: () => this.showOverview({ message, context, filter: "active", page: 1 }),
          resolveTarget: (identifier) => resolveTaskboardTarget({
            context,
            client,
            identifier,
            senderId: message.senderId,
            replyText: this.options.replyText
          })
        });
        return;
      case "invalid":
        await this.options.replyText(message.senderId, command.message);
        return;
      default:
        return assertNever(command);
    }
  }

  private async showOverview(input: TaskboardOverviewInput): Promise<void> {
    const client = this.requireClient();
    const issues = await client.listIssues({ projectId: input.context.taskboardProject.id });
    await this.options.sendCard(input.message, createTaskOverviewCard({
      projectName: input.context.managedProject.name,
      projectId: input.context.taskboardProject.id,
      issues,
      taskboardBaseUrl: taskboardBaseUrl(client),
      filter: input.filter,
      page: input.page
    }));
  }

  private async showForm(
    message: NormalizedWeixinMessage,
    context: TaskboardChannelContext,
    command: Extract<ReturnType<typeof parseTaskboardChannelCommand>, { readonly kind: "form" }>
  ): Promise<void> {
    const client = this.requireClient();
    if (command.form === "new" || command.form === "todo") {
      await this.options.sendCard(message, createTaskFormCard({
        form: command.form,
        projectName: context.managedProject.name,
        projectId: context.taskboardProject.id,
        taskboardBaseUrl: taskboardBaseUrl(client),
        ...(command.prefill ? { prefill: command.prefill } : {})
      }));
      return;
    }
    const issue = await resolveTaskboardTarget({
      context,
      client,
      identifier: command.identifier ?? "current",
      senderId: message.senderId,
      replyText: this.options.replyText
    });
    if (!issue) return;
    await this.options.sendCard(message, createTaskFormCard({
      form: command.form,
      issue,
      projectName: context.managedProject.name,
      projectId: context.taskboardProject.id,
      taskboardBaseUrl: taskboardBaseUrl(client),
      ...(command.prefill ? { prefill: command.prefill } : {})
    }));
  }

  private async submit(
    message: NormalizedWeixinMessage,
    context: TaskboardChannelContext,
    submission: TaskboardSubmission
  ): Promise<void> {
    const requestId = submission.request_id;
    const reservation = this.submissionDedup.reserve(requestId, context.taskboardProject.id, submission);
    if (reservation.kind === "mismatch") {
      await this.options.replyText(message.senderId, "该请求标识已用于其他任务操作，请刷新任务面板后重试。");
      return;
    }
    if (reservation.kind === "duplicate") {
      if (await reservation.completion) {
        await this.refreshSubmissionTarget({ message, context, submission, note: "该操作已处理，任务已刷新。" });
      } else {
        await this.submit(message, context, submission);
      }
      return;
    }
    let mutationCompleted = false;
    try {
      if (!(await this.authorizeSubmissionTarget(message, context, submission))) {
        reservation.finish(false);
        return;
      }
      const result = await executeTaskboardSubmission({
        client: this.requireClient(),
        projectId: context.taskboardProject.id,
        submission
      });
      switch (result.kind) {
        case "issue":
          mutationCompleted = true;
          reservation.finish(true);
          this.bindThread(context, result.issue);
          await this.showIssue({
            message,
            context,
            issue: result.issue,
            ...(result.note ? { note: result.note } : {}),
            ...(result.latestComment ? { knownLatestComment: result.latestComment } : {})
          });
          return;
        case "workflow":
          mutationCompleted = submission.operation === "create_start";
          if (!result.issue.threadId) {
            this.options.stateStore.createSession(
              message.senderId,
              context.managedProject.workspace,
              result.issue.title,
              context.managedProject.id
            );
          }
          await this.options.runWorkflow(message, result.instruction);
          mutationCompleted = true;
          reservation.finish(true);
          await this.refreshSubmissionTarget({ message, context, submission, note: "已按最新任务状态刷新。" });
          return;
        case "conflict":
          reservation.finish(false);
          await this.showIssue({
            message,
            context,
            issue: result.issue,
            note: "任务已更新；未执行旧卡片上的操作，请基于最新状态重试。"
          });
          return;
        case "invalid":
          reservation.finish(false);
          if (result.issue) await this.showIssue({ message, context, issue: result.issue, note: result.message });
          else await this.options.replyText(message.senderId, result.message);
          return;
        default:
          return assertNever(result);
      }
    } catch (error) {
      reservation.finish(mutationCompleted);
      throw error;
    }
  }

  private async authorizeSubmissionTarget(
    message: NormalizedWeixinMessage,
    context: TaskboardChannelContext,
    submission: TaskboardSubmission
  ): Promise<boolean> {
    if (submission.operation === "create_todo" || submission.operation === "create_start") return true;
    return Boolean(await resolveTaskboardTarget({
      context,
      client: this.requireClient(),
      identifier: submission.identifier,
      senderId: message.senderId,
      replyText: this.options.replyText
    }));
  }

  private async refreshSubmissionTarget(input: {
    readonly message: NormalizedWeixinMessage;
    readonly context: TaskboardChannelContext;
    readonly submission: TaskboardSubmission;
    readonly note: string;
  }): Promise<void> {
    if (input.submission.operation === "create_todo" || input.submission.operation === "create_start") {
      await this.showOverview({ message: input.message, context: input.context, filter: "active", page: 1 });
      return;
    }
    const issue = await resolveTaskboardTarget({
      context: input.context,
      client: this.requireClient(),
      identifier: input.submission.identifier,
      senderId: input.message.senderId,
      replyText: this.options.replyText
    });
    if (!issue) return;
    await this.showIssue({ message: input.message, context: input.context, issue, note: input.note });
  }

  private async showIssue(input: TaskboardShowIssueInput): Promise<void> {
    const client = this.requireClient();
    const latestComment = input.knownLatestComment ?? await latestTaskboardComment(client, input.issue.id);
    await this.options.sendCard(input.message, createTaskCard(input.context.managedProject.name, input.issue, {
      taskboardBaseUrl: taskboardBaseUrl(client),
      ...(latestComment ? { latestComment } : {}),
      ...(input.note ? { note: input.note } : {})
    }));
  }

  private bindThread(context: TaskboardChannelContext, issue: TaskboardIssue): void {
    if (issue.threadId) this.options.stateStore.setSessionThread(context.session.id, issue.threadId);
  }

  private requireClient(): TaskboardClient {
    if (!this.options.client) throw new TaskboardChannelUnavailableError();
    return this.options.client;
  }

}

class TaskboardChannelUnavailableError extends Error {
  readonly name = "TaskboardChannelUnavailableError";
  constructor() { super("Taskboard channel integration is unavailable"); }
}

function assertNever(value: never): never {
  throw new UnexpectedTaskboardChannelValueError(value);
}

class UnexpectedTaskboardChannelValueError extends Error {
  readonly name = "UnexpectedTaskboardChannelValueError";
  constructor(readonly value: never) { super("Taskboard channel value was not handled exhaustively"); }
}
