import { tr, useLanguage } from "./i18n";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./themes.css";
import "./chat-refinement.css";
class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { error?: string }
> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>{tr("Не удалось отобразить приложение")}</h1>
        <p>{this.state.error}</p>
        <button onClick={() => location.reload()}>
          {tr("Перезагрузить интерфейс")}
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
