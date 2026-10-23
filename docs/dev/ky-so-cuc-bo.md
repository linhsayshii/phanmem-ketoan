# Ký số XML: tiện ích ký cục bộ và VNPT SmartCA

Tờ khai (và các XML khác về sau) được ký theo XML-DSig/XAdES (RSA-SHA256, `X509Data`, `SigningTime`, tham chiếu `SignedProperties`) theo QĐ 1233. Máy chủ không bao giờ giữ khóa riêng: máy chủ dựng XML, chuẩn hóa C14N `SignedInfo`, tính SHA-256 rồi gửi **chỉ giá trị băm** cho bên ký.

## Luồng phiên ký

1. `POST /api/signing/sessions` `{docKind:'vat_return', docRef, profileId}` tạo phiên (hết hạn sau 10 phút), trả `digestB64`, `mode`.
2. Chế độ `client` (tiện ích cục bộ): trình duyệt gọi `POST {agentUrl}/v1/sign`, rồi `POST /api/signing/sessions/:id/complete {signatureB64}`. Máy chủ kiểm chữ ký với chứng thư của hồ sơ (400 `SIGNATURE_INVALID` nếu sai) và từ chối chứng thư quá hạn.
3. Chế độ `server` (SmartCA, giả lập): trình duyệt gọi `POST /api/signing/sessions/:id/poll` định kỳ tới khi `status = signed`.
4. `GET /api/tax/vat-returns/:id/xml?signedSession=...` trả XML đã ký (tên tệp thêm `_signed`).

Mỗi người dùng chỉ thấy hồ sơ và phiên của chính mình. Phiên không ghi nhật ký kiểm toán vì chứa toàn bộ XML; hồ sơ ghi nhật ký với cột `credentials` và `cert_der` bị che.

## Giao thức tiện ích cục bộ

Tiện ích tham chiếu: `tools/signer-agent/index.mjs`, chỉ dùng module `node:`.

```bash
node tools/signer-agent/index.mjs --key khoa.pem --cert chungthu.pem --origin http://localhost:5173
```

- Lắng nghe `127.0.0.1:18765`. Từ chối `Host` khác `127.0.0.1`/`localhost` (chống DNS rebinding).
- CORS chỉ cho đúng `--origin` (mặc định `WEB_ORIGIN`), có `Access-Control-Allow-Private-Network`. Nguồn lạ bị 403.
- `GET /v1/certificates` trả `[{serial, subject, notAfter, certB64}]`.
- `POST /v1/sign` `{certSerial, digestB64, algorithm:'RSA-SHA256'}` trả `{signatureB64}`. Mỗi lần ký hỏi y/n ở cửa sổ dòng lệnh; `--yes` bỏ hỏi (chỉ để kiểm thử). Từ chối trả `USER_DECLINED`.
- Chữ ký là RSASSA-PKCS1-v1_5 trên DigestInfo SHA-256 (tiền tố `3031300d060960864801650304020105000420` + băm).

Tiện ích đọc khóa và chứng thư dạng PEM, vì `node:crypto` không đọc `.pfx`. Đổi: `openssl pkcs12 -in a.pfx -nodes -out a.pem`, rồi tách khối `PRIVATE KEY` và `CERTIFICATE` thành hai tệp.

**Chưa thử với USB token thật.** Token cần thư viện PKCS#11 của hãng; nhà phát triển có thể viết tiện ích riêng theo cùng giao thức trên.

## VNPT SmartCA (ký từ xa)

Bộ chuyển đổi `apps/api/src/modules/signing/providers/smartca.ts` theo `docs/dev/tich-hop/ngan-hang.md` mục 7 (`get_certificate`, `signatures/sign`, `sign/{tran}/status`). **Chưa thử trên môi trường thật**; kiểm thử dùng máy chủ giả. Thông tin dịch vụ được mã hóa bằng `sealSecret`, không trả về và không ghi nhật ký.

## Hồ sơ giả lập

Loại `fake` ký bằng khóa thử công khai, chỉ cho môi trường không phải sản xuất.
