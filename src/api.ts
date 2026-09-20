import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  ApprovalRequest,
  AppConfigSnapshot,
  AppSettings,
  AgentPermissions,
  CodexApi,
  CodexEvent,
  CodexRuntimeInfo,
  CronJob,
  DirEntry,
  DynamicToolConfirmRequest,
  DynamicToolsConfigPatch,
  DynamicToolsListResult,
  ExperimentalFeature,
  FileContent,
  FileMetadata,
  FuzzySearchResult,
  GitDiffFile,
  GitStatus,
  McpElicitationRequest,
  McpServerRow,
  PermissionProfile,
  PluginInfo,
  Project,
  ProviderCapabilities,
  Session,
  SkillInfo,
  QueueSnapshot,
  ToolUserInputRequest,
  UpsertCronJobInput,
  UpsertMcpServerInput,
  WatchHandle,
} from './types';

type OkOrErr =
  | { ok: true; queued?: boolean; pendingId?: string }
  | { ok: false; error: string };

function listenCleanup<T>(
  event: string,
  handler: (payload: T) => void,
): () => void {
  let unlisten: (() => void) | undefined;
  const pending = listen<T>(event, (e) => handler(e.payload));
  void pending.then((fn) => {
    unlisten = fn;
  });
  return () => {
    if (unlisten) {
      unlisten();
    } else {
      void pending.then((fn) => fn());
    }
  };
}

