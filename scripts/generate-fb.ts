/**
 * Step 4: 振込データ作成（FBファイル生成）
 * _check-result.json + _extracted.json を読み込み、NG除外してFBファイルを生成
 *
 * Usage: npx tsx plugins/invoice-payment/scripts/generate-fb.ts <workDir> <referenceFile>
 */

import iconv from 'iconv-lite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM/CJS compatible __dirname
const __filename_compat = typeof __filename !== 'undefined' ? __filename : fileURLToPath(import.meta.url);
const __dirname_compat = path.dirname(__filename_compat);

const workDir = process.argv[2];
const refFile = process.argv[3];

if (!workDir) { console.error('Usage: npx tsx generate-fb.ts <workDir> [referenceFile]'); process.exit(1); }

// Path traversal guard: workDir must be a relative path without '..'
if (path.isAbsolute(workDir) && !workDir.startsWith(process.cwd())) {
  console.error(`Security: workDir must be relative or under cwd. Got: ${workDir}`);
  process.exit(1);
}
if (workDir.includes('..')) {
  console.error(`Security: workDir must not contain '..'. Got: ${workDir}`);
  process.exit(1);
}

const checkResult = JSON.parse(fs.readFileSync(path.join(workDir, '_check-result.json'), 'utf-8'));
const extracted = JSON.parse(fs.readFileSync(path.join(workDir, '_extracted.json'), 'utf-8'));

// 銀行コードマスタ（プラグイン同梱）— parseSenderFromRefより先に定義
const pluginRoot = path.resolve(__dirname_compat, '..');
const bankCodesPath = path.join(pluginRoot, 'data', 'bank-codes.json');
const bankMaster: Record<string, { code: string; kana: string }> = fs.existsSync(bankCodesPath)
  ? JSON.parse(fs.readFileSync(bankCodesPath, 'utf-8')).banks
  : {};

function lookupBankCode(bankName: string): string {
  if (bankMaster[bankName]) return bankMaster[bankName].code;
  for (const [name, info] of Object.entries(bankMaster)) {
    if (name.includes(bankName) || bankName.includes(name)) return info.code;
  }
  console.warn(`  [WARN] 銀行コード不明: ${bankName}`);
  return '0000';
}

function lookupBankKana(bankName: string): string {
  if (bankMaster[bankName]) return bankMaster[bankName].kana;
  for (const [name, info] of Object.entries(bankMaster)) {
    if (name.includes(bankName) || bankName.includes(name)) return info.kana;
  }
  return bankName.replace('銀行', '');
}

// リファレンスの「振込元口座」セクションからパース
function parseSenderFromRef(refPath: string) {
  const defaults = { code: '0000000000', name: '', bankCode: '0000', bankName: '', bankKana: '', branchCode: '000', branchName: '', branchKana: '', accountType: '1', accountNumber: '0000000', paymentDate: '0430' };
  if (!refPath || !fs.existsSync(refPath)) return defaults;

  const content = fs.readFileSync(refPath, 'utf-8');

  // 振込元口座セクションの各フィールドを抽出
  const bankName = content.match(/- 銀行名:\s*"(.+?)"/)?.[1] || '';
  const branchName = content.match(/- 支店名:\s*"(.+?)"/)?.[1] || '';
  const accountTypeStr = content.match(/- 口座種別:\s*"(.+?)"/)?.[1] || '普通';
  const accountNumber = content.match(/- 口座番号:\s*"(.+?)"/)?.[1] || '0000000';
  const accountHolder = content.match(/- 口座名義:\s*"(.+?)"/)?.[1] || '';

  // 支払日をパース（例: "月末営業日" → "0430"にはできないのでデフォルト維持）
  const paymentDateStr = content.match(/- paymentDate:\s*"(.+?)"/)?.[1] || '';
  // "毎月25日" → "0025", "月末営業日" → 月末日を計算
  let paymentDate = '0430'; // デフォルト
  const dayMatch = paymentDateStr.match(/(\d+)日/);
  if (dayMatch) {
    const now = new Date();
    // 翌月を計算（12月→1月の跨ぎに対応）
    const nextMonth = (now.getMonth() + 1) % 12 + 1; // 1-12
    paymentDate = String(nextMonth).padStart(2, '0') + dayMatch[1].padStart(2, '0');
  }

  return {
    code: '0000000000', // 依頼人コード（クライアントコードがあれば使う）
    name: accountHolder,
    bankCode: lookupBankCode(bankName),
    bankName,
    bankKana: lookupBankKana(bankName),
    branchCode: '000', // 支店コードはbank-codes.jsonに含まれていないため、将来拡張
    branchName,
    branchKana: branchName.replace('支店', ''),
    accountType: accountTypeStr === '当座' ? '2' : '1',
    accountNumber,
    paymentDate,
  };
}

