import crypto from "node:crypto";
import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";

import type { ProjectInteractionMode } from "../channels/channel-mode-settings.js";

import { readJsonObjectFile, isJsonObject, writeJsonFile } from "./json-store.js";
import {
  cleanKnowledgeInput,
  knowledgeIdentity,
  selectRelevantKnowledge,
  type KnowledgeEntry,
  type KnowledgeInput
} from "./knowledge.js";
import type { StatePaths } from "./paths.js";
import { DEFAULT_SESSION_PAGE_SIZE, isSessionPageSize } from "./session-list-settings.js";
import { bindingExpiry, normalizeBindingActivity, idleDays, validIdleDays, type BindingActivity, type BindingExpiry } from "./binding-expiry.js";

export type ManagedSession = {
  id: string;
  senderId: string;
  title: string;
  workspace: string;
  projectId?: string;
  /** Explicit absence; omitted only for legacy/project-scoped records. */
  projectBinding?: "none";
  hostId?: string;
  mode?: "session" | "qa";
  knowledgeBaseId?: string;
  threadId?: string;
  lastPromptPreview?: string;
  model?: string;
  effort?: string;
  streamReplies?: boolean;
  collaborationMode?: "default" | "plan";
  follow?: boolean;
  /** Detaching suspends delivery without discarding the user's follow preference. */
  followBeforeDetach?: boolean;
  activeMessagePolicy?: "ask" | "steer" | "queue";
  createdAt: string;
  updatedAt: string;
};

export type ManagedProject = {
  id: string;
  name: string;
  workspace: string;
  rootPaths?: readonly string[];
  sourceProjectId?: string;
  projectKind?: "local" | "remote";
  hostId?: string;
  knowledgeBaseId?: string;
  notifications?: ProjectNotificationTarget[];
  createdAt: string;
  updatedAt: string;
};

export type ManagedKnowledgeBase = {
  id: string;
  name: string;
  rootPath: string;
  engineRoot?: string;
  stateDir?: string;
  createdAt: string;
  updatedAt: string;
};

export type { ProjectInteractionMode } from "../channels/channel-mode-settings.js";

export type ProjectNotificationTarget = {
  accountId: string;
  recipientId: string;
  enabled: boolean;
};

export type SessionRuntimeOverrides = {
  model?: string | null;
  effort?: string | null;
  streamReplies?: boolean | null;
};

/** Compare the exact edge shown by a client, not just a thread or directory. */
export type SessionBindingTarget = { conversationId: string; hostId: string; threadId: string | null };
export class SessionBindingConflictError extends Error {
  constructor() { super("绑定已改变，请刷新后确认要解绑的 IM 对话与 session。"); }
}

export type RuntimeState = {
  approvalSequence: number;
  sessionPageSizes: Record<string, number>;
  conversationRoles: Record<string, Record<string, "viewer" | "participant" | "controller">>;
  pairedSenderIds: string[];
  lastActiveSenderId?: string;
  lastActiveActorId?: string;
  lastAuthorizedSenderId?: string;
  lastAuthorizedActorId?: string;
  authorizedConversationsByActor: Record<string, string>;
  syncKey?: string;
  processedMessageIds: string[];
  contextTokens: Record<string, string>;
  sessions: ManagedSession[];
  projects: ManagedProject[];
  knowledgeBases: ManagedKnowledgeBase[];
  activeSessionIds: Record<string, string>;
  activeQaSessionIds: Record<string, string>;
  activeProjectIds: Record<string, string>;
  /** An explicit /unbind or /leave survives restarts and project selection. */
  detachedSessionSenders: string[];
  /** Activity/policy only; activeSessionIds/activeQaSessionIds still own bindings. */
  bindingActivity: Record<string, BindingActivity>;
  interactionModes: Record<string, ProjectInteractionMode>;
  pendingDeliveries: Array<{
    id: string;
    senderId: string;
    text: string;
    createdAt: string;
  }>;
  knowledge: KnowledgeEntry[];
  knowledgeEnabled: boolean;
};

export function emptyRuntimeState(): RuntimeState {
  return {
    approvalSequence: 0,
    sessionPageSizes: {},
    conversationRoles: {},
    pairedSenderIds: [],
    authorizedConversationsByActor: {},
    processedMessageIds: [],
    contextTokens: {},
    sessions: [],
    projects: [],
    knowledgeBases: [],
    activeSessionIds: {},
    activeQaSessionIds: {},
    activeProjectIds: {},
    detachedSessionSenders: [],
    bindingActivity: {},
    interactionModes: {},
    pendingDeliveries: [],
    knowledge: [],
    knowledgeEnabled: true
  };
}

export class RuntimeStateStore {
  private state!: RuntimeState;
  private revision?: string;

  constructor(private readonly paths: StatePaths) {
    this.refresh();
  }

  /** Reconcile external administrative edits without constructing another writer. */
  refresh(): void {
    const revision = stateRevision(this.paths.statePath);
    if (this.state && revision === this.revision) return;
    if (this.state && this.revision && !revision) throw Error("账号状态文件丢失，未初始化为空状态。");
    const loaded = readJsonObjectFile<Partial<RuntimeState>>(this.paths.statePath, {});
    for (const key of ["activeSessionIds", "activeQaSessionIds", "activeProjectIds", "contextTokens", "conversationRoles"] as const) {
      if (loaded[key] !== undefined && !isJsonObject(loaded[key])) throw new Error(`Invalid runtime ${key}; original state preserved`);
    }
    for (const key of ["sessions", "projects", "knowledgeBases", "pairedSenderIds"] as const) {
      if (loaded[key] !== undefined && !Array.isArray(loaded[key])) throw new Error(`Invalid runtime ${key}; original state preserved`);
    }
    this.revision = revision;
    const before = structuredClone(loaded);
    this.state = normalizeRuntimeState(loaded);
    for (const sender of new Set([...Object.keys(this.state.activeSessionIds), ...Object.keys(this.state.activeQaSessionIds)])) {
      const bound = this.getBoundSession(sender);
      // The selected native edge owns its project projection. Repair legacy
      // context drift without selecting a session or reviving detached chats.
      if (bound?.projectId) this.state.activeProjectIds[sender] = bound.projectId;
      else if (bound?.projectBinding === "none") delete this.state.activeProjectIds[sender];
      if (bound && (!this.state.bindingActivity[sender] || this.state.bindingActivity[sender].endedAt)) {
        this.renewBindingActivity(sender);
      }
    }
    // Persist actual initialization/migration, never a no-op read.
    if (!isDeepStrictEqual(this.state, before)) this.save();
  }

