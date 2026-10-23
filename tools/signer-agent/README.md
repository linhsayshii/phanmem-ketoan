# signer-agent

Tiện ích ký số cục bộ tham chiếu. Xem giao thức và lưu ý ở `docs/dev/ky-so-cuc-bo.md`.

```bash
node index.mjs --key khoa.pem --cert chungthu.pem [--origin http://localhost:5173] [--port 18765] [--yes]
```

Khóa riêng không rời máy. Chỉ lắng nghe 127.0.0.1. `.pfx` phải đổi sang PEM trước. Chưa thử với USB token thật.
