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

# 2回目以降: pull（最新版を取得）
cd .invoice-payment-references && git pull --ff-only && cd ..
```

この処理は毎回Step 0で実行する。社員は初回実行時に自動クローンされ、以降は自動pullで常に最新のリファレンスが使える。

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
4. **不足フィールドを記録**する。各Stepで必要になった時点で以下の3段フォールバックを適用:
   - **第1段**: リファレンスに記載あり → そのまま使用
   - **第2段**: リファレンスに記載なし → AskUserQuestion でユーザーに質問。回答があればリファレンスへの反映も提案
   - **第3段**: ユーザーも不明 → 該当処理をスキップし、手動操作の手順を案内。後続Stepは続行可能

### 0-5. 作業ディレクトリ作成

```bash
mkdir -p {WORK_DIR}/invoices
```

---

## Step 1: 請求書収集（collect）

**スクリプトで実行する。**

```bash
npx tsx {SCRIPTS}/collect.ts {WORK_DIR} {REF_FILE}
```

スクリプトがリファレンスの `source` を読み、自動で適切な収集モードを選択する:
- **Google Drive**（sourceにフォルダIDがある場合）: Drive APIで自動ダウンロード、年月サブフォルダ自動検出
- **Gmail**（sourceにメールアドレスや「Gmail」記載がある場合）: 対象期間の添付PDF付きメールを検索・ダウンロード
- **バクラク**（sourceにバクラクURL記載がある場合）: バクラクAPIで「処理中」の請求書を取得
- **ローカル**（sourceが空 or 自動検出不可の場合）: `{WORK_DIR}/invoices/` のファイルをスキャン

全モードで最後にローカルスキャンも実行し、手動追加されたファイルも拾う。

### 収集ソースを明示指定する場合

```bash
# Drive
npx tsx {SCRIPTS}/collect.ts {WORK_DIR} {REF_FILE} --source drive:{folderId}

# Gmail
npx tsx {SCRIPTS}/collect.ts {WORK_DIR} {REF_FILE} --source gmail:"subject:請求書 from:vendor@example.com"

# バクラク（BAKURAKU_TOKEN env必須）
npx tsx {SCRIPTS}/collect.ts {WORK_DIR} {REF_FILE} --source bakuraku
```

### 手動配置（manual）の場合

スクリプト実行前にユーザーに指示:
```
「{clientName}の今月分の請求書PDFを以下に配置してください:
 {WORK_DIR}/invoices/
 配置が完了したら教えてください。」
```
→ AskUserQuestion で完了を待ち、その後スクリプトを実行

### hybrid モード

Drive収集後に「他に手動で追加する請求書はありますか？」と確認。
追加がある場合は `{WORK_DIR}/invoices/` に手動配置後、再度スクリプトを実行。

### 収集完了後
スクリプトが `_manifest.json` を `{WORK_DIR}/` に生成:

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

**2段構え**: Python構造パース（第1段）→ Claude Visionフォールバック（第2段）

### Step 2-1: PDF構造パース（スクリプト）

```bash
python {SCRIPTS}/extract.py {WORK_DIR}
```

`_manifest.json` 内の全PDFに対し、pdfplumber でテキストレイヤーから構造化抽出を実行。
以下を自動抽出する:
- 取引先名、請求書番号、請求日、支払期日
- 合計金額、小計、消費税額、税率別内訳
- 源泉徴収税額
- 振込先口座（銀行名、支店名、口座種別、番号、名義）
- 明細行（テーブル構造から品名、数量、単価、金額）
- 適格請求書登録番号（T + 13桁）

各PDFの抽出結果に `confidence` フィールドが付く:
- **high**: 取引先名・金額ともに構造パースで取得OK
- **medium**: 金額は取れたが取引先名等が不完全
- **low**: 金額が推定（文中最大値）
- **none** (`extraction_method: "vision_required"`): テキストレイヤーなし → Step 2-2 へ

### Step 2-2: Claude Visionフォールバック

`_extracted.json` を Read で読み込み、`visionRequiredIds` に該当するPDFのみ Vision で処理する。

1. 該当PDFを Read tool で読み取る（マルチモーダル自動認識）
2. リファレンスの「読取ヒント」セクションを参照
3. Step 2-1 と同じフィールドを抽出し、`_extracted.json` の該当エントリを上書き更新
4. `extraction_method` を `"vision"` に変更

**Vision不要（全件構造パース済み）の場合はこのステップをスキップ。**

### 抽出結果のフォーマット

```json
{
  "extractedAt": "ISO8601",
  "method": "pdfplumber+vision_fallback",
  "totalCount": 5,
  "structureParsed": 4,
  "visionRequired": 1,
  "visionRequiredIds": ["inv-003"],
  "invoices": [
    {
      "id": "inv-001",
      "sourceFile": "invoices/xxx.pdf",
      "extraction_method": "pdfplumber",
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
      "registrationNumber": "Txxxxxxxxxx",
      "confidence": "high",
      "warnings": []
    }
  ]
}
```

### 抽出後のサマリ表示
```
=== 抽出完了 ===
構造パース: {N1}件 / Vision: {N2}件 / 合計¥{total}
- inv-001: {vendorName} ¥{amount} [high]
- inv-002: {vendorName} ¥{amount} [vision]
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

### 会計ツール連携

`_tool-integration.json` と `_payment-summary.md` を Read で読み込み、ツール別に処理する。

generate-fb.ts が自動判定した `primaryTool` に基づいて分岐:

| primaryTool | ツール名 | API連携 | 処理 |
|---|---|---|---|
| `bakuraku` | バクラク債権・債務管理 | **可能** | `POST /workflow/requests` で支払申請作成 |
| `mf-shiharai` | MF債務支払 | 未成熟 | 手動操作手順を案内 |
| `freee` | freee会計 | **可能（未実装）** | 手動操作手順を案内（将来API化） |
| `mf-kaikei` | MF会計 | CSV | CSVインポート手順を案内 |
| `yayoi` | 弥生会計 | 手動 | 手動入力手順を案内 |
| `bugyo` | 勘定奉行 | 手動 | 手動入力手順を案内 |
| `ics` | ICS会計 | 手動 | 手動入力手順を案内 |
| `tkc` | TKC会計 | 手動 | 手動入力手順を案内 |
| `pca` | PCA会計 | 手動 | 手動入力手順を案内 |
| `unknown` | 未特定 | — | 3段フォールバック |

#### バクラク（apiAvailable: true の場合）
1. 各請求書PDFを `POST /workflow/user_upload_files` でアップロード
2. `POST /workflow/requests` で支払申請を作成（status: IN_PROGRESS）

#### その他全ツール（apiAvailable: false の場合）
`_payment-summary.md` の「会計ツール連携手順」セクションをそのままユーザーに表示。
リファレンスに `manualInstructions` がカスタム記載されている場合はそちらを優先。

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

- **銀行IB操作は絶対に自動化しない** — Step 5の振込実行は常に人間が手動で行う。API/Playwright等による銀行操作は本番環境では禁止。テスト環境（ダミー銀行モックAPI）でのみ method: api を許可
- **振込実行（Step 5）は必ずユーザー確認を経る** — 金額操作は自動で最終実行しない
- リファレンスが不完全な場合は実行を中断し、不足項目を報告する
- スクリプト（check.ts / generate-fb.ts / reconcile.ts）はクライアント固有ロジックを持たない。全てリファレンスから読み取る
- 銀行コードはプラグイン同梱の `data/bank-codes.json` を参照する
- MCPツールが利用できない環境では、該当ステップを手動フォールバックで実行する
