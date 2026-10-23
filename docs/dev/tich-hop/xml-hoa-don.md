# Cấu trúc XML hóa đơn điện tử: tham chiếu để đọc hóa đơn đầu vào

Mục đích: bộ phân tích (parser) XML hóa đơn nhận từ nhà cung cấp hoặc cơ quan thuế, nhập vào phân hệ mua hàng (hóa đơn đầu vào). Tài liệu mô tả đường dẫn thẻ, kiểu, độ dài, ràng buộc, giá trị mã hóa. Không dùng để sinh XML ký số.

## 1. Nguồn và độ tin cậy

| Nguồn | Nội dung | Độ tin cậy |
|---|---|---|
| `~/legal-docs/qd1233-2026/qd1233.txt` | QĐ 1233/QĐ-CT (27/8/2026, Cục trưởng Cục Thuế): thành phần dữ liệu nghiệp vụ HĐĐT, chứng từ điện tử, phương thức truyền nhận. `pdftotext -layout` từ PDF 324 trang | Thứ cấp: bản sao của thuvienphapluat (`cdn.thuvienphapluat.vn`). CHƯA đối chiếu bản gốc của Cục Thuế (gdt.gov.vn không truy cập được từ VPS). Phải đối chiếu bản gốc trước khi coi là dữ liệu pháp lý. Các phụ lục còn dòng "số /QĐ-CT ngày / /2026" để trống, một phụ lục (IV, VII) còn ghi "ngày /06/2025": dấu hiệu bản chưa hoàn chỉnh hoặc sao chép từ bản trước |
| `~/legal-docs/qd1233-2026/kythuat.txt` | QĐ 1271/QĐ-CT (30/5/2025), bản thế hệ trước, thông điệp `PBan` = `2.1.0` | Thứ cấp, chỉ để so sánh cấu trúc |
| `apps/api/test/fixtures/xml/*.xml` | Hai mẫu XML tổng hợp, `PBan` = `2.0.1` | Do tác giả thư viện tự viết (MIT), không từ nhà cung cấp. Xem `NGUON.md` cùng thư mục |
| `research_notes/Nghiệp vụ phần mềm kế toán/ma-nguon-mo-viet-nam-va-tich-hop.md` câu 2 | Tóm tắt QĐ 1450 qua trang thứ cấp | Chưa đối chiếu toàn văn |

Số dòng trích dẫn dưới đây là số dòng trong `qd1233.txt`. Ghi chú ban đầu của dự án nói bảng thẻ ở dòng 1197–2150; thực tế dòng đó là tờ khai và thông báo đăng ký. Bảng thẻ hóa đơn nằm ở dòng 3107–5500 (hóa đơn GTGT 3161–3940, hóa đơn bán hàng 3942–4800), thông điệp bọc ở dòng 319–410, phụ lục từ dòng 15477.

### Chuỗi văn bản và phiên bản

- QĐ 1450/QĐ-TCT (07/10/2021) sửa bởi QĐ 1510/QĐ-TCT (21/9/2022), sau đó QĐ 1306/QĐ-CT (13/6/2025), nay QĐ 1233/QĐ-CT thay QĐ 1306 (`nguon.txt`). QĐ 1271/QĐ-CT (30/5/2025) là bản trung gian trong thư mục tài liệu, `PBan` = `2.1.0`. Chuỗi thứ tự 1450, 1510, 1306 lấy từ ghi chú cũ và `nguon.txt`, chưa kiểm bằng văn bản gốc.
- Hiệu lực QĐ 1233: từ ngày ký. Chuyển tiếp (dòng 59–60): hệ thống thuế nhận song song thông điệp `2.1.0` và `2.1.1`, `2.1.0` nhận đến hết 31/12/2026; hệ thống thuế nâng cấp trước 01/01/2027; ký số `DSig` và `XAdES` nhận song song, hoàn thành trước 10/4/2027 (ngày này theo `nguon.txt`, chưa tìm lại trong thân văn bản).
- `PBan` trong quy định này là `2.1.1` (chuỗi, tối đa 6 ký tự). Hóa đơn đầu vào năm 2026 có thể mang `2.0.1`, `2.1.0` hay `2.1.1`: parser không được từ chối theo `PBan`, chỉ ghi lại.
- Căn cứ pháp lý đi kèm: Nghị định 254/2026/NĐ-CP, Thông tư 91/2026/TT-BTC (cột "Tham khảo" của bảng thẻ).

## 2. Quy tắc chung (dòng 198–300)

