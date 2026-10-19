# SUNSOFT PRO – Phân tích nghiệp vụ & mô hình dữ liệu phần mềm kế toán (Huỳnh Phát / Sunsoft Hà Nội)

> Ghi chú nghiên cứu phục vụ thiết kế phần mềm kế toán mới. Nguồn: tài liệu "Hướng dẫn sử dụng 2021", "Hướng dẫn cài đặt và triển khai", 81 trang help trong SUNSOFT.chm, DDL của CSDL mẫu `KTSTRUC` (122 bảng) và `KT2022` (119 bảng), `AppInfo` (người dùng), dữ liệu tham chiếu xuất từ CSDL mẫu (danh mục chứng từ, hệ thống tài khoản TT133/TT200, định nghĩa BCTC, bước kết chuyển, soát lỗi, nhật ký nâng cấp 2011→03/2026), và danh sách 941 form / 770 report / 32 module VBA của file `KT.mde`.
>
> Quy ước: tên bảng, cột, mã được giữ **nguyên văn** như trong CSDL (ví dụ `OrgCTCHUNG.STT_REC`). Chỗ nào là **suy luận** (không đọc trực tiếp được từ tài liệu/mã) sẽ ghi rõ *(suy luận)*. Vài con số trong đề bài (86 loại chứng từ, 247 dòng trợ giúp) thực ra là số **dòng** CSV vì ô text có xuống dòng; số bản ghi thật là **43 loại chứng từ** và **29 bản ghi trợ giúp** – xem §5 và §11.

---

## Mục lục

1. Tổng quan kiến trúc
2. Cây menu đầy đủ
3. Danh mục (master data)
4. Số dư đầu kỳ
5. Chứng từ (voucher)
6. Mô hình dữ liệu giao dịch
7. Quy trình cuối kỳ
8. Giá thành / vụ việc / công trình / định mức / hợp đồng
9. Thuế
10. Báo cáo
11. Tiện ích / kiểm soát
12. Lịch sử tính năng 2011 → 2026
13. Đánh giá & danh sách nghiệp vụ bắt buộc cho phần mềm mới

---

## 1. Tổng quan kiến trúc

### 1.1 Nền tảng kỹ thuật

| Thành phần | Mô tả (quan sát được) |
|---|---|
| Front-end | Một file **MS Access `KT.mde`** (mã VBA đã biên dịch) chứa 941 form, 770 report, 32 module. Chạy trên Access 2003 runtime hoặc Access 2007–2016 full. Yêu cầu Windows 9x→10, bộ gõ tiếng Việt, font Tahoma/Times New Roman. Phiên bản 2021 vẫn hướng dẫn cài Access 2003 Runtime khi máy có Office 2007/2010. |
| Dữ liệu | Jet **`.mdb`**, **một file dữ liệu cho mỗi năm tài chính** (template `KTSTRUC.mdb` → ví dụ `KT2022.mdb`). File MDE liên kết (linked tables) tới 119 bảng của năm đang làm việc (trong `MSysObjects` có 119 object Type=6 = bảng liên kết). Chọn năm làm việc bằng `Hệ thống\ Chọn năm làm việc` (form `SYS_CHONNAM`, `SYS_CHANGE_DATABASE`). |
| CSDL phụ | `AppInfo.mdb` (bảng `AppUser`, `AppGroup`, `AppSysVar` – người dùng, nhóm, tham số hệ thống); `ktdv.mdb` (bảng `DesDataPath(ID, TEN_CSDL, DATA_PATH)` – danh sách bộ số liệu/đơn vị và đường dẫn); `Appst.mdb` cùng cấu trúc AppInfo (bản lưu/mẫu). |
| Mã hóa | Tiếng Việt lưu Unicode (có bản ghi `OrgSYS_UPDATE: UPDATE_UNICODE 29/03/2016`); các bản trước 2016 dùng font ABC/TCVN3 (các trang help "Đặt lại font chữ"). |
| Module VBA | `Ketoan_Modul, Vattu_Modul, TSCD_Modul, CCDC_Modul, VuViec_Modul, GiaThanh_Modul, HopDong_Modul, VAT_Modul, BCTC_Modul, SuaCT_Modul, Tien_Ich, Utility_Modul, BackUp_Modul, Security_Modul, SerialNumber, NangCap, ConvertData_Modul, ExcelExport, DoiSoChu_Modul, TreeView, Unicode, DateTime_Modul, SetDateNumber_Modul, SetProperties_Modul, Help_Modul, KetThuc_Modul, Option, Syslib, APIFunctions_Modul, Access_Error_Modul, Window_Folder, Window_Version`. Tên module phản ánh ranh giới phân hệ. |
| Quy ước đặt tên bảng | `Org*` = dữ liệu thật (`OrgDM*` danh mục, `OrgCT*` chứng từ, `OrgDauKy*` số dư đầu kỳ, `OrgHOPDONG*`, `OrgDINHMUC_VT`); `Des*` = thiết kế/cấu hình (`DesBC_*` định nghĩa dòng BCTC theo chế độ, `DesHT_*` sơ đồ kết chuyển/phân bổ, `DesDataErr`, `DesSysVar`, `DesAppAction`); `Tmp*` = bảng tổng hợp/cân đối trung gian (`TmpCDOTK`, `TmpCDOCN`, `TmpCDOVT`, `TmpCDOTS`, `TmpCDOCC`, `TmpTHOPCT_TK`, `TmpVT_DGX*`). |
| Khóa chính | Hầu hết dùng `SERIAL` (AutoNumber): `STT_REC` cho chứng từ, `BT_ID`, `VT_ID`, `HD_ID`, `TS_ID`, `CC_ID`… Danh mục dùng mã nghiệp vụ làm PK (`MA_KHG`, `MA_VT`, `TK_TI`…). **Không có khóa ngoại/relationship** trong CSDL (MDB Tools báo "No MSysRelationships") – toàn vẹn dữ liệu do VBA đảm bảo. |

### 1.2 Đa người dùng LAN

- Dữ liệu đặt trên máy chủ (thư mục chia sẻ), mỗi máy trạm cài chương trình. Hướng dẫn: `Hệ thống\ Bảo trì dữ liệu` (compact file dữ liệu, chỉ chạy khi không có người khác dùng) và `Hệ thống\ Bảo trì chương trình` (chạy trên từng máy), khuyến nghị 1 tuần/lần.
- Lưu vết theo máy: hầu hết bảng có `NGAY_NHAP_DL, NGUOI_NHAP_DL, MAY_NHAP_DL, NGAY_SUA_DL, NGUOI_SUA_DL, MAY_SUA_DL`; riêng `OrgCTCHUNG` còn có `GIO_NHAP_DL, NGAY_XOA_DL, GIO_XOA_DL, NGUOI_XOA_DL, MAY_XOA_DL, USER_NAME`.
- Cảnh báo "Không nên mở nhiều lần một chương trình"; lỗi `Max Lock` của Jet từng được xử lý (changelog 13/03/2023).

### 1.3 Đăng nhập, phân quyền (`AppInfo`)

```
AppUser(USERNAME v20, USERFULLNAME v50, USERPASSWORD v10, GROUPNAME v20,
        SUA b, XOA b, MOI b, XACNHAN b, SUA_SAUXACNHAN b, XEMGV b, XEM131 b, XEM331 b)
AppGroup(GROUPNAME v20, GROUPCANNOT text)          -- danh sách MỤC MENU BỊ CẤM của nhóm
AppSysVar(TENBIEN v20, GIATRI v100, GROUPNAME v20) -- tham số hệ thống (có thể theo nhóm)
```

- Tài khoản mặc định `sa`, mật khẩu trống. Mật khẩu tối đa 10 ký tự, cột `USERPASSWORD VARCHAR(10)` → *(suy luận)* lưu plain-text hoặc mã hóa rất đơn giản.
- **Mô hình quyền = blacklist menu theo nhóm** (`GROUPCANNOT`) + 8 cờ theo người dùng: tạo mới (`MOI`), sửa (`SUA`), xóa (`XOA`), xác nhận chứng từ (`XACNHAN`), sửa sau khi đã xác nhận (`SUA_SAUXACNHAN`), xem giá vốn (`XEMGV`), xem công nợ 131 / 331 (`XEM131`, `XEM331`). Trang giới thiệu nói quyền "tới từng người, từng chức năng, từng modul nhập liệu: tạo mới, sửa, xóa, xem, xem giá vốn, in".
- Mã số cài đặt (serial) theo "Mã số khách hàng" của máy (form `SYS_SERIALNUMBER`, module `SerialNumber`).
- Nhật ký sử dụng: bảng `DesAppAction(ACT_ID, USERNAME, COMPUTER_NAME, NGAY_TRUYNHAP, GIO_TRUYNHAP, HOAT_DONG)`; từ 25/08/2012 ghi cả xóa chứng từ/số dư đầu kỳ; 05/11/2014 cho sao lưu nhật ký ra file text. Form `SYS_ACTION`.

### 1.4 Tham số hệ thống (`AppSysVar` – 63 biến mẫu)

| Nhóm | Biến mẫu | Ý nghĩa |
|---|---|---|
| Chế độ kế toán | `CHEDOKT=133` | Chế độ BCTC đang dùng (15/48/244/138/133/200/99). |
| Tài khoản ngầm định | `TKTienMatVND=1111, TKTienGuiVND=1121, TKTienMatNTE=1112, TKTienGuiNTE=1122, TKNoPhaiThu=131, TKNoPhaiTra=331, TKVATDauVao=1331, TKVATDauRa=33311, TKVATNhapKhau=33312, TKThueNhapKhau=3333, TKThueTTDB=3332, TKDoanhthuPX=5111, TKDTHUDICHVU=5111, TKGiavonPX=632, TKGIAVONPXK=632, TKXUATSUDUNG=632, TKHangNhapLai=5111, TKGIAMGIAPX=5111, TKChietKhauPX=5111, TKKhuyenMaiPX=5111, TKHOTROPX=5111, TKChietKhauPN=711, TKKhuyenMaiPN=711, TKDVUTHUENGOAI=6422` | Dùng cho nút **Lập bút toán** tự động trên từng loại chứng từ. |
| Chứng từ trùng | `CTuTrgNo = PC,PCN,BN,BNN,UC,PX,PXT,PXGC,PXL,HB,GTS,CCG` ; `CTuTrgCo = PT,PTN,BC,BCN,PN,PNK,PNL,PNGC,HM,TTS,CCT` | Hai danh sách mã chứng từ tạo thành cặp **khử trùng** (xem §6.6). |
| Thuế | `TYLETHUETNDN=20`, `VAT_MACDINH=10`, `LUUSOHDBAN=TRUE` (tự tăng số hóa đơn bán), `CHUYENSOHD=TRUE` (chuyển số HĐ lên mục chứng từ gốc), `SuDungCTGoc=TRUE` |  |
| Ngoại tệ | `NTE_MACDINH=USD`, khuôn dạng `KhuonDangTienNTE` |  |
| TSCĐ/CCDC | `TSCD_PBCHITIET=-1`, `CCDC_PBCHITIET=-1` | Lập chứng từ khấu hao/phân bổ **chi tiết từng tài sản** hay gộp theo cặp TK. |
| Nhập liệu | `SuDungVuViec`, `SuDungNV`, `CTUTIENMAT`, `CTUTIENGUI`, `LUUVETLOC`, `LOAIXUATTHANG=PXS` (mã phiếu xuất thẳng), `IN_NHANDU_TIEN`, `HienFootDate`, `KHAINGUOILAPBIEU`, `HIENCHUCDANH`, `NGAYKYHIENTAI` |  |
| Mẫu in | `MauPhieuThu, MauPhieuChi, MauPhieuNhap, MauPhieuNhapKhau, MauPhieuXuat, MauPhieuXuatBKE, MauPhieuXuatBBGN, MAUHOADONGTGT, MAUBKEPT, MAUBKEPC` | Số thứ tự mẫu in mặc định. |
| Định dạng số | `KHUONDANGSO, KHUONDANGTIEN, KHUONDANGGIABAN, KHUONDANGGIANHAP, KHUONDANGGIAVON` = chuỗi format Access (`#,##0.00;-#,##0.00[Red]`) |  |
| Đơn vị | `TENCTY` | Tên công ty in trên báo cáo. |

Ngoài ra `OrgSysFormVar` (50 cột: `FORM_NAME, TIEUDE_BC, THANGDAU, THANGCUOI, NGAYDAU, NGAYCUOI, MA_DONVI, MA_VV, TK_TI, MA_KHG, NHOM_KHG, MA_DOI, MA_BOPHAN, MA_NHANVIEN, MA_CHIPHI, MA_KHO, DS_KHO, KHO_N, KHO_X, MA_VT, NHOM_VT, NHOM_SP, TYGIA_NTE, MAU_REP, KHO_GIAY, LAYSODU, PATHNAME, MAU_SO, QD_SO, NGAY_KY, MA_CT, DS_MA_CT, DS_TK_NO, DS_TK_CO, LOAI_THOP, MA_TS, MA_CC, LOAI_HD, NHOM_MUA, NHOM_BAN, TYLE_VAT_MIN/MAX, MA_THUE…`) lưu **tham số lọc lần cuối của từng form báo cáo** – một cơ chế "nhớ bộ lọc" đáng học.

### 1.5 Sao lưu, phục hồi, khóa dữ liệu

- `Hệ thống\ Lưu dữ liệu dự phòng` (`SYS_BACKUP`, `SYS_BACKUP_DIRECT`): tạo bản nén toàn bộ CSDL năm. Tự động: đầu ngày/cuối ngày, khi `Kết thúc` (hỏi "Có lưu dự phòng"), và theo khoảng thời gian (phút) khai trong `Khai báo thông tin hệ thống`. Trước khi `Bảo trì số liệu` cũng lưu thêm một bản (18/03/2022). Tên file lưu đầu ngày có cấu trúc riêng (02/01/2013). *(Đề bài gọi là file `.dat`; tài liệu chỉ nói "dạng nén".)*
- `Khôi phục dữ liệu từ bản lưu` (`SYS_RESTORE`): khi không tìm thấy CSDL, chương trình đề xuất "Khởi tạo mới" hoặc "Khôi phục từ bản sao lưu".
- `Khóa dữ liệu` (`SYS_LOCK`, `SYS_OPEN_LOCK`): khóa **theo phần hành** (bật "Có/Không" từng tiêu chí), theo **tháng/ngày**, và **tự động khóa chứng từ sau N ngày kể từ khi nhập**. Khóa cả khi chuyển năm làm việc (20/02/2022). 22/01/2024 thêm "Khóa danh mục không sửa, xóa". Khóa cũng dùng để chặn "chuyển số dư năm sau" ghi đè phần đã chốt.
- `Xác nhận chứng từ` (ghi sổ) – cột `OrgCTCHUNG.XACNHAN`; quyền `XACNHAN`, `SUA_SAUXACNHAN`; tiện ích `CT_XACNHAN` xác nhận hàng loạt; dùng để loại chứng từ đã soát khỏi lần soát lỗi sau.
- Lưu vết chứng từ sửa/xóa: `CT_DS_SUA`, `CT_DS_XOA`; cờ `CTU_XOA` (bản có lưu chứng từ đã xóa), `CTU_KP` (đã khôi phục sau xóa).

### 1.6 Tạo năm mới, chuyển số dư, nhiều đơn vị

- `Hệ thống\ Tạo số liệu năm mới` (`SYS_TAO_NAMMOI`): tạo CSDL năm mới **chỉ gồm danh mục** của năm trước (căn cứ đồng hồ hệ thống). `SYS_TAO_DONVI` tạo bộ số liệu độc lập (đơn vị khác); `Tiện ích\ Nhập khẩu danh mục` đồng bộ danh mục giữa các năm.
- Chuyển số dư sang năm sau làm **riêng từng phần hành**, từ CSDL năm cũ: `Tổng hợp\ Chuyển số dư tài khoản / khách hàng / tồn kho vật tư / TSCĐ / CCDC / vụ việc / hợp đồng sang năm sau` (form `HACHTOAN_CHUYEN_TK_NAM, _CN_NAM, _VT_NAM, _TS_NAM, _CC_NAM, VV_CHUYEN_SODU`, hợp đồng dùng `OrgHOPDONG.OLD_ID`). Điều kiện: đã cân đối/kết chuyển hết tháng 12 phần hành đó. Có thể chạy lại nhiều lần; muốn giữ phần nào thì khóa phần đó ở năm mới. TSCĐ/CCDC có lựa chọn "chuyển tất cả" hoặc "chỉ chuyển cái còn giá trị".
- "Báo cáo xem nhiều năm" (`SO_NGAY_LIST`): đứng tại một năm xem sổ từ ngày–đến ngày xuyên nhiều file năm (ví dụ 2010→2025); không sửa được chứng từ năm khác nếu chưa chuyển kết nối.
- `Cập nhật cấu trúc dữ liệu` (`SYS_STRUC_UPGRD`, `SYS_STRUC_NEW`, module `NangCap`): nâng cấp schema cho các năm được chọn khi có phiên bản mới; `SYS_NHATKY_NANGCAP` hiển thị nhật ký nâng cấp (bảng `OrgDMUPDATE`).

### 1.7 Các chế độ kế toán hỗ trợ và cách chọn

| Chế độ | Bảng định nghĩa BCTC | Ghi chú |
|---|---|---|
| QĐ 15/2006 | `DesBC_CDKT_B01_15`, `DesBC_KQKD_LAILO_15`, `DesBC_KQKD_NVU_15`, `DesBC_LCTT_TTIEP_15` | Form `BC_BGCDKT_15`, `BC_KQKD_15`, `BC_LCTT_15` |
| QĐ 48/2006 | `*_48` | DN nhỏ và vừa |
| TT 244/2009 (sửa QĐ15) | `*_244` |  |
| TT 138/2011 (sửa QĐ48) | `*_138` | thêm 26/11/2011 |
| TT 200/2014 | `*_200` | HTTK mẫu `OrgDMTK_200` (243 TK) |
| TT 133/2016 | `DesBC_CDKT_B01A_133`, `B01B_133`, `B01SN_133` (siêu nhỏ), `DesBC_KQKD_LAILO_133`, `_SN_133`, `DesBC_KQKD_NVU_133`, `DesBC_LCTT_TTIEP_133` | thêm 28/12/2016; HTTK mẫu `OrgDMTK` (133 TK); `CHEDOKT=133` mặc định |
| TT 99/2025 | `DesBC_CDKT_B01_99`, `DesBC_KQKD_LAILO_99`, `DesBC_LCTT_TTIEP_99` | thêm 11/11/2025 (chỉ có trong `KTSTRUC`, chưa có trong `KT2022`) |

Cách chọn: `Hệ thống\ Khai báo thông tin hệ thống` (`SYS_VARIABLES`, `SYS_VARIABLES_OPTION`) đặt `CHEDOKT`; menu Báo cáo có từng nhóm "Báo cáo tài chính QĐ48/QĐ15/TT133/TT200…"; mẫu số/quyết định số in trên sổ lấy từ `OrgDMMAUBC(FORM_NAME, SO_QD, MAU_SO, QD_SO)` và `OrgDMCT.MAU_SO/QD_SO`. Hệ thống tài khoản mỗi năm là dữ liệu (`OrgDMTK`) nên người dùng có thể dùng HTTK TT200 với BCTC TT133 – tài liệu cảnh báo tránh lệch pha này.

---

## 2. Cây menu đầy đủ

Tổng hợp từ `SUNSOFT.hhc`, mục lục manual, trang help và tên form. Dấu `→` = tên form chính.

