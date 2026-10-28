import { useEffect, useRef, useState } from 'react';

// `scope` (vd. `${tenantId}:${userId}`) tách bản lưu cục bộ giữa công ty/người dùng dùng chung một trình duyệt.
// Máy chủ là nguồn đúng: chỉ khi GET lỗi (mất mạng, 401...) mới dùng bản lưu cục bộ làm dự phòng.
export function useRememberedFilter<T extends object>(key: string, defaults: T, scope = ''): [T, (v: T) => void] {
  const localKey = `filter:${scope}:${key}`;
  const serverUrl = `/api/prefs/${encodeURIComponent(`filter:${key}`)}`;
  const readLocal = (): T => { try { const s = localStorage.getItem(localKey); return s ? { ...defaults, ...(JSON.parse(s) as T) } : defaults; } catch { return defaults; } };
  const clearLocal = () => { try { localStorage.removeItem(localKey); } catch { /* bỏ qua */ } };
  const [value, setValue] = useState<T>(defaults);
  const touched = useRef(false); // người dùng đã đổi bộ lọc trước khi bản nạp về: bản nạp không được ghi đè
  useEffect(() => {
    let alive = true;
    touched.current = false;
    setValue(defaults); // đổi khóa/phạm vi thì bỏ bộ lọc của khóa cũ, rồi nạp lại từ máy chủ
    const fallback = () => { if (alive && !touched.current) setValue(readLocal()); };
    void fetch(serverUrl, { credentials: 'include' }).then(async (r) => {
      if (r.status === 404) { clearLocal(); return; }
      if (!r.ok) { fallback(); return; }
      const b = (await r.json()) as { value: T | null };
      if (!alive || touched.current) return;
      if (b.value) setValue({ ...defaults, ...b.value }); else clearLocal();
    }).catch(fallback);
    return () => { alive = false; };
  }, [localKey, serverUrl]); // không theo `defaults` (đối tượng mới mỗi lần render)
  const update = (v: T) => {
    touched.current = true; setValue(v);
    try { localStorage.setItem(localKey, JSON.stringify(v)); } catch { /* bỏ qua */ }
    void fetch(serverUrl, { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: v }) }).catch(() => undefined);
  };
  return [value, update];
}
