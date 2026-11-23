export type EngineCapability =
  | "connection" | "history" | "messages" | "stream" | "tools"
  | "permissions" | "models" | "diff" | "agents";

export type EngineCheck = { feature: EngineCapability; state: "verified" | "unavailable" | "unchecked"; detail: string };
export type EngineCompatibility = {
  state: "compatible" | "partial" | "incompatible" | "unchecked";
  checks: EngineCheck[];
  canSend: boolean;
};

export type EngineUpdateInfo = {
  source: "bundled" | "managed" | "external";
  installed?: string;
  latest?: string;
  available: boolean;
  canInstall: boolean;
  checkedAt?: number;
  staged?: { version: string; compatibility: EngineCompatibility };
  rejected?: { version: string; compatibility: EngineCompatibility };
  previous?: string;
  phase: "idle" | "checking" | "downloading" | "testing" | "switching" | "rollback";
  error?: string;
  journal: { at: number; action: string; result: string }[];
};
