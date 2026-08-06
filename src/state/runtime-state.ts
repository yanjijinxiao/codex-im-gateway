import crypto from "node:crypto";
import path from "node:path";

import type { ProjectInteractionMode } from "../channels/channel-mode-settings.js";

import { readJsonFile, writeJsonFile } from "./json-store.js";
import {
  cleanKnowledgeInput,
  knowledgeIdentity,
  selectRelevantKnowledge,
  type KnowledgeEntry,
  type KnowledgeInput
} from "./knowledge.js";
import type { StatePaths } from "./paths.js";

export type ManagedSession = {
  id: string;
  senderId: string;
  title: string;
  workspace: string;
  projectId?: string;
  mode?: "session" | "qa";
  knowledgeBaseId?: string;
  threadId?: string;
  lastPromptPreview?: string;
  model?: string;
  effort?: string;
  streamReplies?: boolean;
  collaborationMode?: "default" | "plan";
  createdAt: string;
  updatedAt: string;
};

export type ManagedProject = {
  id: string;
  name: string;
  workspace: string;
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

export type RuntimeState = {
  pairedSenderIds: string[];
  lastActiveSenderId?: string;
  lastActiveActorId?: string;
  lastAuthorizedSenderId?: string;
  lastAuthorizedActorId?: string;
  syncKey?: string;
  processedMessageIds: string[];
  contextTokens: Record<string, string>;
  sessions: ManagedSession[];
  projects: ManagedProject[];
  knowledgeBases: ManagedKnowledgeBase[];
  activeSessionIds: Record<string, string>;
  activeQaSessionIds: Record<string, string>;
  activeProjectIds: Record<string, string>;
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
    pairedSenderIds: [],
    processedMessageIds: [],
    contextTokens: {},
    sessions: [],
    projects: [],
    knowledgeBases: [],
    activeSessionIds: {},
    activeQaSessionIds: {},
    activeProjectIds: {},
    interactionModes: {},
    pendingDeliveries: [],
    knowledge: [],
    knowledgeEnabled: true
  };
}

export class RuntimeStateStore {
  private state: RuntimeState;

  constructor(private readonly paths: StatePaths) {
    this.state = normalizeRuntimeState(readJsonFile<Partial<RuntimeState>>(paths.statePath, {}));
    this.save();
  }

  get snapshot(): RuntimeState {
    return structuredClone(this.state);
  }

  save(): void {
    writeJsonFile(this.paths.statePath, this.state);
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
    }
    this.save();
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

  createProject(name: string, workspace: string): ManagedProject {
    const resolvedWorkspace = path.resolve(workspace);
    const existing = this.state.projects.find((project) => project.workspace === resolvedWorkspace);
    if (existing) {
      throw new Error(`Project workspace already exists: ${resolvedWorkspace}`);
    }
    const now = new Date().toISOString();
    const project: ManagedProject = {
      id: crypto.randomUUID(),
      name: cleanProjectName(name),
      workspace: resolvedWorkspace,
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
    this.state.activeProjectIds[senderId] = project.id;
    this.save();
    return structuredClone(project);
  }

  getActiveProject(senderId: string): ManagedProject | undefined {
    const projectId = this.state.activeProjectIds[senderId]
      ?? this.mutableActiveSession(senderId)?.projectId
      ?? this.mutableActiveQaSession(senderId)?.projectId;
    const project = this.state.projects.find((candidate) => candidate.id === projectId);
    return project ? structuredClone(project) : undefined;
  }

  getInteractionMode(senderId: string): ProjectInteractionMode {
    return this.state.interactionModes[senderId] ?? "session";
  }

  setInteractionMode(senderId: string, mode: ProjectInteractionMode): void {
    this.state.interactionModes[senderId] = mode;
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
    knowledgeBaseId?: string
  ): ManagedSession {
    const now = new Date().toISOString();
    const resolvedWorkspace = path.resolve(workspace);
    const project = projectId
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
      ...(mode === "qa" ? { mode, ...(knowledgeBaseId ? { knowledgeBaseId } : {}) } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.state.sessions.push(session);
    this.state.activeProjectIds[senderId] = project.id;
    if (mode === "qa") this.state.activeQaSessionIds[senderId] = session.id;
    else this.state.activeSessionIds[senderId] = session.id;
    this.save();
    return structuredClone(session);
  }

  setSessionPromptPreview(sessionId: string, preview: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    const normalized = cleanPromptPreview(preview);
    if (normalized) session.lastPromptPreview = normalized;
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
    if (session.mode === "qa") this.state.activeQaSessionIds[session.senderId] = session.id;
    else this.state.activeSessionIds[session.senderId] = session.id;
    if (session.projectId) this.state.activeProjectIds[session.senderId] = session.projectId;
    session.updatedAt = new Date().toISOString();
    this.save();
    return structuredClone(session);
  }

  resetSession(sessionId: string): ManagedSession {
    const session = this.mutableSession(sessionId);
    delete session.threadId;
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
    this.state.sessions = this.state.sessions.filter((candidate) => candidate.id !== sessionId);
    if (this.state.activeSessionIds[session.senderId] === sessionId) {
      const fallback = this.state.sessions
        .filter((candidate) => candidate.senderId === session.senderId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (fallback) {
        this.state.activeSessionIds[session.senderId] = fallback.id;
      } else {
        delete this.state.activeSessionIds[session.senderId];
      }
    }
    if (this.state.activeQaSessionIds[session.senderId] === sessionId) {
      const fallback = this.state.sessions
        .filter((candidate) => candidate.senderId === session.senderId && candidate.mode === "qa")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (fallback) this.state.activeQaSessionIds[session.senderId] = fallback.id;
      else delete this.state.activeQaSessionIds[session.senderId];
    }
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
    project.notifications = Array.isArray(project.notifications)
      ? project.notifications.filter((target) => Boolean(
        target
        && typeof target.accountId === "string"
        && typeof target.recipientId === "string"
        && typeof target.enabled === "boolean"
      ))
      : [];
  }
  const projectsByWorkspace = new Map(projects.map((project) => [path.resolve(project.workspace), project]));
  for (const session of sessions) {
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
  }
  return {
    ...emptyRuntimeState(),
    ...value,
    pairedSenderIds: Array.isArray(value.pairedSenderIds) ? value.pairedSenderIds : [],
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

function cleanPromptPreview(value?: string): string | undefined {
  const clean = value?.trim().replace(/\s+/g, " ").slice(0, 120);
  return clean || undefined;
}