- Tên thẻ: viết liền không dấu, viết tắt (lấy chữ cái đầu viết hoa của mỗi từ, từ cuối giữ nguyên; ví dụ `SLuong`, `DLHDon`). Phân biệt chữ hoa/thường: không đổi.
- Mã hóa: UTF-8 (dòng 211).
- Số (dòng 214–230): tối đa 21 chữ số không tính dấu chấm thập phân và dấu âm; dấu phân cách thập phân là dấu chấm `.`; phần thập phân tối đa 6 chữ số. Ký hiệu độ dài `x,y` = tổng tối đa x chữ số, trong đó y chữ số thập phân (`TGia` 7,2; `SLuong`/`DGia`/`ThTien` 21,6; `TLCKhau` 6,4). Không có dấu phân cách hàng nghìn. Tiền VND (tổng tiền chưa thuế, tổng tiền thuế, tổng chiết khấu thương mại, tổng thanh toán...) làm tròn đến đồng, không ghi phần thập phân. Quy tắc này khớp ràng buộc tiền VND của dự án (`^\d{1,16}$`); với ngoại tệ nhận chuỗi thập phân, không dùng `number`.
- Ngày (`date`): `YYYY-MM-DD`, múi giờ GMT+7. Ngày giờ (`dateTime`): `YYYY-MM-DDThh:mm:ss`, GMT+7, không AM/PM, không có hậu tố múi giờ (dòng 232–241). Chỉ áp dụng trong XML.
- Chuỗi: "Chuỗi ký tự", độ dài tối đa theo cột "Độ dài".
- Ràng buộc "Bắt buộc (nếu có)": ghi hay không tùy văn bản pháp luật liên quan (dòng 247–250). Parser đầu vào phải chấp nhận thẻ vắng mặt.
- Thẻ `TTKhac` (dòng 3118–3150): chứa nhiều `TTin` gồm `TTruong` (tên trường), `KDLieu` (kiểu: `string`, `numeric`, `dateTime`, `date`; Phụ lục III, dòng 15606), `DLieu` (dữ liệu). Nội dung tối đa 500 ký tự. Có thể đặt ở `DLHDon`, `TTChung`, `NBan`, `NMua`, `HHDVu`, `TToan`.
- Mã của cơ quan thuế (`MCCQT`), dòng 253–279: chuỗi 34 ký tự cho hóa đơn có mã thông thường. Hóa đơn từ máy tính tiền: 23 ký tự `Mx-yy-ccccc-nnnnnnnnnnn` (`M`, loại hóa đơn 1–9, 2 số cuối năm, 5 ký tự do CQT cấp, 11 số), ví dụ `M2-26-A1B2C-00001234567`.
- Chữ ký (dòng 280–305): RSA; hàm băm SHA-256, SHA-384 hoặc SHA-512; XML signature theo ETSI EN 319 132-1 V1.2.1 (XAdES). `SigningTime` ở `Signature/Object/QualifyingProperties/SignedProperties/SignedSignatureProperties/`. Chứng thư số X.509 mã hóa Base64 ở `Signature/KeyInfo/X509Data/X509Certificate`. Ngoài vùng dữ liệu nghiệp vụ, phải có `Reference` trỏ `SignedProperties`. Giai đoạn chuyển tiếp: nhận cả `DSig` lẫn `XAdES`.

## 3. Gói ngoài: thông điệp `TDiep` (dòng 319–410)

Khi hóa đơn truyền giữa tổ chức truyền nhận (TCTN) và cơ quan thuế, `HDon` nằm TRONG `TDiep/DLieu`. Hóa đơn nhà cung cấp trả về cho người mua thường là `HDon` trần (không có `TDiep`). Parser phải nhận cả hai: gốc là `TDiep` thì đi vào `TDiep/DLieu/HDon`, gốc là `HDon` thì dùng trực tiếp.

| Đường dẫn | Tên đầy đủ | Độ dài | Kiểu | Ràng buộc |
|---|---|---|---|---|
| `TDiep/TTChung/PBan` | Phiên bản thông điệp | 6 | Chuỗi | Bắt buộc (`2.1.1`) |
| `TDiep/TTChung/MNGui` | Mã nơi gửi | 14 | Chuỗi | Bắt buộc |
| `TDiep/TTChung/MNNhan` | Mã nơi nhận | 14 | Chuỗi | Bắt buộc |
| `TDiep/TTChung/MLTDiep` | Mã loại thông điệp | 3 | Số | Bắt buộc |
| `TDiep/TTChung/MTDiep` | Mã thông điệp | 46 | Chuỗi | Bắt buộc |
| `TDiep/TTChung/MTDTChieu` | Mã thông điệp tham chiếu | 46 | Chuỗi | Bắt buộc, trừ khi bên nhận không bóc được thông điệp gốc |
| `TDiep/TTChung/MST` | MST của NNT có dữ liệu trong thông điệp | 14 | Chuỗi | Bắt buộc |
| `TDiep/TTChung/SLuong` | Số lượng dữ liệu trong `DLieu` | 7 | Số | Bắt buộc |
| `TDiep/DLieu` | Dữ liệu (chứa `HDon`) | | | |

