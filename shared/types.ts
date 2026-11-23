import type { EngineCompatibility, EngineUpdateInfo } from "./engine-manager";

export type Mode = "cautious" | "autonomous" | "full";
export type Workspace = "work" | "chat";
export type MemoryEntry = {
  id: string;
  scope: "global" | "project";
  projectId?: string;
  text: string;
  created: number;
  updated: number;
  source: "user";
};
export type SearchResult = {
  sessionId: string;
  projectId: string;
  title: string;
  messageId?: string;
  snippet: string;
};
export type ModelRef = { id: string; providerID: string; variant?: string };
export type EditMessageResult = { sent: true } | { sent: false; error: string };
export type Project = {
  id: string;
  name: string;
  path: string;
  collapsed: boolean;
  section?: string;
  managed?: boolean;
};
export type Session = {
  id: string;
  projectId: string;
  title: string;
  parentId?: string;
  updated: number;
  created: number;
  busy?: number;
  idle?: number;
  outcome?: string;
  model?: ModelRef;
  mode: Mode;
  pinned: boolean;
  running: boolean;
  workspace?: Workspace;
  unread?: boolean;
  section?: string;
  planning?: boolean;
  directory?: string;
  agent?: string;
  reviewSourceId?: string;
  completed?: boolean;
  directoryMissing?: boolean;
};
export type PromptOptions = { planning?: boolean; skills?: string[] };
export type Capabilities = {
  skills: { id: string; name: string; description: string }[];
  mcp: { name: string; title: string; status: string }[];
  plugins: { id: string; status: string }[];
  errors: string[];
};
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  preview?: string;
  size?: number;
  pages?: number;
  status?: string;
  detail?: string;
  selectedPages?: number[];
  visualPages?: number[];
  excerpt?: string;
};
export type ImageRef = { url: string; name: string };
export type ToolItem = {
  id: string;
  name: string;
  category: "shell" | "read" | "edit" | "web" | "image" | "other";
  title: string;
  status: string;
  input: string;
  output: string;
  command?: string;
  outputTruncated?: boolean;
  changes?: ActionFileDiff[];
  path?: { full: string; display: string };
  cwd?: string;
  exit?: string;
  started?: number;
  ended?: number;
  images: ImageRef[];
  childSessionId?: string;
};
export type TimelineRow =
  | {
      id: string;
      type: "user";
      text: string;
      at: number;
      images?: ImageRef[];
      attachments?: { name: string; mime: string }[];
    }
  | { id: string; type: "text"; text: string; at: number }
  | { id: string; type: "actions"; tools: ToolItem[]; at: number }
  | {
      id: string;
      type: "run";
      text: string;
      at: number;
      started?: number;
      duration?: number;
      status: "running" | "succeeded" | "interrupted" | "failed" | "info";
      details: RunDetail[];
    }
  | {
      id: string;
      type: "system";
      text: string;
      at: number;
      status?: string;
      duration?: number;
    };
export type RunDetail = {
  id: string;
  text: string;
  kind: "model" | "event";
  status?: "error" | "interrupted";
};
export type Permission = {
  id: string;
  sessionId: string;
  action: string;
  resources: string[];
  toolId?: string;
};
export type FormField = {
  key: string;
  type: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  default?: unknown;
  options?: { value: string; label: string }[];
  when?: { key: string; op: "eq" | "neq"; value: unknown }[];
  url?: string;
};
export type AgentForm = {
  id: string;
  sessionId: string;
  title: string;
  fields: FormField[];
};
export type Model = {
  id: string;
  providerID: string;
  name: string;
  tools: boolean;
  image: boolean;
  context: number;
  variants: string[];
  enabled: boolean;
};
export type Integration = {
  id: string;
  name: string;
  connected: boolean;
  custom?: boolean;
  needsAuth?: boolean;
  methods: { type: string; id?: string; label?: string; form?: FormField[] }[];
};
export type ProviderModel = { id: string; name: string };
export type SavedProviderSettings = {
  name: string;
  baseUrl: string;
  runtime: "compatible" | "openai" | "anthropic" | "openrouter";
};
export type FileDiff = {
  file: string;
  displayFile?: string;
  fullFile?: string;
  patch: string;
  additions: number;
  deletions: number;
  status: string;
  more?: boolean;
};
export type ActionFileDiff = Omit<FileDiff, "additions" | "deletions"> & {
  additions?: number;
  deletions?: number;
  previousFile?: string;
};
export type GitFile = {
  path: string;
  status: string;
  additions?: number;
  deletions?: number;
};
export type GitStatus = {
  repository: boolean;
  error?: string;
  branch: string;
  files: GitFile[];
  gh: boolean;
  ghAccount?: string;
};
export type EngineStatus = {
  state: "starting" | "ready" | "reconnecting" | "error" | "stopped";
  version?: string;
  error?: string;
  compatibility?: EngineCompatibility;
  generation?: number;
};
export type Preferences = {
  engineAutoCheck?: boolean;
  engineNotify?: boolean;
  theme?: "dark" | "light";
  language?: "ru" | "en";
  workspace?: Workspace;
  workspaceSessions?: Partial<Record<Workspace, string>>;
  chatFontSize?: number;
  codeFontSize?: number;
  density?: "comfortable" | "compact";
  animations?: boolean;
  uiScale?: number;
  memoryEnabled?: boolean;
  projectId?: string;
  sessionId?: string;
  model?: ModelRef;
  mode: Mode;
  sidebarWidth: number;
  favoriteModels?: ModelRef[];
  showProjects?: boolean;
  chatSort?: "updated" | "created" | "title";
  pinnedProjects?: string[];
};
export type ConversationMarker = { id: string; text: string; at: number };
export type Snapshot = {
  session: Session;
  rows: TimelineRow[];
  permissions: Permission[];
  forms: AgentForm[];
  olderCursor?: string | null;
  queued: { id: string; text: string }[];
  diffs: FileDiff[];
  metrics?: import("./rcf").SessionMetrics;
};
export type AppState = {
  projects: Project[];
  sessions: Session[];
  preferences: Preferences;
  engine: EngineStatus;
};
export type AppEvent =
  | { type: "engine"; status: EngineStatus }
  | { type: "engine-update"; update: EngineUpdateInfo }
  | { type: "theme"; theme: "dark" | "light" }
  | { type: "changed"; sessionId?: string }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "error"; message: string };
