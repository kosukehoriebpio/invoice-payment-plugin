/**
 * Step 4: 振込データ作成（FBファイル生成）
 * _check-result.json + _extracted.json を読み込み、NG除外してFBファイルを生成
 *
 * Usage: npx tsx plugins/invoice-payment/scripts/generate-fb.ts <workDir> <referenceFile>
 */

import iconv from 'iconv-lite';
import fs from 'fs';
import path from 'path';

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
const pluginRoot = path.resolve(__dirname, '..');
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

// Parse regular vendors from reference (for #24 new code determination)
const regularVendors: Record<string, boolean> = {};
if (refFile && fs.existsSync(refFile)) {
  const refContent = fs.readFileSync(refFile, 'utf-8');
  const vendorSection = refContent.match(/### 定期取引先[\s\S]*?(?=\n##|\n---)/m);
  if (vendorSection) {
    for (const line of vendorSection[0].split('\n')) {
      if (!line.startsWith('|') || line.includes('---')) continue;
      const cols = line.split('|').slice(1, -1).map(c => c.trim());
      if (cols[0] && !cols[0].includes('取引先')) regularVendors[cols[0]] = true;
    }
  }
}

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
lines.push(iconv.decode(Buffer.concat([hB, Buffer.alloc(Math.max(0, 120 - hB.length), 0x20)]), 'Shift_JIS'));

for (const r of validRecords) {
  // 新規コード: '0'=その他, '1'=第1回, '2'=変更(既存先)
  // 初回振込か既存かの判定はリファレンスの定期取引先リストと突合して決定
  const isKnownVendor = Object.keys(regularVendors || {}).includes(r.vendorName);
  const newCode = isKnownVendor ? '2' : '0';
  let d = '2' + padLeft(r.bankCode, 4) + padRight(r.bankName, 15) + padLeft(r.branchCode, 3) + padRight(r.branchName, 15) + '    ' + r.accountType + padLeft(r.accountNumber, 7) + padRight(r.recipientName, 30) + padLeft(String(r.amount), 10) + newCode + ' '.repeat(40);
  const dB = iconv.encode(d, 'Shift_JIS');
  lines.push(iconv.decode(Buffer.concat([dB, Buffer.alloc(Math.max(0, 120 - dB.length), 0x20)]), 'Shift_JIS'));
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
const summary = `# 振込サマリ\n\n生成: ${new Date().toISOString()}\n\n| # | 取引先 | 金額 |\n|---|--------|------|\n${validRecords.map((r, i) => `| ${i + 1} | ${r.vendorName} | ¥${r.amount.toLocaleString()} |`).join('\n')}\n\n合計: ${validRecords.length}件 ¥${totalAmount.toLocaleString()}\n\n## 除外\n${excluded.map((r: any) => `- ${r.invoiceId} ${r.vendorName} ¥${r.totalAmount.toLocaleString()} — ${r.checks.find((c: any) => c.status === 'NG')?.message}`).join('\n') || 'なし'}\n`;
fs.writeFileSync(path.join(workDir, '_payment-summary.md'), summary);