  get snapshot(): RuntimeState {
    return structuredClone(this.state);
  }

  allocateApprovalId(): string {
    this.state.approvalSequence += 1;
    this.save();
    return `A${this.state.approvalSequence}`;
  }

  getSessionPageSize(conversationId: string, actorId: string): number {
    return this.state.sessionPageSizes[JSON.stringify([conversationId, actorId])] ?? DEFAULT_SESSION_PAGE_SIZE;
  }

  setSessionPageSize(conversationId: string, actorId: string, size: number): void {
    if (!isSessionPageSize(size)) throw new Error("Invalid session page size");
    this.state.sessionPageSizes[JSON.stringify([conversationId, actorId])] = size;
    this.save();
  }

  get controlJournalPath(): string { return path.join(this.paths.runtimeDir, "session-controls.json"); }
  get approvalJournalPath(): string { return path.join(path.dirname(this.paths.statePath), "approvals.json"); }

  /** Shared by all IM accounts and backends, never stored in Codex's database. */
  get sessionPurposeRegistryPath(): string { return path.join(this.paths.root, "session-purposes.json"); }

  /** Account-local durable workspaces, separate from credentials and registered projects. */
  get standaloneWorkspacesDir(): string { return path.join(path.dirname(this.paths.statePath), "workspaces", "standalone"); }

  roleFor(conversationId: string, actorId: string): "viewer" | "participant" | "controller" | undefined {
    const roles = this.state.conversationRoles[conversationId];
    return roles && Object.hasOwn(roles, actorId) ? roles[actorId] : undefined;
  }

  setRole(conversationId: string, actorId: string, role: "viewer" | "participant" | "controller"): void {
    if (!Object.hasOwn(this.state.conversationRoles, conversationId)) {
      Object.defineProperty(this.state.conversationRoles, conversationId, { value: {}, enumerable: true, writable: true, configurable: true });
    }
    const roles = this.state.conversationRoles[conversationId];
    Object.defineProperty(roles, actorId, { value: role, enumerable: true, configurable: true, writable: true });
    this.save();
  }

  setSessionFollow(sessionId: string, follow: boolean): void {
    const session = this.mutableSession(sessionId);
    session.follow = follow;
    delete session.followBeforeDetach;
    this.save();
  }

  setActiveMessagePolicy(sessionId: string, policy: "ask" | "steer" | "queue"): void {
    this.mutableSession(sessionId).activeMessagePolicy = policy;
    this.save();
  }

  leaveSession(senderId: string, reason: "manual" | "idle" = "manual"): void {
    this.detachSessionSelection(senderId, reason);
    this.save();
  }

  private detachSessionSelection(senderId: string, reason: "manual" | "idle"): void {
    const endedSessionId = this.getBoundSession(senderId)?.id;
    for (const session of [this.mutableActiveSession(senderId), this.mutableActiveQaSession(senderId)]) {
      if (session) {
        session.followBeforeDetach ??= session.follow !== false;
        session.follow = false;
      }
    }
    delete this.state.activeSessionIds[senderId];
    delete this.state.activeQaSessionIds[senderId];
    this.state.detachedSessionSenders = [...new Set([...this.state.detachedSessionSenders, senderId])];
    const activity = this.state.bindingActivity[senderId];
    if (activity) Object.assign(activity, { generation: crypto.randomUUID(), endedAt: new Date().toISOString(), endedReason: reason, endedSessionId });
  }

  isSessionDetached(senderId: string): boolean {
    return this.state.detachedSessionSenders.includes(senderId);
  }

  getBoundSession(senderId: string): ManagedSession | undefined {
    if (this.isSessionDetached(senderId)) return undefined;
    const session = this.getInteractionMode(senderId) === "qa"
      ? this.getActiveQaSession(senderId) : this.getActiveSession(senderId);
    return session && (session.projectId ? Boolean(this.getProject(session.projectId)) : session.projectBinding === "none") ? session : undefined;
  }

  sessionBindingTarget(session: ManagedSession): SessionBindingTarget {
    return { conversationId: session.senderId,
      hostId: session.hostId ?? this.getProject(session.projectId ?? "")?.hostId ?? "local",
      threadId: session.threadId ?? null };
  }

  unbindSession(sessionId: string, expected: SessionBindingTarget, reason: "manual" | "idle" = "manual"): { session: ManagedSession; changed: boolean } {
    const session = this.mutableSession(sessionId);
    const target = this.sessionBindingTarget(session);
    if (target.conversationId !== expected.conversationId || target.hostId !== expected.hostId || target.threadId !== expected.threadId) {
      throw new SessionBindingConflictError();
    }
    const bound = this.getBoundSession(session.senderId);
    if (bound && bound.id !== session.id) throw new SessionBindingConflictError();
    // An already detached edge is idempotent. Never detach a replacement.
    const selected = this.state.activeSessionIds[session.senderId] === session.id
      || this.state.activeQaSessionIds[session.senderId] === session.id;
    if (!selected) return { session: structuredClone(session), changed: false };
    this.leaveSession(session.senderId, reason);
    return { session: structuredClone(session), changed: true };
  }

