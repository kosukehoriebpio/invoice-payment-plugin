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

REF_DIR     = .invoice-payment-references/
              （リファレンス専用リポのローカルクローン）
REF_FILE    = {REF_DIR}/{client-slug}.md
WORK_DIR    = .tmp-invoice-payment/{client-slug}/{YYYY-MM}/
              （YYYY-MMは現在の年月）
SCRIPTS     = {PLUGIN_ROOT}/scripts/
```

### 0-3. リファレンスの同期（自動pull）

リファレンスはプラグインとは別のリポ（`kosukehoriebpio/invoice-payment-references`）で管理されている。
プラグイン起動時に最新版を自動取得する:

```bash
# 初回: クローン
if [ ! -d ".invoice-payment-references" ]; then
  git clone https://github.com/kosukehoriebpio/invoice-payment-references.git .invoice-payment-references
fi

# 2回目以降: ローカル変更を破棄してからpull（常にリモートの正規版を使う）
cd .invoice-payment-references && git restore --staged . 2>/dev/null; git checkout -- . 2>/dev/null; git pull --ff-only && cd ..
```

**重要**: `git restore --staged` + `git checkout --` でローカルの変更（staged含む）を必ずリセットしてからpullする。
前回セッションのClaude Codeがリファレンスをローカルで書き換えた場合でも、常にリモートの正規版が使われる。

### 0-4. リファレンス読込

1. `REF_FILE`（`.invoice-payment-references/{client-slug}.md`）を Read で読み込む
2. 存在しない場合 → ユーザーに通知:
   ```
   「{client-slug} のリファレンスが見つかりません。
    .invoice-payment-references/_template.md をもとに作成しますか？
    作成後、リファレンスリポにコミット・プッシュすれば全社員に反映されます。」
   ```
3. リファレンスの内容を把握し、以下を特定:
   - 会計ツール（tool / apiAvailable）
   - 収集方法（method: auto/manual/hybrid）
   - 定期取引先一覧
   - 振込元口座
   - 振込実行方法（method: manual/api）

### 0-5. 作業ディレクトリ作成

```bash
mkdir -p {WORK_DIR}/invoices
```

### 0-6. 初期化結果の報告と確認

リファレンスから読み取った内容をユーザーに報告し、正しいか確認する:
```
=== Step 0 完了: 初期化 ===
クライアント: {clientName}（{clientNo}）
会計ツール: {tool}
収集方法: {method} — {source}
振込元口座: {銀行名}
振込実行: {bankingSystem}（{method}）
作業ディレクトリ: {WORK_DIR}

→ この内容で Step 1（請求書収集）に進みますか？
  リファレンスの情報に誤りがあれば教えてください。
```
→ AskUserQuestion で確認。ユーザーが誤りを指摘した場合はリファレンスを修正してから続行する。

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

### 収集完了後の報告と確認
`{WORK_DIR}/invoices/` 内のPDFファイル一覧を Glob で取得し、`_manifest.json` を生成。
**ユーザーに収集結果を報告し、次のステップに進むか確認する:**
```
=== Step 1 完了: 請求書収集 ===
収集方法: {method}
収集元: {source}
件数: {N}件
ファイル一覧:
- invoices/xxx.pdf
- invoices/yyy.pdf

→ 次のステップに進みますか？
```
→ AskUserQuestion で確認。承認されなければ中断。

### 次ステップの判定（会計ツールへの直接インポート vs 独自処理）

収集完了後、リファレンスの会計ツール設定に基づいて次の処理を判定する:

**パターンA（大多数のクライアント）: 会計ツールに直接インポート**
- リファレンスに `importDirect: true` またはバクラク/MF債務支払等のツールが設定されている場合
- 収集した請求書をそのまま会計ツールにインポートすれば、仕訳・分類はツール側で完了する
- → **Step 2（読取）・Step 3（チェック）はスキップ** → Step 4（振込データ作成）へ
- この場合、リファレンスの `manualInstructions`（会計ツールへのインポート手順）をユーザーに表示する

**パターンB（特殊なクライアント）: インポート前に加工・チェックが必要**
- リファレンスに `preImportProcessing` セクションがある場合
- 例: 請求書の金額を加工する、複数請求書を統合する、特定のフォーマットに変換する等
- → **Step 2・Step 3 を実行**してからStep 4へ

判定方法:
1. リファレンスの `preImportProcessing` セクションを確認
2. あれば パターンB → Step 2へ
3. なければ パターンA → インポート手順をユーザーに提示してStep 4へ

```
=== 判定結果 ===
会計ツール: {tool}
インポート方式: {パターンA: 直接インポート / パターンB: 加工後インポート}

{パターンAの場合}
請求書を会計ツールにインポートしてください:
{manualInstructionsの内容}
インポートが完了したら教えてください。

{パターンBの場合}
このクライアントはインポート前の加工が必要です。
Step 2（読取・データ化）に進みます。
```

`_manifest.json` を生成:

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

### 抽出後の報告と確認
```
=== Step 2 完了: 請求書読取・データ化 ===
{N}件 / 合計¥{total}
- inv-001: {vendorName} ¥{amount}
- inv-002: {vendorName} ¥{amount}
- ...

