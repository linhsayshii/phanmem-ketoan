// Dịch lỗi API ra tiếng Việt kế toán để người dùng không bao giờ thấy chữ thô của zod/fastify ("params/year Expected number, received nan").
// Thông báo do máy chủ viết sẵn bằng tiếng Việt (AppError, động cơ thuế/lương, RAISE của SQL) được giữ nguyên; chỉ lỗi kỹ thuật mới bị thay.

interface Issue { path?: (string | number)[]; code?: string; message?: string; expected?: string | undefined; received?: string | undefined; minimum?: number | string; maximum?: number | string; type?: string; validation?: string; options?: unknown[]; scope?: string }

// Tên trường thân thiện theo tên tham số/trường dữ liệu API đang dùng. Trường không có trong bảng thì không nêu tên (không lộ tên mã).
const FIELD: Record<string, string> = {
  year: 'Năm', fiscalYear: 'Năm tài chính', month: 'Tháng', period: 'Kỳ', no: 'Kỳ', from: 'Từ ngày', to: 'Đến ngày', asOf: 'Đến ngày', date: 'Ngày', dateFrom: 'Từ ngày', dateTo: 'Đến ngày',
  postingDate: 'Ngày hạch toán', documentDate: 'Ngày chứng từ', dueDate: 'Hạn thanh toán', invoiceDate: 'Ngày hóa đơn', setDate: 'Ngày chứng từ ghi sổ', effectiveFrom: 'Ngày hiệu lực',
  accountCode: 'Tài khoản', creditAccountCode: 'Tài khoản ghi Có', debitAccountCode: 'Tài khoản ghi Nợ', partyCode: 'Đối tượng', itemCode: 'Mã hàng', warehouseCode: 'Kho', currency: 'Loại tiền', rate: 'Tỷ giá',
  amount: 'Số tiền', quantity: 'Số lượng', price: 'Đơn giá', description: 'Diễn giải', voucherType: 'Loại chứng từ', voucherNo: 'Số chứng từ', taxCode: 'Mã thuế', name: 'Tên', code: 'Mã',
  employeeId: 'Nhân viên', bookForm: 'Hình thức sổ', regime: 'Chế độ kế toán', level: 'Mức khóa sổ', modules: 'Phân hệ', rows: 'Danh sách dòng', lines: 'Chi tiết', size: 'Số dòng mỗi trang', page: 'Trang',
  password: 'Mật khẩu', username: 'Tên đăng nhập', email: 'Email', q: 'Từ khóa tìm kiếm', kind: 'Loại', status: 'Trạng thái', format: 'Định dạng', id: 'Mã định danh',
};

const VI = /[àáảãạăắằẳẵặâấầẩẫậđèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵ]/i;
/** Thông báo đã là tiếng Việt (có dấu) thì do máy chủ viết sẵn, không đụng tới. */
export const isVietnamese = (s: string | undefined): s is string => !!s && VI.test(s);

const fieldLabel = (path: (string | number)[]): string => {
  const row = path.findIndex((p) => typeof p === 'number');
  const name = [...path].reverse().find((p): p is string => typeof p === 'string');
  const label = name ? FIELD[name] : undefined;
  if (row >= 0) return `Dòng ${Number(path[row]) + 1}${label && name !== 'rows' ? ` – ${label}` : ''}`;
  return label ?? '';
};

const num = (v: number | string | undefined) => (v === undefined ? '' : String(v));

/** Một lỗi zod → cụm "Trường: lý do" bằng tiếng Việt. */
export function issueText(i: Issue): string {
  const label = fieldLabel(i.path ?? []);
  const why = (() => {
    switch (i.code) {
      case 'invalid_type':
        if (i.received === 'undefined' || i.received === 'null') return 'bắt buộc nhập';
        if (i.expected === 'number' || i.expected === 'integer') return 'phải là số';
        if (i.expected === 'string') return 'phải là chữ';
        if (i.expected === 'boolean') return 'phải là có hoặc không';
        if (i.expected === 'array') return 'phải là danh sách';
        return 'giá trị không hợp lệ';
      case 'too_small':
        if (i.type === 'string') return i.minimum === 1 ? 'không được để trống' : `phải có ít nhất ${num(i.minimum)} ký tự`;
        if (i.type === 'array') return `phải có ít nhất ${num(i.minimum)} dòng`;
        return `không được nhỏ hơn ${num(i.minimum)}`;
      case 'too_big':
        if (i.type === 'string') return `không được dài quá ${num(i.maximum)} ký tự`;
        if (i.type === 'array') return `không được quá ${num(i.maximum)} dòng`;
        return `không được lớn hơn ${num(i.maximum)}`;
      case 'invalid_string':
      case 'invalid_format':
        if (i.validation === 'email') return 'không phải địa chỉ email hợp lệ';
        if (i.validation === 'datetime' || i.validation === 'date') return 'phải là ngày hợp lệ';
        return isVietnamese(i.message) ? i.message : 'sai định dạng';
      case 'invalid_enum_value':
      case 'invalid_literal':
      case 'invalid_union_discriminator':
        return 'không nằm trong các giá trị cho phép';
      case 'not_multiple_of': return 'không phải bội số hợp lệ';
      case 'custom': return isVietnamese(i.message) ? i.message : 'giá trị không hợp lệ';
      default: return isVietnamese(i.message) ? i.message : 'giá trị không hợp lệ';
    }
  })();
  // Chữ tiếng Việt do máy chủ viết (custom/superRefine) thường đã tự đủ câu: không ghép tên trường lần nữa.
  if ((i.code === 'custom' || !i.code) && isVietnamese(i.message)) return i.message!;
  if (!label) return why === 'bắt buộc nhập' ? 'Thiếu thông tin bắt buộc' : `Có trường nhập chưa hợp lệ (${why})`;
  return `${label}: ${why}`;
}