```
Hệ thống (SYS_*)
├─ Khởi động/Đăng nhập (SYS_LOGIN) · Đăng nhập lại · Chọn năm làm việc (SYS_CHONNAM) · Chọn CSDL/đơn vị (SYS_CHANGE_DATABASE)
├─ Khai báo thông tin hệ thống (SYS_VARIABLES / SYS_VARIABLES_OPTION)
│    tab: Thông tin chung · Tài khoản ngầm định · Lựa chọn nhập liệu · Lựa chọn VAT · Lựa chọn TSCĐ · Lựa chọn báo cáo · Lựa chọn khác
├─ Quản lý người dùng (SYS_USER_ADD/CHANGE, SYS_GROUP_ADD/CHANGE, SYS_SECURITY) · Thay đổi mật khẩu (SYS_USER_PASSWORD)
├─ Khóa dữ liệu (SYS_LOCK) · Mở khóa (SYS_OPEN_LOCK)
├─ Lưu dữ liệu dự phòng (SYS_BACKUP) · Khôi phục dữ liệu (SYS_RESTORE)
├─ Bảo trì dữ liệu (SYS_COMPACT) · Bảo trì chương trình
├─ Cập nhật cấu trúc dữ liệu (SYS_STRUC_UPGRD) · Tạo số liệu năm mới (SYS_TAO_NAMMOI) · Tạo đơn vị (SYS_TAO_DONVI) · Xóa CSDL (SYS_DELETE_DATABASE)
├─ Nhật ký sử dụng (SYS_ACTION) · Nhật ký nâng cấp (SYS_NHATKY_NANGCAP) · Kiểm tra Index chứng từ
├─ Đặt font Tiếng Việt, định dạng số, ngày · Đặt Security warning · Mã số cài đặt (SYS_SERIALNUMBER)
└─ Kết thúc (SYS_KETTHUC)

Danh mục (DM*)
├─ Tài khoản (DMTK, DMTK_DOIMA) · Chứng từ (DMCT) · Ngoại tệ (DMNTE) · Đơn vị (DMDONVI) · Bộ phận (DMBOPHAN) · Nhân viên (DMNHANVIEN)
├─ Nhóm khách hàng (DMKHG_NHOM) · Đội bán hàng (DMDOI) · Khách hàng (DMKHG) · Chi nhánh khách hàng (DMKHG_CN)
├─ Kho (DMKHO) · Chủng loại (DMCHUNGLOAI) · Hãng sản xuất (DMHANGSX) · Vật tư hàng hóa (DMVT) · Đơn giá bán (DMDGBAN) · Đơn giá nhập (DMDGNHAP)
├─ Tài sản cố định (DMTS) · Lý do tăng giảm (DMLYDO_TG) · Nguồn vốn (DMNGUONVON) · Công cụ dụng cụ (DMCC)
├─ Vụ việc công trình (DMVV) · Chi phí (DMCPHI) · Đối tượng tập hợp chi phí (DMDOITUONG) · Yếu tố chi phí (DMYEUTO)
├─ Dịch vụ (DMDICHVU) · Nhóm dịch vụ (DMDICHVU_NHOM) · Hình thức thanh toán (DMHTTT)
├─ Loại thuế (DMTHUE) · Nhóm hóa đơn mua (DMHDMUA) · Nhóm hóa đơn bán (DMHDBAN) · Mã hóa đơn/ký hiệu mẫu (DMMAHD) · Mã số thuế (DMMST) · MST bỏ trốn (DMMST_TRAIPHEP)
└─ Tàu/phương tiện (DMTAU) · Cung đường (DMCUNGDUONG)   [ngành vận tải]

Đầu kỳ (DAUKY_*)
├─ Lập quy trình hạch toán / sơ đồ kết chuyển, phân bổ (HACHTOAN_SETUP, _KC_CTU, _PB_CTU, _PB_BUTTOAN, _NAPMAU)
├─ Số dư đầu kỳ tài khoản (DAUKY_TK) · khách hàng/công nợ (DAUKY_CONGNO) · tồn kho (DAUKY_VT, DAUKY_VT1 theo lô NTXT/đích danh)
├─ TSCĐ đầu kỳ (DAUKY_TS) · CCDC đầu kỳ (DAUKY_CC) · Vụ việc đầu kỳ (DAUKY_VV)
└─ Định mức vật tư (DINHMUC_VT, _COPY, _SOATGIA, _THIEUGIA) · Bảng giá thành tạm tính (GT_BANGGIA_TT)

Chứng từ (CT1–CT4)
├─ Phiếu thu (CT3_PT) · Phiếu thu ngoại tệ (CT3_PTNTE) · Phiếu thu khác (CT3_PTX)
├─ Phiếu chi (CT3_PC) · Phiếu chi ngoại tệ (CT3_PCNTE) · Phiếu chi khác (CT3_PCX)
├─ Ủy nhiệm chi (CT4_UNC) · Giấy báo có (CT4_BC) · Giấy báo nợ (CT4_BN) · Báo có/nợ ngoại tệ (CT4_BCN, CT4_BNN)
├─ Hóa đơn bán hàng (CT2_HDB) · Hóa đơn mua hàng (CT2_HDM) · Hóa đơn mua hàng không qua kho (CT2_HDMX) · [HBX bán không qua kho]
├─ Phiếu bán dịch vụ (CT1_PDVB) · Phiếu mua dịch vụ (CT1_PDVM)
└─ Phiếu kế toán (CT1_PKT) – chứa cả chứng từ tự động KC/KH/CC (lọc theo mã)

Hàng hóa (CT5, CT6, VT_*)
├─ Phiếu nhập kho mua hàng (CT5_PN) · Nhập khẩu (CT5_PNK) · Nhập lại hàng bán trả lại (CT5_PNLAI) · Nhập khác (CT5_PNX) · Nhập chi phí (PNCP)
├─ Phiếu xuất kho bán hàng (CT5_PX) · Xuất điều chuyển kho (CT5_PXD) · Xuất trả lại hàng (CT5_PXTRA) · Xuất hủy (CT5_PXH) · Xuất biếu tặng (CT5_PXBIEU) · Xuất khác (CT5_PXX)
├─ Nhập vật tư gia công (CT6_PNGC) · Xuất vật tư gia công (CT6_PXGC) · Nhập kho sản phẩm/thành phẩm (CT6_PNSP) · Xuất cho sản xuất, sử dụng (CT6_PXSX) · Xuất định mức (CT6_PXDM)
├─ Cân đối vật tư, hàng hóa (VT_CDOVT) · Cập nhật đơn giá vốn phiếu xuất (VT_TINHDGXUAT) · Tồn kho (VT_TONKHO_*) · Tồn kho âm (VT_TONKHO_AM) · Hỏi số tồn (VT_HOISOTON_NHOM) · Kiểm kê (VT_KIEMKE)
└─ Báo cáo hàng hóa: Thẻ kho, Sổ chi tiết vật tư, NXT, mua hàng, bán hàng, doanh số, lãi gộp, nhập xuất, điều chuyển, giảm trừ, tra cứu giá… (xem §10)

Tài sản (CT7, CT8, TAISAN_*, CCDC_*)
├─ Phiếu tăng TSCĐ (CT7_TTS) · Giảm/thanh lý (CT7_GTS) · Điều chỉnh (CT7_DTS)
├─ Phiếu tăng CCDC (CT8_CCT) · Giảm (CT8_CCG) · Điều chỉnh (CT8_CCD)
├─ Cân đối tăng giảm TSCĐ (TAISAN_CDOTS) · Lập bút toán trích khấu hao (TAISAN_CTU_TRICHKH) · Xóa bút toán KH (TAISAN_XOA_TRICHKH) · Xem cân đối (TAISAN_XEMCD)
├─ Cân đối CCDC (CCDC_CANDOI) · Lập/xóa chứng từ phân bổ (CCDC_CTU_PB, _XOA)
└─ Báo cáo TSCĐ/CCDC: bảng trích KH, thẻ, sổ chi tiết, tăng giảm, kiểm kê, phân bổ năm, tổng hợp (xem §10)

Vụ việc / Giá thành (VV_*, GT_*, CP_*)  – chỉ hiện khi SuDungVuViec
├─ Bảng kê chứng từ theo vụ việc · Bảng kê NVL theo vụ việc · Sổ chi tiết phát sinh vụ việc · Cân đối phát sinh vụ việc / theo TK / theo khách
├─ Tập hợp chi phí (VV_TAPHOP_CHIPHI, VV_TAPHOP_154) · Chi phí dở dang (VV_CPDD_THOP) · KQKD vụ việc (VV_KQKD, VV_KQKD_621) · Số dư vụ việc (VV_SODU)
└─ Sổ chi tiết giá thành (GT_SO_CTIET, GT_SO_CTIET_154, GT_SO_CTIET_GT) · Bảng giá thành tạm tính · Sổ chi phí theo mã phí / SXKD (CP_*)

Hợp đồng (HOPDONG_*) – chỉ hiện khi khai "sử dụng hợp đồng"
├─ Hợp đồng mua (HOPDONG_MUA_MOI/XEM/LOC) · Hợp đồng bán (HOPDONG_BAN_*) · Hàng hóa theo hợp đồng (HOPDONG_HHOA) · Copy hợp đồng
└─ Sổ chi tiết hợp đồng · Sổ tổng hợp hợp đồng

Tổng hợp (HACHTOAN_*)
├─ Cân đối tài khoản (HACHTOAN_CANDOI_TK) · Cân đối công nợ (HACHTOAN_CANDOI_CN)
├─ Hạch toán cuối tháng (HACHTOAN_RUN, _RUN_KC, _RUN_PB, HACHTOAN_CTIET_KC)
├─ Chuyển số dư tài khoản sang tháng sau (HACHTOAN_CHUYEN_TK_THANG)
└─ Chuyển số dư TK / khách hàng / tồn kho / TSCĐ / CCDC / vụ việc / hợp đồng sang năm sau

Báo cáo (SO_*, NKC_*, BC_*, SOCONGNO_*, …)
├─ Sổ quỹ tiền mặt · Sổ tiền gửi NH · Sổ TM/TG ngoại tệ · Sổ tiền mặt/tiền gửi theo ngày · Nhật ký thu/chi tiền · Sổ tiền vay
├─ Sổ cái TK · Sổ chi tiết TK · Sổ chi tiết NVL (TK kho) · Bảng cân đối phát sinh TK (theo tháng/ngày/cộng cấp) · Bảng kê chứng từ
├─ Nhật ký chung · NK đặc biệt (mua, bán, thu, chi) · Sổ cái theo NKC
├─ Công nợ: Bảng cân đối công nợ (tháng/ngày) · Sổ chi tiết công nợ (nhiều mẫu, có hàng hóa) · Biên bản đối chiếu · Đến hạn thu/trả · theo nhóm/nhân viên
├─ Thuế GTGT: Bảng kê mua vào / bán ra (xuất HTKK) · Tờ khai 01/GTGT · Điều chỉnh · BC tình hình sử dụng hóa đơn · Quyết toán TNDN
├─ Báo cáo tài chính theo chế độ: Bảng CĐKT · KQKD · Nghĩa vụ ngân sách · LCTT trực tiếp · Thuyết minh (chi tiết TK) · Nạp công thức
├─ Chi phí (theo mã phí, SXKD, năm) · Dịch vụ (mua/bán chi tiết, tổng hợp)
├─ Báo cáo in liên tục (SO_LIENTUC_LIST) · Báo cáo xem nhiều năm (SO_NGAY_LIST)
└─ Danh mục (in) · Số dư đầu kỳ (in)

Tiện ích (CT_*, SYS_CTU_LECH*, SYS_DATAERR*)
├─ Kiểm tra, soát lỗi chứng từ · Kiểm tra chênh lệch chứng từ · Kiểm tra hóa đơn và bút toán thuế · Chứng từ thiếu bút toán · Kiểm tra Index
├─ Tìm MST bỏ trốn · Tra cứu giá mua, giá bán · Xác nhận chứng từ · Copy (nhân bản) chứng từ · Cố định giá vốn
├─ Đánh lại số phiếu · Xóa số phiếu · Xóa số dư đầu kỳ · Xóa chứng từ khỏi bản dữ liệu · Xóa các bảng cân đối
├─ Nhập khẩu / xuất khẩu chứng từ (giữa các bản dữ liệu) · Nhập khẩu danh mục · Nhập khẩu số dư đầu kỳ · Nhập khẩu bảng kê hóa đơn (Excel) thành chứng từ
├─ Cập nhật: giá nhập, giá vốn, KM, mã HĐ/ký hiệu mẫu, số HĐ, số PX, STT khoản, tên mặt hàng, bút toán PX, chuyển số HĐ lên chứng từ gốc
└─ Xem danh sách chứng từ có sửa · đã xóa

Trợ giúp: Hướng dẫn sử dụng (CHM, nút ? trên mọi cửa sổ – bảng OrgDMTROGIUP) · Danh ngôn (OrgDMDANHNGON) · Giới thiệu · Liên hệ
```

Quy tắc phím: Alt+chữ gạch chân, Enter/Tab di chuyển ô, Alt+↓ mở combo, **F4** tìm kiếm trong ô mã, **F5** làm tươi danh mục sau khi bổ sung, nhập mã mới chưa có + Enter → hỏi bổ sung danh mục ngay.

---

## 3. Danh mục (master data)

Hai kiểu cửa sổ: **danh mục phân nhóm (cây)** – tài khoản, vật tư, TSCĐ, CCDC, vụ việc; và **danh mục thường** (lưới). Mọi danh mục đều có Bổ sung/Sửa/Xóa/In/Xuất Excel/Ghép mã (xóa mã chỉ khi không còn dữ liệu liên quan; ghép hai mã = đổi mã cũ thành mã mới trên toàn bộ dữ liệu rồi xóa). Nhiều danh mục có "Mở khóa" để copy/paste từ Excel. Quy tắc mã: không dấu, không khoảng trắng, không ký tự `* / \ + - = ' "`, ngắn; mã cây nên đánh số cố định độ dài (112101…112199, không 11211/112110).

### 3.1 Hệ thống tài khoản – `OrgDMTK` (PK `TK_TI`)

| Cột | Kiểu | Ý nghĩa |
|---|---|---|
| `TK_TI` | V15 | Số hiệu tài khoản (cũng là mã). TK con phải bắt đầu bằng số hiệu TK mẹ. |
| `TEN_TK`, `TEN_TK_E` | V150 | Tên Việt / Anh. |
| `LOAI_DU` | V1 | Loại dư: `N` dư Nợ, `C` dư Có, `L` lưỡng tính, trống = không có số dư (TK 5–9, TK mẹ). Dùng để kiểm tra khi nhập số dư đầu kỳ (chỉ cho nhập đúng bên) và tổng hợp. |
| `TK_NTE` | B | Có theo dõi ngoại tệ (song song VND + nguyên tệ). Mẫu: 1112, 1122. |
| `CHI_TIET` | S | 1 = TK chi tiết (lá, được định khoản & nhập số dư); 0 = TK tổng hợp (chỉ để lên báo cáo). Mở TK con đầu tiên cho một TK chi tiết → TK đó tự chuyển thành tổng hợp và **mọi chứng từ đã định khoản vào nó được chuyển sang TK con đầu tiên**. |
| `NHOM_ME` | V8 | TK mẹ. |
| `CAP_TK` | I | Cấp 1..8. |
| `TC_KHAC` | V5 | **Tính chất khác**: `CN` = theo dõi công nợ (bắt buộc mã khách trên bút toán, có bảng cân đối công nợ, 2 số dư); `VT` = theo dõi vật tư chi tiết (TK kho: 152,153,154,155,156,157,158); `TS` = theo dõi TSCĐ (2111,2112,2113…). |
| `TK_CP`, `TK_VV` | B | TK có theo dõi mã chi phí / mã vụ việc (bật cột tương ứng khi hạch toán). |
| `SO_TK_NH`, `TEN_TK_NH`, `TEN_CN_NH`, `THANH_PHO` | | Số tài khoản ngân hàng, tên, chi nhánh gắn với TK 112x – dùng in Ủy nhiệm chi và Biên bản đối chiếu công nợ. |
| `STT`, `GHI_CHU`, lưu vết | | |

Hai bộ mẫu: `OrgDMTK` theo **TT133** (133 TK; 131/331 = CN; 152–157 = VT; 2111–2113 = TS) và `OrgDMTK_200` theo **TT200** (243 TK; thêm 1113, 113x, 121x, 128x, 136x, 1531–1534, 1551/1552, 1561/1562/1567, 158, 161x, 171, 2111–2118, 212x, 213x, 221, 222, 243, 244, 337, 343x, 344, 347, 357, 41111/41112, 4113, 412, 4131/4132, 414, 417, 441, 461x, 466, 5114, 5117, 5211–5213, 6111/6112, 621, 622, 623x, 627x, 641x, 642x chi tiết, 8211/8212). Nhánh gốc: `N` TS ngoài bảng, 1 TSLĐ, 2 TSCĐ, 3 Nợ phải trả, 4 Vốn CSH, 5 Doanh thu, 6 Chi phí SXKD, 7 Thu nhập khác, 8 Chi phí khác, 9 KQKD.

Thao tác đặc biệt: **Thay đổi số hiệu tài khoản chi tiết** + **Ghép hai mã** (form `DMTK_DOIMA`) cho phép đổi số hiệu, dời TK sang mẹ khác, gộp TK cấp 3 về cấp 2 (ví dụ help: ghép 1541–1544 về 154) – sau đó phải chạy Cân đối tài khoản lại từ tháng đầu.

### 3.2 Danh mục chứng từ – `OrgDMCT` (PK `MA_CT`)

`MA_CT v4, TEN_CT, NHOM_CT v6 (A-TM tiền mặt | B-NH ngân hàng | C-VT vật tư | D-HD hóa đơn | E-TS tài sản/CCDC | F-PKT phiếu kế toán & tự động), PS_CT, STT (1 = dòng thu/nhập, 2 = dòng chi/xuất, 98/99 = tự động), TK_CT (TK mặc định phần chung, ví dụ PT/PC = 1111, BC/BN = 1121, HB = 131, HM = 331), MA_NTE, MA_THUE (loại hóa đơn mặc định), MAU_PHIEU, SO_LIEN, SUDUNG_HD (dùng hợp đồng), SUDUNG_NV (dùng nhân viên), SUDUNG_CTUGOC (dùng chứng từ gốc), MAU_SO ("Mẫu số 01 - TT"…), QD_SO (dòng "Ban hành theo TT 133/2016…"), NHIEU_TK, NHIEU_NTE, NHIEU_KHO, HIEN_NGAYIN, HIEN_NGUOILAP, SOCT_THANG (đánh số theo tháng), TIEU_DE, DIEN_GIAI (diễn giải mặc định khi nhập mới), GHI_CHU_MD`. Một số mã chương trình dùng nội bộ không xóa được. Danh sách 43 mã: §5.1.

### 3.3 Khách hàng/đối tượng – `OrgDMKHG` (PK `MA_KHG` v25)

Dùng chung cho **mọi đối tượng chi tiết** của TK có `TC_KHAC='CN'` (khách hàng, nhà cung cấp, nhân viên tạm ứng 141, nội bộ 336/338, khế ước vay…). Tùy chọn hệ thống "Một mã khách dùng cho nhiều tài khoản" (nếu tắt: danh sách khách lọc theo `TK_TI` ngầm định của khách).

| Nhóm cột | Cột |
|---|---|
| Định danh | `MA_KHG, TEN_KHG v255, TK_TI` (TK công nợ ngầm định, bắt buộc), `CONGTY` (là công ty/cá nhân), `CO_SD` (còn sử dụng) |
| Liên hệ/in hóa đơn | `HOTEN_GD, HOTEN_KTT, NGUOI_LIENHE` (→ "người mua hàng" trên hóa đơn), `DIA_CHI, DIA_CHI_GIAOHANG, QUAN_HUYEN, TINH_TP, THANH_PHO, MASO_THUE, TEL, FAX, EMAIL, SO_CCCD, NGAY_CAP_CCCD, NOI_CAP_CCCD, NGAY_SINH` (CCCD thêm 07/2025 cho hóa đơn cá nhân) |
| Phân tích | `MA_NHOM` (nhóm khách), `MA_BOPHAN`, `MA_NHANVIEN` (NV phụ trách, tự điền vào chứng từ), `MA_DOI` (đội bán hàng), `MA_VV`, `NTE/MA_NTE` |
| Tín dụng | `SONO_TOIDA, NO_HIENTAI, THOIHAN_THANHTOAN` (ngày, mặc định cho chứng từ), `THU_TUNGAY, THU_DENNGAY` (lịch thu nợ), `MUC_CK` |
| Khế ước vay | `KHE_UOC, SO_KHE_UOC, NGAY_VAY, NGAY_DH, LAI_SUAT, LAI_SUAT_QH, TIENVAY_VND, TIENVAY_NTE, TRANG_THAI` – theo dõi từng khế ước như một "khách" của TK 341 (sổ tiền vay `SO_TIENVAY_*`) |
| Ngân hàng (UNC) | `SO_TK_NH, TEN_TK_NH, TEN_CN_NH` |
| Khác | `HOADON_DACBIET` (khách có hóa đơn đặc biệt), `NHAN_VIEN` (khách là nhân viên – dùng bảng lương), `HOTEN_BO/ME, DIENTHOAI_BO/ME` (khách hàng là học sinh – tùy biến cho trường học), lưu vết |

Bảng phụ: `OrgDMKHG_NHOM(MA_NHOM, TEN_NHOM)`; `OrgDMKHG_CN` (chi nhánh của khách: `MA_CHINHANH, TEN_CHINHANH, DIA_CHI, DIA_CHI_GIAOHANG, MASO_THUE, DIEN_THOAI, FAX, EMAIL, NGUOI_LIENHE, MA_KHG, SO_TK_NH, TEN_TK_NH, THANH_PHO`) – công nợ theo dõi ở khách mẹ, hàng giao cho chi nhánh (METRO Thăng Long/Hoàng Mai…); `OrgDMDOI(MA_DOI, TEN_DOI)`; `OrgDMMST(MASO_ID, MASO_THUE, TEN_KHG, DIA_CHI)` tra cứu MST khi nhập hóa đơn; `OrgDMMST_TRAIPHEP` (MST bỏ trốn: `TEN_CONGTY, NGAY_THUCHIEN, GIAM_DOC, SO_CMT, COQUAN_THUE, MUC_CANHBAO, THONGBAO_SO`).

### 3.4 Vật tư, hàng hóa, sản phẩm – `OrgDMVT` (PK `MA_VT` v20)

| Cột | Ý nghĩa |
|---|---|
| `MA_VT, TEN_VT v255, TEN_VT2, DANH_DIEM` | Mã, tên, tên 2, danh điểm |
| `DVT, DVT2, HESO_DVT2, DVT3, HESO_DVT3` | **Đa đơn vị tính** (1 hộp = 12 chiếc); xuất/nhập theo ĐVT1 hoặc ĐVT2; tùy chọn mặc định ĐVT2 (10/2024). Danh mục ĐVT riêng `OrgDMDVT(DVT, GHI_CHU)`. |
| `CHI_TIET, NHOM_ME, STT` | Cây nhóm hàng. |
| `LOAI v2` | Loại (NVL/hàng hóa/thành phẩm…) *(giá trị không quan sát được)* |
| `NTE` | Theo dõi giá ngoại tệ |
| `BUOC_SX` | Bước sản xuất: 1 = SP làm trực tiếp từ NVL; 2 = SP từ NVL + SP cấp 1… (giá thành nhiều cấp) |
| `GT_KH` | Giá thành kế hoạch |
| `THUE_SUAT, THUE_NK, THUE_DB` | Thuế suất GTGT, nhập khẩu, TTĐB mặc định của mặt hàng |
| `KHONGTINH_NXT` | **Không tính vào NXT**: hàng "dịch vụ" (phí vận chuyển, công lắp đặt) vẫn xuất được dù không tồn; có tùy chọn lập bút toán doanh thu dịch vụ riêng |
| `UYTHAC_DAILY` | Hàng XNK ủy thác / đại lý hưởng hoa hồng (ảnh hưởng tờ khai GTGT) |
| `MA_HANG` (hãng SX), `MA_CHUNGLOAI` | Danh mục phụ `OrgDMHANGSX`, `OrgDMCHUNGLOAI` |
| `THANH_PHAN, HAN_DUNG (tháng), VITRI_KHO, SL_TON_MIN, SL_TON_MAX` | Dược phẩm/thực phẩm: thành phần hoạt chất, hạn dùng (tự tính từ ngày SX), vị trí kho, tồn min/max |
| `DG_BAN_LE, DG_BAN_BUON, DG_NHAP` | Giá tham chiếu |
| `SD_BC` | Cờ chọn nhóm khi lập báo cáo |

Bảng giá: `OrgDMDGBAN(VT_ID, THANG, MA_KHG, MA_VT, MA_SIEUTHI, DVT, DG_BAN, DG_BAN2, DG_BAN3 (+_NTE), DG_GG (đơn giá giảm giá), TYLE_CK, PHI_XD (lệ phí xăng dầu), NGAY_BAN, NGUOI_BAN, MAY_BAN)` – giá bán theo tháng, theo khách (hoặc chung), theo ĐVT; nút "Tạo bảng giá" copy giá từ khách khác; `OrgDMDGNHAP(…DG_NHAP, DG_NHAP2, TYLE_CK, PHI_XD…)` giá nhập lần cuối theo NCC. Khi bật "Lưu đơn giá nhập/bán" chương trình tự lấy giá lần cuối ra chứng từ và hỏi lưu khi giá đổi. `MA_SIEUTHI` = mã hàng theo hệ thống siêu thị của khách.

### 3.5 Kho – `OrgDMKHO` (PK `MA_KHO` v8)

`MA_KHO, TEN_KHO, TK_TI` (TK kho 152/153/155/156/157 – **khuyến nghị mở kho theo tài khoản**), `PP_DGX v1` (**phương pháp tính đơn giá xuất của kho**: bình quân gia quyền / đích danh / nhập trước xuất trước), `KHO_GB` (kho gửi bán), `DIA_CHI, CO_SD, GHI_CHU`. Giá vốn tính **theo từng kho, từng tháng**; các kho trong một hệ thống có thể dùng phương pháp khác nhau. Tối thiểu 1 kho; kho không cần trùng kho vật lý.

### 3.6 TSCĐ – `OrgDMTS` (PK `MA_TS` v25) và CCDC – `OrgDMCC`

`OrgDMTS: MA_TS, TEN_TS v150, DVT, MA_NGUONVON (→ OrgDMNGUONVON: BSUNG, KHAC, NSACH, TCO, VAY), THONG_SO (thông số kỹ thuật), NUOC_SX, NAM_SX, NGAY_SD (ngày đưa vào sử dụng), NGAY_DC, LYDO_DC (ngày/lý do đình chỉ), GHI_CHU, CHI_TIET, NHOM_ME, COINBC (có in ra báo cáo khi đã khấu hao hết), STT`. Nhóm mẫu: `KHAC, MM (máy móc), NC (nhà cửa), PT (phương tiện), TB (thiết bị quản lý)`. Phụ tùng kèm theo: `OrgDMTS_PT(PT_ID, STT_PT, MA_TS, TEN_PT, DVT, SL, GIA_TRI)` (1-n). Lý do tăng giảm: `OrgDMLYDO_TG(MA_TG, TEN_TG, LOAI_TG 1 tăng/2 giảm/3 điều chỉnh)`.

`OrgDMCC: MA_CC v25, TEN_CC, DVT, NUOC_SX, NAM_SX, NGAY_PB (ngày bắt đầu phân bổ), GHI_CHU, CHI_TIET, NHOM_ME, STT`. Mã TS/CC được nới từ 10 lên 25 ký tự (04/2022).

Lưu ý mô hình: danh mục TS/CC **chỉ giữ thuộc tính tĩnh**; nguyên giá, khấu hao, TK, bộ phận, vụ việc nằm ở số dư đầu kỳ (`OrgDauKyTS/CC`) và chứng từ tăng (`OrgCTTS/CC`), còn trạng thái từng tháng ở bảng cân đối `TmpCDOTS/CC`.

### 3.7 Vụ việc / công trình – `OrgDMVV` (PK `MA_VV` v20)

