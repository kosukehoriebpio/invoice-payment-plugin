/**
 * Step 3: 内容チェック
 * _extracted.json を読み込み、リファレンスのルールに基づいてチェックを実行
 *
 * Usage: npx tsx plugins/invoice-payment/scripts/check.ts <workDir> <referenceFile>
 */

import fs from 'fs';
import path from 'path';

const workDir = process.argv[2];
const refFile = process.argv[3];

if (!workDir) {
  console.error('Usage: npx tsx check.ts <workDir> <referenceFile>');
  process.exit(1);
}

// --- リファレンスパーサー（汎用） ---

/** マークダウンテーブルの行をパースして列の配列にする */
function parseTableRows(content: string, sectionHeader: string): string[][] {
  // セクションヘッダーからセクション末尾（次の##または---）まで抽出
  const pattern = new RegExp(sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?(?=\\n##|\\n---|$)', 'm');
  const match = content.match(pattern);
  if (!match) return [];

  const rows: string[][] = [];
  const lines = match[0].split('\n');
  let headerSkipped = false;

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('---')) continue; // セパレータ行

    const cols = line.split('|').slice(1, -1).map(c => c.trim());

    // 最初のテーブル行はヘッダーなのでスキップ
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }

    if (cols.length > 0 && cols[0]) {
      rows.push(cols);
    }
  }

  return rows;
}

/** リファレンスファイルから金額を抽出（¥やカンマを除去） */
function parseAmount(str: string): number | null {
  const m = str.replace(/[¥,\s]/g, '').match(/\d+/);
  return m ? parseInt(m[0]) : null;
}