- `MNGui`, `MNNhan`: cơ quan thuế là `TCT`; TCTN là `V` + MST (bỏ dấu `-`), tổ chức kết nối nhận gửi thanh toán là `K` + MST (ví dụ `V0107001729001`).
- `MTDiep`: `MNGui` + 32 ký tự hoa của UUID v4 không có dấu `-`.
- `MLTDiep` liên quan hóa đơn (Phụ lục I, dòng 15360–15420): `200` gửi hóa đơn để cấp mã, `201` cấp mã theo từng lần phát sinh, `202` kết quả cấp mã (hóa đơn đã có `MCCQT`), `203` hóa đơn không mã, `204` kết quả kiểm tra dữ liệu (01/TB-KTDL), `206` hóa đơn máy tính tiền đã cấp mã, `207`/`214` hóa đơn kèm phiếu casino, `208`/`210` hóa đơn điều chỉnh/thay thế nhiều hóa đơn kèm bảng kê, `209`/`215` hóa đơn tích hợp biên lai, `216` hóa đơn máy tính tiền không mã; `999` phản hồi kỹ thuật; `-1` phản hồi sai định dạng.
- Một thông điệp chứa một loại dữ liệu của một NNT; thông điệp cấp mã (`200`, `202`) chỉ chứa một hóa đơn (dòng 11101–11107); thông điệp không mã (`203`) có thể chứa nhiều hóa đơn, `SLuong` là tổng số.
- Dung lượng tối đa một thông điệp: 2MB (dòng 408).
- Thông điệp hóa đơn máy tính tiền (`206`, `216`) thêm chữ ký số của người bán ở `TDiep/CKSNNT`, ký trên `TDiep/DLieu` (dòng 11146).
- `HDon` trong thông điệp `202` mang `MCCQT` và chữ ký CQT; trong `200` chưa có `MCCQT`.

## 4. Cấu trúc `HDon` (dòng 3109–3160)

```
HDon
  DLHDon [@Id]            dữ liệu hóa đơn do người bán lập (phần được ký)
    TTChung               thông tin chung
      TTHDLQuan           hóa đơn liên quan (điều chỉnh/thay thế)
      TTKhac/TTin*
    NDHDon                nội dung
      NBan (+TTKhac)
      NMua (+TTKhac)
      DSHHDVu/HHDVu*      (+TTHHDTrung/TTin*, +TTKhac)
      TToan               (THTTLTSuat/LTSuat*, DSLPhi/LPhi*, TTKhac)
    TTKhac/TTin*
  DSHDGiay/DLHDGiay*      hóa đơn giấy bị thay thế (NĐ 51/2010, 04/2014)
  DLQRCode                dữ liệu QR (không bắt buộc, 512 ký tự)
  MCCQT [@Id]             mã CQT (chỉ hóa đơn có mã)
  DSCKS                   chữ ký số
    NBan                  người bán / đơn vị nhận ủy nhiệm
    NMua                  người mua (nếu có)
    CQT                   cơ quan thuế (hóa đơn có mã)
    CCKSKhac              chữ ký khác
```

Các thẻ ở dạng `*` lặp nhiều lần. Bảng sau là hóa đơn GTGT (mục a, `KHMSHDon` = 1). Hóa đơn bán hàng (mục b, dòng 3942) cùng khung nhưng khác ở mục 6.

### 4.1 `HDon/DLHDon/TTChung` (dòng 3171–3280)

| Thẻ | Tên đầy đủ | Kiểu | Dài | Bắt buộc | Ghi chú |
|---|---|---|---|---|---|
| `PBan` | Phiên bản thông điệp | Chuỗi | 6 | Có | `2.1.1` |
| `THDon` | Tên hóa đơn | Chuỗi | 100 | Có | |
| `KHMSHDon` | Ký hiệu mẫu số hóa đơn | Chuỗi | 1 | Có | Phụ lục II: 1 GTGT, 2 bán hàng, 3 bán tài sản công, 4 bán hàng dự trữ quốc gia, 5 khác (tem, vé, thẻ, phiếu thu), 6 phiếu xuất kho kiêm vận chuyển nội bộ/gửi bán đại lý, 7 hóa đơn thương mại, 8 GTGT tích hợp biên lai, 9 bán hàng tích hợp biên lai. Hóa đơn theo NĐ 51/2010, 04/2014 dùng 11 ký tự (`01GTKT0/001`) |
| `KHHDon` | Ký hiệu hóa đơn | Chuỗi | 6 | Có | Ví dụ `C26TAA`: `C` có mã (`K` không mã), 2 số năm, `T` (đơn vị đăng ký trực tiếp)/`M` (máy tính tiền), 2 chữ quản lý. Quy ước này lấy từ TT 78, không có trong bảng thẻ |
| `SHDon` | Số hóa đơn | Số | 8 | Nếu có | Bắt buộc với hóa đơn đã cấp số; mẫu XML ghi `00000123` (giữ số 0 đầu: lưu dạng chuỗi) |
| `MHSo` | Mã hồ sơ | Chuỗi | 20 | Với hóa đơn đề nghị cấp mã từng lần phát sinh | |
| `NLap` | Ngày lập | Ngày | | Có | |
| `HDCTTChinh` | Hóa đơn cho thuê tài chính | Số | 1 | Có | `1` thuê tài chính, `0` không |
| `SBKe` | Số bảng kê | Chuỗi | 50 | Nếu có | Bảng kê kèm hóa đơn hoặc hóa đơn chiết khấu thương mại |
| `NBKe` | Ngày bảng kê | Ngày | | Nếu có | |
| `DVTTe` | Đơn vị tiền tệ | Chuỗi | 3 | Có | Mã ISO 4217 trong Phụ lục XVI (dòng 16263), ví dụ `VND`, `USD`, `SGD`, `THB` |
| `TGia` | Tỷ giá | Số | 7,2 | Trừ khi `DVTTe` là VND | Chú ý: kiểu 7,2 hẹp hơn tỷ giá nội bộ của dự án (`NUMERIC(20,10)`) |
| `HTTToan` | Hình thức thanh toán | Chuỗi | 50 | Có | Văn bản tự do, ví dụ `TM`, `CK`, `TM/CK`; không có danh mục mã |
| `MSTTCGP` | MST tổ chức cung cấp giải pháp hóa đơn điện tử | Chuỗi | 14 | Có | |
| `MSTDVNUNLHDon` | MST đơn vị nhận ủy nhiệm lập hóa đơn | Chuỗi | 14 | Khi ủy nhiệm | |
| `TDVNUNLHDon` | Tên đơn vị nhận ủy nhiệm | Chuỗi | 400 | Khi ủy nhiệm | |
| `DCDVNUNLHDon` | Địa chỉ đơn vị nhận ủy nhiệm | Chuỗi | 400 | Khi ủy nhiệm | |