`MA_VV, TEN_VV, TEN_VV_ENG, TK_TI, MA_KHG (chủ đầu tư/khách), NGAY_PS, NGAY_DAU, NGAY_CUOI, NGAY_TT (ngày thanh toán), TG_TIEN_VND, TG_TIEN_NTE (giá trị hợp đồng/dự toán), NHOM_ME, CHI_TIET, STT, CO_SD, GHI_CHU`. Dạng cây; bật bằng tùy chọn "Sử dụng vụ việc". Vụ việc = công trình, dự án, hợp đồng, đối tượng tập hợp chi phí; xuất hiện ở **mọi** bút toán/dòng vật tư/hóa đơn/tài sản.

`OrgDMDOITUONG(MA_DOITUONG v20, TEN_DOITUONG, TG_TIEN_VND, TG_TIEN_NTE, MA_HD, MA_VV, MA_KHG, NGAY_PS, NGAY_DAU, NGAY_CUOI)` – **đối tượng tập hợp chi phí = hạng mục của công trình** (cấp dưới vụ việc), bật bằng "Sử dụng mã đối tượng".

`OrgDMYEUTO(MA_YEUTO, TEN_YEUTO)` – yếu tố chi phí giá thành (NVL trực tiếp, nhân công, SXC…).

### 3.8 Chi phí – `OrgDMCPHI` (PK `MA_CHIPHI` v10)

`MA_CHIPHI, TEN_CHIPHI, TK_TI, LOAI_PS, TK_DU, GHI_CHU`. Cách **chi tiết chi phí thay cho mở tiểu khoản**: hạch toán `Nợ 6421 – mã phí 01` thay vì `642101`. Bật bằng "Sử dụng mã chi phí". Báo cáo `CP_MAPHI_CTIET`, `CP_MAPHI_THOP_*` (tháng/quý/năm/vụ việc), `CP_SXKD`. Từ 2023–2026 mã chi phí được đưa thêm vào trang Hóa đơn GTGT (phân loại hàng 8%), trang vật tư phiếu nhập/xuất, CCDC/TSCĐ.

### 3.9 Các danh mục nhỏ

| Bảng | Cột | Dùng cho |
|---|---|---|
| `OrgDMNTE` | `MA_NTE v6, TEN_NTE, MA_NTE_XU (tên tiền xu, 08/2024), GHI_CHU`; mẫu `USD/Đô la Mỹ/Cent` | Ngoại tệ; tỷ giá nhập trên từng chứng từ (không có bảng tỷ giá) |
| `OrgDMDONVI` | `MA_DONVI, TEN_DONVI` | Đơn vị/chi nhánh hạch toán trong cùng CSDL (cột `MA_DONVI` trên chứng từ, hóa đơn, lọc báo cáo, xuất khẩu chứng từ) |
| `OrgDMBOPHAN` | `MA_BOPHAN, TEN_BOPHAN` | Bộ phận: tổng hợp doanh thu/chi phí, nơi dùng TSCĐ/CCDC, giá thành theo bộ phận |
| `OrgDMNHANVIEN` | `MA_NHANVIEN, TEN_NHANVIEN, GIOI_TINH, NGAY_SINH, MASO_THUE, MA_BOPHAN, CHUCVU, NGAY_DILAM, NGAY_VAO_CTY, SO_CMND, NGAY_CAP, NOI_CAP, SO_TK, TEN_NGANHANG, DIA_CHI, DIEN_THOAI, DI_DONG, EMAIL, HESO_LUONG, GIAMTRU_GC, NGUNG_TD, CHON` | Nhân viên bán hàng/phụ trách khách, thu chi theo NV; dữ liệu lương (hệ số, giảm trừ gia cảnh) phục vụ bảng chấm công/bảng lương (được nêu ở phần giới thiệu) |
| `OrgDMDICHVU` | `MA_DVU, TEN_DVU, DVT, DG_BAN, DG_MUA, TK_DOANHTHU, TK_GIAVON, TK_THUE, TYLE_TTDB, TYLE_VAT, CK, MA_NHOM_DVU` + `OrgDMDICHVU_NHOM` | Phiếu bán/mua dịch vụ; **mỗi dịch vụ mang sẵn TK doanh thu/giá vốn/thuế** |
| `OrgDMHTTT` | `MA_TT, TEN_TT`; mẫu `CK, MN, TM, TM/CK` | Hình thức thanh toán in trên PX/HB/PDV/PN/HM |
| `OrgDMTHUE` | `MA_THUE, TEN_THUE, THUE_SUAT, STT`; mẫu: `00` 0%, `05` 5%, `07` 10%×70%, `08` 8%, `10` 10%, `KT` không chịu thuế, `KTH` không tổng hợp lên 01/GTGT, `NK` hàng nhập khẩu, `TT` hóa đơn trực tiếp 0%, `XK` xuất khẩu | Loại hóa đơn/thuế suất; `NK` tách bút toán thuế GTGT hàng NK (33312) |
| `OrgDMHDMUA` | `NHOM_MUA 01–05` = 5 mục bảng kê mua vào của tờ khai (dùng riêng SXKD chịu thuế đủ ĐK khấu trừ / không đủ ĐK / dùng chung / dự án đầu tư / không tổng hợp) | Phân loại hóa đơn mua |
| `OrgDMHDBAN` | `NHOM_BAN 00,05,07,08,10,KT,KTH` + `THUE_SUAT` | Phân loại hóa đơn bán theo thuế suất |
| `OrgDMMAHD` | `MA_HD, KIHIEU_MAU ("01GTKT3/001"), STT` | Mã hóa đơn / ký hiệu mẫu theo TT156 (2014) |
| `OrgDMSOHD_MAX`, `OrgDMSOHD_MUA`, `OrgDMSOPX_MAX` | số HĐ bán lớn nhất theo nhóm/ký hiệu; số HĐ mua lớn nhất theo khách; số PX lớn nhất | Bộ đếm tự tăng số hóa đơn/phiếu xuất |
| `OrgDMNGUONVON` | 5 nguồn vốn TSCĐ | |
| `OrgDMTAU`, `OrgDMCUNGDUONG` | tàu/phương tiện (`TRUONG_TAU, TRONG_TAI, TK_DOANHTHU`), cung đường (`SO_KM`) | Tùy biến ngành vận tải (cột `MA_TAU` trên bút toán/đầu kỳ công nợ; `OrgCTDICHVU.MA_CUNGDUONG, SO_KM, TRONG_TAN, NGAY_DI, NGAY_DEN`) |
| `OrgDMMAUBC` | `FORM_NAME, SO_QD, MAU_SO, QD_SO` | Mẫu số/QĐ in trên từng sổ theo chế độ |
| `OrgDMTROGIUP` | `FORM_NAME, HELP` (29 bản ghi) | Trợ giúp ngữ cảnh theo form (nút ?) – người dùng sửa được (`SYS_HELP_EDIT`) |
| `OrgDMDANHNGON` | 499 câu danh ngôn | Hiển thị theo ngày |

---

## 4. Số dư đầu kỳ

Nguyên tắc chung: nhập **một lần duy nhất** khi bắt đầu kế toán máy; các năm sau dùng "chuyển số dư". `THANG_HT` trong bảng đầu kỳ = **tháng đầu kỳ** (có thể là tháng 1 hoặc tháng bất kỳ – khuyên chọn đầu quý); mọi chứng từ phải có ngày ≥ tháng đầu kỳ; đổi tháng đầu kỳ thì phải `Tiện ích\ Xóa các bảng cân đối` để chương trình xác định lại. Số dư TK công nợ phải **khớp** tổng chi tiết khách (có tiện ích kiểm tra `CL_DAUKY_CN_TK`, `SYS_CTU_LECH_DKY_CN`). Tất cả cửa sổ đầu kỳ có "Mở khóa" để copy từ Excel (2021–2023) và `Tiện ích\ Nhập khẩu số dư đầu kỳ` (`SYS_IMPORT_DKY`).

| Loại | Bảng | Cột chính | Màn hình |
|---|---|---|---|
| Tài khoản | `OrgDauKyTK` | `DUDAU_ID, THANG_HT, TK_TI, DU_NO, DU_CO, DU_NO_NTE, DU_CO_NTE, DU_DAU, DU_DAU_NTE, TY_GIA` | `DAUKY_TK` – lưới theo TK chi tiết; chỉ cho nhập đúng bên theo `LOAI_DU`; TK tổng hợp/TK sai loại dư bị từ chối. `DU_DAU` = số dư ký số *(suy luận: dương Nợ/âm Có)*. |
| Công nợ (khách hàng) | `OrgDauKyCN` | `THANG_HT, MA_KHG, TK_TI, MA_VV, MA_BOPHAN, MA_TAU, DU_DAU, DU_DAU_NTE, TY_GIA` | `DAUKY_CONGNO` – chọn TK công nợ (`TC_KHAC='CN'`) → danh sách khách; có thể bổ sung khách ngay. Tổng bù trừ phải = số dư TK trên đầu kỳ TK. |
| Tồn kho | `OrgDauKyVT` | `THANG_HT, MA_KHO, MA_VT, DVT, NGAY_NHAP, SL_DAU, SL_TT, SO_LO, NGAY_SX, HAN_SD, SO_DK, DG_VON, DG_VON_NTE, TIEN_VON, TIEN_VON_NTE, TYGIA_NTE, NUOC_SX` | `DAUKY_VT` – cửa sổ tổng hợp theo TK/kho (số khoản, tổng tiền) → `DAUKY_VT_CTIET` theo nhóm hàng; thành tiền = ĐG×SL (nhập thành tiền thì chia lại ĐG, làm tròn 4 số). |
| Tồn kho theo lô (NTXT/đích danh) | `OrgDauKyVT1` | thêm `NHAP_ID, NGAY_NHAP` | `DAUKY_VT1` – mỗi lần nhập còn tồn là một dòng, dùng cho FIFO/đích danh. |
| TSCĐ | `OrgDauKyTS` | `THANG_HT, TK_TI (211x), MA_TS, SL, DG, NG_GIA1, KH_HAO1 (KH lũy kế đến đầu kỳ), TYLE_KHCB (%/năm = 100/số năm), SO_NAM_KH, GIATRI_KH_NAM, GIATRI_KH_THANG, TK_TIDU (TK chi phí 642/627…), TK_TRICH (214x), MA_BOPHAN, MA_TG, MA_VV, MA_CHIPHI, DUNG_KHAUHAO` | `DAUKY_TS` → `DAUKY_TS_CTIET`. Nhập nguyên giá máy chia lại đơn giá. |
| CCDC | `OrgDauKyCC` | `MA_CC, SL, DG, NG_GIA1, KH_HAO1, GIATRI_CONLAI, SO_THANG_KH, TYLE_KHCB (tỷ lệ 1 tháng), GIATRI_KH_THANG, TK_CC (142/242), TK_CP (642/154…), MA_BOPHAN, MA_VV, MA_CHIPHI, DUNG_KHAUHAO` | `DAUKY_CC` |
| Vụ việc | `OrgDauKyVV` | `THANG_HT, MA_VV, TK_TI, MA_KHG, DU_NO, DU_CO, DU_NO_NTE, DU_CO_NTE` | `DAUKY_VV` – số dư từng TK (154, 131…) theo vụ việc (và khách). |
| Hợp đồng | `OrgHOPDONG.THUCHIEN_NAMTRUOC, PHAITHU_NAMTRUOC, PHAITRA_NAMTRUOC`; `OrgHOPDONG_HHOA.SLTH_NAMTRUOC` | Giá trị đã thực hiện và dư công nợ hợp đồng năm trước. |
| Thuế GTGT | `DesBC_VAT_DUDAU(THANG, DU_DAU)` | Số thuế GTGT còn được khấu trừ chuyển sang đầu từng tháng (tờ khai). |
| BCTC năm trước | cột `NAM_TRUOC`/`DU_DAU` trong `DesBC_*` | Cột "số đầu năm", "năm trước" của BCTC: máy lấy từ năm trước hoặc tự nhập. |
| Sơ đồ hạch toán | `DesHT_Buoc`, `DesHT_KC_CTu`, `DesHT_PB_CTu` | Menu Đầu kỳ (xem §7). |

Quy ước cột lưu vết (`NGAY_NHAP_DL, NGUOI_NHAP_DL, MAY_NHAP_DL, NGAY_SUA_DL…`) có ở tất cả bảng đầu kỳ.

---

## 5. Chứng từ (voucher)

### 5.1 Danh mục 43 loại chứng từ mẫu (`OrgDMCT` trong `KTSTRUC`)

Cột `TK_CT` = TK mặc định phần chung; `MAU_SO` = mẫu in; `QD_SO` của tất cả dòng = "Ban hành theo TT số 133/2016/TT-BTC ngày 26/08/2016" (đổi theo chế độ). `STT` 1 = chiều tiền/hàng vào, 2 = ra, 98/99 = tự động.

| Mã | Tên | Nhóm | STT | TK mặc định | Mẫu in | Form nhập |
|---|---|---|---|---|---|---|
| PT | Phiếu thu tiền mặt | A-TM | 1 | 1111 | Mẫu số 01 - TT | CT3_PT_MOI/XEM/LOC |
| PTN | Phiếu thu ngoại tệ | A-TM | 1 | (1112) | Mẫu số 01 - TT | CT3_PTNTE |
| PTX | Phiếu thu khác | A-TM | 1 | | Mẫu số 01 - TT | CT3_PTX |
| PC | Phiếu chi tiền mặt | A-TM | 2 | 1111 | Mẫu số 02 - TT | CT3_PC |
| PCN | Phiếu chi ngoại tệ | A-TM | 2 | (1112) | Mẫu số 02 - TT | CT3_PCNTE |
| PCX | Phiếu chi khác | A-TM | 2 | | Mẫu số 02 - TT | CT3_PCX |
| BC | Giấy báo có | B-NH | 1 | 1121 | | CT4_BC |
| BCN | Giấy báo có ngoại tệ | B-NH | 1 | (1122) | | CT4_BCN |
| BN | Giấy báo nợ | B-NH | 2 | 1121 | | CT4_BN |
| BNN | Giấy báo nợ ngoại tệ | B-NH | 2 | (1122) | | CT4_BNN |
| UC | Ủy nhiệm chi | B-NH | 2 | | | CT4_UNC (in mẫu UNC theo ngân hàng) |
| HB | Hóa đơn bán hàng | D-HD | 2 | 131 | | CT2_HDB |
| HBX | Hóa đơn bán hàng không qua kho | D-HD | 1 | 131 | | (CT2_HDB + hàng hóa, 12/2025) |
| HM | Hóa đơn mua hàng | D-HD | 1 | 331 | | CT2_HDM |
| HMX | Hóa đơn mua hàng không qua kho | D-HD | 2 | 331 | | CT2_HDMX (+ trang VATTU) |
| PDV | Phiếu bán dịch vụ | F-PKT | 2 | (131) | | CT1_PDVB (+ trang DV) |
| PDVM | Phiếu mua dịch vụ | F-PKT | 1 | (331) | | CT1_PDVM |
| PK | Phiếu kế toán | F-PKT | 98 | | | CT1_PKT |
| KC | Chứng từ kết chuyển tự động | F-PKT | 99 | | | sinh bởi HACHTOAN_RUN |
| KH | Chứng từ trích khấu hao TSCĐ | F-PKT | 99 | | | sinh bởi TAISAN_CTU_TRICHKH |
| CC | Chứng từ phân bổ CCDC | F-PKT | 99 | | | sinh bởi CCDC_CTU_PB |
| PN | Phiếu nhập kho (mua hàng) | C-VT | 1 | | Mẫu số 01 - VT | CT5_PN (+VATTU, BUTTOAN, PBO) |
| PNK | Phiếu nhập hàng nhập khẩu | C-VT | 1 | | Mẫu số 01 - VT | CT5_PNK (+PBO thuế NK) |
| PNL | Phiếu nhập hàng bán trả lại | C-VT | 2 | | Mẫu số 01 - VT | CT5_PNLAI |
| PNGC | Phiếu nhập vật tư gia công | C-VT | 1 | | Mẫu số 01 - VT | CT6_PNGC |
| PNT | Phiếu nhập kho thành phẩm | C-VT | 2 | | Mẫu số 01 - VT | CT6_PNSP (+ nút Xuất ĐM) |
| PNCP | Phiếu nhập chi phí | C-VT | 2 | | Mẫu số 01 - VT | *(suy luận: nhập chi phí mua hàng/giá vốn vào kho)* |
| PNX | Phiếu nhập khác | C-VT | 1 | | | CT5_PNX |
| PX | Phiếu xuất bán hàng | C-VT | 2 | | Mẫu số 02 - VT | CT5_PX (+VATTU, HD, BKE, BUTTOAN, PPDGX) |
| PXT | Phiếu xuất bán thành phẩm | C-VT | 2 | | Mẫu số 02 - VT | (biến thể PX) |
| PXS | Phiếu xuất cho sản xuất, sử dụng | C-VT | 2 | | Mẫu số 02 - VT | CT6_PXSX; cũng là mã "xuất thẳng" (`LOAIXUATTHANG=PXS`) |
| PXD | Phiếu xuất điều chuyển kho | C-VT | 2 | | Mẫu số 02 - VT | CT5_PXD (tự sinh phiếu nhập kho đích cùng số) |
| PXL | Phiếu xuất trả lại hàng (trả NCC) | C-VT | 2 | | Mẫu số 02 - VT | CT5_PXTRA |
| PXGC | Phiếu xuất vật tư gia công | C-VT | 2 | | Mẫu số 02 - VT | CT6_PXGC |
| PXH | Phiếu xuất hủy hàng | C-VT | 2 | | Mẫu số 02 - VT | CT5_PXH |
| PXB | Phiếu xuất biếu, tặng | C-VT | 2 | | Mẫu số 02 - VT | CT5_PXBIEU (chỉ số lượng, không công nợ) |
| PXX | Phiếu xuất khác | C-VT | 2 | | Mẫu số 02 - VT | CT5_PXX (xuất được từ danh mục, không cần tồn) |
| TTS | Tăng tài sản cố định | E-TS | 1 | | | CT7_TTS (+TAISAN, nút Chi tiền) |
| GTS | Giảm tài sản cố định | E-TS | 2 | | | CT7_GTS |
| DTS | Điều chỉnh tài sản cố định | E-TS | 2 | | | CT7_DTS (+BUTTOAN, nút Tính giá trị TS) |
| CCT | Tăng công cụ, dụng cụ | E-TS | 1 | | | CT8_CCT |
| CCG | Giảm công cụ, dụng cụ | E-TS | 2 | | | CT8_CCG |
| CCD | Điều chỉnh công cụ, dụng cụ | E-TS | 2 | | | CT8_CCD |

Mã xuất hiện trong code/changelog nhưng không có trong `OrgDMCT` mẫu: `PNS` (phiếu nhập xuất thẳng – `DesDataErr` loại trừ `MA_CT<>'PNS'` khỏi lỗi "không có bút toán"; từ 10/2012 nhập-xuất thẳng thành **lựa chọn "Xuất thẳng" trên phiếu nhập** và sinh phiếu xuất `PXS`), `PXDM` (phiếu xuất định mức, form `CT6_PXDM`), chứng từ phân bổ cuối kỳ (`DesHT_PB_*`, *(suy luận)* cũng ghi mã `KC` hoặc mã riêng).

### 5.2 Cấu trúc chung một cửa sổ chứng từ

Mọi cửa sổ nhập có 3 vùng: **Phần chung** (header), **các trang** (tab) chi tiết, **nút lệnh**. Hai chế độ: `_MOI` (nhập mới, số chứng từ tự tăng) và `_XEM` (lọc `_LOC` rồi duyệt `<< >> |<< >>|`, phải bấm **Sửa** để mở khóa). Phím F4 tìm, F5 làm tươi.

**Phần chung** (→ `OrgCTCHUNG`): Mã chứng từ, Số chứng từ, Ngày chứng từ (mặc định ngày máy nếu năm làm việc = năm máy; cảnh báo nếu khác năm), **Tháng hạch toán** (độc lập với ngày, mặc định = tháng của ngày; là đơn vị khóa sổ), Diễn giải chứng từ (100 ký tự; dùng mặc định cho diễn giải bút toán; khi lên sổ ưu tiên diễn giải bút toán), Ghi chú chứng từ, Đơn vị, Kho nhập/xuất (hoặc nhiều kho → cột kho xuống dòng vật tư), TK ngầm định (TK tiền mặt/tiền gửi; TK ghi nợ/có), Khách hàng (+ tự điền tên, người liên hệ, MST, địa chỉ, điện thoại, CCCD, hạn thanh toán, nhân viên phụ trách), Chi nhánh khách, Hợp đồng, Nhân viên, Bộ phận, Hình thức thanh toán, Ngoại tệ (mã + tỷ giá), Chứng từ gốc kèm theo (danh sách số HĐ, tự chuyển từ trang hóa đơn), Xác nhận, Đã thu/chi tiền, Thời hạn/ngày thanh toán, Số PO, Số lệnh xuất, Người nhập + ngày nhập (máy tự ghi).

**Các trang** tùy loại chứng từ:

| Trang | Bảng | Có ở |
|---|---|---|
| Bút toán (Nợ/Có) | `OrgCTKT` | tất cả |
| Vật tư chi tiết | `OrgCTVT` | PN*, PX*, HMX/HBX, PXDM |
| Hóa đơn GTGT | `OrgCTVAT` | hầu hết (PT, PC, BC, BN, HB, HM, PN, PX, PDV, TTS, GTS, PK…) |
| Tài sản tăng/giảm/điều chỉnh | `OrgCTTS` | TTS, GTS, DTS |
| Công cụ | `OrgCTCC` | CCT, CCG, CCD |
| Dịch vụ | `OrgCTDICHVU` | PDV, PDVM |
| Bảng kê kèm hóa đơn | `OrgCTVT_BKE` | PX (khi số dòng hàng > số dòng hóa đơn) |
| Hóa đơn GTGT in (đặt in NĐ51) | `OrgCTVT_HD` | PX, HB, PDV |
| Phân bổ chi phí mua hàng / thuế NK | cửa sổ `CT5_PN_PBO`, `CT5_PNK_PBO` | PN, PNK, PNX, PNGC |

**Nút lệnh**: Lập bút toán (tự định khoản theo TK ngầm định + dữ liệu trên phiếu; có "Tắt lập bút toán"), Bỏ bút toán/hóa đơn/tài sản/công cụ/mã hàng, Tính tồn kho, Hỏi số tồn, Thay đổi phương pháp tính giá vốn (cho mã hàng đang chọn), Chuyển hàng sang bảng kê / sang hóa đơn, Phân bổ CP, Thu tiền / Chi tiền (sinh PT/PC/BN/BC từ PX/PN/HB/HM/PDV/TTS/CCT – liên kết `STT_REC_PT`, `STT_REC_PC`, `DA_THANHTOAN`), Chọn phiếu nhập/xuất/hóa đơn đã có (`CT3_CHONPHIEUNHAP`, `CT3_CHONPHIEUXUAT`, `CT0_THUTIEN`, `CT0_CHITIEN`) khi làm PT/PC, Mới, Sửa, Lọc, Xóa, In phiếu (nhiều mẫu, in liên tục, ra PDF/Excel), In bảng kê, Kết thúc. Sub-form dùng chung: `CT0_BUTTOAN_TKNO`, `CT0_BUTTOAN_TKCO`, `_NTE`, `CT0_HDVAT_MUA`, `CT0_HDVAT_BAN`, `CT0_HDVAT_MUABAN`.

### 5.3 Mô tả từng màn hình nhập

**Phiếu thu / chi (PT, PC, PTN, PCN, PTX, PCX)** – `CT3_*`. Header: người nộp/nhận, địa chỉ, TK tiền mặt (`TK_TI`), số tiền, lý do. Tab Hóa đơn GTGT (hóa đơn chưa nhập ở chứng từ khác; nhiều hóa đơn trên một phiếu – thanh toán theo tour/công trình), tab Bút toán: máy đặt sẵn Nợ 1111 (PT) hoặc Có 1111 (PC), người dùng nhập TK đối ứng + mã khách (nếu TK CN) + mã phí + bộ phận + vụ việc. Phiếu ngoại tệ: tỷ giá, tiền NTE; từ 12/2011 cho nhập tỷ giá/TK tiền mặt khác nhau từng bút toán để hạch toán chênh lệch tỷ giá ngay trên phiếu. In: mẫu 1/2/3/4, 1 liên/2 liên, A5, số tiền bằng chữ, "đã nhận đủ".

