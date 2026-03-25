---
name: invoice-payment
description: 請求書振込業務をクライアント別リファレンスに基づいて実行する。収集→読取→チェック→振込データ作成→実行→消込の6ステップ。
argument-hint: "<client-slug> [collect|extract|check|pay|execute|reconcile|all]"
allowed-tools: Read, Bash, Glob, Grep, Write, Edit, AskUserQuestion
---

# /invoice-payment — 請求書振込業務プラグイン

**引数**: $ARGUMENTS

---

## Step 0: 初期化（必ず最初に実行）

### 0-1. 引数パース

```
引数なし     → AskUserQuestion でクライアントを確認
{client}     → 全ステップ通し実行
{client} all → 全ステップ通し実行
{client} {step} → 指定ステップのみ実行
```

ステップ名: `collect` / `extract` / `check` / `pay` / `execute` / `reconcile`

### 0-2. パスの解決

以下の変数を確定する（以降の全ステップで使用）:

```
PLUGIN_ROOT = このSKILL.mdから3階層上のディレクトリ
              （skills/invoice-payment/SKILL.md → plugins/invoice-payment/）
              Glob で plugins/invoice-payment/.claude-plugin/plugin.json を探して確定する

REF_FILE    = {PLUGIN_ROOT}/references/{client-slug}.md
WORK_DIR    = .tmp-invoice-payment/{client-slug}/{YYYY-MM}/
              （YYYY-MMは現在の年月）
SCRIPTS     = {PLUGIN_ROOT}/scripts/
```

### 0-3. リファレンス読込

1. `REF_FILE` を Read で読み込む
2. 存在しない場合 → ユーザーに通知:
   ```
   「{client-slug} のリファレンスが見つかりません。
    {PLUGIN_ROOT}/references/_template.md をもとに作成しますか？」
   ```
3. リファレンスの内容を把握し、以下を特定:
   - 会計ツール（tool / apiAvailable）
   - 収集方法（method: auto/manual/hybrid）
   - 定期取引先一覧
   - 振込元口座
   - 振込実行方法（method: manual/api）

### 0-4. 作業ディレクトリ作成

```bash
mkdir -p {WORK_DIR}/invoices
```

---

## Step 1: 請求書収集（collect）

リファレンスの「請求書収集」セクションの `method` を読んで分岐する。

### method: auto
リファレンスの `source` に従って自動収集:
- **Gmail**: Gmail MCPツール（gmail_search_messages / gmail_read_message）で検索→添付PDF保存
- **Google Drive**: Drive MCPツール（drive_files_list / drive_files_download）でフォルダ内ファイル取得
- MCPツールが使えない場合は manual にフォールバック

### method: manual
ユーザーに指示:
```
「{clientName}の今月分の請求書PDFを以下に配置してください:
 {WORK_DIR}/invoices/
 配置が完了したら教えてください。」
```
→ AskUserQuestion で完了を待つ

### method: hybrid
auto を実行した後、「他に手動で追加する請求書はありますか？」と確認

### 収集完了後
`{WORK_DIR}/invoices/` 内のPDFファイル一覧を Glob で取得し、`_manifest.json` を生成:

```json
{
  "collectedAt": "ISO8601",
  "method": "manual|auto|hybrid",
  "invoices": [
    { "file": "invoices/xxx.pdf", "status": "pending" }
  ]
}
```

Write で `{WORK_DIR}/_manifest.json` に保存。

---

## Step 2: 請求書読取・データ化（extract）

`_manifest.json` を Read で読み込み、各PDFを順に処理する。

### 各PDFの処理手順

1. Read tool でPDFファイルを読み取る（Claude Visionが自動で画像として認識）
2. リファレンスの「読取ヒント」セクションを参照し、既知取引先の場合はヒントを適用
3. 以下のフィールドを抽出:

```json
{
  "id": "inv-001",
  "sourceFile": "invoices/xxx.pdf",
  "vendorName": "取引先名",
  "invoiceNumber": "請求書番号",
  "invoiceDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD",
  "subtotal": 0,
  "taxAmount": 0,
  "totalAmount": 0,
  "taxBreakdown": [{ "rate": 0.10, "subtotal": 0, "tax": 0 }],
  "withholdingTax": null,
  "bankAccount": {
    "bankName": "", "branchName": "", "accountType": "普通",
    "accountNumber": "", "accountHolder": ""
  },
  "lineItems": [{ "item": "", "quantity": 0, "unit": "", "unitPrice": 0, "taxRate": 0.10, "amount": 0 }],
  "registrationNumber": "Txxxxxxxxxx"
}
```

4. 全件の抽出結果を統合して `_extracted.json` に Write で保存:

```json
{
  "extractedAt": "ISO8601",
  "method": "claude-vision",
  "totalCount": 0,
  "invoices": [...]
}
```

