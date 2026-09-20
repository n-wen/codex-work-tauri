/** Shared domain types for the React renderer. */

export interface ModelEntry {
  id: string;
  label: string;
  /** API model id passed to thread/turn */
  model: string;
}

export interface ProviderEntry {
  id: string;
  label: string;
  baseUrl: string;
  apiKey: string;
  models: ModelEntry[];
}

export interface AppSettings {
  providers: ProviderEntry[];
  activeProviderId: string;
  /** Optional Codex binary override. Empty = download/use the version pinned by this app. */
  codexBin?: string;
  /** Preferred editor command (`code` / `code.cmd` / absolute path). */
  editorCommand?: string;
}

export function activeProvider(settings: AppSettings | null | undefined): ProviderEntry | null {
  if (!settings?.providers?.length) return null;
  return (
    settings.providers.find((p) => p.id === settings.activeProviderId) ??
    settings.providers[0] ??
    null
  );
}

export function activeModels(settings: AppSettings | null | undefined): ModelEntry[] {
  return activeProvider(settings)?.models ?? [];
}

export function defaultModelId(settings: AppSettings | null | undefined): string {
  return activeModels(settings)[0]?.model ?? '';
}

export function modelLabelFor(
  settings: AppSettings | null | undefined,
  modelId: string | null | undefined,
): string {
  const id = (modelId ?? '').trim() || defaultModelId(settings);
  const hit = activeModels(settings).find((m) => m.model === id);
  return hit?.label || id || '模型';
}

export function legacyToAppSettings(partial?: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  codexBin?: string;
  providers?: ProviderEntry[];
  activeProviderId?: string;
}): AppSettings {
  if (partial?.providers?.length) {
    return {
      providers: partial.providers,
      activeProviderId:
        partial.activeProviderId &&
        partial.providers.some((p) => p.id === partial.activeProviderId)
          ? partial.activeProviderId
          : partial.providers[0].id,
      codexBin: partial.codexBin,
    };
  }
  const model = partial?.model?.trim() || 'gpt-4o-mini';
  const provider: ProviderEntry = {
    id: 'default',
    label: '默认',
    baseUrl: partial?.baseUrl?.trim() || 'https://api.openai.com/v1',
    apiKey: partial?.apiKey ?? '',
    models: [{ id: 'default', label: model, model }],
  };
  return {
    providers: [provider],
    activeProviderId: 'default',
    codexBin: partial?.codexBin,
    editorCommand: (partial as { editorCommand?: string } | undefined)?.editorCommand,
  };
}

export interface ReasoningEffortOption {
  effort: string;
  description: string;
}

export interface ProviderCapabilities {
  namespaceTools: boolean;
  imageGeneration: boolean;
  webSearch: boolean;
  inputImages: boolean;
  reasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort?: string | null;
}

export interface AppConfigSnapshot {
  model?: string | null;
  modelReasoningEffort?: string | null;
  config: unknown;
}

export interface ExperimentalFeature {
  name: string;
  stage?: string | null;
  displayName?: string | null;
  description?: string | null;
  enabled: boolean;
  defaultEnabled?: boolean | null;
}

export interface McpServerTool {
  name: string;
  description?: string | null;
}

export interface McpServerRow {
  name: string;
  enabled: boolean;
  transport: string;
  command?: string | null;
  args: string[];
  cwd?: string | null;
  url?: string | null;
  envText: string;
  authStatus?: string | null;
  startupStatus?: string | null;
  error?: string | null;
  tools: McpServerTool[];
}

export interface UpsertMcpServerInput {
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | string;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  url?: string | null;
  envText?: string | null;
}

export interface McpElicitationRequest {
  requestId: string;
  serverName: string;
  message: string;
  mode: string;
  url?: string | null;
  schema?: unknown;
}

export interface CodexRuntimeInfo {
  version: string;
  releaseTag: string;
  path?: string | null;
  managed: boolean;
}

/** App Server config.toml: sandbox_mode + approval_policy */
export interface AgentPermissions {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access' | string;
  approvalPolicy: 'untrusted' | 'on-request' | 'never' | string;
}