**Giấy báo có / báo nợ / UNC (BC, BN, BCN, BNN, UC)** – `CT4_*`. Giống PT/PC với TK tiền gửi (`TK_TI` chọn mọi TK 112x; UNC còn chọn TK vay 311/341). UNC có khối thông tin người trả/người nhận (`TEN_DV_TRA, SO_TK_TRA, TEN_NH_TRA, TINH_TP_TRA, CN_NH_TRA, TEN_DV_NHAN, SO_TK_NHAN, TEN_NH_NHAN, TINH_TP_NHAN, CN_NH_NHAN, SO_CCCD…`) và in theo **mẫu từng ngân hàng** (BIDV, VCB, Vietinbank, MB, Agribank, Techcombank, Sacombank, TPBank). Nút Thu tiền/Chi tiền trên BC/BN (2021).

**Hóa đơn bán hàng / mua hàng (HB, HM)** – `CT2_*`: bán/mua dịch vụ hoặc hàng không theo dõi chi tiết, chưa thu/trả tiền. Một trang: thông tin hóa đơn GTGT + bút toán; TK Có tự xác định từ khách (331/131), TK Nợ người dùng chọn. Lập bút toán tách doanh thu theo vụ việc trên từng hóa đơn (2018). HMX/HBX "không qua kho": có trang hàng hóa (`OrgCTVT`) nhưng **không vào NXT** – dùng mua hàng đưa thẳng ra công trình.

**Phiếu kế toán (PK)** – `CT1_PKT`: bút toán điều chỉnh, bổ sung, bù trừ công nợ (bù trừ giữa 2 khách phải tách 2 dòng, mỗi dòng một mã khách). Cũng là nơi **xem** chứng từ tự động `KC/KH/CC` (lọc theo mã). Có trang hóa đơn GTGT (kiểm tra trùng số hóa đơn).

**Phiếu bán / mua dịch vụ (PDV, PDVM)** – `CT1_PDVB/PDVM`: tab Dịch vụ (`OrgCTDICHVU`: mã DV, ĐVT, SL, giá bán, tiền, %CK, thuế TTĐB, thuế GTGT, tiền trước thuế; ngành vận tải: cung đường, tàu, km, trọng tấn, ngày đi/đến), tab Hóa đơn, tab Bút toán (lập từ TK doanh thu/giá vốn/thuế khai trong danh mục dịch vụ). TK ngầm định = TK phải thu.

**Phiếu nhập kho mua hàng (PN)** – `CT5_PN_MOI` + `CT5_PN_VATTU` + `CT5_PN_PBO` + `CT5_PN_BUTTOAN`: header có kho nhập (hoặc nhiều kho), NCC, hình thức TT, địa chỉ, CCCD/điện thoại (2026), chi phí mua hàng tổng. Tab Vật tư: STT, mã hàng (BS DMVT ngay), tên hàng (sửa được), ĐVT (1/2), SL, đơn giá nhập VND/NTE, tiền, %CK/tiền CK (nhập tiền thì tính %), giảm giá, KM (hàng khuyến mại), thuế suất, lô/hạn dùng/ngày SX/số ĐK/chất lượng/số phiếu kiểm nghiệm/điều kiện bảo quản, mã vụ việc/mã chi phí/đối tượng từng dòng. **Phân bổ chi phí mua hàng** (nút Phân bổ CP): tự chia theo tỷ lệ tiền hàng hoặc nhập tay (cảnh báo khi tổng ≠ chi phí), kết quả vào `CHI_PHI` → `DG_VON = DG_NHAP + chi phí/đv + thuế NK/đv`. Lập bút toán: Nợ TK kho (từ `OrgDMKHO.TK_TI`) / Có TK ghi Có ở header; chi phí mua hàng ghi Nợ giá vốn. Lựa chọn **Xuất thẳng**: sinh luôn phiếu xuất `PXS` (`CTU_BT` = STT chứng từ bán thẳng). In: 7+ mẫu, đơn đặt hàng, biên bản kiểm nhận, BBGN (4 mẫu, có nhiệt độ/độ ẩm cho dược).

**Phiếu nhập khẩu (PNK)**: như PN + phân bổ **thuế nhập khẩu, thuế TTĐB** vào giá vốn (`TYLE_THUENK, THUE_NK`), thuế GTGT hàng NK = thuế suất × (giá chưa thuế + thuế NK), hóa đơn loại `NK` → bút toán thuế tách 33312; lập bút toán hóa đơn mua trong nước (vận chuyển…) theo từng hóa đơn/khách.

**Phiếu nhập lại hàng bán trả lại (PNL)**: nhập lại giá vốn theo phiếu xuất gốc hoặc giá hiện hành; tự trừ công nợ khách (`TKHangNhapLai=5111`); in mẫu có giá vốn/giá bán.

**Phiếu xuất kho bán hàng (PX)** – màn hình phức tạp nhất (`CT5_PX_MOI/XEM/LOC/VATTU/HD/BKE/BUTTOAN/PPDGX`): header: kho xuất (1 hoặc nhiều), TK ghi nợ (mặc định 131), khách (+chi nhánh, người mua, ĐT, địa chỉ, MST, CCCD, nhân viên bán, hạn/ngày thanh toán từ danh mục khách), hình thức TT, ngoại tệ, xác nhận, đã thu tiền, số PO, số lệnh xuất, %CK/tiền CK **cả đơn hàng** (`TYLE_CK_TG, TIEN_CK_TG`). Tab Vật tư: mã hàng **chỉ chọn từ hàng tồn của kho** (nút Tính tồn kho; hàng `KHONGTINH_NXT` vẫn xuất được), SL tồn tính đến ngày (loại trừ chính phiếu này), SL xuất, đơn giá bán (từ bảng giá chung/theo khách/theo ĐVT; nhập thành tiền thì chia lại giá), **đơn giá vốn** (máy tính theo kho đến thời điểm; cột ẩn theo quyền `XEMGV`), %CK, tiền CK, KM (tick → giá = 0, giá vốn hàng KM hạch toán vào TK riêng), tiền KM, đơn giá giảm giá, tiền giảm giá, tỷ lệ/tiền hỗ trợ, lệ phí xăng dầu, tiền vận chuyển, bảo hành (tháng), thuế suất/tiền thuế từng dòng, thuế TTĐB, giá net, lô/hạn dùng, cố định giá vốn (`CODINH_GV`), phương pháp tính giá vốn từng dòng (`PP_DGX`). Tab Hóa đơn GTGT (tự tăng số HĐ bán, ký hiệu). Tab Bút toán: Lập bút toán sinh: Nợ 131/Có 5111 (doanh thu), Nợ 131/Có 33311 (thuế), Nợ 632/Có 156 (giá vốn – cập nhật lại sau khi cân đối), các bút toán CK/giảm giá/KM/hỗ trợ (TK khai trong tham số) – cờ `BT_DOANHTHU, BT_THUE, BT_GIAVON, BT_CK, GIAVON_KM` trên `OrgCTKT` đánh dấu bút toán do máy sinh. Tab Bảng kê kèm HĐ, tab Hóa đơn in. Nút **Thu tiền** sinh phiếu thu. In: 19 mẫu phiếu xuất, 6 mẫu BBGN, 6 mẫu bảng kê, báo giá, đơn đặt hàng, hóa đơn GTGT (mẫu tự in/đặt in NĐ51), mẫu có giá vốn/lãi gộp (theo quyền).

**Phiếu xuất điều chuyển (PXD)**: chọn kho xuất + kho nhập; máy tự lập phiếu nhập kho đích **cùng số phiếu**, giá vốn theo kho xuất.

**Phiếu xuất sử dụng/sản xuất (PXS)**: không có trang hóa đơn; TK Nợ là TK chi phí (621/627/642…), mã vụ việc/mã chi phí theo từng dòng vật tư (một phiếu nhiều vụ việc), có ngoại tệ (2025).

**Phiếu xuất trả NCC (PXL), xuất hủy (PXH), xuất biếu tặng (PXB), xuất khác (PXX)**: biến thể của PX; PXB/PNX chỉ số lượng (không bút toán công nợ) vẫn lên sổ chi tiết công nợ có hàng hóa.

**Gia công / sản xuất (PNGC, PXGC, PNT/PNSP, PXDM)**: nhập kho thành phẩm `PNSP` có nút **Xuất ĐM** sinh `PXDM` xuất NVL theo định mức (`OrgDINHMUC_VT`) với số lượng `SL_XUAT_DM` (có thể khác SL nhập kho); phiếu xuất định mức lấy hàng từ danh mục (không cần tồn); bút toán Nợ 621/Có 152 gắn `MA_SP`, `DINH_MUC=True`.

**Phiếu tăng TSCĐ (TTS)** – `CT7_TTS_MOI/TAISAN`: tab Tài sản tăng (STT, mã TS – BS DMTS ngay, tên, SL, đơn giá, nguyên giá (nhập NG máy chia lại ĐG), hao mòn, số năm KH, tỷ lệ KHCB (=100/số năm), KH 1 năm, KH 1 tháng, TK nguyên giá 211x, TK khấu hao 214x, TK chi phí 642/627, lý do tăng, bộ phận, vụ việc, mã chi phí, hợp đồng, đối tượng, **Dừng khấu hao**, diễn giải), tab Hóa đơn, tab Bút toán, nút Chi tiền. Tùy chọn trích KH theo ngày của tháng đầu tăng ((ngày cuối tháng − ngày tăng)+1), theo tỷ lệ hay số năm.

**Phiếu giảm TSCĐ (GTS)**: chọn TS → máy điền NG/KH lũy kế hiện có; bút toán thanh lý/nhượng bán. **Phiếu điều chỉnh (DTS)**: giá trị hiện có (nút Tính giá trị TS) + giá trị điều chỉnh (+/−) nguyên giá; tab bút toán.

**CCDC (CCT, CCG, CCD)**: tương tự với `TK_CC` (142/242), `TK_CP`, số tháng phân bổ, giá trị phân bổ/tháng, bộ phận, vụ việc, mã chi phí, dừng khấu hao.

### 5.4 Quy tắc đánh số chứng từ

- `SO_CT` (v20, chữ hoặc số) = **số lớn nhất đã có + 1** theo từng `MA_CT`; mặc định tăng liên tục cả năm, tùy chọn tăng theo tháng (toàn hệ thống `Lựa chọn khác` hoặc theo loại `OrgDMCT.SOCT_THANG`).
- Cho phép nhập tay; nhập trùng → cảnh báo, F4 tìm chứng từ đã dùng số đó; số lớn bất thường → do ai đó gõ nhầm (lọc số−1).
- `Tiện ích\ Đánh lại số phiếu` (`CT_REMAKE_STT`) đánh lại cho cả tháng/quý/năm, chèn ký tự (PC1/1, PC2/1…); `Xóa số phiếu` để đánh lại từ đầu. Chứng từ tự động cũng có STT và từ 08/2025 cho xóa.
- `STT_CT` (int) là số thứ tự nội bộ để sắp xếp; `STT_REC` (autonumber) là khóa kỹ thuật, in trên sổ cột "*" để nhảy về chứng từ.
- Số hóa đơn bán: tự tăng theo `OrgDMSOHD_MAX` (ký hiệu + nhóm), định dạng 7→8 chữ số (`0000001`, NĐ123/TT78, 12/2021), tùy chọn không thêm số 0; số hóa đơn mua kiểm tra trùng theo số+ký hiệu (hoặc chỉ số – tùy chọn 2024).
- Số phiếu xuất riêng (`OrgDMSOPX_MAX`) khi in phiếu xuất kiêm hóa đơn.

### 5.5 Chứng từ tạo tự động

| Mã | Sinh bởi | Nội dung bút toán | Ghi chú |
|---|---|---|---|
| `KH` | `Tài sản\ Lập bút toán trích khấu hao` (sau Cân đối TSCĐ có lập bút toán) | Nợ `TK_TIDU` (642/627/641) – mã chi phí/bộ phận/vụ việc / Có `TK_TRICH` (214x), số = `GIATRI_KH_THANG` từng TS (hoặc gộp theo cặp TK nếu tắt `TSCD_PBCHITIET`); `OrgCTKT.MA_TS` lưu mã TS để in thẻ | chỉ lập khi tiền trích ≠ 0; có mục Xóa bút toán KH; ngày = cuối tháng hoặc ngày hiện tại (tùy chọn) |
| `CC` | `Tài sản\ Cân đối CCDC` lựa chọn "có lập chứng từ phân bổ" | Nợ `TK_CP` / Có `TK_CC` (142/242) từng CCDC hoặc gộp; `OrgCTKT.MA_CC` | tương tự KH |
| `KC` | `Tổng hợp\ Hạch toán cuối tháng` theo `DesHT_KC_CTu` | Kết chuyển số dư/phát sinh TK nguồn → TK đích (511→911, 632→911, 911→4212, 521→5111, 1331→33311…), có thể theo mã SP/vụ việc, có "để lại" | header `BUOC_KC` = bước; "Cân đối có xóa chứng từ kết chuyển" xóa toàn bộ KC của tháng |
| (PB) | bước phân bổ `DesHT_PB_CTu/BToan` | Phân bổ số dư `TK_PB` sang nhiều `TK_DICH` theo `TYLE_PB` (nhập tay, theo tháng trước, hoặc theo tỷ lệ số dư/doanh thu của `TK_TYLE`) | *(suy luận: ghi mã KC cùng bước)* |
| Giá vốn | `Hàng hóa\ Cân đối vật tư (có cập nhật đơn giá vốn)` | **Sửa lại** bút toán giá vốn (`BT_GIAVON=True`) trên chính các phiếu xuất: Nợ 632/621…/Có 152/153/155/156 = `DG_VON mới × SL` | không sinh chứng từ mới |
| PT/PC/BN/BC | nút Thu tiền/Chi tiền trên PX/PN/HB/HM/PDV/TTS/CCT | Phiếu thu/chi/báo nợ/có liên kết `STT_REC_PT/PC` | |
| PN điều chuyển | PXD | Phiếu nhập kho đích cùng số | |
| PXS / PXDM | tùy chọn Xuất thẳng trên PN; nút Xuất ĐM trên PNSP | Phiếu xuất thẳng / xuất NVL theo định mức | `CTU_BT`, `CTU_HHOA`, `CTU_AUTO` |
| Chứng từ nhập khẩu | `CT_IMPORT_*` (bảng kê Excel, bản dữ liệu khác, MISA) | cờ `CTU_NGOAI` | |
| Nhân bản | `CT_COPY_CTU` | cờ `CTU_COPY`; ngày = ngày hiện tại (cùng năm) hoặc ngày gốc | |

---

## 6. Mô hình dữ liệu giao dịch

### 6.1 Sơ đồ quan hệ (tất cả nối bằng `STT_REC`; không có FK vật lý)

```
OrgCTCHUNG (header, PK STT_REC)
 ├─1..n─ OrgCTKT      (bút toán Nợ/Có – mỗi dòng là một CẶP TK)      PK BT_ID
 ├─0..n─ OrgCTVT      (dòng vật tư/hàng hóa)                          PK VT_ID  ─┐
 ├─0..n─ OrgCTVAT     (dòng hóa đơn GTGT mua/bán)                     PK HD_ID   │ NHAP_ID → OrgCTVT.VT_ID của phiếu nhập
 ├─0..n─ OrgCTTS      (dòng TSCĐ tăng/giảm/điều chỉnh)                PK TS_ID   │ (lô nhập, dùng cho FIFO/đích danh)
 ├─0..n─ OrgCTCC      (dòng CCDC)                                     PK CC_ID   │
 ├─0..n─ OrgCTDICHVU  (dòng dịch vụ)                                  PK VT_ID   │
 ├─0..n─ OrgCTVT_BKE  (bảng kê hàng kèm hóa đơn – bản in)             PK BK_ID   │
 ├─0..n─ OrgCTVT_HD   (dòng hóa đơn GTGT in – bản in)                 PK VT_ID ◄─┘
 ├─ HD_ID → OrgHOPDONG.HD_ID ;  STT_REC_PT / STT_REC_PC → OrgCTCHUNG (phiếu thanh toán liên quan)
 └─ CTU_BT → STT_REC phiếu xuất thẳng ; BUOC_KC → DesHT_Buoc

Tổng hợp theo tháng (THANG_HT):  TmpCDOTK (TK [+MA_VV/MA_SP]) · TmpCDOCN (TK+khách[+VV+BP]) ·
   TmpCDOVT (kho+VT) · TmpCDOVT1 (kho+VT+lô) · TmpCDOTS (TS) · TmpCDOCC (CC) · TmpTHOPCT_TK (cặp TK Nợ/Có)
```

### 6.2 `OrgCTCHUNG` – header (91 cột)

| Nhóm | Cột | Ghi chú |
|---|---|---|
| Khóa & phân loại | `STT_REC` (PK, SERIAL), `MA_DONVI`, `THANG_HT` (NOT NULL), `MA_CT` (NOT NULL), `SO_CT`, `NGAY_CT`, `STT_CT` | Kỳ hạch toán = `THANG_HT`; mọi tổng hợp tháng dùng cột này, báo cáo "theo ngày" dùng `NGAY_CT`. |
| Ngoại tệ | `NTE` (cờ), `MA_NTE`, `TYGIA_NTE` | Một tỷ giá/chứng từ; bút toán có thể ghi đè (`OrgCTKT.TYGIA_BT, MA_NTE_BT`). |
| Đối tác | `MA_KHG`, `MA_CHINHANH`, `TEN` (người nộp/nhận), `DIACHI`, `MST_KHG`, `DIENTHOAI_KHG`, `TEN_KHG_IN`, `SO_CCCD`, `NGAY_CAP_CCCD`, `NOI_CAP_CCCD` | Thông tin in hóa đơn cho khách lẻ (`KL`). |
| Hợp đồng/đơn hàng | `HD_ID`, `SO_PO`, `SO_LENHXUAT` | |
| TK & diễn giải | `TK_TI` (TK dùng chung cho mọi bút toán: 1111/1121/131/331), `TK_NO`, `TK_CO` (v30, UNC), `DIEN_GIAI_CT` (255), `GHI_CHU_CT` (text) | |
| Thanh toán | `THOIHAN_THANHTOAN` (ngày), `NGAY_THANHTOAN`, `DA_THANHTOAN`, `NGAY_CT_THANHTOAN`, `THANG_HT_THANHTOAN`, `STT_REC_PT`, `STT_REC_PC`, `MA_TT` (hình thức), `TG_THANHTOAN`, `TG_THANHTOAN_NTE` | Theo dõi hạn thanh toán, nợ quá hạn, tuổi nợ. |
| Kho | `KHO_X`, `KHO_N`, `DS_KHO` (danh sách kho khi xuất nhiều kho/định mức), `MA_NHAP`, `MA_XUAT` (dạng nhập/xuất trên cùng loại phiếu), `LOAI_PX` (F/OF) | |
| Phân tích | `MA_NHANVIEN`, `MA_BOPHAN` | Vụ việc/chi phí/đối tượng **không ở header** mà ở từng dòng. |
| Tổng đơn hàng | `TYLE_CHIETKHAU`, `TG_CHIETKHAU`, `TG_CHI_PHI` (chi phí mua hàng), `TG_THUE_NK`, `TYLE_CK_TG`, `TIEN_CK_TG` | |
| Trạng thái | `CHECK` (đã kiểm tra), `XACNHAN` (đã xác nhận/ghi sổ – thủ kho/kế toán tổng hợp), `CODINH_CTU` (không cho lập lại bút toán), `HOADON_DACBIET`, `UYTHAC_DAILY` | |
| Nguồn gốc | `CTU_AUTO`, `CTU_HHOA`, `CTU_BT`, `CTU_GOC` (v10), `CTU_GOC_DS` (danh sách chứng từ gốc/số HĐ), `CTU_COPY`, `CTU_NGOAI`, `CTU_XOA`, `CTU_KP`, `BUOC_KC` | |
| UNC/ngân hàng | `TEN_DV_TRA, SO_TK_TRA, TEN_NH_TRA, TINH_TP_TRA, CN_NH_TRA, TEN_DV_NHAN, SO_TK_NHAN, TEN_NH_NHAN, TINH_TP_NHAN, CN_NH_NHAN` | |
| Khác | `NO_HIENTAI` (nợ tại thời điểm lập) | |
| Lưu vết | `NGAY_NHAP_DL, NGUOI_NHAP_DL, USER_NAME, GIO_NHAP_DL, MAY_NHAP_DL, NGAY_SUA_DL, NGUOI_SUA_DL, GIO_SUA_DL, MAY_SUA_DL, NGAY_XOA_DL, GIO_XOA_DL, NGUOI_XOA_DL, MAY_XOA_DL` | Chỉ lưu lần sửa cuối; không có diff nội dung. |

### 6.3 `OrgCTKT` – bút toán (30 cột)

| Cột | Ý nghĩa |
|---|---|
| `BT_ID` PK, `STT_REC` FK, `STT_BT` | thứ tự bút toán trong chứng từ |
| `TK_TINO`, `TK_TICO` | **TK Nợ và TK Có trên cùng một dòng** (định khoản kép, không phải mô hình một dòng–một bên). Mọi sổ cái/chữ T được suy ra bằng cách "lật" dòng. |
| `TIEN_VND`, `TIEN_NTE` | số tiền; `TYGIA_BT`, `MA_NTE_BT` tỷ giá/ngoại tệ riêng của dòng |
| `MA_KHG` (khách chung), `MA_KHG_NO`, `MA_KHG_CO` | mã đối tượng bên Nợ/bên Có – **bắt buộc khi TK tương ứng có `TC_KHAC='CN'`** (soát lỗi 5, 6) |
| `MA_CHIPHI`, `MA_HD` (hợp đồng), `MA_VV`, `MA_DOITUONG`, `MA_SP` (sản phẩm tính giá thành), `MA_YEUTO`, `YEUTO_CP` (yếu tố chi phí), `MA_TAU`, `MA_TS`, `MA_CC` | **các chiều phân tích** của một bút toán; MA_TS/MA_CC do chứng từ KH/CC ghi để in thẻ |
| `DINH_MUC` | chi phí NVL xuất theo định mức hay tự xác định |
| `GIAVON_KM` | bút toán giá vốn hàng khuyến mại |
| `BT_GIAVON`, `BT_DOANHTHU`, `BT_THUE`, `BT_CK` | đánh dấu bút toán do máy lập → cho phép lập lại/cập nhật giá vốn mà không đụng bút toán tay |
| `DIEN_GIAI_BT` (255), `STATUS` (v1) | |

Hệ quả thiết kế: tổng Nợ = tổng Có **đương nhiên** đúng ở mức dòng; lỗi chỉ xảy ra khi thiếu TK hoặc tiền (soát lỗi 4). Bảng `TmpTHOPCT_TK(THANG_HT, TK_TINO, TK_TICO, TIEN_VND, TIEN_NTE, MA_VV, MA_SP)` là tổng hợp theo **cặp đối ứng** – nền tảng của công thức KQKD/LCTT ("phát sinh Có 632 đối ứng Nợ 911").

### 6.4 `OrgCTVT` – dòng vật tư (87 cột) và cách kho gắn với bút toán

