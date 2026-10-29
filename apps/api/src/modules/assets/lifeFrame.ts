import { isDepreciationFramesComplete, loadDepreciationFrames, type DepreciationFrame, type DepreciationFrameSet } from '@kt/coa-data';

// Gợi ý/cảnh báo thời gian sử dụng TSCĐ theo khung TT 45/2013/TT-BTC Phụ lục 1. Chỉ để tham khảo ở thẻ tài sản: không chặn lưu, không đổi cách tính khấu hao.
export type LifeFrameStatus = 'within' | 'below' | 'above' | 'not_applicable' | 'unavailable';
export interface LifeFrameCheck { status: LifeFrameStatus; frameCode: string | null; minMonths: number | null; maxMonths: number | null; message: string | null }

const yearsLabel = (months: number): string => (months % 12 === 0 ? `${months / 12} năm` : `${months} tháng`);

export function frameList(): (DepreciationFrameSet & { available: true }) | { available: false } {
  return isDepreciationFramesComplete() ? { ...loadDepreciationFrames(), available: true } : { available: false };
}

// at: ngày tra cứu (mặc định hôm nay), ngoài hiệu lực của khung thì không áp dụng. used: TSCĐ đã qua sử dụng, thời gian xác định theo Điều 10 khoản 2 nên khung không áp trực tiếp.
export function checkLifeAgainstFrame(frameCode: string, lifeMonths: number, at: string, used: boolean): LifeFrameCheck {
  const none = (status: LifeFrameStatus, message: string | null, f: DepreciationFrame | null = null): LifeFrameCheck =>
    ({ status, frameCode: f?.code ?? null, minMonths: f ? f.minYears * 12 : null, maxMonths: f ? f.maxYears * 12 : null, message });
  if (!isDepreciationFramesComplete()) return none('unavailable', null);
  const set = loadDepreciationFrames();
  const f = set.frames.find((x) => x.code === frameCode);
  if (!f) return none('unavailable', null);
  if (at < set.validFrom || (set.validTo !== null && at > set.validTo)) return none('not_applicable', `Khung thời gian của TT 45/2013/TT-BTC chỉ có hiệu lực đến ${set.validTo ?? 'khi có văn bản thay thế'}; ngày ${at} nằm ngoài, phần mềm không kiểm tra.`, f);
  if (used) return none('not_applicable', 'TSCĐ đã qua sử dụng: thời gian trích khấu hao xác định theo Điều 10 khoản 2 TT 45/2013/TT-BTC (giá trị hợp lý / giá TSCĐ mới cùng loại x thời gian của TSCĐ mới), không đối chiếu trực tiếp với khung.', f);
  const min = f.minYears * 12; const max = f.maxYears * 12;
  const where = `nhóm ${f.code} "${f.label}" (từ ${f.minYears} đến ${f.maxYears} năm)`;
  const tail = ' Muốn khác khung, doanh nghiệp phải lập phương án thay đổi thời gian trích khấu hao và giải trình (Điều 10 khoản 3 điểm a TT 45/2013/TT-BTC).';
  if (lifeMonths < min) return none('below', `Thời gian sử dụng ${yearsLabel(lifeMonths)} thấp hơn mức tối thiểu ${yearsLabel(min)} của ${where} theo Phụ lục 1 TT 45/2013/TT-BTC.${tail}`, f);
  if (lifeMonths > max) return none('above', `Thời gian sử dụng ${yearsLabel(lifeMonths)} cao hơn mức tối đa ${yearsLabel(max)} của ${where} theo Phụ lục 1 TT 45/2013/TT-BTC.${tail}`, f);
  return none('within', null, f);
}