function parseReference(refPath: string) {
  const regularVendors: Record<string, { normalAmount: number; tolerance: number | 'exact' }> = {};
  const withholdingVendors: string[] = [];
  let highAmountThreshold = 500000;
  const autoAdditions: any[] = [];

  if (!refPath || !fs.existsSync(refPath)) return { regularVendors, withholdingVendors, highAmountThreshold, autoAdditions };

  const content = fs.readFileSync(refPath, 'utf-8');

  // 定期取引先テーブル
  const vendorRows = parseTableRows(content, '### 定期取引先');
  for (const cols of vendorRows) {
    if (cols.length < 3) continue;
    const name = cols[0];
    const amount = parseAmount(cols[1]);
    const toleranceStr = cols[2];
    if (!amount) continue;

    const tolerance = toleranceStr.includes('完全一致') || toleranceStr.includes('exact')
      ? 'exact' as const
      : (() => {
          const m = toleranceStr.match(/±?(\d+)/);
          return m ? parseInt(m[1]) / 100 : 0.30;
        })();

    regularVendors[name] = { normalAmount: amount, tolerance };
  }

  // 源泉徴収対象取引先
  const whMatch = content.match(/源泉徴収対象取引先:\s*\[(.*?)\]/);
  if (whMatch) {
    withholdingVendors.push(...whMatch[1].split(',').map(v => v.trim().replace(/"/g, '')).filter(Boolean));
  }

  // 高額アラート閾値
  const thresholdMatch = content.match(/高額アラート:\s*¥?([\d,]+)/);
  if (thresholdMatch) {
    highAmountThreshold = parseInt(thresholdMatch[1].replace(/,/g, ''));
  }

  // 請求書なし定期取引
  const autoRows = parseTableRows(content, '### 請求書なし定期取引');
  for (const cols of autoRows) {
    if (cols.length < 3) continue;
    const vendorName = cols[0];
    const amount = parseAmount(cols[1]);
    const bankInfo = cols[2];
    if (!amount) continue;

    const bankMatch = bankInfo.match(/(.+?)\s+(.+?)\s+(普通|当座)\s+(\d+)\s+(.+)/);
    autoAdditions.push({
      type: 'recurring_no_invoice',
      vendorName,
      totalAmount: amount,
      message: '請求書なし定期取引。リファレンスに基づき振込データに自動追加。',
      bankAccount: bankMatch ? {
        bankName: bankMatch[1], branchName: bankMatch[2],
        accountType: bankMatch[3], accountNumber: bankMatch[4], accountHolder: bankMatch[5],
      } : null,
    });
  }

  return { regularVendors, withholdingVendors, highAmountThreshold, autoAdditions };
}

// --- メイン処理 ---

const extractedPath = path.join(workDir, '_extracted.json');
if (!fs.existsSync(extractedPath)) {
  console.error(`_extracted.json not found in ${workDir}`);
  process.exit(1);
}

const { regularVendors, withholdingVendors, highAmountThreshold, autoAdditions } = parseReference(refFile);
const extracted = JSON.parse(fs.readFileSync(extractedPath, 'utf-8'));
const invoices: any[] = Array.isArray(extracted.invoices) ? extracted.invoices : [];
if (invoices.length === 0) {
  console.error('_extracted.json に請求書データがありません');
  process.exit(1);
}

interface Check { checkType: string; status: 'OK' | 'WARN' | 'NG' | 'INFO'; message: string; }
interface Result { invoiceId: string; vendorName: string; totalAmount: number; overallStatus: 'OK' | 'WARN' | 'NG'; checks: Check[]; }

const results: Result[] = [];

for (const inv of invoices) {
  const checks: Check[] = [];
  let overallStatus: 'OK' | 'WARN' | 'NG' = 'OK';

  // 1. 二重請求チェック
  // invoiceNumber が空の場合は請求書番号での突合をスキップし、
  // vendorName + totalAmount + invoiceDate の組み合わせで判定する
  const dupes = invoices.filter(o => {
    if (o.id === inv.id) return false;
    if (o.vendorName !== inv.vendorName || o.totalAmount !== inv.totalAmount) return false;
    // Both have invoiceNumber → must match
    if (inv.invoiceNumber && o.invoiceNumber) return o.invoiceNumber === inv.invoiceNumber;
    // invoiceNumber unavailable → fall back to date match
    if (inv.invoiceDate && o.invoiceDate) return o.invoiceDate === inv.invoiceDate;
    // No reliable secondary key → don't flag as duplicate
    return false;
  });
  if (dupes.length > 0) {
    checks.push({ checkType: 'duplicate', status: 'NG', message: `二重請求: ${dupes.map(d => d.id).join(',')}と同一（${inv.invoiceNumber || inv.invoiceDate || '番号不明'}）` });
    overallStatus = 'NG';
  } else {
    checks.push({ checkType: 'duplicate', status: 'OK', message: '二重請求なし' });
  }

  // 2. 金額妥当性チェック
  const reg = regularVendors[inv.vendorName];
  if (reg) {
    if (reg.tolerance === 'exact') {
      if (inv.totalAmount === reg.normalAmount) {
        checks.push({ checkType: 'amount_range', status: 'OK', message: `固定額¥${reg.normalAmount.toLocaleString()}と一致` });
      } else {
        checks.push({ checkType: 'amount_range', status: 'WARN', message: `固定額¥${reg.normalAmount.toLocaleString()}と不一致（¥${inv.totalAmount.toLocaleString()}）` });
        if (overallStatus === 'OK') overallStatus = 'WARN';
      }
    } else if (reg.normalAmount > 0) {
      const diff = Math.abs(inv.totalAmount - reg.normalAmount) / reg.normalAmount;
      if (diff <= reg.tolerance) {
        checks.push({ checkType: 'amount_range', status: 'OK', message: `通常¥${reg.normalAmount.toLocaleString()}の±${reg.tolerance * 100}%内（${(diff * 100).toFixed(1)}%）` });
      } else {
        checks.push({ checkType: 'amount_range', status: 'WARN', message: `通常¥${reg.normalAmount.toLocaleString()}から${(diff * 100).toFixed(1)}%乖離` });
        if (overallStatus === 'OK') overallStatus = 'WARN';
      }
    }
  }

  // 3. 取引先マスタ照合
  if (regularVendors[inv.vendorName]) {
    checks.push({ checkType: 'vendor_master', status: 'OK', message: '登録済み取引先' });
  } else {
    checks.push({ checkType: 'vendor_master', status: 'WARN', message: '未登録取引先' });
    if (overallStatus === 'OK') overallStatus = 'WARN';
  }

  // 4. 支払期日チェック
  if (!inv.dueDate) {
    checks.push({ checkType: 'due_date', status: 'WARN', message: '支払期日が未記載' });
    if (overallStatus === 'OK') overallStatus = 'WARN';
  } else {
    const today = new Date();
    const due = new Date(inv.dueDate);
    if (isNaN(due.getTime())) {
      checks.push({ checkType: 'due_date', status: 'WARN', message: `支払期日の形式不正: ${inv.dueDate}` });
      if (overallStatus === 'OK') overallStatus = 'WARN';
    } else if (due < today) {
      checks.push({ checkType: 'due_date', status: 'WARN', message: `期日超過: ${inv.dueDate}` });
      if (overallStatus === 'OK') overallStatus = 'WARN';
    } else {
      checks.push({ checkType: 'due_date', status: 'OK', message: `期日 ${inv.dueDate}` });
    }
  }

  // 5. 高額アラート
  if (inv.totalAmount >= highAmountThreshold) {
    checks.push({ checkType: 'high_amount', status: 'INFO', message: `高額: ¥${inv.totalAmount.toLocaleString()}` });
  }

  // 6. 源泉徴収チェック
  if (withholdingVendors.includes(inv.vendorName)) {
    if (inv.withholdingTax != null && inv.withholdingTax > 0) {
      // 100万以下: 10.21%, 100万超: 超過分に20.42%
      const base = inv.subtotal;
      let expected: number;
      if (base <= 1_000_000) {
        expected = Math.floor(base * 0.1021);
      } else {
        expected = Math.floor(1_000_000 * 0.1021 + (base - 1_000_000) * 0.2042);
      }
      if (Math.abs(inv.withholdingTax - expected) <= 1) {
        checks.push({ checkType: 'withholding_tax', status: 'OK', message: `源泉¥${inv.withholdingTax.toLocaleString()} OK` });
      } else {
        checks.push({ checkType: 'withholding_tax', status: 'WARN', message: `源泉不一致: ¥${inv.withholdingTax.toLocaleString()} vs 計算¥${expected.toLocaleString()}` });
        if (overallStatus === 'OK') overallStatus = 'WARN';
      }
    } else {
      checks.push({ checkType: 'withholding_tax', status: 'WARN', message: '源泉対象だが未記載' });
      if (overallStatus === 'OK') overallStatus = 'WARN';
    }
  }

  results.push({ invoiceId: inv.id, vendorName: inv.vendorName, totalAmount: inv.totalAmount, overallStatus, checks });
}

// 出力
const output = {
  checkedAt: new Date().toISOString(),
  summary: { total: results.length, ok: results.filter(r => r.overallStatus === 'OK').length, warn: results.filter(r => r.overallStatus === 'WARN').length, ng: results.filter(r => r.overallStatus === 'NG').length },
  results,
  autoAdditions,
};

fs.writeFileSync(path.join(workDir, '_check-result.json'), JSON.stringify(output, null, 2));

// レポート
console.log(`\n=== チェック結果 === (${output.summary.ok} OK / ${output.summary.warn} WARN / ${output.summary.ng} NG)`);
for (const r of results) {
  const icon = r.overallStatus === 'OK' ? '[OK]  ' : r.overallStatus === 'WARN' ? '[WARN]' : '[NG]  ';
  console.log(`${icon} ${r.invoiceId} ${r.vendorName} ¥${r.totalAmount.toLocaleString()}`);
  for (const c of r.checks) { if (c.status !== 'OK') console.log(`       ${c.status}: ${c.message}`); }
}
if (autoAdditions.length > 0) {
  console.log('\n--- 自動追加 ---');
  for (const a of autoAdditions) console.log(`[AUTO] ${a.vendorName} ¥${a.totalAmount.toLocaleString()}`);
}