### 抽出後のサマリ表示
```
=== 抽出完了 ===
{N}件 / 合計¥{total}
- inv-001: {vendorName} ¥{amount}
- inv-002: ...
```

---

## Step 3: 内容チェック（check）

**スクリプトで実行する。**

```bash
npx tsx {SCRIPTS}/check.ts {WORK_DIR} {REF_FILE}
```

スクリプトが `_check-result.json` を `WORK_DIR` に出力する。

### チェック後の判断

スクリプトの出力を確認し、ユーザーに報告する:

- **NGがある場合**: NG項目を報告し、続行するか確認する。
  ```
  「以下の請求書にNGが検出されました:
   - inv-004 株式会社A食品卸 ¥341,000 — 二重請求の疑い
   これらを除外してStep 4に進みますか？」
  ```
  → AskUserQuestion で確認

- **WARNのみの場合**: WARN内容を報告し、確認後に続行。

- **全てOKの場合**: そのままStep 4に進む。

---

## Step 4: 振込データ作成（pay）

**スクリプトで実行する。**

```bash
npx tsx {SCRIPTS}/generate-fb.ts {WORK_DIR} {REF_FILE}
```

スクリプトが `_payment.fb.txt`（振込ファイル）と `_payment-summary.md`（サマリ）を出力する。

### 振込サマリの確認

`_payment-summary.md` を Read で読み込み、ユーザーに表示:
```
「以下の振込データを作成しました:
 {サマリの内容}

 振込実行に進みますか？」
```
→ AskUserQuestion で確認。承認されなければ中断。

### 会計ツール連携（リファレンスに apiAvailable: true の場合）

リファレンスの `importMethod` に従ってAPI操作を実行:
- バクラクの場合:
  1. 各請求書PDFを `POST /workflow/user_upload_files` でアップロード
  2. `POST /workflow/requests` で支払申請を作成（status: IN_PROGRESS）
- apiAvailable: false の場合: `manualInstructions` の内容をユーザーに表示

---

## Step 5: 振込実行（execute）

リファレンスの「振込実行」セクションの `method` を読んで分岐する。

### method: manual
ユーザーに操作手順を表示:
```
【振込実行手順】
1. {bankingSystem} にログイン
2. {リファレンスのinstructionsをそのまま表示}
3. アップロードするファイル: {WORK_DIR}/_payment.fb.txt
4. 振込件数: {N}件 / 合計金額: ¥{total}

完了したら教えてください。
```
→ AskUserQuestion で完了報告を待つ

### method: api
リファレンスの `apiEndpoint` にFBファイルをアップロード:
```bash
curl -X POST -F "file=@{WORK_DIR}/_payment.fb.txt" {apiEndpoint}
```
結果を表示してユーザーに確認。

---

## Step 6: 消込確認（reconcile）

リファレンスの「消込確認」セクションの `method` を読んで分岐する。

### method: auto（APIで振込結果を取得できる場合）
**スクリプトで実行する。**

```bash
npx tsx {SCRIPTS}/reconcile.ts {WORK_DIR} {APIのURL}
```

### method: manual
ユーザーに振込結果データの提供を依頼:
```
「振込結果（通帳明細CSVまたはIB振込結果CSV）を
 {WORK_DIR}/ に配置してください。」
```
→ 配置後にreconcile.tsを実行

### 消込結果の報告
`_reconcile-result.json` を Read で読み込み、最終レポートを表示:
```
=== 消込結果 ===
消込OK: {N}件 / 未消込: {N}件 / 不一致: {N}件
{詳細テーブル}

請求書振込業務が完了しました。
```

---

## 通し実行の制御

全ステップ通し実行の場合、以下の順序で実行する。
**各ステップの間でユーザー確認を挟む箇所に注意。**

```
Step 0 → パス解決・リファレンス読込
Step 1 → 請求書収集
Step 2 → PDF読取・データ化
Step 3 → チェック（スクリプト） → 【ユーザー確認: NG/WARNがあれば】
Step 4 → 振込データ作成（スクリプト） → 【ユーザー確認: 振込サマリ】
Step 5 → 振込実行 → 【ユーザー確認: 手動の場合は完了報告を待つ】
Step 6 → 消込確認（スクリプト）
```

---

## 注意事項

- **振込実行（Step 5）は必ずユーザー確認を経る** — 金額操作は自動で最終実行しない
- リファレンスが不完全な場合は実行を中断し、不足項目を報告する
- スクリプト（check.ts / generate-fb.ts / reconcile.ts）はクライアント固有ロジックを持たない。全てリファレンスから読み取る
- 銀行コードはプラグイン同梱の `data/bank-codes.json` を参照する
- MCPツールが利用できない環境では、該当ステップを手動フォールバックで実行する