  private renewBindingActivity(senderId: string, now = Date.now()): void {
    const previous = this.state.bindingActivity[senderId];
    Object.defineProperty(this.state.bindingActivity, senderId, { enumerable: true, configurable: true, writable: true,
      value: { generation: crypto.randomUUID(), baselineAt: new Date(now).toISOString(),
        ...(previous?.lastHumanAt ? { lastHumanAt: previous.lastHumanAt } : {}),
        ...(previous?.idleDays !== undefined ? { idleDays: previous.idleDays } : {}),
        ...(previous?.policyBasisDays !== undefined ? { policyBasisDays: previous.policyBasisDays } : {}) } });
  }

  recordBindingHumanActivity(senderId: string, now = Date.now()): void {
    if (!this.getBoundSession(senderId)) return;
    if (!this.state.bindingActivity[senderId]) this.renewBindingActivity(senderId, now);
    const activity = this.state.bindingActivity[senderId];
    activity.lastHumanAt = new Date(Math.max(now, Date.parse(activity.lastHumanAt ?? activity.baselineAt))).toISOString();
    activity.generation = crypto.randomUUID(); this.save();
  }

  /** Apply a changed policy with a full grace period, including across restart. */
  prepareBindingExpiry(defaultDays: number, now = Date.now()): void {
    let changed = false;
    for (const [sender, activity] of Object.entries(this.state.bindingActivity)) {
      if (!this.getBoundSession(sender)) continue;
      const days = activity.idleDays ?? idleDays(defaultDays);
      if (activity.policyBasisDays === days) continue;
      activity.policyBasisDays = days; activity.baselineAt = new Date(now).toISOString();
      activity.generation = crypto.randomUUID(); changed = true;
    }
    if (changed) this.save();
  }

  getBindingExpiry(senderId: string, defaultDays: number, now = Date.now()): BindingExpiry | undefined {
    const activity = this.state.bindingActivity[senderId];
    return activity && bindingExpiry(structuredClone(activity), Boolean(this.getBoundSession(senderId)), defaultDays, now);
  }

  selectedConversationSessions(senderId: string): ManagedSession[] {
    if (this.isSessionDetached(senderId)) return [];
    return [this.getActiveSession(senderId), this.getActiveQaSession(senderId)].filter((session): session is ManagedSession => Boolean(session));
  }

  setBindingIdleDays(sessionId: string, expected: SessionBindingTarget & { generation: string }, days: number | null, defaultDays: number): void {
    if (days !== null && !validIdleDays(days)) throw new Error("自动解绑期限必须是 0–3650 的整数天数。");
    const session = this.state.sessions.find(item => item.id === sessionId);
    if (!session) throw new SessionBindingConflictError();
    const target = this.sessionBindingTarget(session);
    const activity = this.state.bindingActivity[session.senderId];
    if (this.getBoundSession(session.senderId)?.id !== sessionId || !activity || activity.generation !== expected.generation
      || target.conversationId !== expected.conversationId || target.hostId !== expected.hostId || target.threadId !== expected.threadId) throw new SessionBindingConflictError();
    if (days === null) delete activity.idleDays; else activity.idleDays = days;
    activity.policyBasisDays = days ?? idleDays(defaultDays); activity.baselineAt = new Date().toISOString();
    activity.generation = crypto.randomUUID(); this.save();
  }

  expireBinding(sessionId: string, expected: SessionBindingTarget & { generation: string }, defaultDays: number, now = Date.now()): boolean {
    const session = this.getSession(sessionId);
    if (!session || this.getBoundSession(session.senderId)?.id !== sessionId) return false;
    const expiry = this.getBindingExpiry(session.senderId, defaultDays, now);
    if (!expiry || expiry.generation !== expected.generation || expiry.status !== "due") return false;
    return this.unbindSession(sessionId, expected, "idle").changed;
  }

  save(): void {
    if (stateRevision(this.paths.statePath) !== this.revision) {
      this.refresh();
      throw new Error("账号状态已被其他写入者修改，本次旧快照未保存；请刷新后重试。");
    }
    try { writeJsonFile(this.paths.statePath, this.state); }
    catch (error) {
      // A failed commit must not leave the live owner advertising an unsaved mutation.
      if (this.revision) { this.revision = undefined; this.refresh(); }
      throw error;
    }
    this.revision = stateRevision(this.paths.statePath);
  }

  listPairedSenderIds(): string[] {
    return [...new Set(this.state.pairedSenderIds)].sort();
  }

  setPairedSenderIds(senderIds: string[]): void {
    this.state.pairedSenderIds = [...new Set(senderIds)].sort();
    this.save();
  }

  rememberContextToken(senderId: string, token: string): void {
    this.state.contextTokens[senderId] = token;
    this.state.lastActiveSenderId = senderId;
    this.save();
  }

  getContextToken(senderId: string): string | undefined {
    return this.state.contextTokens[senderId];
  }

  getLastActiveSenderId(): string | undefined {
    return this.state.lastActiveSenderId;
  }

  rememberChannelIdentity(actorId: string, conversationId: string, authorized: boolean): void {
    if (!actorId || !conversationId) return;
    this.state.lastActiveActorId = actorId;
    this.state.lastActiveSenderId = conversationId;
    if (authorized) {
      this.state.lastAuthorizedActorId = actorId;
      this.state.lastAuthorizedSenderId = conversationId;
      this.state.authorizedConversationsByActor[actorId] = conversationId;
    }
    this.save();
  }

  getAuthorizedConversation(actorId: string): string | undefined {
    const linkedConversation = this.state.authorizedConversationsByActor[actorId];
    if (linkedConversation) return linkedConversation;
    if (this.state.lastAuthorizedActorId === actorId) {
      return this.state.lastAuthorizedSenderId;
    }
    return undefined;
  }

