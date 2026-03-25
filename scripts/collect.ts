/**
 * Step 1: 請求書収集
 * リファレンスの収集設定に基づき、Drive/ローカルから請求書PDFを収集し _manifest.json を生成
 *
 * Usage:
 *   npx tsx scripts/collect.ts <workDir> <referenceFile> [options]
 *
 * Options:
 *   --source drive:<folderId>   Google Drive フォルダから取得
 *   --source local              WORK_DIR/invoices/ を手動配置前提でスキャン
 *   --source auto               リファレンスの設定から自動判定（デフォルト）
 *   --period <YYYY-MM>          対象年月（デフォルト: 当月）
 *
 * リファレンスの source フォーマット例:
 *   "Google Drive フォルダID: 15PaMhjpiPdFVqTRaEJD5mHKpibDL4nRQ"
 *   "バクラク債権・債務管理（https://invoice.layerx.jp/invoices）"
 *   ""（空 = manual）
 */

import fs from 'fs';
import path from 'path';

// ============================================================
// Types
// ============================================================

interface ManifestEntry {
  file: string;
  originalName: string;
  source: 'drive' | 'local' | 'bakuraku';
  downloadedAt: string;
  status: 'pending';
}

interface Manifest {
  collectedAt: string;
  period: string;
  method: 'auto' | 'manual' | 'hybrid';
  source: string;
  totalCount: number;
  invoices: ManifestEntry[];
}

interface CollectArgs {
  workDir: string;
  refFile: string;
  sourceOverride: string | null; // "drive:<id>", "local", "auto"
  period: string;                // YYYY-MM
}

// ============================================================
// Argument Parsing
// ============================================================

