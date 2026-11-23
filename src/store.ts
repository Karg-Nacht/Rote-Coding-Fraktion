import { create } from "zustand";
import { setLanguage } from "./i18n";
import type { EngineUpdateInfo } from "../shared/engine-manager";
import type {
  AppState,
  EngineStatus,
  Model,
  ModelRef,
  Preferences,
  Project,
  Session,
  Snapshot,
  Workspace,
} from "../shared/types";
type State = AppState & {
  models: Model[];
  snapshot?: Snapshot;
  loading: boolean;
  error?: string;
  settings: boolean;
  settingsSection?: string;
  search: boolean;
  git: boolean;
  sidebar: boolean;
  draftVersion: number;
  bootstrapped: boolean;
  engineUpdate?: EngineUpdateInfo;
  searchTarget?: { sessionId: string; messageId: string; query: string };
  set: (value: Partial<State>) => void;
};
export const useApp = create<State>((set) => ({
  projects: [],
  sessions: [],
  preferences: { mode: "cautious", sidebarWidth: 260 },
  engine: { state: "starting" },
  models: [],
  loading: false,
  settings: false,
  search: false,
  git: false,
  sidebar: true,
  draftVersion: 0,
  bootstrapped: false,
  set,
}));
export const api = window.desktop;
export const report = (error: unknown) =>
  useApp.getState().set({
    error: String(error instanceof Error ? error.message : error).replace(
      /^Error invoking remote method '[^']+': Error: /,
      "",
    ),
  });