  getLastActiveActorId(): string | undefined {
    return this.state.lastActiveActorId;
  }

  getLastAuthorizedSenderId(): string | undefined {
    return this.state.lastAuthorizedSenderId;
  }

  getLastAuthorizedActorId(): string | undefined {
    return this.state.lastAuthorizedActorId;
  }

  getSyncKey(): string | undefined {
    return this.state.syncKey;
  }

  setSyncKey(syncKey: string): void {
    if (!syncKey || this.state.syncKey === syncKey) {
      return;
    }
    this.state.syncKey = syncKey;
    this.save();
  }

  claimProcessedMessage(messageId: string): boolean {
    const id = messageId.trim();
    if (!id || this.state.processedMessageIds.includes(id)) {
      return false;
    }
    this.state.processedMessageIds.push(id);
    this.state.processedMessageIds = this.state.processedMessageIds.slice(-1_000);
    this.save();
    return true;
  }

  setWorkspace(senderId: string, workspace: string): void {
    this.ensureActiveSession(senderId, workspace);
    const session = this.mutableActiveSession(senderId)!;
    const resolvedWorkspace = path.resolve(workspace);
    const project = this.projectForWorkspace(resolvedWorkspace);
    session.workspace = resolvedWorkspace;
    session.projectId = project.id;
    delete session.threadId;
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  getWorkspace(senderId: string): string | undefined {
    return this.getActiveSession(senderId)?.workspace;
  }

  setThread(senderId: string, threadId: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (threadId) {
      session.threadId = threadId;
    } else {
      delete session.threadId;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  getThread(senderId: string): string | undefined {
    return this.getActiveSession(senderId)?.threadId;
  }

  setModelOverride(senderId: string, model?: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (model?.trim()) {
      session.model = model.trim();
    } else {
      delete session.model;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  setEffortOverride(senderId: string, effort?: string): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (effort?.trim()) {
      session.effort = effort.trim();
    } else {
      delete session.effort;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  setStreamRepliesOverride(senderId: string, streamReplies?: boolean): void {
    const session = this.mutableActiveSession(senderId);
    if (!session) {
      throw new Error(`No active session for sender: ${senderId}`);
    }
    if (typeof streamReplies === "boolean") {
      session.streamReplies = streamReplies;
    } else {
      delete session.streamReplies;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
  }

  setSessionCollaborationMode(sessionId: string, mode: "default" | "plan"): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (mode === "plan") session.collaborationMode = mode;
    else delete session.collaborationMode;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  listSessions(): ManagedSession[] {
    return structuredClone(this.state.sessions)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listProjects(): ManagedProject[] {
    return structuredClone(this.state.projects)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getProject(projectId: string): ManagedProject | undefined {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    return project ? structuredClone(project) : undefined;
  }

  listKnowledgeBases(): ManagedKnowledgeBase[] {
    return structuredClone(this.state.knowledgeBases)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  createKnowledgeBase(
    name: string,
    rootPath: string,
    options: { engineRoot?: string; stateDir?: string } = {}
  ): ManagedKnowledgeBase {
    const resolvedRoot = path.resolve(rootPath);
    const existing = this.state.knowledgeBases.find((item) => item.rootPath === resolvedRoot);
    if (existing) {
      throw new Error(`Knowledge base root already exists: ${resolvedRoot}`);
    }
    const now = new Date().toISOString();
    const knowledgeBase: ManagedKnowledgeBase = {
      id: crypto.randomUUID(),
      name: cleanProjectName(name),
      rootPath: resolvedRoot,
      ...(options.engineRoot ? { engineRoot: path.resolve(options.engineRoot) } : {}),
      ...(options.stateDir ? { stateDir: path.resolve(options.stateDir) } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.state.knowledgeBases.push(knowledgeBase);
    this.save();
    return structuredClone(knowledgeBase);
  }

  updateKnowledgeBase(
    knowledgeBaseId: string,
    input: { name?: string; rootPath?: string; engineRoot?: string | null; stateDir?: string | null }
  ): ManagedKnowledgeBase {
    const knowledgeBase = this.mutableKnowledgeBase(knowledgeBaseId);
    if (input.name !== undefined) knowledgeBase.name = cleanProjectName(input.name);
    if (input.rootPath !== undefined) {
      const resolvedRoot = path.resolve(input.rootPath);
      const duplicate = this.state.knowledgeBases.some((item) => (
        item.id !== knowledgeBaseId && item.rootPath === resolvedRoot
      ));
      if (duplicate) throw new Error(`Knowledge base root already exists: ${resolvedRoot}`);
      knowledgeBase.rootPath = resolvedRoot;
    }
    if (input.engineRoot !== undefined) {
      if (input.engineRoot) knowledgeBase.engineRoot = path.resolve(input.engineRoot);
      else delete knowledgeBase.engineRoot;
    }
    if (input.stateDir !== undefined) {
      if (input.stateDir) knowledgeBase.stateDir = path.resolve(input.stateDir);
      else delete knowledgeBase.stateDir;
    }
    knowledgeBase.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(knowledgeBase);
  }

  deleteKnowledgeBase(knowledgeBaseId: string): void {
    this.mutableKnowledgeBase(knowledgeBaseId);
    if (this.state.projects.some((project) => project.knowledgeBaseId === knowledgeBaseId)) {
      throw new Error("Knowledge base is still bound to a project");
    }
    this.state.knowledgeBases = this.state.knowledgeBases.filter((item) => item.id !== knowledgeBaseId);
    this.state.sessions = this.state.sessions.filter((session) => session.knowledgeBaseId !== knowledgeBaseId);
    this.save();
  }

  listKnowledge(): KnowledgeEntry[] {
    return structuredClone(this.state.knowledge)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  relevantKnowledge(query: string, projectId?: string, limit = 20): KnowledgeEntry[] {
    if (!this.state.knowledgeEnabled) return [];
    return selectRelevantKnowledge(this.state.knowledge, query, projectId, limit);
  }

  rememberKnowledge(input: KnowledgeInput, projectId?: string, sourceSessionId?: string): KnowledgeEntry | undefined {
    if (!this.state.knowledgeEnabled) return undefined;
    const clean = cleanKnowledgeInput(input);
    if (!clean) return undefined;
    const scopedProjectId = clean.scope === "project" ? projectId : undefined;
    if (clean.scope === "project" && !scopedProjectId) return undefined;
    const identity = knowledgeIdentity(clean, scopedProjectId);
    const existing = this.state.knowledge.find((entry) => knowledgeIdentity(entry, entry.projectId) === identity);
    const now = new Date().toISOString();
    if (existing) {
      existing.content = clean.content;
      existing.updatedAt = now;
      if (sourceSessionId) existing.sourceSessionId = sourceSessionId;
      this.save();
      return structuredClone(existing);
    }
    const entry: KnowledgeEntry = {
      id: crypto.randomUUID(),
      ...clean,
      ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
      ...(sourceSessionId ? { sourceSessionId } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.state.knowledge.unshift(entry);
    this.state.knowledge = this.state.knowledge.slice(0, 200);
    this.save();
    return structuredClone(entry);
  }

  deleteKnowledge(knowledgeId: string): void {
    if (!this.state.knowledge.some((entry) => entry.id === knowledgeId)) {
      throw new Error(`Knowledge entry not found: ${knowledgeId}`);
    }
    this.state.knowledge = this.state.knowledge.filter((entry) => entry.id !== knowledgeId);
    this.save();
  }

  clearKnowledge(): void {
    this.state.knowledge = [];
    this.save();
  }

  isKnowledgeEnabled(): boolean {
    return this.state.knowledgeEnabled;
  }

  setKnowledgeEnabled(enabled: boolean): void {
    this.state.knowledgeEnabled = enabled;
    this.save();
  }

  createProject(
    name: string,
    workspace: string,
    metadata: { sourceProjectId?: string; projectKind?: "local" | "remote"; hostId?: string; rootPaths?: readonly string[] } = {}
  ): ManagedProject {
    const resolvedWorkspace = path.resolve(workspace);
    const existing = this.state.projects.find((project) => (
      project.workspace === resolvedWorkspace
      && (project.hostId ?? "local") === (metadata.hostId ?? "local")
    ));
    if (existing) {
      throw new Error(`Project workspace already exists: ${resolvedWorkspace}`);
    }
    const now = new Date().toISOString();
    const project: ManagedProject = {
      id: crypto.randomUUID(),
      name: cleanProjectName(name),
      workspace: resolvedWorkspace,
      notifications: [],
      ...(metadata.rootPaths?.length ? { rootPaths: [...metadata.rootPaths] } : {}),
      ...(metadata.sourceProjectId ? { sourceProjectId: metadata.sourceProjectId } : {}),
      ...(metadata.projectKind ? { projectKind: metadata.projectKind } : {}),
      ...(metadata.hostId ? { hostId: metadata.hostId } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.state.projects.push(project);
    this.save();
    return structuredClone(project);
  }

  renameProject(projectId: string, name: string): ManagedProject {
    const project = this.mutableProject(projectId);
    project.name = cleanProjectName(name);
    project.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(project);
  }

  updateProjectMetadata(
    projectId: string,
    metadata: { sourceProjectId?: string; projectKind?: "local" | "remote"; hostId?: string; rootPaths?: readonly string[] }
  ): ManagedProject {
    const project = this.mutableProject(projectId);
    if (metadata.sourceProjectId) project.sourceProjectId = metadata.sourceProjectId;
    if (metadata.projectKind) project.projectKind = metadata.projectKind;
    if (metadata.hostId) project.hostId = metadata.hostId;
    if (Object.hasOwn(metadata, "rootPaths")) {
      if (metadata.rootPaths?.length) project.rootPaths = [...metadata.rootPaths];
      else delete project.rootPaths;
    }
    project.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(project);
  }

  bindProjectKnowledgeBase(projectId: string, knowledgeBaseId?: string): ManagedProject {
    const project = this.mutableProject(projectId);
    if (knowledgeBaseId) {
      this.mutableKnowledgeBase(knowledgeBaseId);
      project.knowledgeBaseId = knowledgeBaseId;
    } else {
      delete project.knowledgeBaseId;
      for (const [senderId, activeProjectId] of Object.entries(this.state.activeProjectIds)) {
        if (activeProjectId === projectId && this.state.interactionModes[senderId] === "qa") {
          this.state.interactionModes[senderId] = "session";
        }
      }
    }
    project.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(project);
  }

  activateProject(senderId: string, projectId: string): ManagedProject {
    const project = this.mutableProject(projectId);
    const bound = this.getBoundSession(senderId);
    // Explicit project selection ends an incompatible edge. Getters must not
    // silently hide it while leaving it selected for a future accidental return.
    const incompatible = [this.mutableActiveSession(senderId), this.mutableActiveQaSession(senderId)]
      .filter((session): session is ManagedSession => Boolean(session && session.projectId !== project.id));
    if (incompatible.length && (!bound || incompatible.some(session => session.id === bound.id))) {
      this.detachSessionSelection(senderId, "manual");
    } else for (const session of incompatible) {
      session.follow = false;
      if (this.state.activeSessionIds[senderId] === session.id) delete this.state.activeSessionIds[senderId];
      if (this.state.activeQaSessionIds[senderId] === session.id) delete this.state.activeQaSessionIds[senderId];
    }
    this.state.activeProjectIds[senderId] = project.id;
    this.save();
    return structuredClone(project);
  }

  getActiveProject(senderId: string): ManagedProject | undefined {
    const bound = this.getBoundSession(senderId);
    if (bound) return bound.projectId ? this.getProject(bound.projectId) : undefined;
    const projectId = this.state.activeProjectIds[senderId];
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    return project ? structuredClone(project) : undefined;
  }

  getInteractionMode(senderId: string): ProjectInteractionMode {
    return this.state.interactionModes[senderId] ?? "session";
  }

  setInteractionMode(senderId: string, mode: ProjectInteractionMode): void {
    const previous = this.getInteractionMode(senderId);
    this.state.interactionModes[senderId] = mode;
    if (previous !== mode && this.getBoundSession(senderId)) this.renewBindingActivity(senderId);
    this.save();
  }

  setProjectNotifications(projectId: string, targets: ProjectNotificationTarget[]): ManagedProject {
    const project = this.mutableProject(projectId);
    const unique = new Map<string, ProjectNotificationTarget>();
    for (const target of targets) {
      const accountId = target.accountId.trim();
      const recipientId = target.recipientId.trim();
      if (!accountId || !recipientId) continue;
      unique.set(`${accountId}\u0000${recipientId}`, { accountId, recipientId, enabled: target.enabled });
    }
    project.notifications = [...unique.values()].slice(0, 20);
    project.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(project);
  }

  deleteProject(projectId: string): void {
    this.mutableProject(projectId);
    if (this.state.sessions.some((session) => session.projectId === projectId)) {
      throw new Error("Project still has sessions");
    }
    this.state.projects = this.state.projects.filter((project) => project.id !== projectId);
    for (const [senderId, activeProjectId] of Object.entries(this.state.activeProjectIds)) {
      if (activeProjectId === projectId) delete this.state.activeProjectIds[senderId];
    }
    this.save();
  }

  getSession(sessionId: string): ManagedSession | undefined {
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId);
    return session ? structuredClone(session) : undefined;
  }

  getActiveSession(senderId: string): ManagedSession | undefined {
    const sessionId = this.state.activeSessionIds[senderId];
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId && candidate.senderId === senderId);
    return session ? structuredClone(session) : undefined;
  }

  getActiveQaSession(senderId: string): ManagedSession | undefined {
    const sessionId = this.state.activeQaSessionIds[senderId];
    const session = this.state.sessions.find((candidate) => (
      candidate.id === sessionId && candidate.senderId === senderId && candidate.mode === "qa"
    ));
    return session ? structuredClone(session) : undefined;
  }

  ensureActiveSession(senderId: string, workspace: string): ManagedSession {
    const active = this.mutableActiveSession(senderId);
    if (active) {
      return structuredClone(active);
    }
    return this.createSession(senderId, workspace);
  }

  createSession(
    senderId: string,
    workspace: string,
    title?: string,
    projectId?: string,
    mode: "session" | "qa" = "session",
    knowledgeBaseId?: string,
    context?: { standalone?: boolean; hostId?: string }
  ): ManagedSession {
    const now = new Date().toISOString();
    const resolvedWorkspace = path.resolve(workspace);
    const project = context?.standalone ? undefined : projectId
      ? this.mutableProject(projectId)
      : this.projectForWorkspace(resolvedWorkspace);
    if (project && project.workspace !== resolvedWorkspace) {
      throw new Error("Session workspace must match its project");
    }
    if (mode === "qa" && knowledgeBaseId) this.mutableKnowledgeBase(knowledgeBaseId);
    const number = this.state.sessions.filter((session) => session.senderId === senderId).length + 1;
    const session: ManagedSession = {
      id: crypto.randomUUID(),
      senderId,
      title: cleanTitle(title) ?? `会话 ${number}`,
      workspace: resolvedWorkspace,
      ...(project ? { projectId: project.id } : {}),
      ...(context?.standalone ? { projectBinding: "none" as const } : {}),
      ...(context?.hostId ? { hostId: context.hostId } : {}),
      mode: mode === "qa" ? "qa" : "session",
      ...(mode === "qa" && knowledgeBaseId ? { knowledgeBaseId } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.state.sessions.push(session);
    this.state.detachedSessionSenders = this.state.detachedSessionSenders.filter(id => id !== senderId);
    if (project) this.state.activeProjectIds[senderId] = project.id;
    else delete this.state.activeProjectIds[senderId];
    if (mode === "qa") this.state.activeQaSessionIds[senderId] = session.id;
    else this.state.activeSessionIds[senderId] = session.id;
    this.renewBindingActivity(senderId);
    this.save();
    return structuredClone(session);
  }

  setSessionPromptPreview(sessionId: string, preview: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    const normalized = cleanPromptPreview(preview);
    if (normalized) {
      session.lastPromptPreview = normalized;
      const inferredTitle = cleanTitle(normalized);
      if (inferredTitle && shouldReplaceGeneratedSessionTitle(session.title)) {
        session.title = inferredTitle;
      }
    }
    else delete session.lastPromptPreview;
    this.save();
    return structuredClone(session);
  }

  renameSession(sessionId: string, title: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    const nextTitle = cleanTitle(title);
    if (!nextTitle) {
      throw new Error("Session title cannot be empty");
    }
    session.title = nextTitle;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  activateSession(sessionId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (typeof session.followBeforeDetach === "boolean") {
      session.follow = session.followBeforeDetach;
      delete session.followBeforeDetach;
    }
    this.state.detachedSessionSenders = this.state.detachedSessionSenders.filter(id => id !== session.senderId);
    if (session.mode === "qa") this.state.activeQaSessionIds[session.senderId] = session.id;
    else this.state.activeSessionIds[session.senderId] = session.id;
    if (session.projectId) this.state.activeProjectIds[session.senderId] = session.projectId;
    else if (session.projectBinding === "none") delete this.state.activeProjectIds[session.senderId];
    this.renewBindingActivity(session.senderId);
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  resetSession(sessionId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    delete session.threadId;
    if (this.getBoundSession(session.senderId)?.id === sessionId) this.renewBindingActivity(session.senderId);
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  setSessionThread(sessionId: string, threadId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (threadId) {
      session.threadId = threadId;
    } else {
      delete session.threadId;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  /** One native thread can have many IM edges. Membership changes update every
   * edge on that host atomically, without detaching chats or touching execution. */
  reconcileThreadProject(threadId: string, hostId: string, projectId: string | undefined, cwd?: string): void {
    if (projectId && (this.mutableProject(projectId).hostId ?? "local") !== hostId) throw new Error("项目主机不一致");
    let changed = false;
    for (const session of this.state.sessions) {
      if (session.threadId !== threadId || session.mode === "qa"
        || (session.hostId ?? this.getProject(session.projectId ?? "")?.hostId ?? "local") !== hostId) continue;
      const bound = this.getBoundSession(session.senderId)?.id === session.id;
      const workspace = cwd && path.isAbsolute(cwd) ? cwd : session.workspace;
      if (session.projectId !== projectId || session.workspace !== workspace
        || (projectId ? session.projectBinding === "none" : session.projectBinding !== "none")) {
        session.hostId = hostId; session.workspace = workspace;
        if (projectId) { session.projectId = projectId; delete session.projectBinding; }
        else { delete session.projectId; session.projectBinding = "none"; }
        changed = true;
      }
      if (bound) {
        if (this.state.activeProjectIds[session.senderId] !== projectId) {
          if (projectId) this.state.activeProjectIds[session.senderId] = projectId;
          else delete this.state.activeProjectIds[session.senderId];
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  /** Selecting a Taskboard thread is a binding change, not a retargeted old session. */
  bindProjectThread(senderId: string, projectId: string, threadId: string, title: string): ManagedSession {
    const project = this.mutableProject(projectId);
    const existing = this.state.sessions.find(session => session.senderId === senderId
      && session.mode !== "qa" && session.projectId === projectId && session.threadId === threadId);
    if (existing) return this.activateSession(existing.id);
    const session = this.createSession(senderId, project.workspace, title, projectId);
    return this.setSessionThread(session.id, threadId);
  }

  updateSessionRuntime(sessionId: string, overrides: SessionRuntimeOverrides): ManagedSession {
    const session = this.mutableSession(sessionId);
    if (Object.hasOwn(overrides, "model")) {
      const model = overrides.model?.trim();
      if (model) session.model = model;
      else delete session.model;
    }
    if (Object.hasOwn(overrides, "effort")) {
      const effort = overrides.effort?.trim();
      if (effort) session.effort = effort;
      else delete session.effort;
    }
    if (Object.hasOwn(overrides, "streamReplies")) {
      if (typeof overrides.streamReplies === "boolean") session.streamReplies = overrides.streamReplies;
      else delete session.streamReplies;
    }
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  deleteSession(sessionId: string): void {
    const session = this.mutableSession(sessionId);
    if (this.getBoundSession(session.senderId)?.id === sessionId) {
      this.leaveSession(session.senderId);
    } else {
      // Removing an inactive mode's history must not detach the active mode.
      if (this.state.activeSessionIds[session.senderId] === sessionId) delete this.state.activeSessionIds[session.senderId];
      if (this.state.activeQaSessionIds[session.senderId] === sessionId) delete this.state.activeQaSessionIds[session.senderId];
    }
    this.state.sessions = this.state.sessions.filter((candidate) => candidate.id !== sessionId);
    this.save();
  }

  private mutableSession(sessionId: string): ManagedSession {
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new Error(`Managed session not found: ${sessionId}`);
    }
    return session;
  }

  private mutableProject(projectId: string): ManagedProject {
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw new Error(`Managed project not found: ${projectId}`);
    }
    return project;
  }

  private mutableKnowledgeBase(knowledgeBaseId: string): ManagedKnowledgeBase {
    const knowledgeBase = this.state.knowledgeBases.find((candidate) => candidate.id === knowledgeBaseId);
    if (!knowledgeBase) throw new Error(`Managed knowledge base not found: ${knowledgeBaseId}`);
    return knowledgeBase;
  }

  private projectForWorkspace(workspace: string): ManagedProject {
    const existing = this.state.projects.find((project) => project.workspace === workspace);
    if (existing) return existing;
    const now = new Date().toISOString();
    const project: ManagedProject = {
      id: crypto.randomUUID(),
      name: path.basename(workspace) || workspace,
      workspace,
      notifications: [],
      createdAt: now,
      updatedAt: now
    };
    this.state.projects.push(project);
    return project;
  }

  private mutableActiveSession(senderId: string): ManagedSession | undefined {
    const sessionId = this.state.activeSessionIds[senderId];
    return this.state.sessions.find((candidate) => candidate.id === sessionId && candidate.senderId === senderId);
  }

  private mutableActiveQaSession(senderId: string): ManagedSession | undefined {
    const sessionId = this.state.activeQaSessionIds[senderId];
    return this.state.sessions.find((candidate) => (
      candidate.id === sessionId && candidate.senderId === senderId && candidate.mode === "qa"
    ));
  }
}

function stateRevision(file: string): string | undefined {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function normalizeRuntimeState(value: Partial<RuntimeState>): RuntimeState {
  const sessions = Array.isArray(value.sessions) ? value.sessions : [];
  const projects = Array.isArray(value.projects) ? value.projects : [];
  const knowledgeBases = Array.isArray(value.knowledgeBases) ? value.knowledgeBases : [];
  for (const knowledgeBase of knowledgeBases) {
    knowledgeBase.rootPath = path.resolve(knowledgeBase.rootPath);
    if (knowledgeBase.engineRoot) knowledgeBase.engineRoot = path.resolve(knowledgeBase.engineRoot);
    if (knowledgeBase.stateDir) knowledgeBase.stateDir = path.resolve(knowledgeBase.stateDir);
  }
  for (const project of projects) {
    project.workspace = path.resolve(project.workspace);
    if (project.projectKind !== "local" && project.projectKind !== "remote") delete project.projectKind;
    if (typeof project.sourceProjectId !== "string" || !project.sourceProjectId.trim()) delete project.sourceProjectId;
    if (typeof project.hostId !== "string" || !project.hostId.trim()) delete project.hostId;
    project.notifications = Array.isArray(project.notifications)
      ? project.notifications.filter((target) => Boolean(
        target
        && typeof target.accountId === "string"
        && typeof target.recipientId === "string"
        && typeof target.enabled === "boolean"
      ))
      : [];
  }
  const projectsByWorkspace = new Map(projects
    .filter((project) => project.projectKind !== "remote")
    .map((project) => [project.workspace, project]));
  for (const session of sessions) {
    if (session.projectBinding === "none") {
      delete session.projectId;
      session.mode = "session";
      delete session.knowledgeBaseId;
      continue;
    }
    const workspace = path.resolve(session.workspace);
    let project = session.projectId ? projects.find((candidate) => candidate.id === session.projectId) : undefined;
    if (!project) {
      project = projectsByWorkspace.get(workspace);
    }
    if (!project) {
      const now = session.createdAt || new Date().toISOString();
      project = {
        id: crypto.randomUUID(),
        name: path.basename(workspace) || workspace,
        workspace,
        createdAt: now,
        updatedAt: session.updatedAt || now
      };
      projects.push(project);
      projectsByWorkspace.set(workspace, project);
    }
    session.projectId = project.id;
    session.mode = session.mode === "qa" ? "qa" : "session";
    if (session.collaborationMode !== "plan") delete session.collaborationMode;
    if (session.knowledgeBaseId && !knowledgeBases.some((item) => item.id === session.knowledgeBaseId)) {
      delete session.knowledgeBaseId;
    }
    const inferredTitle = cleanTitle(session.lastPromptPreview);
    if (inferredTitle && shouldReplaceGeneratedSessionTitle(session.title)) {
      session.title = inferredTitle;
    }
  }
  return {
    ...emptyRuntimeState(),
    ...value,
    detachedSessionSenders: Array.isArray(value.detachedSessionSenders)
      ? value.detachedSessionSenders.filter((id): id is string => typeof id === "string") : [],
    bindingActivity: Object.fromEntries(Object.entries(value.bindingActivity && typeof value.bindingActivity === "object"
      && !Array.isArray(value.bindingActivity) ? value.bindingActivity : {}).flatMap(([sender, activity]) => {
      const normalized = normalizeBindingActivity(activity); return normalized ? [[sender, normalized]] : [];
    })),
    approvalSequence: Number.isSafeInteger(value.approvalSequence) && value.approvalSequence! >= 0
      ? value.approvalSequence! : 0,
    sessionPageSizes: value.sessionPageSizes && typeof value.sessionPageSizes === "object" && !Array.isArray(value.sessionPageSizes)
      ? Object.fromEntries(Object.entries(value.sessionPageSizes).filter(([, size]) => isSessionPageSize(size))) : {},
    pairedSenderIds: Array.isArray(value.pairedSenderIds) ? value.pairedSenderIds : [],
    conversationRoles: Object.fromEntries(Object.entries(value.conversationRoles ?? {}).map(([chat, roles]) => [
      chat, Object.fromEntries(Object.entries(roles ?? {}).filter(([, role]) =>
        role === "viewer" || role === "participant" || role === "controller"))
    ])),
    authorizedConversationsByActor: normalizeAuthorizedConversations(value.authorizedConversationsByActor),
    processedMessageIds: Array.isArray(value.processedMessageIds)
      ? value.processedMessageIds.filter((id): id is string => typeof id === "string").slice(-1_000)
      : [],
    contextTokens: value.contextTokens && typeof value.contextTokens === "object" ? value.contextTokens : {},
    sessions,
    projects,
    knowledgeBases,
    activeSessionIds: value.activeSessionIds && typeof value.activeSessionIds === "object" ? value.activeSessionIds : {},
    activeQaSessionIds: value.activeQaSessionIds && typeof value.activeQaSessionIds === "object" ? value.activeQaSessionIds : {},
    activeProjectIds: value.activeProjectIds && typeof value.activeProjectIds === "object" ? value.activeProjectIds : {},
    interactionModes: normalizeInteractionModes(value.interactionModes),
    pendingDeliveries: Array.isArray(value.pendingDeliveries) ? value.pendingDeliveries : [],
    knowledge: Array.isArray(value.knowledge) ? value.knowledge : [],
    knowledgeEnabled: value.knowledgeEnabled !== false
  };
}

function normalizeAuthorizedConversations(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
    Boolean(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1])
  )));
}

function normalizeInteractionModes(value: unknown): Record<string, ProjectInteractionMode> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, ProjectInteractionMode] => (
    entry[1] === "session" || entry[1] === "task" || entry[1] === "qa"
  )));
}

function cleanProjectName(value: string): string {
  const clean = value.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!clean) {
    throw new Error("Project name cannot be empty");
  }
  return clean;
}

function cleanTitle(value?: string): string | undefined {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 80);
  return clean || undefined;
}

function shouldReplaceGeneratedSessionTitle(value?: string): boolean {
  const title = value?.trim() ?? "";
  return !title
    || /^(?:会话\s*\d+|新会话|Codex 会话(?:\s+[\da-f-]+)?)$/i.test(title)
    || /^(?:WeChat|Codex channel) bridge rule:/i.test(title)
    || /^The following is the Codex agent history/i.test(title);
}

function cleanPromptPreview(value?: string): string | undefined {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 120);
  return clean || undefined;
}