| Nhóm | Cột |
|---|---|
| Khóa/kho | `VT_ID`, `STT_REC`, `STT_KHOAN`, `MA_KHO`, `MA_KHO_LUU`, `MA_VT`, `DANH_DIEM`, `MA_SIEUTHI`, `TEN_HANG` (tự gõ), `DVT` |
| Số lượng | `SL_TON` (tồn tại thời điểm), `SL_TT` (thực tế), `SL_BO`, `SL_CAY`, `SL_KM`, `SL_CON`, `SL_XUAT_DM` |
| Lô/dược | `NGAY_NHAP`, `SO_LO`, `HAN_SD`, `NGAY_SX`, `SO_DK`, `NUOC_SX`, `CHAT_LUONG`, `SO_PKN`, `DK_BAOQUAN` |
| Giá nhập/vốn | `DG_NHAP(_NTE)`, `TIEN_NHAP`, `CHI_PHI` (chi phí mua phân bổ), `TYLE_THUENK`, `THUE_NK`, `PHI_XD`, `TIEN_PHI_XD`, **`DG_VON`** (= giá nhập + chi phí/đv + thuế NK/đv; với phiếu xuất = giá vốn tính được), `CODINH_GV`, `PP_DGX`, `PP_DGX_LUU`, `NHAP_ID` (lô nhập được xuất – FIFO/đích danh) |
| Giá bán | `DG_BAN(_NTE)`, `TIEN_BAN`, `TYLE_CK`, `TIEN_CK`, `DG_GG`, `TIEN_GG`, `KM`, `TYLE_KM`, `TIEN_KM`, `TYLE_HOTRO`, `TIEN_HOTRO`, `TYLE_VC`, `TIEN_VC`, `BAOHANH`, `DG_NET`, `TIEN_NET` (giá sau giảm trừ), `PHI_TAU` |
| Thuế theo dòng | `TYLE_VAT`, `THUE_VAT`, `TIEN_TRUOC_VAT`, `TYLE_THUEDB`, `THUE_DB`, `TIEN_TRUOC_TTDB` (mỗi loại có `_NTE`) |
| Phân tích | `MA_VV`, `MA_HD`, `MA_DOITUONG`, `MA_SP`, `MA_CHIPHI` |

Cách gắn kho với sổ cái: **dòng vật tư không tự sinh bút toán**; nút *Lập bút toán* đọc `OrgDMKHO.TK_TI` của kho + TK đối ứng ở header + tham số để ghi `OrgCTKT` (cờ `BT_GIAVON`). Báo cáo NXT/thẻ kho đọc `OrgCTVT` + `TmpCDOVT`; sổ cái đọc `OrgCTKT`. Hai nguồn này được đối chiếu bằng tiện ích "chênh lệch PN/PX bút toán ≠ tiền vốn" (`VT_PN_CL_BT_TV`, `VT_PX_CL_BT_TV`, `VT_PX_SLDG_TT`…). Giá vốn của phiếu xuất được **ghi ngược** vào `OrgCTVT.DG_VON` và `OrgCTKT.TIEN_VND` của bút toán giá vốn khi chạy cân đối có cập nhật đơn giá.

### 6.5 `OrgCTVAT` – hóa đơn GTGT (26 cột) và cách VAT gắn với bút toán

`HD_ID, STT_REC, STT_HD, KIHIEU_HD, SO_HD, NGAY_HD, MA_KHG, TEN_KHG, MASO_THUE, DOANH_SO, TYLE_VAT, TIEN_THUE, TEN_MATHANG, MA_THUE (→OrgDMTHUE), NHOM_MUA (→OrgDMHDMUA), NHOM_BAN (→OrgDMHDBAN), PLOAI ('M' mua/'B' bán), CKKM (hóa đơn trả CK/KM – lên bảng kê bán số âm), KHONG_KHAUTRU, MA_DONVI (hóa đơn của công ty hay chi nhánh), MA_HD, KIHIEU_MAU (mẫu/ký hiệu mẫu TT156), MA_VV, MA_NHOM, MA_CHIPHI, GHI_CHU`.

Hóa đơn là **dữ liệu kê khai thuế độc lập** với bút toán: bảng kê mua vào/bán ra và tờ khai đọc `OrgCTVAT`; bút toán thuế (Nợ 1331/Có 331, Nợ 131/Có 33311) ở `OrgCTKT` (cờ `BT_THUE`). Tiện ích `CT_SOSANH_VAT` tìm chứng từ có tiền thuế trên bút toán ≠ tiền thuế trên hóa đơn. Một chứng từ có thể có **nhiều hóa đơn** (`CTU_GOC_DS` liệt kê số HĐ). Kiểm tra trùng số HĐ khi nhập.

### 6.6 Công nợ, ngoại tệ, khử trùng

- **Công nợ** = TK `CN` + `MA_KHG_NO/CO` trên bút toán. `TmpCDOCN(THANG_HT, TK_TI, MA_KHG, MA_VV, MA_BOPHAN, DU_DAU, PS_NO, PS_CO, +_NTE)` là bảng cân đối công nợ theo tháng. BCĐKT lấy 131/331 theo "2 số dư" (tổng khách dư Nợ, tổng khách dư Có) khi `NGUON='CN'`.
- **Ngoại tệ**: TK có `TK_NTE`; mọi bảng số dư/phát sinh có cặp `_NTE`; tỷ giá nhập trên chứng từ (không có bảng tỷ giá, không tự đánh giá lại – chỉ có dòng LCTT 61A/61B lấy TK 413 đối ứng tiền). Phiếu ngoại tệ riêng (PTN/PCN/BCN/BNN), in phiếu "In VND/In USD".
- **Khử trùng chứng từ** (đặc trưng Sunsoft): kế toán tiền mặt và ngân hàng nhập độc lập cả Phiếu thu và Giấy báo nợ cho nghiệp vụ "rút TGNH nhập quỹ"; khi lên sổ/cân đối, máy **đánh dấu trùng** cặp chứng từ thuộc danh sách `CTuTrgNo`/`CTuTrgCo` nếu cùng tháng (hoặc ngày), cùng số tiền **của bút toán**, cùng định khoản Nợ/Có, cùng mã khách → chỉ tính một lần vào sổ cái; sổ quỹ/sổ TGNH vẫn lấy đủ. Rút 2 lần 50tr cùng ngày phải nhập 2 phiếu. Khuyến nghị hạch toán PN/PX/HB/HM qua TK công nợ để hạn chế trùng. Cột `Trạng thái` trên Bảng kê chứng từ cho biết đã đánh dấu trùng.

### 6.7 Bảng cân đối trung gian (`Tmp*`) – "snapshot" theo tháng

| Bảng | Khóa logic | Cột | Nguồn / dùng cho |
|---|---|---|---|
| `TmpCDOTK` | THANG_HT + TK_TI (+MA_VV, MA_SP) | `DU_DAU, PS_NO, PS_CO (+_NTE)` | Cân đối tài khoản; bảng CĐPS, BCĐKT (`NGUON=TmpCDOTK`), chuyển số dư tháng/năm. Số dư đầu tháng sau = cuối tháng trước. |
| `TmpCDOCN` | THANG_HT + TK + MA_KHG (+VV, BP) | như trên | Cân đối công nợ; BCĐKT 2 số dư; biên bản đối chiếu. |
| `TmpCDOVT` | THANG_HT + MA_KHO + MA_VT (+lô) | `SL_DAU, DU_DAU, SL_NHAP, PS_NO, SL_XUAT, PS_CO, SL_CUOI, DU_CUOI, DG_HT (đơn giá hạch toán = bình quân tháng), +_NTE` | Cân đối vật tư; NXT, tồn kho, giá vốn bình quân. |
| `TmpCDOVT1` | + `NHAP_ID, NGAY_NHAP, DG_VON` | `SL_DAU, SL_NHAP, SLX_DD (xuất đích danh), SLX_TT, SLX_HT, SL_CUOI` | Tồn theo lô nhập cho FIFO/đích danh. |
| `TmpVT_DGX`, `TmpVT_DGX_TB`, `TmpVT_DGXHT`, `TmpVT_DGX_HETHANG` | kho+VT(+lô) | `DG_VON`, `SL_CUOI`, `DG_HT`; HETHANG = danh sách phiếu xuất không còn hàng để tính giá (`STT_REC, MA_CT, NGAY_CT, SO_CT, SL_XUAT, CHECK`) | Bảng làm việc khi tính đơn giá xuất. |
| `TmpCDOTS` | THANG_HT + MA_TS | `NG_GIA1, KH_HAO1, TANG_NG, TANG_KH, GIAM_NG, GIAM_KH, TRICH_KH, LK_TRICH, TYLE_KHCB, SO_NAM_KH, GIATRI_KH_NAM/THANG, TK_TI, TK_TIDU, TK_TRICH, MA_BOPHAN, MA_VV, MA_CHIPHI, DUNG_KHAUHAO` | Bảng cân đối TSCĐ tháng → chứng từ KH, thẻ, sổ trích KH. |
| `TmpCDOCC` | THANG_HT + MA_CC | tương tự + `TANG, GIAM, DIEUCHINH` | Cân đối CCDC. |
| `TmpTHOPCT_TK` | THANG_HT + TK_TINO + TK_TICO (+VV, SP) | `TIEN_VND, TIEN_NTE` | Tổng hợp đối ứng → KQKD/LCTT/TNDN. |

Tất cả `Tmp*` được **tính lại** bằng các lệnh "Cân đối …" và xóa bằng `Tiện ích\ Xóa các bảng cân đối`; chúng không phải nguồn sự thật nhưng là **điều kiện tiên quyết** để báo cáo đúng (manual nhấn mạnh phải cân đối trước khi xem NXT, BCĐPS, BCTC).

---

## 7. Quy trình cuối kỳ (tổng hợp số liệu)

### 7.1 Thứ tự chuẩn (theo "Qui trình tổng hợp số liệu cuối tháng" + các trang help)

| Bước | Menu / form | Việc máy làm | Ghi chú |
|---|---|---|---|
| 0 | `Hệ thống\ Lưu dữ liệu dự phòng` | Sao lưu trước khi chạy (nhiều bước **ghi đè** giá vốn, bút toán) | khuyến nghị trong help soát lỗi 8 |
| 1 | `Tiện ích\ Kiểm tra, soát lỗi chứng từ` (`SYS_DATAERR_DETECT`) | Chạy 12 kiểm tra `DesDataErr` từ tháng–đến tháng; mỗi lỗi có nút Sửa chứng từ. Lỗi **không** ngăn tổng hợp. Dùng Xác nhận chứng từ để loại chứng từ đã soát. | §11.1 |
| 1b | `Tiện ích\ Kiểm tra chênh lệch chứng từ` (`SYS_CTU_LECH_*`) | Sai ĐVT (đầu kỳ, chứng từ, trùng, hệ số), SL×ĐG ≠ thành tiền (PN, PX, đầu kỳ), bút toán ≠ tiền vốn, giá bán < giá vốn, thiếu PP tính giá vốn, CCDC thiếu TK, chiết khấu | hay gặp sau khi ghép mã hàng khác ĐVT |
| 1c | `Tiện ích\ Kiểm tra hóa đơn và bút toán thuế` (`CT_SOSANH_VAT`), `Chứng từ thiếu bút toán` (`CT_THIEU_BT`) | | |
| 2 | `Tài sản\ Cân đối tăng giảm TSCĐ` (`TAISAN_CDOTS`) từ tháng–đến tháng, chọn **"Cân đối có lập bút toán trích khấu hao"** | Lập `TmpCDOTS` (NG đầu, KH đầu, tăng/giảm NG & KH, trích KH tháng, lũy kế, giá trị còn lại, TK phân bổ) → sinh chứng từ `KH`. Thay đổi phát sinh 214 và 642/627. | hoặc tách: cân đối không lập → `Lập bút toán trích khấu hao` → (`Xóa bút toán KH`) |
| 3 | `Tài sản\ Cân đối công cụ dụng cụ` (`CCDC_CANDOI`) chọn "có lập chứng từ phân bổ hao mòn" | Lập `TmpCDOCC`, sinh chứng từ `CC` (Nợ TK_CP/Có 142,242) chi tiết từng CCDC hoặc gộp theo cặp TK (`CCDC_PBCHITIET`) | phải chạy **trước** Hạch toán cuối tháng |
| 4 | `Hàng hóa\ Cân đối vật tư, hàng hóa` (`VT_CDOVT`) từ tháng–đến tháng, chọn **"có cập nhật đơn giá vốn hàng xuất"** | Lập NXT `TmpCDOVT/VT1` từng kho từng tháng; tính giá vốn theo `PP_DGX` của kho (hoặc của dòng); **sửa lại `DG_VON` trên mọi phiếu xuất (bán, sử dụng, điều chuyển, định mức, gia công, hủy, trả…) và bút toán giá vốn** (Nợ 621/627/632…/Có 152/153/155/156). Cảnh báo tồn âm SL/tiền, sai ĐVT, "hết số lượng còn tiền". | Lựa chọn "không cập nhật" chỉ lập NXT với giá hiện có. Hàng `CODINH_GV` không bị sửa. Chạy từng tháng để xử lý âm kho dây chuyền. |
| 4b | `Hàng hóa\ Cập nhật đơn giá vốn phiếu xuất` (`VT_TINHDGXUAT`) | Chỉ ghi lại giá vốn phiếu xuất theo `DG_HT` của bảng cân đối; chọn **Bình quân theo thời điểm** hay **Bình quân gia quyền tháng** | dùng khi đã cân đối |
| 5 | `Tổng hợp\ Cân đối công nợ` (`HACHTOAN_CANDOI_CN`) từ tháng–đến tháng | Lập `TmpCDOCN` cho mọi TK `CN` | cần sau ghép mã khách; BCĐKT 2 số dư & chuyển số dư năm dùng bảng này |
| 6 | (Vụ việc/giá thành) `GT_BANGGIA_TT_TAO`, `VV_TAPHOP_*`, bước `PRE_PROC` | Tập hợp chi phí theo vụ việc/SP, tính giá thành tạm tính, cập nhật giá vốn SP nhập kho | §8 |
| 7 | `Tổng hợp\ Cân đối tài khoản` (`HACHTOAN_CANDOI_TK`) từ tháng–đến tháng, chọn **có/không xóa chứng từ kết chuyển** | Lập `TmpCDOTK`, `TmpTHOPCT_TK`; "có xóa" đưa dữ liệu về trước khi kết chuyển. Có ô "Đánh dấu trùng". | phải chạy lại khi sửa dữ liệu tháng cũ |
| 8 | `Tổng hợp\ Hạch toán cuối tháng` (`HACHTOAN_RUN`) | Chạy **từng bước** `DesHT_Buoc` theo thứ tự; mỗi bước: (a) phân bổ – mở `HACHTOAN_RUN_PB` cho sửa tỷ lệ (tổng phải = 100%); (b) kết chuyển – mở `HACHTOAN_RUN_KC` nhập "để lại" nếu khai `DELAI`; sinh chứng từ `KC` (`BUOC_KC`); (c) **cân đối tài khoản lại** làm cơ sở bước sau; đánh dấu `T01..T12` của bước. Ô "Xóa tham số kết chuyển lần trước" khi đã sửa sơ đồ. | có thể kết chuyển theo tháng/quý/năm (cân đối 1→12 rồi kết chuyển tại tháng 12) |
| 9 | `Báo cáo\ Bảng cân đối phát sinh TK` | Kiểm tra cân (đầu kỳ và phát sinh); TK 5–9 dư 0 | help "Bang can doi phat sinh" |
| 10 | Xem/in BCTC, thuế, sổ sách; `Báo cáo in liên tục` xuất cả bộ sổ năm ra Excel | | |
| 11 | `Hệ thống\ Khóa dữ liệu` theo tháng/phần hành | | |
| 12 | (Cuối năm) `Tổng hợp\ Chuyển số dư … sang năm sau` từng phần hành sau khi cân đối hết tháng 12 | | §1.6 |

Nếu điều chỉnh dữ liệu tháng cũ: chạy lại từ bước có liên quan, từ tháng đó trở đi (Cân đối TK + Hạch toán cuối tháng lại).

### 7.2 Phương pháp tính giá vốn (đơn giá xuất)

- Khai theo **kho** (`OrgDMKHO.PP_DGX`): *Bình quân gia quyền* (tháng), *Đích danh*, *Nhập trước xuất trước* (NTXT/FIFO). Có thể **đổi theo từng dòng xuất** (`OrgCTVT.PP_DGX`, cửa sổ `CT5_PX_PPDGX`). Tính riêng **từng kho, từng tháng**.
- Công thức bình quân tháng (help): `Giá TB tháng = (Tiền tồn đầu tháng + Tiền nhập trong tháng) / (SL tồn đầu + SL nhập trong tháng)`. Bình quân "theo thời điểm" (tức thời) là lựa chọn thứ hai khi cập nhật giá vốn phiếu xuất.
- FIFO/đích danh dùng `OrgDauKyVT1`/`TmpCDOVT1`/`TmpVT_DGX` theo **lô nhập** (`NHAP_ID`, `NGAY_NHAP`); đích danh chọn lô khi xuất.
- Làm tròn: đơn giá 4 số thập phân, tiền 2 số; dòng tồn SL rất nhỏ/tiền < 1đ được xóa/đưa về 0 khi cân đối & chuyển năm.
- Tồn âm thời điểm được chấp nhận nếu cuối tháng không âm; tồn âm tháng → giá vốn sai/không tính được → nhập bù kiểm kê rồi chạy lại cân đối.
- `Cố định giá vốn` giữ nguyên giá vốn một dòng xuất qua mọi lần tính lại (tiện ích `CT_CODINHGV` cập nhật hàng loạt).
- Giá vốn hàng khuyến mại tách bút toán riêng (TK khai riêng, 2023/2025).

### 7.3 Sơ đồ kết chuyển/phân bổ (`DesHT_*`)

```
DesHT_Buoc   (BUOC S PK, DIEN_GIAI, PRE_PROC v20 "chương trình xử lý phụ", STATUS, T01..T12 B = đã hạch toán tháng)
DesHT_KC_CTu (CT_ID PK, BUOC, STT_CTU, TK_KC (TK nguồn, có thể tổng hợp), TK_DICH, LOAI_KC v5, DELAI B (để lại),
              MASP B + MA_SP (kết chuyển chi tiết theo sản phẩm), MAVV B + MA_VV (theo vụ việc), DIEN_GIAI)
DesHT_KC_BToan (BT_ID, THANG_HT, BUOC, CT_ID, STT_BT, TK_TI, TK_DICH, LOAI_KC, DU_CUOI, DE_LAI, MA_SP, MA_VV)
              -- bút toán kết chuyển ĐÃ SINH từng tháng (log)
DesHT_PB_CTu  (CT_ID PK, BUOC, STT_CTU, TK_PB (TK chi tiết có số dư cần phân bổ), DIEN_GIAI, TIEN_PB,
              LOAI_PB S: 0 = tỷ lệ trực tiếp, 1 = tỷ lệ qua số dư các TK khác)
DesHT_PB_BToan (BT_ID, THANG_HT, BUOC, CT_ID, STT_BT, TK_PB, TK_DICH, TYLE_PB, TK_TYLE (TK làm cơ sở tỷ lệ), MA_VV)
```

Sơ đồ mẫu (`HACHTOAN_SETUP_NAPMAU` nạp lại khi cần):

| Bước | Diễn giải | Chứng từ kết chuyển |
|---|---|---|
| 1 | Kết chuyển giảm trừ doanh thu | 521 → 5111 |
| 2 | Kết chuyển doanh thu, chi phí | 511→911, 515→911, 632→911, 635→911, 641→911, 642→911, 711→911, 811→911, 821→911, **1331→33311** (khấu trừ thuế GTGT) |
| 3 | Xác định lãi lỗ | 911 → 4212 |

Bút toán tạo ra: với TK nguồn dư Có (511, 711, 515) → `Nợ TK nguồn / Có TK đích`; TK nguồn dư Nợ (632, 641, 642, 635, 811, 821) → `Nợ TK đích / Có TK nguồn`; 911→4212 theo dấu lãi/lỗ *(cách chọn chiều là suy luận từ kết quả KQKD "phát sinh Có 632 đối ứng Nợ 911")*. Mỗi chứng từ KC có diễn giải bút toán để in phiếu (2013); có thể kết chuyển chi tiết theo `MA_SP`/`MA_VV` (đóng vai trò 154→155 từng sản phẩm, 621/622/627→154 từng công trình). "Để lại" cho phép giữ một phần số dư không kết chuyển (ví dụ chi phí dở dang). Không khai TK kết chuyển lồng nhau trong cùng một bước (vì sau mỗi bước mới cân đối lại).

`PRE_PROC` là tên thủ tục VBA chạy trước bước (ví dụ tính giá thành) – *(suy luận từ nhãn "Chương trình xử lý phụ")*.

### 7.4 Cân đối TSCĐ/CCDC chi tiết

- TSCĐ: KH tháng = `GIATRI_KH_THANG` (= NG × tỷ lệ/12 hoặc NG/số năm/12; tùy chọn theo tỷ lệ hay số năm cho khách cũ); tháng đầu tăng có tùy chọn tính theo ngày; dừng khi `DUNG_KHAUHAO` hoặc KH lũy kế = NG (`COINBC` quyết định có in nữa không). Điều chỉnh NG (DTS) cộng vào `TANG_NG/GIAM_NG`. Giảm (GTS) ghi `GIAM_NG, GIAM_KH`. Bảng tổng hợp phân bổ KH theo TK chi phí/bộ phận/vụ việc (`TS_PHANBO_KH`, `TS_SO_KH_NAM`).
- CCDC: phân bổ theo số tháng (`SO_THANG_KH`), bắt đầu từ `NGAY_PB`; cột "Giá trị còn lại đầu kỳ = NG đầu − hao mòn đầu" để đối chiếu sổ 142/242. Thẻ CCDC/TSCĐ có cả chứng từ trích/phân bổ.

### 7.5 Chuyển số dư tháng sau / năm sau

`Chuyển số dư tài khoản sang tháng sau` (`HACHTOAN_CHUYEN_TK_THANG`) khởi tạo số dư đầu tháng kế tiếp từ `TmpCDOTK` (thực tế là bước ngầm trong Cân đối TK). Chuyển năm: đọc số dư cuối tháng 12 của `TmpCDOTK/CN/VT/TS/CC` + vụ việc → ghi vào `OrgDauKy*` của CSDL năm mới (`THANG_HT=1`); cảnh báo danh mục hai năm phải khớp (TK, kho, hàng + ĐVT, TS, CC, khách, thuộc tính `CN`).

---

## 8. Giá thành / vụ việc / công trình / định mức / hợp đồng

### 8.1 Các chiều và bảng

| Chiều | Bảng danh mục | Có mặt ở | Bảng tổng hợp |
|---|---|---|---|
| Vụ việc/công trình `MA_VV` | `OrgDMVV` (cây, có khách, giá trị HĐ, ngày) | `OrgCTKT, OrgCTVT, OrgCTVAT, OrgCTTS, OrgCTCC, OrgCTDICHVU, OrgDauKyCN, OrgDauKyVV, OrgDauKyTS/CC, DesHT_KC_CTu` | `TmpCDOTK.MA_VV`, `TmpCDOCN.MA_VV`, `TmpTHOPCT_TK.MA_VV`, `OrgDauKyVV` |
| Đối tượng/hạng mục `MA_DOITUONG` | `OrgDMDOITUONG` (gắn vụ việc, hợp đồng, khách) | `OrgCTKT, OrgCTVT, OrgCTTS` | (qua báo cáo vụ việc) |
| Sản phẩm `MA_SP` | = mã hàng trong `OrgDMVT` (`BUOC_SX`, `GT_KH`) | `OrgCTKT, OrgCTVT, DesHT_KC_*` | `TmpCDOTK.MA_SP`, `TmpTHOPCT_TK.MA_SP`, `OrgGT_BANGGIA_TT` |
| Yếu tố chi phí `MA_YEUTO`/`YEUTO_CP` | `OrgDMYEUTO` | `OrgCTKT` | báo cáo giá thành theo yếu tố |
| Mã chi phí `MA_CHIPHI` | `OrgDMCPHI` | hầu hết dòng | `CP_*` |
| Bộ phận `MA_BOPHAN` | `OrgDMBOPHAN` | header, TS, CC, đầu kỳ CN, bảng giá thành tạm tính | |
| Hợp đồng `HD_ID`/`MA_HD` | `OrgHOPDONG` | header, bút toán, vật tư, TS | sổ hợp đồng |

