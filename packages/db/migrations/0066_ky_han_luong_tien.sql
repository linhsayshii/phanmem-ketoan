-- GĐ3 Task 21: kỳ hạn ngắn/dài hạn (B01 TT99) và mã luồng tiền (B03 trực tiếp).
-- Kỳ hạn không thêm cột: dùng voucher_line.due_date sẵn có (hạn thanh toán của dòng công nợ, đi vào open_item.due_date; dòng tài khoản khác là ngày đáo hạn).
-- Mã luồng tiền: voucher_line.cash_flow_code = mã chỉ tiêu B03 (dòng luồng tiền của định nghĩa B03 theo chế độ), chỉ ghi ở dòng tài khoản tiền (API kiểm).
-- Cả hai là siêu dữ liệu trình bày, không phải số tiền: sửa được sau ghi sổ như diễn giải (fn_line_immutable bỏ khỏi so sánh, trigger ghi audit_event trước/sau),
-- không thêm vào fn_voucher_canonical (chuỗi băm khóa cứng không đổi định dạng; kỳ khóa cứng vẫn chặn mọi sửa dòng).
ALTER TABLE voucher_line ADD COLUMN cash_flow_code text CONSTRAINT voucher_line_cash_flow_code_len CHECK (length(cash_flow_code) BETWEEN 1 AND 10);

DO $mig$
DECLARE d text; o text; n text;
BEGIN
  -- Dòng đã ghi sổ: cash_flow_code sửa được như due_date.
  d := pg_get_functiondef('fn_line_immutable()'::regprocedure);
  o := $o$- 'due_date'$o$; n := $n$- 'due_date' - 'cash_flow_code'$n$;
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 2 THEN RAISE EXCEPTION 'fn_line_immutable: không thấy đúng hai chỗ due_date'; END IF;
  EXECUTE replace(d, o, n);
  -- Chứng từ đảo chép mã luồng tiền để luồng tiền của mã triệt tiêu (B03 trừ đúng chỉ tiêu ở kỳ đảo).
  d := pg_get_functiondef('reverse_voucher(uuid, date, text)'::regprocedure);
  o := 'description, due_date, bank_account_id'; n := 'description, due_date, bank_account_id, cash_flow_code';
  IF (length(d) - length(replace(d, o, ''))) / length(o) <> 2 THEN RAISE EXCEPTION 'reverse_voucher: không thấy đúng hai chỗ danh sách cột dòng'; END IF;
  EXECUTE replace(d, o, n);
  -- Soát lỗi: dòng tiền chưa có mã (chỉ khi công ty đã dùng mã trong khoảng soát, để công ty không dùng mã không bị báo hàng loạt).
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  IF position($r$ON CONFLICT DO NOTHING$r$ IN d) = 0 THEN RAISE EXCEPTION 'seed_data_check_rules không có ON CONFLICT DO NOTHING'; END IF;
  n := $new$,
  -- B03 trực tiếp: dòng tiền mặt/tiền gửi (subledger cash, bank) của chứng từ đã ghi sổ không phải chứng từ đảo, có dòng đối ứng không phải tiền (chuyển tiền nội bộ không cần mã),
  -- chưa gắn mã luồng tiền; chỉ báo khi trong khoảng đã có dòng gắn mã.
  (p_tenant, 'LCTT_THIEU_MA', 'Dòng tiền chưa có mã luồng tiền', 'warning',
   $q$SELECT v.id, coalesce(v.voucher_no, '(nháp)'), 'TK ' || a.code || ' dòng ' || l.line_no || CASE WHEN l.debit > 0 THEN ': thu ' || l.debit ELSE ': chi ' || l.credit END
      FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id JOIN account a ON a.id = l.account_id
      WHERE v.state = 'posted' AND v.reversal_of_id IS NULL AND NOT v.is_closing AND l.posting_date BETWEEN $1 AND $2
        AND a.subledger_kind IN ('cash','bank') AND l.cash_flow_code IS NULL
        AND EXISTS (SELECT 1 FROM voucher_line c JOIN account ca ON ca.id = c.account_id WHERE c.voucher_id = v.id AND c.posting_date = l.posting_date AND ca.subledger_kind IS DISTINCT FROM 'cash' AND ca.subledger_kind IS DISTINCT FROM 'bank')
        AND EXISTS (SELECT 1 FROM voucher_line m WHERE m.cash_flow_code IS NOT NULL AND m.posting_date BETWEEN $1 AND $2)
      ORDER BY v.posting_date, v.voucher_no, l.line_no$q$,
   'Dòng tiền chưa gắn mã luồng tiền: Báo cáo lưu chuyển tiền tệ xếp theo cặp tài khoản đối ứng', 'Gắn Mã luồng tiền (F4) trên dòng tiền của chứng từ; chứng từ đã ghi sổ sửa được mã mà không cần bỏ ghi sổ', true, '{}')$new$;
  d := replace(d, E'\n  ON CONFLICT DO NOTHING', n || E'\n  ON CONFLICT DO NOTHING');
  IF position('LCTT_THIEU_MA' IN d) = 0 THEN RAISE EXCEPTION 'không chèn được quy tắc LCTT_THIEU_MA (khuôn ON CONFLICT khác dự kiến)'; END IF;
  EXECUTE d;
