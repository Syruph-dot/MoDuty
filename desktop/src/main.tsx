import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/desktop.css";
import "./styles/tiles.css";
import "./styles/window.css";
import "./styles/edge.css";
import "./styles/governance.css";
import "./styles/settings-screen.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);