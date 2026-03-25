# クライアントリファレンス テンプレート

このファイルをコピーして `{client-slug}.md` として保存し、各項目を埋める。

---

```yaml
---
clientSlug: ""
clientName: ""
updatedAt: ""
---
```

## 0. 会計ツール（全ステップ共通）

### 利用ツール
- tool: ""
  <!-- moneyforward / freee / yayoi / bugyo / its / その他 -->
- apiAvailable: false
  <!-- true: API/MCP経由で自動操作可能 / false: 手動操作 -->
- importFormat: ""
  <!-- 会計ツールへのインポート形式。例: "CSV" / "仕訳帳インポート" / "振替伝票CSV" -->
- exportFormat: ""
  <!-- 会計ツールからのエクスポート形式（消込確認等で使用）。例: "仕訳帳CSV" / "振込明細CSV" -->
- manualInstructions: |
    <!-- apiAvailable: false の場合の手動操作手順 -->

---

## 1. 請求書収集（Step 1: collect）

### 収集方法
- method: manual
  <!-- auto / manual / hybrid -->
- source: ""
  <!-- 例: "Gmail keiri@example.com 件名に「請求書」を含むメール" -->
  <!-- 例: "Google Drive フォルダID: xxxxx" -->
  <!-- 例: "Slack #keiri チャンネルにアップロードされるPDF" -->
- destination: ""
  <!-- 収集した請求書の一時保管先 -->

### 収集ルール
- 対象期間の判定方法: ""
  <!-- 例: "請求日が当月のもの" / "前月21日〜当月20日" -->
- 除外条件: ""
  <!-- 例: "0円請求書は除外" -->

---

## 2. 読取ヒント（Step 2: extract）

### 既知取引先

| 取引先 | フォーマット特徴 | 注意点 |
|--------|----------------|--------|

### 特殊フィールド
- 源泉徴収対象: false
- 源泉徴収対象取引先: []

---

## 3. チェックルール（Step 3: check）

### 定期取引先

| 取引先 | 通常金額（税込） | 許容範囲 | 備考 |
|--------|----------------|---------|------|

### チェック閾値
- 前月比アラート: ±30%
- 高額アラート: ¥1,000,000以上
- 二重請求検出: 同一取引先+同一金額+同一月

### 源泉徴収
- 源泉徴収対象の判定方法: ""

---

## 4. 振込データ（Step 4: pay）

### 振込元口座
- 銀行名: ""
- 支店名: ""
- 口座種別: ""
- 口座番号: ""
- 口座名義: ""

### 振込形式
- format: "fb"
  <!-- fb（全銀協） / csv -->
- feePolicy: "sender"
  <!-- sender（当方負担） / receiver（先方負担） -->

### 支払サイクル
- cycle: ""
  <!-- 例: "月末締め翌月末払い" -->
- paymentDate: ""
  <!-- 例: "毎月25日" / "月末営業日" -->

---

## 5. 振込実行（Step 5: execute）

### 実行方法
- method: manual
  <!-- manual / api -->
- bankingSystem: ""
  <!-- 例: "三菱UFJ BizSTATION" / "みずほe-ビジネスサイト" -->
- instructions: |
    <!-- 手動操作手順 -->

### 承認フロー

| 金額帯 | 承認者 |
|--------|--------|
| 全件 | |

---

## 6. 消込確認（Step 6: reconcile）

### 消込方法
- method: manual
  <!-- manual / auto -->
- source: ""
  <!-- 照合元データ。会計ツール連携の場合はセクション0の exportFormat を使用 -->
- instructions: |
    <!-- 手動の場合の手順 -->

---

## 特記事項

<!-- このクライアント固有の注意事項 -->
