// Chống lặp toast lỗi: cùng một nội dung hiện liên tiếp thì antd chỉ cập nhật toast cũ (cùng `key`) thay vì xếp chồng nhiều toast giống hệt.
type ErrorFn = (...args: unknown[]) => unknown;
const patched = new WeakSet<object>();

export function dedupeErrorToasts(target: { error: unknown }): void {
  if (patched.has(target)) return;
  patched.add(target);
  const original = target.error as ErrorFn;
  target.error = (content: unknown, ...rest: unknown[]) => {
    if (typeof content === 'string') return original({ content, key: `error:${content}` }, ...rest);
    const cfg = content as { content?: unknown; key?: unknown } | null;
    if (cfg && typeof cfg === 'object' && cfg.key === undefined && typeof cfg.content === 'string') return original({ ...cfg, key: `error:${cfg.content}` }, ...rest);
    return original(content, ...rest);
  };
}
