import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
// One copy-only implementation across Gateway, IDE pages and taskboard.
import "../../../src/web/copyable.css";
import "../../../src/web/copyable.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
