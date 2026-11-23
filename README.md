# Rote Coding Fraktion

Rote Coding Fraktion (RCF) is a Windows desktop workspace for AI-assisted coding with OpenCode. It brings local projects, chat sessions, tool approvals, and Git changes together in an Electron application. The current source version is **0.2.3**.

## Features

- Work Faction for coding sessions and Chat Faction for tool-free conversations.
- Local projects, searchable session history, pinned and recent chats, and a conversation outline for long sessions.
- Streaming responses and expandable tool activity, including command output, permission requests, and file changes.
- Git status and diffs, selected-file staging, branches, commits, and task worktrees. Remote operations require explicit confirmation.
- Task agents, read-only review, and conversation checkpoints. Restoring a checkpoint leaves project files as they are.
- Provider and model configuration, image attachments for compatible models, and local PDF preparation.

## Architecture

The Electron main process supervises OpenCode and exposes a typed IPC bridge to the React and TypeScript renderer. OpenCode handles sessions, model requests, tools, credentials, and event streaming. RCF stores desktop preferences, drafts, and other local data in SQLite. See the [architecture notes](docs/ARCHITECTURE.md).

## OpenCode compatibility

| Component | Version | Role |
| --- | --- | --- |
| OpenCode CLI | 2.3.0 | Default engine for development and Windows packaging |
| OpenCode TypeScript client | 2.3.0 | Pinned API client |
| OpenCode CLI | 2.3.2 | Additional supported engine through the engine manager, subject to runtime compatibility checks |

RCF checks the engine API before enabling operations. Other engine versions can have limited functionality. Engine management is available under **Settings → About**.

## Development

Use Windows x64, Node.js 22.22 or later in the 22.x line, npm, and Git. Git must be on `PATH` for Git features. Draft pull request creation also requires GitHub CLI and an authenticated account.

From the repository root, run:

```powershell
npm ci
npm run setup
npm run dev
```

The project disables automatic npm lifecycle scripts. The explicit setup step installs the Electron runtime and the bundled OpenCode executable. Development uses a profile under `.runtime/desktop`.

```powershell
npm test
npm run build
npm run test:engine
npm run test:engine-manager-ui
```

The engine-manager UI check uses separate Electron data and local fixtures. The [live contract script](scripts/opencode-contract-live.mjs) takes a verified OpenCode executable and its exact version as arguments.

## Windows builds

```powershell
npm run build
npm run package
```

`npm run build` produces the renderer and main-process output. After setup, `npm run package` rebuilds the app and packages unsigned x64 Portable and NSIS Setup executables into `release/`. Use `npm run package:dir` for an unpacked build.

This publication contains source code. Portable and Setup builds for 0.2.3 require separate packaging and launch verification before distribution.

## Data and permissions

- The default Windows profile is `%APPDATA%\Forge Agent`. Portable builds also use it by default. Set `RCF_DATA_DIR` to an absolute path for a separate profile.
- OpenCode permissions govern tool actions. Commands allowed by those permissions run with the OS privileges of the signed-in user. Use OS-level isolation for untrusted projects.
- OpenCode manages provider credentials in the app profile. Keep profiles, credentials, attachments, and local databases outside version control.
- Provider availability and model capabilities vary. Model-dependent features require a compatible provider and model.

## Documentation and license

- [Changelog](CHANGELOG.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Historical verification](VERIFICATION.md)
- [MIT license](LICENSE)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

Historical reports refer to local verification outputs and Windows binaries from earlier versions. Those paths document the original runs.