export type PermissionsPresetId = 'ask' | 'auto' | 'full';

export interface PermissionsPreset {
  id: PermissionsPresetId;
  label: string;
  description: string;
  permissions: AgentPermissions;
}

export const PERMISSIONS_PRESETS: PermissionsPreset[] = [
  {
    id: 'ask',
    label: '请求批准',
    description: '只读沙箱；越界操作需批准',
    permissions: { sandbox: 'read-only', approvalPolicy: 'on-request' },
  },
  {
    id: 'auto',
    label: '自动',
    description: '工作区内可读写与执行；越界需批准',
    permissions: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  },
  {
    id: 'full',
    label: '完全访问',
    description: '无沙箱限制，不请求批准',
    permissions: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
  },
];

export function matchPermissionsPreset(
  permissions: AgentPermissions | null | undefined,
): PermissionsPresetId | 'custom' {
  if (!permissions) return 'auto';
  const hit = PERMISSIONS_PRESETS.find(
    (p) =>
      p.permissions.sandbox === permissions.sandbox &&
      p.permissions.approvalPolicy === permissions.approvalPolicy,
  );
  return hit?.id ?? 'custom';
}

export function permissionsLabel(permissions: AgentPermissions | null | undefined): string {
  const id = matchPermissionsPreset(permissions);
  if (id === 'custom') return '自定义';
  return PERMISSIONS_PRESETS.find((p) => p.id === id)?.label ?? '自动';
}