### 8.2 Định mức – `OrgDINHMUC_VT` (BOM)

`DM_ID, MA_SP, MA_VT, DVT, SL_TT (định mức/1 SP, 4 số thập phân), GIA_NHAP, NGAY_NHAP (ngày mua để biết giá), GIA_VON, TIEN_VON, GIA_BAN, TIEN_BAN, NVL_CHINH, NVL_PHU, GHI_CHU` + lưu vết. Form: `DINHMUC_VT` (BS/SUA định mức và NVL), `DINHMUC_VT_COPY` (copy định mức SP), `DINHMUC_VT_SOATGIA` (soát giá), `DINHMUC_VT_THIEUGIA` (NVL chưa có giá), `GC_CAPNHAT_DGNHAP` (cập nhật giá nhập); báo cáo `DINHMUC_VT`, `_BIENDONG`, `_CHUACOST`, `_SOATGIA`. Dùng để: sinh phiếu xuất NVL định mức từ phiếu nhập thành phẩm/gia công, tính giá thành kế hoạch, so sánh định mức–thực tế.

### 8.3 Cách tập hợp 621/622/627 → 154 → 155 (tổng hợp từ giới thiệu, bảng và form)

1. **Phát sinh chi phí** ghi `MA_SP`/`MA_VV` (+`MA_YEUTO`) trên bút toán: NVL trực tiếp qua `PXS`/`PXDM` (Nợ 621, `DINH_MUC` phân biệt xuất theo định mức hay tự xác định), nhân công (Nợ 622 từ phiếu kế toán/bảng lương), SXC (Nợ 627 từ chi phí, KH, CC – chứng từ KH/CC mang `MA_VV/MA_BOPHAN`).
2. **Tập hợp**: `VV_TAPHOP_CHIPHI` (tập hợp chi phí theo vụ việc/TK), `VV_TAPHOP_154` (số dư 154 theo vụ việc), `VV_CPDD_THOP` (chi phí dở dang tổng hợp), `VV_THOP_XUAT_NVL`/`VV_THOP_NHAP_NVL` (NVL xuất/nhập theo vụ việc), `VV_CDOI_PS`, `VV_CDOI_PS_TK`, `VV_CDOI_PS_KHG` (cân đối phát sinh theo vụ việc / TK / khách).
3. **Kết chuyển chi tiết**: bước kết chuyển `DesHT_KC_CTu` với `MASP/MAVV=True` tạo bút toán `Nợ 154 / Có 621,622,627` **theo từng SP/vụ việc**, rồi `Nợ 155 / Có 154` theo SP; "để lại" = chi phí dở dang cuối kỳ *(suy luận về cách dùng DELAI)*.
4. **Giá thành**: `OrgGT_BANGGIA_TT(SP_ID, THANG_HT, MA_BOPHAN, MA_SP, DG_TT)` = bảng đơn giá tạm tính/giá thành theo tháng & bộ phận (`GT_BANGGIA_TT_TAO` tạo bảng); giới thiệu nêu: giá thành tính theo yếu tố chi phí (định mức, thực tế, hoặc kết hợp), SP gia công, SP nhiều cấp (`BUOC_SX`), **tự động cập nhật đơn giá vốn SP nhập kho theo giá thành** và tự lập chứng từ giá vốn SP bán. Sổ: `GT_SO_CTIET` (sổ chi tiết giá thành), `GT_SO_CTIET_154` (dùng khi 154 không mở tiểu khoản – 2023), `GT_SO_CTIET_GT`, báo cáo `GT_BANGGIA_TT_THANG/NAM`.
5. **KQKD theo vụ việc**: `VV_KQKD`, `VV_KQKD_621`, `VV_KQKD_CTIET(_621)` – doanh thu, chi phí, lãi lỗ từng công trình (có mẫu nhìn 621 riêng); `VV_SODU` số dư vụ việc; `VV_NHATKY_PS`, `VV_BKE_CTU`, `VV_BKE_CTU_NVL`, `VV_CTIET_PS(_VT/_TK/_LT)`, `VV_SOCTIET_VT`.

Cơ chế thuật toán phân bổ gián tiếp (627 → nhiều SP theo tỷ lệ 621 chẳng hạn) được thực hiện bằng **chứng từ phân bổ** trong sơ đồ hạch toán (`TK_PB=627`, `TK_DICH=154 theo SP`, `LOAI_PB=1`, `TK_TYLE=621`).

### 8.4 Hợp đồng – `OrgHOPDONG` / `OrgHOPDONG_HHOA`

`OrgHOPDONG(HD_ID PK, OLD_ID (STT_REC năm trước), MA_HD v20, TEN_HD, SO_HD, LOAI_HD 'M'/'B', DATHANG_ID (đơn đặt hàng liên quan), NGAY_HD, MA_KHG, MA_NHANVIEN, TGTIEN_VND, TGTIEN_NTE, THUCHIEN_NAMTRUOC, PHAITHU_NAMTRUOC, PHAITRA_NAMTRUOC)`; `OrgHOPDONG_HHOA(VT_ID, HD_ID, STT, MA_VT, DVT, SL_HD, DG_VND, DG_NTE, TIEN_VND, TIEN_NTE, SLTH_NAMTRUOC, SLTH_NAMNAY, SL_CONLAI)`.

Bật bằng "Sử dụng hợp đồng trên chứng từ" (và `OrgDMCT.SUDUNG_HD`). Chứng từ gắn `HD_ID` → Sổ chi tiết hợp đồng (chứng từ, hàng hóa đã giao/nhận, tiền đã thu/trả), Sổ tổng hợp hợp đồng (giá trị HĐ, thực hiện lũy kế, còn lại, công nợ). Copy hợp đồng; chuyển số dư HĐ năm sau. Đây là "theo dõi lô hàng/đơn hàng" nhẹ, không có quy trình duyệt.

---

## 9. Thuế

### 9.1 Thuế GTGT

| Chức năng | Form/bảng | Mô tả |
|---|---|---|
| Nhập hóa đơn | tab Hóa đơn GTGT trên mọi chứng từ → `OrgCTVAT` | Số, ngày, ký hiệu, ký hiệu mẫu/mã HĐ, khách/MST (tra `OrgDMMST`, cảnh báo `OrgDMMST_TRAIPHEP`), mặt hàng (tự lấy tên hàng đầu tiên nếu chọn), doanh số, thuế suất/loại thuế (`MA_THUE`), tiền thuế, nhóm mua (01–05) / nhóm bán (theo thuế suất), đơn vị, vụ việc, mã chi phí, không khấu trừ, CK/KM. Kiểm tra trùng số HĐ (bán: số; mua: số+ký hiệu hoặc chỉ số). Tùy chọn ẩn cột không còn dùng theo TT119/2014; hạn thanh toán tự chuyển xuống HĐ mua (HTKK 3.1.1). |
| Bảng kê mua vào | `SO_VAT_60_MUA` (+ `_119`, `_CT` theo chứng từ, `_CP` theo mã chi phí, `_TS` theo thuế suất, `_VV`) | Mẫu 01-2/GTGT; lọc tháng/ngày/ký hiệu/nhóm/MST; nút Sửa CTừ; **xuất Excel** tên `VAT+MUA+THANG.xls` (Excel 97-2003) → HTKK "Tải bảng kê". Nhóm 04 xuất riêng cho tờ khai 02/GTGT dự án đầu tư. |
| Bảng kê bán ra | `SO_VAT_60_BAN` (+ `_119`, `_PL43` nhóm 8% theo NQ43/2022, `_CT`, `_VV`, `_DC`) | Mẫu 01-1/GTGT; `SO_VAT_BAN_UPDATE(_KIHIEU/_MATHUE)` cập nhật ký hiệu/loại thuế hàng loạt. Tùy chọn "lấy tên người mua làm tên khách hàng". |
| Tờ khai 01/GTGT | `SO_VAT_TOKHAI_127` + `DesBC_VAT_127(CHITIEU_ID, STT, STT_TEXT, THANG_HT, MASO, DIEN_GIAI, MASO_DS, DOANHSO, MASO_VAT, THUEVAT)` | Lập theo tháng/quý; chỉ tiêu mã số chuẩn (21..43); `DesBC_VAT_DUDAU(THANG, DU_DAU)` số còn được khấu trừ chuyển sang; `DesBC_VAT_DC(THANG_HT, MASO 06/07/08/18/19/20/25, DOANHSO, THUEVAT)` điều chỉnh tăng/giảm kỳ trước & đề nghị hoàn (12 bộ cho 12 tháng); In theo mẫu BTC; xử lý hàng ủy thác. |
| Báo cáo sử dụng hóa đơn | `DesBC_VAT_SDHD_QUY(QUY, MAU_HD, TEN_MAU_HD, HINHTHUC_HD, CON_THANGTRUOC, SO_LINH, CONG_LINH, SUDUNG, XOA_BO, MAT, NOP_TRA (từ 2011 = Hủy), CONG_SUDUNG, CON_LAI)` | BC26/AC theo quý. |
| Sổ thuế | Sổ cái/chi tiết 133, 3331; bước kết chuyển `1331→33311` | |
| Kiểm tra | `CT_SOSANH_VAT` (bút toán thuế ≠ hóa đơn), kiểm tra trùng số HĐ, `DMMST_TRAIPHEP_TIMKIEM` (tìm MST bỏ trốn trong hóa đơn đã nhập), `CT_UPDATE_MAHD/SOHD` | |
| In hóa đơn | tab "Hóa đơn GTGT in" (`OrgCTVT_HD`), mẫu tự in/đặt in NĐ51/2010 & TT153/2010, gạch chéo dòng trống, bảng kê kèm hóa đơn (`OrgCTVT_BKE`) có số/ngày bảng kê = số/ngày HĐ | |

**Định dạng xuất HTKK**: file Excel 97-2003 đúng cột bảng kê 01-1/01-2 (theo phiên bản HTKK 2.5.1 → 3.x; bỏ cột mã HĐ theo HTKK 3.2.1, thêm cột theo TT156/2013, bỏ theo TT119/2014). Không có xuất XML.

### 9.2 Thuế TNDN

- `TYLETHUETNDN=20`. Bảng `DesBC_TNDN_88_QT` (tờ khai quyết toán, 63 chỉ tiêu A1…C10), `DesBC_TNDN_88_1A` (phụ lục 03-1A kết quả SXKD), `DesBC_TNDN_88_QT_PHULUC` (chọn in phụ lục); form `SO_TNDN_QUYETTOAN_88`, `_1A`, `_DC` (điều chỉnh), `_PL`.
- Cột công thức: `MASO` (mã tính toán), `MASO_CHITIEU` (mã hiển thị A1, B2…), `TK_NO/LEN_TK_NO`, `TK_CO/LEN_TK_CO` (cặp đối ứng + số ký tự so khớp), `DK_KHAC` (công thức cộng mã số: `02+09-04-10-14`), `NGUON` (`+`, `++` = dòng tổng cấp), `NHAP_VAO` (chỉ tiêu người dùng nhập tay – toàn bộ phần B điều chỉnh tăng/giảm), `PHU_LUC`. Ví dụ: A1 Doanh thu = PS `Nợ 511 / Có 911`; A10 Giá vốn = `Nợ 911 / Có 632`; A4 Chiết khấu TM = `Nợ 511 / Có 5211`; A15 = `02+09-04-10-14`; C2 = B30 × 20% (nhập).

### 9.3 Hóa đơn điện tử (quan sát từ changelog)

- Không có tích hợp API/XML hóa đơn điện tử. Cách làm thực tế của Sunsoft từ 2024–2026: **"Nhập khẩu bảng kê hóa đơn (Excel) thành chứng từ"** – người dùng tải bảng kê HĐĐT bán ra/mua vào (từ hệ thống HĐĐT/cổng thuế/MISA) rồi import: bán ra → Phiếu xuất kho bán hàng có hàng hóa & KM (mẫu 1, 2), Phiếu bán dịch vụ, Hóa đơn bán; mua vào → Phiếu nhập kho, Hóa đơn mua không qua kho (HMX), Phiếu nhập lại, chứng từ dịch vụ (một chứng từ nhiều hóa đơn/nhiều bút toán); map mã khách theo MST, xuất file Excel mẫu, đánh lại STT hàng, nhận diện KM (SL≠0, tiền=0). Form: `CT_IMPORT_DAURA`, `_DAURA_PX`, `_DAURA_PX_2`, `_DAURA_PDV`, `_DAURA_PNL`, `_DAURA_MISA`, `CT_IMPORT_DAUVAO`, `_DAUVAO_2`, `_DAUVAO_PN`, `_DAUVAO_HMX`, `CT_IMPORT_LIST`.
- Số hóa đơn 8 chữ số theo NĐ123/TT78 (12/2021); thuế 8% (NQ43/2022, 01/2022) và 7% (10%×70%, 11/2021); CCCD trên hóa đơn cá nhân (2025–2026).
- Không thấy "hộ kinh doanh" trong changelog/help (tìm chuỗi không có kết quả); không thấy import sao kê ngân hàng (form `CT_IMPORT_CTU_NH` tồn tại nhưng không xác định được ý nghĩa; `Nhập khẩu chứng từ từ bản dữ liệu khác` là chức năng được mô tả).

---

## 10. Báo cáo

### 10.1 Quy ước tên report (770 report trong `KT.mde`)

Hậu tố: `_LT` = bản in liên tục (nhiều sổ/phiếu một lần), `_NTE` = ngoại tệ, `_2/_3/…` = mẫu số, `_SUB` = sub-report, `_GV` = có giá vốn, `_NGAY` = theo ngày (xem nhiều năm), `_KHG/_NV/_VT/_NHOM/_DOI` = tổng hợp theo khách/nhân viên/mặt hàng/nhóm/đội, `_A4` khổ ngang, `_S` = tổng hợp theo tổng chứng từ, `_N` = theo chứng từ, `_CTU/_TK` = chi tiết chứng từ / theo tiểu khoản, `_SL` = chỉ số lượng, `_1L/_2L` = 1 liên/2 liên. Mọi báo cáo xem trước (preview), in, Export Excel/Word (`ExcelExport`), Page Setup; có ô tiêu đề sửa được, ngày ký, mẫu số/QĐ số, người lập biểu/KTT/GĐ; dòng "*" bấm đúp mở chứng từ gốc (sửa tại chỗ, bấm Xem lại).

### 10.2 Danh mục báo cáo theo phân hệ

**A. Mẫu in chứng từ (CT1–CT8_*)** – 300+ report: phiếu thu/chi (4 mẫu × 1–2 liên × VND/NTE), báo nợ/có (2 mẫu), UNC (8 mẫu + NTE, theo ngân hàng), hóa đơn bán/mua (3 mẫu), hóa đơn không qua kho, phiếu dịch vụ, phiếu kế toán, phiếu nhập (7 mẫu + mẫu 13 + BBGN 4 mẫu + đơn đặt hàng + NTE), phiếu nhập khẩu (3 mẫu), nhập lại (GV, NTE), nhập khác, phiếu xuất (19 mẫu + BBGN 6 mẫu + bảng kê kèm HĐ 6 mẫu + hóa đơn GTGT 3 mẫu + báo giá + đơn hàng + GV + NTE + mẫu "NA"), điều chuyển, hủy, trả, biếu, xuất khác, gia công, nhập SP, xuất định mức, xuất SX (có vụ việc), phiếu tăng/giảm/điều chỉnh TSCĐ & CCDC (2 mẫu, A4 ngang), và **bảng kê** của từng loại chứng từ (`*_BKE`). `CT_BKE`, `CT_BKE_2` bảng kê chứng từ chung (lọc mã CT, TK, khách, vụ việc, trạng thái trùng); `CT_THIEU_BT`, `CT_SAI_KHG`, `CT_DS_SUA`, `CT_DS_XOA`.

**B. Sổ kế toán tổng hợp (SO_*, NKC_*, SOCAI_*)**

| Nhóm | Report | Tên Việt |
|---|---|---|
| Tiền | `SO_TAIKHOAN_TIENMAT(_A4,_NGAY,_NGAY_A4,_NTE,_S)`, `SO_TAIKHOAN_TIENGUI(…)`, `SO_TAIKHOAN_TMTG_NTE`, `SO_TIENMAT_NGAY(_NTE)`, `SO_TIENGUI_NGAY(_NTE)` | Sổ quỹ tiền mặt, Sổ tiền gửi ngân hàng (chỉ lấy PT/PC hoặc BN/BC; theo chi tiết chứng từ hoặc tổng chứng từ; theo ngày; ngoại tệ) |
| Nhật ký | `SO_NHATKY_THUTIEN`, `SO_NHATKY_CHITIEN`, `NKC_NHATKY_CHUNG(_2,_3,_N,_NTE,_N_2,_N_3)`, `NKC_MAU_2(_2,_NTE)`, `NKC_NHATKY_MUA/BAN/THU/CHI`, `NKC_DACBIET(_2)`, `NKC_SOCAI_CTU(_2,_NTE)`, `NKC_SOCAI_TK(_2,_NTE)` | Nhật ký thu/chi tiền, Sổ nhật ký chung (nhiều mẫu, có tìm kiếm, copy chứng từ), nhật ký mua/bán/thu/chi (đặc biệt), sổ cái theo hình thức NKC |
| Sổ cái / chi tiết | `SO_TAIKHOAN_SOCAI_CTU(_2,_3,_4,_N,_NTE,_S)`, `SO_TAIKHOAN_SOCAI_TK(_NTE)`, `SO_TAIKHOAN_SOCAI_LT(_2,_3,_4)`, `SO_TAIKHOAN_CTIET_CTU(_N,_NTE,_S)`, `SO_TAIKHOAN_CTIET_LT(_2,_3)`, `SO_TAIKHOAN_CTIET_NGAY(_NTE)`, `SOCAI_NGAY_CTU/TK(_NTE)`, `BIA_SOCAI` | Sổ cái TK (theo chứng từ / theo tiểu khoản / chữ T / không cộng tháng; mẫu 4 lấy cả 2 mã khách), Sổ chi tiết TK, theo ngày nhiều năm, bìa sổ cái, in liên tục |
| Cân đối | `SO_CDOTK`, `SO_CDOTK_BTC(_NB)`, `SO_CDOTK_CAP1`, `SO_CDOTK_CONGTK(_ME)`, `SO_CDOTK_LK`, `SO_TAIKHOAN_CDOTK_NGAY` | Bảng cân đối phát sinh TK: liên tục / cộng cấp 1 / cấp 1 / mẫu BTC / cộng TK mẹ / lũy kế / theo ngày; tùy chọn 1 hay 2 số dư TK công nợ |
| NVL | `SO_CHITIET_NVL(_2,_NTE)` | Sổ chi tiết TK kho (152/153/155/156) có số lượng |
| Tiền vay | `SoTienVay_CTIET(_NTE)`, `SoTienVay_THOP(_NTE)` | Sổ chi tiết/tổng hợp tiền vay theo khế ước |
| Đầu kỳ | `DAUKY_TK/CN/VT(_NTE)/TS/CC/VV`, `CL_DAUKY_CN_TK` | In số dư đầu kỳ; chênh lệch đầu kỳ công nợ vs TK |

**C. Công nợ (SOCONGNO_*, SO_CONGNO_*)**

`SoCongNo_CDOI_THANG(_DC,_LK,_NHOM,_NHOM_LK,_NTE,_NV,_NV_LK)` Bảng cân đối công nợ theo tháng (theo nhóm khách, nhân viên, lũy kế, ngoại tệ); `SO_CONGNO_CDOI_NGAY(_NHOM,_NTE,_NV)` theo ngày; `SoCongNo_CTiet_1…7 (_NTE)` 7 mẫu sổ chi tiết công nợ (mẫu có địa chỉ/ĐT, có hàng hóa, có 2 mã khách…); `SOCONGNO_CTIET_LT(_2,_3)` in liên tục; `SO_CONGNO_CTIET_NGAY(_NTE,_TK,_TK_NTE)`; `SO_CONGNO_TK(_NTE)` sổ công nợ theo TK; `SO_CONGNO_DOICHIEU_131/_331/_CHUNG/_2/_3/_LT…` **Biên bản đối chiếu công nợ** (phải thu/phải trả, 3 mẫu, có số TK ngân hàng, số 0 đồng bằng chữ); `SoCongNo_DenHanThu_ChiTiet/TongHop(_NTE)` nợ đến hạn thu/trả (tuổi nợ, quá hạn); `SOCONGNO_CHUT`; `RptAutoAnounceDebt` thông báo nợ tự động.

**D. Vật tư – hàng hóa (VT_*)** – 143 report

| Nhóm | Report | Tên Việt |
|---|---|---|
| Kho | `VT_THEKHO(_2,_3,_LT…)`, `VT_SOCTIET_VT(_2,_3,_4,_LT,_NTE)`, `VT_SOCTIET_NX(_GV,_NGAY)`, `VT_TONKHO(_AM,_CB,_NTE,_SL)`, `VT_KIEMKE(_2)`, `VT_BCNXT(_2,_3,_CTIET,_CTIET_2,_CTIET_KHO,_CTIET_LT,_CTIET_SL,_KHO,_KHO_SL,_LT,_NTE,_NTXT,_SL)`, `VT_CDOVT_TONAM`, `VT_TINHDGXUAT_HETHANG`, `VT_BKE_PN`, `VT_BKE_PX` | Thẻ kho (mẫu 3 có lô/hạn dùng), Sổ chi tiết vật tư, Sổ chi tiết nhập xuất, Tồn kho (âm, chỉ SL, cảnh báo), Kiểm kê, Báo cáo NXT (tổng hợp / chi tiết kho / theo ngày nhập cho NTXT / chỉ SL / ngoại tệ), tồn âm, phiếu xuất hết hàng, bảng kê PN/PX |
| Mua hàng | `VT_MUAHANG(_BKE,_BKE_NTE,_NAM,_NAM_KHG,_SOCTIET,_SOCTIET_LT,…_NTE)`, `VT_NHAP_HD(_NTE,_VT,_VT_NTE)`, `VT_NHATKY_NHAP_CTIET/KHG/NGAY/VT`, `VT_THOP_NHAP_1/2/3`, `VT_THOP_NHAP_CTIET_1/2`, `VT_THOP_NHAPLAI(_CTIET)`, `VT_TRACUU_GIAMUA_CTIET/THOP` | Báo cáo mua hàng, bảng kê mua, mua hàng năm/theo NCC, sổ chi tiết mua hàng, mua theo hóa đơn, nhật ký nhập, tổng hợp nhập, nhập lại hàng, tra cứu giá mua |
| Bán hàng | `VT_BANHANG_BKE`, `VT_BANHANG_HD(_2,_NTE,_VT,_VT_2,_VT_NTE)`, `VT_BANHANG_MATHANG(_2,_3)`, `VT_BANHANG_NAM(_KHG)`, `VT_BANHANG_NHATKY_CTIET/KHG/NGAY/VT`, `VT_BANHANG_SOCTIET(_GV,_LT,_LT_GV,_LT_NTE,_NTE)`, `VT_THOP_XUAT_BAN_CTU/KHG/KHG_THOP/NV/NV_VT/VT`, `VT_THOP_XUAT_CTIET_CTU/VT`, `VT_THOP_GIAMTRU(_KHG,_NHOM,_NV)`, `VT_XUAT_GIAVON_CTIET/KHG/NGAY/VT`, `VT_XUAT_TRA_*`, `VT_XUAT_DC(_KHG,_NV,_THOP_*,_VT)`, `VT_TRACUU_GIABAN_*` | Bảng kê bán, bán hàng theo hóa đơn (lãi gộp, %LG/DT), theo khách & mặt hàng (có %CK, thuế), bán hàng năm, sổ chi tiết bán hàng, nhật ký bán, tổng hợp xuất bán theo chứng từ/khách/NV/mặt hàng, tổng hợp giảm trừ, xuất theo giá vốn, xuất trả, xuất điều chuyển/gửi bán, tra cứu giá bán |
| Doanh số | `VT_DOANHSO_CTU/DOI/KHG/KHG_VT/NHOM/NHOM_KHG/NV/NV_VT/VT` | Doanh số & lãi gộp theo chứng từ, đội, khách, nhóm khách, nhân viên, mặt hàng (có/không KM, so định mức doanh số) |
| Kiểm soát | `VT_PN_CL_BT_TV`, `VT_PX_CL_BT_TV`, `VT_PN_SLDG_TT`, `VT_PX_SLDG_TT`, `VT_PXB_CL_DT_TB`, `VT_PXB_TIEN_CK_CL`, `VT_SAI_DVT(_DAUKY,_TRUNG)` | Chênh lệch bút toán ≠ tiền vốn, SL×ĐG ≠ thành tiền, giá bán < trung bình, chiết khấu lệch, sai ĐVT |

