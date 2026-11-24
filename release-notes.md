# RCF 0.3.0 · Project Intelligence

Rote Coding Fraktion is a Windows desktop workspace for OpenCode. Work Faction supports coding agents, Git worktrees, and review. Chat Faction supports conversations with tools disabled.

## What’s new

In Chat Faction, select a local project, turn on **Project Context**, and enter a question. **Preview Context** shows the code excerpts, relative paths, line ranges, approximate size, and exclusions. You can cancel preparation and keep your draft. The model can cite project evidence when explaining behavior, tracing dependencies, or discussing a likely bug.

## Install on Windows

Use a 64-bit Windows 10 or 11 system. Run `RCF-0.3.0-x64-Setup.exe` to choose an installation directory and add the Start Menu and Desktop shortcuts. The installed app can be removed from Windows Settings. Run `RCF-0.3.0-x64-Portable.exe` directly if you prefer to skip installation. The bundled OpenCode CLI and TypeScript client are version 2.3.0. Configure a supported model provider in **Settings → Models and connections**. Provider access may require a network connection and credentials.

Both executables are unsigned. Windows SmartScreen may display an unknown-publisher warning. Compare the hash of your download to `SHA256SUMS.txt`, for example with `Get-FileHash -Algorithm SHA256 .\RCF-0.3.0-x64-Setup.exe` in PowerShell.

## Privacy and limitations

Project Context starts off. Electron Main searches only the selected project and sends the excerpts to your configured model provider for that request. The scanner skips links, hidden and generated directories, common credential files, and files with recognizable secrets. Review the excerpts before sending sensitive source code. The excerpts stay out of RCF's database and stored prompt history. Model replies are part of ordinary chat history and may quote the evidence.

Search is based on file names, paths, and words in common UTF-8 source and documentation formats. It checks up to 2,000 candidate files and includes up to 35 files within about 32,000 characters. Large or heavily generated repositories may require more specific questions. Chat Faction continues to deny built-in tools, shell, file edits, subagents, and MCP tools. Existing profiles continue to use `%APPDATA%\Forge Agent`, including with the Portable build.

The Setup and Portable executables were checked on Windows x64 with isolated profiles and a loopback provider. Verification exercised Settings, Chat and Work Faction, and clean shutdown. The Setup check also exercised installation into a temporary directory and uninstalling.
