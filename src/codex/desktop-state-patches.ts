type Patch = { op?: unknown; path?: unknown; value?: unknown };

/** Atomic path-copy patches: do not clone untouched history or mutate a pending request. */
export function applyDesktopStatePatches<T extends Record<string, unknown>>(state: T, patches: readonly unknown[]): T | undefined {
  let next: Record<string, unknown> = state;
  for (const raw of patches) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const patch = raw as Patch;
    const keys = patch.path;
    if (!Array.isArray(keys) || !keys.length || !keys.every(safeKey)) return undefined;
    const op = patch.op ?? "replace";
    if (!["add", "replace", "remove"].includes(String(op))) return undefined;
    const root = { ...next };
    let source: Record<string | number, unknown> | unknown[] = next;
    let target: Record<string | number, unknown> | unknown[] = root;
    for (const key of keys.slice(0, -1)) {
      if (!Object.hasOwn(source, key)) return undefined;
      const child = (source as Record<string | number, unknown>)[key];
      if (!child || typeof child !== "object") return undefined;
      const clone = Array.isArray(child) ? child.slice() : { ...child };
      (target as Record<string | number, unknown>)[key] = clone;
      source = child as typeof source; target = clone;
    }
    const key = keys.at(-1)!;
    if (Array.isArray(target)) {
      if (key === "length" && op === "replace" && Number.isSafeInteger(patch.value)
        && Number(patch.value) >= 0 && Number(patch.value) <= target.length) target.length = Number(patch.value);
      else {
        const index = typeof key === "number" ? key : /^\d+$/.test(key) ? Number(key) : -1;
        if (!Number.isSafeInteger(index) || index < 0 || index > target.length || op !== "add" && index === target.length) return undefined;
        if (op === "remove") target.splice(index, 1);
        else if (op === "add") target.splice(index, 0, patch.value);
        else target[index] = patch.value;
      }
    } else {
      if (op !== "add" && !Object.hasOwn(target, key)) return undefined;
      if (op === "remove") delete target[key];
      else target[key] = patch.value;
    }
    next = root;
  }
  return next as T;
}

function safeKey(key: unknown): key is string | number {
  return (typeof key === "string" || typeof key === "number" && Number.isSafeInteger(key) && key >= 0)
    && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}