### 4.2 `TTChung/TTHDLQuan`: hóa đơn liên quan (dòng 3282–3416)

Chỉ có khi hóa đơn là điều chỉnh hoặc thay thế (Điều 10 TT 91).

| Thẻ | Tên đầy đủ | Kiểu | Dài | Bắt buộc | Giá trị |
|---|---|---|---|---|---|
| `TCHDon` | Tính chất hóa đơn | Số | 1 | Có | 1 thay thế, 2 điều chỉnh, 3 thay thế nhiều hóa đơn, 4 điều chỉnh nhiều hóa đơn, 5 chiết khấu thương mại. Nếu hóa đơn tính chất 5 lập sai, hóa đơn xử lý chọn 2 |
| `MSTCLQuan` | MST có liên quan | Chuỗi | 14 | Khi điều chỉnh/thay thế hóa đơn của đơn vị bị chia, tách, sáp nhập, hợp nhất | |
| `LHDCLQuan` | Loại hóa đơn có liên quan | Số | 1 | Khi điều chỉnh/thay thế một hóa đơn (trừ lý do 1, 2, 3, 9, 10, 12) | Phụ lục VI: 1 theo NĐ 123/70, 2 có mã xác thực theo QĐ 1209/2660, 3 theo NĐ 51/04 (trừ loại 2), 4 đặt in NĐ 123, 5 theo NĐ 254/2026 |
| `KHMSHDCLQuan` | Ký hiệu mẫu số hóa đơn bị thay thế/điều chỉnh | Chuỗi | 11 | như trên | |
| `KHHDCLQuan` | Ký hiệu hóa đơn bị thay thế/điều chỉnh | Chuỗi | 8 | như trên | |
| `SHDCLQuan` | Số hóa đơn bị thay thế/điều chỉnh | Chuỗi | 8 | như trên | |
| `NLHDCLQuan` | Ngày lập hóa đơn bị thay thế/điều chỉnh | Ngày | | như trên | |
| `LDDCTThe` | Lý do điều chỉnh/thay thế | Số | 2 | Khi điều chỉnh/thay thế một hóa đơn | Phụ lục XVII (dòng 16315): 1 đến 14, trong đó 4 chiết khấu thương mại, 5 trả lại hàng (điều chỉnh), 6 trả lại hàng là tài sản đăng ký (thay thế), 13 điều chỉnh/thay thế hóa đơn lập sai, 14 thay thế bằng hóa đơn máy tính tiền |
| `GChu` | Ghi chú | Chuỗi | 255 | Không | |
| `SBKCLQuan` | Số bảng kê thay thế/điều chỉnh | Chuỗi | 50 | Khi thay thế/điều chỉnh nhiều hóa đơn | |
| `NBKCLQuan` | Ngày bảng kê thay thế/điều chỉnh | Ngày | | như trên | |

Hóa đơn điều chỉnh có thể bỏ `DSHHDVu` và `TToan` khi không điều chỉnh thông tin tương ứng (dòng 3614, 3705): parser không được coi thiếu là lỗi.

### 4.3 `NDHDon/NBan`: người bán (dòng 3422–3488)

