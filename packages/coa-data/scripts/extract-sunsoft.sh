#!/usr/bin/env bash
# Trích bảng tham chiếu từ bản sao SUNSOFT PRO. Chỉ danh mục/định nghĩa; KHÔNG cột số liệu, KHÔNG bảng giao dịch.
set -euo pipefail
SRC="${SUNSOFT_DIR:-$HOME/Downloads/SUNSOFTPRO}/KTDATA.dat"
OUT="$(dirname "$0")/../reference/sunsoft"; mkdir -p "$OUT"
PICK="node $(dirname "$0")/pick-columns.mjs"
x() { if mdb-export -D '%Y-%m-%d' "$SRC" "$1" | $PICK "$2" > "$OUT/$3.csv"; then echo "$3: $(($(wc -l < "$OUT/$3.csv") - 1)) dòng"; else rm -f "$OUT/$3.csv"; echo "$3: bỏ qua (bảng không có)"; return 1; fi; }
x OrgDMTK     "TK_TI,TEN_TK,TEN_TK_E,LOAI_DU,TK_NTE,CHI_TIET,NHOM_ME,TC_KHAC,CAP_TK" OrgDMTK_133
x OrgDMTK_200 "TK_TI,TEN_TK,TEN_TK_E,LOAI_DU,TK_NTE,CHI_TIET,NHOM_ME,TC_KHAC,CAP_TK" OrgDMTK_200
for R in 99 133 200; do
  x "DesBC_CDKT_B01_$R"    "MASO,TEN_TK,THUYET_MINH,NGUON,TK,LOAI_DU,DK_KHAC,HIEN_AN,KIEU_CHU,SO_AM,MAU_DAM" "DesBC_CDKT_B01_$R" || true
  x "DesBC_KQKD_LAILO_$R"  "MASO,DIEN_GIAI,THUYET_MINH,NHAP,NGUON,TK_TI,TK_DU,LOAI_PS,DIEU_KIEN,HIEN_AN,KIEU_CHU,SO_AM,MAU_DAM" "DesBC_KQKD_LAILO_$R" || true
  x "DesBC_LCTT_TTIEP_$R"  "MASO,CHI_TIEU,TK_NO,LEN_TK_NO,TK_CO,LEN_TK_CO,DK_KHAC,CHI_TIET,THUYET_MINH,NGUON,KIEU_CHU,HIEN_AN,MAU_DAM,SO_AM" "DesBC_LCTT_TTIEP_$R" || true
done
x DesBC_CDKT_B01A_133 "MASO,TEN_TK,THUYET_MINH,NGUON,TK,LOAI_DU,DK_KHAC,HIEN_AN,KIEU_CHU,SO_AM,MAU_DAM" DesBC_CDKT_B01A_133 || true
x DesBC_CDKT_B01B_133 "MASO,TEN_TK,THUYET_MINH,NGUON,TK,LOAI_DU,DK_KHAC,HIEN_AN,KIEU_CHU,SO_AM,MAU_DAM" DesBC_CDKT_B01B_133 || true
x DesHT_Buoc   "BUOC,DIEN_GIAI,PRE_PROC" DesHT_Buoc
x DesHT_KC_CTu "CT_ID,BUOC,STT_CTU,TK_KC,TK_DICH,LOAI_KC,DELAI,MASP,MA_SP,MAVV,MA_VV,DIEN_GIAI" DesHT_KC_CTu
x DesDataErr   "Err_Code,Err_Description,Table_Name,Err_Formula,Err_Help,Err_Check" DesDataErr
x OrgDMCT      "MA_CT,TEN_CT,NHOM_CT,STT,TK_CT,MAU_SO,QD_SO,SOCT_THANG" OrgDMCT
x OrgDMTHUE    "MA_THUE,TEN_THUE,THUE_SUAT,STT" OrgDMTHUE
x OrgDMHTTT    "MA_TT,TEN_TT" OrgDMHTTT
x OrgDMNTE     "MA_NTE,TEN_NTE" OrgDMNTE
