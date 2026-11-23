# Third-party notices

Rote Coding Fraktion (RCF), formerly Forge Agent, is an independent application. It is not an OpenAI product and does not use OpenAI branding or artwork.

The Windows distribution includes OpenCode CLI 2.3.0, published by anomalyco as `@opencode/cli`, and the official `@opencode/client` 2.3.0. OpenCode is licensed under MIT. The unmodified upstream license is included in `resources/engine/LICENSE` in the distribution and `resources/OPENCODE-LICENSE` in the source tree. Source and license: https://github.com/anomalyco/opencode/tree/v2.3.0 .

RCF can also install OpenCode CLI 2.3.2 from the upstream npm distribution. This version is separate from the bundled engine. The source repository does not redistribute CLI executables.

Electron includes Chromium, Node.js and their dependencies. The Electron distribution's license files are retained in the packaged application.

React, React DOM, Zustand, TanStack Virtual, Lucide, react-markdown, remark-gfm, Shiki and Zod are used under their respective open source licenses. Installed production dependency license texts and package metadata are copied into `resources/third-party-licenses` by `scripts/collect-notices.mjs`.

Local PDF preparation uses Mozilla PDF.js (`pdfjs-dist`, Apache-2.0) and the native `@napi-rs/canvas` rendering package (MIT), including its upstream native-component notices. Their installed license texts are included with the production dependency notices.

Provider services, Git, GitHub CLI, Ollama and LM Studio have their own terms and installation requirements. They are not bundled except for the OpenCode engine stated above.
