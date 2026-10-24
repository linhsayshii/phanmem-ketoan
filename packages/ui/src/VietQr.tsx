import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { formatVnNumber } from '@kt/domain';

export interface VietQrProps {
  payload: string; bankName?: string | undefined; accountNo?: string | undefined; accountName?: string | null | undefined; amount?: string | undefined; content?: string | undefined; size?: number;
}
// Mã VietQR vẽ bằng canvas; thông tin thụ hưởng, số tiền, nội dung hiện dưới mã để người trả đối chiếu.
export function VietQr({ payload, bankName, accountNo, accountName, amount, content, size = 240 }: VietQrProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!ref.current) return;
    QRCode.toCanvas(ref.current, payload, { width: size, margin: 1, errorCorrectionLevel: 'M' }).then(() => setErr(''), (e: Error) => setErr(e.message));
  }, [payload, size]);
  return (
    <div style={{ textAlign: 'center' }} data-testid="vietqr">
      {err ? <div role="alert">Không vẽ được mã QR: {err}</div> : <canvas ref={ref} aria-label="Mã QR thanh toán" style={{ width: size, height: size }} />}
      <div style={{ marginTop: 8, lineHeight: 1.6 }}>
        {bankName && <div><b>{bankName}</b></div>}
        {accountNo && <div>STK: {accountNo}{accountName ? ` – ${accountName}` : ''}</div>}
        {amount && <div>Số tiền: <b>{formatVnNumber(amount)}</b> đồng</div>}
        {content && <div>Nội dung: {content}</div>}
      </div>
    </div>
  );
}
