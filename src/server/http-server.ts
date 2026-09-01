import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { resolveCodexCommand } from "../codex/exec-runner.js";
import { loadConfig, saveConfig } from "../state/config.js";
import type { StatePaths } from "../state/paths.js";
import type { CodexModelOption, CodexRuntimeInfo } from "../codex/backend.js";
import type { AccountManager, SessionAttachmentFile, SessionHistoryMessage, SessionUpload } from "./account-manager.js";
import { LoginManager } from "./login-manager.js";
import { UpdateManager, type UpdateService } from "./update-manager.js";
import type { CodexProjectCandidate } from "./codex-projects.js";
import { handleTaskboardHttp } from "./taskboard-http.js";
import { WEBHOOK_PROVIDERS } from "../webhooks/webhook-provider.js";
import { PROJECT_INTERACTION_MODES } from "../channels/channel-mode-settings.js";
import { selectLocalDirectory } from "./directory-picker.js";

const bodySchema = z.record(z.string(), z.unknown());
const webhookUrlSchema = z.string().trim().max(2_048).url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Invalid Webhook URL: HTTP or HTTPS required");
const projectInteractionModeSchema = z.enum(PROJECT_INTERACTION_MODES);
const qaKnowledgeBaseSelectionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("project"),
    projectId: z.string().trim().min(1).optional()
  }).strict(),
  z.object({
    kind: z.literal("managed"),
    knowledgeBaseId: z.string().trim().min(1)
  }).strict(),
  z.object({
    kind: z.literal("directory"),
    rootPath: z.string().trim().min(1),
    name: z.string().trim().min(1).max(60).optional(),
    engineRoot: z.string().trim().min(1).optional(),
    stateDir: z.string().trim().min(1).optional()
  }).strict()
]);
const channelModeSettingsSchema = z.object({
  defaultMode: projectInteractionModeSchema,
  enabledModes: z.array(projectInteractionModeSchema).min(1).max(PROJECT_INTERACTION_MODES.length),
  qaKnowledgeBase: qaKnowledgeBaseSelectionSchema
}).strict().superRefine((value, context) => {
  if (new Set(value.enabledModes).size !== value.enabledModes.length) {
    context.addIssue({ code: "custom", path: ["enabledModes"], message: "Enabled modes must be unique" });
  }
  if (!value.enabledModes.includes(value.defaultMode)) {
    context.addIssue({ code: "custom", path: ["defaultMode"], message: "Default mode must be enabled" });
  }
});
const accountSettingsSchema = z.object({
  displayName: z.string().max(40),
  webhookUrl: webhookUrlSchema.nullable().optional(),
  webhookProvider: z.enum(WEBHOOK_PROVIDERS).optional(),
  cardTemplateId: z.string().trim().max(300).nullable().optional(),
  cardContentKey: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).nullable().optional(),
  networkFamily: z.enum(["auto", "ipv4", "ipv6"]).optional(),
  modeSettings: channelModeSettingsSchema.optional()
});
const accountDeleteSchema = z.object({
  retainHistory: z.boolean().optional()
});
const channelAccountSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("wecom"),
    botId: z.string().trim().min(1).max(200),
    secret: z.string().trim().min(1).max(500),
    displayName: z.string().trim().max(40).optional()
  }),
  z.object({
    channel: z.literal("feishu"),
    appId: z.string().trim().min(1).max(200),
    appSecret: z.string().trim().min(1).max(500),
    displayName: z.string().trim().max(40).optional()
  }),
  z.object({
    channel: z.literal("dingtalk"),
    clientId: z.string().trim().min(1).max(200),
    clientSecret: z.string().trim().min(1).max(500),
    cardTemplateId: z.string().trim().max(300).optional(),
    cardContentKey: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
    networkFamily: z.enum(["auto", "ipv4", "ipv6"]).optional(),
    displayName: z.string().trim().max(40).optional()
  })
]);
const projectCreateSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  workspace: z.string().min(1),
  source: z.literal("codex-history")
});
const projectPatchSchema = z.object({
  name: z.string().trim().min(1).max(60)
});
const projectNotificationsSchema = z.object({
  notifications: z.array(z.object({
    accountId: z.string().trim().min(1),
    recipientId: z.string().trim().min(1).max(300),
    enabled: z.boolean()
  })).max(20)
});
const knowledgeBaseCreateSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().trim().min(1).max(60),
  rootPath: z.string().trim().min(1),
  engineRoot: z.string().trim().min(1).optional(),
  stateDir: z.string().trim().min(1).optional()
});
const knowledgeBasePatchSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  rootPath: z.string().trim().min(1).optional(),
  engineRoot: z.string().trim().min(1).nullable().optional(),
  stateDir: z.string().trim().min(1).nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "Knowledge base update is empty");