| Thẻ | Tên đầy đủ | Kiểu | Dài | Bắt buộc |
|---|---|---|---|---|
| `Ten` | Tên | Chuỗi | 400 | Có |
| `MST` | Mã số thuế | Chuỗi | 14 | Có |
| `DChi` | Địa chỉ | Chuỗi | 400 | Có |
| `MCHang` | Mã cửa hàng | Chuỗi | 50 | Không |
| `TCHang` | Tên cửa hàng | Chuỗi | 400 | Không |
| `TCQDGBTSan`, `DCCQDGBTSan`, `MSTCQDGBTSan` | Tên, địa chỉ, MST cơ quan được giao bán đấu giá tài sản | Chuỗi | 400, 400, 14 | Không |
| `MDDKDoanh` | Mã địa điểm kinh doanh | Chuỗi | 14 | Doanh nghiệp có mã địa điểm kinh doanh xăng dầu |
| `TDDKDoanh` | Tên địa điểm kinh doanh | Chuỗi | 400 | Không |
| `DCDDKDoanh` | Địa chỉ địa điểm kinh doanh | Chuỗi | 400 | Doanh nghiệp nhiều địa điểm xăng dầu |
| `SDThoai` | Số điện thoại | Chuỗi | 20 | Không |
| `DCTDTu` | Địa chỉ thư điện tử | Chuỗi | 50 | Không |
| `STKNHang` | Số tài khoản ngân hàng | Chuỗi | 30 | Không |
| `TNHang` | Tên ngân hàng | Chuỗi | 400 | Không |
| `Fax` | Fax | Chuỗi | 20 | Không |
| `Website` | Website | Chuỗi | 100 | Không |

### 4.4 `NDHDon/NMua`: người mua (dòng 3490–3612)

Hầu hết "bắt buộc nếu có". `Ten`, `MST`, `DChi` bắt buộc theo loại hàng hóa đặc trưng 1 (tài sản đăng ký) hoặc nếu có thông tin. Hóa đơn bán lẻ cho người tiêu dùng có thể để `HVTNMHang` là "Bán cho người tiêu dùng". Mẫu máy tính tiền có `Ten`, `MST`, `DChi` rỗng.

| Thẻ | Tên đầy đủ | Kiểu | Dài | Bắt buộc |
|---|---|---|---|---|
| `Ten` | Tên | Chuỗi | 400 | Nếu có |
| `MST` | Mã số thuế | Chuỗi | 14 | Nếu có |
| `DChi` | Địa chỉ | Chuỗi | 400 | Nếu có |
| `MTinh`, `TTinh` | Mã, tên tỉnh/thành phố (theo QĐ 19/2025/QĐ-TTg) | Chuỗi | 2, 50 | Hàng hóa đặc trưng 1 |
| `MXa`, `TXa` | Mã, tên xã/phường | Chuỗi | 5, 50 | Hàng hóa đặc trưng 1 |
| `MKHang` | Mã khách hàng | Chuỗi | 50 | Không |
| `SDDTCNNgoai` | Số định danh tổ chức nước ngoài | Chuỗi | 50 | Không |
| `SDThoai` | Số điện thoại | Chuỗi | 20 | Hàng hóa đặc trưng 1 |
| `CCCDan` | Số CC/CCCD/định danh cá nhân | Chuỗi | 12 | Người tiêu dùng cá nhân có cung cấp |
| `SHChieu` | Số hộ chiếu | Chuỗi | 20 | như trên |
| `MQTNMua`, `QTNMua` | Mã, tên quốc tịch người mua (Phụ lục XIX) | Chuỗi | 2, 50 | Người mua nước ngoài có cung cấp |
| `DCTDTu` | Thư điện tử | Chuỗi | 50 | Không |
| `HVTNMHang` | Họ và tên người mua hàng | Chuỗi | 100 | Nếu có |
| `STKNHang` | Số tài khoản ngân hàng | Chuỗi | 30 | Không |
| `TNHang` | Tên ngân hàng | Chuỗi | 400 | Không |

### 4.5 `NDHDon/DSHHDVu/HHDVu`: một dòng hàng (dòng 3616–3680)

| Thẻ | Tên đầy đủ | Kiểu | Dài | Bắt buộc | Giá trị |
|---|---|---|---|---|---|
| `TChat` | Tính chất | Số | 1 | Có | Phụ lục IV: 1 hàng hóa, dịch vụ; 2 khuyến mại; 3 chiết khấu thương mại (theo dòng); 4 ghi chú/diễn giải; 5 hàng hóa đặc trưng |
| `STT` | Số thứ tự | Số | 4 | Không | |
| `MHHDVu` | Mã hàng hóa, dịch vụ | Chuỗi | 50 | Nếu có | |
| `THHDVu` | Tên hàng hóa, dịch vụ | Chuỗi | 500 | Có | |
| `DVTinh` | Đơn vị tính | Chuỗi | 50 | Nếu có | |
| `SLuong` | Số lượng | Số | 21,6 | Nếu có | |
| `DGia` | Đơn giá | Số | 21,6 | Nếu có | |
| `TLCKhau` | Tỷ lệ % chiết khấu | Số | 6,4 | Không | Chiết khấu theo dòng |
| `STCKhau` | Số tiền chiết khấu | Số | 21,6 | Không | |
| `ThTien` | Thành tiền chưa thuế GTGT | Số | 21,6 | Có, trừ khi `TChat` = 4 | |
| `TSuat` | Thuế suất GTGT | Chuỗi | 11 | Nếu có | Phụ lục V, xem 4.7 |

