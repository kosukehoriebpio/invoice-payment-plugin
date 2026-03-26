/**
 * Step 1: 請求書収集
 * リファレンスの収集設定に基づき、Drive/ローカルから請求書PDFを収集し _manifest.json を生成
 *
 * Usage:
 *   npx tsx scripts/collect.ts <workDir> <referenceFile> [options]
 *
 * Options:
 *   --source drive:<folderId>   Google Drive フォルダから取得
 *   --source gmail:<query>      Gmail 添付PDF検索（例: gmail:"請求書 from:vendor@example.com"）
 *   --source bakuraku           バクラクAPIから処理中の請求書を取得
 *   --source local              WORK_DIR/invoices/ を手動配置前提でスキャン
 *   --source auto               リファレンスの設定から自動判定（デフォルト）
 *   --period <YYYY-MM>          対象年月（デフォルト: 当月）
 *   (BAKURAKU_TOKEN env)         バクラクAPIトークン（CLIオプションでの指定は不可 — セキュリティ上の理由）
 *
 * リファレンスの source フォーマット例:
 *   "Google Drive フォルダID: 15PaMhjpiPdFVqTRaEJD5mHKpibDL4nRQ"
 *   "Gmail keiri@example.com 件名に「請求書」を含むメール"
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
  source: 'drive' | 'gmail' | 'bakuraku' | 'local';
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
  sourceOverride: string | null; // "drive:<id>", "gmail:<query>", "bakuraku", "local", "auto"
  period: string;                // YYYY-MM
  bakurakuToken: string;
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
    bakurakuToken: process.env.BAKURAKU_TOKEN || '',
  };

  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--source') result.sourceOverride = args[++i];
    if (args[i] === '--period') result.period = args[++i];
    // --bakuraku-token removed: tokens must not appear in CLI args (visible via ps)
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
  gmailQuery: string | null;
  bakurakuUrl: string | null;
}

function parseReference(refPath: string): CollectionConfig {
  const config: CollectionConfig = {
    method: 'manual',
    source: '',
    driveFolderId: null,
    gmailQuery: null,
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

  // Detect Gmail source
  if (/Gmail|gmail|メール/i.test(config.source)) {
    // Extract email or build a default query
    const emailMatch = config.source.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+)/);
    config.gmailQuery = emailMatch
      ? `from:${emailMatch[1]} has:attachment filename:pdf`
      : 'subject:請求書 has:attachment filename:pdf';
  }

  // Detect Bakuraku
  if (/バクラク|bakuraku|layerx/i.test(config.source)) {
    config.bakurakuUrl = 'https://api.bakuraku.layerx.jp/rest/v1';
  }

  return config;
}

// ============================================================
// Google Drive Collection
// ============================================================

let _driveClient: any = null;

async function loadGoogleAuth() {
  // Cache the Drive client to avoid re-auth on repeated calls
  if (_driveClient) return _driveClient;
  const { google } = await import('googleapis');
  const authModule = await import('../../integrations/lib/auth');
  const auth = await authModule.getAuthClient();
  _driveClient = google.drive({ version: 'v3', auth });
  return _driveClient;
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
  // Sanitize folderId to prevent query injection (allow only alphanumeric, hyphen, underscore)
  const safeFolderId = folderId.replace(/[^a-zA-Z0-9_-]/g, '');
  if (safeFolderId !== folderId) {
    console.error(`  WARN: folderId sanitized: ${folderId} → ${safeFolderId}`);
  }
  const query = `'${safeFolderId}' in parents and trashed = false and (${mimeTypes.map(m => `mimeType='${m}'`).join(' or ')})`;

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

    const safeFid = folderId.replace(/[^a-zA-Z0-9_-]/g, '');
    const res = await drive.files.list({
      q: `'${safeFid}' in parents and mimeType='application/vnd.google-apps.folder' and trashed = false`,
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
// Gmail Collection
// ============================================================

let _gmailClient: any = null;

async function loadGmailClient() {
  if (_gmailClient) return _gmailClient;
  const { google } = await import('googleapis');
  const authModule = await import('../../integrations/lib/auth');
  const auth = await authModule.getAuthClient();
  _gmailClient = google.gmail({ version: 'v1', auth });
  return _gmailClient;
}

async function collectFromGmail(query: string, invoicesDir: string, period: string): Promise<ManifestEntry[]> {
  console.error(`  Gmail query: ${query}`);

  const gmail = await loadGmailClient();
  const entries: ManifestEntry[] = [];

  // Add date filter for the period
  const [year, month] = period.split('-');
  const afterDate = `${year}/${month}/01`;
  const nextMonth = parseInt(month) === 12 ? `${parseInt(year) + 1}/01/01` : `${year}/${String(parseInt(month) + 1).padStart(2, '0')}/01`;
  const fullQuery = `${query} after:${afterDate} before:${nextMonth}`;

  console.error(`  Full query: ${fullQuery}`);

  // Search messages
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: fullQuery,
    maxResults: 50,
  });

  const messages = listRes.data.messages || [];
  console.error(`  Found ${messages.length} messages`);

  // Process sequentially to respect Gmail API rate limits (250 quota units/sec)
  for (const msg of messages) {
    if (!msg.id) continue;

    // Get message with attachments
    const msgRes = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
    });

    const parts = msgRes.data.payload?.parts || [];
    for (const part of parts) {
      if (!part.filename || !part.body?.attachmentId) continue;

      // Only download PDFs and images
      const ext = path.extname(part.filename).toLowerCase();
      if (!['.pdf', '.png', '.jpg', '.jpeg'].includes(ext)) continue;

      try {
        const attRes = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: msg.id,
          id: part.body.attachmentId,
        });

        const data = attRes.data.data;
        if (!data) continue;

        // Decode base64url
        const buffer = Buffer.from(data, 'base64url');
        const safeName = part.filename.replace(/[<>:"/\\|?*]/g, '_');

        // Avoid duplicates by adding message ID prefix if needed
        const destName = fs.existsSync(path.join(invoicesDir, safeName))
          ? `${msg.id.slice(0, 8)}_${safeName}`
          : safeName;
        const destPath = path.join(invoicesDir, destName);

        fs.writeFileSync(destPath, buffer);

        entries.push({
          file: `invoices/${destName}`,
          originalName: part.filename,
          source: 'gmail',
          downloadedAt: new Date().toISOString(),
          status: 'pending',
        });
        console.error(`  ✓ ${destName} (${(buffer.length / 1024).toFixed(0)}KB)`);
      } catch (err: any) {
        console.error(`  ✗ ${part.filename}: ${err.message}`);
      }
    }
  }

  return entries;
}

// ============================================================
// Bakuraku Collection
// ============================================================

const BAKURAKU_API_BASE = 'https://api.bakuraku.layerx.jp/rest/v1';

async function collectFromBakuraku(token: string, invoicesDir: string, period: string): Promise<ManifestEntry[]> {
  console.error(`  Bakuraku API: fetching pending invoices`);

  const entries: ManifestEntry[] = [];

  // List workflow requests (pending/in-progress invoices)
  const listRes = await fetch(`${BAKURAKU_API_BASE}/workflow/requests?status=IN_PROGRESS&per_page=100`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });

  if (!listRes.ok) {
    const errText = await listRes.text();
    console.error(`  Bakuraku API error: ${listRes.status} ${errText}`);
    return entries;
  }

  const data = await listRes.json();
  const requests = data.requests || data.data || [];
  console.error(`  Found ${requests.length} pending requests`);

  for (const req of requests) {
    // Filter by period if possible (check date fields)
    const reqDate = req.due_date || req.created_at || '';
    if (period && reqDate && !reqDate.startsWith(period)) continue;

    // Download attached files
    const files = req.files || req.uploaded_files || [];
    for (const file of files) {
      const fileUrl = file.url || file.download_url;
      const fileName = file.name || file.filename || `bakuraku_${req.id}.pdf`;
      if (!fileUrl) continue;

      try {
        const fileRes = await fetch(fileUrl, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!fileRes.ok) continue;

        const buffer = Buffer.from(await fileRes.arrayBuffer());
        const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_');
        const destPath = path.join(invoicesDir, safeName);
        fs.writeFileSync(destPath, buffer);

        entries.push({
          file: `invoices/${safeName}`,
          originalName: fileName,
          source: 'bakuraku',
          downloadedAt: new Date().toISOString(),
          status: 'pending',
        });
        console.error(`  ✓ ${safeName} (${(buffer.length / 1024).toFixed(0)}KB)`);
      } catch (err: any) {
        console.error(`  ✗ ${fileName}: ${err.message}`);
      }
    }
  }

  return entries;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs();
  const config = parseReference(args.refFile);

  // Determine source mode
  type SourceMode = 'drive' | 'gmail' | 'bakuraku' | 'local';
  let sourceMode: SourceMode = 'local';
  let driveFolderId: string | null = null;
  let gmailQuery: string | null = null;

  if (args.sourceOverride) {
    if (args.sourceOverride.startsWith('drive:')) {
      sourceMode = 'drive';
      driveFolderId = args.sourceOverride.slice(6);
    } else if (args.sourceOverride.startsWith('gmail:')) {
      sourceMode = 'gmail';
      gmailQuery = args.sourceOverride.slice(6);
    } else if (args.sourceOverride === 'bakuraku') {
      sourceMode = 'bakuraku';
    } else if (args.sourceOverride === 'auto') {
      // Priority: Drive > Bakuraku > Gmail > local
      if (config.driveFolderId) {
        sourceMode = 'drive';
        driveFolderId = config.driveFolderId;
      } else if (config.bakurakuUrl) {
        sourceMode = 'bakuraku';
      } else if (config.gmailQuery) {
        sourceMode = 'gmail';
        gmailQuery = config.gmailQuery;
      }
    }
  } else {
    // Auto-detect from reference
    if (config.driveFolderId) {
      sourceMode = 'drive';
      driveFolderId = config.driveFolderId;
    } else if (config.bakurakuUrl) {
      sourceMode = 'bakuraku';
    } else if (config.gmailQuery) {
      sourceMode = 'gmail';
      gmailQuery = config.gmailQuery;
    }
  }

  console.error('=== collect.ts ===');
  console.error(`Work dir: ${args.workDir}`);
  console.error(`Reference: ${args.refFile}`);
  console.error(`Period: ${args.period}`);
  console.error(`Source: ${sourceMode}${driveFolderId ? ` (folder: ${driveFolderId})` : ''}${gmailQuery ? ` (query: ${gmailQuery})` : ''}`);
  console.error('');

  // Ensure directories
  const invoicesDir = path.join(args.workDir, 'invoices');
  fs.mkdirSync(invoicesDir, { recursive: true });

  let entries: ManifestEntry[] = [];
  let autoCollected = false;

  // === Drive Collection ===
  if (sourceMode === 'drive' && driveFolderId) {
    console.error('[Auto] Collecting from Google Drive...');
    const periodFolder = await findPeriodSubfolder(driveFolderId, args.period);
    const targetFolder = periodFolder || driveFolderId;
    const driveEntries = await collectFromDrive(targetFolder, invoicesDir, args.period);
    entries.push(...driveEntries);
    autoCollected = true;
  }

  // === Gmail Collection ===
  if (sourceMode === 'gmail' && gmailQuery) {
    console.error('[Auto] Collecting from Gmail...');
    try {
      const gmailEntries = await collectFromGmail(gmailQuery, invoicesDir, args.period);
      entries.push(...gmailEntries);
      autoCollected = true;
    } catch (err: any) {
      console.error(`  Gmail collection failed: ${err.message}`);
      console.error('  Falling back to local scan.');
    }
  }

  // === Bakuraku Collection ===
  if (sourceMode === 'bakuraku') {
    if (args.bakurakuToken) {
      console.error('[Auto] Collecting from Bakuraku...');
      try {
        const bakurakuEntries = await collectFromBakuraku(args.bakurakuToken, invoicesDir, args.period);
        entries.push(...bakurakuEntries);
        autoCollected = true;
      } catch (err: any) {
        console.error(`  Bakuraku collection failed: ${err.message}`);
        console.error('  Falling back to local scan.');
      }
    } else {
      console.error('[Skip] Bakuraku: no token (set BAKURAKU_TOKEN env or --bakuraku-token)');
    }
  }

  // === Always scan local files (catch manual additions) ===
  console.error(`[Local] Scanning ${invoicesDir}...`);
  const localEntries = scanLocalInvoices(invoicesDir).filter(
    e => !entries.some(d => d.file === e.file)
  );
  entries.push(...localEntries);
  if (localEntries.length > 0) {
    console.error(`  ${localEntries.length} additional local files found`);
  }

  // === Hints if nothing collected ===
  if (entries.length === 0) {
    console.error(`\n  No invoices found.`);
    console.error(`  Place PDF/image files in: ${invoicesDir}`);
    if (config.driveFolderId && sourceMode !== 'drive') {
      console.error(`  Or run with: --source drive:${config.driveFolderId}`);
    }
    if (config.bakurakuUrl && sourceMode !== 'bakuraku') {
      console.error(`  Or run with: --source bakuraku (requires BAKURAKU_TOKEN)`);
    }
    if (config.gmailQuery && sourceMode !== 'gmail') {
      console.error(`  Or run with: --source gmail:"${config.gmailQuery}"`);
    }
  }

  // Generate manifest
  const sources = [...new Set(entries.map(e => e.source))];
  const manifest: Manifest = {
    collectedAt: new Date().toISOString(),
    period: args.period,
    method: autoCollected ? (localEntries.length > 0 ? 'hybrid' : 'auto') : 'manual',
    source: sources.join('+') || 'local',
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