**E. TSCĐ (TS_*) / CCDC (CCDC_*)**: `TS_SO_TRICHKH` (bảng trích khấu hao tháng/từ tháng–đến tháng), `TS_SO_KH_NAM` (bảng tổng hợp trích KH năm), `TS_PHANBO_KH` (bảng phân bổ KH theo TK/bộ phận), `TS_THE(_LT,_LT_PT,_SUB)` (thẻ TSCĐ + phụ tùng), `TS_SO_CTIET` (sổ chi tiết tăng giảm), `TS_TANGGIAM`, `TS_KIEMKE`, `TS_THOP`, `TS_NAM`, `TS_CDOTS` (xem bảng cân đối), `TS_BKE` (bảng kê chứng từ TS); CCDC tương ứng: `CCDC_PHANBO_KH` (bảng phân bổ CCDC tháng), `CCDC_SO_TRICHKH`, `CCDC_THE(_LT)`, `CCDC_SO_CTIET`, `CCDC_KIEMKE`, `CCDC_NAM`, `CCDC_CANDOI_XEM`, `CCDC_BKE`.

**F. Vụ việc / giá thành / chi phí (VV_*, GT_*, CP_*)**: `VV_BKE_CTU(_NVL)`, `VV_CTIET_PS(_2,_LT,_NTE,_TK,_VT,_VT_2)`, `VV_CDOI_PS(_TK)`, `VV_CDOI_KHG(_VV)`, `VV_NHATKY_PS`, `VV_SOCTIET_VT(_VV)`, `VV_SODU`, `VV_TAPHOP_CHIPHI`, `VV_TAPHOP_154_NO`, `VV_CPDD_THOP`, `VV_THOP_PS`, `VV_THOP_NHAP_NVL(_CTIET,_KHG)`, `VV_THOP_XUAT_NVL(_CTIET,_KHG)`, `VV_KQKD(_621)`, `VV_KQKD_CTIET(_621)`; `GT_SO_CTIET`, `GT_SO_CTIET_154`, `GT_SO_CTIET_GT`, `GT_BANGGIA_TT_THANG/NAM`, `DINHMUC_VT(_BIENDONG,_CHUACOST,_SOATGIA)`; `CP_MAPHI_CTIET`, `CP_MAPHI_THOP_THANG/QUI/NAM/THANG_VV`, `CP_SXKD` (sổ chi phí SXKD), `CP_THOP_NAM`.

**G. Dịch vụ, hợp đồng**: `DV_BAN_CTIET/THOP`, `DV_MUA_CTIET/THOP`, `DV_THOP_MUABAN`; `HOPDONG_MUA/BAN(_BKE)`, `HOPDONG_SOCTIET`, `HOPDONG_SOTHOP`.

**H. Thuế**: `SO_VAT_60_MUA(_119,_CP,_CT,_TS,_VV)`, `SO_VAT_60_BAN(_119,_CT,_DC,_LT,_PL43,_VV)`, `SO_VAT_TOKHAI_127`, `SO_TNDN_QUYETTOAN_88(_1A,_SUB)`.

**I. Báo cáo tài chính (BC_*)**

| Chế độ | Bảng CĐKT | KQKD | Nghĩa vụ NSNN | LCTT |
|---|---|---|---|---|
| QĐ15 | `BC_BGCDKT_15(_TAISAN,_NGUONVON,_NGOAIBANG)` | `BC_KQKD_LAILO_15(_LUYKE,_NAM)` | `BC_KQKD_NVU_15` | `BC_LCTT_15_QUY/_NAM` |
| QĐ48 | `BC_BGCDKT_48(…)` | `BC_KQKD_LAILO_48(…)` | `BC_KQKD_NVU_48` | `BC_LCTT_48_QUY/_NAM` |
| TT244 | `BC_BGCDKT_244(…)` | `BC_KQKD_LAILO_244(…)` | `BC_KQKD_NVU_244` | `BC_LCTT_244_QUY/_NAM` |
| TT138 | `BC_BGCDKT_138(…)` | `BC_KQKD_LAILO_138(…)` | `BC_KQKD_NVU_138` | `BC_LCTT_138_QUY/_NAM` |
| TT133 | `BC_BGCDKT_133_B01A`, `_B01B`, `_B01SN` | `BC_KQKD_LAILO_133`, `_SN` | `BC_KQKD_NVU_133` | `BC_LCTT_133` |
| TT200 | `BC_BGCDKT_200` | `BC_KQKD_LAILO_200` | `BC_KQKD_NVU_200` | `BC_LCTT_200` |
| TT99 | `BC_BGCDKT_99` | `BC_KQKD_LAILO_99` | – | `BC_LCTT_99` |

Kèm `BCTC_CTIET_TK` (chi tiết phát sinh theo công thức của một chỉ tiêu – thuyết minh), các form `*_NB` (ngoài bảng), `BCTC_NAPMAU` nạp công thức, `BC_*_SUB` sửa công thức. Mẫu in: theo tháng (2 cột đầu năm/cuối kỳ), theo năm; KQKD theo kỳ/lũy kế/năm (cột năm trước máy lập hoặc tự nhập); báo cáo lập **từ ngày–đến ngày**, cho phép niên độ lệch (01/07–30/06).

**J. Danh mục in**: `DM*` (1 report/danh mục), `HACHTOAN`, `HACHTOAN_KC`, `HACHTOAN_PB` (in sơ đồ hạch toán), `SYS_ACTION` (nhật ký).

### 10.3 Cơ chế định nghĩa báo cáo tài chính theo dòng (`DesBC_*`)

Mỗi BCTC là một **bảng dòng** do người dùng sửa được (nút *Sửa công thức*, *Nạp công thức* từ file mẫu hoặc từ năm đã có). Cột hiển thị chung: `HIEN_AN` (ẩn/hiện), `KIEU_CHU` (`B` béo, `BH` béo hoa), `SO_AM` (âm trong ngoặc hay dấu −), `MAU_DAM` (tô đậm dòng tổng), `THUYET_MINH`, tên tiếng Anh.

**Bảng cân đối kế toán – `DesBC_CDKT_B01_99` (118 dòng)**: `MASO` (mã chỉ tiêu, PK), `TEN_TK`, `NGUON` (`""` = lấy số dư từ `TmpCDOTK`; `CN` = lấy từ bảng cân đối công nợ `TmpCDOCN` tách 2 số dư; `+`, `++`, `+++`… = dòng tổng cộng cấp n), `TK` (một TK/tiền tố), `LOAI_DU` (`N` chỉ lấy dư Nợ, `C` chỉ dư Có, `N-C` = dư Nợ − dư Có (ký số, có thể âm), `C-N`), `DK_KHAC` (biểu thức SQL/VBA trên `TK_TI` hoặc `MASO` cho dòng tổng), `DU_DAU`, `DU_CUOI` (+`_NTE`) = kết quả.

Ví dụ dòng (đọc từ dữ liệu):

| MASO | Chỉ tiêu | NGUON | TK | LOAI_DU | DK_KHAC | Diễn giải cách tính |
|---|---|---|---|---|---|---|
| 111 | 1. Tiền | | | N-C | `Left(TK_TI,3) In('111','112','113')` | Σ(dư Nợ − dư Có) của mọi TK bắt đầu 111/112/113 |
| 131 | 1. Phải thu ngắn hạn của khách hàng | CN | 131 | N | | Σ dư Nợ **từng khách** của TK 131 (từ `TmpCDOCN`) |
| 312 | 2. Người mua trả tiền trước | CN | 131 | C | | Σ dư Có từng khách của 131 – cùng TK xuất hiện ở 2 chỉ tiêu |
| 141 | 1. Hàng tồn kho | | | N-C | `Left(TK_TI,3) In('151',…,'158')` | |
| 223 | – Giá trị hao mòn lũy kế (*) | | 2141 | N-C | | âm (trình bày trong ngoặc) |
| 319 | 9. Phải trả ngắn hạn khác | | | C | `(Left(TK_TI,3) In('138','338')) AND (Left(TK_TI,4)<>'3387')` | |
| 110 | I. Tiền và tương đương tiền | + | | | `MASO In('111','112')` | tổng cấp 1 |
| 270 | Tổng cộng tài sản | ++++ | | | `MASO In('100','200')` | tổng cấp 4 |

**KQKD – `DesBC_KQKD_LAILO_99` (28 dòng)**: `TK_TI` + `TK_DU` (TK đối ứng) + `LOAI_PS` (`C` = phát sinh Có TK_TI; `C-N`, `N-C` = chênh lệch hai chiều đối ứng) + `DIEU_KIEN` + `NGUON` (`+`…) + `NHAP` (cho nhập tay) → `KY_NAY, KY_TRUOC, LUY_KE, NAM_TRUOC`. Ví dụ: `01` Doanh thu = PS Có 511 (không cần đối ứng); `11` Giá vốn = `632` đối ứng `911` loại `C-N` (PS Có 632/Nợ 911 trừ chiều ngược – nên **phải kết chuyển** mới có số); `04` Giảm giá hàng bán = `5212` đối ứng `511` loại `C`; `06` Thuế XNK/TTĐB/GTGT trực tiếp = `333` đối ứng `511`, điều kiện `Left(TK_TICO,4) In('3331','3332','3333')`; `10` Doanh thu thuần = `MASO In('01') - (MASO Between '03' And '06')`; `60` LNST = `MASO='50' - MASO In('51','52')`.

**LCTT trực tiếp – `DesBC_LCTT_TTIEP_99` (32 dòng)**: `TK_NO` (danh sách TK Nợ, phân cách phẩy), `LEN_TK_NO` (số ký tự so khớp), `TK_CO`, `LEN_TK_CO`, `DK_KHAC` (điều kiện thêm hoặc công thức cộng mã số cho dòng tổng, ví dụ `01+06+02+03+04+05+07`), `CHI_TIET` (1 = dòng tiêu đề/tổng), `Q0..Q4` (số theo quý). Ví dụ: `01` Tiền thu bán hàng = PS `Nợ 111,112 / Có 511,131` (so 3 ký tự); `02` Tiền chi NCC = `Nợ 152,153,154,155,156,331,131,621,622,623,627,632,641,642 / Có 111,112,341`, `Left(TK_TINO,4)<>'3334'`; `05` Thuế TNDN đã nộp = `Nợ 3334 (4 ký tự) / Có 111,112`; `61A/61B` ảnh hưởng tỷ giá = 413 đối ứng tiền; `60` Tiền đầu kỳ lấy từ số dư đầu kỳ 111/112; `70 = 50+60+61`. Nguồn số: `TmpTHOPCT_TK` (tổng hợp cặp đối ứng theo tháng) *(suy luận)*.

**Nghĩa vụ NSNN – `DesBC_KQKD_NVU_*`**: `TAIKHOAN` (333x), `DK_KHAC`, `CTHUC_DANOP` (công thức xác định chứng từ đã nộp), `DU_CO1` (còn phải nộp đầu kỳ), `PHAI_NOP` (= tổng PS Có − giảm trừ/khấu trừ), `DA_NOP`, `_LK`, `DU_CO2`.

Điểm mạnh của cơ chế: báo cáo tài chính = dữ liệu, thay đổi chế độ/HTTK không cần sửa code; có "chi tiết phát sinh theo công thức" để truy ngược. Điểm yếu: công thức là chuỗi SQL rải trong cột `DK_KHAC`, phụ thuộc đã kết chuyển, không có kiểm tra tính đầy đủ (dòng không nhặt TK nào → lệch TS–NV, help phải hướng dẫn tự soát).

---

## 11. Tiện ích / kiểm soát

### 11.1 Soát lỗi chứng từ – `DesDataErr` (12 kiểm tra, cột `ERR_FORMULA` là mệnh đề SQL Jet)

| # | Lỗi | Bảng/điều kiện | Hậu quả nêu trong help |
|---|---|---|---|
| 0 | Ngày/tháng hạch toán không hợp lệ | ngày chứng từ không thuộc năm làm việc | |
| 1 | Thiếu ngày chứng từ | `OrgCTCHUNG.NGAY_CT is null` | |
| 2 | Tháng hạch toán ≠ tháng chứng từ | `THANG_HT <> Month(NGAY_CT)` | cảnh báo, có thể cố ý |
| 3 | Chứng từ không có bút toán | `left join OrgCTKT … is null and MA_CT<>'PNS'` | chứng từ rác → xóa |
| 4 | Bút toán thiếu TK hoặc thiếu tiền | `TK_TINO null or TK_TICO null or Nz(TIEN_VND)=0` | lệch PS Nợ–Có trên BCĐPS |
| 5 | Thiếu mã khách phải thu | `OrgDMTK.TC_KHAC='CN' (bên Nợ) and MA_KHG_NO is null` | lệch 2 số dư, lệch TS–NV, số dư TK ≠ bảng công nợ |
| 6 | Thiếu mã khách phải trả | tương tự bên Có | |
| 7 | Chứng từ vật tư không có vật tư | `Left(MA_CT,2) In('PX','PN') and OrgCTVT null` | |
| 8 | Thiếu SL hoặc đơn giá vốn | `(SL_TT=0 or DG_VON=0) and KHONGTINH_NXT=False and KM=False` | chạy cân đối có cập nhật ĐG vốn (lưu dự phòng trước) |
| 9 | Chứng từ vật tư thiếu mã kho | `MA_CT<>'HMX' and MA_KHO null` | hay gặp khi nhiều kho |
| 10 | Chứng từ TSCĐ thiếu tham số | `MA_CT In('TTS','GTS') and (TK_TI/TK_TIDU/TK_TRICH null or NG_GIA/SO_NAM_KH/GIATRI_KH_THANG=0)` | |
| 11 | Chứng từ CCDC thiếu tham số | `MA_CT In('CCT','CCG') and (TK_CC/TK_CP null or NG_GIA/SO_THANG_KH/GIATRI_KH_THANG=0)` | |

Bảng có `ERR_CHECK` (bật/tắt), `ERR_HELP` (hướng dẫn); form `SYS_DATAERR_DES` cho **người dùng/triển khai thêm kiểm tra mới bằng SQL** – ý tưởng "rule engine" đơn giản đáng học.

### 11.2 Kiểm tra chênh lệch (`SYS_CTU_LECH*`) và các kiểm tra khác

Sai ĐVT (đầu kỳ `_DVT_DKY`, `_DVT_DKY1`, chứng từ `_DVT`, trùng ĐVT `_DVT_TRUNG`, hệ số `_DVT_HESO`), SL×ĐG ≠ thành tiền (PN `_PNSL`, PX `_PXSL`, đầu kỳ `_SLDG_DKY`), bút toán ≠ tiền vốn (`_PN`, `_PX`), chênh lệch đầu kỳ công nợ (`_DKY_CN`), giá bán < giá vốn (`_GBGV`), phiếu xuất thiếu PP giá vốn (`SYS_CTU_THIEU_PPDGX`), xuất trung bình (`_PXTB`), chiết khấu (`_CK`), CCDC thiếu TK (`_CC_THIEU_TK`). `CT_THIEU_BT` chứng từ thiếu bút toán; `CT_SOSANH_VAT` thuế; `CT_HOI_SO` hỏi số; `Kiểm tra Index chứng từ`; kiểm tra ngày chứng từ với ngày máy; kiểm tra trùng số chứng từ; kiểm tra TK ngầm định tồn tại khi lập bút toán.

### 11.3 Danh sách tiện ích (menu Tiện ích) và form

| Tiện ích | Form | Mô tả |
|---|---|---|
| Xác nhận chứng từ | `CT_XACNHAN` | đánh dấu `XACNHAN` hàng loạt theo lọc; quyền sửa sau xác nhận riêng |
| Copy (nhân bản) chứng từ | `CT_COPY_CTU` (cũng có nút trên bảng kê/sổ) | ngày = hiện tại hoặc gốc; `THANG_HT=Month(ngày)`; kiểm tra khóa |
| Đánh lại số phiếu / Xóa số phiếu | `CT_REMAKE_STT`, `CT_XOA_SO_CHUNGTU` | theo tháng/quý/năm, chèn ký tự |
| Cố định giá vốn | `CT_CODINHGV` | cập nhật/bỏ `CODINH_GV` nhiều dòng |
| Cập nhật hàng loạt | `CT_UPDATE_GIANHAP`, `CT_UPDATE_GIAVON(_PXL)`, `CT_UPDATE_KM`, `CT_UPDATE_MAHD`, `CT_UPDATE_SOHD`, `CT_UPDATE_SOPX`, `CT_UPDATE_STT_KHOAN`, `CT_UPDATE_TENMATHANG`, `CT_UPDATE_BT_PX`, `CT_UPDATE_LIST` | giá nhập, giá vốn, trạng thái KM, mã/ký hiệu HĐ, số HĐ, số PX, STT hàng, tên mặt hàng trên HĐ, lập lại bút toán phiếu xuất, chuyển số HĐ lên chứng từ gốc |
| Xóa | `CT_XOA_CHUNGTU` (theo tháng/mã CT/số/kho), `CT_XOA_DAUKY`, `CT_XOA_CANDOI` (xóa bảng cân đối từng loại – đổi tháng đầu kỳ) | |
| Nhập khẩu / xuất khẩu chứng từ | `CT_XUATKHAU_CHUNGTU` (chọn tháng, mã CT, đơn vị, TK, kho → file), `CT_IMPORT_CHUNGTU`, `SYS_IMPORT_CTU` (nối dữ liệu nhiều người nhập trên nhiều bản) | file nén gửi email |
| Nhập khẩu danh mục / số dư | `SYS_IMPORT_DM` (đồng bộ danh mục giữa các năm), `SYS_IMPORT_DKY`, "Mở khóa" copy từ Excel trong từng danh mục/đầu kỳ | |
| Nhập khẩu bảng kê hóa đơn (Excel) | `CT_IMPORT_LIST`, `CT_IMPORT_DAURA*`, `CT_IMPORT_DAUVAO*`, `CT_IMPORT_DAURA_MISA` | §9.3; có nút xuất file Excel mẫu |
| Tra cứu | `VT_TRACUU_GIABAN/GIAMUA`, `DMMST_TRAIPHEP_TIMKIEM`, `VT_HOISOTON_NHOM` | |
| Lịch sử | `CT_DS_SUA`, `CT_DS_XOA`, `SYS_ACTION` | |
| Danh mục | Ghép mã (mọi danh mục), `DMTK_DOIMA` đổi số hiệu/ghép TK, khóa danh mục | sau ghép phải cân đối lại |
| Hệ thống | `SYS_BACKUP(_DIRECT)`, `SYS_RESTORE`, `SYS_COMPACT`, `SYS_STRUC_UPGRD`, `SYS_TAO_NAMMOI`, `SYS_TAO_DONVI`, `SYS_DELETE_DATABASE`, `Đặt Security warning`, `Đặt font` | |
| Báo cáo | In liên tục (`SO_LIENTUC_LIST`: sổ cái/chi tiết TK, công nợ, biên bản đối chiếu, thẻ kho, sổ chi tiết VT, thẻ TS/CC, phiếu; xuất Excel 1 sheet hoặc mỗi sổ một sheet), Xem nhiều năm (`SO_NGAY_LIST`) | |

---

## 12. Lịch sử tính năng 2011 → 03/2026 (từ `OrgDMUPDATE`, ~380 mục)