export type OAuthAttempt = {
  attemptID: string;
  url: string;
  instructions: string;
  mode: string;
};
export interface DesktopApi {
  worktrees(projectId: string): Promise<import("./rcf").Worktree[]>;
  createWorktree(
    projectId: string,
    branch: string,
  ): Promise<import("./rcf").Worktree>;
  removeWorktree(projectId: string, directory: string): Promise<boolean>;
  createWorktreeSession(
    projectId: string,
    directory: string,
    model?: ModelRef,
  ): Promise<Session>;
  finishTask(sessionId: string): Promise<void>;
  agents(sessionId: string): Promise<import("./rcf").AgentDefinition[]>;
  agentRuns(sessionId: string): Promise<import("./rcf").AgentRun[]>;
  launchAgent(
    sessionId: string,
    agentId: string,
    task: string,
    model?: ModelRef,
    directory?: string,
  ): Promise<Session>;
  startReview(sessionId: string, model: ModelRef): Promise<Session>;
  reviewReport(sessionId: string): Promise<import("./rcf").ReviewReport>;
  fixReview(sessionId: string): Promise<void>;
  checkpoints(sessionId: string): Promise<import("./rcf").Checkpoint[]>;
  restoreCheckpoint(sessionId: string, messageId: string): Promise<boolean>;
  taskGitStatus(sessionId: string): Promise<GitStatus>;
  taskGitDiff(sessionId: string, file: string): Promise<string>;
  openTaskFile(sessionId: string, file: string): Promise<void>;
  bootstrap(): Promise<AppState>;
  addProject(): Promise<Project | null>;
  removeProject(projectId: string): Promise<void>;
  sectionProject(projectId: string, section: string): Promise<Project>;
  archiveProjectChats(projectId: string): Promise<void>;
  collapseProject(projectId: string, collapsed: boolean): Promise<void>;
  renameProject(projectId: string, name: string): Promise<Project>;
  copyText(text: string): Promise<void>;
  sessions(
    projectId: string,
    cursor?: string,
    archived?: boolean,
  ): Promise<{ sessions: Session[]; next?: string | null }>;
  createSession(
    projectId: string | undefined,
    model: ModelRef | undefined,
    mode: Mode,
    workspace?: Workspace,
  ): Promise<Session>;
  changeSessionProject(sessionId: string, projectId?: string): Promise<Session>;
  capabilities(projectId?: string): Promise<Capabilities>;
  connectMcp(
    name: string,
    connected: boolean,
    projectId?: string,
  ): Promise<void>;
  addMcp(
    config: {
      name: string;
      type: "local" | "remote";
      url?: string;
      command?: string[];
    },
    projectId?: string,
  ): Promise<void>;
  localEnvironment(): Promise<{ directory: string }>;
  revealTasks(): Promise<void>;
  attachFolder(): Promise<Attachment[]>;
  openSession(sessionId: string): Promise<Snapshot>;
  refreshSession(sessionId: string): Promise<Snapshot>;
  olderMessages(sessionId: string, cursor: string): Promise<Snapshot>;
  conversationIndex(
    sessionId: string,
    cursor?: string,
  ): Promise<{ items: ConversationMarker[]; next?: string | null }>;
  renameSession(sessionId: string, title: string): Promise<void>;
  pinSession(sessionId: string, pinned: boolean): Promise<void>;
  archiveSession(sessionId: string, archived: boolean): Promise<void>;
  markSessionUnread(sessionId: string, unread: boolean): Promise<void>;
  moveSession(sessionId: string, projectId: string): Promise<void>;
  sectionSession(sessionId: string, section: string): Promise<void>;
  forkSession(sessionId: string, projectId: string): Promise<Session>;
  copySession(sessionId: string, kind: "title" | "id" | "text"): Promise<void>;
  shareSession(sessionId: string): Promise<boolean>;
  deleteSession(sessionId: string): Promise<boolean>;
  openSessionWindow(sessionId: string): Promise<void>;
  send(
    sessionId: string,
    text: string,
    model: ModelRef,
    mode: Mode,
    attachments: string[],
    options?: PromptOptions,
  ): Promise<void>;
  stop(sessionId: string): Promise<void>;
  editLastMessage(
    sessionId: string,
    messageId: string,
    text: string,
    model: ModelRef,
    mode: Mode,
  ): Promise<EditMessageResult>;
  setMode(sessionId: string, mode: Mode): Promise<void>;
  permission(
    sessionId: string,
    requestId: string,
    decision: "once" | "reject",
  ): Promise<void>;
  replyForm(
    sessionId: string,
    formId: string,
    answer: Record<string, string | number | boolean | string[]> | null,
  ): Promise<void>;
  cancelQueued(sessionId: string, messageId: string): Promise<void>;
  models(projectId?: string): Promise<Model[]>;
  integrations(projectId?: string): Promise<Integration[]>;
  connectKey(
    integrationId: string,
    key: string,
    answer: Record<string, string | number | boolean | string[]>,
    projectId?: string,
  ): Promise<void>;
  oauthStart(
    integrationId: string,
    methodId: string,
    answer: Record<string, string | number | boolean | string[]>,
    projectId?: string,
  ): Promise<OAuthAttempt>;
  oauthComplete(
    integrationId: string,
    attemptId: string,
    code?: string,
    projectId?: string,
  ): Promise<void>;
  oauthStatus(
    integrationId: string,
    attemptId: string,
    projectId?: string,
  ): Promise<{ status: string; message?: string }>;
  oauthCancel(
    integrationId: string,
    attemptId: string,
    projectId?: string,
  ): Promise<void>;
  connectExternal(
    integrationId: string,
    methodId: string,
    answer: Record<string, string | number | boolean | string[]>,
    projectId?: string,
  ): Promise<void>;
  customProvider(input: {
    id: string;
    name: string;
    baseUrl: string;
    model: string;
    key?: string;
    images: boolean;
    tools: boolean;
    runtime: "compatible" | "openai" | "anthropic" | "openrouter";
  }): Promise<void>;
  customProviderSettings(
    providerId: string,
  ): Promise<SavedProviderSettings | undefined>;
  providerModels(input: {
    baseUrl: string;
    key?: string;
    providerId?: string;
  }): Promise<ProviderModel[]>;
  attachments(): Promise<Attachment[]>;
  importAttachments(
    files: { name: string; mime: string; bytes: number[] | Uint8Array }[],
  ): Promise<Attachment[]>;
  preparePdfAttachment(id: string, pages: number[]): Promise<Attachment>;
  search(input: {
    query: string;
    projectId?: string;
    workspace: Workspace;
  }): Promise<SearchResult[]>;
  listMemory(projectId?: string): Promise<MemoryEntry[]>;
  saveMemory(input: {
    id?: string;
    scope: "global" | "project";
    projectId?: string;
    text: string;
  }): Promise<MemoryEntry>;
  deleteMemory(id: string): Promise<void>;
  sessionDiff(sessionId: string): Promise<FileDiff[]>;
  gitStatus(projectId: string): Promise<GitStatus>;
  gitDiff(projectId: string, path: string): Promise<string>;
  gitStage(
    projectId: string,
    files: string[],
    sessionId?: string,
  ): Promise<void>;
  gitAction(
    projectId: string,
    action: "branch" | "commit" | "push" | "pull" | "pr",
    value: string,
    body?: string,
    sessionId?: string,
  ): Promise<string>;
  saveDraft(key: string, text: string): Promise<void>;
  loadDraft(key: string): Promise<string>;
  savePreferences(preferences: Partial<Preferences>): Promise<void>;
  retryEngine(): Promise<void>;
  engineUpdateInfo(): Promise<EngineUpdateInfo>;
  checkEngineUpdate(): Promise<EngineUpdateInfo>;
  installEngineUpdate(): Promise<EngineUpdateInfo>;
  switchEngineVersion(): Promise<EngineUpdateInfo>;
  rollbackEngineVersion(): Promise<EngineUpdateInfo>;
  openExternal(url: string): Promise<void>;
  revealProject(projectId: string): Promise<void>;
  windowAction(action: "minimize" | "maximize" | "close"): void;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

