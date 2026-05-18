import { useEffect, useMemo, useState } from "react";
import type { ThemeMode } from "../types";

const storageKey = "todo-ai-theme";

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const stored = window.localStorage.getItem(storageKey);
    return stored === "dark" || stored === "light" || stored === "system" ? stored : "dark";
  });
  const [systemTheme, setSystemTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    void window.todoAI?.getSystemTheme().then(setSystemTheme);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(media.matches ? "dark" : "light");
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(storageKey, theme);
  }, [theme]);

  const resolvedTheme = useMemo(() => (theme === "system" ? systemTheme : theme), [systemTheme, theme]);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);

  return { theme, resolvedTheme, setTheme };
}