`TTHDTrung/TTin` (hàng hóa đặc trưng, bắt buộc khi `TChat` = 5): `LHHDTrung` (Số 1, loại hàng hóa đặc trưng, Phụ lục XV), `TTruong` (Chuỗi 20), `DLieu` (Chuỗi 200).

### 4.6 `NDHDon/TToan` (dòng 3705–3770)

| Đường dẫn | Tên đầy đủ | Kiểu | Dài | Bắt buộc |
|---|---|---|---|---|
| `THTTLTSuat/LTSuat/TSuat` | Thuế suất | Chuỗi | 11 | Nếu có |
| `THTTLTSuat/LTSuat/ThTien` | Thành tiền chưa thuế của mức thuế suất | Số | 21,6 | Có |
| `THTTLTSuat/LTSuat/TThue` | Tiền thuế GTGT của mức thuế suất | Số | 21,6 | Nếu có |
| `TgTCThue` | Tổng tiền chưa thuế | Số | 21,6 | Có |
| `TGTKCThue` | Tổng giảm trừ không chịu thuế | Số | 21,6 | Không |
| `TgTThue` | Tổng tiền thuế GTGT | Số | 21,6 | Có |
| `DSLPhi/LPhi/TLPhi` | Tên loại phí, lệ phí | Chuỗi | 100 | Nếu có |
| `DSLPhi/LPhi/TPhi` | Tiền phí | Số | 21,6 | Nếu có |
| `TTCKTMai` | Tổng tiền chiết khấu thương mại | Số | 21,6 | Nếu có |
| `TGTKhac` | Tổng giảm trừ khác | Số | 21,6 | Không |
| `TgTTTBSo` | Tổng tiền thanh toán bằng số | Số | 21,6 | Có |
| `TgTTTBChu` | Tổng tiền thanh toán bằng chữ | Chuỗi | 255 | Có |

`THTTLTSuat/LTSuat` lặp theo số mức thuế suất khác nhau trên hóa đơn. Quy tắc nhất quán để kiểm tra khi nhập: tổng `LTSuat/ThTien` = `TgTCThue` (sai lệch do làm tròn cần dung sai), tổng `LTSuat/TThue` = `TgTThue`, `TgTCThue` + `TgTThue` + phí - giảm trừ = `TgTTTBSo` (công thức chưa có trong văn bản, tự kiểm tra bằng mẫu thật).

### 4.7 Mã thuế suất `TSuat` (Phụ lục V, dòng 15633)

| Giá trị | Nghĩa |
|---|---|
| `0%`, `5%`, `8%`, `10%` | Thuế suất tương ứng |
| `KCT` | Không chịu thuế GTGT |
| `KKKNT` | Không kê khai, tính nộp thuế GTGT |
| `KHAC:AB.CD%` | Trường hợp khác, ví dụ `KHAC:5.26%`, `KHAC:7%`. Phần `:AB.CD` bắt buộc khi xác định được thuế suất; người nộp thuế theo Điều 30 TT 89/2026/TT-BTC chỉ điền `KHAC` |
| `CTTC` | Thuế suất của hóa đơn cho thuê tài chính |
| `KTPVDC` | Không thuộc phạm vi điều chỉnh của Luật thuế |
| `KTGTT` | Không tính vào giá tính thuế GTGT |

`KTPVDC` và `KTGTT` không có trong `kythuat.txt` (QĐ 1271): giá trị mới của 2.1.1. Parser phải chấp nhận giá trị lạ (lưu thô, đánh dấu cần xem).

### 4.8 `HDon/MCCQT`, `DLQRCode`, `DSCKS` (dòng 3898–3940)

| Đường dẫn | Tên đầy đủ | Kiểu | Dài | Bắt buộc |
|---|---|---|---|---|
| `MCCQT` | Mã của cơ quan thuế trên hóa đơn | Chuỗi | 34 (23 với máy tính tiền) | Có, với hóa đơn có mã |
| `DLQRCode` | Dữ liệu QR Code | Chuỗi | 512 | Không |
| `DSCKS/NBan/Signature` | Chữ ký số người bán hoặc đơn vị nhận ủy nhiệm | | | Nếu có (ký trên `HDon/DLHDon`) |
| `DSCKS/NMua/Signature` | Chữ ký số người mua | | | Không |
| `DSCKS/CQT/Signature` | Chữ ký số cơ quan thuế | | | Có, với hóa đơn đủ điều kiện cấp mã (ký trên `DLHDon` và `MCCQT`) |
| `DSCKS/CCKSKhac` | Chữ ký khác do NNT tự định nghĩa | | | Không |

