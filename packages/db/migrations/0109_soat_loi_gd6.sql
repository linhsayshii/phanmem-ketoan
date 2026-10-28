-- GĐ6 Task 14a: mười ba quy tắc soát lỗi lương, giá thành, hợp đồng. Quy tắc lương cần view_salary, giá thành cần view_cost (thiếu cờ: bỏ qua, không chạy SQL).
-- Hai quy tắc "cần tính lại / cần chạy lại" (LUONG_CAN_TINH_LAI, GIA_THANH_CAN_CHAY_LAI) dùng chữ ký đầu vào tính bằng mã (getRun, isStale) nên không viết được bằng SQL:
-- dòng quy tắc có SQL rỗng, phần chạy nằm ở apps/api/src/modules/tools/dataCheckTs.ts theo mã quy tắc.
-- Định nghĩa lại seed_data_check_rules từ thân hiện hành (qua 0092): chèn các dòng mới trước ON CONFLICT như 0064/0076/0092.
-- Kỳ lương/kỳ giá thành là tháng: "trong khoảng" = tháng giao với [$1, $2]. Số tiền in trong chi tiết, nên quy tắc lương/giá thành mang cờ.
DO $mig$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('seed_data_check_rules(uuid)'::regprocedure);
  IF position($r$ON CONFLICT DO NOTHING$r$ IN d) = 0 THEN RAISE EXCEPTION 'seed_data_check_rules không có ON CONFLICT DO NOTHING'; END IF;
  n := $new$,
  -- Lương: nhân viên có thu nhập chịu thuế trong bảng lương (chưa hủy) mà hồ sơ không có mã số thuế.
  (p_tenant, 'LUONG_THIEU_MST', 'Nhân viên có thu nhập chịu thuế thiếu mã số thuế', 'warning',
   $q$SELECT NULL::uuid, e.code, e.name || ', kỳ ' || to_char(make_date(pl.year, pl.month, 1), 'MM/YYYY') || ', thu nhập chịu thuế ' || trim_scale(v.value::numeric)
      FROM payroll_line pl JOIN employee e ON e.id = pl.employee_id
      JOIN payroll_line_value v ON v.line_id = pl.id AND v.column_code = 'taxable_income'
      WHERE pl.run_status <> 'cancelled' AND make_date(pl.year, pl.month, 1) BETWEEN date_trunc('month', $1::date)::date AND $2 AND v.value::numeric > 0 AND coalesce(btrim(e.tax_code), '') = ''
      ORDER BY pl.year, pl.month, e.code$q$,
   'Nhân viên có thu nhập chịu thuế trong bảng lương nhưng chưa khai mã số thuế, tờ khai thuế TNCN và quyết toán không đối chiếu được', 'Khai mã số thuế của nhân viên ở danh mục Nhân viên', true, '{view_salary}'),
  -- Lương: trả bằng chuyển khoản, có thực lĩnh nhưng hồ sơ lương chưa có số tài khoản ngân hàng (mỗi nhân viên một dòng).
  (p_tenant, 'LUONG_THIEU_TK_NH', 'Nhân viên trả lương chuyển khoản thiếu số tài khoản ngân hàng', 'warning',
   $q$SELECT NULL::uuid, e.code, e.name || ', có bảng lương từ kỳ ' || to_char(min(make_date(pl.year, pl.month, 1)), 'MM/YYYY')
      FROM payroll_line pl JOIN employee e ON e.id = pl.employee_id JOIN employee_payroll p ON p.employee_id = pl.employee_id
      WHERE pl.run_status <> 'cancelled' AND make_date(pl.year, pl.month, 1) BETWEEN date_trunc('month', $1::date)::date AND $2 AND pl.net > 0
        AND p.pay_method = 'transfer' AND coalesce(btrim(p.bank_account_no), '') = ''
      GROUP BY e.id, e.code, e.name ORDER BY e.code$q$,
   'Nhân viên được trả lương chuyển khoản nhưng hồ sơ lương chưa có số tài khoản ngân hàng nên không lập được tệp chi lương', 'Khai số tài khoản ở Hồ sơ lương hoặc đổi hình thức trả sang tiền mặt', true, '{view_salary}'),
  -- Lương: hồ sơ có ngày nghỉ việc nhưng còn dòng lương (tổng thu nhập > 0) ở tháng bắt đầu sau ngày nghỉ.
  (p_tenant, 'LUONG_NV_NGHI_VAN_TINH', 'Nhân viên đã nghỉ việc vẫn tính lương', 'warning',
   $q$SELECT NULL::uuid, e.code, e.name || ', nghỉ việc ' || to_char(p.end_date, 'DD/MM/YYYY') || ', vẫn có lương kỳ ' || to_char(make_date(pl.year, pl.month, 1), 'MM/YYYY')
      FROM payroll_line pl JOIN employee e ON e.id = pl.employee_id JOIN employee_payroll p ON p.employee_id = pl.employee_id
      WHERE pl.run_status <> 'cancelled' AND make_date(pl.year, pl.month, 1) BETWEEN date_trunc('month', $1::date)::date AND $2
        AND p.end_date IS NOT NULL AND make_date(pl.year, pl.month, 1) > p.end_date AND pl.gross > 0
      ORDER BY pl.year, pl.month, e.code$q$,
   'Nhân viên đã có ngày nghỉ việc nhưng bảng lương của tháng sau ngày nghỉ vẫn tính tổng thu nhập', 'Loại nhân viên khỏi bảng lương hoặc sửa ngày nghỉ việc ở Hồ sơ lương', true, '{view_salary}'),
  -- Lương: bảng lương đã tính hoặc đã hạch toán mà hồ sơ, chấm công hoặc tham số đã đổi (cùng phép tính "Cần tính lại" của getRun). Chạy bằng mã: dataCheckTs.ts.
  (p_tenant, 'LUONG_CAN_TINH_LAI', 'Bảng lương cần tính lại', 'warning',
   $q$SELECT NULL::uuid, NULL::text, NULL::text WHERE false$q$,
   'Hồ sơ lương, chấm công hoặc tham số đã thay đổi sau lần tính của bảng lương', 'Mở bảng lương và Tính lại, rồi Chạy lại hạch toán nếu bảng đã hạch toán', true, '{view_salary}'),
  -- Lương: bảng lương đã hạch toán, thực lĩnh của nhân viên khác Có − Nợ TK 334 theo nhân viên trên chứng từ LU hiện hành.
  (p_tenant, 'LUONG_LECH_SO_CAI', 'Phải trả người lao động theo nhân viên lệch bảng lương', 'error',
   $q$SELECT r.voucher_id, e.code, e.name || ', kỳ ' || to_char(make_date(pl.year, pl.month, 1), 'MM/YYYY') || ': bảng lương ' || trim_scale(pl.net) || ', sổ cái ' || trim_scale(coalesce(g.s, 0))
      FROM payroll_line pl JOIN payroll_run r ON r.id = pl.run_id JOIN employee e ON e.id = pl.employee_id
      LEFT JOIN LATERAL (SELECT sum(l.credit - l.debit) AS s FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state = 'posted' JOIN account a ON a.id = l.account_id
        WHERE l.voucher_id = r.voucher_id AND l.employee_id = pl.employee_id AND a.code LIKE '334%'
          AND l.posting_date = (make_date(pl.year, pl.month, 1) + interval '1 month - 1 day')::date) g ON true
      WHERE r.status = 'posted' AND r.voucher_id IS NOT NULL AND make_date(pl.year, pl.month, 1) BETWEEN date_trunc('month', $1::date)::date AND $2 AND coalesce(g.s, 0) <> pl.net
      ORDER BY pl.year, pl.month, e.code$q$,
   'Số phải trả người lao động của nhân viên trên chứng từ hạch toán lương khác thực lĩnh của bảng lương', 'Chạy lại hạch toán của bảng lương (bảng lương > Chạy lại hạch toán); nếu vẫn lệch kiểm tra chứng từ LU', true, '{view_salary}'),
  -- Lương: lương đóng BHXH, BHYT hoặc BHTN của dòng lương vượt trần theo tham số (si_ceiling: mức tuyệt đối hoặc bội số lương tối thiểu vùng). Chỉ so khi tham số có
  -- (legal_param thắng payroll_param như payrollParam); thiếu tham số hoặc vùng thì không báo. Động cơ lương luôn kẹp trần, nên chỉ lệch khi sửa tay ô lương đóng bảo hiểm hoặc đổi tham số.
  (p_tenant, 'LUONG_BH_VUOT_TRAN', 'Lương đóng bảo hiểm vượt mức trần', 'error',
   $q$WITH ln AS (
        SELECT pl.year, pl.month, e.code, e.name, p.region, (make_date(pl.year, pl.month, 1) + interval '1 month - 1 day')::date AS me, sb.value::numeric AS si_base, ub.value::numeric AS ui_base
        FROM payroll_line pl JOIN employee e ON e.id = pl.employee_id JOIN employee_payroll p ON p.employee_id = pl.employee_id
        LEFT JOIN payroll_line_value sb ON sb.line_id = pl.id AND sb.column_code = 'si_base'
        LEFT JOIN payroll_line_value ub ON ub.line_id = pl.id AND ub.column_code = 'ui_base'
        WHERE pl.run_status <> 'cancelled' AND make_date(pl.year, pl.month, 1) BETWEEN date_trunc('month', $1::date)::date AND $2),
      c AS (
        SELECT ln.*, cp.value AS cv, mw.value AS wv
        FROM ln
        LEFT JOIN LATERAL (SELECT x.value FROM (
            SELECT value, 1 AS pri FROM legal_param WHERE code = 'si_ceiling' AND valid_from <= ln.me AND (valid_to IS NULL OR valid_to >= ln.me)
            UNION ALL SELECT value, 2 FROM payroll_param WHERE code = 'si_ceiling' AND valid_from <= ln.me AND (valid_to IS NULL OR valid_to >= ln.me)) x ORDER BY x.pri LIMIT 1) cp ON true
        LEFT JOIN LATERAL (SELECT x.value FROM (
            SELECT value, 1 AS pri FROM legal_param WHERE code = 'min_wage_region' AND valid_from <= ln.me AND (valid_to IS NULL OR valid_to >= ln.me)
            UNION ALL SELECT value, 2 FROM payroll_param WHERE code = 'min_wage_region' AND valid_from <= ln.me AND (valid_to IS NULL OR valid_to >= ln.me)) x ORDER BY x.pri LIMIT 1) mw ON true),
      k AS (
        SELECT c.*,
          CASE WHEN cv->>'si_base_max' IS NOT NULL THEN (cv->>'si_base_max')::numeric
               WHEN cv->>'si_base_max_multiple_of_min_wage' IS NOT NULL AND wv->>region IS NOT NULL THEN round((cv->>'si_base_max_multiple_of_min_wage')::numeric * (wv->>region)::numeric) END AS si_cap,
          CASE WHEN cv->>'ui_base_max_multiple_of_min_wage' IS NOT NULL AND wv->>region IS NOT NULL THEN round((cv->>'ui_base_max_multiple_of_min_wage')::numeric * (wv->>region)::numeric) END AS ui_cap
        FROM c)
      SELECT NULL::uuid, code, name || ', kỳ ' || to_char(make_date(year, month, 1), 'MM/YYYY') || ': '
        || concat_ws('; ', CASE WHEN si_base > si_cap THEN 'lương đóng BHXH, BHYT ' || trim_scale(si_base) || ' vượt trần ' || trim_scale(si_cap) END,
                           CASE WHEN ui_base > ui_cap THEN 'lương đóng BHTN ' || trim_scale(ui_base) || ' vượt trần ' || trim_scale(ui_cap) END)
      FROM k WHERE si_base > si_cap OR ui_base > ui_cap
      ORDER BY year, month, code$q$,
   'Lương đóng bảo hiểm của dòng lương lớn hơn mức trần theo tham số bảo hiểm', 'Kiểm tra ô lương đóng bảo hiểm nhập tay hoặc tính lại bảng lương', true, '{view_salary}'),
  -- Giá thành: lần chạy trong khoảng có GT bị gỡ hoặc chữ ký đầu vào đã đổi (cùng phép tính isStale). Chạy bằng mã: dataCheckTs.ts.
  (p_tenant, 'GIA_THANH_CAN_CHAY_LAI', 'Giá thành cần chạy lại', 'warning',
   $q$SELECT NULL::uuid, NULL::text, NULL::text WHERE false$q$,
   'Chi phí, nhập kho thành phẩm hoặc dở dang kỳ trước đã thay đổi sau lần chạy giá thành, hoặc chứng từ giá thành đã bị gỡ', 'Chạy lại giá thành của kỳ (Giá thành > Tính giá thành), rồi chạy lại giá vốn', true, '{view_cost}'),
  -- Giá thành: sau khi có chứng từ giá vốn (GV) của tháng chứa $2, TK 154 phải bằng dở dang cuối của lần chạy giá thành gần nhất (QĐ #805, #852); lệch (kể cả dư mà không có dở dang) là báo.
  (p_tenant, 'GIA_THANH_154_CON_DU', 'Dư TK 154 khác dở dang cuối theo giá thành', 'warning',
   $q$WITH b AS (
        SELECT coalesce(sum(l.debit - l.credit), 0) AS bal FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted', 'reversed') JOIN account a ON a.id = l.account_id
        WHERE a.code LIKE '154%' AND l.posting_date <= $2),
      w AS (
        SELECT coalesce(sum(o.closing_material + o.closing_labor + o.closing_overhead), 0) AS wip FROM cost_run_object o
        WHERE o.run_id = (SELECT r.id FROM cost_run r WHERE make_date(r.year, r.month, 1) <= $2 ORDER BY r.year DESC, r.month DESC LIMIT 1)),
      g AS (
        SELECT EXISTS (SELECT 1 FROM voucher v WHERE v.voucher_type = 'GV' AND v.state = 'posted' AND v.reversal_of_id IS NULL AND v.posting_date BETWEEN date_trunc('month', $2::date)::date AND $2) AS ok)
      SELECT NULL::uuid, 'TK 154', 'Dư ' || trim_scale(b.bal) || ', dở dang cuối theo giá thành ' || trim_scale(w.wip) FROM b, w, g WHERE g.ok AND b.bal <> w.wip$q$,
   'Sau giá vốn, số dư TK 154 phải bằng dở dang cuối của lần chạy giá thành gần nhất', 'Xem Sổ chi tiết TK 154 theo đối tượng (Báo cáo giá thành): chạy lại giá thành và giá vốn, hoặc điều chỉnh số dư 154 không có dở dang', true, '{view_cost}'),
  -- Giá thành: đối tượng sản phẩm, đơn hàng có chi phí nguyên vật liệu trong lần chạy mà không có định mức hiệu lực trong tháng (theo đối tượng hoặc theo sản phẩm đầu ra).
  (p_tenant, 'GIA_THANH_THIEU_DINH_MUC', 'Đối tượng giá thành thiếu định mức nguyên vật liệu', 'warning',
   $q$SELECT NULL::uuid, co.code, 'Kỳ ' || to_char(make_date(r.year, r.month, 1), 'MM/YYYY') || ': chi phí nguyên vật liệu ' || trim_scale(o.incurred_material) || ', chưa có định mức'
      FROM cost_run_object o JOIN cost_run r ON r.id = o.run_id JOIN cost_object co ON co.id = o.cost_object_id
      WHERE co.kind IN ('product', 'order') AND o.incurred_material > 0
        AND make_date(r.year, r.month, 1) <= $2 AND (make_date(r.year, r.month, 1) + interval '1 month - 1 day') >= $1
        AND NOT EXISTS (SELECT 1 FROM cost_norm n WHERE n.valid_from <= (make_date(r.year, r.month, 1) + interval '1 month - 1 day')::date AND (n.valid_to IS NULL OR n.valid_to >= make_date(r.year, r.month, 1))
          AND (n.cost_object_id = o.cost_object_id OR n.item_id = co.item_id OR n.item_id IN (SELECT y.item_id FROM cost_run_output y WHERE y.run_object_id = o.id AND y.item_id IS NOT NULL)))
      ORDER BY r.year, r.month, co.code$q$,
   'Đối tượng giá thành có chi phí nguyên vật liệu nhưng chưa có định mức nên không so sánh được với thực tế', 'Khai định mức nguyên vật liệu của sản phẩm hoặc đối tượng (Giá thành > Định mức)', true, '{view_cost}'),
  -- Giá thành (D15): kỳ đã kết chuyển mà 621, 622, 623, 627 còn dư tại cuối kỳ, nghĩa là chi phí chưa vào 154 vì kỳ không chạy giá thành (hoặc chạy giá thành rồi bị gỡ).
  (p_tenant, 'GIA_THANH_621_622_627_CON_DU', 'Chi phí sản xuất 621, 622, 627 chưa kết chuyển sang giá thành', 'warning',
   $q$SELECT NULL::uuid, 'Kỳ ' || p.period_no || '/' || p.fiscal_year, 'Dư Nợ ' || trim_scale(o.bal) || ' trên TK 621, 622, 623, 627 cuối kỳ'
      FROM fiscal_period p
      CROSS JOIN LATERAL (SELECT coalesce(sum(l.debit - l.credit), 0) AS bal FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted', 'reversed') JOIN account a ON a.id = l.account_id
        WHERE a.code ~ '^(621|622|623|627)' AND l.posting_date <= p.date_to) o
      WHERE p.period_no BETWEEN 1 AND 12 AND p.date_from <= $2 AND p.date_to >= $1 AND o.bal <> 0
        AND (coalesce((SELECT g.ok FROM period_close_log g WHERE g.fiscal_year = p.fiscal_year AND g.period_no = p.period_no AND g.step = 'closing' ORDER BY g.ran_at DESC, g.id DESC LIMIT 1), false)
          OR EXISTS (SELECT 1 FROM voucher k WHERE k.is_closing AND k.state = 'posted' AND k.reversal_of_id IS NULL AND k.fiscal_year = p.fiscal_year AND k.period_no = p.period_no))
      ORDER BY p.fiscal_year, p.period_no$q$,
   'Kỳ đã kết chuyển nhưng chi phí nguyên vật liệu, nhân công, sản xuất chung còn dư, chưa được tập hợp vào giá thành', 'Chạy giá thành của kỳ (cần mở lại kỳ hoặc ghi lùi) rồi kết chuyển lại; công ty không tính giá thành thì kết chuyển các tài khoản này theo sơ đồ kết chuyển', true, '{view_cost}'),
  -- Giá thành (QĐ #807): vụ việc, hợp đồng, đơn hàng đã hoàn thành (lần chạy gần nhất của đối tượng, trước hoặc đến $2) mà TK 154 theo đối tượng còn dư: chưa kết chuyển giá vốn Nợ 632 / Có 154.
  -- Dòng 154 thuộc đối tượng khi mang cost_object_id, hoặc project_id / contract_id của đối tượng.
  (p_tenant, 'GIA_THANH_DAU_RA_KHONG_MA_HANG', 'Vụ việc hoàn thành còn dư TK 154 chưa kết chuyển giá vốn', 'warning',
   $q$SELECT NULL::uuid, co.code, 'Đã hoàn thành (kỳ ' || to_char(make_date(x.year, x.month, 1), 'MM/YYYY') || '), TK 154 còn dư ' || trim_scale(b.bal)
      FROM cost_object co
      CROSS JOIN LATERAL (SELECT r.year, r.month, o.completed FROM cost_run_object o JOIN cost_run r ON r.id = o.run_id
        WHERE o.cost_object_id = co.id AND make_date(r.year, r.month, 1) <= $2 ORDER BY r.year DESC, r.month DESC LIMIT 1) x
      CROSS JOIN LATERAL (SELECT coalesce(sum(l.debit - l.credit), 0) AS bal FROM voucher_line l JOIN voucher v ON v.id = l.voucher_id AND v.state IN ('posted', 'reversed') JOIN account a ON a.id = l.account_id
        WHERE a.code LIKE '154%' AND l.posting_date <= $2
          AND (l.cost_object_id = co.id OR (co.project_id IS NOT NULL AND l.project_id = co.project_id) OR (co.contract_id IS NOT NULL AND l.contract_id = co.contract_id))) b
      WHERE co.kind IN ('project', 'contract', 'order') AND x.completed AND b.bal <> 0
      ORDER BY co.code$q$,
   'Đối tượng không nhập kho thành phẩm đã hoàn thành nhưng giá thành vẫn nằm ở TK 154, chưa kết chuyển sang giá vốn', 'Lập phiếu kế toán Nợ 632 / Có 154 gắn vụ việc hoặc hợp đồng khi nghiệm thu, ghi nhận doanh thu', true, '{view_cost}'),
  -- Hợp đồng: đợt thanh toán đã quá ngày dự kiến (trong khoảng, trước hôm nay giờ Việt Nam) mà chưa có hóa đơn đã ghi sổ (QĐ #824).
  (p_tenant, 'HOP_DONG_QUA_HAN_DOT', 'Đợt thanh toán hợp đồng quá hạn chưa lập hóa đơn', 'warning',
   $q$SELECT NULL::uuid, c.code, 'Đợt ' || m.seq || ' (' || m.description || ') dự kiến ' || to_char(m.due_date, 'DD/MM/YYYY') || ', số tiền ' || trim_scale(m.amount)
      FROM contract_milestone m JOIN contract c ON c.tenant_id = m.tenant_id AND c.id = m.contract_id
      LEFT JOIN voucher v ON v.tenant_id = m.tenant_id AND v.id = m.voucher_id
      WHERE m.status = 'planned' AND m.due_date BETWEEN $1 AND $2 AND m.due_date < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        AND c.kind IN ('sale', 'purchase') AND c.status <> 'cancelled' AND coalesce(v.state, '') <> 'posted'
      ORDER BY m.due_date, c.code, m.seq$q$,
   'Đợt thanh toán đã quá ngày dự kiến mà chưa lập hóa đơn đã ghi sổ', 'Lập hóa đơn từ đợt (Hợp đồng > Đợt thanh toán) hoặc dời ngày dự kiến, bỏ đợt', true, '{}'),
  -- Hợp đồng: hóa đơn đã xuất (bán) hoặc nhận (mua), lũy kế đến $2 và cùng loại tiền, vượt giá trị hợp đồng cộng phụ lục ký đến $2 (cùng phép tính theo dõi thực hiện, QĐ #822).
  (p_tenant, 'HOP_DONG_VUOT_GIA_TRI', 'Doanh số hợp đồng vượt giá trị hợp đồng', 'warning',
   $q$SELECT NULL::uuid, c.code, 'Hóa đơn ' || trim_scale(inv.cur) || ' vượt giá trị ' || trim_scale(c.value + coalesce(am.s, 0)) || ' (đã gồm phụ lục)'
      FROM contract c
      LEFT JOIN LATERAL (SELECT sum(a.value_change) AS s FROM contract_amendment a WHERE a.contract_id = c.id AND a.signed_date <= $2) am ON true
      CROSS JOIN LATERAL (SELECT coalesce(sum(s.sg * (il.amount_currency - il.discount_amount_currency)), 0) AS cur
        FROM (SELECT DISTINCT l.voucher_id FROM voucher_line l WHERE l.tenant_id = c.tenant_id AND l.contract_id = c.id AND l.posting_date <= $2) vl
        JOIN voucher v ON v.id = vl.voucher_id AND v.currency_code = c.currency_code JOIN voucher_item_line il ON il.tenant_id = v.tenant_id AND il.voucher_id = v.id
        LEFT JOIN voucher r ON r.id = v.reversed_by_id
        CROSS JOIN LATERAL (SELECT CASE WHEN v.voucher_type IN ('GGB', 'TLB', 'GGM', 'TLM') THEN -1 ELSE 1 END AS sg) s
        WHERE v.voucher_type IN ('HDB', 'BH', 'GGB', 'TLB', 'HDM', 'MH', 'GGM', 'TLM') AND v.reversal_of_id IS NULL
          AND (v.state = 'posted' OR (v.state = 'reversed' AND r.posting_date > $2))) inv
      WHERE c.kind IN ('sale', 'purchase') AND c.status <> 'cancelled' AND c.value + coalesce(am.s, 0) > 0 AND inv.cur > c.value + coalesce(am.s, 0)
      ORDER BY c.code$q$,
   'Tổng hóa đơn đã xuất hoặc nhận theo hợp đồng lớn hơn giá trị hợp đồng cộng phụ lục', 'Lập phụ lục tăng giá trị hợp đồng hoặc kiểm tra hóa đơn gắn nhầm hợp đồng', true, '{}')
  $new$;
  d := replace(d, E'\n  ON CONFLICT DO NOTHING', n || E'\n  ON CONFLICT DO NOTHING');
  IF position('HOP_DONG_VUOT_GIA_TRI' IN d) = 0 THEN RAISE EXCEPTION 'không chèn được quy tắc GĐ6 (khuôn ON CONFLICT khác dự kiến)'; END IF;
  EXECUTE d;
END $mig$;

-- Công ty đã có: bổ sung quy tắc mới (tắt nhật ký kiểm toán như 0038: migration không có người dùng).
ALTER TABLE data_check_rule DISABLE TRIGGER trg_audit;
SELECT seed_data_check_rules(id) FROM tenant;
ALTER TABLE data_check_rule ENABLE TRIGGER trg_audit;
