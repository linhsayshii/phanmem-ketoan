# Thiết kế lõi sổ cái kế toán kép (General Ledger + Sub-ledgers): mẫu hình kiến trúc & mô hình dữ liệu

Ghi chú nghiên cứu, cập nhật 2026-10-19. Tên mẫu hình, tên bảng/trường, định danh mã và tên nguồn giữ nguyên gốc (tiếng Anh); phần diễn giải bằng tiếng Việt. Mọi phát hiện có nguồn inline; phần "Inferences" là suy luận/đề xuất thiết kế của người nghiên cứu, phần "Gaps" là điều chưa tìm được nguồn.

---

## Nền tảng mẫu hình: Fowler "Accounting Patterns", nguyên tắc bất biến (Helland), và các sổ cái sản xuất (Square, Stripe, Uber, TigerBeetle, Modern Treasury)

### Takeaway
Mọi thiết kế sổ cái "đã được chứng minh" hội tụ về cùng một bộ nguyên tắc: (1) **Account – Entry – Transaction** với ràng buộc tổng Entry trong một Transaction bằng 0; (2) **Entry/Transaction bất biến sau khi post**, sửa sai chỉ bằng bút toán mới (Reversal / Replacement / Difference Adjustment); (3) số dư là **dữ liệu dẫn xuất** (cache) từ log bút toán — "the truth is the log"; (4) idempotency key và two-phase (pending → posted/void) để an toàn khi retry/đồng thời.