const projectKnowledgeBaseSchema = z.object({
  knowledgeBaseId: z.string().min(1).nullable()
});
const directoryPickerSchema = z.object({
  defaultPath: z.string().trim().min(1).optional()
}).strict();
const sessionCreateSchema = z.object({
  accountId: z.string().min(1),
  senderId: z.string().min(1),
  title: z.string().max(80).optional(),
  projectId: z.string().min(1)
});
const sessionPatchSchema = z.object({
  title: z.string().max(80).optional(),
  model: z.string().max(200).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
  streamReplies: z.boolean().nullable().optional()
}).refine((value) => Object.keys(value).length > 0, "Session update is empty");
const configSchema = z.object({
  defaultCwd: z.string().min(1),
  allowedWorkspaces: z.array(z.string().min(1)).min(1),
  codexBackend: z.enum(["auto", "app-server", "exec"]),
  codexAppServerTransport: z.enum(["auto", "daemon", "stdio"]).optional(),
  codexExecSandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).nullable().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  streamReplies: z.boolean().optional(),
  taskboardEnabled: z.boolean().optional(),
  taskboardUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  }, "Taskboard URL must use an HTTP loopback origin").optional()
});
const MAX_WEB_UPLOAD_FILES = 10;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;

const webRoot = fileURLToPath(new URL("../web", import.meta.url));
const execFileAsync = promisify(execFile);

export type LocalHttpServerOptions = {
  paths: StatePaths;
  accountManager: AccountManager;
  loginManager?: LoginManager;
  productVersion?: string;
  port?: number;
  codexCheck?: () => Promise<{ ready: boolean; version?: string; error?: string }>;
  codexRuntimeCheck?: () => Promise<CodexRuntimeInfo>;
  codexModelsCheck?: () => Promise<CodexModelOption[]>;
  codexProjectsProvider?: () => readonly CodexProjectCandidate[] | Promise<readonly CodexProjectCandidate[]>;
  directoryPicker?: (defaultPath?: string) => Promise<string | undefined>;
  updateService?: UpdateService;
  onUpdateInstalled?: (version: string) => void;
};

export type LocalHttpServer = {
  url: string;
  requestToken: string;
  close: () => Promise<void>;
};

