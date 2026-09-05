import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// CandleKit's overlay components (ReplayControls) — namespaced under .ck-*,
// themed via the --ck-* variables AURA defines in styles.css (dark palette).
import "@getcandlekit/charts/styles.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);