function parseArgs(): CollectArgs {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: npx tsx collect.ts <workDir> <referenceFile> [--source drive:<id>|local|auto] [--period YYYY-MM]');
    process.exit(1);
  }

  const result: CollectArgs = {
    workDir: args[0],
    refFile: args[1],
    sourceOverride: null,
    period: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`,
  };

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--source') result.sourceOverride = args[++i];
    if (args[i] === '--period') result.period = args[++i];
  }

  return result;
}

// ============================================================
// Reference Parsing
// ============================================================

interface CollectionConfig {
  method: 'auto' | 'manual' | 'hybrid';
  source: string;
  driveFolderId: string | null;
  bakurakuUrl: string | null;
}

function parseReference(refPath: string): CollectionConfig {
  const config: CollectionConfig = {
    method: 'manual',
    source: '',
    driveFolderId: null,
    bakurakuUrl: null,
  };

  if (!fs.existsSync(refPath)) return config;
  const content = fs.readFileSync(refPath, 'utf-8');

  // Parse method
  const methodMatch = content.match(/- method:\s*(auto|manual|hybrid)/);
  if (methodMatch) config.method = methodMatch[1] as any;

  // Parse source
  const sourceMatch = content.match(/- source:\s*"(.+?)"/);
  if (sourceMatch) config.source = sourceMatch[1];

  // Extract Drive folder ID from source
  const driveIdMatch = config.source.match(/(?:folders\/|フォルダID:\s*)([a-zA-Z0-9_-]{20,})/);
  if (driveIdMatch) config.driveFolderId = driveIdMatch[1];

  // Detect Bakuraku
  if (/バクラク|bakuraku|layerx/i.test(config.source)) {
    config.bakurakuUrl = 'https://invoice.layerx.jp/invoices';
  }

  return config;
}

// ============================================================
// Google Drive Collection
// ============================================================

async function loadGoogleAuth() {
  // Dynamic import to avoid hard dependency — only needed for Drive mode
  const { google } = await import('googleapis');
  const authModule = await import('../../integrations/lib/auth');
  const auth = await authModule.getAuthClient();
  return google.drive({ version: 'v3', auth });
}

async function collectFromDrive(folderId: string, invoicesDir: string, period: string): Promise<ManifestEntry[]> {
  console.error(`  Drive folder: ${folderId}`);
  console.error(`  Period: ${period}`);

  const drive = await loadGoogleAuth();

  // List files in the folder (PDFs and images only)
  const mimeTypes = [
    'application/pdf',
    'image/png',
    'image/jpeg',
  ];
  const query = `'${folderId}' in parents and trashed = false and (${mimeTypes.map(m => `mimeType='${m}'`).join(' or ')})`;

  const entries: ManifestEntry[] = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: query,
      fields: 'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime)',
      pageSize: 100,
      pageToken,
      orderBy: 'createdTime desc',
    });

    const files = res.data.files || [];
    console.error(`  Found ${files.length} files`);

    for (const file of files) {
      if (!file.id || !file.name) continue;

      // Filter by period if the file name or date matches
      // (relaxed: download all, let the user filter later)
      const safeName = file.name.replace(/[<>:"/\\|?*]/g, '_');
      const destPath = path.join(invoicesDir, safeName);

      // Download
      try {
        const resp = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        fs.writeFileSync(destPath, Buffer.from(resp.data as ArrayBuffer));

        entries.push({
          file: `invoices/${safeName}`,
          originalName: file.name,
          source: 'drive',
          downloadedAt: new Date().toISOString(),
          status: 'pending',
        });
        console.error(`  ✓ ${safeName}`);
      } catch (err: any) {
        console.error(`  ✗ ${file.name}: ${err.message}`);
      }
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return entries;
}

// ============================================================
// Local Scan (manual mode)
// ============================================================

function scanLocalInvoices(invoicesDir: string): ManifestEntry[] {
  if (!fs.existsSync(invoicesDir)) return [];

  const entries: ManifestEntry[] = [];
  const exts = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif']);

  for (const file of fs.readdirSync(invoicesDir)) {
    const ext = path.extname(file).toLowerCase();
    if (!exts.has(ext)) continue;
    if (file.startsWith('.') || file.startsWith('_')) continue;

    entries.push({
      file: `invoices/${file}`,
      originalName: file,
      source: 'local',
      downloadedAt: new Date().toISOString(),
      status: 'pending',
    });
  }

  return entries;
}

// ============================================================
// Subfolder Scan for Drive (check year-month subfolders)
// ============================================================

async function findPeriodSubfolder(folderId: string, period: string): Promise<string | null> {
  try {
    const drive = await loadGoogleAuth();
    // Look for subfolders matching period (e.g., "2026-03", "202603", "3月", "2026年3月")
    const [year, month] = period.split('-');
    const monthNum = parseInt(month);
    const searchTerms = [
      period,
      `${year}${month}`,
      `${monthNum}月`,
      `${year}年${monthNum}月`,
    ];

    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 50,
    });

    for (const folder of res.data.files || []) {
      if (!folder.name || !folder.id) continue;
      for (const term of searchTerms) {
        if (folder.name.includes(term)) {
          console.error(`  Found period subfolder: ${folder.name} (${folder.id})`);
          return folder.id;
        }
      }
    }
  } catch {
    // If Drive auth fails, just return null
  }
  return null;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs();
  const config = parseReference(args.refFile);

  // Determine source
  let sourceMode: 'drive' | 'local' = 'local';
  let driveFolderId: string | null = null;

  if (args.sourceOverride) {
    if (args.sourceOverride.startsWith('drive:')) {
      sourceMode = 'drive';
      driveFolderId = args.sourceOverride.slice(6);
    } else if (args.sourceOverride === 'auto') {
      if (config.driveFolderId) {
        sourceMode = 'drive';
        driveFolderId = config.driveFolderId;
      }
    }
    // "local" → stay as local
  } else {
    // Auto-detect from reference
    if (config.driveFolderId) {
      sourceMode = 'drive';
      driveFolderId = config.driveFolderId;
    }
  }

  console.error('=== collect.ts ===');
  console.error(`Work dir: ${args.workDir}`);
  console.error(`Reference: ${args.refFile}`);
  console.error(`Period: ${args.period}`);
  console.error(`Source: ${sourceMode}${driveFolderId ? ` (folder: ${driveFolderId})` : ''}`);
  console.error('');

  // Ensure directories
  const invoicesDir = path.join(args.workDir, 'invoices');
  fs.mkdirSync(invoicesDir, { recursive: true });

  let entries: ManifestEntry[] = [];

  if (sourceMode === 'drive' && driveFolderId) {
    console.error('[1/2] Collecting from Google Drive...');

    // Check for period-specific subfolder first
    const periodFolder = await findPeriodSubfolder(driveFolderId, args.period);
    const targetFolder = periodFolder || driveFolderId;

    const driveEntries = await collectFromDrive(targetFolder, invoicesDir, args.period);
    entries.push(...driveEntries);

    // Also scan for any manually added local files
    console.error('[2/2] Scanning local files...');
    const localEntries = scanLocalInvoices(invoicesDir).filter(
      e => !entries.some(d => d.file === e.file)
    );
    entries.push(...localEntries);
    if (localEntries.length > 0) {
      console.error(`  ${localEntries.length} additional local files found`);
    }
  } else {
    console.error('[1/1] Scanning local invoices...');
    entries = scanLocalInvoices(invoicesDir);

    if (entries.length === 0) {
      console.error(`\n  No invoices found in ${invoicesDir}`);
      console.error(`  Please place PDF/image files there and re-run.`);

      if (config.driveFolderId) {
        console.error(`\n  Tip: This client has a Drive folder configured.`);
        console.error(`  Run with --source auto to download from Drive:`);
        console.error(`    npx tsx collect.ts ${args.workDir} ${args.refFile} --source auto`);
      }
      if (config.bakurakuUrl) {
        console.error(`\n  Tip: This client uses Bakuraku.`);
        console.error(`  Export invoices from: ${config.bakurakuUrl}`);
      }
    }
  }

  // Generate manifest
  const manifest: Manifest = {
    collectedAt: new Date().toISOString(),
    period: args.period,
    method: entries.some(e => e.source === 'drive') ? 'auto' : 'manual',
    source: sourceMode === 'drive' ? `drive:${driveFolderId}` : 'local',
    totalCount: entries.length,
    invoices: entries,
  };

  const manifestPath = path.join(args.workDir, '_manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // Summary
  console.error('');
  console.error('=== Summary ===');
  console.error(`  Invoices: ${entries.length}`);
  if (entries.length > 0) {
    for (const e of entries) {
      console.error(`    [${e.source}] ${e.originalName}`);
    }
  }
  console.error(`  Manifest: ${manifestPath}`);

  // Output manifest path to stdout (for piping)
  console.log(manifestPath);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