export async function startLocalHttpServer(options: LocalHttpServerOptions): Promise<LocalHttpServer> {
  const requestToken = crypto.randomBytes(24).toString("base64url");
  const productVersion = options.productVersion ?? readProductVersion();
  const loginManager = options.loginManager ?? new LoginManager({
    paths: options.paths,
    accountManager: options.accountManager
  });
  const updateService = options.updateService ?? new UpdateManager({ currentVersion: productVersion });
  let actualPort = options.port ?? 8787;
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, {
      ...options,
      loginManager,
      productVersion,
      requestToken,
      updateService,
      port: actualPort
    }).catch((error: unknown) => {
      const message = requestErrorMessage(error);
      sendJson(response, errorStatus(error, message), { error: message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine local server address");
  }
  actualPort = address.port;
  return {
    url: `http://127.0.0.1:${actualPort}`,
    requestToken,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

type HandlerContext = LocalHttpServerOptions & {
  loginManager: LoginManager;
  productVersion: string;
  requestToken: string;
  updateService: UpdateService;
  port: number;
};

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: HandlerContext): Promise<void> {
  setSecurityHeaders(response);
  if (!isAllowedHost(request.headers.host, context.port)) {
    sendJson(response, 403, { error: "Local host required" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  const method = request.method ?? "GET";
  if (method === "GET" && url.pathname === "/api/channel-capabilities") {
    const origin = request.headers.origin;
    if (origin === "app://-") response.setHeader("Access-Control-Allow-Origin", origin);
    sendJson(response, 200, {
      navigation: await context.accountManager.listChannelCapabilityNavigation()
    });
    return;
  }
  if (isMutation(method)) {
    if (!isAllowedOrigin(request.headers.origin, context.port)) {
      sendJson(response, 403, { error: "Local origin required" });
      return;
    }
    if (request.headers["x-codex-channel-bridge-token"] !== context.requestToken
      && request.headers["x-codex-weixin-token"] !== context.requestToken) {
      sendJson(response, 403, { error: "Invalid request token" });
      return;
    }
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    const config = loadConfig(context.paths);
    const [codex, codexRuntime, codexModels] = await Promise.all([
      (context.codexCheck ?? (() => checkCodex(config.codexBin)))(),
      readCodexRuntime(context),
      readCodexModels(context)
    ]);
    sendJson(response, 200, {
      product: "codex-channel-bridge",
      version: context.productVersion,
      requestToken: context.requestToken,
      config,
      codex,
      codexRuntime,
      codexModels,
      accounts: context.accountManager.listAccounts(),
      projects: context.accountManager.listProjects(),
      knowledgeBases: context.accountManager.listKnowledgeBases(),
      sessions: context.accountManager.listSessions()
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/update") {
    const force = url.searchParams.get("force") === "1";
    if (force && (
      !isAllowedOrigin(request.headers.origin, context.port)
      || (request.headers["x-codex-channel-bridge-token"] !== context.requestToken
        && request.headers["x-codex-weixin-token"] !== context.requestToken)
    )) {
      sendJson(response, 403, { error: "Invalid manual update check" });
      return;
    }
    sendJson(response, 200, await context.updateService.check(force));
    return;
  }
  if (method === "POST" && url.pathname === "/api/update") {
    const result = await context.updateService.installLatest();
    sendJson(response, 200, { ok: true, ...result, restarting: Boolean(context.onUpdateInstalled) });
    if (context.onUpdateInstalled) {
      const timer = setTimeout(() => {
        try {
          context.onUpdateInstalled?.(result.version);
        } catch (error) {
          console.error(`[codex-channel-bridge] unable to schedule restart: ${error instanceof Error ? error.message : String(error)}`);
        }
      }, 250);
      timer.unref();
    }
    return;
  }
  if (method === "GET" && url.pathname === "/api/accounts") {
    sendJson(response, 200, { accounts: context.accountManager.listAccounts() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/accounts") {
    const body = channelAccountSchema.parse(await readJsonBody(request));
    sendJson(response, 201, { account: await context.accountManager.addChannelAccount(body) });
    return;
  }
  if (method === "GET" && url.pathname === "/api/sessions") {
    sendJson(response, 200, { sessions: context.accountManager.listSessions() });
    return;
  }
  if (method === "GET" && url.pathname === "/api/codex-projects") {
    sendJson(response, 200, { projects: await readCodexProjects(context) });
    return;
  }
  if (method === "POST" && url.pathname === "/api/directory-picker") {
    const body = directoryPickerSchema.parse(await readJsonBody(request));
    const selectedPath = await (context.directoryPicker ?? selectLocalDirectory)(body.defaultPath);
    if (selectedPath && !path.isAbsolute(selectedPath)) {
      throw new Error("Directory picker must return an absolute path");
    }
    sendJson(response, 200, { path: selectedPath ?? null });
    return;
  }
  if (method === "GET" && url.pathname === "/api/projects") {
    sendJson(response, 200, { projects: context.accountManager.listProjects() });
    return;
  }
  if (method === "GET" && url.pathname === "/api/knowledge-bases") {
    sendJson(response, 200, { knowledgeBases: context.accountManager.listKnowledgeBases() });
    return;
  }
  if (method === "POST" && url.pathname === "/api/knowledge-bases") {
    const body = knowledgeBaseCreateSchema.parse(await readJsonBody(request));
    sendJson(response, 201, await context.accountManager.createKnowledgeBase(body.accountId, body));
    return;
  }
  if (await handleTaskboardHttp({ request, response, pathname: url.pathname, accountManager: context.accountManager })) return;
  if (method === "POST" && url.pathname === "/api/projects") {
    const body = projectCreateSchema.parse(await readJsonBody(request));
    const workspace = path.resolve(body.workspace);
    const candidate = (await readCodexProjects(context))
      .find((project) => project.workspace === workspace);
    if (!candidate) {
      throw new Error(`Invalid Codex project workspace: ${workspace}`);
    }
    if (candidate.projectKind === "remote" && !candidate.hostId) {
      throw new Error(`Remote Codex Desktop project has no routable host id: ${workspace}`);
    }
    const config = loadConfig(context.paths);
    if (!config.allowedWorkspaces.some((allowed) => path.resolve(allowed) === workspace)) {
      saveConfig(context.paths, {
        ...config,
        allowedWorkspaces: [...config.allowedWorkspaces, workspace]
      });
    }
    sendJson(response, 201, {
      project: context.accountManager.createProject(body.accountId, body.name, workspace, {
        sourceProjectId: candidate.projectId,
        projectKind: candidate.projectKind,
        hostId: candidate.hostId
      })
    });
    return;
  }
  const projectNotificationMatch = matchPath(url.pathname, "/api/projects/:accountId/:projectId/notifications");
  if (method === "PUT" && projectNotificationMatch) {
    const body = projectNotificationsSchema.parse(await readJsonBody(request));
    sendJson(response, 200, {
      project: context.accountManager.setProjectNotifications(
        projectNotificationMatch.accountId,
        projectNotificationMatch.projectId,
        body.notifications
      )
    });
    return;
  }
  const projectKnowledgeBaseMatch = matchPath(url.pathname, "/api/projects/:accountId/:projectId/knowledge-base");
  if (method === "PUT" && projectKnowledgeBaseMatch) {
    const body = projectKnowledgeBaseSchema.parse(await readJsonBody(request));
    sendJson(response, 200, {
      project: context.accountManager.bindProjectKnowledgeBase(
        projectKnowledgeBaseMatch.accountId,
        projectKnowledgeBaseMatch.projectId,
        body.knowledgeBaseId ?? undefined
      )
    });
    return;
  }
  const knowledgeBaseInspectMatch = matchPath(
    url.pathname,
    "/api/knowledge-bases/:accountId/:knowledgeBaseId/inspect"
  );
  if (method === "POST" && knowledgeBaseInspectMatch) {
    sendJson(response, 200, {
      inspection: await context.accountManager.inspectKnowledgeBase(
        knowledgeBaseInspectMatch.accountId,
        knowledgeBaseInspectMatch.knowledgeBaseId
      )
    });
    return;
  }
  const knowledgeBaseMatch = matchPath(url.pathname, "/api/knowledge-bases/:accountId/:knowledgeBaseId");
  if (method === "PATCH" && knowledgeBaseMatch) {
    const body = knowledgeBasePatchSchema.parse(await readJsonBody(request));
    sendJson(response, 200, await context.accountManager.updateKnowledgeBase(
      knowledgeBaseMatch.accountId,
      knowledgeBaseMatch.knowledgeBaseId,
      body
    ));
    return;
  }
  if (method === "DELETE" && knowledgeBaseMatch) {
    context.accountManager.deleteKnowledgeBase(
      knowledgeBaseMatch.accountId,
      knowledgeBaseMatch.knowledgeBaseId
    );
    sendJson(response, 200, { ok: true });
    return;
  }
  const projectMatch = matchPath(url.pathname, "/api/projects/:accountId/:projectId");
  if (method === "PATCH" && projectMatch) {
    const body = projectPatchSchema.parse(await readJsonBody(request));
    sendJson(response, 200, {
      project: context.accountManager.renameProject(projectMatch.accountId, projectMatch.projectId, body.name)
    });
    return;
  }
  if (method === "DELETE" && projectMatch) {
    context.accountManager.deleteProject(projectMatch.accountId, projectMatch.projectId);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "POST" && url.pathname === "/api/logins") {
    sendJson(response, 201, await context.loginManager.start());
    return;
  }
  const loginMatch = matchPath(url.pathname, "/api/logins/:id");
  if (method === "GET" && loginMatch) {
    sendJson(response, 200, await context.loginManager.poll(loginMatch.id));
    return;
  }

  const accountAction = matchPath(url.pathname, "/api/accounts/:accountId/:action");
  if (method === "POST" && accountAction?.action === "start") {
    sendJson(response, 200, await context.accountManager.startAccount(accountAction.accountId));
    return;
  }
  if (method === "POST" && accountAction?.action === "stop") {
    sendJson(response, 200, await context.accountManager.stopAccount(accountAction.accountId));
    return;
  }
  if (method === "POST" && accountAction?.action === "sync-feishu-menu") {
    sendJson(response, 200, await context.accountManager.syncFeishuShortcutMenu(accountAction.accountId));
    return;
  }
  const accountMatch = matchPath(url.pathname, "/api/accounts/:accountId");
  if (method === "PATCH" && accountMatch) {
    const body = accountSettingsSchema.parse(await readJsonBody(request));
    if (body.modeSettings) {
      await context.accountManager.updateAccountModeSettings(accountMatch.accountId, body.modeSettings);
    }
    const { modeSettings: _modeSettings, ...accountSettings } = body;
    let account = context.accountManager.updateAccount(accountMatch.accountId, accountSettings);
    if ((body.cardTemplateId !== undefined || body.cardContentKey !== undefined || body.networkFamily !== undefined)
      && account.channel === "dingtalk"
      && (account.status === "running" || account.status === "starting")) {
      account = await context.accountManager.refreshAccount(accountMatch.accountId);
    }
    sendJson(response, 200, { account });
    return;
  }
  if (method === "DELETE" && accountMatch) {
    const body = accountDeleteSchema.parse(await readJsonBody(request));
    await context.accountManager.removeAccount(accountMatch.accountId, {
      retainHistory: body.retainHistory === true
    });
    sendJson(response, 200, { ok: true });
    return;
  }

  const accessMatch = matchPath(url.pathname, "/api/accounts/:accountId/senders/:senderId/:action");
  if (method === "POST" && accessMatch?.action === "allow") {
    context.accountManager.allowSender(accessMatch.accountId, accessMatch.senderId);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "POST" && accessMatch?.action === "remove") {
    context.accountManager.removeSender(accessMatch.accountId, accessMatch.senderId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && url.pathname === "/api/sessions") {
    const body = sessionCreateSchema.parse(await readJsonBody(request));
    const session = context.accountManager.createSession(
      body.accountId,
      body.senderId,
      undefined,
      body.title,
      body.projectId
    );
    sendJson(response, 201, { session });
    return;
  }
  const attachmentMatch = matchPath(
    url.pathname,
    "/api/sessions/:accountId/:sessionId/messages/:messageId/attachments/:attachmentIndex"
  );
  if ((method === "GET" || method === "HEAD") && attachmentMatch) {
    const attachmentIndex = Number(attachmentMatch.attachmentIndex);
    if (!Number.isInteger(attachmentIndex) || attachmentIndex < 0) {
      throw new Error("Invalid session attachment index");
    }
    const attachment = await context.accountManager.getSessionAttachment(
      attachmentMatch.accountId,
      attachmentMatch.sessionId,
      attachmentMatch.messageId,
      attachmentIndex
    );
    serveSessionAttachment(
      request,
      response,
      attachment,
      url.searchParams.get("download") === "1",
      method === "HEAD"
    );
    return;
  }
  const sessionAction = matchPath(url.pathname, "/api/sessions/:accountId/:sessionId/:action");
  if (method === "GET" && sessionAction?.action === "messages") {
    const messages = await context.accountManager.getSessionMessages(sessionAction.accountId, sessionAction.sessionId);
    sendJson(response, 200, {
      messages: withAttachmentUrls(messages, sessionAction.accountId, sessionAction.sessionId)
    });
    return;
  }
  if (method === "POST" && sessionAction?.action === "messages") {
    const body = await readSessionMessageBody(request, loadConfig(context.paths).maxInboundBytes);
    const stream = url.searchParams.get("stream") === "1"
      && context.accountManager.isSessionStreamEnabled(sessionAction.accountId, sessionAction.sessionId);
    if (stream) {
      startNdjson(response);
      try {
        const result = await context.accountManager.continueSession(
          sessionAction.accountId,
          sessionAction.sessionId,
          body.text,
          body.uploads,
          async (message) => writeNdjson(response, { type: "progress", message })
        );
        await writeNdjson(response, { type: "done", result });
      } catch (error) {
        await writeNdjson(response, {
          type: "error",
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        if (!response.writableEnded) response.end();
      }
      return;
    }
    sendJson(response, 200, {
      result: await context.accountManager.continueSession(
        sessionAction.accountId,
        sessionAction.sessionId,
        body.text,
        body.uploads
      )
    });
    return;
  }
  if (method === "POST" && sessionAction?.action === "activate") {
    sendJson(response, 200, {
      session: await context.accountManager.activateSession(sessionAction.accountId, sessionAction.sessionId)
    });
    return;
  }
  if (method === "POST" && sessionAction?.action === "reset") {
    sendJson(response, 200, { session: context.accountManager.resetSession(sessionAction.accountId, sessionAction.sessionId) });
    return;
  }
  const sessionMatch = matchPath(url.pathname, "/api/sessions/:accountId/:sessionId");
  if (method === "PATCH" && sessionMatch) {
    const body = sessionPatchSchema.parse(await readJsonBody(request));
    let session;
    if (body.title !== undefined) {
      session = context.accountManager.renameSession(
        sessionMatch.accountId,
        sessionMatch.sessionId,
        body.title
      );
    }
    if (body.model !== undefined || body.effort !== undefined || body.streamReplies !== undefined) {
      session = context.accountManager.updateSessionRuntime(
        sessionMatch.accountId,
        sessionMatch.sessionId,
        {
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.effort !== undefined ? { effort: body.effort } : {}),
          ...(body.streamReplies !== undefined ? { streamReplies: body.streamReplies } : {})
        }
      );
    }
    sendJson(response, 200, {
      session
    });
    return;
  }
  if (method === "DELETE" && sessionMatch) {
    context.accountManager.deleteSession(sessionMatch.accountId, sessionMatch.sessionId);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "PUT" && url.pathname === "/api/config") {
    const input = configSchema.parse(await readJsonBody(request));
    const current = loadConfig(context.paths);
    const defaultCwd = path.resolve(input.defaultCwd);
    const allowedWorkspaces = [...new Set([...input.allowedWorkspaces.map((workspace) => path.resolve(workspace)), defaultCwd])];
    saveConfig(context.paths, {
      ...current,
      ...input,
      defaultCwd,
      allowedWorkspaces,
      codexExecSandbox: input.codexExecSandbox ?? undefined,
      model: optionalString(input.model),
      effort: optionalString(input.effort)
    });
    await context.accountManager.restartRunning();
    sendJson(response, 200, {
      config: loadConfig(context.paths),
      codexRuntime: await readCodexRuntime(context),
      codexModels: await readCodexModels(context)
    });
    return;
  }

  if (method === "GET" && !url.pathname.startsWith("/api/")) {
    serveStatic(response, url.pathname);
    return;
  }
  sendJson(response, 404, { error: "Not found" });
}

async function readCodexProjects(context: HandlerContext): Promise<readonly CodexProjectCandidate[]> {
  return await context.codexProjectsProvider?.() ?? await context.accountManager.listCodexProjects();
}

function readProductVersion(): string {
  try {
    const packageJson = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
  } catch {
    return "unknown";
  }
}

function readCodexRuntime(context: HandlerContext): Promise<CodexRuntimeInfo> {
  return (context.codexRuntimeCheck ?? (() => context.accountManager.getCodexRuntimeInfo()))();
}

function readCodexModels(context: HandlerContext): Promise<CodexModelOption[]> {
  return (context.codexModelsCheck ?? (() => context.accountManager.getCodexModels()))();
}

function serveStatic(response: ServerResponse, pathname: string): void {
  const files: Record<string, { name: string; type: string }> = {
    "/": { name: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
    "/favicon.ico": { name: "favicon.svg", type: "image/svg+xml" },
    "/favicon.svg": { name: "favicon.svg", type: "image/svg+xml" },
    "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
    "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
    "/account-mode-settings.js": { name: "account-mode-settings.js", type: "text/javascript; charset=utf-8" },
    "/knowledge-bases.js": { name: "knowledge-bases.js", type: "text/javascript; charset=utf-8" },
    "/vendor/lucide.min.js": { name: "vendor/lucide.min.js", type: "text/javascript; charset=utf-8" },
    "/vendor/marked.umd.js": { name: "vendor/marked.umd.js", type: "text/javascript; charset=utf-8" },
    "/vendor/purify.min.js": { name: "vendor/purify.min.js", type: "text/javascript; charset=utf-8" }
  };
  const asset = files[pathname];
  if (!asset) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  const filePath = path.join(webRoot, asset.name);
  if (!fs.existsSync(filePath)) {
    sendJson(response, 503, { error: "Web assets are not built" });
    return;
  }
  response.statusCode = 200;
  response.setHeader("Content-Type", asset.type);
  response.end(fs.readFileSync(filePath));
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src http://127.0.0.1:* http://localhost:*; frame-ancestors app://-");
}

function isAllowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function matchPath(pathname: string, pattern: string): Record<string, string> | undefined {
  const actual = pathname.split("/").filter(Boolean);
  const expected = pattern.split("/").filter(Boolean);
  if (actual.length !== expected.length) return undefined;
  const values: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const segment = expected[index];
    if (segment.startsWith(":")) {
      values[segment.slice(1)] = decodeURIComponent(actual[index]);
    } else if (segment !== actual[index]) {
      return undefined;
    }
  }
  return values;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBodyBuffer(request, 1024 * 1024);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

async function readBodyBuffer(request: IncomingMessage, maxBytes: number, limitMessage = "Request body is too large"): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error(limitMessage);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new Error(limitMessage);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readSessionMessageBody(
  request: IncomingMessage,
  maxUploadBytes: number
): Promise<{ text: string; uploads: SessionUpload[] }> {
  const contentType = request.headers["content-type"];
  const normalizedContentType = Array.isArray(contentType) ? contentType[0] : contentType ?? "";
  if (!normalizedContentType.toLowerCase().startsWith("multipart/form-data")) {
    const body = bodySchema.parse(await readJsonBody(request));
    return { text: requiredString(body.text, "text"), uploads: [] };
  }

  const limitMessage = `Attachments exceed the ${formatByteLimit(maxUploadBytes)} limit`;
  const raw = await readBodyBuffer(request, maxUploadBytes + MULTIPART_OVERHEAD_BYTES, limitMessage);
  let formData: FormData;
  try {
    formData = await new Response(new Uint8Array(raw), {
      headers: { "Content-Type": normalizedContentType }
    }).formData();
  } catch {
    throw new Error("Invalid multipart form data");
  }
  const textEntry = formData.get("text");
  const text = typeof textEntry === "string" ? textEntry.trim() : "";
  const fileEntries = formData.getAll("files");
  if (fileEntries.length > MAX_WEB_UPLOAD_FILES) {
    throw new Error(`Too many attachments; maximum is ${MAX_WEB_UPLOAD_FILES}`);
  }
  const uploads: SessionUpload[] = [];
  let totalBytes = 0;
  for (const entry of fileEntries) {
    if (typeof entry === "string") {
      throw new Error("Invalid attachment");
    }
    const data = Buffer.from(await entry.arrayBuffer());
    totalBytes += data.length;
    if (totalBytes > maxUploadBytes) {
      throw new Error(limitMessage);
    }
    uploads.push({ name: entry.name, data });
  }
  if (!text && !uploads.length) {
    throw new Error("Message text or attachment is required");
  }
  return { text, uploads };
}

function formatByteLimit(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} byte${bytes === 1 ? "" : "s"}`;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorStatus(error: unknown, message: string): number {
  if (error instanceof z.ZodError) return 400;
  if (/not found/i.test(message)) return 404;
  if (/already in progress|no newer/i.test(message)) return 409;
  if (/unable to verify|timed out/i.test(message)) return 503;
  return /required|invalid|allowed|empty|too large|too many|exceed|transition/i.test(message) ? 400 : 500;
}

function requestErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Invalid request";
  return error instanceof Error ? error.message : String(error);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(value)}\n`);
}

function startNdjson(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Accel-Buffering", "no");
}

async function writeNdjson(response: ServerResponse, value: unknown): Promise<void> {
  if (response.destroyed || response.writableEnded) return;
  if (response.write(`${JSON.stringify(value)}\n`)) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
  });
}

function withAttachmentUrls(
  messages: SessionHistoryMessage[],
  accountId: string,
  sessionId: string
): Array<SessionHistoryMessage & { attachments: Array<SessionHistoryMessage["attachments"][number] & { url?: string }> }> {
  return messages.map((message) => ({
    ...message,
    attachments: (message.attachments ?? []).map((attachment) => ({
      ...attachment,
      ...(attachment.available ? {
        url: [
          "/api/sessions",
          encodeURIComponent(accountId),
          encodeURIComponent(sessionId),
          "messages",
          encodeURIComponent(message.id),
          "attachments",
          String(attachment.index)
        ].join("/")
      } : {})
    }))
  }));
}

function serveSessionAttachment(
  request: IncomingMessage,
  response: ServerResponse,
  attachment: SessionAttachmentFile,
  download: boolean,
  headOnly: boolean
): void {
  const stat = fs.statSync(attachment.path);
  if (!stat.isFile()) {
    throw new Error("Session attachment not found");
  }
  const range = parseByteRange(request.headers.range, stat.size);
  if (range === null) {
    response.statusCode = 416;
    response.setHeader("Content-Range", `bytes */${stat.size}`);
    response.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? stat.size - 1;
  response.statusCode = range ? 206 : 200;
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Content-Type", mediaContentType(attachment.name));
  response.setHeader("Content-Length", String(Math.max(0, end - start + 1)));
  response.setHeader(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(attachment.name)}`
  );
  if (range) {
    response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  }
  if (headOnly || stat.size === 0) {
    response.end();
    return;
  }
  const stream = fs.createReadStream(attachment.path, { start, end });
  stream.on("error", (error) => {
    if (!response.headersSent) {
      sendJson(response, 500, { error: error.message });
    } else {
      response.destroy(error);
    }
  });
  stream.pipe(response);
}

function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | null | undefined {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || size <= 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) {
    return null;
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function mediaContentType(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return ({
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".m4v": "video/x-m4v",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".wav": "audio/wav",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".zip": "application/zip"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

export async function checkCodex(codexBin: string): Promise<{ ready: boolean; version?: string; error?: string }> {
  try {
    const command = resolveCodexCommand(codexBin);
    const result = await execFileAsync(command.command, [...command.argsPrefix, "--version"], {
      timeout: 5_000,
      windowsHide: true
    });
    return { ready: true, version: result.stdout.trim() || result.stderr.trim() || codexBin };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : String(error) };
  }
}
