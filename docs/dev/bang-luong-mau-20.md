# Bảng lương mẫu 20 nhân viên: tính tay độc lập

> **Dữ liệu minh họa — không phải văn bản pháp lý.** Mọi tham số dưới đây là *Dữ liệu minh họa của dữ liệu mẫu — chưa đối chiếu văn bản gốc*. Phần lớn lấy từ bảng nghiên cứu sơ bộ ở đặc tả mục 10 (`docs/superpowers/specs/2026-10-19-phan-mem-ke-toan-design.md`); các giá trị đặc tả không có được ghi rõ là *giả định minh họa*. Phần mềm không có giá trị pháp lý mặc định: doanh nghiệp tự nhập tham số kèm nguồn văn bản (GĐ6 Quy ước 1, quyết định #600).

Mục đích: tiêu chí nghiệm thu GĐ6 "bảng lương mẫu 20 nhân viên khớp tính tay". Mọi số dưới đây tính bằng tay theo công thức viết lại từ tham số, không gọi hàm của mã; được kiểm lại bằng một script Decimal riêng ngoài repo (không import mã sản phẩm). Kết quả nhập tay vào `apps/api/test/fixtures/payroll-20.json`; kiểm thử `packages/domain/test/payroll.test.ts` so động cơ với tệp đó từng cột từng người.

## 1. Tham số minh họa (kỳ lương tháng 10/2026)

| Mã tham số | Giá trị minh họa | Lấy từ |
|---|---|---|
| `pit_brackets` (tháng) | ≤ 10.000.000: 5%; ≤ 30.000.000: 10%; ≤ 60.000.000: 20%; ≤ 100.000.000: 30%; trên: 35% | đặc tả mục 10 (TNCN 5 bậc, mốc 10/30/60/100 triệu/tháng) |
| `pit_brackets_annual` (quyết toán) | ≤ 120.000.000: 5%; ≤ 360.000.000: 10%; ≤ 720.000.000: 20%; ≤ 1.200.000.000: 30%; trên: 35% | giả định minh họa: 12 lần mốc tháng (phần mềm không tự suy, nhập riêng) |
| `pit_deduction` | bản thân 15.500.000; người phụ thuộc 6.200.000 / tháng | đặc tả mục 10 |
| `si_rates` NLĐ | BHXH 8%; BHYT 1,5%; BHTN 1% (cộng 10,5%) | đặc tả mục 10 |
| `si_rates` NSDLĐ | BHXH 17% (14 + 3); BHYT 3%; BHTN 1%; TNLĐ-BNN 0,5% (cộng 21,5%) | đặc tả mục 10 |
| `si_ceiling.si_base_max` | 50.600.000 (BHXH, BHYT) | đặc tả mục 10 (từ 01/07/2026) |
| `si_ceiling.ui_base_max_multiple_of_min_wage` | 20 × lương tối thiểu vùng I = 20 × 5.310.000 = **106.200.000** (BHTN) | giả định minh họa (bội số 20); lương tối thiểu vùng từ đặc tả mục 10 |
| `si_floor.si_base_min` | 5.310.000 | giả định minh họa: bằng lương tối thiểu vùng I của đặc tả mục 10 |
| `min_wage_region` | I 5.310.000; II 4.730.000; III 4.140.000; IV 3.700.000 | đặc tả mục 10 |
| `ot_multipliers` | ngày thường 1,5; ngày nghỉ hằng tuần 2; ngày lễ 3 | đặc tả mục 10 (150/200/300%) |
| `ot_tax_exempt_extra` | có (phần trả cao hơn giờ làm việc bình thường không chịu thuế) | giả định minh họa |
| `pit_non_resident_rate` | 20% | giả định minh họa (đặc tả mục 10 không có) |
| `pit_flat_rate_no_contract` | 10% | giả định minh họa (đặc tả mục 10 không có) |

Cài đặt công ty (không phải pháp lý): ngày công chuẩn 26 ngày/tháng (`standard_26`), 8 giờ/ngày; mọi nhân viên vùng I.

## 2. Quy tắc tính (viết lại để tính tay)

1. **Lương theo ngày công** = Σ (lương tháng của đoạn × ngày công hưởng lương của đoạn) ÷ 26. Cộng tử số rồi chia một lần; làm tròn đồng nửa lên một lần ở cuối.
2. **Đơn giá giờ** = lương tháng cuối kỳ ÷ 26 ÷ 8 (không làm tròn). **Tiền làm thêm** = đơn giá × (giờ ngày thường × 1,5 + giờ ngày nghỉ × 2 + giờ lễ × 3). **Phần không chịu thuế** = đơn giá × (giờ ngày thường × 0,5 + giờ ngày nghỉ × 1 + giờ lễ × 2). Mỗi số làm tròn đồng một lần.
3. **Tổng thu nhập (gross)** = lương theo ngày công + phụ cấp + tiền làm thêm + thu nhập khác (Thưởng).
4. **Lương đóng bảo hiểm** = mức lương đóng BH ghi trong hồ sơ (không ghi thì lương tháng cuối kỳ) + phụ cấp có tính BH. Mức đóng BHXH/BHYT = min(max(lương đóng; sàn 5.310.000); trần 50.600.000); mức đóng BHTN = min(max(lương đóng; 5.310.000); 106.200.000). Không tham gia bảo hiểm thì mức đóng 0.
5. **Bảo hiểm** từng loại = tỷ lệ × mức đóng, làm tròn đồng từng loại (NLĐ: BHXH, BHYT, BHTN; NSDLĐ: BHXH, BHYT, BHTN, TNLĐ-BNN; BHTN dùng mức đóng BHTN).
6. **Thu nhập chịu thuế** = gross − phụ cấp không chịu thuế − phần làm thêm không chịu thuế.
7. Cư trú, hợp đồng từ 3 tháng: **Thu nhập tính thuế** = max(0; thu nhập chịu thuế − giảm trừ bản thân − số người phụ thuộc có hiệu lực trong tháng × 6.200.000 − bảo hiểm bắt buộc NLĐ − giảm trừ khác). **TNCN** = lũy tiến từng bậc, làm tròn đồng một lần ở cuối.
8. Không cư trú: TNCN = 20% × thu nhập chịu thuế. Hợp đồng dưới 3 tháng: TNCN = 10% × thu nhập chịu thuế. Không có giảm trừ.
9. **Khấu trừ khác** = tạm ứng + đóng góp từ thiện trừ qua lương. **Thực lĩnh** = gross − BH NLĐ − TNCN − khấu trừ khác.
10. Người phụ thuộc tính theo **tháng**: có hiệu lực từ ngày bất kỳ trong tháng thì được tính cả tháng đó; hết hiệu lực từ tháng trước thì không tính.

Thuế lũy tiến tháng tại các mốc: 10.000.000 → 500.000; 30.000.000 → 500.000 + 2.000.000 = 2.500.000; 60.000.000 → 2.500.000 + 6.000.000 = 8.500.000; 100.000.000 → 8.500.000 + 12.000.000 = 20.500.000.

## 3. Tính từng nhân viên

Viết tắt: NLĐ = người lao động, DN = người sử dụng lao động, NPT = người phụ thuộc, TNTT = thu nhập tính thuế. Bảo hiểm DN theo thứ tự BHXH 17% / BHYT 3% / BHTN 1% / TNLĐ 0,5%.

### NV01 Nguyễn Văn An — thu nhập thấp hơn giảm trừ
- Đầu vào: lương 10.000.000, 26 công, tham gia đủ bảo hiểm, không NPT.
- Lương theo công = 10.000.000 × 26 ÷ 26 = 10.000.000. Gross = 10.000.000.
- Mức đóng = 10.000.000 (BHTN 10.000.000).
- BH NLĐ: 800.000 + 150.000 + 100.000 = 1.050.000. BH DN: 1.700.000 + 300.000 + 100.000 + 50.000 = 2.150.000.
- Thu nhập chịu thuế 10.000.000. Giảm trừ: 15.500.000 + 0 + 1.050.000 = 16.550.000. TNTT = max(0; 10.000.000 − 16.550.000) = 0. TNCN = 0.
- Thực lĩnh = 10.000.000 − 1.050.000 − 0 = **8.950.000**.

### NV02 Trần Thị Bình — đúng mốc bậc 1 (10.000.000)
- Đầu vào: lương 26.550.000, 26 công, lương đóng BH 10.000.000, không NPT.
- Lương theo công = 26.550.000. Gross = 26.550.000.
- Mức đóng 10.000.000. BH NLĐ 800.000 + 150.000 + 100.000 = 1.050.000. BH DN 2.150.000.
- Thu nhập chịu thuế 26.550.000. TNTT = 26.550.000 − 15.500.000 − 1.050.000 = 10.000.000.
- TNCN: bậc 1 10.000.000 × 5% = 500.000. TNCN = **500.000**.
- Thực lĩnh = 26.550.000 − 1.050.000 − 500.000 = **25.000.000**.

### NV03 Lê Văn Cường — đúng mốc bậc 2 (30.000.000)
- Đầu vào: lương 40.000.000, 26 công, lương đóng BH 20.000.000, phụ cấp trách nhiệm 7.600.000 (chịu thuế, không tính BH), không NPT.
- Lương theo công = 40.000.000; phụ cấp 7.600.000. Gross = 47.600.000.
- Mức đóng 20.000.000. BH NLĐ 1.600.000 + 300.000 + 200.000 = 2.100.000. BH DN 3.400.000 + 600.000 + 200.000 + 100.000 = 4.300.000.
- Thu nhập chịu thuế 47.600.000. TNTT = 47.600.000 − 15.500.000 − 2.100.000 = 30.000.000.
- TNCN: 10.000.000 × 5% = 500.000; 20.000.000 × 10% = 2.000.000; cộng **2.500.000**.
- Thực lĩnh = 47.600.000 − 2.100.000 − 2.500.000 = **43.000.000**.

### NV04 Phạm Thị Dung — đúng mốc bậc 3 (60.000.000), 1 NPT
- Đầu vào: lương 84.850.000, 26 công, lương đóng BH 30.000.000, 1 NPT (từ 01/2026).
- Gross = 84.850.000.
- Mức đóng 30.000.000. BH NLĐ 2.400.000 + 450.000 + 300.000 = 3.150.000. BH DN 5.100.000 + 900.000 + 300.000 + 150.000 = 6.450.000.
- TNTT = 84.850.000 − 15.500.000 − 6.200.000 − 3.150.000 = 60.000.000.
- TNCN: 500.000 + 2.000.000 + 30.000.000 × 20% = 6.000.000 → **8.500.000**.
- Thực lĩnh = 84.850.000 − 3.150.000 − 8.500.000 = **73.200.000**.

### NV05 Hoàng Văn Em — đúng mốc bậc 4 (100.000.000), lương đóng vượt trần BHXH, dưới trần BHTN, 2 NPT
- Đầu vào: lương 120.000.000, 26 công, lương đóng BH 80.000.000, phụ cấp chịu thuế 13.507.000 (không tính BH), 2 NPT.
- Gross = 120.000.000 + 13.507.000 = 133.507.000.
- Mức đóng BHXH/BHYT = min(80.000.000; 50.600.000) = 50.600.000; BHTN = min(80.000.000; 106.200.000) = 80.000.000.
- BH NLĐ: 8% × 50.600.000 = 4.048.000; 1,5% × 50.600.000 = 759.000; 1% × 80.000.000 = 800.000; cộng 5.607.000.
- BH DN: 17% × 50.600.000 = 8.602.000; 3% × 50.600.000 = 1.518.000; 1% × 80.000.000 = 800.000; 0,5% × 50.600.000 = 253.000; cộng 11.173.000.
- TNTT = 133.507.000 − 15.500.000 − 12.400.000 − 5.607.000 = 100.000.000.
- TNCN: 500.000 + 2.000.000 + 6.000.000 + 40.000.000 × 30% = 12.000.000 → **20.500.000**.
- Thực lĩnh = 133.507.000 − 5.607.000 − 20.500.000 = **107.400.000**.

### NV06 Vũ Thị Giang — bậc 5, vượt cả trần BHTN
- Đầu vào: lương 150.000.000, 26 công, không ghi lương đóng BH (lấy lương), không NPT.
- Gross = 150.000.000. Mức đóng BHXH/BHYT 50.600.000; BHTN = min(150.000.000; 106.200.000) = 106.200.000.
- BH NLĐ: 4.048.000 + 759.000 + 1.062.000 = 5.869.000. BH DN: 8.602.000 + 1.518.000 + 1.062.000 + 253.000 = 11.435.000.
- TNTT = 150.000.000 − 15.500.000 − 5.869.000 = 128.631.000.
- TNCN: 20.500.000 + (128.631.000 − 100.000.000) × 35% = 20.500.000 + 10.020.850 = **30.520.850**.
- Thực lĩnh = 150.000.000 − 5.869.000 − 30.520.850 = **113.610.150**.

### NV07 Đặng Văn Hải — vừa qua mốc bậc 3, làm tròn nửa lên
- Đầu vào: lương 70.000.000, 26 công, lương đóng BH 10.000.000, Thưởng (cột nhập tay) 6.550.005, không NPT.
- Gross = 70.000.000 + 6.550.005 = 76.550.005. BH NLĐ 1.050.000; BH DN 2.150.000.
- TNTT = 76.550.005 − 15.500.000 − 1.050.000 = 60.000.005.
- TNCN: 8.500.000 + 5 × 30% = 8.500.000 + 1,5 = 8.500.001,5 → làm tròn nửa lên **8.500.002**.
- Thực lĩnh = 76.550.005 − 1.050.000 − 8.500.002 = **67.000.003**.

### NV08 Bùi Thị Hoa — NPT có hiệu lực từ giữa tháng, NPT khác đã hết
- Đầu vào: lương 30.000.000, 26 công; NPT A đăng ký từ 15/10/2026 (tính cả tháng 10); NPT B từ 01/2025 đến 09/2026 (không tính tháng 10). Số NPT tháng 10 = 1.
- Gross 30.000.000. Mức đóng 30.000.000. BH NLĐ 3.150.000; BH DN 6.450.000.
- TNTT = 30.000.000 − 15.500.000 − 6.200.000 − 3.150.000 = 5.150.000.
- TNCN = 5.150.000 × 5% = **257.500**.
- Thực lĩnh = 30.000.000 − 3.150.000 − 257.500 = **26.592.500**.

### NV09 Đỗ Văn Khoa — lương đóng dưới sàn
- Đầu vào: lương 4.000.000, 26 công, tham gia bảo hiểm.
- Gross 4.000.000. Mức đóng = max(4.000.000; 5.310.000) = 5.310.000 (cả BHTN).
- BH NLĐ: 8% × 5.310.000 = 424.800; 1,5% = 79.650; 1% = 53.100; cộng 557.550.
- BH DN: 17% = 902.700; 3% = 159.300; 1% = 53.100; 0,5% = 26.550; cộng 1.141.650.
- TNTT = max(0; 4.000.000 − 15.500.000 − 557.550) = 0. TNCN 0.
- Thực lĩnh = 4.000.000 − 557.550 = **3.442.450**.

### NV10 Ngô Thị Lan — vào làm giữa tháng (15/10), có nửa ngày công
- Đầu vào: lương 18.000.000, 17,5 công hưởng lương, tham gia bảo hiểm (doanh nghiệp đăng ký từ tháng 10).
- Lương theo công = 18.000.000 × 17,5 ÷ 26 = 315.000.000 ÷ 26 = 12.115.384,615… → **12.115.385**. Gross = 12.115.385.
- Mức đóng 18.000.000 (lương hợp đồng). BH NLĐ 1.440.000 + 270.000 + 180.000 = 1.890.000. BH DN 3.060.000 + 540.000 + 180.000 + 90.000 = 3.870.000.
- TNTT = max(0; 12.115.385 − 15.500.000 − 1.890.000) = 0. TNCN 0.
- Thực lĩnh = 12.115.385 − 1.890.000 = **10.225.385**.

### NV11 Dương Văn Minh — nghỉ việc giữa tháng (09/10), có tạm ứng
- Đầu vào: lương 22.000.000, 7 công; doanh nghiệp không đóng bảo hiểm tháng nghỉ việc (hồ sơ đánh dấu không tham gia tháng này); tạm ứng trừ lương 1.000.000.
- Lương theo công = 22.000.000 × 7 ÷ 26 = 154.000.000 ÷ 26 = 5.923.076,923… → **5.923.077**. Gross 5.923.077.
- Bảo hiểm 0 (không tham gia).
- TNTT = max(0; 5.923.077 − 15.500.000) = 0. TNCN 0.
- Khấu trừ khác 1.000.000. Thực lĩnh = 5.923.077 − 0 − 0 − 1.000.000 = **4.923.077**.

### NV12 Lý Thị Ngọc — đổi lương giữa tháng (hai đoạn)
- Đầu vào: 01–15/10 lương 20.000.000, 11 công; 16–31/10 lương 24.000.000, 15 công. Không ghi lương đóng BH (lấy lương cuối kỳ 24.000.000).
- Lương theo công = (20.000.000 × 11 + 24.000.000 × 15) ÷ 26 = (220.000.000 + 360.000.000) ÷ 26 = 580.000.000 ÷ 26 = 22.307.692,307… → **22.307.692**.
- Mức đóng 24.000.000. BH NLĐ 1.920.000 + 360.000 + 240.000 = 2.520.000. BH DN 4.080.000 + 720.000 + 240.000 + 120.000 = 5.160.000.
- TNTT = 22.307.692 − 15.500.000 − 2.520.000 = 4.287.692. TNCN = 4.287.692 × 5% = 214.384,6 → **214.385**.
- Thực lĩnh = 22.307.692 − 2.520.000 − 214.385 = **19.573.307**.

### NV13 Mai Văn Phúc — làm thêm ngày thường, ngày nghỉ, ngày lễ
- Đầu vào: lương 26.000.000, 26 công; làm thêm 10 giờ ngày thường, 8 giờ ngày nghỉ hằng tuần, 4 giờ ngày lễ.
- Đơn giá giờ = 26.000.000 ÷ 26 ÷ 8 = 125.000.
- Tiền làm thêm = 125.000 × (10 × 1,5 + 8 × 2 + 4 × 3) = 125.000 × 43 = **5.375.000**.
- Không chịu thuế = 125.000 × (10 × 0,5 + 8 × 1 + 4 × 2) = 125.000 × 21 = **2.625.000**.
- Gross = 26.000.000 + 5.375.000 = 31.375.000. Mức đóng 26.000.000 (tiền làm thêm không tính BH). BH NLĐ 2.080.000 + 390.000 + 260.000 = 2.730.000. BH DN 4.420.000 + 780.000 + 260.000 + 130.000 = 5.590.000.
- Thu nhập chịu thuế = 31.375.000 − 2.625.000 = 28.750.000. TNTT = 28.750.000 − 15.500.000 − 2.730.000 = 10.520.000.
- TNCN = 500.000 + 520.000 × 10% = 500.000 + 52.000 = **552.000**.
- Thực lĩnh = 31.375.000 − 2.730.000 − 552.000 = **28.093.000**.

### NV14 Trịnh Thị Quỳnh — làm thêm với đơn giá giờ lẻ, phụ cấp không chịu thuế
- Đầu vào: lương 15.000.000, 26 công; làm thêm 7,5 giờ ngày thường, 3 giờ ngày lễ; phụ cấp ăn trưa 730.000 (không chịu thuế, không tính BH).
- Đơn giá giờ = 15.000.000 ÷ 208 = 72.115,384615… (giữ nguyên, không làm tròn).
- Tiền làm thêm = 15.000.000 × (7,5 × 1,5 + 3 × 3) ÷ 208 = 15.000.000 × 20,25 ÷ 208 = 303.750.000 ÷ 208 = 1.460.336,538… → **1.460.337**.
- Không chịu thuế = 15.000.000 × (7,5 × 0,5 + 3 × 2) ÷ 208 = 15.000.000 × 9,75 ÷ 208 = 146.250.000 ÷ 208 = **703.125**.
- Gross = 15.000.000 + 730.000 + 1.460.337 = 17.190.337. BH NLĐ 1.200.000 + 225.000 + 150.000 = 1.575.000. BH DN 2.550.000 + 450.000 + 150.000 + 75.000 = 3.225.000.
- Thu nhập chịu thuế = 17.190.337 − 730.000 − 703.125 = 15.757.212. TNTT = max(0; 15.757.212 − 15.500.000 − 1.575.000) = 0. TNCN 0.
- Thực lĩnh = 17.190.337 − 1.575.000 = **15.615.337**.

### NV15 John Smith — cá nhân không cư trú
- Đầu vào: lương 40.000.000, 26 công, phụ cấp chịu thuế 2.000.000; không tham gia bảo hiểm.
- Gross = 42.000.000. Bảo hiểm 0.
- Thu nhập chịu thuế 42.000.000; không giảm trừ. TNCN = 20% × 42.000.000 = **8.400.000**. (Cột thu nhập tính thuế ghi 42.000.000: cơ sở áp thuế suất toàn phần.)
- Thực lĩnh = 42.000.000 − 8.400.000 = **33.600.000**.

### NV16 Tạ Văn Sơn — hợp đồng dưới 3 tháng, khấu trừ tỷ lệ cố định
- Đầu vào: lương 8.000.000, 20 công, không tham gia bảo hiểm.
- Lương theo công = 8.000.000 × 20 ÷ 26 = 160.000.000 ÷ 26 = 6.153.846,153… → **6.153.846**.
- TNCN = 10% × 6.153.846 = 615.384,6 → **615.385** (không giảm trừ).
- Thực lĩnh = 6.153.846 − 615.385 = **5.538.461**.

### NV17 Cao Thị Trang — phụ cấp hỗn hợp (tính BH, chịu thuế, không chịu thuế), 1 NPT
- Đầu vào: lương 25.000.000, 26 công; phụ cấp trách nhiệm 2.000.000 (chịu thuế, tính BH); phụ cấp xăng xe 1.000.000 (chịu thuế, không tính BH); ăn trưa 730.000 (không chịu thuế); 1 NPT.
- Phụ cấp = 3.730.000. Gross = 28.730.000.
- Lương đóng = 25.000.000 + 2.000.000 = 27.000.000. BH NLĐ 2.160.000 + 405.000 + 270.000 = 2.835.000. BH DN 4.590.000 + 810.000 + 270.000 + 135.000 = 5.805.000.
- Thu nhập chịu thuế = 28.730.000 − 730.000 = 28.000.000. TNTT = 28.000.000 − 15.500.000 − 6.200.000 − 2.835.000 = 3.465.000.
- TNCN = 3.465.000 × 5% = **173.250**.
- Thực lĩnh = 28.730.000 − 2.835.000 − 173.250 = **25.721.750**.

### NV18 Lâm Văn Tuấn — giảm trừ khác (đóng góp từ thiện trừ qua lương)
- Đầu vào: lương 35.000.000, 26 công; cột "Đóng góp từ thiện, quỹ hưu trí tự nguyện" 1.000.000 (vừa là giảm trừ khác khi tính thuế, vừa trừ vào lương).
- Gross 35.000.000. BH NLĐ 2.800.000 + 525.000 + 350.000 = 3.675.000. BH DN 5.950.000 + 1.050.000 + 350.000 + 175.000 = 7.525.000.
- TNTT = 35.000.000 − 15.500.000 − 3.675.000 − 1.000.000 = 14.825.000.
- TNCN = 500.000 + 4.825.000 × 10% = 500.000 + 482.500 = **982.500**.
- Khấu trừ khác 1.000.000. Thực lĩnh = 35.000.000 − 3.675.000 − 982.500 − 1.000.000 = **29.342.500**.

### NV19 Hồ Thị Uyên — thu nhập đúng bằng giảm trừ
- Đầu vào: lương 16.550.000, 26 công, lương đóng BH 10.000.000.
- Gross 16.550.000. BH NLĐ 1.050.000; BH DN 2.150.000.
- TNTT = 16.550.000 − 15.500.000 − 1.050.000 = 0. TNCN 0.
- Thực lĩnh = 16.550.000 − 1.050.000 = **15.500.000**.

### NV20 Quách Văn Vinh — người được quyết toán năm (mục 5), tháng 10
- Đầu vào: lương 45.000.000, 26 công; NPT 1 từ 01/2026, NPT 2 từ 08/2026 → tháng 10 có 2 NPT.
- Gross 45.000.000. BH NLĐ 3.600.000 + 675.000 + 450.000 = 4.725.000. BH DN 7.650.000 + 1.350.000 + 450.000 + 225.000 = 9.675.000.
- TNTT = 45.000.000 − 15.500.000 − 12.400.000 − 4.725.000 = 12.375.000.
- TNCN = 500.000 + 2.375.000 × 10% = 500.000 + 237.500 = **737.500**.
- Thực lĩnh = 45.000.000 − 4.725.000 − 737.500 = **39.537.500**.

## 4. Tổng bảng lương tháng 10/2026

| Mã | Gross | BH NLĐ | BH DN | TNCN | Khấu trừ khác | Thực lĩnh |
|---|---:|---:|---:|---:|---:|---:|
| NV01 | 10.000.000 | 1.050.000 | 2.150.000 | 0 | 0 | 8.950.000 |
| NV02 | 26.550.000 | 1.050.000 | 2.150.000 | 500.000 | 0 | 25.000.000 |
| NV03 | 47.600.000 | 2.100.000 | 4.300.000 | 2.500.000 | 0 | 43.000.000 |
| NV04 | 84.850.000 | 3.150.000 | 6.450.000 | 8.500.000 | 0 | 73.200.000 |
| NV05 | 133.507.000 | 5.607.000 | 11.173.000 | 20.500.000 | 0 | 107.400.000 |
| NV06 | 150.000.000 | 5.869.000 | 11.435.000 | 30.520.850 | 0 | 113.610.150 |
| NV07 | 76.550.005 | 1.050.000 | 2.150.000 | 8.500.002 | 0 | 67.000.003 |
| NV08 | 30.000.000 | 3.150.000 | 6.450.000 | 257.500 | 0 | 26.592.500 |
| NV09 | 4.000.000 | 557.550 | 1.141.650 | 0 | 0 | 3.442.450 |
| NV10 | 12.115.385 | 1.890.000 | 3.870.000 | 0 | 0 | 10.225.385 |
| NV11 | 5.923.077 | 0 | 0 | 0 | 1.000.000 | 4.923.077 |
| NV12 | 22.307.692 | 2.520.000 | 5.160.000 | 214.385 | 0 | 19.573.307 |
| NV13 | 31.375.000 | 2.730.000 | 5.590.000 | 552.000 | 0 | 28.093.000 |
| NV14 | 17.190.337 | 1.575.000 | 3.225.000 | 0 | 0 | 15.615.337 |
| NV15 | 42.000.000 | 0 | 0 | 8.400.000 | 0 | 33.600.000 |
| NV16 | 6.153.846 | 0 | 0 | 615.385 | 0 | 5.538.461 |
| NV17 | 28.730.000 | 2.835.000 | 5.805.000 | 173.250 | 0 | 25.721.750 |
| NV18 | 35.000.000 | 3.675.000 | 7.525.000 | 982.500 | 1.000.000 | 29.342.500 |
| NV19 | 16.550.000 | 1.050.000 | 2.150.000 | 0 | 0 | 15.500.000 |
| NV20 | 45.000.000 | 4.725.000 | 9.675.000 | 737.500 | 0 | 39.537.500 |
| **Cộng** | **825.402.342** | **44.583.550** | **90.399.650** | **82.953.372** | **2.000.000** | **695.865.420** |

Kiểm: 825.402.342 − 44.583.550 − 82.953.372 − 2.000.000 = 695.865.420.

## 5. Bảng lương phụ (thưởng) tháng 12/2026 của NV20

Bảng lương chính tháng 12 của NV20 giống tháng 10: thu nhập chịu thuế 45.000.000, BH NLĐ 4.725.000, TNCN đã khấu trừ 737.500. Bảng lương phụ (loại `bonus`) chỉ có Thưởng Tết 30.000.000, không đóng bảo hiểm. TNCN tháng tính trên tổng các bảng của tháng trừ phần đã khấu trừ (GĐ6 D12):
- Thu nhập chịu thuế cả tháng = 45.000.000 + 30.000.000 = 75.000.000.
- TNTT cả tháng = 75.000.000 − 15.500.000 − 12.400.000 − 4.725.000 = 42.375.000.
- TNCN cả tháng = 500.000 + 2.000.000 + 12.375.000 × 20% = 500.000 + 2.000.000 + 2.475.000 = 4.975.000.
- TNCN của bảng thưởng = 4.975.000 − 737.500 = **4.237.500**. Thực lĩnh thưởng = 30.000.000 − 4.237.500 = **25.762.500**.

## 6. Quyết toán thuế TNCN năm 2026 của NV20 (12 tháng, thu nhập thay đổi)

Tham số minh họa giữ nguyên cả năm (kể cả nửa đầu năm, chỉ để minh họa phép tính). Lương: tháng 1–6 30.000.000; tháng 7–9 40.000.000; tháng 10–12 45.000.000; tháng 12 thêm thưởng 30.000.000 (mục 5). BH NLĐ = 10,5% × lương. NPT: 1 người tháng 1–7, 2 người tháng 8–12.

| Tháng | Thu nhập chịu thuế | BH NLĐ | NPT | TNTT tháng | TNCN đã khấu trừ |
|---|---:|---:|---:|---:|---:|
| 1–6 (mỗi tháng) | 30.000.000 | 3.150.000 | 1 | 30.000.000 − 15.500.000 − 6.200.000 − 3.150.000 = 5.150.000 | 5% × 5.150.000 = 257.500 |
| 7 | 40.000.000 | 4.200.000 | 1 | 40.000.000 − 15.500.000 − 6.200.000 − 4.200.000 = 14.100.000 | 500.000 + 4.100.000 × 10% = 910.000 |
| 8, 9 (mỗi tháng) | 40.000.000 | 4.200.000 | 2 | 40.000.000 − 15.500.000 − 12.400.000 − 4.200.000 = 7.900.000 | 5% × 7.900.000 = 395.000 |
| 10, 11 (mỗi tháng) | 45.000.000 | 4.725.000 | 2 | 12.375.000 | 737.500 |
| 12 | 75.000.000 | 4.725.000 | 2 | 42.375.000 | 737.500 + 4.237.500 = 4.975.000 |

Cả năm:
- Thu nhập chịu thuế = 6 × 30.000.000 + 3 × 40.000.000 + 2 × 45.000.000 + 75.000.000 = 180.000.000 + 120.000.000 + 90.000.000 + 75.000.000 = 465.000.000.
- Giảm trừ bản thân = 12 × 15.500.000 = 186.000.000 (12 tháng tính giảm trừ bản thân là đầu vào của quyết toán, không suy).
- Giảm trừ NPT: số tháng-người = 7 × 1 + 5 × 2 = 17; 17 × 6.200.000 = 105.400.000.
- Bảo hiểm bắt buộc = 6 × 3.150.000 + 3 × 4.200.000 + 3 × 4.725.000 = 18.900.000 + 12.600.000 + 14.175.000 = 45.675.000.
- TNTT năm = 465.000.000 − 186.000.000 − 105.400.000 − 45.675.000 = 127.925.000.
- Thuế năm theo biểu năm: 120.000.000 × 5% = 6.000.000; 7.925.000 × 10% = 792.500; cộng **6.792.500**.
- Đã khấu trừ = 6 × 257.500 + 910.000 + 2 × 395.000 + 2 × 737.500 + 4.975.000 = 1.545.000 + 910.000 + 790.000 + 1.475.000 + 4.975.000 = **9.695.000**.
- Chênh lệch = 6.792.500 − 9.695.000 = **−2.902.500**: nộp thừa, hoàn (hoặc bù trừ) cho người lao động 2.902.500.
- Kiểm chéo: Σ TNTT tháng = 6 × 5.150.000 + 14.100.000 + 2 × 7.900.000 + 2 × 12.375.000 + 42.375.000 = 30.900.000 + 14.100.000 + 15.800.000 + 24.750.000 + 42.375.000 = 127.925.000 (khớp TNTT năm). Thuế năm thấp hơn tổng khấu trừ tháng vì thu nhập dồn ở tháng 12 rơi vào bậc 20% khi tính theo tháng nhưng chỉ ở bậc 10% khi tính theo năm.

## 7. Hạn chế của mẫu
- Không có ngưỡng không khấu trừ của hợp đồng dưới 3 tháng (tham số chưa có): khấu trừ tỷ lệ cố định trên toàn bộ thu nhập chịu thuế.
- Quy tắc "làm dưới nửa tháng không đóng bảo hiểm" không tự áp dụng: hồ sơ/bảng lương đánh dấu tham gia hay không (NV11).
- Kinh phí công đoàn và đoàn phí có trong động cơ (tham số `si_rates.employer.union`, `union_fee`) nhưng không có trong mẫu 20 người vì đặc tả mục 10 không có giá trị; kiểm thử đơn vị dùng tỷ lệ minh họa riêng.