| Năm | Số mục | Chủ đề chính |
|---|---|---|
| 2011 (từ 20/11) | 6 | BCTC theo TT138 sửa QĐ48; nút Chi tiền trên phiếu tăng TS/CCDC; chọn hóa đơn mua/bán, phiếu nhập/xuất khi làm PC/PT; hạn thanh toán trên HM/HB/PDV/PN; bút toán nhiều tỷ giá trên phiếu ngoại tệ; bảng kê chứng từ TS/CCDC; sửa chuyển số dư năm. |
| 2012 | 63 | Danh mục chi nhánh khách hàng, đội bán hàng, đối tượng tập hợp chi phí, hãng SX/chủng loại; phiếu xuất biếu tặng; xuất thẳng thành lựa chọn trên PN; vụ việc theo từng dòng vật tư; TK 113; mẫu NKC, sổ cái A4 ngang; mẫu số/QĐ/ngày ký khai được; bảng tổng hợp KH năm; lưu vết xóa chứng từ/đầu kỳ; kiểm tra trùng số chứng từ, SL×ĐG; HTKK 3.1.1 (hạn thanh toán xuống HĐ mua); trích KH theo ngày tháng đầu; in liên tục HB/HM; gạch chéo hóa đơn; bỏ SendKeys (Win7). |
| 2013 | 59 | Phiếu mua dịch vụ + báo cáo dịch vụ; sổ chi tiết nhập xuất VT, thẻ kho/sổ chi tiết/công nợ/sổ cái **in liên tục**; số lô/ngày SX/hạn dùng/số ĐK trên chứng từ & danh mục; thuế suất VAT/TTĐB/NK trong danh mục hàng; thuế TTĐB trên PX/PDV; cửa sổ kiểm tra chứng từ thiếu bút toán; biên bản đối chiếu công nợ; tăng số chứng từ theo tháng; cột SL tồn trên phiếu xuất, nút Hỏi số tồn; số lệnh xuất; tách bút toán thuế GTGT hàng NK; trả CK/KM trên HĐ bán; cập nhật cố định giá vốn; chi nhánh khách trên HB/PX/PNL; giá vốn làm tròn 4 số; nạp công thức BCTC từ năm cũ; mẫu phiếu A5; kiểm tra điều kiện khi nhập khẩu chứng từ; lọc theo đơn vị. |
| 2014 | 29 | TT156/2013 (mã HĐ, ký hiệu mẫu), rồi TT119/2014 (bỏ cột); HTKK 3.2.1; danh mục nhóm dịch vụ; mã đơn vị trên hóa đơn (công ty/chi nhánh); BBGN trên PX; sổ nhật ký thu/chi; **sổ & BCTC xem nhiều năm**; nhập khẩu số dư đầu kỳ; cửa sổ hạch toán cuối tháng xem chi tiết bút toán KC, ngày chứng từ KC mặc định cuối tháng; chọn trích KH theo tỷ lệ/số năm; NXT theo ngày nhập (NTXT); doanh số có/không KM; cân đối công nợ theo nhân viên; sao lưu nhật ký ra text. |
| 2015 | 19 | Mã vụ việc trên hóa đơn GTGT & bảng kê; tờ khai GTGT theo quý; chuyển số dư vụ việc; kiểm tra PP giá vốn trên PX; số ngày trích TS/CC từ ngày tăng; kiểm tra ngày chứng từ vs ngày máy; tiêu đề KTT/GĐ; lỗi Access 2007+ (3054); diễn giải chứng từ/bút toán trên sổ cái. |
| 2016 | 9 | **BCTC TT133/2016** (28/12/2016); Unicode (03/2016); 2 số dư TK công nợ trên BCĐPS; số HĐ 7 chữ số; phụ tùng kèm TSCĐ; bảng kê VAT theo TT119/TT156/vụ việc; F4 tìm kiếm. |
| 2017 | 4 | Mã chi phí cho CCDC; chi nhánh ngân hàng trong DMTK (UNC); mẫu thẻ kho/sổ chi tiết không cột tồn; sổ hợp đồng. |
| 2018 | 7 | BCTC TT133 theo HTKK 3.8.2; tách doanh thu theo vụ việc khi lập bút toán HB; thẻ TSCĐ có giảm NG/KH; mã chi phí khi chuyển số dư TS/CC; cột ủy thác; tìm kiếm trên bảng tổng hợp công nợ. |
| 2019 | 9 | Bảng giá theo mã hàng + ĐVT + khách; vụ việc khi lập bút toán theo hóa đơn; bấm đúp mở sửa từ sổ/danh mục; mẫu phiếu có chi phí/giá vốn/lãi gộp; sổ hợp đồng, copy hợp đồng. |
| 2020 | 13 | Phân quyền xem giá vốn trên PX & báo cáo; diễn giải chứng từ/bút toán trên bảng kê; nhân viên trên hợp đồng; hiện phần thập phân; mẫu BCTC TT133 siêu nhỏ; UNC BIDV/Vietinbank/VCB. |
| 2021 | 32 | Thu/chi tiền trên BN/BC; Copy chứng từ trên bảng kê; dừng khấu hao trên phiếu tăng TS/CC; công thức BCĐKT TT200; mở khóa copy từ Excel (bảng giá, đầu kỳ TK/CN); cảnh báo tồn âm/sai ĐVT trên NXT; sổ cái/chi tiết in liên tục xuất Excel nhiều sheet; phiếu tăng/giảm TS/CC A4 ngang + xuất Excel; thuế 7% (10%×70%); **số HĐ 8 chữ số NĐ123/TT78**; hướng dẫn khi BCĐKT/BCĐPS không cân. |
| 2022 | 27 | Nhóm 8% NQ43/2022 trên bảng kê bán; khóa dữ liệu khi chuyển năm; bảng kê VAT theo chứng từ/ký hiệu; mã TS/CC 25 ký tự; mẫu PN/PX có số lô, hạn dùng (dược); tùy chọn không thêm số 0 số HĐ; lưu bản trước bảo trì; xuất định mức lấy hàng từ danh mục; cảnh báo hết SL còn tiền; NXT mẫu 2; sổ chi tiết bán hàng có giá vốn. |
| 2023 | 36 | UNC Techcombank/Sacombank/Agribank (in vào mẫu giấy), chi nhánh NH nhận, CCCD; mã chi phí trên hóa đơn GTGT & bảng kê mua; NKC mẫu 2; BCĐPS cộng TK mẹ; kiểm tra khóa khi copy Excel đầu kỳ; NXT chi tiết kho xuất mỗi kho một sheet; TK giá vốn hàng KM; sổ chi tiết giá thành 154 không tiểu khoản; định mức 4 số thập phân; in báo giá/đơn đặt hàng/biên bản kiểm nhận; biên bản đối chiếu 0 đồng; nút Copy trên NKC/sổ cái; UNC BIDV 2023; kiểm tra trùng số+ký hiệu HĐ mua. |
| 2024 | 25 | Khóa danh mục; sổ chi tiết TK/công nợ/BCĐTK/BCĐCN xem nhiều năm; mẫu thẻ kho có lô/hạn; BBGN mẫu 4 (nhiệt độ/độ ẩm); mã chi phí trên HĐ GTGT (phân loại 8%); bảng kê mua theo thuế suất; UNC Techcombank; tên tiền xu; in đơn đặt hàng trên PX; hình thức TT trên PN/HM; cột địa chỉ/người nhận trên nhật ký thu chi; LCTT lấy thêm 341; cấu trúc lưu hóa đơn bán ra đổi (Access 2007+); **Nhập khẩu bảng kê HĐ bán ra → phiếu xuất; mua vào → phiếu nhập (25/12/2024)**. |
| 2025 | 34 | Loạt **nhập khẩu bảng kê hóa đơn thành chứng từ**: PN/PX có diễn giải, CK, map mã khách theo MST, file Excel mẫu, dịch vụ không hàng hóa (mẫu 2, nhiều HĐ/nhiều bút toán), nhập lại, phiếu bán dịch vụ, địa chỉ, vụ việc; CCCD trong DM khách & PX; UNC TPBank; tra cứu giá nhiều năm + Excel; khuôn dạng giá ngoại tệ; PX sử dụng có ngoại tệ; sổ chi tiết vụ việc in liên tục; BCTC TT200 tiền không lấy 128; KQKD/LCTT nút Chi tiết chỉ tiêu; **BCTC TT99/2025 (11/11/2025)**; bảng kê VAT có cột tháng HT; xóa STT chứng từ tự động; **Hóa đơn mua hàng không qua kho (HMX)**; thuế suất trên bảng kê PN/PX/tồn; công cụ đánh lại STT hàng, cập nhật KM, lập lại bút toán PX; PNX/PXB lên sổ công nợ có hàng hóa. |
| 2026 (đến 05/03) | 8 | Nhập khẩu bảng kê mua không qua kho; BBGN mẫu 5 (quốc hiệu, đại diện 2 bên), mẫu 6; CCCD/ĐT trên phiếu nhập & mẫu in; bảng kê mua/bán thêm thông tin ra Excel; mã chi phí trên trang vật tư PN/PXS và tổng hợp NVL theo vụ việc; sổ chi tiết mã chi phí nhiều năm. |

Nhận xét: nhịp cập nhật 2012–2013 rất cao (mỗi tuần), 2016–2019 thưa, hồi lại từ 2021. Chủ đề lặp lại nhiều nhất: **mẫu in** (phiếu, UNC từng ngân hàng, BBGN), **xuất Excel**, **in liên tục**, **xem nhiều năm**, cập nhật **biểu mẫu thuế** theo từng thông tư. Những năm gần đây tập trung vào **import bảng kê HĐĐT** thay vì tích hợp API.

---

## 13. Đánh giá và danh sách nghiệp vụ bắt buộc

### 13.1 Điểm mạnh đáng học

1. **Chứng từ = header + nhiều "trang" chi tiết dùng chung một STT_REC**: bút toán, vật tư, hóa đơn GTGT, tài sản, CCDC, dịch vụ cùng gắn vào một chứng từ; một phiếu xuất vừa là phiếu kho, vừa là hóa đơn, vừa là bút toán. Hóa đơn GTGT là **dữ liệu kê khai riêng** (nhiều hóa đơn/chứng từ) không bị trói vào bút toán.
2. **Nút "Lập bút toán"** sinh định khoản từ tham số TK ngầm định + TK kho + danh mục dịch vụ, nhưng vẫn cho sửa tay / tắt tự động; cờ `BT_GIAVON/BT_THUE/BT_DOANHTHU/BT_CK` phân biệt bút toán máy và tay để có thể lập lại.
3. **Chiều phân tích phong phú trên từng dòng** (`MA_KHG_NO/CO, MA_VV, MA_DOITUONG, MA_SP, MA_CHIPHI, MA_YEUTO, MA_BOPHAN, MA_NHANVIEN, MA_HD, MA_TAU`) → tránh bùng nổ tiểu khoản; "mã chi phí thay tiểu khoản" là ý tưởng tốt.
4. **Sơ đồ kết chuyển/phân bổ là dữ liệu** (`DesHT_*`) với bước, thứ tự, để lại, chi tiết theo SP/vụ việc, phân bổ theo tỷ lệ số dư TK khác; chạy từng bước và cân đối sau mỗi bước.
5. **BCTC/tờ khai định nghĩa theo dòng** (`DesBC_*`) với công thức số dư/đối ứng, nạp lại mẫu, sửa được, truy ngược "chi tiết phát sinh theo công thức"; hỗ trợ 7 chế độ kế toán và niên độ lệch.
6. **Soát lỗi dữ liệu bằng bảng SQL** (`DesDataErr`) + bộ kiểm tra chênh lệch kho/công nợ/thuế; mỗi lỗi có hướng dẫn hậu quả và nút sửa tại chỗ.
7. **Truy ngược từ sổ về chứng từ** ở mọi báo cáo (dòng `*`, bấm đúp), sửa rồi "Xem lại".
8. Kho: nhiều kho/phiếu, giá vốn theo kho & tháng với 3 phương pháp, đổi phương pháp từng dòng, cố định giá vốn, cập nhật ngược giá vốn vào bút toán, cảnh báo tồn âm/sai ĐVT, đa ĐVT, lô/hạn dùng, hàng không tính NXT, KM/CK/giảm giá/hỗ trợ/phí xăng dầu từng dòng, phân bổ chi phí mua hàng/thuế NK ngay trên phiếu nhập, xuất thẳng, xuất định mức từ phiếu nhập thành phẩm.
9. **Khử trùng chứng từ** cho phép hai kế toán nhập độc lập PT và BN cùng nghiệp vụ.
10. Vận hành: bộ lọc nhớ theo form (`OrgSysFormVar`), in liên tục cả bộ sổ năm ra Excel nhiều sheet, xem nhiều năm, in UNC theo mẫu ngân hàng, biên bản đối chiếu công nợ, bổ sung danh mục ngay tại ô mã (F4/F5), ghép mã, nhập khẩu bảng kê HĐĐT thành chứng từ, nhật ký nâng cấp hiển thị trong phần mềm, trợ giúp ngữ cảnh sửa được.
11. Quyền thực dụng: xem giá vốn, xem 131/331, sửa sau xác nhận, khóa theo phần hành/tháng/ngày/tự động sau N ngày, khóa danh mục.

### 13.2 Điểm yếu / hạn chế

| Vấn đề | Chi tiết |
|---|---|
| Nền Access/Jet | Giới hạn 2 GB/file, khóa trang (Max Lock), cần compact định kỳ, chạy trên LAN chia sẻ file (dễ hỏng khi mất mạng), không web/mobile, phụ thuộc Access runtime và font/locale Windows (nhiều trang help chỉ để chỉnh font, dấu phẩy thập phân, Security warning). |
| 1 CSDL / năm | Chuyển số dư thủ công từng phần hành, phải khớp danh mục hai năm, báo cáo nhiều năm là "vá" bằng cách mở nhiều file; chứng từ ngày khác năm không hợp lệ; sửa năm cũ phải chuyển kết nối. |
| Snapshot tháng (`Tmp*`) | Báo cáo chỉ đúng sau khi chạy đúng thứ tự Cân đối TS → CCDC → VT → CN → TK → Hạch toán; sửa dữ liệu cũ phải chạy lại tất cả từ tháng đó; người dùng phải hiểu "đã cân đối đến tháng nào". |
| Không có khóa ngoại, không transaction | Toàn vẹn phụ thuộc VBA; soát lỗi phát hiện sau (chứng từ không bút toán, thiếu mã khách…). |
| Audit trail hạn chế | Chỉ lưu người/máy/giờ nhập-sửa-xóa cuối cùng + nhật ký hành động dạng text; không lưu giá trị trước/sau; mật khẩu 10 ký tự, nhóm quyền là blacklist menu. |
| Bút toán Nợ/Có kép | Mỗi dòng một cặp TK: không biểu diễn được định khoản 1 Nợ – n Có tự nhiên (phải tách dòng), khó cho bút toán nhiều chiều; mã khách phải điền cả hai bên. |
| Ngoại tệ | Tỷ giá nhập tay theo chứng từ, không bảng tỷ giá, không đánh giá lại cuối kỳ tự động (chỉ có dòng LCTT 413), không tỷ giá ghi sổ cho công nợ. |
| Đa chi nhánh/đơn vị | `MA_DONVI` chỉ là chiều lọc; không hợp nhất, không phân quyền theo đơn vị; mỗi đơn vị độc lập là một bộ số liệu. |
| Hóa đơn điện tử | Không ký số/phát hành/tra cứu HĐĐT; chỉ in mẫu NĐ51 và import bảng kê Excel; bảng kê HTKK bằng Excel 97-2003. |
| Ngân hàng | Chỉ in UNC theo mẫu, không import sao kê/kết nối API. |
| Giá thành | Cơ chế dựa vào kết chuyển/phân bổ theo SP và bảng giá tạm tính; không có mô hình dở dang/đánh giá SPDD rõ ràng, không giá thành theo công đoạn nhiều cấp tự động (chỉ cờ `BUOC_SX`); tài liệu rất ít. |
| Lương/nhân sự | Nêu "bảng chấm công, bảng lương" nhưng không có form/bảng → có thể là Excel ngoài. |
| UI/nhập liệu | 941 form Access, nhiều biến thể mẫu in (19 mẫu phiếu xuất) → chi phí bảo trì lớn; tùy biến theo khách (Tin Thành, Hiệp Hưng, Hoàng Mai, Lê Quý Đôn, đội tàu) nằm chung trong schema. |
| Số liệu tham chiếu khác đề bài | Chỉ 43 loại chứng từ và 29 bản ghi trợ giúp trong CSDL mẫu. |

### 13.3 Danh sách "nghiệp vụ bắt buộc phải có" rút ra cho phần mềm mới

**Danh mục & cấu hình**
1. Hệ thống tài khoản dạng cây, nhiều chế độ (TT133/TT200/TT99), thuộc tính: loại dư (N/C/L), chi tiết/tổng hợp, theo dõi ngoại tệ, công nợ (CN), vật tư (VT), TSCĐ (TS), mã chi phí, vụ việc; đổi số hiệu/ghép tài khoản có dữ liệu.
2. Đối tượng công nợ dùng chung nhiều TK (khách, NCC, nhân viên, khế ước vay), nhóm, chi nhánh giao hàng, nhân viên phụ trách, hạn thanh toán, hạn mức, thông tin in hóa đơn (MST, CCCD), tài khoản ngân hàng.
3. Vật tư: cây nhóm, đa ĐVT có hệ số, thuế suất mặc định (GTGT/NK/TTĐB), lô/hạn dùng/ngày SX, hàng không tính tồn (dịch vụ), tồn min/max, bảng giá bán/mua theo khách/tháng/ĐVT, hãng/chủng loại.
4. Kho với TK kho và phương pháp giá vốn riêng (BQ tháng, BQ tức thời, FIFO, đích danh), kho gửi bán.
5. TSCĐ/CCDC: nhóm, nguồn vốn, phụ tùng, lý do tăng giảm; tham số khấu hao/phân bổ gắn với TK chi phí, bộ phận, vụ việc, mã chi phí; dừng khấu hao.
6. Vụ việc/công trình (cây), đối tượng/hạng mục, sản phẩm, yếu tố chi phí, mã chi phí, bộ phận, nhân viên, đội bán hàng, đơn vị/chi nhánh, hợp đồng (+ hàng hóa hợp đồng), dịch vụ (với TK doanh thu/giá vốn/thuế), hình thức thanh toán, loại thuế, nhóm hóa đơn mua (theo mục tờ khai) và bán (theo thuế suất), ký hiệu mẫu hóa đơn, ngoại tệ.
7. Tham số TK ngầm định cho sinh bút toán; danh sách cặp chứng từ trùng; tùy chọn bật/tắt từng chiều phân tích; mẫu số/QĐ số theo chế độ; nhớ bộ lọc theo người dùng/form.

**Số dư đầu kỳ**: TK (VND/NTE, đúng loại dư), công nợ chi tiết (phải khớp TK), tồn kho theo kho (+ theo lô cho FIFO/đích danh), TSCĐ, CCDC, vụ việc, hợp đồng, thuế GTGT còn khấu trừ, số liệu BCTC năm trước; nhập từ Excel; kiểm tra chênh lệch.

**Chứng từ** (tối thiểu các loại): phiếu thu/chi (VND, NTE), báo nợ/báo có, UNC in mẫu ngân hàng, hóa đơn bán/mua (có/không qua kho), phiếu bán/mua dịch vụ, phiếu kế toán, phiếu nhập mua/nhập khẩu (phân bổ chi phí & thuế NK)/nhập lại/nhập gia công/nhập thành phẩm/nhập khác, phiếu xuất bán (kiêm hóa đơn, bảng kê kèm HĐ, CK/KM/giảm giá/hỗ trợ/bảo hành, thu tiền ngay)/xuất sử dụng-sản xuất/xuất điều chuyển (tự sinh nhập)/xuất trả NCC/xuất hủy/xuất biếu/xuất gia công/xuất định mức/xuất khác, tăng-giảm-điều chỉnh TSCĐ và CCDC; chứng từ tự động: khấu hao, phân bổ CCDC, kết chuyển, phân bổ, giá vốn.
- Trên mọi chứng từ: tháng hạch toán tách khỏi ngày; nhiều bút toán; nhiều hóa đơn GTGT; mã đối tượng bên Nợ/Có; vụ việc/mã chi phí/đối tượng/SP/bộ phận/nhân viên/hợp đồng theo dòng; ngoại tệ & tỷ giá (cả theo dòng); chứng từ gốc kèm theo; xác nhận; thanh toán liên kết (đã thu/chi, hạn, phiếu thanh toán); đánh số tự động (năm/tháng, đánh lại, kiểm tra trùng); in nhiều mẫu, in liên tục, ra PDF/Excel; nhân bản; lọc/duyệt/sửa/xóa theo quyền và khóa sổ.

**Kho & giá vốn**: tính tồn tại thời điểm, cảnh báo xuất quá tồn, giá vốn theo kho/tháng/phương pháp, cập nhật ngược bút toán giá vốn, cố định giá vốn, NXT/thẻ kho/sổ chi tiết/kiểm kê/tồn âm, đối chiếu kho ↔ sổ cái.

**Cuối kỳ**: soát lỗi (bảng rule), cân đối TSCĐ + sinh KH, cân đối CCDC + sinh phân bổ, cân đối kho + giá vốn, cân đối công nợ, tập hợp chi phí/giá thành, cân đối TK, hạch toán cuối kỳ theo sơ đồ nhiều bước (kết chuyển có để lại, theo SP/vụ việc; phân bổ theo tỷ lệ), khóa sổ, chuyển số dư năm sau từng phần hành (có thể chạy lại), tạo năm mới giữ danh mục.

**Thuế**: hóa đơn GTGT mua/bán với nhóm kê khai, bảng kê 01-1/01-2 (xuất HTKK), tờ khai 01/GTGT (điều chỉnh, còn khấu trừ chuyển kỳ, hoàn), BC26 sử dụng hóa đơn, kiểm tra trùng số HĐ, đối chiếu bút toán thuế ↔ hóa đơn, MST bỏ trốn, quyết toán TNDN (03/TNDN + phụ lục, điều chỉnh tăng/giảm nhập tay), import bảng kê HĐĐT thành chứng từ (và trong phần mềm mới: tích hợp HĐĐT/XML thật).

**Báo cáo**: sổ quỹ/TGNH (chi tiết & tổng chứng từ), nhật ký chung & đặc biệt, sổ cái (chứng từ/tiểu khoản/chữ T), sổ chi tiết TK, BCĐPS (1/2 số dư công nợ, cộng cấp), bảng cân đối & sổ chi tiết công nợ (nhiều mẫu, nhóm/NV, đến hạn/tuổi nợ, biên bản đối chiếu), tiền vay theo khế ước, hàng hóa (NXT, mua, bán, doanh số, lãi gộp theo khách/NV/mặt hàng/đội, giảm trừ, điều chuyển, trả lại), TSCĐ/CCDC (trích KH, phân bổ, thẻ, tăng giảm, kiểm kê), vụ việc (bảng kê, chi tiết, cân đối, tập hợp chi phí, dở dang, KQKD), chi phí theo mã phí, dịch vụ, hợp đồng, BCTC đầy đủ theo chế độ (CĐKT, KQKD, LCTT trực tiếp, nghĩa vụ NSNN, thuyết minh) với công thức dữ liệu hóa, niên độ lệch, so sánh năm trước, truy ngược chỉ tiêu; in liên tục, xem nhiều năm, xuất Excel.

**Hệ thống**: người dùng/nhóm, quyền theo chức năng + cờ dữ liệu nhạy cảm (giá vốn, công nợ), khóa theo phần hành/kỳ/ngày/tự động, nhật ký hành động và lịch sử sửa/xóa (nên lưu cả giá trị cũ), sao lưu/phục hồi tự động theo lịch, nhiều đơn vị/bộ số liệu, nhập-xuất chứng từ giữa các bộ dữ liệu, trợ giúp ngữ cảnh và nhật ký phiên bản trong phần mềm.

---

### Phụ lục A – Thống kê object `KT.mde`

| Loại | Số lượng | Nhóm tiền tố (số lượng) |
|---|---|---|
| Form | 941 | VT 122 · SO 91 · BC 64 · CT (tiện ích) 61 · SYS 57 · VV 45 · CT5 41 · TAISAN 30 · DAUKY 28 · CCDC 24 · CT6 20 · HACHTOAN 20 · CT3 18 · DINHMUC 16 · NKC 16 · DMKHG 15 · CT1/CT4/DV/HOPDONG 14 · CT2/DMVT 13 · DMTS 12 · CT7/CT8 11 · DMCC/DMVV 10 · CT0 9 · GT 9 · CP 8 … SWITCHBOARD 1 |
| Report | 770 | VT 143 · CT5 133 · SO 89 · BC 53 · CT3 48 · CT4 33 · VV 31 · SOCONGNO 26 · NKC 23 · CT2/CT6 21 · TS 14 · CT7/CT8 13 · CCDC 9 · CT1 9 · CP 7 · DAUKY 7 · HOPDONG 6 · DV/GT 5 · DINHMUC 4 · DM* ~35 |
| Module VBA | 32 | xem §1.1 |
| Bảng liên kết | 119 | = số bảng của CSDL năm (`KT2022`); `KTSTRUC` mới có thêm 3 bảng TT99 |

### Phụ lục B – Khác biệt schema `KTSTRUC` (mới) so với `KT2022`

Thêm bảng `DesBC_CDKT_B01_99, DesBC_KQKD_LAILO_99, DesBC_LCTT_TTIEP_99`; thêm cột `DU_DAU_NTE/DU_CUOI_NTE` cho CĐKT 133/200; `OrgCTCHUNG` thêm `SO_CCCD, NGAY_CAP_CCCD, NOI_CAP_CCCD, CN_NH_NHAN, GIO_NHAP_DL, MAY_NHAP_DL`; `OrgCTVAT` thêm `MA_CHIPHI, MA_NHOM`; `OrgCTVT` thêm `TYLE_KM, PHI_TAU(_NTE)`; `OrgCTVT_BKE/HD` thêm cột KM; `OrgDMKHG` thêm CCCD, `TEN_CN_NH`; `OrgDMKHO/OrgDMVV` thêm `CO_SD`; `OrgDMNTE` thêm `MA_NTE_XU`; `OrgDMCTDICHVU` thêm `MA_VV`; `OrgSysFormVar` thêm `MA_TS, MA_CC, MA_CHIPHI, MA_THUE, TYLE_VAT_MIN/MAX` – khớp với changelog 2023–2025.

### Phụ lục C – Nguồn đã dùng

`docs/SunSoft_Huong dan su dung.txt`, `docs/Sunsoft_Huong dan cai dat va trien khai.txt`, `chm/SUNSOFT.hhc`, 81 file `chm_txt/*.txt`, `schema/KTSTRUC.sql`, `schema/KT2022.sql`, `schema/AppInfo.sql`, `schema/ktdv.sql`, `refdata/*.csv` (OrgDMCT, OrgDMTK, OrgDMTK_200, OrgDMTHUE, OrgDMHTTT, OrgDMNTE, OrgDMMAUBC, OrgDMHDMUA, OrgDMHDBAN, OrgDMNGUONVON, OrgDMMAHD, OrgDMTS, DesHT_Buoc, DesHT_KC_CTu, DesHT_PB_*, DesBC_CDKT_B01_99, DesBC_KQKD_LAILO_99, DesBC_LCTT_TTIEP_99, DesBC_TNDN_88_QT, DesBC_VAT_DC, DesDataErr, OrgDMTROGIUP, OrgDMUPDATE, AppSysVar, AppGroup, OrgSysFormVar), `mde/forms.txt`, `mde/reports.txt`, `mde/modules.txt`, `mde/MSysObjects.csv`. Không đọc thư mục dữ liệu khách hàng.
