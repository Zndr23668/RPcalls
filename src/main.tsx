import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./material3-web.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);