const sender = parseSenderFromRef(refFile);

// Parse reference for tool info and regular vendors
let paymentTool = '';   // bakuraku, mf-shiharai, freee, mf-kaikei, yayoi, bugyo, etc.
let toolApiAvailable = false;
let toolManualInstructions = '';
const regularVendors: Record<string, boolean> = {};

if (refFile && fs.existsSync(refFile)) {
  const refContent = fs.readFileSync(refFile, 'utf-8');

  // Parse tool from section 0
  const toolMatch = refContent.match(/- tool:\s*"(.+?)"/);
  if (toolMatch) paymentTool = toolMatch[1].toLowerCase();
  const apiMatch = refContent.match(/- apiAvailable:\s*(true|false)/);
  if (apiMatch) toolApiAvailable = apiMatch[1] === 'true';
  const instrMatch = refContent.match(/- manualInstructions:\s*\|\n([\s\S]*?)(?=\n---|\n##)/);
  if (instrMatch) {
    const raw = instrMatch[1];
    const indentMatch = raw.match(/^(\s+)/);
    const indent = indentMatch ? indentMatch[1] : '    ';
    toolManualInstructions = raw.replace(new RegExp(`^${indent}`, 'gm'), '').trim();
  }

  // Parse regular vendors for new code determination
  const vendorSection = refContent.match(/### 定期取引先[\s\S]*?(?=\n##|\n---|$)/m);
  if (vendorSection) {
    for (const line of vendorSection[0].split('\n')) {
      if (!line.startsWith('|') || line.includes('---')) continue;
      const cols = line.split('|').slice(1, -1).map(c => c.trim());
      if (cols[0] && !cols[0].includes('取引先')) regularVendors[cols[0]] = true;
    }
  }
}

// Normalize tool name to a canonical key
function resolveToolKey(tool: string): string {
  if (/bakuraku|バクラク/i.test(tool)) return 'bakuraku';
  if (/mf.*債務|mf.*shiharai|moneyforward.*債務/i.test(tool)) return 'mf-shiharai';
  if (/freee/i.test(tool)) return 'freee';
  if (/\bmf\b|moneyforward|マネーフォワード/i.test(tool)) return 'mf-kaikei';
  if (/弥生|yayoi/i.test(tool)) return 'yayoi';
  if (/奉行|bugyo/i.test(tool)) return 'bugyo';
  if (/\bics\b/i.test(tool)) return 'ics';
  if (/\btkc\b/i.test(tool)) return 'tkc';
  if (/\bpca\b/i.test(tool)) return 'pca';
  return 'unknown';
}

// For compound tools like "bakuraku + moneyforward", detect the primary payment tool
function detectPrimaryPaymentTool(tool: string): string {
  const parts = tool.split(/[+＋,、]/).map(s => s.trim());
  // Priority: bakuraku > mf-shiharai > freee > others (bakuraku handles payment flow)
  for (const p of parts) {
    const key = resolveToolKey(p);
    if (key === 'bakuraku') return 'bakuraku';
  }
  for (const p of parts) {
    const key = resolveToolKey(p);
    if (key === 'mf-shiharai') return 'mf-shiharai';
  }
  for (const p of parts) {
    const key = resolveToolKey(p);
    if (key === 'freee') return 'freee';
  }
  // Default: first tool
  return resolveToolKey(parts[0] || '');
}

const primaryTool = detectPrimaryPaymentTool(paymentTool);
console.log(`会計ツール: ${paymentTool} → primary: ${primaryTool} (API: ${toolApiAvailable})`);

// NG除外
const okResults = checkResult.results.filter((r: any) => r.overallStatus !== 'NG');
const okInvoices = okResults.map((r: any) => extracted.invoices.find((i: any) => i.id === r.invoiceId)).filter(Boolean);

console.log(`チェック結果: ${checkResult.results.length}件中 OK/WARN=${okInvoices.length}件, NG=${checkResult.results.length - okInvoices.length}件`);

interface Rec { bankCode: string; bankName: string; branchCode: string; branchName: string; accountType: string; accountNumber: string; recipientName: string; amount: number; vendorName: string; }
const records: Rec[] = [];

for (const inv of okInvoices) {
  const ba = inv.bankAccount;
  records.push({
    bankCode: lookupBankCode(ba.bankName),
    bankName: lookupBankKana(ba.bankName),
    branchCode: '000', branchName: ba.branchName.replace('支店', ''),
    accountType: ba.accountType === '普通' ? '1' : '2',
    accountNumber: ba.accountNumber,
    recipientName: ba.accountHolder,
    amount: inv.totalAmount,
    vendorName: inv.vendorName,
  });
}

for (const auto of checkResult.autoAdditions || []) {
  if (!auto.bankAccount) continue;
  const ba = auto.bankAccount;
  records.push({
    bankCode: lookupBankCode(ba.bankName || ''),
    bankName: lookupBankKana(ba.bankName || ''),
    branchCode: '000', branchName: (ba.branchName || '').replace('支店', ''),
    accountType: ba.accountType === '普通' ? '1' : '2',
    accountNumber: ba.accountNumber,
    recipientName: ba.accountHolder,
    amount: auto.totalAmount,
    vendorName: auto.vendorName,
  });
}

// #19: Skip records with incomplete bank info (empty bankCode or accountNumber)
const validRecords = records.filter(r => {
  if (r.bankCode === '0000' || !r.accountNumber) {
    console.warn(`  [SKIP] ${r.vendorName}: 振込先口座情報が不完全（銀行コード不明・口座番号なし）`);
    return false;
  }
  if (r.amount <= 0) {
    console.warn(`  [SKIP] ${r.vendorName}: 金額が0以下（¥${r.amount}）`);
    return false;
  }
  return true;
});

const totalAmount = validRecords.reduce((s, r) => s + r.amount, 0);

// #22: Don't generate FB if no valid records
if (validRecords.length === 0) {
  console.error('\n[ERROR] 振込可能なレコードが0件です。FBファイルは生成しません。');
  const summary = `# 振込サマリ\n\n生成: ${new Date().toISOString()}\n\n振込可能レコード: 0件\n全件が除外またはデータ不完全のためFB生成をスキップしました。\n`;
  fs.writeFileSync(path.join(workDir, '_payment-summary.md'), summary);
  process.exit(0);
}

console.log(`\n振込: ${validRecords.length}件 合計¥${totalAmount.toLocaleString()}`);

// Warn about placeholder branch codes
const branchWarnings: string[] = [];
for (const r of validRecords) {
  console.log(`  ${r.vendorName}: ¥${r.amount.toLocaleString()}`);
  if (r.branchCode === '000') {
    branchWarnings.push(r.vendorName);
  }
}
if (branchWarnings.length > 0) {
  console.warn(`\n[WARN] 以下の取引先の支店コードが未設定（000）です。FBアップロード前に手動で修正が必要:`);
  for (const v of branchWarnings) console.warn(`  - ${v}`);
}
if (sender.branchCode === '000') {
  console.warn(`[WARN] 振込元の支店コードも未設定（000）です。リファレンスの振込元口座情報を補完してください。`);
}

// FB生成
function padRight(str: string, len: number): string {
  const buf = iconv.encode(str, 'Shift_JIS');
  if (buf.length >= len) return iconv.decode(buf.subarray(0, len), 'Shift_JIS');
  return iconv.decode(Buffer.concat([buf, Buffer.alloc(len - buf.length, 0x20)]), 'Shift_JIS');
}
function padLeft(str: string, len: number): string { return str.padStart(len, '0'); }

const lines: string[] = [];
// Header
let h = '1' + '21' + padLeft(sender.code, 10) + padRight(sender.name, 40) + sender.paymentDate + padLeft(sender.bankCode, 4) + padRight(sender.bankKana, 15) + padLeft(sender.branchCode, 3) + padRight(sender.branchKana, 15) + sender.accountType + padLeft(sender.accountNumber, 7);
const hB = iconv.encode(h, 'Shift_JIS');
if (hB.length > 120) {
  console.warn(`[WARN] ヘッダーレコードが${hB.length}バイト（120バイト超）。切り詰めます。`);
}
lines.push(iconv.decode(Buffer.concat([hB.subarray(0, 120), Buffer.alloc(Math.max(0, 120 - hB.length), 0x20)]).subarray(0, 120), 'Shift_JIS'));

for (const r of validRecords) {
  // 新規コード: '0'=その他, '1'=第1回, '2'=変更(既存先)
  // 初回振込か既存かの判定はリファレンスの定期取引先リストと突合して決定
  const isKnownVendor = Object.keys(regularVendors || {}).includes(r.vendorName);
  const newCode = isKnownVendor ? '2' : '0';
  // 全銀協フォーマット データレコード (120バイト):
  // 区分(1) + 銀行コード(4) + 銀行名(15) + 支店コード(3) + 支店名(15) +
  // 手形交換所番号(4, スペース) + 預金種目(1) + 口座番号(7) + 受取人名(30) +
  // 振込金額(10) + 新規コード(1) + EDI情報(20) + 振込区分(1) + 予備(6) = 118 → パディングで120
  // 振込区分: '7'=テレ振込（電信）が一般的。銀行によっては ' ' も可。
  const transferType = '7';
  let d = '2' + padLeft(r.bankCode, 4) + padRight(r.bankName, 15) + padLeft(r.branchCode, 3) + padRight(r.branchName, 15) + '    ' + r.accountType + padLeft(r.accountNumber, 7) + padRight(r.recipientName, 30) + padLeft(String(r.amount), 10) + newCode + ' '.repeat(20) + transferType + ' '.repeat(6);
  const dB = iconv.encode(d, 'Shift_JIS');
  lines.push(iconv.decode(Buffer.concat([dB.subarray(0, 120), Buffer.alloc(Math.max(0, 120 - dB.length), 0x20)]).subarray(0, 120), 'Shift_JIS'));
}

let t = '8' + padLeft(String(validRecords.length), 6) + padLeft(String(totalAmount), 12);
const tB = iconv.encode(t, 'Shift_JIS');
lines.push(iconv.decode(Buffer.concat([tB, Buffer.alloc(Math.max(0, 120 - tB.length), 0x20)]), 'Shift_JIS'));

const eB = Buffer.alloc(120, 0x20); eB[0] = 0x39;
lines.push(iconv.decode(eB, 'Shift_JIS'));

const fbPath = path.join(workDir, '_payment.fb.txt');
fs.writeFileSync(fbPath, iconv.encode(lines.join('\r\n'), 'Shift_JIS'));
console.log(`\nFB: ${fbPath}`);

// Summary
const excluded = checkResult.results.filter((r: any) => r.overallStatus === 'NG');

// Tool-specific instructions for accounting system integration
const TOOL_INSTRUCTIONS: Record<string, { name: string; apiReady: boolean; apiStatus: string; manualSteps: string }> = {
  'bakuraku': {
    name: 'バクラク債権・債務管理',
    apiReady: true,
    apiStatus: 'API連携可能（支払申請作成）',
    manualSteps: [
      '1. バクラク (https://invoice.layerx.jp) にログイン',
      '2. 「仕訳・支払」→「処理中」画面を開く',
      '3. 各請求書のPDFをアップロードし、支払申請を作成',
      '4. 承認フローに従い承認',
      '5. 「振込データ出力」から総合振込データをダウンロード',
      '   ※ 生成済みの _payment.fb.txt を使用する場合はこのステップ不要',
    ].join('\n'),
  },
  'mf-shiharai': {
    name: 'マネーフォワード債務支払',
    apiReady: false,
    apiStatus: 'API未成熟（手動操作）',
    manualSteps: [
      '1. MF債務支払 にログイン',
      '2. 「申請」→「支払依頼」→「新規申請」',
      '3. 請求書PDFを一括アップロード',
      '4. 各請求書の支払情報（金額・振込先・期日）を確認',
      '5. 承認フローに従い承認',
      '6. 「振込データ作成」から総合振込データをダウンロード',
      '   ※ 生成済みの _payment.fb.txt を使用する場合はこのステップ不要',
    ].join('\n'),
  },
  'freee': {
    name: 'freee会計',
    apiReady: false, // API連携可能だが未実装
    apiStatus: 'API連携可能（取引登録・振込データ）※未実装',
    manualSteps: [
      '1. freee会計にログイン',
      '2. 「取引」→「取引の一覧・登録」で各請求書を登録',
      '   - 取引先マスタに振込先口座が登録されていることを確認',
      '3. 「支払管理レポート」で合計金額・件数を確認',
      '4. 「振込データの作成」→ CSV/全銀フォーマットでエクスポート',
      '   ※ 生成済みの _payment.fb.txt を使用する場合はこのステップ不要',
    ].join('\n'),
  },
  'mf-kaikei': {
    apiReady: false,
    name: 'マネーフォワード会計',
    apiStatus: 'API未成熟（CSVインポート）',
    manualSteps: [
      '1. MF会計にログイン',
      '2. 「仕訳帳」→「インポート」→「仕訳帳」',
      '3. 費用計上CSVをインポート',
      '4. 振込は _payment.fb.txt を銀行IBにアップロードして実行',
    ].join('\n'),
  },
  'yayoi': {
    apiReady: false,
    name: '弥生会計',
    apiStatus: '手動操作のみ',
    manualSteps: [
      '1. 弥生会計を開く',
      '2. 「振替伝票」で各請求書の仕訳を入力',
      '3. 振込は _payment.fb.txt を銀行IBにアップロードして実行',
    ].join('\n'),
  },
  'bugyo': {
    apiReady: false,
    name: '勘定奉行 / 商蔵奉行',
    apiStatus: '手動操作のみ',
    manualSteps: [
      '1. 奉行シリーズを開く',
      '2. 「支払管理」で支払データを登録',
      '3. 振込は _payment.fb.txt を銀行IBにアップロードして実行',
    ].join('\n'),
  },
  'ics': {
    apiReady: false,
    name: 'ICS会計',
    apiStatus: '手動操作のみ',
    manualSteps: [
      '1. ICS会計システムにログイン',
      '2. 仕訳データを手動入力',
      '3. 振込は _payment.fb.txt を銀行IBにアップロードして実行',
    ].join('\n'),
  },
  'tkc': {
    apiReady: false,
    name: 'TKC会計',
    apiStatus: '手動操作のみ',
    manualSteps: [
      '1. TKCシステムにログイン',
      '2. 仕訳データを手動入力',
      '3. 振込は _payment.fb.txt を銀行IBにアップロードして実行',
    ].join('\n'),
  },
  'pca': {
    apiReady: false,
    name: 'PCA会計',
    apiStatus: '手動操作のみ',
    manualSteps: [
      '1. PCA会計を開く',
      '2. 仕訳データを手動入力',
      '3. 振込は _payment.fb.txt を銀行IBにアップロードして実行',
    ].join('\n'),
  },
  'unknown': {
    apiReady: false,
    name: '会計ツール未特定',
    apiStatus: '手動操作',
    manualSteps: [
      '会計ツールが特定できませんでした。',
      'リファレンスの Section 0「会計ツール」を更新してください。',
      '振込は _payment.fb.txt を銀行IBにアップロードして実行してください。',
    ].join('\n'),
  },
};

const toolInfo = TOOL_INSTRUCTIONS[primaryTool] || TOOL_INSTRUCTIONS['unknown'];

// If reference has custom manual instructions, use those instead
const instructions = toolManualInstructions || toolInfo.manualSteps;

const summary = [
  `# 振込サマリ`,
  ``,
  `生成: ${new Date().toISOString()}`,
  `会計ツール: ${toolInfo.name} (${toolInfo.apiStatus})`,
  ``,
  `| # | 取引先 | 金額 |`,
  `|---|--------|------|`,
  ...validRecords.map((r, i) => `| ${i + 1} | ${r.vendorName} | ¥${r.amount.toLocaleString()} |`),
  ``,
  `合計: ${validRecords.length}件 ¥${totalAmount.toLocaleString()}`,
  ``,
  `## 会計ツール連携手順（${toolInfo.name}）`,
  ``,
  instructions,
  ``,
  `## 除外`,
  excluded.map((r: any) => `- ${r.invoiceId} ${r.vendorName} ¥${r.totalAmount?.toLocaleString()} — ${r.checks?.find((c: any) => c.status === 'NG')?.message}`).join('\n') || 'なし',
  ``,
].join('\n');

fs.writeFileSync(path.join(workDir, '_payment-summary.md'), summary);

// Output tool integration info as JSON for SKILL.md to use
// apiAvailable = reference says true AND this tool's implementation is ready
const integrationInfo = {
  primaryTool,
  toolName: toolInfo.name,
  apiAvailable: toolInfo.apiReady && toolApiAvailable,
  apiStatus: toolInfo.apiStatus,
};
fs.writeFileSync(path.join(workDir, '_tool-integration.json'), JSON.stringify(integrationInfo, null, 2));