### Cited Findings
- Fowler mô tả `Account` là "a pot of money"; "The value, or balance, of the Account is derived as the sum of all the Accounting Entrys"; `Accounting Transaction` liên kết các `Accounting Entry` của một lần chuyển tiền; nếu mọi Transaction sinh ra từ Domain Event thì đó chính là Event Sourcing — [Accounting Narrative](https://martinfowler.com/eaaDev/AccountingNarrative.html)
- Ba chiến lược sửa sai của Fowler: **Replacement Adjustment** (xóa Transaction sai, tạo bộ đúng – đơn giản nhưng mất lịch sử trừ khi dùng Parallel Model), **Reversal Adjustment** (giữ Transaction sai, ghi bút toán đối ứng rồi ghi bút toán đúng – giữ lịch sử nhưng nhiều dòng triệt tiêu nhau), **Difference Adjustment** (chỉ ghi phần chênh lệch – ít dòng nhất nhưng phức tạp hơn, thường cần Parallel Model) — [Accounting Narrative](https://martinfowler.com/eaaDev/AccountingNarrative.html)
- Mẫu **Accounting Transaction**: `AccountingTransaction{entries, date, wasPosted}`, `Entry{amount, date, account, transaction}`; `add()` ném `ImmutableTransactionException` khi `wasPosted` = true; `canPost()` kiểm tra `balance().isZero()`; "A two-legged transaction only ever has two entries, which are of opposite sign"; multi-legged linh hoạt hơn nhưng khó xây/khó validate hơn – "it's better to start with the simpler if you're not sure" — [Accounting Transaction](https://martinfowler.com/eaaDev/AccountingTransaction.html)
- Mẫu **Retroactive Event** (sự kiện đến muộn/ghi lùi ngày): xác định *branch point*, hoặc **rebuild** (khôi phục snapshot trước branch point rồi replay) hoặc **rewind/replay** (đảo ngược từng sự kiện về branch point); sự kiện sai = reverse + reject + replacement; phương án thay thế là **Parallel Model**; chi phí: cần Event Sourcing + khả năng đảo ngược, "not small pre-requisites" — [Retroactive Event](https://martinfowler.com/eaaDev/RetroactiveEvent.html)
- Mẫu **Audit Log**: ghi cả *actual date* (ngày hiệu lực) lẫn *record date* (ngày ghi) — "it's always wise to add both dates as it's easy to do"; "Audit Log is easy to write but harder to read, especially as it grows large" — [Audit Log](https://martinfowler.com/eaaDev/AuditLog.html)
- Tài liệu "Accounting Patterns" (PDF) của Fowler có mục lục: Event; Accounting Entry; Accounting Transaction ("Two Legged or Multi-Legged?"); Account; Posting Rule; Secondary Posting Rule ("Maintaining the Event Trace"); Difference Adjustment; Reversal Adjustment; Replacement Adjustment; "Correcting mistakes: Finding the Entries Affected by an Adjustment" — [accounting.pdf](https://martinfowler.com/apsupp/accounting.pdf)
- Trong *Analysis Patterns* ch.6, Posting Rule được mô hình với *trigger*, *calculation method*, *account finder* và *eligibility condition* tùy chọn; Posting Rule gắn với Accounting Practice (Accounting Practice Type, users) — [apchap6.pdf](https://martinfowler.com/apsupp/apchap6.pdf) (qua tóm tắt tìm kiếm; xem Gaps)
- Helland: "Accountants don't use erasers or they go to jail. All entries in a ledger remain in the ledger. Corrections can be made but only by making new entries in the ledger."; "The truth is the log. The database is a cache of a subset of the log."; phân biệt *observed facts* (một khoản ghi nợ/có vào tài khoản séc) và *derived facts* (số dư hiện tại, khấu hao tính từ tỷ lệ và nguyên giá) — [Immutability Changes Everything, CIDR 2015](https://www.cidrdb.org/cidr2015/Papers/CIDR15_Paper16.pdf)
- Square **Books**: bảng `books` (balance, type, owner, id), `journal_entries`, `book_entries` (link journal entry + book, số tiền debit (+)/credit (−), *per-book version counter* tăng đơn điệu); journal entry phải tổng bằng 0; tenant mô hình bằng "shelves" (`shelf_id` trong index phụ `(shelf_id, owner, book_id)`); append-only, sửa sai bằng entry mới; số dư cache trên `books`; thay integer tăng dần bằng UUID để tránh hotspot trên Spanner; ~20 TB, đội 3 người — [Books, an immutable double-entry accounting database service](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/)
- Stripe Ledger: "an immutable log of events", bút toán đã publish "cannot be deleted or modified"; sửa sai bằng revert + reprocess; mô hình *clearing accounts* phải về 0 ở trạng thái ổn định ("terminal reservoirs are full, and intermediate pipes are empty"); ~5 tỷ event/ngày; đo Clearing / Timeliness / Completeness thành DQ score; bulk repair qua "two-phase review and commit" — [Ledger: Stripe's system for tracking and validating money movement](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)
- Uber LedgerStore: "an immutable storage solution at Uber" với "verifiable data completeness and correctness guarantees"; index strongly-consistent dùng 2-phase (ghi *index intent* trước record, commit bất đồng bộ); index eventually-consistent dựa trên Docstore Materialized Views; dữ liệu cũ offload theo *time-range* sang cold storage và "sealing"; checksum theo cửa sổ thời gian để kiểm tra đủ dữ liệu; >2 nghìn tỷ index — [How LedgerStore Supports Trillions of Indexes at Uber](https://www.uber.com/en-IE/blog/how-ledgerstore-supports-trillions-of-indexes/)
- Modern Treasury guarantees: "For each currency within a Ledger Transaction, credits will always equal debits."; "its Entries will either all succeed or all fail to be written."; "Entries cannot be changed or removed on a Ledger Transaction once it is posted."; "Once archived, a Ledger Transaction's Entries won't count toward any Account Balances."; "Idempotency keys are supported on all POST requests to prevent creating duplicate objects"; "Reads won't block and aren't blocked by writes." — [Ledgers Guarantees](https://docs.moderntreasury.com/ledgers/docs/ledgers-guarantees.md)
- Modern Treasury: Ledger Transaction có status `pending` / `posted` / `archived`; `pending` còn sửa được (PATCH); `posted`/`archived` bất biến trừ metadata; huỷ bút toán đã posted = ghi một reversing transaction; mỗi account có `pending_balance`, `posted_balance`, `available_balance` — [Transaction Status and Balances](https://docs.moderntreasury.com/ledgers/docs/transaction-status-and-balances.md)
- TigerBeetle: `Transfer` "cannot be modified or deleted after creation. Use correcting transfers to fix mistakes."; mỗi transfer có đúng một `debit_account_id` và một `credit_account_id`, hai tài khoản phải cùng `ledger`; `id` là idempotency key duy nhất toàn cluster — [Transfer reference](https://docs.tigerbeetle.com/reference/transfer/)
- TigerBeetle two-phase: transfer `flags.pending` "reserves its amount in the debit/credit accounts' debits_pending/credits_pending fields"; post bằng `post_pending_transfer` (có thể post một phần, phần còn lại trả về), void bằng `void_pending_transfer`, `timeout` tính bằng giây; resolve tạo transfer mới với `pending_id` trỏ về bản gốc — [Two-Phase Transfers](https://docs.tigerbeetle.com/coding/two-phase-transfers/)
- Beancount: "All transactions must balance by 'weight.' There is no exception."; số dùng `decimal.Decimal`; tolerance phải xử lý tường minh; từ chối virtual postings; "Beancount does not represent time, only dates"; thứ tự directive "is irrelevant to the outcome of its computations" — [Beancount Design Doc](https://raw.githubusercontent.com/beancount/docs/master/docs/beancount_design_doc.md)

### Inferences
- Bảng quyết định "event sourcing vs CRUD" cho sổ cái:

| Tiêu chí | CRUD (sửa tại chỗ) | Append-only journal + reversal (Helland/Fowler Reversal Adjustment) | Event Sourcing đầy đủ (Fowler Retroactive Event) |
|---|---|---|---|
| Vết kiểm toán | Phải thêm audit table riêng | Có sẵn trong journal | Có sẵn trong event log |
| Sửa bút toán đã post | UPDATE/DELETE | Reversal + bút toán mới (hoặc Difference Adjustment) | Reject/replace event rồi replay |
| Ghi lùi ngày (backdated) | Chỉ cần sửa số dư | Cần tính lại số dư từ ngày hiệu lực | Replay từ branch point (đắt nhưng tổng quát) |
| Độ phức tạp | Thấp | Trung bình | Cao ("not small pre-requisites") |
| Phù hợp | Không nên dùng cho GL | **Khuyến nghị cho GL** | Chỉ cần ở lớp nghiệp vụ nguồn (hoá đơn, kho) nếu thật sự cần |

- Thực tế các hệ thống lớn (Square, Stripe, Modern Treasury, TigerBeetle, ERPNext, Odoo) đều không event-source toàn hệ thống; họ **append-only ở lớp journal/ledger** và giữ CRUD ở tài liệu nguồn (draft). Đây là điểm cân bằng nên chọn.
- Transaction multi-legged (Fowler) là bắt buộc cho chứng từ Việt Nam (một chứng từ nhiều dòng Nợ/Có); TigerBeetle cho thấy có thể phân rã thành nhiều transfer 2 chân nối bằng `linked` + tài khoản `Control`, nhưng với GL doanh nghiệp thì lưu thẳng N dòng trong một voucher đơn giản hơn.

### Gaps
- Không trích được nội dung thân bài "Accounting Patterns" PDF (font mã hoá tuỳ biến, không có công cụ trích PDF trên máy); chỉ có mục lục và các trang eaaDev HTML. Chi tiết Posting Rule / Accounting Practice / Secondary Posting Rule lấy từ tóm tắt tìm kiếm của *Analysis Patterns* ch.6, chưa đọc trực tiếp.
- Không tìm thấy bản ghi/bài nói hội thảo nào của Square về Books ngoài bài blog 2019.
- Bài Uber không mô tả cơ chế "sealing" ở mức hash/chữ ký; chỉ nhắc đến trong ngữ cảnh offload theo khoảng thời gian.

---

## Q1. Lược đồ GL tối thiểu cho chứng từ kiểu Việt Nam (một chứng từ nhiều dòng Nợ/Có, mỗi dòng mang đối tượng/chiều phân tích)

### Takeaway
Lõi tối thiểu gồm 4 bảng: `account` (hệ thống tài khoản dạng cây theo mã), `voucher` (chứng từ = Accounting Transaction, có `state`), `voucher_line` (= Accounting Entry, một dòng = một tài khoản + một bên Nợ hoặc Có, kèm chiều phân tích) và `fiscal_period` (khoá kỳ). Ràng buộc then chốt: mỗi dòng chỉ có một bên khác 0 (`debit*credit = 0`), tổng Nợ = tổng Có theo từng chứng từ & từng loại tiền, dòng tài khoản công nợ bắt buộc có đối tượng, số tiền bằng `NUMERIC` (VND scale 0), dòng mang cả `amount_currency` + `balance` quy đổi.

### Cited Findings
**Mô hình tham chiếu – Odoo `account.move` / `account.move.line`**
- `account.move.line` có: `move_id` (required, `ondelete="cascade"`), `journal_id`, `company_id`, `date` (related `move_id.date`), `account_id`, `name`, `debit` (Monetary, `currency_field='company_currency_id'`), `credit`, `balance`, `amount_currency`, `currency_id` (required), `currency_rate` (compute, không lưu), `partner_id`, `analytic_distribution` (Json), `product_id`, `quantity`, `tax_ids`, `tax_line_id`, `tax_base_amount`, `tax_tag_ids`, `reconciled`, `matched_debit_ids`/`matched_credit_ids` (One2many `account.partial.reconcile`), `full_reconcile_id`, `amount_residual`, `amount_residual_currency`, `matching_number`, `date_maturity`, `display_type`, `sequence`, `parent_state` (related `move_id.state`) — [account_move_line.py (Odoo 18.0)](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move_line.py)
- SQL constraints của Odoo: `check_credit_debit`: `CHECK(display_type IN ('line_section','line_note') OR credit * debit=0)` ("Wrong credit or debit value in accounting entry!"); `check_amount_currency_balance_sign`: `balance` và `amount_currency` phải cùng dấu hoặc cùng bằng 0; `check_accountable_required_fields`: dòng kế toán phải có `account_id`; `balance = debit - credit` được áp trong code (`_sanitize_vals`), không có DB constraint; `_check_payable_receivable` là Python constraint — [account_move_line.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move_line.py)
- `account.move`: `state` ∈ {`draft`, `posted`, `cancel`}; `posted_before` (Boolean); `inalterable_hash`, `secure_sequence_number` ("Inalterability No Gap Sequence #"); `reversed_entry_id` ("Reversal of") / `reversal_move_ids`; `auto_post` ∈ {`no`,`at_date`,`monthly`,`quarterly`,`yearly`}; unique index `account_move_unique_name` trên `(name, journal_id)` chỉ khi `state = 'posted' AND name != '/'` — [account_move.py (Odoo 18.0)](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- `_check_balanced`: SQL `HAVING ROUND(SUM(line.balance), decimal_places) != 0` → "The entry is not balanced." — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)

**Mô hình tham chiếu – ERPNext `GL Entry`**
- Trường GL Entry: `posting_date`, `transaction_date`, `account`, `party_type`, `party` (Dynamic Link), `cost_center`, `debit`, `credit` (company currency), `account_currency`, `debit_in_account_currency`, `credit_in_account_currency`, `against`, `against_voucher_type`, `against_voucher`, `voucher_type`, `voucher_no`, `voucher_detail_no`, `project`, `remarks`, `is_opening`, `is_advance`, `fiscal_year`, `company`, `finance_book`, `due_date`, `is_cancelled`, `transaction_exchange_rate`, `debit_in_transaction_currency`, `credit_in_transaction_currency`, `transaction_currency`, `voucher_subtype` — [gl_entry.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/gl_entry/gl_entry.json)
- Validation trong GL Entry: "{0} {1}: Customer is required against Receivable account {2}"; "Supplier is required against Payable account {2}"; "Either debit or credit amount is required"; "Balance for Account {0} must always be {1}" (`validate_balance_type`); "'Profit and Loss' type account {2} not allowed in Opening Entry"; "Account {2} is a Group Account and group accounts cannot be used in transactions"; "Cost Center is required for 'Profit and Loss' account"; "Accounting Entry for {2} can only be made in currency: {3}"; "Account {0} is frozen" / "Not authorized to edit frozen Account {0}" — [gl_entry.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/gl_entry/gl_entry.py)
- Index của GL Entry: `(voucher_type, voucher_no)`, `(posting_date, company)`, `(party_type, party)`; trên PostgreSQL thêm partial index `WHERE is_cancelled = 0`: `gle_active_detail (company, posting_date, account)` và `gle_active_cover (company, account, posting_date) INCLUDE (debit, credit)` — [gl_entry.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/gl_entry/gl_entry.py)
- `make_gl_entries` → `process_gl_map`: phân bổ theo cost center allocation, `merge_similar_entries` (gộp dòng cùng khoá, bỏ dòng 0), `toggle_debit_credit_if_negative` (nợ âm → có dương); `process_debit_credit_difference` cho phép lệch ≤ `5/10^precision` (Journal/Payment Entry) hoặc 0.5 (loại khác) rồi ghi vào "Round Off Account"; vượt ngưỡng → "Debit and Credit not equal for {0} #{1}. Difference is {2}." — [general_ledger.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/general_ledger.py)

**Mô hình tham chiếu – fintech ledgers**
- Modern Treasury mẫu tối thiểu: `Account{id, user_id, account_type, normality}`, `Transaction{id, timestamp, description}`, `Entry{id, transaction_id, account_id, amount, direction}`; ràng buộc "sum of debit amounts == sum of credit amounts, per transaction"; "Enforce double-entry on every transaction (at least one debit + one credit)" — [Accounting For Developers, Part II](https://www.moderntreasury.com/journal/accounting-for-developers-part-ii)
- Modern Treasury: một Ledger Transaction "composed of at least two ledger entry objects"; "ledger transactions can write to only a single ledger" — [Ledgers Objects](https://docs.moderntreasury.com/ledgers/docs/guide-to-ledger-objects.md)
- TigerBeetle `Account`: `id` (u128), `debits_pending`, `debits_posted`, `credits_pending`, `credits_posted`, `user_data_128/64/32`, `ledger` (u32), `code` (u16), `flags` (`linked`, `debits_must_not_exceed_credits`, `credits_must_not_exceed_debits`, `history`, `imported`, `closed`), `timestamp`; "Accounts cannot be deleted after creation." — [Account reference](https://docs.tigerbeetle.com/reference/account/)
- TigerBeetle khuyến nghị: một `ledger` cho mỗi loại tiền; số tiền u128 theo đơn vị nhỏ nhất với *asset scale*; `id` dạng time-based (48 bit ms + 80 bit random) thay vì random thuần; `user_data_64` dành cho "when" thực tế (bitemporality), `code` cho "why" — [Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/)
- Medici (MongoDB): `Medici_Journal{datetime, memo, _transactions[], book, voided, void_reason}`; `Medici_Transaction{credit, debit, meta, datetime, account_path[], accounts, book, memo, _journal, timestamp, voided, void_reason, _original_journal}`; tên tài khoản phân cấp bằng dấu hai chấm (`Assets:Cash`), `account_path` lưu từng cấp để index prefix — [flash-oss/medici](https://github.com/flash-oss/medici)
- Xero ManualJournal: `LineAmount` dương = Nợ, âm = Có; status DRAFT / POSTED / DELETED / VOIDED / ARCHIVED; phải có ít nhất 1 Nợ và 1 Có — [CData Xero ManualJournals](https://cdn.cdata.com/help/DXN/ado/pg_accountingtable-manualjournals.htm), [withone.ai Xero ref](https://www.withone.ai/knowledge/xero/conn_mod_def%3A%3AGJ8cYwKERpQ%3A%3ABNa_QryqR2mVqWF4tR-IOQ/md)
- QuickBooks Online JournalEntry: `SyncToken` là version number để optimistic locking ("Attempts to modify an object specifying an older SyncToken fails"); ít nhất một dòng Nợ và một dòng Có, tổng bằng nhau — [CData QBO JournalEntries](https://cdn.cdata.com/help/RNM/ado/pg_table-journalentries.htm)

**Hệ thống tài khoản (chart of accounts)**
- ERPNext `Account`: `account_name`, `account_number`, `is_group`, `company`, `root_type` ∈ {Asset, Liability, Income, Expense, Equity}, `report_type` ∈ {Balance Sheet, Profit and Loss}, `account_currency`, `parent_account`, `account_type` (Bank, Cash, Receivable, Payable, Stock, Tax, Round Off, Temporary, Fixed Asset, Accumulated Depreciation, Cost of Goods Sold, ...), `freeze_account`, `balance_must_be` ∈ {Debit, Credit}, `lft`, `rgt` (nested set, `is_tree`=1, `nsm_parent_field`=`parent_account`), `include_in_gross`, `disabled` — [account.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/account/account.json)
- Odoo `account.account`: `code`, `name`, `account_type` ∈ {`asset_receivable`, `asset_cash`, `asset_current`, `asset_non_current`, `asset_prepayments`, `asset_fixed`, `liability_payable`, `liability_credit_card`, `liability_current`, `liability_non_current`, `equity`, `equity_unaffected`, `income`, `income_other`, `expense`, `expense_depreciation`, `expense_direct_cost`, `off_balance`}; `internal_group` suy từ prefix; `reconcile` (true cho receivable/payable); `currency_id` ("Forces all journal items in this account to have a specific currency"); `include_initial_balance` = true trừ income/expense ("Used in reports to know if we should consider journal items from the beginning of time"); `account.group` có `code_prefix_start`/`code_prefix_end` ("Account prefixes can determine account groups"); mã tài khoản unique theo công ty (enforce ở Python) — [account_account.py (Odoo 18.0)](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_account.py)
- Việt Nam: Thông tư 99/2025/TT-BTC (ban hành 27/10/2025, hiệu lực 01/01/2026) thay thế toàn bộ Thông tư 200/2014/TT-BTC; TT200 có TK cấp 2 của 111 là 1111 (Tiền Việt Nam), 1112 (Ngoại tệ), 1113 (Vàng tiền tệ); TT99 "Không quy định chi tiết tài khoản cấp 2", "Doanh nghiệp được tự mở các tài khoản chi tiết theo nhu cầu quản lý thực tế" — [MISA AMIS: TK 111 theo TT99](https://amis.misa.vn/252349/tai-khoan-111-theo-thong-tu-99/), [ketoanthienung so sánh TT200/TT99](https://ketoanthienung.net/so-sanh-tai-khoan-ke-toan-thong-tu-200-va-thong-tu-99.htm)
- Kết cấu TK 111 theo TT99: bên Nợ ghi tăng khi nhập quỹ/thừa quỹ/chênh lệch tăng đánh giá lại ngoại tệ; bên Có ghi giảm; "Số dư bên Nợ" — [MISA AMIS](https://amis.misa.vn/252349/tai-khoan-111-theo-thong-tu-99/)

**Chiều phân tích (dimensions / đối tượng)**
- Odoo 17+: `analytic_distribution` là trường JSON trên journal item, dạng dict {analytic_account_id: phần trăm}, tổng phải = 100%; plan có thể bắt buộc phân bổ với một số tài khoản — [OCA contributors list 2024](https://odoo-community.org/groups/contributors-15/contributors-1936202?mode=date), [DeployMonkey](https://deploymonkey.com/blog/odoo-analytic-distribution-error-fix)
- ERPNext: GL Entry có cột cố định `cost_center`, `project`, `finance_book`, `party_type`/`party`; "Accounting Dimension <b>{0}</b> is required for 'Profit and Loss' account {1}." / "... 'Balance Sheet' account" (`validate_dimensions_for_pl_and_bs`) — [gl_entry.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/gl_entry/gl_entry.py)
- Xero ManualJournal giới hạn tối đa 2 tracking category trên dòng — [withone.ai Xero ref](https://www.withone.ai/knowledge/xero/conn_mod_def%3A%3AGJ8cYwKERpQ%3A%3ABNa_QryqR2mVqWF4tR-IOQ/md)
- MISA: "đối tượng tập hợp chi phí" (THCP) gồm công trình, hạng mục, đơn vị thi công/phân xưởng, sản phẩm, quy trình, công đoạn; phần mềm chỉ có sẵn 4 loại đối tượng THCP; đối tượng cha–con, chứng từ hiển thị cả cha lẫn con — [helpact.misa.vn](https://helpact.misa.vn/?p=1111), [MISA AMIS kế toán giá thành công trình](https://amis.misa.vn/53627/ke-toan-gia-thanh-cong-trinh-xay-dung/)
- TigerBeetle dùng 3 trường `user_data_128/64/32` được index làm chiều phân tích "who/what, when, where" — [Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/)

**Kiểu tiền tệ & làm tròn**
- PostgreSQL: NUMERIC "is especially recommended for storing monetary amounts and other quantities where exactness is required"; "calculations on numeric values are very slow compared to the integer types, or to the floating-point types"; `real`/`double precision` "are inexact"; `numeric` làm tròn *ties away from zero*, float làm tròn *ties to even* — [PostgreSQL datatype-numeric](https://www.postgresql.org/docs/current/datatype-numeric.html)
- ISO 4217 minor unit: VND = 0, JPY = 0, USD = 2, EUR = 2, BHD/KWD = 3 — [ISO 4217 (Wikipedia)](https://en.wikipedia.org/wiki/ISO_4217)
- TigerBeetle: số tiền u128, "Map the smallest useful unit of a currency to 1"; asset scale khó đổi về sau vì account/transfer bất biến — [Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/)
- Beancount: tolerance suy từ số chữ số thập phân trong input, "We must deal with tolerances explicitly" — [Beancount Design Doc](https://raw.githubusercontent.com/beancount/docs/master/docs/beancount_design_doc.md)

**Đánh số chứng từ**
- PostgreSQL `nextval` không bao giờ rollback nên sequence luôn có thể có lỗ; `INSERT ... ON CONFLICT` cũng tiêu hao số — [Cybertec: gaps in sequences](https://www.cybertec-postgresql.com/en/gaps-in-sequences-postgresql)
- Cách gapless phổ biến: bảng counter một dòng, `UPDATE ... RETURNING` trong cùng transaction với INSERT (row lock đến khi commit, rollback thu hồi số), đổi lại là tuần tự hoá việc cấp số — [ElixirForum thread](https://elixirforum.com/t/how-to-ensure-a-gapless-auto-incremental-id-field-when-using-postgresql/26340), [pgsql-general thread](https://postgrespro.com/list/thread-id/1436372)
- Odoo: `secure_sequence_number` "Inalterability No Gap Sequence #"; `_unlink_forbid_parts_of_chain` chặn xoá bút toán đã đánh số nếu không phải số cuối chuỗi; `_compute_made_sequence_gap` cảnh báo khi số trước bị thiếu — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- Việt Nam: Nghị định 123/2020/NĐ-CP khoản 3 Điều 10: số hoá đơn "bắt đầu từ 1 và được lập theo thứ tự liên tục từ nhỏ đến lớn trong cùng ký hiệu hoá đơn và ký hiệu mẫu số" — [Thư Viện Pháp Luật](https://thuvienphapluat.vn/hoi-dap-phap-luat/so-hoa-don-co-toi-da-may-so-331499.html); hoá đơn điện tử có mã CQT phải "lập liên tục, không được cách số hay bỏ số" — [MISA AMIS](https://amis.misa.vn/30493/hoa-don-dien-tu-co-duoc-cach-so-va-lui-ngay-hay-khong-theo-thong-tu-78-2021-va-nghi-dinh-123-2020/)
- Luật Kế toán 2015 Điều 16: chứng từ phải có "Tên và số hiệu của chứng từ kế toán; Ngày, tháng, năm lập; Tên, địa chỉ của đơn vị lập; Nội dung nghiệp vụ kinh tế, tài chính phát sinh" — [Thư Viện Pháp Luật](https://thuvienphapluat.vn/lao-dong-tien-luong/so-hieu-chung-tu-ke-toan-la-gi-so-hieu-chung-tu-lay-o-dau-38469.html)
- TT200: doanh nghiệp "được chủ động xây dựng, thiết kế biểu mẫu chứng từ kế toán phù hợp với đặc điểm hoạt động và yêu cầu quản lý" nhưng phải đáp ứng Luật Kế toán; Phụ lục 3 "chỉ mang tính hướng dẫn" — [LuatVietnam](https://luatvietnam.vn/tin-phap-luat/mau-chung-tu-ke-toan-doanh-nghiep-theo-thong-tu-200-230-19146-article.html)

### Inferences
**Lược đồ đề xuất (PostgreSQL), tổng hợp từ Odoo + ERPNext + Modern Treasury + Square:**

```sql
-- Hệ thống tài khoản: cây theo mã (111 → 1111 → 11111...), nested-set tuỳ chọn như ERPNext (lft/rgt)
CREATE TABLE account (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid    NOT NULL,
  code          text    NOT NULL,                 -- '111', '1111', '13111'
  name          text    NOT NULL,
  parent_id     bigint  REFERENCES account(id),
  is_group      boolean NOT NULL DEFAULT false,   -- ERPNext is_group / Odoo không có nhưng dùng account.group
  root_type     text    NOT NULL CHECK (root_type IN ('asset','liability','equity','income','expense','off_balance')),
  account_type  text    NOT NULL,                 -- Odoo account_type: asset_receivable, asset_cash, liability_payable, equity_unaffected, ...
  normal_balance text   NOT NULL CHECK (normal_balance IN ('debit','credit')),
  balance_must_be text  CHECK (balance_must_be IN ('debit','credit')),  -- ERPNext balance_must_be
  include_initial_balance boolean GENERATED ALWAYS AS (root_type NOT IN ('income','expense')) STORED, -- Odoo
  currency_code  char(3),                          -- NULL = mọi loại tiền; Odoo currency_id / ERPNext account_currency
  subledger_kind text,  -- 'receivable'|'payable'|'inventory'|'fixed_asset'|'bank'|NULL: tài khoản kiểm soát, dòng phải có đối tượng
  reconcile      boolean NOT NULL DEFAULT false,   -- Odoo reconcile: cho phép đối trừ open items
  is_active      boolean NOT NULL DEFAULT true,
  UNIQUE (tenant_id, code)
);

-- Kỳ kế toán & khoá sổ
CREATE TABLE fiscal_period (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  fiscal_year int NOT NULL, period_no int NOT NULL,   -- 1..12 (+ 0 kỳ mở sổ, 13 kỳ điều chỉnh)
  date_from  date NOT NULL, date_to date NOT NULL,
  status     text NOT NULL CHECK (status IN ('open','soft_locked','hard_locked')),  -- Odoo: lock date vs Hard Lock date
  UNIQUE (tenant_id, fiscal_year, period_no)
);

-- Chứng từ = Accounting Transaction (multi-legged)
CREATE TABLE voucher (
  id              uuid PRIMARY KEY,                  -- UUID/ULID: idempotent, tránh hotspot (Square)
  tenant_id       uuid NOT NULL,
  voucher_type    text NOT NULL,                     -- 'PT','PC','BN','BC','PKT','HDBR'... (journal/sổ nhật ký)
  voucher_no      text,                              -- cấp khi post (gapless theo voucher_type + fiscal_year)
  seq_no          bigint,                            -- số thứ tự không lỗ hổng (Odoo secure_sequence_number)
  posting_date    date NOT NULL,                     -- ngày hạch toán (effective_at)
  document_date   date NOT NULL,                     -- ngày chứng từ (ERPNext transaction_date)
  state           text NOT NULL CHECK (state IN ('draft','posted','reversed','cancelled')),
  description     text,
  source_doc_type text, source_doc_id uuid,          -- hoá đơn/phiếu kho sinh ra chứng từ (ERPNext voucher_type/voucher_no)
  reversed_by_id  uuid REFERENCES voucher(id),       -- Odoo reversal_move_ids
  reversal_of_id  uuid REFERENCES voucher(id),       -- Odoo reversed_entry_id
  idempotency_key text,                              -- Modern Treasury / Stripe
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  posted_by  uuid, posted_at timestamptz,            -- Fowler Audit Log: actual date (posting_date) + record date (posted_at)
  prev_hash  bytea, row_hash bytea,                  -- Odoo inalterable_hash: hash chain (tuỳ chọn)
  version    int NOT NULL DEFAULT 1,                 -- QBO SyncToken / MT lock_version
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, voucher_type, voucher_no)       -- Odoo: unique(name, journal_id) khi posted
);

-- Dòng chứng từ = Accounting Entry
CREATE TABLE voucher_line (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  voucher_id    uuid NOT NULL REFERENCES voucher(id) ON DELETE CASCADE,  -- cascade chỉ có ý nghĩa khi draft
  line_no       int  NOT NULL,
  account_id    bigint NOT NULL REFERENCES account(id),
  posting_date  date NOT NULL,              -- denormalize từ voucher để index/partition (ERPNext posting_date)
  -- tiền: tiền giao dịch + quy đổi (Odoo amount_currency/balance; ERPNext *_in_account_currency, *_in_transaction_currency)
  currency_code char(3) NOT NULL,
  fx_rate       numeric(20,10),
  amount_currency numeric(20,4) NOT NULL,   -- có dấu: + Nợ, − Có (Odoo); scale theo ISO 4217 exponent
  debit         numeric(20,0) NOT NULL DEFAULT 0 CHECK (debit >= 0),   -- VND: scale 0
  credit        numeric(20,0) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  balance       numeric(20,0) GENERATED ALWAYS AS (debit - credit) STORED,
  -- đối tượng/chiều phân tích (ERPNext party_type/party, cost_center, project; Odoo partner_id, analytic_distribution)
  party_type    text, party_id uuid,        -- khách hàng / NCC / nhân viên (bắt buộc với TK công nợ)
  cost_center_id bigint, department_id bigint, project_id bigint, contract_id bigint, item_id bigint,
  extra_dims    jsonb NOT NULL DEFAULT '{}', -- chiều mở rộng ít dùng; tránh "mã thống kê" vô hạn ở cột
  description   text,
  due_date      date,                       -- Odoo date_maturity / ERPNext due_date
  CONSTRAINT one_side_only CHECK (debit = 0 OR credit = 0),            -- Odoo check_credit_debit
  CONSTRAINT sign_consistent CHECK (sign(amount_currency) = sign(debit - credit) OR (amount_currency = 0 AND debit = credit)), -- Odoo check_amount_currency_balance_sign
  UNIQUE (voucher_id, line_no)
);
CREATE INDEX ON voucher_line (tenant_id, account_id, posting_date) INCLUDE (debit, credit);   -- ERPNext gle_active_cover
CREATE INDEX ON voucher_line (tenant_id, party_type, party_id, posting_date);
CREATE INDEX ON voucher_line (tenant_id, posting_date, account_id);
```

- **Ràng buộc "tổng Nợ = tổng Có"** không biểu diễn được bằng CHECK đơn dòng; dùng một trong: (a) deferred constraint trigger `AFTER INSERT/UPDATE/DELETE ... INITIALLY DEFERRED` kiểm tra `SUM(debit)=SUM(credit)` và `SUM(amount_currency)=0` theo (voucher_id, currency_code) — giống `_check_balanced` của Odoo nhưng ở DB; (b) chỉ cho phép ghi dòng qua một stored procedure `post_voucher()` (cách ERPNext `make_gl_entries`). Nên làm cả hai.
- **Tài khoản kiểm soát ↔ sub-ledger**: `account.subledger_kind` + trigger "nếu `subledger_kind IN ('receivable','payable')` thì `party_id NOT NULL`" (ERPNext "Customer is required against Receivable account"; Odoo `_check_payable_receivable`). Tương tự `inventory` → `item_id`, `fixed_asset` → `asset_id`.
- **Dấu của `amount_currency`** theo Odoo (+ Nợ / − Có) cho phép một cột ngoại tệ; Square dùng Nợ dương/Có âm cho cả `book_entries` nhưng tự nhận là "least intuitive part". Với kế toán VN quen hai cột Nợ/Có, giữ `debit`/`credit` riêng ở tiền hạch toán và cột có dấu ở ngoại tệ là thoả hiệp hợp lý.
- **`posting_date` lặp trên dòng** (ERPNext làm vậy) để index/partition theo ngày không cần join; trigger giữ đồng bộ khi voucher còn draft.
- **Chiều phân tích – bảng quyết định**:

| Cách mô hình | Ưu | Nhược | Dùng khi |
|---|---|---|---|
| Cột cố định trên dòng (ERPNext `cost_center`, `project`, `party`) | Index/FK/CHECK trực tiếp; báo cáo SQL đơn giản | Thêm chiều = migration | Chiều "chuẩn" của VN: đối tượng công nợ, khoản mục chi phí, bộ phận, công trình/vụ việc, hợp đồng, hàng hoá |
| JSON/tag trên dòng (Odoo `analytic_distribution`, `extra_dims jsonb`) | Linh hoạt, cho phép phân bổ % | Khó FK, khó import; GIN index chậm hơn B-tree | Chiều hiếm/thay đổi theo tenant ("mã thống kê" tuỳ biến) |
| Bảng analytic line riêng (Odoo `account.analytic.line`, tách khỏi GL) | Cho phép N:M, phân bổ nhiều plan | GL và analytic có thể lệch nhau; phải đối chiếu | Kế toán quản trị tách khỏi kế toán tài chính |

  Khuyến nghị: cột cố định cho 5–7 chiều cốt lõi + `extra_dims jsonb`; không tách analytic line nếu mục tiêu là báo cáo theo đối tượng ngay trên sổ cái.
- **Tiền tệ**: `NUMERIC` với scale theo ISO 4217 (VND 0, USD 2); nếu cần tối đa hiệu năng thì lưu *minor units* `bigint` (TigerBeetle/Square), nhưng VND có giá trị giao dịch tới hàng chục nghìn tỷ nên `bigint` (±9.2e18) vẫn đủ. Tránh `money` và `float`.
- **Đánh số**: cấp `voucher_no` *tại thời điểm post*, không phải lúc tạo draft, bằng bảng `voucher_counter(tenant_id, voucher_type, fiscal_year, last_no)` với `UPDATE ... RETURNING` trong cùng transaction post (gapless nhưng tuần tự hoá theo loại chứng từ/năm). Khoảng tuần tự này nhỏ nên chấp nhận được; huỷ chứng từ đã đánh số không thu hồi số mà chuyển `state='cancelled'` giữ chỗ (Odoo chỉ cho xoá số cuối chuỗi).

### Gaps
- Không kiểm chứng được lược đồ Bigcapital (không tìm thấy file migration `accounts_transactions` qua tìm kiếm; trang GitHub tree trả 404 với WebFetch). Chỉ xác nhận stack: NestJS/TypeScript, MariaDB, một database cho mỗi tổ chức ([Railway deploy page](https://railway.com/deploy/bigcapital-accounting.md)).
- Tài liệu chính thức Xero/QuickBooks API chạy JS, không fetch được; thông tin lấy từ tài liệu CData và tham chiếu bên thứ ba.
- Không tìm được văn bản pháp lý VN quy định "đánh số chứng từ kế toán (phiếu thu/chi) phải liên tục không gián đoạn"; chỉ có quy định cho *hoá đơn* (NĐ 123/2020). Cần tra trực tiếp TT200/TT99 và Luật Kế toán Điều 18–19.
- Không tìm thấy tài liệu MISA về "mã thống kê" và "khoản mục chi phí" như chiều hạch toán.

---

## Q2. Xử lý sửa chứng từ đã ghi sổ: thoả "không xoá không dấu vết" nhưng giữ UX kế toán quen sửa trực tiếp trong kỳ mở

### Takeaway
Mẫu thắng thế trong cả Odoo lẫn ERPNext: **draft ↔ posted ↔ cancelled/reversed** với quy tắc "sửa = (reverse hoặc reset-to-draft có kiểm soát) + ghi lại", và mức độ cứng rắn **tăng dần theo kỳ**: kỳ mở → cho reset-to-draft nhưng ghi audit log; sau *lock date* → chỉ reversal ghi ngày hiện tại; sau *hard lock / hash* → không sửa gì. Luật Kế toán 2015 Điều 27 cho phép ghi số âm / ghi điều chỉnh — tức Reversal/Difference Adjustment là hợp pháp, còn UPDATE tại chỗ không có dấu vết là không.

### Cited Findings
**Pháp lý Việt Nam**
- Luật Kế toán 2015 Điều 27: "Khi phát hiện sổ kế toán có sai sót thì không được tẩy xóa làm mất dấu vết thông tin, số liệu ghi sai mà phải sửa chữa theo một trong ba phương pháp": *ghi cải chính* (gạch một đường vào chỗ sai, ghi số/chữ đúng phía trên, có chữ ký kế toán trưởng), *ghi số âm* ("ghi lại số sai bằng mực đỏ hoặc ghi lại số sai trong dấu ngoặc đơn, sau đó ghi lại số đúng và phải có chữ ký của kế toán trưởng bên cạnh"), *ghi điều chỉnh* (lập chứng từ điều chỉnh và ghi thêm số chênh lệch) — [Thư Viện Pháp Luật](https://thuvienphapluat.vn/hoi-dap-phap-luat/khi-phat-hien-so-ke-toan-co-sai-sot-thi-co-duoc-tay-xoa-khong-368599.html), [Luật Minh Khuê](https://luatminhkhue.vn/cac-phuong-phap-de-sua-chua-so-ke-toan-co-sai-sot.aspx), [ACC Group](https://accgroup.vn/sua-sai-so-sach-ke-toan)
- Sai sót phát hiện trước khi nộp báo cáo tài chính năm thì sửa trên sổ của năm đó — [ACC Group](https://accgroup.vn/sua-sai-so-sach-ke-toan)

**Odoo 18**
- Trạng thái `draft` / `posted` / `cancel`; `posted_before` đánh dấu đã từng post — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- Reset-to-draft: "Only posted/cancelled journal entries can be reset to draft."; "You cannot reset to draft a locked journal entry." (khi có `inalterable_hash`); bút toán chênh lệch tỷ giá và cash-basis cũng không reset được; `_need_cancel_request` là hook cho localization chặn reset khi hoá đơn đã gửi cơ quan thuế — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- Xoá: "To keep the audit trail, you can not delete journal entries once they have been posted." (gợi ý cancel thay vì xoá); `_can_be_unlinked` chỉ cho xoá khi không có hash và ngày sau fiscal lock date, ngược lại `_unlink_or_reverse` sẽ reverse thay vì xoá — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- Lock date: `_check_fiscal_lock_dates` gọi `company._get_lock_date_violations(fiscalyear=True, tax=False, hard=True, sale/purchase theo journal)` → "You cannot add/modify entries prior to and inclusive of: %(lock_date_info)s."; `write()` kiểm tra khi đổi `name`/`date`/`state` của bút toán posted; đổi journal bị chặn: "You cannot edit the journal of an account move if it has been posted once, unless the name is removed or set to \"/\"." — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- Odoo có nhiều lock date: "Journal Entries lock date", "All Users lock date" ("the date after which no journal entries may be created or modified by any user"), lock date thường miễn trừ accountant, và **Hard Lock date** "is irreversible" — [Odoo year-end docs](https://www.odoo.com/documentation/saas-18.4/applications/finance/accounting/reporting/year_end.html)
- Reversal: `_reverse_moves` đặt `move_type` đảo (`TYPE_REVERSE_MAP`, ví dụ `out_invoice` → `out_refund`), `reversed_entry_id`, `partner_id`; `cancel=True` thì post ngay (`_post(soft=False)`) và tự đối trừ với bản gốc (`_reconcile_reversed_moves`) — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- Hash chain: `hash_string = sha256((previous_hash + current_record).encode('utf-8')).hexdigest()`; từ version 4 lưu dạng `$version$hash`; trường hash gồm `['date','journal_id','company_id']` (v1) + `name` (v2–4); "This document is protected by a hash." — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- Tài liệu inalterability: hash SHA-256 từ name, date, journal, company, debit, credit, account, partner; "the hash chain corresponds to the sequence prefix, ordered by sequence number"; bật theo journal ("Secure Posted Entries with Hash", journal "restricted") hoặc Secure Entries Wizard đến một ngày; bút toán đã secured không sửa được; có "Data Inalterability Check Report" — [Odoo data_inalterability](https://www.odoo.com/documentation/18.0/applications/finance/accounting/reporting/data_inalterability.html)

**ERPNext**
- Huỷ chứng từ: `make_reverse_gl_entries` khoá dòng (row lock), đặt `is_cancelled = 1` trên dòng gốc, tạo dòng đảo Nợ/Có với remark "On cancellation of" và `is_cancelled = 1`; khi bật *immutable ledger* thì dòng gốc giữ nguyên và dòng đảo post với `is_cancelled = 0` và ngày hạch toán mới — [general_ledger.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/general_ledger.py)
- "ERPNext retains the original debit and credit and adds opposite rows for the same voucher."; General Ledger phải bật "Show Cancelled Entries" mới thấy; bản gốc từng chặn cứng giao dịch kho lùi ngày vì "recalculating all later FIFO or moving-average values was expensive", nay cho phép qua Repost Item Valuation — [Immutable Ledger in ERPNext](https://docs.frappe.io/erpnext/immutable-ledger-in-erpnext.md)
- Accounts Settings: "Enable Immutable Ledger" (posts reversal entries instead of rewriting older ledger history); "Delete Accounting and Stock Ledger entries on deletion of transaction"; "Accounts Frozen Till Date"; "Role Allowed to Set Frozen Accounts and Edit Frozen Entries" — [Accounts Settings](https://docs.frappe.io/erpnext/accounts-settings)
- Accounting Period "locks selected submittable document types for the finished date range" (bảng Closed Documents: Sales Invoice, Purchase Invoice, Journal Entry, Payment Entry, Stock Entry...), "blocks creation, amendment, or cancellation"; là *selective lock*; khác với freezing date là "broader date-based posting restriction" — [Accounting Period](https://docs.frappe.io/erpnext/accounting-period)
- Thảo luận cộng đồng v13 "Introducing Immutable Ledgers": lý do là "posting a backdated transaction requires reposting all future entries"; một ý kiến phản biện: dòng đảo "does not have an originating journal entry or stock entry supporting it", nên tạo bút toán đảo có ngày thay vì cancel — [discuss.frappe.io](https://discuss.frappe.io/t/breaking-change-v13-introducing-immutable-ledgers-in-erpnext/52953)

**Fintech / khác**
- Modern Treasury: `pending` sửa được, `posted`/`archived` bất biến, đảo bằng transaction mới; `archived` không tính vào số dư; không được archive transaction đã posted — [Transaction Status and Balances](https://docs.moderntreasury.com/ledgers/docs/transaction-status-and-balances.md), [Guarantees](https://docs.moderntreasury.com/ledgers/docs/ledgers-guarantees.md)
- Medici: void "doesn't delete anything", đánh dấu `voided`, tạo journal đối ứng, memo thêm "[VOID]", mặc định ngày void = hiện tại; `use_original_date` ghi lùi ngày gốc nhưng có thể làm cache số dư lệch — [medici](https://github.com/flash-oss/medici)
- Xero: journal POSTED → VOIDED, DRAFT → DELETED (status riêng, không xoá vật lý) — [withone.ai Xero ref](https://www.withone.ai/knowledge/xero/conn_mod_def%3A%3AGJ8cYwKERpQ%3A%3ABNa_QryqR2mVqWF4tR-IOQ/md)
- Audit log chống sửa: trigger chặn UPDATE/DELETE/TRUNCATE, role ứng dụng chỉ INSERT, hash chain theo thứ tự cố định trường, verifier độc lập tính lại hash, "anchor" đầu chuỗi ra ngoài (object lock, RFC 3161 timestamp, email) — [knogin](https://knogin.com/en/developers/auth-tamper-evident-audit-trail), [the47network](https://the47network.com/blog/tamper-proof-audit-trail.html), [appmaster](https://appmaster.io/blog/tamper-evident-audit-trails-postgresql)

### Inferences
**Máy trạng thái đề xuất cho `voucher.state`:**

```
draft ──post()──▶ posted ──reverse()──▶ reversed   (voucher mới state=posted, reversal_of_id = gốc)
  ▲                 │
  │   unpost()      │  (chỉ kỳ 'open', chưa hash, người có quyền; ghi audit_event 'unposted')
  └─────────────────┘
draft ──discard()──▶ cancelled (giữ số nếu đã cấp; không xoá vật lý)
```

**Bảng quyết định "sửa chứng từ đã post":**

| Tình huống | Kỳ `open` | Kỳ `soft_locked` (sau lock date) | Kỳ `hard_locked` / đã hash / đã nộp BCTC |
|---|---|---|---|
| Sửa diễn giải, chiều phân tích không ảnh hưởng số tiền/tài khoản | Cho UPDATE tại chỗ + audit_event (Odoo cho sửa metadata; MT cho sửa metadata) | Như kỳ open | Không |
| Sửa số tiền/tài khoản/ngày | `unpost()` → sửa → `post()` lại; mọi phiên bản dòng cũ lưu vào `voucher_line_history` (UX "sửa trực tiếp" nhưng có vết) | Reversal ghi ngày hiện tại + chứng từ mới (Fowler Reversal Adjustment; Odoo `_unlink_or_reverse`) | Reversal/điều chỉnh ở kỳ mở gần nhất (Luật KT: ghi số âm / ghi điều chỉnh) |
| Xoá | `discard()` → `cancelled`, giữ số | Reversal | Không |
| Ghi lùi ngày vào kỳ này | Cho phép | Chặn trừ role đặc biệt (ERPNext "Role Allowed to Set Frozen Accounts and Edit Frozen Entries") | Chặn tuyệt đối |

- "UX kế toán quen sửa" được đáp ứng bằng **unpost-edit-repost trong kỳ mở** — thực chất là Replacement Adjustment của Fowler, nhưng tránh "mất lịch sử" bằng cách lưu snapshot các dòng cũ (bảng `voucher_line_history` hoặc bảng `audit_event` với JSON before/after, ghi cả `posting_date` lẫn `recorded_at` theo Audit Log). Odoo thực hiện đúng cách này (reset to draft) và chỉ chuyển sang reversal khi đụng lock date/hash.
- Hash chain chỉ nên tính **tại thời điểm hard lock / chốt kỳ** (Odoo "Secure Entries Wizard đến một ngày"), tránh tính lúc post vì unpost sẽ phá chuỗi.
- Nên lưu `reversal_of_id` + tự động đối trừ (reconcile) dòng đảo với dòng gốc trên tài khoản công nợ (Odoo `_reconcile_reversed_moves`) để báo cáo tuổi nợ không hiển thị cặp dòng triệt tiêu.
- ERPNext để lộ một điểm yếu: dòng đảo "On cancellation of" không có chứng từ gốc; thiết kế mới nên tạo **voucher đảo thực sự** (có số, có ngày, có người lập) thay vì dòng GL mồ côi.

### Gaps
- Không truy cập được nguyên văn Điều 27 khoản 3–4 Luật Kế toán 2015 (phần sửa sổ ghi bằng phương tiện điện tử); các trang luatminhkhue/hethongphapluat trả 403/500. Cần đối chiếu văn bản gốc (Luật 88/2015/QH13) về yêu cầu "ghi số âm hoặc ghi điều chỉnh" đối với sổ điện tử.
- Không đọc được phần `_hash_moves` (điều kiện journal restricted / sắp xếp theo sequence) trong account_move.py vì file quá dài; chỉ có `_calculate_hashes`.

---

## Q3. Vật hoá số dư (balance materialization) để báo cáo nhiều năm vẫn nhanh mà ghi lùi ngày vẫn đúng; khoá kỳ, kết chuyển cuối năm; báo cáo; hiệu năng

### Takeaway
Chiến lược thắng thế là **"snapshot theo kỳ + cộng dồn phần tăng thêm"**: số dư = `snapshot(cuối kỳ trước) + SUM(dòng từ đầu kỳ đến ngày hỏi)`; một bút toán ghi lùi ngày chỉ làm "bẩn" các snapshot **từ ngày hiệu lực trở đi** và chúng được tính lại (đồng bộ hoặc nền). Running balance trên từng dòng chỉ dùng cho tài khoản tiền/ngân hàng và kho, nơi ghi lùi ngày bị hạn chế hoặc có cơ chế repost. Kết chuyển cuối năm là bút toán thật (không phải phép tính báo cáo) ghi vào tài khoản "lợi nhuận chưa phân phối", và báo cáo tài chính được định nghĩa bằng *mapping theo tiền tố mã tài khoản* (Odoo `account_codes` engine) hoặc `root_type/report_type` (ERPNext).

### Cited Findings
**Cách tính số dư trong các hệ thống**
- Fowler: số dư là tổng các Entry; có thể tính cho một khoảng thời gian — [Accounting Narrative](https://martinfowler.com/eaaDev/AccountingNarrative.html)
- Helland: số dư là *derived fact* — [CIDR 2015](https://www.cidrdb.org/cidr2015/Papers/CIDR15_Paper16.pdf)
- TigerBeetle lưu bốn bộ đếm cộng dồn trên account (`debits_pending`, `debits_posted`, `credits_pending`, `credits_posted`) và ứng dụng tự tính số dư; flag `history` giữ lịch sử số dư theo từng transfer cho `get_account_balances` — [Account reference](https://docs.tigerbeetle.com/reference/account/), [Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/)
- Square cache số dư trên `books` và cập nhật mỗi thao tác; `book_entries` có version counter theo book — [Square Books](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/)
- Medici: snapshot số dư nền mỗi 24h (`balanceSnapshotSec`), TTL gấp đôi; truy vấn = snapshot gần nhất + giao dịch sau đó; void ghi lùi ngày (`use_original_date`) có thể làm cache lệch đến khi tính lại — [medici](https://github.com/flash-oss/medici)
- Modern Treasury: entry có `effective_at` "affects the balance on and after the effective_at timestamp"; có thể ghi lùi (ví dụ ghi ngày 1/10 với `effective_at` 30/9); truy vấn `balances[effective_at]=...`; ghi lùi làm đổi số dư quá khứ nên hỏi lại cùng ngày có thể ra khác; `lock_version` "will always increment upward upon updating the account" kể cả khi effective_at trong quá khứ — [Verify Prior Ledger States](https://docs.moderntreasury.com/ledgers/docs/verify-prior-ledger-states.md)
- Oracle GL: bút toán ghi lùi ngày thay đổi số dư "as of the effective date and all subsequent dates", tính lại bắt đầu từ effective date — [Oracle Average Balance Processing](https://docs.oracle.com/en/cloud/saas/financials/25b/faugl/key-aspects-of-average-balance-processing.html); Oracle Accounting Foundation tách *As of Date* và *Posting Date*, ghi phiên bản mới của bản ghi số dư thay vì ghi đè — [Oracle OFS process details](https://docs.oracle.com/en/industries/financial-services/ofs-analytical-applications/accounting-foundation/22d/user/process-details.html)
- Jack Henry GL: "Prior-date posting limits are configurable", sửa sai bằng reversal liên kết bản gốc — [Jack Henry transaction sets](https://jackhenry.dev/digital-core-api-docs/general-ledger/guides/transaction-sets/)
- ERPNext Stock Ledger Entry lưu running balance trên từng dòng: `qty_after_transaction`, `valuation_rate`, `stock_value`, `stock_value_difference`, `stock_queue`; ghi lùi ngày phải repost toàn bộ dòng sau — [stock_ledger_entry.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/stock/doctype/stock_ledger_entry/stock_ledger_entry.json), [Repost Item Valuation](https://docs.frappe.io/erpnext/repost-item-valuation)

**Khoá kỳ, kết chuyển cuối năm**
- Odoo dùng account type `equity_unaffected` ("Current Year Earnings"); mặc định tài khoản `999999` "Undistributed Profits/Losses"; chỉ được có một tài khoản loại này; kết chuyển = bút toán misc ngày cuối năm chuyển sang vốn chủ sở hữu; sau khi "current year earnings" = 0 thì đặt Hard Lock date (irreversible) — [Odoo year-end](https://www.odoo.com/documentation/saas-18.4/applications/finance/accounting/reporting/year_end.html), [account_account.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_account.py)
- Odoo `include_initial_balance` = false với income/expense → báo cáo P&L không cộng dồn từ đầu, báo cáo BS cộng "from the beginning of time" — [account_account.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_account.py)
- ERPNext Period Closing Voucher chuyển số dư ròng income/expense vào tài khoản đóng (Retained Earnings...), có "Book Cost Center Wise Profit/Loss"; "do not close receivable, payable, bank, stock, asset, liability, or other Balance Sheet accounts"; sửa sau đó = PCV mới chỉ chuyển phần P&L còn lại ("does not silently rewrite the submitted voucher"); khoá bằng Accounting Period hoặc Accounts Frozen Upto — [Period Closing Voucher](https://docs.frappe.io/erpnext/period-closing-voucher)
- ERPNext: "ERPNext does not allow a future end date" cho Accounting Period — [Accounting Period](https://docs.frappe.io/erpnext/accounting-period)
- ERPNext GL Entry: `is_opening` ∈ {No, Yes}; "'Profit and Loss' type account not allowed in Opening Entry"; "Round Off for Opening" account riêng — [gl_entry.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/gl_entry/gl_entry.json), [general_ledger.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/general_ledger.py)

**Báo cáo & DSL định nghĩa báo cáo**
- Odoo `account.report` engines: *domain* (formula là Odoo domain trên `account.move.line`, subformula `sum`, `sum_if_pos`, `sum_if_neg`, `count_rows`, dấu `-` đảo dấu), *tax_tags*, *account_codes* (số học trên tiền tố mã: `21 + 10 - 5`, loại trừ con: `21 + 10(101, 102) - 5(57)`), `cross_report` tham chiếu báo cáo khác — [Odoo Custom reports](https://www.odoo.com/documentation/saas-17.2/pt_BR/applications/finance/accounting/reporting/customize.html)
- ERPNext: Account có `root_type` + `report_type` (Balance Sheet / Profit and Loss) + cây `lft/rgt`; báo cáo P&L/BS dựng từ cây này — [account.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/account/account.json)
- Odoo tag: `tag_ids` "Optional tags you may want to assign for custom reporting"; `account.group` theo tiền tố mã — [account_account.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_account.py)
- ERPNext Payment Ledger: AR/AP report và công cụ đối trừ lấy nguồn từ Payment Ledger, "Debit and Credit fields are replaced by 'Account Type' and 'Amount'" — [ERPNext manual: Payment Ledger](https://docs.erpnext.com/docs/user/manual/en/payment_ledger)
- Odoo `account.partial.reconcile.max_date` = ngày lớn hơn trong hai dòng được đối trừ, "used for aged reports" — [account_partial_reconcile.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_partial_reconcile.py)

**Hiệu năng ở quy mô lớn**
- PostgreSQL partition RANGE/LIST/HASH; "the constraint's columns must include all of the partition key columns" đối với PK/UNIQUE; planner "handle partition hierarchies with up to a few thousand partitions fairly well" khi prune tốt; index tạo trên bảng cha tự nhân bản xuống partition; `DETACH PARTITION ... CONCURRENTLY` chỉ cần `SHARE UPDATE EXCLUSIVE` — [PostgreSQL ddl-partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- BRIN phù hợp bảng append-only theo thời gian, nhỏ hơn B-tree "dozens to hundreds of times"; dữ liệu ghi lệch thứ tự (ví dụ ghi lùi ngày) làm BRIN kém hiệu quả — [StackHarbor BRIN](https://stackharbor.com/en/knowledge-base/pg-brin-indexes-large-tables/), [Crunchy Data BRIN](https://crunchydata.com/blog/postgresql-brin-indexes-big-data-performance-with-minimal-storage)
- Uber: offload theo time-range sang cold storage; checksum theo cửa sổ thời gian; index eventually-consistent xây bằng materialized views — [Uber LedgerStore](https://www.uber.com/en-IE/blog/how-ledgerstore-supports-trillions-of-indexes/)
- Square: UUID thay integer tăng dần, `cursor_shard` + `commit_timestamp` cho dữ liệu sắp theo thời gian, interleave `book_entries` dưới `journal_entries` — [Square Books](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/)

### Inferences
**Bảng quyết định chiến lược số dư:**

| Chiến lược | Đọc | Ghi | Ghi lùi ngày | Dùng cho |
|---|---|---|---|---|
| Tính từ dòng (SUM) | O(n dòng) – chậm khi nhiều năm | Rẻ nhất | Luôn đúng | Nguồn chân lý; kiểm tra chéo |
| Running balance trên từng dòng (ERPNext SLE, TigerBeetle `history`) | O(1) tra số dư tại dòng | Phải khoá tài khoản khi ghi | Phải repost mọi dòng sau (đắt, serial) | Kho (bắt buộc cho FIFO/BQ), sổ quỹ/ngân hàng |
| Bộ đếm cộng dồn trên account (TigerBeetle, Square `books`) | O(1) số dư hiện tại | Hot row, cần version/lock | Không có số dư lịch sử | Ví/ số dư "hiện tại" |
| **Snapshot cuối kỳ + delta** (Medici, Oracle) | O(dòng trong kỳ) | Rẻ; snapshot tính nền | Chỉ invalid snapshot từ kỳ chứa ngày hiệu lực trở đi | **GL doanh nghiệp – khuyến nghị** |

**Lược đồ snapshot đề xuất:**

```sql
CREATE TABLE account_period_balance (
  tenant_id uuid NOT NULL, account_id bigint NOT NULL,
  fiscal_year int NOT NULL, period_no int NOT NULL,
  currency_code char(3) NOT NULL,
  -- chiều phân tích tuỳ chọn: party_id, cost_center_id... (NULL = tổng)
  party_type text, party_id uuid, cost_center_id bigint,
  opening_debit numeric(20,0), opening_credit numeric(20,0),
  period_debit  numeric(20,0), period_credit numeric(20,0),
  closing_debit numeric(20,0) GENERATED ALWAYS AS (opening_debit + period_debit) STORED,
  closing_credit numeric(20,0) GENERATED ALWAYS AS (opening_credit + period_credit) STORED,
  is_stale boolean NOT NULL DEFAULT false,
  computed_at timestamptz,
  PRIMARY KEY (tenant_id, account_id, fiscal_year, period_no, currency_code, party_type, party_id, cost_center_id)
);
```
- Khi post/reverse voucher có `posting_date` = d: `UPDATE account_period_balance SET is_stale = true WHERE (fiscal_year, period_no) >= period(d) AND account_id IN (...)`. Worker tính lại theo thứ tự thời gian; báo cáo đọc snapshot `is_stale=false` + `SUM` phần dòng sau `computed_at`/trong kỳ. Đây chính là "rebuild từ branch point" của Fowler Retroactive Event, giới hạn trong phạm vi tài khoản bị ảnh hưởng (Fowler: "it can be limited to a subset of the system (the article cites accounts)").
- Cấp "số dư VN": số dư đầu kỳ Nợ/Có, phát sinh Nợ/Có, số dư cuối kỳ Nợ/Có – đúng cột của Bảng cân đối tài khoản / Sổ cái TT200; lưu riêng Nợ và Có (không net) để tài khoản lưỡng tính (131, 331) có số dư hai bên theo đối tượng.
- Kết chuyển cuối năm: bút toán thật `voucher_type='KC'` ngày 31/12 đưa số dư các TK loại 5–9 về 0 vào 421 (hoặc 911 → 421 theo TT200/TT99), có `is_closing=true` để báo cáo P&L *loại trừ* dòng kết chuyển (ERPNext PCV, Odoo "misc entry to equity"). Mở lại năm cũ = reverse bút toán KC, sửa, chạy KC lại (ERPNext: PCV mới chỉ chuyển phần còn lại).
- Partition `voucher_line` theo `RANGE (posting_date)` tháng/quý với PK `(id, posting_date)`; index B-tree `(tenant_id, account_id, posting_date)`; BRIN chỉ thêm cho cột `created_at` (đúng thứ tự ghi), không cho `posting_date` (bị ghi lùi).
- Báo cáo tài chính: bảng `report_line(report_code, line_code, formula)` với formula theo engine *account_codes* của Odoo (`'111 + 112 + 113'`, `'131(1312)'`), cộng thêm `balance_side` ∈ {debit, credit, net} để lấy "dư Nợ 131" riêng "dư Có 131" theo từng đối tượng (yêu cầu BCĐKT Việt Nam). Trial balance = `account_period_balance` nhóm theo cấp mã (prefix 1,2,3,4 ký tự).

### Gaps
- Không có nguồn nào cung cấp thiết kế hoàn chỉnh cho invalidation snapshot + tính lại đồng thời (lock, ordering); phần trên là tổng hợp từ Medici, Oracle, Modern Treasury và Fowler.
- Không tìm được tài liệu mô tả cấu trúc bên trong báo cáo Financial Statements của ERPNext (ngoài trường `root_type`/`report_type`).

---

## Q4. Động cơ tính giá vốn hàng tồn kho (bình quân cuối kỳ vs bình quân di động vs FIFO theo lớp) sao cho recost cuối kỳ ghi lại COGS nhất quán; các sub-ledger khác (AR/AP open items, TSCĐ, lương) và đối chiếu với GL

### Takeaway
Hai thiết kế thực chiến: (a) **ERPNext** – Stock Ledger Entry là running ledger theo (item, warehouse) với `stock_queue` FIFO và `valuation_rate` BQ di động, mọi thay đổi lùi ngày sinh job *Repost Item Valuation* tính lại toàn bộ dòng sau và repost GL; (b) **Odoo** – `stock.valuation.layer` là **lớp giá trị bất biến**, mỗi xuất kho tiêu thụ `remaining_qty/remaining_value` của các lớp, điều chỉnh (landed cost, chênh lệch hoá đơn) là *lớp con* liên kết `stock_valuation_layer_id` thay vì sửa lớp cũ. Cho phương pháp **bình quân gia quyền cuối kỳ** (phổ biến ở VN), cần tách "lượng" (ghi ngay) khỏi "giá" (gán ở cuối kỳ) và ghi COGS qua **bút toán điều chỉnh/thay thế** sau recost, không ghi đè GL. Sub-ledger AR/AP nên có bảng open-item riêng (ERPNext Payment Ledger Entry, Odoo `account.partial.reconcile`) đối chiếu được với tài khoản kiểm soát trên GL.

### Cited Findings
**Kho – ERPNext**
- SLE fields: `item_code`, `warehouse`, `posting_date`, `posting_time`, `posting_datetime`, `voucher_type`, `voucher_no`, `voucher_detail_no`, `dependant_sle_voucher_detail_no`, `recalculate_rate`, `actual_qty`, `qty_after_transaction`, `incoming_rate`, `outgoing_rate`, `valuation_rate`, `stock_value`, `stock_value_difference`, `stock_queue` (Long Text), `serial_no`, `batch_no`, `serial_and_batch_bundle`, `project`, `company`, `stock_uom`, `fiscal_year`, `is_cancelled`, `is_adjustment_entry` — [stock_ledger_entry.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/stock/doctype/stock_ledger_entry/stock_ledger_entry.json)
- FIFO: "maintains a FIFO queue of [quantity, rate] layers for each item-warehouse"; ví dụ layers [10@100],[10@120], xuất 15 → 10×100 + 5×120 = 1,600, còn 5 trị giá 600. Moving average: new average = (existing qty × existing avg rate + incoming qty × incoming rate) / (existing qty + incoming qty); xuất kho không đổi giá bình quân. Thay đổi quá khứ (backdated, cancel/amend, Landed Cost Voucher, đổi valuation rate) → "must repost — recompute the quantity, rate, value, and GL impact" của các dòng sau — [FIFO and Moving Average](https://docs.frappe.io/erpnext/fifo-and-moving-average)
- Repost Item Valuation: tự tạo khi lưu giao dịch lùi ngày hoặc thủ công (company, item, warehouse, posting date/time); tính lại từ mốc thời gian về sau và repost GL; chậm với lịch sử dài; "avoid reposting transactions in a closed financial year, since the closing balance would change" — [Repost Item Valuation](https://docs.frappe.io/erpnext/repost-item-valuation)
- Bản immutable ledger gốc chặn giao dịch kho lùi ngày vì tính lại FIFO/BQ đắt; nay cho phép qua job repost, "Recomputing every later stock or accounting entry can be expensive on a large database." — [Immutable Ledger in ERPNext](https://docs.frappe.io/erpnext/immutable-ledger-in-erpnext.md)

**Kho – Odoo**
- `stock.valuation.layer`: `company_id`, `product_id`, `quantity`, `uom_id`, `unit_cost`, `value`, `remaining_qty`, `remaining_value`, `description`, `stock_valuation_layer_id` (parent, "Linked To"), `stock_valuation_layer_ids` (child), `stock_move_id`, `account_move_id`, `account_move_line_id`, `price_diff_value`, `warehouse_id`, `lot_id`; unit cost khi tiêu thụ = `(candidate.value + sum(candidate.stock_valuation_layer_ids.mapped('value'))) / candidate.quantity` — tức lớp con (landed cost/revaluation) cộng vào lớp cha; `_get_returned_qty` trừ hàng trả trước khi tiêu thụ — [stock_valuation_layer.py (Odoo 18.0)](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/stock_account/models/stock_valuation_layer.py)
- Ví dụ FIFO vs AVCO (Odoo 19): mua 4@€10 rồi 4@€20, bán 3 → tồn còn €75 (AVCO) vs €90 (FIFO) — [Idealis Consulting](https://idealisconsulting.com/en_US/blog/idealis-consulting-1/understanding-stock-valuation-fifo-avco-and-margin-calculation-in-odoo-19-518)
- Truy vấn kiểm tra lệch: `SELECT ... remaining_qty, remaining_value FROM stock_valuation_layer WHERE remaining_qty > 0`, `remaining_qty` âm là dấu hiệu lỗi — [DeployMonkey](https://deploymonkey.com/blog/odoo-inventory-valuation-mismatch-fix)

**Kho – Việt Nam & plain-text accounting**
- TT200: ba phương pháp chính – thực tế đích danh, bình quân gia quyền (sau mỗi lần nhập hoặc cuối kỳ), FIFO; "Doanh nghiệp lựa chọn phương pháp tính giá trị hàng tồn kho nào thì phải đảm bảo tính nhất quán trong cả niên độ kế toán"; công thức BQ cuối kỳ: (Giá trị tồn đầu kỳ + Giá trị nhập trong kỳ) / (SL tồn đầu kỳ + SL nhập trong kỳ); BQ tức thời (liên hoàn) phù hợp đơn vị ít chủng loại, BQ cuối kỳ phù hợp nhiều chủng loại nhưng dồn việc cuối tháng — [MISA SME](https://sme.misa.vn/63109/tong-hop-cac-phuong-phap-xac-dinh-gia-xuat-kho-moi-nhat-theo-thong-tu-200/), [Kế toán Anpha](https://ketoananpha.vn/phuong-phap-tinh-gia-xuat-kho.html)
- Beancount: `Cost{number, currency, date, label}`, `CostSpec` thông tin một phần được *booking* giải quyết; Inventory gộp các position cùng currency+cost; booking method ví dụ FIFO, AVERAGE — [Beancount Design Doc](https://raw.githubusercontent.com/beancount/docs/master/docs/beancount_design_doc.md)

**AR/AP open items & đối trừ thanh toán**
- ERPNext Payment Ledger Entry: `posting_date`, `account_type`, `account`, `party_type`, `party`, `voucher_type`, `voucher_no`, `against_voucher_type`, `against_voucher_no`, `amount`, `account_currency`, `amount_in_account_currency`, `delinked`, `company`, `cost_center`, `project`, `due_date`, `finance_book`, `remarks`, `voucher_detail_no` — [payment_ledger_entry.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/payment_ledger_entry/payment_ledger_entry.json)
- Payment Ledger "only records transactions on Receivable and Payable accounts"; "the reconciliation process only updates the Payment Ledger"; AR/AP report và công cụ đối trừ dùng nó — [ERPNext manual](https://docs.erpnext.com/docs/user/manual/en/payment_ledger); trước v14 đối trừ phải sửa Payment Entry đã submit và repost GL để đổi `against_voucher`, "invisible in the GL entries, with no record of when it occurred" — [Proposal: Payment Reconciliation Improvement](https://discuss.frappe.io/t/proposal-payment-reconciliation-improvement/46873)
- `create_payment_ledger_entry` được gọi trong `make_gl_entries` trước `save_entries` khi ≥2 dòng và không phải PCV; huỷ chứng từ tạo Payment Ledger reversal — [general_ledger.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/general_ledger.py)
- ERPNext `update_outstanding_amt`: tính outstanding từ debit/credit theo account currency lọc theo against-voucher; "Outstanding for {0} cannot be less than zero ({1})" — [gl_entry.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/gl_entry/gl_entry.py)
- Odoo `account.partial.reconcile`: `debit_move_id`, `credit_move_id`, `full_reconcile_id`, `exchange_move_id`, `amount` (company currency, dương), `debit_amount_currency`, `credit_amount_currency`, `debit_currency_id`, `credit_currency_id`, `company_id`, `max_date`; unlink = gỡ partial → gỡ full reconcile → **reverse** (không xoá) exchange move & cash-basis move với `cancel=True`, ngày gốc trừ khi đụng lock date thì ngày sau lock — [account_partial_reconcile.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_partial_reconcile.py)
- Odoo dòng công nợ có `amount_residual`, `amount_residual_currency`, `reconciled`, `matching_number`, `date_maturity` — [account_move_line.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move_line.py)
- Stripe: clearing accounts (ví dụ `charge_unsubmitted`) phải về 0; creation và release khớp bằng identifier, có thể đến lệch thứ tự — [Stripe Ledger](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)
- TigerBeetle two-phase (pending → post/void) là cơ chế "reserve rồi settle" ở DB — [Two-Phase Transfers](https://docs.tigerbeetle.com/coding/two-phase-transfers/)

**Tài sản cố định**
- ERPNext Asset Depreciation Schedule: `asset`, `company`, `finance_book`, `depreciation_method`, `total_number_of_depreciations`, `rate_of_depreciation`, `daily_prorata_based`, `shift_based`, `frequency_of_depreciation` (months), `opening_accumulated_depreciation`, `opening_number_of_booked_depreciations`, `expected_value_after_useful_life`, `value_after_depreciation`, `depreciation_schedule` (child), `status` ∈ {Draft, Active, Cancelled}, `amended_from`; child `Depreciation Schedule`: `schedule_date`, `depreciation_amount`, `accumulated_depreciation_amount`, `journal_entry` (Link Journal Entry), `make_depreciation_entry` (Button), `shift` — [asset_depreciation_schedule.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/assets/doctype/asset_depreciation_schedule/asset_depreciation_schedule.json), [depreciation_schedule.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/assets/doctype/depreciation_schedule/depreciation_schedule.json)
- Odoo có `account_type` `asset_fixed` và `expense_depreciation` — [account_account.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_account.py)
- Helland: khấu hao là *derived fact* "amortized capital expenses based upon a rate and a cost" — [CIDR 2015](https://www.cidrdb.org/cidr2015/Papers/CIDR15_Paper16.pdf)

**Lương**
- ERPNext Payroll Entry: submit tất cả Salary Slip → Journal Entry trích lương "book the default Payroll Payable account against respective Expense Heads"; cost center ưu tiên Salary Structure Assignment → Employee/Department → Payroll Entry; "Submitting Salary Slips one by one manually will not create the Journal Entry"; Bank Entry là một bút toán tổng ("only one payment entry") — [Payroll Entry](https://docs.frappe.io/hr/payroll-entry)

### Inferences
**Bảng quyết định phương pháp giá vốn:**

| Phương pháp | Khi nào biết giá xuất | Cấu trúc dữ liệu | Recost cuối kỳ | Ghi lùi ngày |
|---|---|---|---|---|
| BQ gia quyền **cuối kỳ** (TT200/TT99, phổ biến VN) | Cuối kỳ | `stock_move(qty)` + `item_period_cost(item, wh?, period, avg_rate)` | **Bản chất là recost**: 1 lần/kỳ, gán `unit_cost` cho mọi dòng xuất trong kỳ | Rẻ: chỉ tính lại kỳ bị ảnh hưởng và các kỳ sau (giá tồn đầu kỳ thay đổi) |
| BQ **di động** (ERPNext Moving Average, Odoo AVCO) | Ngay lúc xuất | Running `valuation_rate` trên từng SLE | Repost toàn bộ dòng sau mốc | Đắt, serial theo (item, wh) |
| FIFO lớp (Odoo SVL, ERPNext `stock_queue`, Beancount lots) | Ngay lúc xuất | Lớp nhập bất biến + `remaining_qty/value` + bảng tiêu thụ lớp | Repost: huỷ tiêu thụ, chạy lại | Đắt nhất; cần lock (item, wh) |
| Đích danh | Ngay | Lô/serial gắn giá | Không cần | Không ảnh hưởng dòng khác |

**Lược đồ đề xuất (hỗ trợ cả 3, tách lượng khỏi giá):**

```sql
CREATE TABLE stock_move (            -- sự kiện lượng, bất biến sau post
  id uuid PRIMARY KEY, tenant_id uuid, item_id bigint, warehouse_id bigint,
  posting_date date, posting_seq bigint,         -- thứ tự tuyệt đối trong ngày (ERPNext posting_datetime + creation)
  qty numeric(20,4),                              -- + nhập / − xuất
  direction text CHECK (direction IN ('in','out','adjust')),
  known_unit_cost numeric(20,4),                  -- nhập: giá vốn nhập (có thể sửa bởi lớp điều chỉnh)
  source_doc_type text, source_doc_id uuid, voucher_id uuid, state text
);
CREATE TABLE stock_cost_layer (      -- Odoo stock.valuation.layer: lớp nhập + lớp con điều chỉnh
  id bigint PRIMARY KEY, tenant_id uuid, item_id bigint, warehouse_id bigint,
  stock_move_id uuid REFERENCES stock_move(id), parent_layer_id bigint REFERENCES stock_cost_layer(id),
  quantity numeric(20,4), value numeric(20,0), remaining_qty numeric(20,4), remaining_value numeric(20,0),
  created_at timestamptz
);
CREATE TABLE stock_cost_assignment ( -- kết quả tính giá cho dòng xuất; phiên bản hoá
  id bigint PRIMARY KEY, tenant_id uuid, stock_move_id uuid, costing_run_id bigint,
  unit_cost numeric(20,4), total_cost numeric(20,0),
  consumed_layer_id bigint, consumed_qty numeric(20,4),     -- FIFO: nhiều dòng/1 move
  is_current boolean
);
CREATE TABLE costing_run (            -- một lần tính giá/recost
  id bigint PRIMARY KEY, tenant_id uuid, method text, scope_item_id bigint, scope_warehouse_id bigint,
  from_date date, status text, started_at timestamptz, finished_at timestamptz,
  cogs_adjustment_voucher_id uuid    -- bút toán chênh lệch COGS (Difference Adjustment) hoặc bộ reversal+replacement
);
```
- **Recost nhất quán với GL**: không UPDATE dòng GL đã post. Sau `costing_run`, so sánh `stock_cost_assignment` cũ/mới theo (tài khoản 632/155/156, đối tượng, kỳ) và ghi **một chứng từ điều chỉnh** phần chênh lệch (Fowler Difference Adjustment) nếu kỳ còn mở; nếu kỳ đã khoá thì ghi vào kỳ mở gần nhất. Với BQ cuối kỳ thì chứng từ xuất kho post với `unit_cost = NULL` (chỉ lượng) và bút toán giá vốn sinh ở cuối kỳ bằng một voucher tổng hợp theo (item, kho, đối tượng) — tránh N bút toán 632 lẻ tẻ bị thay thế.
- ERPNext chứng minh running-ledger + repost chạy được nhưng "slow on long histories" và nguy hiểm khi chạm năm đã đóng → thiết kế mới nên **chặn recost xuyên kỳ khoá** và đưa chênh lệch vào kỳ mở.
- Khoá đồng thời: mọi ghi/recost trên cùng (item, warehouse) phải serial (advisory lock `pg_advisory_xact_lock(hash(item,wh))`) — ERPNext từng có bug "earlier-dated transaction is submitted alongside another for the same item and warehouse" ([v15.123.0 release note qua tìm kiếm](https://newreleases.io/project/github/frappe/erpnext/release/v15.123.0)).
- **AR/AP open items**: bảng `open_item(id, tenant_id, account_id, party_id, voucher_line_id, due_date, original_amount, currency)` + `settlement(id, open_item_id, settling_voucher_line_id, amount, amount_currency, fx_rate, settled_on, exchange_diff_voucher_id)`; `residual = original − SUM(settlement)` (Odoo `amount_residual`). Huỷ đối trừ = xoá settlement **và reverse** bút toán chênh lệch tỷ giá (Odoo unlink → reverse `exchange_move_id`), không xoá GL. Đối chiếu sub-ledger ↔ GL: `SUM(open_item.residual) per account` phải bằng số dư GL của tài khoản kiểm soát, chạy như một *invariant job* (Stripe "clearing" ratio).
- **TSCĐ**: `asset` + `depreciation_schedule_line(schedule_date, amount, accumulated, voucher_id)` là *derived plan*; mỗi kỳ bút toán khấu hao là voucher thật trỏ về dòng lịch; thay đổi nguyên giá/thời gian → lịch mới (ERPNext `amended_from`, status Cancelled) chứ không sửa lịch cũ, các kỳ đã ghi giữ nguyên, phần chênh ghi kỳ hiện tại.
- **Lương**: sub-ledger lương (bảng lương theo nhân viên/thành phần) → một voucher trích lương tổng hợp theo (TK chi phí, bộ phận/cost center) + voucher chi trả tổng (ERPNext); chi tiết nhân viên ở sub-ledger, không đẩy N dòng/nhân viên vào GL trừ khi 334 cần theo dõi theo đối tượng nhân viên.

### Gaps
- Không tìm thấy mã nguồn Odoo mô tả "FIFO vacuum"/xử lý tồn âm và cách Odoo *tính lại* khi nhận chứng từ lùi ngày (Odoo thực tế không repost FIFO lùi ngày; chưa xác nhận được bằng nguồn).
- Không có nguồn mô tả động cơ *bình quân gia quyền cuối kỳ* trong Odoo/ERPNext (cả hai chỉ có FIFO/moving average/standard); đề xuất trên là suy luận từ công thức TT200 + cấu trúc SVL.
- ERPNext Payment Ledger: không tìm được tài liệu thiết kế gốc (PR #31033 được tham chiếu trong thảo luận nhưng chưa đọc).
- Không có nguồn về sổ phụ TSCĐ của Odoo Enterprise (`account.asset`) – mô-đun không nằm trong community repo.

---

## Q5. Mô hình thuế tổng quát (thuế suất, bao gồm/không bao gồm, khấu trừ tại nguồn, tài khoản VAT đầu vào/đầu ra)

### Takeaway
Odoo `account.tax` + `account.tax.repartition.line` là mô hình tổng quát nhất đã được chứng minh: một thuế = cách tính (`amount_type`), phạm vi (`type_tax_use`), chính sách giá bao gồm (`price_include`), chuỗi phụ thuộc (`include_base_amount`/`is_base_affected`), thời điểm ghi nhận (`tax_exigibility` on_invoice/on_payment) và **bảng phân bổ** quyết định phần trăm thuế đi vào tài khoản nào với thẻ báo cáo nào, riêng cho hoá đơn và hoá đơn trả lại. Thuế khấu trừ tại nguồn / reverse-charge được mô hình bằng dòng phân bổ **âm** (+100/−100). ERPNext đơn giản hơn: tài khoản loại `Tax` với `tax_rate`, cộng `Tax Withholding Category` riêng.

### Cited Findings
- Odoo `account.tax`: `amount_type` ∈ {`group`, `fixed`, `percent`, `division`} (mặc định `percent`; `group` gom `children_tax_ids`); `price_include_override` ∈ {`tax_included`, `tax_excluded`} với `price_include` tính từ override rồi đến `company.account_price_include`; `include_base_amount` ("Affect Base of Subsequent Taxes"); `is_base_affected` ("Base Affected by Previous Taxes", mặc định True); `type_tax_use` ∈ {`sale`, `purchase`, `none`}; `tax_group_id` → `account.tax.group` có `tax_payable_account_id`, `tax_receivable_account_id`, `advance_tax_payment_account_id` dùng cho bút toán quyết toán thuế; `tax_exigibility` ∈ {`on_invoice`, `on_payment`}; `cash_basis_transition_account_id` giữ thuế đến khi hoá đơn được đối trừ — [account_tax.py (Odoo 18.0)](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_tax.py)
- Repartition: `invoice_repartition_line_ids` / `refund_repartition_line_ids` (lọc theo `document_type`), mỗi bên mặc định một dòng `base` và một dòng `tax`; `_validate_repartition_lines`: đúng một dòng base mỗi bên, hai bên cùng số dòng/thứ tự/`repartition_type`/`factor_percent`, ≥1 dòng tax, tổng factor dương = 100, tổng factor âm (nếu có) = −100; dòng có `factor_percent`, `account_id`, `tag_ids`, `use_in_tax_closing` — [account_tax.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_tax.py)
- `has_negative_factor`: thuế có dòng phân bổ âm, help text mô tả reverse-charge dạng "+100 / -100"; engine tạo bản sao `reverse_charge_taxes_data` với `is_reverse_charge` và đảo dấu — [account_tax.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_tax.py)
- Dòng journal item của Odoo mang `tax_ids` (thuế áp lên dòng cơ sở), `tax_line_id` (dòng *là* thuế, related `tax_repartition_line_id.tax_id`), `tax_base_amount`, `tax_tag_ids` — [account_move_line.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move_line.py)
- Odoo lock date riêng cho thuế: `tax_lock_date`, `line_ids._check_tax_lock_date()` — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py)
- Odoo báo cáo thuế dùng engine `tax_tags` — [Odoo Custom reports](https://www.odoo.com/documentation/saas-17.2/pt_BR/applications/finance/accounting/reporting/customize.html)
- ERPNext Account có `account_type = 'Tax'` và `tax_rate` trên tài khoản — [account.json](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/account/account.json)
- QuickBooks JournalEntryLineDetail có `TaxCodeRef`, `TaxApplicableOn`, `TaxAmount` (từ yêu cầu; không xác nhận được từ trang chính thức – xem Gaps)

### Inferences
**Lược đồ thuế tổng quát (theo Odoo, rút gọn):**

```sql
CREATE TABLE tax (
  id bigint PRIMARY KEY, tenant_id uuid, code text, name text,
  scope text CHECK (scope IN ('sale','purchase','none')),          -- type_tax_use
  amount_type text CHECK (amount_type IN ('percent','fixed','division','group')),
  rate numeric(9,4),                                                -- 10.0000 (%)
  price_include boolean, include_base_amount boolean, is_base_affected boolean DEFAULT true,
  exigibility text CHECK (exigibility IN ('on_invoice','on_payment')),
  transition_account_id bigint,                                     -- cash_basis_transition_account_id
  sequence int, active boolean
);
CREATE TABLE tax_distribution (          -- account.tax.repartition.line
  id bigint PRIMARY KEY, tax_id bigint REFERENCES tax(id),
  document_type text CHECK (document_type IN ('invoice','refund')),
  line_type text CHECK (line_type IN ('base','tax')),
  factor_percent numeric(9,4),           -- +100 / -100 cho reverse charge & khấu trừ tại nguồn
  account_id bigint,                     -- 1331 (VAT đầu vào), 33311 (VAT đầu ra), 3335 (TNCN khấu trừ)...
  report_tags text[],                    -- chỉ tiêu tờ khai: 'vat_in_base','vat_out_10'...
  seq int
);
```
- VND làm tròn thuế theo dòng vs theo chứng từ: lưu `tax_amount` trên dòng thuế (đã làm tròn scale 0) và một dòng "round off" như ERPNext (`Round Off Account`, ngưỡng `5/10^precision`) để tổng Nợ = Có.
- Thuế khấu trừ tại nguồn (TNCN, nhà thầu nước ngoài): mô hình như thuế `purchase` với phân bổ `tax` −100% vào 3335/3338 trên dòng thanh toán; hoặc tách "withholding" như ERPNext Tax Withholding Category (không đọc được tài liệu). Với VN, cách phân bổ âm của Odoo đủ tổng quát: hoá đơn 100 → phải trả NCC 90 (331), thuế giữ lại 10 (3335).
- Thuế theo thời điểm thanh toán (`on_payment`, cash basis) cần `transition_account_id` và bút toán chuyển khi đối trừ; Odoo chặn reset-to-draft các bút toán cash-basis — đưa vào state machine Q2.
- Thuế bao gồm trong giá: lưu cả `price_unit` gốc và `base_amount` đã tách; không lưu chỉ giá đã có thuế rồi suy ngược vì sai số làm tròn.

### Gaps
- Không đọc được phần định nghĩa model `account.tax.repartition.line` (file bị cắt ở 100k ký tự) và logic tax closing của Odoo.
- Không tìm được tài liệu ERPNext Tax Withholding Category trong phiên nghiên cứu này.
- Không xác nhận được trường `TaxCodeRef`/`TaxApplicableOn` của QuickBooks từ nguồn chính thức (trang Intuit chạy JS).

---

## Q6. Sai lầm thường gặp khi xây sổ cái

### Takeaway
Các nguồn độc lập (PostgreSQL docs, Stripe, Square, Modern Treasury, ERPNext, Odoo, Medici, cộng đồng Frappe) chỉ ra cùng một danh sách: float cho tiền; xoá/sửa dòng đã post; thiếu idempotency; trộn sub-ledger với GL (đối trừ làm thay đổi GL); không khoá kỳ; cache số dư mà không có cơ chế invalidation khi ghi lùi ngày; đánh số chứng từ bằng sequence DB; quy ước dấu khó hiểu; nhiều tài khoản "kết chuyển" không tồn tại hoặc quá nhiều dòng triệt tiêu.

### Cited Findings
- Float: `real`/`double precision` "are inexact"; "If you require exact storage and calculations (such as for monetary amounts), use the numeric type instead" — [PostgreSQL](https://www.postgresql.org/docs/current/datatype-numeric.html); TigerBeetle dùng u128 và khuyến cáo tính trên số nguyên vì float "can lose precision" — [Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/); Beancount dùng Decimal — [Beancount Design Doc](https://raw.githubusercontent.com/beancount/docs/master/docs/beancount_design_doc.md)
- Xoá dòng: Odoo "To keep the audit trail, you can not delete journal entries once they have been posted." — [account_move.py](https://raw.githubusercontent.com/odoo/odoo/18.0/addons/account/models/account_move.py); Medici: xoá thủ công làm `medici_balances` sai đến 24h — [medici](https://github.com/flash-oss/medici); Helland "Accountants don't use erasers or they go to jail" — [CIDR 2015](https://www.cidrdb.org/cidr2015/Papers/CIDR15_Paper16.pdf)
- Thiếu idempotency: Stripe dùng header `Idempotency-Key`, server trả "cached result of the successful operation" khi retry — [Stripe idempotency](https://stripe.com/blog/idempotency); Modern Treasury hỗ trợ idempotency key cho mọi POST, `external_id` unique theo ledger — [Guarantees](https://docs.moderntreasury.com/ledgers/docs/ledgers-guarantees.md); TigerBeetle `id` là idempotency key — [Transfer reference](https://docs.tigerbeetle.com/reference/transfer/)
- Trộn sub-ledger và GL: ERPNext trước v14 đối trừ bằng cách sửa chứng từ đã submit và repost GL để đổi `against_voucher` — "invisible in the GL entries, with no record of when it occurred" — [Proposal thread](https://discuss.frappe.io/t/proposal-payment-reconciliation-improvement/46873); v14 tách Payment Ledger: "reconciliation process only updates the Payment Ledger" — [ERPNext manual](https://docs.erpnext.com/docs/user/manual/en/payment_ledger); hệ quả phụ: GL của khách không còn hiện against-voucher — [discuss.frappe.io](https://discuss.frappe.io/t/payment-ledger-v-s-general-ledger-and-payment-reconciliation/124131)
- Không khoá kỳ: Odoo yêu cầu "current year earnings" về 0 trước khi đặt Hard Lock date irreversible — [Odoo year-end](https://www.odoo.com/documentation/saas-18.4/applications/finance/accounting/reporting/year_end.html); ERPNext cảnh báo repost trong năm đã đóng làm đổi số dư cuối năm — [Repost Item Valuation](https://docs.frappe.io/erpnext/repost-item-valuation)
- Cache số dư không invalidation: Medici `use_original_date` làm cache lệch — [medici](https://github.com/flash-oss/medici); Modern Treasury nhắc ghi lùi `effective_at` làm "checking a past date later can show different results" — [Verify Prior Ledger States](https://docs.moderntreasury.com/ledgers/docs/verify-prior-ledger-states.md)
- Sequence DB cho số chứng từ: "nextval ... is never rolled back" — [Cybertec](https://www.cybertec-postgresql.com/en/gaps-in-sequences-postgresql)
- Quy ước dấu: Square thừa nhận "The sign convention is the least intuitive part" — [Square Books](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/)
- Dòng đảo mồ côi: ý kiến cộng đồng ERPNext rằng dòng reversal "does not have an originating journal entry or stock entry supporting it" — [discuss.frappe.io](https://discuss.frappe.io/t/breaking-change-v13-introducing-immutable-ledgers-in-erpnext/52953)
- Số dòng 1 trong một chứng từ: ERPNext raise "Incorrect number of General Ledger Entries found. You might have selected a wrong Account in the transaction." — [general_ledger.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/general_ledger.py)
- Hotspot/ID: Square thay monotonic integer bằng UUID; TigerBeetle khuyến cáo ID ngẫu nhiên thuần "perform worse with LSM optimizations" — [Square Books](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/), [Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/)
- Clearing không về 0: Stripe coi tài khoản trung gian có số dư ≠ 0 là lỗi dữ liệu phát hiện ngay — [Stripe Ledger](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)
- Kiểm tra một chiều: LedgerLoom lưu ý kiểm tra cân từng bút toán không bắt được lỗi phân loại tài khoản; cần thêm bất biến phương trình kế toán ở mức toàn sổ — [LedgerLoom ch.05](https://ledgerloom.readthedocs.io/en/latest/ledgerloom_ch05_accounting_equation_invariant.html)
- RLS: table owner/superuser/`BYPASSRLS` bỏ qua policy trừ khi `FORCE ROW LEVEL SECURITY`; session variable có thể xung đột với pooler kiểu pgBouncer — [AWS RLS blog](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)

### Inferences
**Checklist "đừng làm":**

| Sai lầm | Hậu quả | Phòng ngừa |
|---|---|---|
| `float`/`double` cho tiền | Lệch 1 đồng, không cân | `NUMERIC(…,0)` cho VND, `NUMERIC(…,2/3)` ngoại tệ; CHECK scale theo ISO 4217 |
| UPDATE/DELETE dòng đã post | Mất vết, vi phạm Luật KT Đ.27 | Trigger chặn UPDATE/DELETE khi `state='posted'`; sửa qua Q2 |
| Post không idempotent | Ghi trùng khi retry | `UNIQUE(tenant_id, idempotency_key)`, trả kết quả cũ |
| Đối trừ công nợ ghi đè GL | Không biết đối trừ khi nào | Bảng settlement riêng (Q4), GL bất biến |
| Không có lock date | Số liệu đã nộp bị đổi | `fiscal_period.status` + kiểm tra ở `post()`/`unpost()` |
| Cache số dư không có `is_stale` | Báo cáo sai sau ghi lùi ngày | Snapshot + invalidation theo ngày hiệu lực (Q3) |
| `SERIAL` làm số chứng từ | Thiếu số sau rollback | Counter table khi post |
| Một cột `amount` có dấu duy nhất | Nhầm Nợ/Có, khó đọc với kế toán VN | Hai cột `debit`/`credit` + CHECK một bên |
| Dòng đảo không có chứng từ | Không giải trình được | Voucher đảo thật với `reversal_of_id` |
| Partition không có `posting_date` trong PK | Không tạo được PK/UNIQUE | PK `(id, posting_date)` |
| ORM `cascade delete` trên voucher đã post, lazy-load N+1 khi tính số dư, decimal → float trong driver | Mất dữ liệu / chậm / sai số | Chỉ cascade khi draft; tính số dù bằng SQL aggregate; map NUMERIC sang Decimal/BigInt (không `number` JS) |

### Gaps
- Không tìm được khảo sát/nghiên cứu có hệ thống về "lỗi thường gặp"; danh sách trên tổng hợp từ nhiều nguồn riêng lẻ.

---

## Q7. Lựa chọn công nghệ: PostgreSQL (NUMERIC, generated columns, partitioning, RLS), đa thuê bao SaaS, đồng thời/idempotency, kiểm thử bất biến kế toán, cạm bẫy ORM

### Takeaway
PostgreSQL đáp ứng toàn bộ nhu cầu lõi: `NUMERIC` chính xác, generated column cho `balance = debit − credit`, declarative partitioning theo `posting_date`, partial index `WHERE state='posted'`, deferred constraint trigger cho cân Nợ/Có, advisory lock cho tuần tự hoá theo tài khoản/kho, RLS cho multi-tenant kiểu "pool". Mô hình tenant: **row-level (`tenant_id` + RLS)** là mặc định cho SaaS nhiều tenant nhỏ; **schema/database per tenant** khi cần cách ly/backup riêng (Bigcapital chọn DB-per-org). Đồng thời: optimistic `version`/`lock_version` + idempotency key + balance lock (MT) ; kiểm thử: property-based với ba bất biến (cân từng chứng từ, reversal triệt tiêu, cache = recompute).

### Cited Findings
**PostgreSQL**
- NUMERIC chính xác nhưng "very slow compared to the integer types"; lưu trữ "two bytes for each group of four decimal digits, plus three to eight bytes overhead" — [PostgreSQL numeric](https://www.postgresql.org/docs/current/datatype-numeric.html)
- Partition: PK/UNIQUE phải chứa partition key; pruning plan-time và execution-time; `enable_partition_pruning`; index trên bảng cha tự nhân bản; vài nghìn partition vẫn ổn nếu prune tốt — [ddl-partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- ERPNext dùng partial index PostgreSQL `WHERE is_cancelled = 0` và `INCLUDE (debit, credit)` — [gl_entry.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/doctype/gl_entry/gl_entry.py)
- Gapless counter với `UPDATE ... RETURNING` / `SHARE ROW EXCLUSIVE` — [ElixirForum](https://elixirforum.com/t/how-to-ensure-a-gapless-auto-incremental-id-field-when-using-postgresql/26340)
- Trigger chặn UPDATE/DELETE/TRUNCATE trên bảng audit + role INSERT-only + hash chain + anchor ngoài — [knogin](https://knogin.com/en/developers/auth-tamper-evident-audit-trail), [the47network](https://the47network.com/blog/tamper-proof-audit-trail.html)

**Đa thuê bao**
- AWS: ba mô hình **silo** (DB riêng/tenant), **bridge** (schema riêng/tenant), **pool** (bảng chung + partitioning key, "cheapest and simplest to maintain but is hardest to enforce without RLS"); `ALTER TABLE tenant ENABLE ROW LEVEL SECURITY; CREATE POLICY tenant_isolation_policy ON tenant USING (tenant_id = current_setting('app.current_tenant')::UUID);`; ứng dụng `SET app.current_tenant = ...` khi lấy connection; kết nối bằng role không phải owner; `FORCE ROW LEVEL SECURITY`; INSERT vi phạm policy báo lỗi, SELECT/UPDATE/DELETE trả 0 dòng; cảnh báo pooler chia sẻ session state — [AWS RLS blog](https://aws.amazon.com/blogs/database/multi-tenant-data-isolation-with-postgresql-row-level-security/)
- So sánh: RLS rẻ, dễ phân tích chéo tenant, không phình catalog; schema-per-tenant mạnh hơn về cách ly/backup nhưng mỗi migration chạy N lần và catalog (`pg_class`, `pg_attribute`, `pg_index`) phình; ngưỡng "vỡ" được trích dẫn từ ~500 đến vài nghìn tenant (không phải benchmark) — [Draxlr](https://www.draxlr.com/blogs/multi-tenant-database-isolation-models/), [dev.co](https://dev.co/multi-tenant-saas-postgres-isolation)
- Square: tenant = "shelves", index phụ namespaced bằng `shelf_id` — [Square Books](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/)
- Bigcapital: "one database per organization" (MariaDB, NestJS) — [Railway deploy page](https://railway.com/deploy/bigcapital-accounting.md)
- TigerBeetle: multi-tenant → mỗi khách một `ledger` cho mỗi loại tiền — [Data Modeling](https://docs.tigerbeetle.com/coding/data-modeling/)

**Đồng thời & idempotency**
- Modern Treasury: ghi entry kèm `lock_version` của account (ví dụ `lock_version: 5`) → "will fail to be created" nếu account đã thay đổi; balance lock `pending_balance_amount` / `posted_balance_amount` / `available_balance_amount` với toán tử `gt/gte/eq/lte/lt` → 422 khi vi phạm; `ledger_account_category_balance_locks` cho hạn mức nhóm — [Lock on Account Balance or Version](https://docs.moderntreasury.com/ledgers/docs/lock-on-account-balance-or-version.md)
- Modern Treasury: "Reads won't block and aren't blocked by writes. Writes can use locking to serialize" — [Guarantees](https://docs.moderntreasury.com/ledgers/docs/ledgers-guarantees.md)
- TigerBeetle: `flags.linked` để nhiều transfer cùng thành công/thất bại; `debits_must_not_exceed_credits` để chặn số dư âm ở DB; `imported` timestamps phải tăng nghiêm ngặt — [Transfer reference](https://docs.tigerbeetle.com/reference/transfer/), [Multi-debit/credit recipe](https://docs.tigerbeetle.com/coding/recipes/multi-debit-credit-transfers/)
- ERPNext `make_reverse_gl_entries` đọc dòng gốc với row lock trước khi tạo dòng đảo — [general_ledger.py](https://raw.githubusercontent.com/frappe/erpnext/develop/erpnext/accounts/general_ledger.py)
- QuickBooks `SyncToken`: version number, update với token cũ bị từ chối — [CData QBO](https://cdn.cdata.com/help/RNM/ado/pg_table-journalentries.htm)
- Stripe idempotency: key do client sinh, áp cho "mutating endpoints (i.e. anything under POST)" — [Stripe idempotency](https://stripe.com/blog/idempotency)
- Uber: index strongly consistent bằng *intent* ghi trước record, commit sau — [Uber LedgerStore](https://www.uber.com/en-IE/blog/how-ledgerstore-supports-trillions-of-indexes/)

**Kiểm thử bất biến**
- Ledgerkit: fuzz test "a thousand random multi-leg entries with random idempotent replays" rồi assert tổng Nợ = tổng Có, tổng số dư có dấu = 0, số dư cache = tính lại từ journal; seed PRNG được log để tái hiện — [ledgerkit](https://github.com/themusashimaru/ledgerkit)
- Logistiki: bất biến "debits equal credits per currency", "a reversal exactly negates the original postings", "posted journals are immutable" — [Logistiki ledger invariants](https://logistiki.hexdocs.pm/ledger_invariants.html)
- LedgerLoom: kiểm tra cân từng entry + kiểm tra phương trình kế toán toàn sổ — [LedgerLoom ch.05](https://ledgerloom.readthedocs.io/en/latest/ledgerloom_ch05_accounting_equation_invariant.html)
- Beancount: `Balance` directive kiểm tra số dư đầu ngày, `Pad` chèn bút toán bù khi assertion thất bại — [Beancount Design Doc](https://raw.githubusercontent.com/beancount/docs/master/docs/beancount_design_doc.md)
- Stripe: "Prove correctness with invariants" là bài học chính; completeness check theo ID giữa nguồn và ledger — [Stripe Ledger](https://stripe.dev/blog/ledger-stripe-system-for-tracking-and-validating-money-movement)

### Inferences
**Bảng quyết định multi-tenancy:**

| Mô hình | Phù hợp | Rủi ro riêng cho kế toán |
|---|---|---|
| Pool (`tenant_id` + RLS) | SaaS nhiều DN nhỏ (kế toán dịch vụ, hộ kinh doanh) | Một policy sai lộ sổ sách DN khác → bắt buộc `FORCE ROW LEVEL SECURITY`, role app không phải owner, test tự động cho từng bảng; mọi UNIQUE phải có `tenant_id`; partition theo `(posting_date)` vẫn dùng được vì `tenant_id` ở index |
| Bridge (schema/tenant) | Vài trăm khách vừa, cần backup/restore từng DN, xuất dữ liệu theo DN cho cơ quan thuế | Migration ×N; catalog phình |
| Silo (DB/tenant, như Bigcapital) | Khách lớn/on-prem, yêu cầu pháp lý tách dữ liệu | Chi phí vận hành; khó báo cáo tổng |

Khuyến nghị: pool + RLS làm mặc định, thiết kế khoá & migration sao cho có thể "thăng cấp" một tenant lớn sang silo (mọi bảng đều có `tenant_id`, không dùng sequence toàn cục làm ID nghiệp vụ).

**Kỹ thuật PostgreSQL cụ thể:**
- `balance numeric GENERATED ALWAYS AS (debit - credit) STORED`; `CHECK (debit = 0 OR credit = 0)`; constraint trigger `DEFERRABLE INITIALLY DEFERRED` kiểm tra cân theo `(voucher_id, currency_code)` ở COMMIT.
- Trigger `BEFORE UPDATE OR DELETE ON voucher_line` RAISE khi voucher đang `posted` (trừ khi session flag `app.unposting = on` do thủ tục `unpost()` đặt) — tương đương Odoo "readonly fields on a posted move".
- `pg_advisory_xact_lock(hashtext(tenant_id||account_id))` khi post nếu tài khoản có `balance_must_be` (ERPNext `validate_balance_type`) hoặc là sổ quỹ cần running balance; nếu không thì không khoá (MT: "reads won't block").
- Idempotency: `INSERT ... ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id`; nếu không trả dòng → đọc voucher cũ và trả lại (đừng dùng sequence cho `voucher_no` ở bước này vì `ON CONFLICT` tiêu hao số – Cybertec).
- Optimistic lock: `UPDATE voucher SET ... , version = version + 1 WHERE id = $1 AND version = $2` (QBO SyncToken / MT lock_version).
- RLS mẫu: `CREATE POLICY p ON voucher_line USING (tenant_id = current_setting('app.current_tenant')::uuid)`, dùng `SET LOCAL` trong transaction (an toàn hơn `SET` với pooler ở transaction mode).
- Hash chain tính khi hard-lock: `row_hash = sha256(prev_hash || canonical_json(voucher + lines))`; verifier độc lập; đầu chuỗi mỗi kỳ ghi ra object storage có object-lock.

**Chiến lược kiểm thử (property-based, ví dụ Hypothesis/fast-check):**
1. Sinh ngẫu nhiên chứng từ N dòng, nhiều loại tiền, VND scale 0 → `post()` → assert `SUM(debit)=SUM(credit)` và `SUM(amount_currency)=0` theo loại tiền; chứng từ lệch phải bị từ chối.
2. Sinh chuỗi {post, reverse, unpost, backdate} ngẫu nhiên (stateful test) → assert số dư snapshot = `SUM` từ dòng với mọi `as_of_date`; reversal + gốc = 0 trên mọi tài khoản và đối tượng.
3. Replay cùng `idempotency_key` k lần → đúng một voucher, tổng không đổi.
4. Bất biến toàn sổ: Tài sản = Nợ phải trả + Vốn chủ sở hữu ở mọi ngày; mọi tài khoản clearing (Stripe) = 0 sau quy trình kết thúc.
5. Sub-ledger ↔ GL: `SUM(open_item.residual)` = số dư tài khoản kiểm soát; `SUM(stock_cost_layer.remaining_value)` = số dư 152/155/156.
6. Khoá kỳ: mọi thao tác ghi vào kỳ `hard_locked` bị từ chối, kể cả reverse.

**ORM pitfalls (suy luận từ các phát hiện):** cascade delete trên bản ghi đã post; map NUMERIC sang float/`number`; tính số dư bằng vòng lặp đối tượng thay vì aggregate SQL; tự động `UPDATE` toàn bộ cột khi lưu entity (phá hash/version); transaction mặc định của ORM không bao trùm counter table + insert; Odoo chọn giữ `balance = debit − credit` trong code thay vì DB – nếu tái sử dụng cách này thì phải chặn mọi đường ghi ngoài ORM.

### Gaps
- Không tìm thấy benchmark NUMERIC vs BIGINT minor-units trên workload sổ cái; chỉ có phát biểu định tính của PostgreSQL docs.
- Không có nguồn chính thống về ORM pitfalls riêng cho sổ cái; phần này là suy luận.
- Các ngưỡng số lượng tenant cho schema-per-tenant đến từ blog, không phải đo lường.