Vị trí chữ ký: `DSCKS` là anh em của `DLHDon`, KHÔNG nằm trong `DLHDon`. `ds:Signature` có `ds:Object/xades:QualifyingProperties/xades:SignedProperties`. Chữ ký NBan và NMua ký vùng `DLHDon`; chữ ký CQT ký `DLHDon` và `MCCQT`. Thuộc tính `Id` của `DLHDon` và `MCCQT` (mẫu dùng `Id="data"`) là đích `Reference/@URI` (`#data`).

Parser đầu vào: chưa kiểm chữ ký ở giai đoạn đọc (kiểm chữ ký là việc riêng, cần chuẩn hóa C14N và XAdES). Lưu nguyên XML gốc, vì file XML gốc là bản có giá trị pháp lý; chỉ đọc `DLHDon`, `MCCQT`, ghi nhận có hay không `DSCKS/*`.

## 5. Khác biệt giữa `2.1.0` (QĐ 1271) và `2.1.1` (QĐ 1233)

So sánh bằng đối chiếu bảng thẻ hóa đơn GTGT hai văn bản; kết quả là điểm khác biệt có thể nhận ra, chưa phải so sánh từng dòng.

- Cấu trúc khung giống nhau: `HDon/{DLHDon, DLQRCode, MCCQT, DSCKS}`, `DLHDon/{TTChung, NDHDon, TTKhac}`. Thẻ lõi (`PBan`, `THDon`, `KHMSHDon`, `KHHDon`, `SHDon`, `NLap`, `DVTTe`, `TGia`, `HTTToan`, `MSTTCGP`, `NBan`, `NMua`, `HHDVu`, `TToan`, `THTTLTSuat`, `TgTCThue`, `TgTThue`, `TgTTTBSo`, `TgTTTBChu`) không đổi tên.
- Thêm trong `2.1.1` (không thấy trong `kythuat.txt`): `NDHDon/NBan`: `TCQDGBTSan`, `DCCQDGBTSan`, `MSTCQDGBTSan` (đấu giá tài sản), `MDDKDoanh`, `TDDKDoanh`, `DCDDKDoanh` (địa điểm kinh doanh xăng dầu); `NMua`: `MTinh`, `TTinh`, `MXa`, `TXa`, `SDDTCNNgoai`, `MQTNMua`, `QTNMua` (quốc tịch); `HHDVu`: `MNNNghe` (mã nhóm ngành nghề, Phụ lục XVIII, chỉ có ở hóa đơn bán hàng và một số mẫu khác); `TTHDLQuan`: `MSTCLQuan`, `LDDCTThe`; `TSuat`: `KTPVDC`, `KTGTT`.
- Đổi tham chiếu pháp lý: Nghị định 123/2020, TT 78/2021 sang Nghị định 254/2026, TT 91/2026.
- `ThTien` không còn bắt buộc khi `TChat` = 4 (ghi chú/diễn giải).
- Mã loại hóa đơn (Phụ lục VI) có giá trị `5` mới (hóa đơn theo NĐ 254/2026); mã lý do Phụ lục XVII có tới 14 mã.
- So `2.0.1` (mẫu XML trong repo) với `2.1.x`: `2.0.1` có `MauSo` và `DVTTe` dạng thẻ con (`Ma`, `Ten`), không thấy trong bảng `2.1.x`; `2.1.x` có `THDon`, `MSTTCGP`, `HDCTTChinh` bắt buộc. Parser nên xử lý cả hai (chi tiết mục 7).
- Chữ ký: `2.1.x` nhận song song `DSig` (XML-DSig) và `XAdES` đến hết giai đoạn chuyển tiếp.

## 6. Khác biệt theo loại hóa đơn (trong cùng `HDon/DLHDon`)

- Hóa đơn bán hàng (`KHMSHDon` = 2, dòng 3942–4800): `HHDVu` thêm `MNNNghe`; không có `TSuat` ở dòng hàng; `TToan` KHÔNG có `THTTLTSuat`, `TgTCThue`, `TgTThue`, `TGTKCThue`; có `DSLPhi`, `TTCKTMai`, `TGTKhac`, `TgTTTBSo`, `TgTTTBChu`. Không có thuế GTGT để tách: không đưa vào bút toán thuế đầu vào được khấu trừ.
- Hóa đơn bán tài sản công, dự trữ quốc gia, tem/vé/thẻ, phiếu xuất kho kiêm vận chuyển nội bộ/đại lý, máy tính tiền, nhiều tỷ giá của ngân hàng, GTGT kiêm tờ khai hoàn thuế, thương mại: các bảng riêng ở dòng 4802–9200, cùng khung `TTChung/NDHDon`. Chưa dựng bảng thẻ riêng cho chúng; khi cần, đọc `qd1233.txt` ở các dòng đó. Parser đầu vào v1 chỉ cam kết GTGT (`KHMSHDon` 1, 8) và bán hàng (2, 9).
- Hóa đơn từ máy tính tiền: `MCCQT` 23 ký tự; người mua thường để trống.

## 7. Đối chiếu hai mẫu XML với bảng thẻ

Mẫu: `apps/api/test/fixtures/xml/vn-einvoice-vat.xml` và `vn-einvoice-cashreg.xml`. Cả hai `PBan` = `2.0.1`, không ký số.

