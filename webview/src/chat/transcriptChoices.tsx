import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
} from "react";

type Choice = boolean | null | { cursor?: number; direction?: "before" | "after" };
export type TranscriptChoices = Map<string, Choice>;
type Scope = { choices: TranscriptChoices; key: string };
const ChoiceScope = createContext<Scope | null>(null);

// Keep the reader's choices, not the mounted row, tool result or rendered
// SVG. A workspace switch clears this map, just as it did with keyed chat.
export function TranscriptChoiceScope({
  id,
  choices,
  children,
}: {
  id: string;
  choices?: TranscriptChoices;
  children: ReactNode;
}) {
  const parent = useContext(ChoiceScope);
  const scope = useMemo(
    () =>
      choices
        ? { choices, key: id }
        : parent
          ? { choices: parent.choices, key: `${parent.key}/${id}` }
          : null,
    [choices, parent, id],
  );
  return <ChoiceScope.Provider value={scope}>{children}</ChoiceScope.Provider>;
}

export function useTranscriptChoiceOwner() {
  return useContext(ChoiceScope)?.key;
}

export function useResetTranscriptChoices() {
  const scope = useContext(ChoiceScope);
  return useCallback(
    (name: string) => {
      if (!scope) return;
      const prefix = `${scope.key}/${name}`;
      for (const key of scope.choices.keys()) if (key.startsWith(prefix)) scope.choices.delete(key);
    },
    [scope],
  );
}

export function useTranscriptChoice<T extends Choice>(name: string, initial: T) {
  const scope = useContext(ChoiceScope);
  const key = scope && `${scope.key}/${name}`;
  const [value, setValue] = useState<T>(() =>
    scope && key && scope.choices.has(key) ? (scope.choices.get(key) as T) : initial,
  );
  const latest = useRef(value);
  const set = useCallback(
    (action: SetStateAction<T>) => {
      const next = typeof action === "function" ? action(latest.current) : action;
      latest.current = next;
      if (scope && key) {
        if (next === initial) scope.choices.delete(key);
        else scope.choices.set(key, next);
      }
      setValue(next);
    },
    [scope, key, initial],
  );
  return [value, set] as const;
}
