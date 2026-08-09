import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

import { copy } from "../copy.it";

type Theme = "system" | "light" | "dark";

const storageKey = "tema";
const choices = [
  { value: "system", label: copy.theme.system, Icon: Monitor },
  { value: "light", label: copy.theme.light, Icon: Sun },
  { value: "dark", label: copy.theme.dark, Icon: Moon },
] as const;

function isTheme(value: string | null): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function applyTheme(theme: Theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

export function ThemePicker() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const stored = localStorage.getItem(storageKey);
    const initial = isTheme(stored) ? stored : "system";
    setTheme(initial);
    applyTheme(initial);
  }, []);

  function choose(next: Theme) {
    localStorage.setItem(storageKey, next);
    setTheme(next);
    applyTheme(next);
  }

  return (
    <fieldset className="theme-picker">
      <legend>{copy.theme.label}</legend>
      <div className="theme-picker__options">
        {choices.map(({ value, label, Icon }) => (
          <button
            aria-pressed={theme === value}
            className="theme-picker__choice"
            key={value}
            onClick={() => choose(value)}
            type="button"
          >
            <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
