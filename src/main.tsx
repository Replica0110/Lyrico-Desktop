import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import "./i18n";
import App from "./App";
import { installFrontendDiagnostics } from "./backend/diagnostics";

installFrontendDiagnostics();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
