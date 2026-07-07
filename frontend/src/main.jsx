import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./app.css";
import "./theme.css";
import App from "./App.jsx";

// Apply saved theme early to avoid flash
try {
  const saved = localStorage.getItem("theme");
  if (saved === "light") document.documentElement.classList.add("theme-light");
} catch (e) {}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