export interface Project {
  id: string;
  name: string;
  workDir: string;
  /** false = hidden cwd workspace (ungrouped chats); omit/true = show under 项目 */
  listed?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallRecord {
  id: string;
  name: 'list_dir' | 'read_file' | 'write_file' | 'run_command';
  arguments: Record<string, unknown>;
  status: 'pending_approval' | 'running' | 'completed' | 'rejected' | 'error';
  result?: string;
  diffSummary?: string;
  error?: string;
}

export interface PlanStep {
  step: string;
  status: 'pending' | 'inProgress' | 'completed' | string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCallRecord[];
  createdAt: string;
  /** App Server turn id — used by thread/fork lastTurnId */
  turnId?: string;
  /** Local image paths attached to this user message */
  images?: string[];
  /** Collapsible reasoning / plan cards (not plain assistant text). */
  kind?: 'text' | 'reasoning' | 'plan';
  reasoningSummary?: string;
  planSteps?: PlanStep[];
  planExplanation?: string;
  /** Pending queue bubble — not yet sent as a turn */
  queued?: boolean;
  sendingSoon?: boolean;
  /**
   * Hand-chat delivery: optimistic send → App Server userMessage.
   * Omitted for history loaded from thread/read.
   */
  delivery?: 'pending' | 'received';
}

export interface ChatPending {
  id: string;
  lane: 'chat' | string;
  sessionId: string;
  projectId: string;
  text: string;
  createdAt: string;
  sendingSoon?: boolean;
  images?: string[];
  model?: string;
}

export interface CronPending {
  id: string;
  lane: 'cron' | string;
  jobId: string;
  createdAt: string;
}

export interface QueueSnapshot {
  chat: ChatPending[];
  cron: CronPending[];
}

export type CronOrigin = 'newInProject' | 'bindExisting';
export type CronRepeat = 'alwaysNew' | 'reuseFirst';

export interface CronJob {
  id: string;
  name: string;
  prompt: string;
  cronExpr: string;
  onceAt?: string | null;
  enabled: boolean;
  projectId?: string | null;
  threadId?: string | null;
  origin: CronOrigin;
  repeat?: CronRepeat | null;
  model?: string | null;
  sandbox?: string | null;
  approvalPolicy: string;
  timezone: string;
  timeoutMins: number;
  lastThreadId?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  nextRunAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCronJobInput {
  id?: string;
  name: string;
  prompt: string;
  cronExpr?: string;
  schedulePreset?: string;
  time?: string;
  intervalHours?: number;
  days?: string[];
  /** ISO-8601 one-shot; mutually exclusive with cronExpr / schedulePreset */
  onceAt?: string | null;
  enabled: boolean;
  projectId?: string | null;
  threadId?: string | null;
  origin: CronOrigin;
  repeat?: CronRepeat | null;
  model?: string | null;
  sandbox?: string | null;
  approvalPolicy?: string;
  timeoutMins?: number;
}

/** App Server ThreadStatus (`thread/list` / `thread/status/changed`). */
export type ThreadActiveFlag = 'waitingOnApproval' | 'waitingOnUserInput';

export type ThreadStatus =
  | { type: 'notLoaded' }
  | { type: 'idle' }
  | { type: 'systemError' }
  | { type: 'active'; activeFlags: ThreadActiveFlag[] };

export interface Session {
  id: string;
  projectId: string;
  title: string;
  /** Codex App Server thread id */
  threadId?: string;
  /** Thread cwd；无侧栏项目时仍是默认工作区 */
  cwd?: string;
  /** API model id for this thread */
  model?: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
  /** Live thread status from App Server */
  status?: ThreadStatus;
}

export type CodexEventMethod =
  | 'session/start'
  | 'thread/started'
  | 'thread/status/changed'
  | 'turn/start'
  | 'item/userMessage'
  | 'item/agentMessage/delta'
  | 'item/agentMessage/completed'
  | 'item/toolCall'
  | 'item/toolCall/approval'
  | 'item/toolCall/updated'
  | 'turn/completed'
  | 'turn/interrupted'
  | 'turn/error'
  | 'skills/changed'
  | 'fs/changed'
  | 'fuzzyFileSearch/sessionUpdated'
  | 'fuzzyFileSearch/sessionCompleted'
  | 'mcpServer/startupStatus/updated'
  | 'mcpServer/oauthLogin/completed'
  | 'queue/updated'
  | (string & {});

export interface CodexEvent {
  jsonrpc: '2.0';
  method: CodexEventMethod;
  params: Record<string, unknown>;
}

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel';

export interface ApprovalNetworkAmendment {
  action: string;
  host: string;
}

export interface ApprovalRequest {
  requestId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  reason: string;
  /** Optional unified diff / change summary for write_file approvals */
  diffSummary?: string;
  /** `command` | `fileChange` | `permissions` */
  kind?: string;
  commandActions?: unknown[];
  proposedExecpolicyAmendment?: string[];
  proposedNetworkPolicyAmendments?: ApprovalNetworkAmendment[];
  permissions?: unknown;
}

export interface DynamicToolConfirmRequest {
  requestId: string;
  callId: string;
  namespace?: string | null;
  tool: string;
  summary: string;
  arguments: unknown;
}

export interface ToolUserInputOption {
  label: string;
  description: string;
}

export interface ToolUserInputQuestion {
  id: string;
  header: string;
  question: string;
  options?: ToolUserInputOption[] | null;
  isOther?: boolean;
  isSecret?: boolean;
}

export interface ToolUserInputRequest {
  requestId: string;
  threadId?: string | null;
  turnId?: string | null;
  itemId?: string | null;
  questions: ToolUserInputQuestion[];
  autoResolutionMs?: number | null;
}

export interface TokenUsageBreakdown {
  cachedInputTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

/** Matches Codex TUI: fixed overhead (system/tools) excluded from “user-controllable” fill. */
export const CONTEXT_BASELINE_TOKENS = 12_000;

/** Tokens currently occupying the context window (latest turn), not session spend. */
export function tokensInContextWindow(usage: ThreadTokenUsage | null | undefined): number {
  return usage?.last?.totalTokens ?? 0;
}

/**
 * Fraction of the effective context window used (0–1).
 * Uses `last` (current context), not cumulative `total`.
 */
export function contextWindowUsedRatio(usage: ThreadTokenUsage | null | undefined): number | null {
  const windowSize = usage?.modelContextWindow ?? null;
  if (windowSize == null || windowSize <= 0) return null;
  if (windowSize <= CONTEXT_BASELINE_TOKENS) return 1;
  const effectiveWindow = windowSize - CONTEXT_BASELINE_TOKENS;
  const used = Math.max(0, tokensInContextWindow(usage) - CONTEXT_BASELINE_TOKENS);
  return Math.min(1, used / effectiveWindow);
}

export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, '')}K`;
  }
  const m = n / 1_000_000;
  return `${m.toFixed(m >= 10 ? 0 : 1).replace(/\.0$/, '')}M`;
}

function asTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function parseTokenUsageBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  return {
    cachedInputTokens: asTokenCount(o.cachedInputTokens),
    inputTokens: asTokenCount(o.inputTokens),
    outputTokens: asTokenCount(o.outputTokens),
    reasoningOutputTokens: asTokenCount(o.reasoningOutputTokens),
    totalTokens: asTokenCount(o.totalTokens),
  };
}

export function parseThreadTokenUsage(params: Record<string, unknown>): ThreadTokenUsage | null {
  const raw = params.tokenUsage;
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const last = parseTokenUsageBreakdown(obj.last);
  const total = parseTokenUsageBreakdown(obj.total);
  if (!last || !total) return null;
  const windowRaw = obj.modelContextWindow;
  const modelContextWindow =
    typeof windowRaw === 'number' && Number.isFinite(windowRaw) && windowRaw > 0
      ? Math.trunc(windowRaw)
      : null;
  return { last, total, modelContextWindow };
}

const TOKEN_USAGE_CACHE_KEY = 'cw:thread-token-usage';
const TOKEN_USAGE_CACHE_LIMIT = 80;

export function loadCachedThreadTokenUsage(): Record<string, ThreadTokenUsage> {
  try {
    const raw = localStorage.getItem(TOKEN_USAGE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, ThreadTokenUsage> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!id.trim()) continue;
      const usage = parseThreadTokenUsage({
        tokenUsage:
          value && typeof value === 'object' && 'total' in (value as object)
            ? value
            : (value as { usage?: unknown })?.usage,
      });
      if (usage) out[id] = usage;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCachedThreadTokenUsage(map: Record<string, ThreadTokenUsage>) {
  try {
    const ids = Object.keys(map);
    const trimmed =
      ids.length <= TOKEN_USAGE_CACHE_LIMIT
        ? map
        : Object.fromEntries(
            ids.slice(-TOKEN_USAGE_CACHE_LIMIT).map((id) => [id, map[id]]),
          );
    localStorage.setItem(TOKEN_USAGE_CACHE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota / private mode */
  }
}

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: string;
  tokenBudget?: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface PluginScheduledTask {
  key: string;
  name: string;
  prompt: string;
  schedule: {
    type: string;
    time?: string;
    intervalHours?: number;
    days?: string[];
  };
}

export interface PluginSkillSummary {
  name?: string;
  displayName?: string;
  description?: string;
  path?: string;
}

export interface PluginHookSummary {
  key: string;
  eventName: string;
}

/** Cached `plugin/read` payload for detail view. */
export interface PluginDetail {
  description?: string | null;
  marketplaceName?: string;
  marketplacePath?: string | null;
  shareUrl?: string | null;
  skills?: PluginSkillSummary[];
  hooks?: PluginHookSummary[];
  mcpServers?: string[];
  scheduledTasks?: PluginScheduledTask[] | null;
  apps?: Array<{ name?: string; displayName?: string }>;
  appTemplates?: Array<{ name?: string; displayName?: string }>;
  summary?: {
    id?: string;
    name?: string;
    interface?: {
      displayName?: string | null;
      shortDescription?: string | null;
      longDescription?: string | null;
      logo?: string | null;
      logoDark?: string | null;
      logoUrl?: string | null;
      logoUrlDark?: string | null;
      brandColor?: string | null;
      websiteUrl?: string | null;
      category?: string | null;
      developerName?: string | null;
      capabilities?: string[];
      screenshotUrls?: string[];
      screenshots?: string[];
      defaultPrompt?: string[] | null;
    } | null;
  };
}

export interface DynamicToolListItem {
  namespace: string;
  namespaceLabel: string;
  namespaceDescription: string;
  namespaceEnabled: boolean;
  name: string;
  label: string;
  description: string;
  sideEffect: string;
  confirm: boolean;
  enabled: boolean;
}

export interface DynamicToolsListResult {
  enabled: boolean;
  tools: DynamicToolListItem[];
  hasSessionOverride?: boolean;
}

export interface DynamicToolsConfigPatch {
  enabled: boolean;
  namespaces: Record<
    string,
    {
      enabled: boolean;
      tools?: Record<string, boolean>;
    }
  >;
}

export interface SkillToolDependency {
  type: string;
  value: string;
  command?: string;
  description?: string;
  transport?: string;
  url?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  enabled: boolean;
  path: string;
  scope: string;
  cwd?: string;
  displayName?: string;
  shortDescription?: string;
  brandColor?: string;
  iconSmall?: string;
  iconLarge?: string;
  defaultPrompt?: string;
  dependencies?: SkillToolDependency[];
}

export interface PluginInfo {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  version?: string;
  displayName?: string;
  description?: string;
  longDescription?: string;
  category?: string;
  developerName?: string;
  brandColor?: string;
  /** Local logo path (installed package). */
  logo?: string;
  logoDark?: string;
  /** Remote catalog logo URL. */
  logoUrl?: string;
  logoUrlDark?: string;
  websiteUrl?: string;
  capabilities?: string[];
  keywords?: string[];
  screenshotUrls?: string[];
  screenshots?: string[];
  defaultPrompts?: string[];
  marketplaceName: string;
  marketplacePath?: string;
  remoteMarketplaceName?: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FileMetadata {
  path: string;
  createdAtMs: number;
  modifiedAtMs: number;
  isDirectory: boolean;
  isFile: boolean;
  isSymlink: boolean;
}

export interface FileContent {
  path: string;
  dataBase64: string;
  text?: string;
  byteLength: number;
}

export interface FuzzySearchHit {
  fileName: string;
  matchType: string;
  path: string;
  root: string;
  score: number;
  indices?: number[];
}

export interface FuzzySearchResult {
  files: FuzzySearchHit[];
}

export interface WatchHandle {
  watchId: string;
  path: string;
}

export interface GitStatus {
  branch?: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface GitDiffFile {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  patch: string;
}

export interface PermissionProfile {
  id: string;
  allowed: boolean;
  description?: string | null;
}

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string; title?: string | null }
  | { type: 'custom'; instructions: string };

export interface CodexApi {
  getSettings: () => Promise<AppSettings | null>;
  saveSettings: (settings: AppSettings) => Promise<{ ok: true } | { ok: false; error: string }>;
  validateSettings: (settings: AppSettings) => Promise<{ ok: true } | { ok: false; error: string }>;
  maskApiKey: (apiKey: string) => string | Promise<string>;
  getCodexRuntime: () => Promise<CodexRuntimeInfo>;

  getAgentPermissions: () => Promise<AgentPermissions>;
  setAgentPermissions: (permissions: AgentPermissions) => Promise<AgentPermissions>;
  getProviderCapabilities: (model?: string | null) => Promise<ProviderCapabilities>;
  readAppConfig: () => Promise<AppConfigSnapshot>;
  writeAppConfigValue: (keyPath: string, value: unknown) => Promise<AppConfigSnapshot>;
  listExperimentalFeatures: () => Promise<ExperimentalFeature[]>;
  setExperimentalFeature: (name: string, enabled: boolean) => Promise<ExperimentalFeature[]>;
  readConfigRequirements: () => Promise<unknown>;
  listMcpServers: () => Promise<McpServerRow[]>;
  upsertMcpServer: (input: UpsertMcpServerInput) => Promise<McpServerRow[]>;
  deleteMcpServer: (name: string) => Promise<McpServerRow[]>;
  reloadMcpServers: () => Promise<McpServerRow[]>;
  mcpServerOauthLogin: (name: string) => Promise<string>;
  respondMcpElicitation: (
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: unknown,
  ) => Promise<{ ok: true }>;
  onMcpElicitation: (handler: (req: McpElicitationRequest) => void) => () => void;

  listProjects: () => Promise<Project[]>;
  createProject: (input: { name: string; workDir: string }) => Promise<Project>;
  /** Documents/Codex/YYYY-MM-DD/<slug> */
  createDefaultProject: () => Promise<Project>;
  renameProject: (id: string, name: string) => Promise<Project>;
  deleteProject: (id: string) => Promise<void>;
  selectDirectory: () => Promise<string | null>;

  listSessions: (projectId: string) => Promise<Session[]>;
  listAllSessions: () => Promise<Session[]>;
  searchSessions: (searchTerm: string) => Promise<Session[]>;
  createSession: (projectId: string | null, title?: string) => Promise<Session>;
  getSession: (projectId: string, sessionId: string) => Promise<Session | null>;
  renameSession: (projectId: string, sessionId: string, title: string) => Promise<Session>;
  forkSession: (sessionId: string, lastTurnId?: string | null) => Promise<Session>;
  archiveSession: (sessionId: string) => Promise<void>;
  unarchiveSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  listArchivedSessions: () => Promise<Session[]>;

  listSkills: (cwds?: string[], forceReload?: boolean) => Promise<SkillInfo[]>;
  setSkillEnabled: (
    enabled: boolean,
    name?: string,
    path?: string,
  ) => Promise<boolean>;
  listPlugins: (cwds?: string[]) => Promise<PluginInfo[]>;
  installPlugin: (
    pluginName: string,
    marketplacePath?: string,
    remoteMarketplaceName?: string,
  ) => Promise<void>;
  uninstallPlugin: (pluginId: string) => Promise<void>;
  pluginRead: (
    pluginName: string,
    marketplacePath?: string | null,
    remoteMarketplaceName?: string | null,
  ) => Promise<{ plugin?: PluginDetail }>;
  addPluginScheduledTask: (
    pluginName: string,
    marketplacePath: string | null | undefined,
    remoteMarketplaceName: string | null | undefined,
    taskKey: string,
    projectId?: string | null,
  ) => Promise<CronJob>;

  reviewStart: (
    threadId: string,
    target: ReviewTarget | { type: string; [key: string]: unknown },
    delivery?: string | null,
  ) => Promise<{ reviewThreadId?: string | null } | unknown>;
  mcpServerResourceRead: (
    server: string,
    uri: string,
    threadId?: string | null,
  ) => Promise<unknown>;
  mcpServerToolCall: (
    server: string,
    tool: string,
    threadId: string,
    args?: unknown,
  ) => Promise<unknown>;
  listPermissionProfiles: (cwd?: string | null) => Promise<PermissionProfile[]>;
  setDefaultPermissionProfile: (profileId: string) => Promise<void>;
  compactThread: (threadId: string) => Promise<unknown>;
  threadGoalGet: (threadId: string) => Promise<{ goal?: ThreadGoal | null }>;
  threadGoalSet: (
    threadId: string,
    objective?: string | null,
    status?: string | null,
    tokenBudget?: number | null,
  ) => Promise<unknown>;
  threadGoalClear: (threadId: string) => Promise<unknown>;

  commandExec: (
    command: string[],
    cwd?: string | null,
    processId?: string | null,
    tty?: boolean | null,
    cols?: number | null,
    rows?: number | null,
  ) => Promise<unknown>;
  commandExecWrite: (processId: string, dataBase64: string) => Promise<unknown>;
  commandExecResize: (processId: string, cols: number, rows: number) => Promise<unknown>;
  commandExecTerminate: (processId: string) => Promise<unknown>;

  getAutostartEnabled: () => Promise<boolean>;
  setAutostartEnabled: (enabled: boolean) => Promise<boolean>;

  fsReadDirectory: (path: string) => Promise<DirEntry[]>;
  fsReadFile: (path: string) => Promise<FileContent>;
  fsWriteFile: (path: string, dataBase64: string) => Promise<void>;
  fsWriteTextFile: (path: string, text: string) => Promise<void>;
  fsCreateDirectory: (path: string, recursive?: boolean | null) => Promise<void>;
  fsGetMetadata: (path: string) => Promise<FileMetadata>;
  fsRemove: (path: string, force?: boolean | null, recursive?: boolean | null) => Promise<void>;
  fsCopy: (
    sourcePath: string,
    destinationPath: string,
    recursive?: boolean | null,
  ) => Promise<void>;
  fsWatch: (path: string, watchId?: string | null) => Promise<WatchHandle>;
  fsUnwatch: (watchId: string) => Promise<void>;
  fuzzyFileSearch: (
    query: string,
    roots: string[],
    cancellationToken?: string | null,
  ) => Promise<FuzzySearchResult>;
  getGitStatus: (cwd: string) => Promise<GitStatus | null>;
  getGitDiff: (cwd: string) => Promise<GitDiffFile[]>;
  gitStage: (cwd: string, paths: string[]) => Promise<void>;
  gitCommit: (cwd: string, message: string) => Promise<string>;
  openInEditor: (path: string, editor?: string | null) => Promise<void>;

  startTurn: (input: {
    projectId: string;
    sessionId: string;
    message: string;
    pendingId?: string;
    images?: string[];
    model?: string;
    effort?: string;
    skills?: { name: string; path: string }[];
    mentions?: { name: string; path: string }[];
  }) => Promise<
    | { ok: true; queued?: boolean; pendingId?: string }
    | { ok: false; error: string }
  >;
  interruptTurn: (sessionId?: string) => Promise<{ ok: true }>;
  interruptAndClearQueues: () => Promise<{ ok: true }>;
  cancelPending: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  sendPendingNow: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  respondApproval: (
    requestId: string,
    decision: ApprovalDecision,
    applyNetworkAmendment?: ApprovalNetworkAmendment | null,
  ) => Promise<{ ok: true }>;
  respondDynamicTool: (requestId: string, allowed: boolean) => Promise<void>;
  onQueue: (handler: (snapshot: QueueSnapshot) => void) => () => void;

  listCronJobs: () => Promise<CronJob[]>;
  upsertCronJob: (input: UpsertCronJobInput) => Promise<CronJob>;
  deleteCronJob: (id: string) => Promise<void>;
  setCronJobEnabled: (id: string, enabled: boolean) => Promise<CronJob>;
  runCronJobNow: (
    id: string,
  ) => Promise<{ ok: true; queued?: boolean } | { ok: false; error: string }>;
  onScheduled: (
    handler: (payload: { jobId: string; threadId?: string; status: string; error?: string }) => void,
  ) => () => void;

  listDynamicTools: () => Promise<DynamicToolsListResult>;
  setDynamicToolsConfig: (patch: DynamicToolsConfigPatch) => Promise<DynamicToolsListResult>;
  listSessionDynamicTools: (threadId: string) => Promise<DynamicToolsListResult>;
  setSessionDynamicTools: (
    threadId: string,
    patch: DynamicToolsConfigPatch,
  ) => Promise<DynamicToolsListResult>;
  clearSessionDynamicTools: (threadId: string) => Promise<DynamicToolsListResult>;

  respondToolUserInput: (requestId: string, answers: Record<string, { answers: string[] }>) => Promise<{ ok: true }>;
  onToolUserInput: (handler: (req: ToolUserInputRequest) => void) => () => void;

  onEvent: (handler: (event: CodexEvent) => void) => () => void;
  onApproval: (handler: (req: ApprovalRequest) => void) => () => void;
  onDynamicTool: (handler: (req: DynamicToolConfirmRequest) => void) => () => void;

  openPreviewWindow: (
    url: string,
    sessionId: string,
    instanceId: string,
    forceNavigate?: boolean,
  ) => Promise<void>;
  closePreviewWindow: (sessionId: string) => Promise<void>;
  setPreviewFocusSession: (sessionId: string) => Promise<void>;
  onPreviewOpened: (handler: (payload: { url: string; sessionId: string }) => void) => () => void;
  onPreviewClosed: (handler: (payload: { sessionId: string }) => void) => () => void;
  onPreviewWindowClosed: (
    handler: (payload: { sessionId: string; instanceId: string; url?: string | null }) => void,
  ) => () => void;
  onPreviewUrlChanged: (
    handler: (payload: { sessionId: string; url: string }) => void,
  ) => () => void;
  onPreviewElementSelected: (
    handler: (payload: { sessionId: string; instanceId: string; data: unknown }) => void,
  ) => () => void;
}
