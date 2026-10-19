import { useEffect, useState } from 'react';

export function useRememberedFilter<T extends object>(key: string, defaults: T): [T, (v: T) => void] {
  const storageKey = `filter:${key}`;
  const readLocal = (): T => { try { const s = localStorage.getItem(storageKey); return s ? { ...defaults, ...(JSON.parse(s) as T) } : defaults; } catch { return defaults; } };
  const [value, setValue] = useState<T>(readLocal);
  useEffect(() => {
    let alive = true;
    setValue(readLocal()); // đổi khóa (vd. sang danh mục khác) thì nạp bộ lọc của khóa mới, không giữ của khóa cũ
    void fetch(`/api/prefs/${encodeURIComponent(storageKey)}`, { credentials: 'include' }).then(async (r) => { if (!r.ok) return; const b = (await r.json()) as { value: T | null }; if (alive && b.value) setValue({ ...defaults, ...b.value }); }).catch(() => undefined);
    return () => { alive = false; };
  }, [storageKey]); // chỉ chạy lại khi đổi khóa, không theo `defaults` (đối tượng mới mỗi lần render)
  const update = (v: T) => {
    setValue(v);
    try { localStorage.setItem(storageKey, JSON.stringify(v)); } catch { /* bỏ qua */ }
    void fetch(`/api/prefs/${encodeURIComponent(storageKey)}`, { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: v }) }).catch(() => undefined);
  };
  return [value, update];
}
