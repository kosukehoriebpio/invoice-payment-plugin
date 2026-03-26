/**
 * Step 6: 消込確認
 * モックAPI（or 実API）の振込結果と_check-result.json/_extracted.jsonを突合
 *
 * Usage: npx tsx plugins/invoice-payment/scripts/reconcile.ts <workDir> <apiUrl>
 */

import fs from 'fs';
import path from 'path';

const workDir = process.argv[2];
const apiUrl = process.argv[3];

if (!workDir || !apiUrl) {
  console.error('Usage: npx tsx reconcile.ts <workDir> <apiUrl>');
  console.error('  apiUrl is required (no default — specify explicitly)');
  process.exit(1);
}

// Only allow http(s) URLs
if (!/^https?:\/\//i.test(apiUrl)) {
  console.error(`Security: apiUrl must be http(s). Got: ${apiUrl}`);
  process.exit(1);
}

interface Transfer { id: string; recipientName: string; amount: number; status: string; createdAt: string; completedAt?: string; }

async function main() {
  const checkResult = JSON.parse(fs.readFileSync(path.join(workDir, '_check-result.json'), 'utf-8'));
  const extracted = JSON.parse(fs.readFileSync(path.join(workDir, '_extracted.json'), 'utf-8'));

  const okResults = checkResult.results.filter((r: any) => r.overallStatus !== 'NG');
  const okInvoices = okResults.map((r: any) => {
    const inv = extracted.invoices.find((i: any) => i.id === r.invoiceId);
    return { ...r, bankAccount: inv?.bankAccount, withholdingTax: inv?.withholdingTax };
  });

  // API取得
  const res = await fetch(`${apiUrl}/api/transfers`);
  if (!res.ok) { console.error(`API error: ${res.status}`); process.exit(1); }
  const { transfers }: { transfers: Transfer[] } = await res.json() as any;

  console.log(`\n=== 消込確認 ===\n振込結果: ${transfers.length}件 | 照合対象: ${okInvoices.length}件 + ${(checkResult.autoAdditions || []).length}件自動追加\n`);

  const matched = new Set<string>();
  const results: any[] = [];

  // Normalize name for fuzzy matching (strip spaces, lowercase kana)
  function normName(s: string): string {
    return (s || '').replace(/[\s　\(\)（）]/g, '').toLowerCase();
  }

  for (const inv of okInvoices) {
    // Match by amount + recipient name (fuzzy)
    const invName = normName(inv.vendorName);
    const match = transfers.find((t: Transfer) => {
      if (matched.has(t.id)) return false;
      if (t.amount !== inv.totalAmount) return false;
      // If recipient name is available, verify it matches
      if (t.recipientName && invName) {
        const tName = normName(t.recipientName);
        // Either contains the other (handles カ）エーショクヒンオロシ vs 株式会社A食品卸)
        return tName.includes(invName) || invName.includes(tName) || tName === invName;
      }
      // If no name on transfer, fall back to amount-only match
      return true;
    });
    if (match) {
      matched.add(match.id);
      results.push({ invoiceId: inv.invoiceId, vendorName: inv.vendorName, invoiceAmount: inv.totalAmount, transferId: match.id, transferAmount: match.amount, transferStatus: match.status, reconcileStatus: match.status === 'completed' ? 'OK' : 'WARN', message: match.status === 'completed' ? '消込OK' : `振込${match.status}` });
    } else {
      results.push({ invoiceId: inv.invoiceId, vendorName: inv.vendorName, invoiceAmount: inv.totalAmount, transferId: null, transferAmount: null, transferStatus: null, reconcileStatus: 'UNMATCHED', message: '対応振込なし' });
    }
  }

  for (const auto of checkResult.autoAdditions || []) {
    const match = transfers.find((t: Transfer) => t.amount === auto.totalAmount && !matched.has(t.id));
    if (match) {
      matched.add(match.id);
      results.push({ invoiceId: `auto-${auto.vendorName}`, vendorName: auto.vendorName, invoiceAmount: auto.totalAmount, transferId: match.id, transferAmount: match.amount, transferStatus: match.status, reconcileStatus: match.status === 'completed' ? 'OK' : 'WARN', message: match.status === 'completed' ? '消込OK（定期）' : `振込${match.status}` });
    } else {
      results.push({ invoiceId: `auto-${auto.vendorName}`, vendorName: auto.vendorName, invoiceAmount: auto.totalAmount, transferId: null, reconcileStatus: 'UNMATCHED', message: '対応振込なし（定期）' });
    }
  }

  const unmatchedTransfers = transfers.filter(t => !matched.has(t.id));
  const excluded = checkResult.results.filter((r: any) => r.overallStatus === 'NG').map((r: any) => ({ invoiceId: r.invoiceId, vendorName: r.vendorName, amount: r.totalAmount, reason: r.checks.find((c: any) => c.status === 'NG')?.message || 'NG' }));

  const output = { reconciledAt: new Date().toISOString(), summary: { total: results.length, matched: results.filter(r => r.reconcileStatus === 'OK').length, warn: results.filter(r => r.reconcileStatus === 'WARN').length, unmatched: results.filter(r => r.reconcileStatus === 'UNMATCHED').length, unmatchedTransfers: unmatchedTransfers.length }, results, unmatchedTransfers: unmatchedTransfers.map(t => ({ transferId: t.id, recipientName: t.recipientName, amount: t.amount, status: t.status })), excluded };

  fs.writeFileSync(path.join(workDir, '_reconcile-result.json'), JSON.stringify(output, null, 2));

  // レポート
  for (const r of results) {
    const icon = r.reconcileStatus === 'OK' ? '[OK]      ' : r.reconcileStatus === 'WARN' ? '[WARN]    ' : '[UNMATCHED]';
    console.log(`${icon} ${r.vendorName.padEnd(20)} ¥${r.invoiceAmount.toLocaleString().padStart(10)} → ${r.message}`);
  }
  if (unmatchedTransfers.length > 0) { console.log('\n--- 未照合振込 ---'); for (const t of unmatchedTransfers) console.log(`[???] ${t.recipientName.padEnd(20)} ¥${t.amount.toLocaleString().padStart(10)}`); }
  if (excluded.length > 0) { console.log('\n--- 除外 ---'); for (const e of excluded) console.log(`[除外] ${e.vendorName.padEnd(20)} ¥${e.amount.toLocaleString().padStart(10)}`); }
  console.log(`\n=== ${output.summary.matched}/${output.summary.total}件 消込完了 ===`);
}

main();