Thẻ mẫu có, bảng thẻ `2.1.1` KHÔNG có:
- `TTChung/MauSo` (không có trong `qd1233.txt`; cho thấy mẫu theo bản `2.0.x`).
- `TTChung/DVTTe/Ma` và `DVTTe/Ten`: bảng `2.1.1` định nghĩa `DVTTe` là một chuỗi 3 ký tự (mã ISO). Parser đọc `DVTTe` text nếu có text, ngược lại `DVTTe/Ma`.
- Cấu trúc `HDon/DLieu/DLHDon` (chỉ mẫu cashreg): trong QĐ 1233, `DLieu` thuộc `TDiep`, nằm trên `HDon` chứ không nằm dưới `HDon`. Mẫu cashreg bọc sai lớp so với tài liệu. Parser cần tìm `DLHDon` ở cả hai vị trí (`HDon/DLHDon` và `HDon/DLieu/DLHDon`).
- `NBan/MST` và các thẻ khác đúng tên; `SHDon` ở mẫu là chuỗi 8 ký tự có số 0 đầu.

Thẻ bảng thẻ yêu cầu bắt buộc nhưng mẫu THIẾU:
- `TTChung/THDon` (tên hóa đơn), `TTChung/MSTTCGP` (MST tổ chức cung cấp giải pháp), `TTChung/HDCTTChinh`.
- `MCCQT` có nhưng 32 ký tự (bảng: 34; máy tính tiền 23).
- `DSCKS` (người bán, CQT), `TTKhac`, `TTHDLQuan`, `THTTLTSuat`, `DLQRCode`: vắng trong cả hai mẫu. Mẫu GTGT thiếu `THTTLTSuat`, vốn dùng tính thuế theo mức: parser phải suy ra tổng theo mức từ các dòng khi thiếu.
- Mẫu cashreg không có `NMua/HVTNMHang`; `NMua` có ba thẻ rỗng (`Ten`, `MST`, `DChi`): parser coi chuỗi rỗng là vắng.
- Mẫu cashreg dòng hàng không có `MHHDVu` (bảng: "nếu có", chấp nhận được).

Thẻ mẫu có, bảng khớp: `PBan`, `KHMSHDon`, `KHHDon`, `SHDon`, `NLap`, `HTTToan`, `NBan/{Ten,MST,DChi,SDThoai,STKNHang,TNHang}`, `NMua/{Ten,MST,DChi,HVTNMHang}`, `HHDVu/{TChat,STT,MHHDVu,THHDVu,DVTinh,SLuong,DGia,TLCKhau,STCKhau,ThTien,TSuat}`, `TToan/{TgTCThue,TgTThue,TgTTTBSo,TgTTTBChu}`. Thuế suất trong mẫu: `10%` (hai dòng, mẫu GTGT) và `8%` (một dòng, mẫu cashreg), cùng danh mục Phụ lục V.

Giá trị kỳ vọng từng mẫu: `apps/api/test/fixtures/xml/NGUON.md`.

## 8. Gợi ý cho bộ phân tích hóa đơn đầu vào

- Nhận gốc `TDiep` hoặc `HDon`; tìm `DLHDon` ở `HDon/DLHDon` hoặc `HDon/DLieu/DLHDon`.
- Không rút ra bất cứ số tiền nào bằng `number`: đọc nguyên chuỗi, kiểm `^-?\d{1,21}(\.\d{1,6})?$`, đổi bằng `decimal.js`. Tiền VND không có phần thập phân.
- Khóa nhận diện hóa đơn: (MST người bán, `KHMSHDon`, `KHHDon`, `SHDon`), dùng để chống nhập trùng. `SHDon` giữ chuỗi.
- Hóa đơn điều chỉnh/thay thế: đọc `TTHDLQuan` để liên kết hóa đơn gốc; thiếu `DSHHDVu`/`TToan` là hợp lệ.
- Thuế suất: lưu giá trị `TSuat` thô cộng giá trị số suy ra (null với `KCT`, `KKKNT`, `KHAC`, `CTTC`, `KTPVDC`, `KTGTT`).
- Lưu XML gốc không đổi (kể cả chữ ký) cùng chứng từ.

## 9. Việc chưa làm hoặc cần người dùng

- Đối chiếu `qd1233.txt` với bản gốc của Cục Thuế (gdt.gov.vn) trước khi đưa bảng thẻ vào `packages/coa-data` hoặc dùng làm căn cứ pháp lý.
- Xin tệp XML mẫu thật từ nhà cung cấp (SInvoice, MISA, VNPT, BKAV) qua tài khoản sandbox; kiểm tra thực tế `PBan`, vị trí `DLieu`, dạng `DVTTe`, `MauSo`.
- Chưa kiểm chữ ký XAdES/DSig.
- Phụ lục I (đầy đủ `MLTDiep`) và Phụ lục XV (hàng hóa đặc trưng), XVIII (nhóm ngành nghề), XIX (quốc tịch) chưa chép ở đây.