export async function attempt<T>(
  task: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await task();
  } catch (e) {
    report(e);
  }
}
let openSequence = 0;
let refreshSequence = 0;
export async function openSession(session: Session, restoreModel = false) {
  const sequence = ++openSequence;
  const before = useApp.getState();
  useApp.getState().set({
    loading: true,
    searchTarget: undefined,
    ...(session.workspace !== before.preferences.workspace
      ? { git: false }
      : {}),
    preferences: {
      ...useApp.getState().preferences,
      projectId: session.projectId,
      sessionId: session.id,
      workspace: session.workspace ?? "work",
      workspaceSessions: {
        ...before.preferences.workspaceSessions,
        ...(before.snapshot
          ? {
              [before.snapshot.session.workspace ?? "work"]:
                before.snapshot.session.id,
            }
          : {}),
        [session.workspace ?? "work"]: session.id,
      },
    },
    snapshot: undefined,
  });
  try {
    const snapshot = await api.openSession(session.id);
    if (sequence !== openSequence) return;
    useApp.getState().set({
      snapshot,
      sessions: useApp
        .getState()
        .sessions.map((s) =>
          s.id === session.id ? { ...s, unread: false } : s,
        ),
      loading: false,
      preferences: {
        ...useApp.getState().preferences,
        workspace: snapshot.session.workspace ?? "work",
        model:
          restoreModel && before.preferences.model
            ? before.preferences.model
            : (snapshot.session.model ?? useApp.getState().preferences.model),
        mode: snapshot.session.mode,
      },
    });
    if (!restoreModel && snapshot.session.model)
      await api.savePreferences({ model: snapshot.session.model });
    void refreshModels(session.projectId);
  } catch (e) {
    if (sequence === openSequence) {
      useApp.getState().set({ loading: false });
      report(e);
    }
  }
}
export async function selectProject(project: Project) {
  ++openSequence;
  const state = useApp.getState();
  const preferences = {
    ...state.preferences,
    projectId: project.id,
    sessionId: undefined,
  };
  state.set({ preferences, snapshot: undefined, loading: false });
  await api.savePreferences({ projectId: project.id, sessionId: undefined });
  void refreshModels(project.id);
}
export async function selectChatProject(project?: Project) {
  const state = useApp.getState();
  if (state.snapshot) {
    const session = await api.changeSessionProject(
      state.snapshot.session.id,
      project?.id,
    );
    const bootstrap = await api.bootstrap();
    useApp.getState().set({ projects: bootstrap.projects });
    await openSession(session, true);
    await refreshSessions();
  } else {
    state.set({
      preferences: { ...state.preferences, projectId: project?.id },
      git: false,
    });
    await api.savePreferences({ projectId: project?.id, sessionId: undefined });
    await refreshModels(project?.id);
  }
}
export async function refreshModels(
  projectId = useApp.getState().preferences.projectId,
) {
  if (useApp.getState().engine.compatibility?.checks.some(
    (check) => check.feature === "models" && check.state === "unavailable",
  )) return;
  const models = await api.models(projectId);
  if (projectId !== useApp.getState().preferences.projectId) return;
  useApp.getState().set({ models });
}
export async function refreshSessions(restore = false) {
  const seq = ++refreshSequence;
  const state = useApp.getState();
  if (state.engine.state !== "ready") return;
  const result = await Promise.all(
    state.projects.map(async (p) => {
      const sessions: Session[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.sessions(p.id, cursor);
        sessions.push(...page.sessions);
        cursor = page.next ?? undefined;
      } while (cursor);
      return sessions;
    }),
  );
  if (seq !== refreshSequence) return;
  const sessions = result.flat().sort((a, b) => b.updated - a.updated);
  state.set({ sessions });
  if (restore && !useApp.getState().snapshot && state.preferences.sessionId) {
    const saved = sessions.find((s) => s.id === state.preferences.sessionId);
    if (saved) await openSession(saved, true);
  }
}
export async function addProject() {
  const project = await api.addProject();
  if (!project) return;
  const state = useApp.getState();
  if (!state.projects.some((p) => p.id === project.id))
    state.set({ projects: [...state.projects, project] });
  await selectProject(project);
  await refreshSessions();
}
export async function newSession() {
  const state = useApp.getState();
  ++openSequence;
  const projectId = state.projects.find(
    (p) => p.id === state.preferences.projectId,
  )?.managed
    ? undefined
    : state.preferences.projectId;
  state.set({
    snapshot: undefined,
    loading: false,
    searchTarget: undefined,
    git: false,
    draftVersion: state.draftVersion + 1,
    preferences: { ...state.preferences, sessionId: undefined, projectId },
  });
  await api.savePreferences({ sessionId: undefined, projectId });
  await refreshModels(projectId);
}
export async function switchWorkspace(workspace: Workspace) {
  const state = useApp.getState();
  const previous = state.preferences.workspace ?? "work";
  if (previous === workspace) return;
  ++openSequence;
  const workspaceSessions = {
    ...state.preferences.workspaceSessions,
    ...(state.snapshot ? { [previous]: state.snapshot.session.id } : {}),
  };
  const sessionId = workspaceSessions[workspace];
  state.set({
    snapshot: undefined,
    git: false,
    loading: false,
    searchTarget: undefined,
    preferences: {
      ...state.preferences,
      workspace,
      sessionId,
      workspaceSessions,
    },
  });
  await api.savePreferences({ workspace, sessionId, workspaceSessions });
  const saved = state.sessions.find(
    (s) => s.id === sessionId && (s.workspace ?? "work") === workspace,
  );
  if (saved) await openSession(saved);
}
export async function toggleSessionPin(session: Session) {
  await api.pinSession(session.id, !session.pinned);
  const state = useApp.getState();
  if (state.snapshot?.session.id === session.id)
    state.set({
      snapshot: {
        ...state.snapshot,
        session: { ...state.snapshot.session, pinned: !session.pinned },
      },
    });
  await refreshSessions();
}
export async function archiveSession(session: Session) {
  await api.archiveSession(session.id, true);
  const state = useApp.getState();
  if (state.preferences.sessionId === session.id) {
    const project = state.projects.find((p) => p.id === session.projectId);
    if (project) await selectProject(project);
  }
  await refreshSessions();
}
export async function savePreferences(value: Partial<Preferences>) {
  const state = useApp.getState();
  if (value.language) setLanguage(value.language);
  state.set({ preferences: { ...state.preferences, ...value } });
  await api.savePreferences(value);
}
export function sameModel(a: ModelRef | undefined, b: ModelRef) {
  return a?.id === b.id && a.providerID === b.providerID;
}
export function selectDefaultModel({ id, providerID }: ModelRef) {
  const { model } = useApp.getState().preferences;
  return savePreferences({
    model: sameModel(model, { id, providerID }) ? model : { id, providerID },
  });
}
export function toggleFavoriteModel({ id, providerID }: ModelRef) {
  const model = { id, providerID };
  const favorites = useApp.getState().preferences.favoriteModels ?? [];
  return savePreferences({
    favoriteModels: favorites.some((item) => sameModel(item, model))
      ? favorites.filter((item) => !sameModel(item, model))
      : [...favorites, model],
  });
}
let initialized = false;
export async function initialize() {
  if (initialized) return;
  initialized = true;
  const bootstrap = await api.bootstrap();
  setLanguage(bootstrap.preferences.language ?? "ru");
  const chat = new URLSearchParams(location.search).get("chat");
  if (chat) bootstrap.preferences.sessionId = chat;
  useApp.getState().set({ ...bootstrap, bootstrapped: true });
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let restore = true;
  const ready = async (status: EngineStatus) => {
    const state = useApp.getState();
    const changedProfile = state.engine.generation !== status.generation;
    if (changedProfile) {
      openSequence++;
      refreshSequence++;
      restore = true;
    }
    state.set({ engine: status, ...(changedProfile ? { sessions: [], snapshot: undefined, models: [], loading: false } : {}) });
    if (status.state === "ready") {
      await attempt(async () => {
        await refreshSessions(restore);
        restore = false;
        await refreshModels();
      });
    }
  };
  api.onEvent((event) => {
    if (event.type === "theme") {
      const state = useApp.getState();
      state.set({ preferences: { ...state.preferences, theme: event.theme } });
    }
    if (event.type === "engine") void ready(event.status);
    if (event.type === "engine-update") useApp.getState().set({ engineUpdate: event.update });
    if (event.type === "snapshot") {
      const state = useApp.getState();
      if (state.preferences.sessionId === event.snapshot.session.id)
        state.set({ snapshot: event.snapshot });
    }
    if (event.type === "error") report(event.message);
    if (event.type === "changed" && !refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void attempt(async () => {
          const { projects } = await api.bootstrap();
          const latest = useApp.getState();
          const removed =
            latest.preferences.projectId &&
            !projects.some((p) => p.id === latest.preferences.projectId);
          latest.set({
            projects,
            ...(removed
              ? {
                  snapshot: undefined,
                  preferences: {
                    ...latest.preferences,
                    projectId: projects[0]?.id,
                    sessionId: undefined,
                  },
                }
              : {}),
          });
          await refreshSessions();
          const current = useApp.getState().snapshot;
          if (current) {
            const present = useApp
              .getState()
              .sessions.find((s) => s.id === current.session.id);
            if (!present) useApp.getState().set({ snapshot: undefined });
            else if (
              !event.sessionId ||
              event.sessionId === current.session.id
            ) {
              const fresh = await api.refreshSession(current.session.id);
              if (useApp.getState().snapshot?.session.id === fresh.session.id)
                useApp.getState().set({ snapshot: fresh });
            }
          }
          if (!event.sessionId) await refreshModels();
        });
      }, 700);
  });
  await ready(bootstrap.engine);
}