END $mig$;

ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
SELECT seed_data_check_rules(id) FROM tenant;
ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;

-- Định nghĩa báo cáo của công ty: B01 TT99 dùng LT(...) cho các cặp chỉ tiêu ngắn hạn/dài hạn, B03 (TT99, TT133) bỏ cặp có mã (!CF) và cộng CF(mã).
-- Mẫu hệ thống (report_template) cập nhật theo đường đồng bộ dữ liệu tham chiếu (packages/coa-data); ở đây chỉ dòng còn đúng công thức và bên của mẫu cũ, dòng đã sửa tay giữ nguyên.
-- Giữ nhật ký kiểm toán (trước/sau) của report_line như 0039.
UPDATE report_line l SET formula = x.new_formula, side = x.new_side
FROM report_def d, (VALUES
  ('TT99', 'B01', '123', '1281+1282+1283+1288', 'debit', '1281+1282+1283+1288-LT(1281,1282,1283,1288)', 'debit'),
  ('TT99', 'B01', '131', '131', 'debit', '131-LT(131)', 'debit'),
  ('TT99', 'B01', '132', '331', 'debit', '331-LT(331)', 'debit'),
  ('TT99', 'B01', '133', '1362+1363+1368', 'debit', '1362+1363+1368-LT(1362,1363,1368)', 'debit'),
  ('TT99', 'B01', '135', '1388+334+338+141+244', 'debit', '1388+334+338+141+244-LT(1388,334,338,141,244)', 'debit'),
  ('TT99', 'B01', '211', '0', 'net_debit', 'LT(131)', 'debit'),
  ('TT99', 'B01', '212', '0', 'net_debit', 'LT(331)', 'debit'),
  ('TT99', 'B01', '214', '0', 'net_debit', 'LT(1362,1363,1368)', 'debit'),
  ('TT99', 'B01', '215', '0', 'net_debit', 'LT(1388,334,338,141,244)', 'debit'),
  ('TT99', 'B01', '265', '0', 'net_debit', 'LT(1281,1282,1283,1288)', 'debit'),
  ('TT99', 'B01', '311', '331', 'credit', '331-LT(331)', 'credit'),
  ('TT99', 'B01', '312', '131', 'credit', '131-LT(131)', 'credit'),
  ('TT99', 'B01', '314', '333', 'credit', '333-LT(333)', 'credit'),
  ('TT99', 'B01', '316', '335', 'credit', '335-LT(335)', 'credit'),
  ('TT99', 'B01', '317', '3362+3363+3368', 'credit', '3362+3363+3368-LT(3362,3363,3368)', 'credit'),
  ('TT99', 'B01', '320', '338(3387)+1388+344', 'credit', '338(3387)+1388+344-LT(338(3387),344)', 'credit'),
  ('TT99', 'B01', '321', '341+3431', 'credit', '341+3431-LT(341,3431)', 'credit'),
  ('TT99', 'B01', '322', '352', 'credit', '352-LT(352)', 'credit'),
  ('TT99', 'B01', '331', '0', 'net_debit', 'LT(331)', 'credit'),
  ('TT99', 'B01', '332', '0', 'net_debit', 'LT(131)', 'credit'),
  ('TT99', 'B01', '333', '0', 'net_debit', 'LT(333)', 'credit'),
  ('TT99', 'B01', '334', '0', 'net_debit', 'LT(335)', 'credit'),
  ('TT99', 'B01', '336', '0', 'net_debit', 'LT(3362,3363,3368)', 'credit'),
  ('TT99', 'B01', '338', '0', 'net_debit', 'LT(338(3387),344)', 'credit'),
  ('TT99', 'B01', '339', '0', 'net_debit', 'LT(341,3431)', 'credit'),
  ('TT99', 'B01', '343', '0', 'net_debit', 'LT(352)', 'credit'),
  ('TT99', 'B03', '01', 'N111,112,113/C511,131,33311,3387,121', 'net_debit', 'N111,112,113/C511,131,33311,3387,121!CF+CF(01)', 'net_debit'),
  ('TT99', 'B03', '02', 'N331,151,152,153,154,155,156,157,158,121,133,242,335,621,622,623,627,632,641,642/C111,112,113', 'net_debit', 'N331,151,152,153,154,155,156,157,158,121,133,242,335,621,622,623,627,632,641,642/C111,112,113!CF-CF(02)', 'net_debit'),
  ('TT99', 'B03', '03', 'N334/C111,112,113', 'net_debit', 'N334/C111,112,113!CF-CF(03)', 'net_debit'),
  ('TT99', 'B03', '04', 'N635/C111,112,113', 'net_debit', 'N635/C111,112,113!CF-CF(04)', 'net_debit'),
  ('TT99', 'B03', '05', 'N3334/C111,112,113', 'net_debit', 'N3334/C111,112,113!CF-CF(05)', 'net_debit'),
  ('TT99', 'B03', '06', 'N111,112,113/C711,133,141,138,244', 'net_debit', 'N111,112,113/C711,133,141,138,244!CF+CF(06)', 'net_debit'),
  ('TT99', 'B03', '07', 'N811,138,244,3331,3332,3333,3335,3336,3337,3338,3339,338,344,352,353,356/C111,112,113', 'net_debit', 'N811,138,244,3331,3332,3333,3335,3336,3337,3338,3339,338,344,352,353,356/C111,112,113!CF-CF(07)', 'net_debit'),
  ('TT99', 'B03', '21', 'N211,212,213,215,217,241/C111,112,113', 'net_debit', 'N211,212,213,215,217,241/C111,112,113!CF-CF(21)', 'net_debit'),
  ('TT99', 'B03', '22', 'N111,112,113/C211,212,213,215,217', 'net_debit', 'N111,112,113/C211,212,213,215,217!CF+CF(22)', 'net_debit'),
  ('TT99', 'B03', '23', 'N128/C111,112,113', 'net_debit', 'N128/C111,112,113!CF-CF(23)', 'net_debit'),
  ('TT99', 'B03', '24', 'N111,112,113/C128', 'net_debit', 'N111,112,113/C128!CF+CF(24)', 'net_debit'),
  ('TT99', 'B03', '25', 'N221,222,228/C111,112,113', 'net_debit', 'N221,222,228/C111,112,113!CF-CF(25)', 'net_debit'),
  ('TT99', 'B03', '26', 'N111,112,113/C221,222,228', 'net_debit', 'N111,112,113/C221,222,228!CF+CF(26)', 'net_debit'),
  ('TT99', 'B03', '27', 'N111,112,113/C515', 'net_debit', 'N111,112,113/C515!CF+CF(27)', 'net_debit'),
  ('TT99', 'B03', '31', 'N111,112,113/C411', 'net_debit', 'N111,112,113/C411!CF+CF(31)', 'net_debit'),
  ('TT99', 'B03', '32', 'N411,419/C111,112,113', 'net_debit', 'N411,419/C111,112,113!CF-CF(32)', 'net_debit'),
  ('TT99', 'B03', '33', 'N111,112,113/C3411,343,171', 'net_debit', 'N111,112,113/C3411,343,171!CF+CF(33)', 'net_debit'),
  ('TT99', 'B03', '34', 'N3411,343,171/C111,112,113', 'net_debit', 'N3411,343,171/C111,112,113!CF-CF(34)', 'net_debit'),
  ('TT99', 'B03', '35', 'N3412/C111,112,113', 'net_debit', 'N3412/C111,112,113!CF-CF(35)', 'net_debit'),
  ('TT99', 'B03', '36', 'N421,332/C111,112,113', 'net_debit', 'N421,332/C111,112,113!CF-CF(36)', 'net_debit'),
  ('TT99', 'B03', '61', 'N111,112,113/C413-N413/C111,112,113', 'net_debit', 'N111,112,113/C413!CF-N413/C111,112,113!CF', 'net_debit'),
  ('TT133', 'B03', '01', 'N111,112/C5111,5112,5113,131,33311,3387,121', 'net_debit', 'N111,112/C5111,5112,5113,131,33311,3387,121!CF+CF(01)', 'net_debit'),
  ('TT133', 'B03', '02', 'N331,151,152,153,154,155,156,157,121,133,242,335,611,631,642/C111,112', 'net_debit', 'N331,151,152,153,154,155,156,157,121,133,242,335,611,631,642/C111,112!CF-CF(02)', 'net_debit'),
  ('TT133', 'B03', '03', 'N334/C111,112', 'net_debit', 'N334/C111,112!CF-CF(03)', 'net_debit'),
  ('TT133', 'B03', '04', 'N635/C111,112', 'net_debit', 'N635/C111,112!CF-CF(04)', 'net_debit'),
  ('TT133', 'B03', '05', 'N3334/C111,112', 'net_debit', 'N3334/C111,112!CF-CF(05)', 'net_debit'),
  ('TT133', 'B03', '06', 'N111,112/C711,133,141,138,3386', 'net_debit', 'N111,112/C711,133,141,138,3386!CF+CF(06)', 'net_debit'),
  ('TT133', 'B03', '07', 'N811,138,3331,3332,3333,3335,3336,3337,3338,3339,3381,3382,3383,3384,3386,3388,352,353,356/C111,112', 'net_debit', 'N811,138,3331,3332,3333,3335,3336,3337,3338,3339,3381,3382,3383,3384,3386,3388,352,353,356/C111,112!CF-CF(07)', 'net_debit'),
  ('TT133', 'B03', '21', 'N211,217,241/C111,112', 'net_debit', 'N211,217,241/C111,112!CF-CF(21)', 'net_debit'),
  ('TT133', 'B03', '22', 'N111,112/C5118,211,217', 'net_debit', 'N111,112/C5118,211,217!CF+CF(22)', 'net_debit'),
  ('TT133', 'B03', '23', 'N128,228/C111,112', 'net_debit', 'N128,228/C111,112!CF-CF(23)', 'net_debit'),
  ('TT133', 'B03', '24', 'N111,112/C128,228', 'net_debit', 'N111,112/C128,228!CF+CF(24)', 'net_debit'),
  ('TT133', 'B03', '25', 'N111,112/C515', 'net_debit', 'N111,112/C515!CF+CF(25)', 'net_debit'),
  ('TT133', 'B03', '31', 'N111,112/C411', 'net_debit', 'N111,112/C411!CF+CF(31)', 'net_debit'),
  ('TT133', 'B03', '32', 'N411,419/C111,112', 'net_debit', 'N411,419/C111,112!CF-CF(32)', 'net_debit'),
  ('TT133', 'B03', '33', 'N111,112/C341', 'net_debit', 'N111,112/C341!CF+CF(33)', 'net_debit'),
  ('TT133', 'B03', '34', 'N341/C111,112', 'net_debit', 'N341/C111,112!CF-CF(34)', 'net_debit'),
  ('TT133', 'B03', '35', 'N421/C111,112', 'net_debit', 'N421/C111,112!CF-CF(35)', 'net_debit'),
  ('TT133', 'B03', '61', 'N111,112/C413-N413/C111,112', 'net_debit', 'N111,112/C413!CF-N413/C111,112!CF', 'net_debit')
) AS x(regime, report_code, line_code, old_formula, old_side, new_formula, new_side)
WHERE d.tenant_id = l.tenant_id AND d.id = l.report_def_id AND d.regime = x.regime AND d.report_code = x.report_code
  AND l.line_code = x.line_code AND btrim(l.formula) = x.old_formula AND l.side = x.old_side;
