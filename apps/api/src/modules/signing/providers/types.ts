// Giao diện chung của bên ký. 'client': trình duyệt lấy chữ ký (tiện ích cục bộ) rồi gọi /complete. 'server': máy chủ lấy chữ ký (SmartCA, giả lập) qua /poll.
export type SigningKind = 'local_agent' | 'smartca' | 'fake';
export const SIGNING_MODE: Record<SigningKind, 'client' | 'server'> = { local_agent: 'client', smartca: 'server', fake: 'server' };

export class SigningProviderError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
