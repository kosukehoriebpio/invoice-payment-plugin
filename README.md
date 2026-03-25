# invoice-payment — 請求書振込業務プラグイン

経理BPOの請求書振込業務をClaude Codeで標準化・自動化するプラグイン。

## インストール

```bash
# マーケットプレース経由（社内配布後）
/plugin marketplace add sevenrich/claude-plugins
/plugin install invoice-payment@sevenrich-bpo-tools

# または直接
/plugin install github:sevenrich/invoice-payment-plugin
```

## 使い方

```bash
/invoice-payment {client-slug} [step]
```

### ステップ

| Step | コマンド | 内容 |
|------|---------|------|
| 全体 | `/invoice-payment senjin` | 全6ステップ通し実行 |
| 1 | `/invoice-payment senjin collect` | 請求書収集 |
| 2 | `/invoice-payment senjin extract` | PDF読取・データ化 |
| 3 | `/invoice-payment senjin check` | 内容チェック |
| 4 | `/invoice-payment senjin pay` | 振込データ作成 |
| 5 | `/invoice-payment senjin execute` | 振込実行 |
| 6 | `/invoice-payment senjin reconcile` | 消込確認 |

## クライアント追加

1. `references/_template.md` をコピーして `references/{client-slug}.md` を作成
2. 各セクションを埋める（会計ツール、収集方法、定期取引先、振込元口座等）
3. コミット・プッシュ → 全社員に反映

## スクリプト（個別実行）

```bash
# チェック
npx tsx plugins/invoice-payment/scripts/check.ts <workDir> <referenceFile>

# FB生成
npx tsx plugins/invoice-payment/scripts/generate-fb.ts <workDir> <referenceFile>

# 消込
npx tsx plugins/invoice-payment/scripts/reconcile.ts <workDir> [apiUrl]
```

## テスト

```bash
# ダミー銀行API起動
npx tsx plugins/invoice-payment/test/mock-bank/server.ts

# テスト用ダミー会社で全ステップ実行
/invoice-payment test-foods
```

## ファイル構造

```
.claude-plugin/plugin.json    プラグインマニフェスト
skills/invoice-payment/SKILL.md  ワークフロー定義（6ステップ）
scripts/
  check.ts                    Step 3: チェックスクリプト
  generate-fb.ts              Step 4: FBファイル生成
  reconcile.ts                Step 6: 消込スクリプト
references/
  _template.md                クライアントリファレンステンプレート
  test-foods.md               テスト用ダミー会社
test/
  invoices/                   ダミー請求書（HTML + PDF）
  mock-bank/server.ts         ダミー銀行API
  bakuraku-openapi.json       バクラクAPI仕様
```

## 必要な環境

- Node.js 20+
- npm packages: `iconv-lite`, `multer`（モックAPI用）
- MCP（オプション）: Gmail, Google Drive（Step 1の自動収集用）