→ Step 3（内容チェック）に進みますか？
```
→ AskUserQuestion で確認。承認されなければ中断。

---

## Step 3: 内容チェック（check）

**スクリプトで実行する。**

```bash
npx tsx {SCRIPTS}/check.ts {WORK_DIR} {REF_FILE}
```

スクリプトが `_check-result.json` を `WORK_DIR` に出力する。

### チェック後の報告と確認

スクリプトの出力を確認し、**必ず**ユーザーに報告する:

```
=== Step 3 完了: 内容チェック ===
OK: {N}件 / WARN: {N}件 / NG: {N}件
{チェック結果の詳細テーブル}
```

- **NGがある場合**: NG項目を報告し、続行するか確認する。
  ```
  「以下の請求書にNGが検出されました:
   - inv-004 株式会社A食品卸 ¥341,000 — 二重請求の疑い
   これらを除外してStep 4に進みますか？」
  ```
  → AskUserQuestion で確認

- **WARNのみの場合**: WARN内容を報告し、確認後に続行。

- **全てOKの場合**: 結果を報告し、次のステップに進むか確認する。
  → AskUserQuestion で確認。承認されなければ中断。

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

**重要: 銀行のインターネットバンキング操作は、リファレンスの設定に関わらず、必ず人間が行う。**
APIやPlaywright等による銀行IBの自動操作は禁止。
このステップでClaudeが行うのは「操作手順の提示」と「完了報告の受付」のみ。

### 処理フロー

リファレンスの「振込実行」セクションからIBの種類と操作手順を取得し、ユーザーに提示する:

```
【振込実行手順】
1. {bankingSystem} にログイン
2. {リファレンスのinstructionsをそのまま表示}
3. アップロードするファイル: {WORK_DIR}/_payment.fb.txt
4. 振込件数: {N}件 / 合計金額: ¥{total}

完了したら教えてください。
```
→ AskUserQuestion で完了報告を待つ

**注**: リファレンスに `method: api` と記載されていても、銀行IB操作は手動で実行する。
`method: api` はテスト環境（ダミー銀行モックAPI）でのみ使用可能。

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
=== Step 6 完了: 消込確認 ===
消込OK: {N}件 / 未消込: {N}件 / 不一致: {N}件
{詳細テーブル}

=== 全ステップ完了 ===
請求書振込業務が完了しました。
```

---

## 通し実行の制御

全ステップ通し実行の場合、**各ステップの完了後に必ず結果を報告し、ユーザーの承認を得てから次のステップに進む。**
勝手に次のステップに進んではならない。

```
Step 0 → パス解決・リファレンス読込 → 【ユーザー報告: リファレンス内容のサマリ】
Step 1 → 請求書収集              → 【ユーザー確認: 収集結果を報告し承認を得る】
  ├─ パターンA（直接インポート）→ 会計ツールへのインポート手順を提示 → Step 4へスキップ
  └─ パターンB（加工が必要）  → Step 2・3を実行
Step 2 → PDF読取・データ化        → 【ユーザー確認: 抽出結果を報告し承認を得る】※パターンBのみ
Step 3 → チェック（スクリプト）    → 【ユーザー確認: チェック結果を報告し承認を得る】※パターンBのみ
Step 4 → 振込データ作成           → 【ユーザー確認: 振込サマリを報告し承認を得る】
Step 5 → 振込実行                → 【ユーザー確認: 手動操作の完了報告を待つ】
Step 6 → 消込確認（スクリプト）    → 【ユーザー報告: 最終結果を表示】
```

**パターンA（大多数）**: 収集 → 会計ツールにインポート（ツール側で仕訳完了）→ 振込データ作成 → 実行 → 消込
**パターンB（特殊）**: 収集 → 読取・加工 → チェック → 振込データ作成 → 実行 → 消込

**原則**: 1ステップ完了 → 結果報告 → ユーザー「OK」「進めて」等の承認 → 次ステップ開始。
承認なしに次のステップの処理を開始してはならない。

---

## 注意事項

- **銀行IB操作は絶対に自動化しない** — Step 5の振込実行は常に人間が手動で行う。API/Playwright等による銀行操作は本番環境では禁止。テスト環境（ダミー銀行モックAPI）でのみ method: api を許可
- **振込実行（Step 5）は必ずユーザー確認を経る** — 金額操作は自動で最終実行しない
- リファレンスが不完全な場合は実行を中断し、不足項目を報告する
- スクリプト（check.ts / generate-fb.ts / reconcile.ts）はクライアント固有ロジックを持たない。全てリファレンスから読み取る
- 銀行コードはプラグイン同梱の `data/bank-codes.json` を参照する
- MCPツールが利用できない環境では、該当ステップを手動フォールバックで実行する

### リファレンスファイルの保護

- **リファレンスファイル（`.invoice-payment-references/*.md`）を自動で書き換えてはならない。** リファレンスは正規のデータソースであり、Driveを検索して見つけたURLやAPIから取得した情報で上書きしてはならない。
- リファレンスの情報が不完全・不正確だと判断した場合は、**ユーザーに報告して確認を取る**こと。ユーザーの承認なしにリファレンスを変更しない。
- リファレンスを修正する場合は、修正内容をユーザーに明示し、承認後に変更 → コミット → プッシュまで行うこと（ローカルの未コミット変更を放置しない）。
- Drive/Gmail等を検索して見つけたフォルダIDやURLがリファレンスの記載と異なる場合は、**リファレンスの値を信頼し、差異をユーザーに報告する**。勝手にリファレンスを書き換えたり、別のURLを使ったりしない。