const MAX_SHOWN = 3;
export function issuesText(issues: Issue[]): string {
  const seen = [...new Set(issues.map(issueText))];
  return seen.slice(0, MAX_SHOWN).join('; ') + (seen.length > MAX_SHOWN ? `; … (còn ${seen.length - MAX_SHOWN} lỗi khác)` : '');
}

// Thông báo kiểm tra tham số thô của fastify: "params/year Expected number, received nan, body/rows/0/x Required".
const SCOPES = 'params|body|querystring|headers';
function parseRawValidation(raw: string): Issue[] | null {
  const parts = raw.split(new RegExp(`, (?=(?:${SCOPES})/)`));
  const issues: Issue[] = [];
  for (const p of parts) {
    const m = new RegExp(`^(${SCOPES})((?:/[^\\s/]*)*)\\s+(.*)$`, 's').exec(p.trim());
    if (!m) return null;
    const path = m[2]!.split('/').filter(Boolean).map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    const text = m[3]!;
    const t = /^Expected (\w+), received (\w+)$/.exec(text);
    if (t) issues.push({ path, code: 'invalid_type', expected: t[1], received: t[2] === 'nan' ? 'nan' : t[2] });
    else if (text === 'Required') issues.push({ path, code: 'invalid_type', received: 'undefined' });
    else if (/^String must contain at least 1 character/.test(text)) issues.push({ path, code: 'too_small', type: 'string', minimum: 1 });
    else issues.push({ path, code: 'custom', message: text });
  }
  return issues.length ? issues : null;
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Yêu cầu không hợp lệ, hãy kiểm tra lại thông tin đã nhập',
  401: 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại',
  403: 'Tài khoản không có quyền thực hiện thao tác này',
  404: 'Không tìm thấy dữ liệu yêu cầu',
  405: 'Thao tác này không được hỗ trợ',
  408: 'Máy chủ phản hồi quá chậm, hãy thử lại',
  409: 'Dữ liệu đã thay đổi hoặc đang ở trạng thái không cho phép thao tác này',
  413: 'Dữ liệu gửi lên quá lớn',
  415: 'Định dạng dữ liệu không được hỗ trợ',
  422: 'Dữ liệu không hợp lệ',
  429: 'Thao tác quá nhanh, hãy đợi một lát rồi thử lại',
  500: 'Lỗi hệ thống, hãy thử lại sau; nếu còn lỗi, báo quản trị viên',
  502: 'Máy chủ tạm thời không phản hồi, hãy thử lại sau ít phút',
  503: 'Hệ thống đang bảo trì hoặc quá tải, hãy thử lại sau ít phút',
  504: 'Máy chủ phản hồi quá chậm, hãy thử lại sau',
};
export const statusText = (status: number): string =>
  STATUS_TEXT[status] ?? (status >= 500 ? STATUS_TEXT[500]! : status >= 400 ? STATUS_TEXT[400]! : `Lỗi không xác định (mã ${status})`);

// Mã lỗi chung (không phải nghiệp vụ). Mã nghiệp vụ mang thông báo tiếng Việt do máy chủ viết, giữ nguyên.
const CODE_TEXT: Record<string, string> = {
  NETWORK: 'Không kết nối được máy chủ',
  INTERNAL: STATUS_TEXT[500]!,
  UNAUTHENTICATED: STATUS_TEXT[401]!,
  FILE_TOO_LARGE: 'Tệp quá lớn, tối đa 20 MB',
  CONCURRENT_RETRY: 'Thao tác đồng thời bị xung đột, hãy thử lại',
};

export interface RawApiError { status: number; code: string; message?: string | undefined; details?: unknown }

/** Chữ hiển thị cho người dùng của một lỗi API. Không bao giờ trả về chữ tiếng Anh hay đường dẫn tham số thô. */
export function friendlyMessage({ status, code, message, details }: RawApiError): string {
  if (code === 'VALIDATION') {
    const issues = Array.isArray(details) ? details as Issue[] : undefined;
    if (issues?.length) return `Dữ liệu chưa hợp lệ. ${issuesText(issues)}`;
    const parsed = message && !isVietnamese(message) ? parseRawValidation(message) : null;
    if (parsed) return `Dữ liệu chưa hợp lệ. ${issuesText(parsed)}`;
    return isVietnamese(message) ? message : STATUS_TEXT[400]!;
  }
  if (CODE_TEXT[code]) return CODE_TEXT[code]!;
  if (code === 'FORBIDDEN') {
    const perm = /^Thiếu quyền (\S+)$/.exec(message ?? '');
    if (perm) return `Tài khoản chưa được cấp quyền thực hiện thao tác này (quyền ${perm[1]}). Nhờ quản trị viên cấp quyền`;
  }
  if (isVietnamese(message)) return message;
  return statusText(status);
}
