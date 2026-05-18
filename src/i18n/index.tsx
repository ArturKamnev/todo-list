import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Language } from "../types";
import { en } from "./en";
import { ru } from "./ru";

export type TranslationKey = keyof typeof en;

const languageStorageKey = "todo-ai-language";

const dictionaries: Record<Language, Record<TranslationKey, string>> = {
  en,
  ru,
};

const languageNames: Record<Language, { label: string; nativeLabel: string }> = {
  en: { label: "English", nativeLabel: "English" },
  ru: { label: "Russian", nativeLabel: "Русский" },
};

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
  languageNames: typeof languageNames;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function getStoredLanguage(): Language {
  const stored = window.localStorage.getItem(languageStorageKey);
  return stored === "ru" || stored === "en" ? stored : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(getStoredLanguage);

  useEffect(() => {
    window.localStorage.setItem(languageStorageKey, language);
    document.documentElement.lang = language;
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key) => dictionaries[language][key],
      languageNames,
    }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used inside I18nProvider");
  }

  return context;
}