export const codexApi: CodexApi = {
  getSettings: () => invoke<AppSettings | null>('get_settings'),

  saveSettings: (settings) => invoke<OkOrErr>('save_settings_cmd', { settings }),

  validateSettings: (settings) =>
    invoke<OkOrErr>('validate_settings_cmd', { settings }),

  maskApiKey: (apiKey) => invoke<string>('mask_api_key_cmd', { apiKey }),

  getCodexRuntime: () => invoke<CodexRuntimeInfo>('get_codex_runtime'),

  getAgentPermissions: () => invoke<AgentPermissions>('get_agent_permissions'),

  setAgentPermissions: (permissions) =>
    invoke<AgentPermissions>('set_agent_permissions', { permissions }),

  getProviderCapabilities: (model) =>
    invoke<ProviderCapabilities>('get_provider_capabilities', {
      model: model ?? null,
    }),

  readAppConfig: () => invoke<AppConfigSnapshot>('read_app_config_cmd'),

  writeAppConfigValue: (keyPath, value) =>
    invoke<AppConfigSnapshot>('write_app_config_value_cmd', { keyPath, value }),

  listExperimentalFeatures: () =>
    invoke<ExperimentalFeature[]>('list_experimental_features_cmd'),

  setExperimentalFeature: (name, enabled) =>
    invoke<ExperimentalFeature[]>('set_experimental_feature_cmd', { name, enabled }),

  readConfigRequirements: () => invoke<unknown>('read_config_requirements_cmd'),

  listMcpServers: () => invoke<McpServerRow[]>('list_mcp_servers_cmd'),

  upsertMcpServer: (input) => invoke<McpServerRow[]>('upsert_mcp_server_cmd', { input }),

  deleteMcpServer: (name) => invoke<McpServerRow[]>('delete_mcp_server_cmd', { name }),

  reloadMcpServers: () => invoke<McpServerRow[]>('reload_mcp_servers_cmd'),

  mcpServerOauthLogin: (name) => invoke<string>('mcp_server_oauth_login_cmd', { name }),

  mcpServerResourceRead: (server, uri, threadId) =>
    invoke('mcp_server_resource_read_cmd', {
      server,
      uri,
      threadId: threadId ?? null,
    }),

  mcpServerToolCall: (server, tool, threadId, args) =>
    invoke('mcp_server_tool_call_cmd', {
      server,
      tool,
      threadId,
      arguments: args ?? null,
    }),

  listPermissionProfiles: (cwd) =>
    invoke<PermissionProfile[]>('list_permission_profiles_cmd', {
      cwd: cwd ?? null,
    }),

  setDefaultPermissionProfile: (profileId) =>
    invoke<void>('set_default_permission_profile_cmd', { profileId }),

  respondMcpElicitation: (requestId, action, content) =>
    invoke<{ ok: true }>('respond_mcp_elicitation', {
      requestId,
      action,
      content: content ?? null,
    }),

  onMcpElicitation: (handler) =>
    listenCleanup<McpElicitationRequest>('codex:mcpElicitation', handler),

  listProjects: () => invoke<Project[]>('list_projects_cmd'),

  createProject: (input) => invoke<Project>('create_project_cmd', { input }),

  createDefaultProject: () => invoke<Project>('create_default_project_cmd'),

  renameProject: (id, name) => invoke<Project>('rename_project_cmd', { id, name }),

  deleteProject: (id) => invoke<void>('delete_project_cmd', { id }),

  selectDirectory: () => invoke<string | null>('select_directory'),

  listSessions: (projectId) =>
    invoke<Session[]>('list_sessions_cmd', { projectId }),

  listAllSessions: () => invoke<Session[]>('list_all_sessions_cmd'),

  searchSessions: (searchTerm) =>
    invoke<Session[]>('search_sessions_cmd', { searchTerm }),

  createSession: (projectId, title) =>
    invoke<Session>('create_session_cmd', {
      projectId: projectId ?? null,
      title: title ?? null,
    }),

  getSession: (projectId, sessionId) =>
    invoke<Session | null>('get_session_cmd', { projectId, sessionId }),

  renameSession: (projectId, sessionId, title) =>
    invoke<Session>('rename_session_cmd', { projectId, sessionId, title }),

  forkSession: (sessionId, lastTurnId) =>
    invoke<Session>('fork_session_cmd', {
      sessionId,
      lastTurnId: lastTurnId ?? null,
    }),

  archiveSession: (sessionId) => invoke<void>('archive_session_cmd', { sessionId }),

  unarchiveSession: (sessionId) => invoke<void>('unarchive_session_cmd', { sessionId }),

  deleteSession: (sessionId) => invoke<void>('delete_session_cmd', { sessionId }),

  listArchivedSessions: () => invoke<Session[]>('list_archived_sessions_cmd'),

  listSkills: (cwds, forceReload) =>
    invoke<SkillInfo[]>('list_skills_cmd', {
      cwds: cwds ?? null,
      forceReload: forceReload ?? false,
    }),

  setSkillEnabled: (enabled, name, path) =>
    invoke<boolean>('set_skill_enabled_cmd', {
      enabled,
      name: name ?? null,
      path: path ?? null,
    }),

  listPlugins: (cwds) =>
    invoke<PluginInfo[]>('list_plugins_cmd', { cwds: cwds ?? null }),

  installPlugin: (pluginName, marketplacePath, remoteMarketplaceName) =>
    invoke<void>('install_plugin_cmd', {
      pluginName,
      marketplacePath: marketplacePath ?? null,
      remoteMarketplaceName: remoteMarketplaceName ?? null,
    }),

  uninstallPlugin: (pluginId) =>
    invoke<void>('uninstall_plugin_cmd', { pluginId }),

  pluginRead: (pluginName, marketplacePath, remoteMarketplaceName) =>
    invoke('plugin_read_cmd', {
      pluginName,
      marketplacePath: marketplacePath ?? null,
      remoteMarketplaceName: remoteMarketplaceName ?? null,
    }),

  addPluginScheduledTask: (
    pluginName,
    marketplacePath,
    remoteMarketplaceName,
    taskKey,
    projectId,
  ) =>
    invoke<CronJob>('add_plugin_scheduled_task_cmd', {
      pluginName,
      marketplacePath: marketplacePath ?? null,
      remoteMarketplaceName: remoteMarketplaceName ?? null,
      taskKey,
      projectId: projectId ?? null,
    }),

  compactThread: (threadId) => invoke('compact_thread_cmd', { threadId }),

  reviewStart: (threadId, target, delivery) =>
    invoke('review_start_cmd', {
      threadId,
      target,
      delivery: delivery ?? null,
    }),

  threadGoalGet: (threadId) => invoke('thread_goal_get_cmd', { threadId }),

  threadGoalSet: (threadId, objective, status, tokenBudget) =>
    invoke('thread_goal_set_cmd', {
      threadId,
      objective: objective ?? null,
      status: status ?? null,
      tokenBudget: tokenBudget ?? null,
    }),

  threadGoalClear: (threadId) => invoke('thread_goal_clear_cmd', { threadId }),

  commandExec: (command, cwd, processId, tty, cols, rows) =>
    invoke('command_exec_cmd', {
      command,
      cwd: cwd ?? null,
      processId: processId ?? null,
      tty: tty ?? null,
      cols: cols ?? null,
      rows: rows ?? null,
    }),

  commandExecWrite: (processId, dataBase64) =>
    invoke('command_exec_write_cmd', { processId, dataBase64 }),

  commandExecResize: (processId, cols, rows) =>
    invoke('command_exec_resize_cmd', { processId, cols, rows }),

  commandExecTerminate: (processId) =>
    invoke('command_exec_terminate_cmd', { processId }),

  getAutostartEnabled: () => invoke<boolean>('get_autostart_enabled_cmd'),

  setAutostartEnabled: (enabled) =>
    invoke<boolean>('set_autostart_enabled_cmd', { enabled }),

  fsReadDirectory: (path) => invoke<DirEntry[]>('fs_read_directory_cmd', { path }),

  fsReadFile: (path) => invoke<FileContent>('fs_read_file_cmd', { path }),

  fsWriteFile: (path, dataBase64) =>
    invoke<void>('fs_write_file_cmd', { path, dataBase64 }),

  fsWriteTextFile: (path, text) =>
    invoke<void>('fs_write_text_file_cmd', { path, text }),

  fsCreateDirectory: (path, recursive) =>
    invoke<void>('fs_create_directory_cmd', {
      path,
      recursive: recursive ?? null,
    }),

  fsGetMetadata: (path) => invoke<FileMetadata>('fs_get_metadata_cmd', { path }),

  fsRemove: (path, force, recursive) =>
    invoke<void>('fs_remove_cmd', {
      path,
      force: force ?? null,
      recursive: recursive ?? null,
    }),

  fsCopy: (sourcePath, destinationPath, recursive) =>
    invoke<void>('fs_copy_cmd', {
      sourcePath,
      destinationPath,
      recursive: recursive ?? null,
    }),

  fsWatch: (path, watchId) =>
    invoke<WatchHandle>('fs_watch_cmd', {
      path,
      watchId: watchId ?? null,
    }),

  fsUnwatch: (watchId) => invoke<void>('fs_unwatch_cmd', { watchId }),

  fuzzyFileSearch: (query, roots, cancellationToken) =>
    invoke<FuzzySearchResult>('fuzzy_file_search_cmd', {
      query,
      roots,
      cancellationToken: cancellationToken ?? null,
    }),

  getGitStatus: (cwd) => invoke<GitStatus | null>('get_git_status_cmd', { cwd }),

  getGitDiff: (cwd) => invoke<GitDiffFile[]>('get_git_diff_cmd', { cwd }),

  gitStage: (cwd, paths) => invoke<void>('git_stage_cmd', { cwd, paths }),

  gitCommit: (cwd, message) => invoke<string>('git_commit_cmd', { cwd, message }),

  openInEditor: (path, editor) =>
    invoke<void>('open_in_editor_cmd', { path, editor: editor ?? null }),

  startTurn: (input) => invoke<OkOrErr>('start_turn', { input }),

  interruptTurn: (sessionId?: string) =>
    invoke<{ ok: true }>('interrupt_turn', { sessionId: sessionId ?? null }),

  interruptAndClearQueues: () => invoke<{ ok: true }>('interrupt_and_clear_queues_cmd'),

  cancelPending: (id) => invoke<OkOrErr>('cancel_pending_cmd', { id }),

  sendPendingNow: (id) => invoke<OkOrErr>('send_pending_now_cmd', { id }),

  respondApproval: (requestId, decision, applyNetworkAmendment) =>
    invoke<{ ok: true }>('respond_approval', {
      requestId,
      decision,
      applyNetworkAmendment: applyNetworkAmendment ?? null,
    }),

  respondDynamicTool: (requestId, allowed) =>
    invoke<void>('respond_dynamic_tool_cmd', { requestId, allowed }),

  onEvent: (handler) => listenCleanup<CodexEvent>('codex:event', handler),

  onApproval: (handler) =>
    listenCleanup<ApprovalRequest>('codex:approval', handler),

  onDynamicTool: (handler) =>
    listenCleanup<DynamicToolConfirmRequest>('codex:dynamicTool', handler),

  onQueue: (handler) => listenCleanup<QueueSnapshot>('codex:queue', handler),

  listCronJobs: () => invoke<CronJob[]>('list_cron_jobs_cmd'),

  upsertCronJob: (input) => invoke<CronJob>('upsert_cron_job_cmd', { input }),

  deleteCronJob: (id) => invoke<void>('delete_cron_job_cmd', { id }),

  setCronJobEnabled: (id, enabled) =>
    invoke<CronJob>('set_cron_job_enabled_cmd', { id, enabled }),

  runCronJobNow: (id) => invoke<OkOrErr>('run_cron_job_now_cmd', { id }),

  onScheduled: (handler) =>
    listenCleanup<{ jobId: string; threadId?: string; status: string; error?: string }>(
      'codex:scheduled',
      handler,
    ),

  listDynamicTools: () => invoke<DynamicToolsListResult>('list_dynamic_tools_cmd'),

  setDynamicToolsConfig: (patch: DynamicToolsConfigPatch) =>
    invoke<DynamicToolsListResult>('set_dynamic_tools_config_cmd', { patch }),

  listSessionDynamicTools: (threadId) =>
    invoke<DynamicToolsListResult>('list_session_dynamic_tools_cmd', { threadId }),

  setSessionDynamicTools: (threadId, patch) =>
    invoke<DynamicToolsListResult>('set_session_dynamic_tools_cmd', { threadId, patch }),

  clearSessionDynamicTools: (threadId) =>
    invoke<DynamicToolsListResult>('clear_session_dynamic_tools_cmd', { threadId }),

  respondToolUserInput: (requestId, answers) =>
    invoke<{ ok: true }>('respond_tool_user_input_cmd', { requestId, answers }),

  onToolUserInput: (handler) =>
    listenCleanup<ToolUserInputRequest>('codex:toolUserInput', handler),

  openPreviewWindow: (url, sessionId, instanceId, forceNavigate) =>
    invoke<void>('open_preview_window', {
      url,
      sessionId,
      instanceId,
      forceNavigate: forceNavigate ?? true,
    }),

  closePreviewWindow: (sessionId) => invoke<void>('close_preview_window', { sessionId }),

  setPreviewFocusSession: (sessionId) =>
    invoke<void>('set_preview_focus_session', { sessionId }),

  onPreviewOpened: (handler) =>
    listenCleanup<{ url: string; sessionId: string }>('preview-opened', handler),

  onPreviewClosed: (handler) =>
    listenCleanup<{ sessionId: string }>('preview-closed', handler),

  onPreviewWindowClosed: (handler) =>
    listenCleanup<{ sessionId: string; instanceId: string; url?: string | null }>(
      'preview-window-closed',
      handler,
    ),

  onPreviewUrlChanged: (handler) =>
    listenCleanup<{ sessionId: string; url: string }>('preview-url-changed', handler),

  onPreviewElementSelected: (handler) =>
    listenCleanup<{ sessionId: string; instanceId: string; data: unknown }>(
      'preview-element-selected',
      handler,
    ),
};
