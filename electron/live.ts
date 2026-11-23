import type {
  OpenCodeEvent,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client";

// A transient projection of actual SSE deltas. History remains authoritative.
// Reasoning payloads are deliberately never stored in this projection.
export class LiveProjection {
  private sessions = new Map<
    string,
    Map<
      string,
      { message: SessionMessageAssistant; textSlots: Map<number, number> }
    >
  >();
  clear() {
    this.sessions.clear();
  }
  clearSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }
  apply(event: OpenCodeEvent): string | undefined {
    if (
      !("sessionID" in event.data) ||
      typeof event.data.sessionID !== "string"
    )
      return;
    const sessionId = event.data.sessionID;
    if (event.type === "session.step.started") {
      const messages = this.sessions.get(sessionId) ?? new Map();
      messages.set(event.data.assistantMessageID, {
        message: {
          id: event.data.assistantMessageID,
          type: "assistant",
          agent: event.data.agent,
          model: event.data.model,
          time: { created: event.data.started },
          content: [],
        },
        textSlots: new Map(),
      });
      this.sessions.set(sessionId, messages);
      return sessionId;
    }
    if (!("assistantMessageID" in event.data)) return;
    const live = this.sessions
      .get(sessionId)
      ?.get(String(event.data.assistantMessageID));
    if (!live) return; // A late subscription must not fabricate a missing text prefix.
    const message = live.message;
    if (event.type === "session.text.started") {
      live.textSlots.set(event.data.ordinal, message.content.length);
      message.content.push({ type: "text", text: "" });
    } else if (event.type === "session.reasoning.started") {
      message.content.push({ type: "reasoning", text: "" });
    } else if (
      event.type === "session.text.delta" ||
      event.type === "session.text.ended"
    ) {
      const slot = live.textSlots.get(event.data.ordinal);
      if (slot === undefined) return;
      const part = message.content[slot];
      if (part?.type === "text")
        part.text =
          event.type === "session.text.delta"
            ? part.text + event.data.delta
            : event.data.text;
    } else if (event.type === "session.tool.input.started") {
      message.content.push({
        type: "tool",
        id: event.data.id,
        name: event.data.name,
        time: { created: event.created },
        state: { status: "streaming", input: "" },
      });
    } else if (
      event.type === "session.tool.input.delta" ||
      event.type === "session.tool.input.ended" ||
      event.type === "session.tool.called" ||
      event.type === "session.tool.progress" ||
      event.type === "session.tool.success" ||
      event.type === "session.tool.failed"
    ) {
      const tool = message.content.find(
        (p): p is SessionMessageAssistantTool =>
          p.type === "tool" && p.id === event.data.id,
      );
      if (!tool) return;
      if (
        event.type === "session.tool.input.delta" &&
        tool.state.status === "streaming"
      )
        tool.state.input += event.data.delta;
      else if (
        event.type === "session.tool.input.ended" &&
        tool.state.status === "streaming"
      )
        tool.state.input = event.data.text;
      else if (event.type === "session.tool.called") {
        tool.state = {
          status: "running",
          input: event.data.input,
          metadata: {},
        };
        tool.time.ran = event.created;
        tool.executed = event.data.executed;
      } else if (
        event.type === "session.tool.progress" &&
        tool.state.status === "running"
      )
        tool.state.metadata = {
          ...tool.state.metadata,
          ...event.data.metadata,
        };
      else if (
        event.type === "session.tool.success" ||
        event.type === "session.tool.failed"
      ) {
        const input =
          typeof tool.state.input === "object" ? tool.state.input : {};
        tool.state =
          event.type === "session.tool.success"
            ? {
                status: "completed",
                input,
                content: event.data.content,
                metadata: event.data.metadata,
              }
            : {
                status: "error",
                input,
                content: event.data.content,
                metadata: event.data.metadata,
                error: event.data.error,
              };
        tool.time.completed = event.created;
      }
    } else if (
      event.type === "session.step.ended" ||
      event.type === "session.step.failed"
    ) {
      message.time.completed = event.created;
      if (event.type === "session.step.failed")
        message.error = event.data.error;
      else message.finish = event.data.finish;
    } else if (event.type === "session.retry.scheduled") {
      message.retry = {
        attempt: event.data.attempt,
        at: event.data.at,
        error: event.data.error,
      };
    } else return;
    return sessionId;
  }
  merge(
    sessionId: string,
    authoritative: SessionMessageInfo[],
  ): SessionMessageInfo[] {
    const live = this.sessions.get(sessionId);
    if (!live?.size) return authoritative;
    const merged = new Map(authoritative.map((m) => [m.id, m]));
    for (const [id, value] of live) {
      const saved = merged.get(id);
      if (saved?.type === "assistant" && saved.time.completed) {
        live.delete(id);
        continue;
      }
      merged.set(id, value.message);
    }
    return [...merged.values()].sort(
      (a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id),
    );
  }
}
