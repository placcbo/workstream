import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem("theme") || "dark";
    } catch (e) {
      return "dark";
    }
  });

  useEffect(() => {
    try {
      if (theme === "light") {
        document.documentElement.classList.add("theme-light");
        localStorage.setItem("theme", "light");
      } else {
        document.documentElement.classList.remove("theme-light");
        localStorage.setItem("theme", "dark");
      }
    } catch (e) {
      // ignore (e.g., server-side rendering)
    }
  }, [theme]);

  return (
    <button
      type="button"
      aria-label="Toggle theme"
      aria-pressed={theme === "light"}
      title={theme === "light" ? "Switch to dark" : "Switch to light"}
      className="theme-toggle"
      onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
    >
      {theme === "light" ? "🌞" : "🌙"}
    </button>
  );
}
