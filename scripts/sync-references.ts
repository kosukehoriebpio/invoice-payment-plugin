/**
 * sync-references.ts — Notion顧客マニュアルDBから全社リファレンスを一括生成
 *
 * 顧客マニュアルDBの全ページを取得し、会社名でグルーピングして
 * invoice-payment-references リポ用のリファレンスファイルを生成する。
 *
 * データソース:
 *   - Notion API（NOTION_TOKEN指定時）
 *   - ローカルキャッシュ（--local 指定時、data/inbox/notion/ を読む）
 *
 * Usage:
 *   # ローカルキャッシュから（開発・テスト用）
 *   npx tsx scripts/sync-references.ts --local /path/to/data/inbox/notion --output ./refs
 *
 *   # Notion APIから（本番・定期実行用）
 *   NOTION_TOKEN=xxx npx tsx scripts/sync-references.ts --output ./refs
 *
 * Options:
 *   --output <dir>   出力先ディレクトリ (default: ./output)
 *   --local <dir>    ローカルキャッシュディレクトリ (data/inbox/notion/)
 *   --since <date>   この日付以降に更新された会社のみ (YYYY-MM-DD)
 *   --dry-run        ファイル出力せずプレビューのみ
 *   --company <name> 特定の会社のみ生成
 *   --skip-content   ページ本文の取得をスキップ（プロパティのみで生成）
 *   --token <token>  Notion API token (default: NOTION_TOKEN env)
 */

import fs from 'fs';
import path from 'path';

// ============================================================
// Configuration
// ============================================================

const DATABASE_ID = '113f0eb3-d4a5-80c6-bccb-d46749460d09';
const NOTION_API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const RATE_LIMIT_MS = 340; // ~3 requests/sec

// ============================================================
// Types
// ============================================================

interface PageRecord {
  id: string;
  title: string;
  category: string;    // 業務区分
  kind: string;        // 種別 (個別/一般)
  lastEdited: string;  // ISO 8601
  content?: string;    // page body as text
}

interface CompanyGroup {
  clientNo: string;
  clientName: string;
  pages: PageRecord[];
}

interface ExtractedInfo {
  accountingTool: string;
  useBakuraku: boolean;
  bakurakuDetails: string;
  banks: string[];
  paymentCycle: string;
  paymentFormat: string;
  bankingSystem: string;
  sourceNotes: string[];
  categories: string[];
}

interface CliArgs {
  output: string;
  local: string | null;
  since: string | null;
  dryRun: boolean;
  company: string | null;
  skipContent: boolean;
  token: string;
}

// ============================================================
// Argument Parsing
// ============================================================

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {
    output: './output',
    local: null,
    since: null,
    dryRun: false,
    company: null,
    skipContent: false,
    token: process.env.NOTION_TOKEN || '',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--output': result.output = args[++i]; break;
      case '--local': result.local = args[++i]; break;
      case '--since': result.since = args[++i]; break;
      case '--dry-run': result.dryRun = true; break;
      case '--company': result.company = args[++i]; break;
      case '--skip-content': result.skipContent = true; break;
      // --token removed: use NOTION_TOKEN env var instead (security: CLI args visible via ps)
    }
  }

  // Token is only required for API mode
  if (!result.local && !result.token) {
    // Fallback: try reading from ~/.config/desk/ token files
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const configDir = path.join(home, '.config', 'desk');
    for (const file of ['notion-bpo-writer.json', 'notion-token.json']) {
      const tokenPath = path.join(configDir, file);
      if (fs.existsSync(tokenPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
          result.token = data.token || data.access_token || '';
          if (result.token) break;
        } catch { /* skip */ }
      }
    }
    if (!result.token) {
      console.error('Error: NOTION_TOKEN env var, --token, or --local required');
      process.exit(1);
    }
  }

  return result;
}

// ============================================================
// Notion API Client (for API mode)
// ============================================================

let lastRequestTime = 0;

async function rateLimitWait(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

async function notionGet(token: string, endpoint: string): Promise<any> {
  await rateLimitWait();
  const resp = await fetch(`${NOTION_API_BASE}${endpoint}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Notion GET ${endpoint} → ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function notionPost(token: string, endpoint: string, body: object): Promise<any> {
  await rateLimitWait();
  const resp = await fetch(`${NOTION_API_BASE}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Notion POST ${endpoint} → ${resp.status}: ${text}`);
  }
  return resp.json();
}

// ============================================================
// Data Loading: API Mode
// ============================================================

async function queryAllPagesAPI(token: string): Promise<PageRecord[]> {
  const pages: PageRecord[] = [];
  let cursor: string | undefined;
  let batch = 0;

  do {
    batch++;
    const body: any = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const resp = await notionPost(token, `/databases/${DATABASE_ID}/query`, body);

    for (const page of resp.results) {
      const titleParts = page.properties['ハッチアル名']?.title;
      if (!titleParts?.length) continue;
      const title = titleParts.map((t: any) => t.plain_text).join('');

      pages.push({
        id: page.id,
        title,
        category: page.properties['業務区分']?.select?.name || '',
        kind: page.properties['種別']?.select?.name || '',
        lastEdited: page.properties['最終更新日']?.last_edited_time || page.last_edited_time || '',
      });
    }

    cursor = resp.has_more ? resp.next_cursor : undefined;
    process.stderr.write(`  batch ${batch}: ${pages.length} pages\r`);
  } while (cursor);

  process.stderr.write(`  total: ${pages.length} pages              \n`);
  return pages;
}

async function fetchPageBlocksAPI(token: string, pageId: string): Promise<string> {
  const lines: string[] = [];
  let cursor: string | undefined;

  do {
    const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : '?page_size=100';
    const resp = await notionGet(token, `/blocks/${pageId}/children${qs}`);

    for (const block of resp.results) {
      const text = extractBlockText(block);
      if (text) lines.push(text);
    }

    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  return lines.join('\n');
}

function extractBlockText(block: any): string {
  const type: string = block.type;
  const data = block[type];
  if (!data) return '';

  if (data.rich_text) {
    const text = data.rich_text.map((t: any) => t.plain_text).join('');
    if (!text.trim()) return '';
    switch (type) {
      case 'heading_1': return `# ${text}`;
      case 'heading_2': return `## ${text}`;
      case 'heading_3': return `### ${text}`;
      case 'bulleted_list_item': return `- ${text}`;
      case 'numbered_list_item': return `1. ${text}`;
      case 'to_do': return `- [${data.checked ? 'x' : ' '}] ${text}`;
      case 'toggle': return `> ${text}`;
      case 'quote': return `> ${text}`;
      case 'callout': return `> ${text}`;
      default: return text;
    }
  }

  if (type === 'table_row' && data.cells) {
    const cells = data.cells.map((cell: any[]) =>
      cell.map((t: any) => t.plain_text).join('')
    );
    return `| ${cells.join(' | ')} |`;
  }

  if (type === 'divider') return '---';
  return '';
}

// ============================================================
// Data Loading: Local Cache Mode
// ============================================================

interface LocalIndexRecord {
  id: string;
  db: string;
  title: string;
  file: string;
  props: Record<string, any>;
}

function loadFromLocalCache(cacheDir: string): PageRecord[] {
  const indexPath = path.join(cacheDir, '_index.json');
  if (!fs.existsSync(indexPath)) {
    console.error(`Error: _index.json not found in ${cacheDir}`);
    process.exit(1);
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
  const records: LocalIndexRecord[] = index.records.filter(
    (r: LocalIndexRecord) => r.db === 'kokyaku-manual-db'
  );

  return records.map(r => ({
    id: r.id,
    title: r.title,
    category: r.props['業務区分'] || '',
    kind: r.props['種別'] || '',
    lastEdited: r.props['最終更新日'] || '',
  }));
}

function loadPageContentLocal(cacheDir: string, pageId: string): string {
  // Try kokyaku-manual-db/{pageId}.md
  const filePath = path.join(cacheDir, 'kokyaku-manual-db', `${pageId}.md`);
  if (!fs.existsSync(filePath)) return '';

  const raw = fs.readFileSync(filePath, 'utf-8');
  // Strip YAML frontmatter
  const stripped = raw.replace(/^---[\s\S]*?---\n*/, '');
  return stripped;
}

// ============================================================
// Title Parsing & Company Grouping
// ============================================================

const SKIP_PATTERNS = [
  /^YYYY_MMDD/,
  /^顧客番号_/,
  /^\(無題\)$/,
  /^ke$/,
  /^グループ/,
  /^【OCR/,
  /^【バクラク⇒/,
  /^マネーフォワード経費/,
  /^給与奉行クラウド/,
  /^納付税額一覧表/,
  /^【納品用】/,
  /^HRCAREER_/,
  /^\*\*\*\*_/,
];

/** Companies to skip (template/invalid entries) */
const SKIP_COMPANIES = new Set([
  '株式会社',       // empty company name (0174_株式会社_エルコンドル parsed wrong)
  '○○',            // template
]);

/**
 * Canonical company name table — merges name variations into one.
 * Key: clientNo, Value: { canonicalName, slug }
 *
 * Multiple clientNos can map to the same slug to merge related entities.
 */
const CANONICAL_NAMES: Record<string, { name: string; slug: string }> = {
  // マル勝髙田商店 / マル勝高田商店 / マル勝高田 → all 1606
  '1606': { name: '株式会社マル勝高田商店', slug: 'マル勝高田商店' },
  // おくりびとアカデミ / おくりびとアカデミー → 0520
  '0520': { name: '株式会社おくりびとアカデミー', slug: 'おくりびとアカデミー' },
  // Adolescence / Adolessence → 0664
  '0664': { name: '株式会社Adolescence', slug: 'adolescence' },
  // BIRDINITIATIVE / BIRD INITIATIVE / BIRDINTIATIVE → 1711
  '1711': { name: 'BIRD INITIATIVE株式会社', slug: 'bird-initiative' },
  // SHINSEKAI Technologies / Tebhnologies → 1496
  '1496': { name: '株式会社SHINSEKAI Technologies', slug: 'shinsekai-technologies' },
  // 終活カウンセラー協会 / 協会ー / 般社団法人〜 → 1673
  '1673': { name: '一般社団法人終活カウンセラー協会', slug: '終活カウンセラー協会' },
  // ブラックシップ・リアルティ / リアリティ → 1980
  '1980': { name: 'ブラックシップ・リアルティ株式会社', slug: 'ブラックシップ・リアルティ' },
  // YOAKE entertainment / entertainm → 1920
  '1920': { name: '株式会社YOAKE entertainment', slug: 'yoake-entertainment' },
  // LuaaZ / Luaaz → 0792
  '0792': { name: '株式会社LuaaZ', slug: 'luaaz' },
  // Channel47 / channel47 → 1451
  '1451': { name: '一般社団法人Channel47', slug: 'channel47' },
  // TORIHADA (0452), PPP STUDIO (0651) — multi-company entries merge to TORIHADA
  '0452': { name: '株式会社TORIHADA', slug: 'torihada' },
  '0651': { name: '株式会社TORIHADA', slug: 'torihada' },  // PPP STUDIO merged
  // じそく1じかん (0401), Suage/Suage Japan (0641) — related but different entities
  '0401': { name: '株式会社じそく1じかん', slug: 'じそく1じかん' },
  '0641': { name: '株式会社Suage Japan', slug: 'suage-japan' },
  // Holoeyes / Holoeyes株式会社 → 0419
  '0419': { name: 'Holoeyes株式会社', slug: 'holoeyes' },
  // MYPLATE / (NEW)MYPLATE / 株式会社MYPLATE → 1126
  '1126': { name: '株式会社MYPLATE', slug: 'myplate' },
  // DELTA / 株式会社DELTA → 1282
  '1282': { name: '株式会社DELTA', slug: 'delta' },
  // L&E Group（旧リンクエッジ）/ リンクエッジ → 0355
  '0355': { name: '株式会社L&E Group', slug: 'l-e-group' },
  // I-ne / i-ne → 2422
  '2422': { name: '株式会社I-ne', slug: 'i-ne' },
  // BACKSTAGE PRODUCTS / 株式会社BACKSTAGE PRODUCTS → 2451
  '2451': { name: '株式会社BACKSTAGE PRODUCTS', slug: 'backstage-products' },
  // GOLD・KEI — 2201 and 2210 are same company (different numbers in Notion)
  '2201': { name: '株式会社GOLD・KEI', slug: 'gold-kei' },
  '2210': { name: '株式会社GOLD・KEI', slug: 'gold-kei' },
  // Waft — 0500 and 9992 are same company
  '0500': { name: 'Waft', slug: 'waft' },
  '9992': { name: 'Waft', slug: 'waft' },
  // 輝生会 — 1898 (medical corp) and 1446 (related, different departments) are separate
  '1898': { name: '医療法人社団輝生会', slug: '輝生会' },
  // Wonderlabo group — distinct entities, keep separate but fix slug
  '1858': { name: '株式会社Wonderlabo', slug: 'wonderlabo' },
  // エルコンドル — fix the parse issue with "0174_株式会社_エルコンドル"
  '0174': { name: '株式会社エルコンドル', slug: 'エルコンドル' },
};

interface ParsedTitle {
  clientNo: string;
  clientName: string;
  category: string;
}

function parseTitle(title: string): ParsedTitle | null {
  for (const pat of SKIP_PATTERNS) {
    if (pat.test(title)) return null;
  }

  // Clean leading 【作成中】 etc.
  const cleaned = title.replace(/^【[^】]+】\s*/, '');

  // Standard: {no}_{company}_{category}
  const m = cleaned.match(/^(\d{3,4})_+(.+?)_(.+)$/);
  if (m) return { clientNo: m[1], clientName: m[2].trim(), category: m[3].trim() };

  // Variant: 顧客番号1643_株式会社一喜_給与振込
  const m2 = cleaned.match(/^顧客番号(\d+)_(.+?)_(.+)$/);
  if (m2) return { clientNo: m2[1], clientName: m2[2].trim(), category: m2[3].trim() };

  // Multi-company: 0452&0651_株式会社TORIHADA&PPP STUDIO_月末振込
  const m3 = cleaned.match(/^(\d{3,4})[&＆](\d{3,4})_(.+?)_(.+)$/);
  if (m3) return { clientNo: m3[1], clientName: m3[3].trim(), category: m3[4].trim() };

  // Multi-company: 0401・0641_じそく・Suage_概要
  const m4 = cleaned.match(/^(\d{3,4})[・](\d{3,4})_(.+?)_(.+)$/);
  if (m4) return { clientNo: m4[1], clientName: m4[3].trim(), category: m4[4].trim() };

  // Space before underscore: "1898 _輝生会_月末振込"
  const m5 = cleaned.match(/^(\d{3,4})\s+_(.+?)_(.+)$/);
  if (m5) return { clientNo: m5[1], clientName: m5[2].trim(), category: m5[3].trim() };

  return null;
}

function normalizeCompanyName(name: string): string {
  return name.replace(/\s+$/, '').replace(/　/g, ' ').trim();
}

function groupByCompany(pages: PageRecord[]): Map<string, CompanyGroup> {
  // Groups keyed by slug (not company name) to properly merge
  const groups = new Map<string, CompanyGroup>();

  for (const page of pages) {
    const parsed = parseTitle(page.title);
    if (!parsed) continue;

    const rawName = normalizeCompanyName(parsed.clientName);
    if (SKIP_COMPANIES.has(rawName)) continue;

    // Resolve canonical name & slug via clientNo lookup
    const canonical = CANONICAL_NAMES[parsed.clientNo];
    const slug = canonical?.slug || generateSlug(rawName);
    const displayName = canonical?.name || rawName;

    if (!groups.has(slug)) {
      groups.set(slug, {
        clientNo: parsed.clientNo,
        clientName: displayName,
        pages: [],
      });
    }

    const cat = page.category || parsed.category;
    groups.get(slug)!.pages.push({ ...page, category: cat });
  }

  return groups;
}

// ============================================================
// Content → Info Extraction
// ============================================================

const TOOL_PATTERNS: Array<{ pattern: RegExp; tool: string }> = [
  { pattern: /MF会計|マネーフォワード会計|MFクラウド会計/i, tool: 'moneyforward' },
  { pattern: /freee/i, tool: 'freee' },
  { pattern: /弥生会計|弥生オンライン/i, tool: 'yayoi' },
  { pattern: /勘定奉行|奉行クラウド/i, tool: 'bugyo' },
  { pattern: /ICS/i, tool: 'ics' },
  { pattern: /PCA会計/i, tool: 'pca' },
  { pattern: /TKC/i, tool: 'tkc' },
];

const BANK_PATTERN = /([\u4e00-\u9fa5A-Za-z]+銀行)/g;
const BAKURAKU_PATTERN = /バクラク|bakuraku|layerx\.jp/i;
const FB_PATTERN = /FB[ファデ]|全銀|総合振込|FBデータ/i;

const PAYMENT_CYCLE_PATTERNS: Array<{ pattern: RegExp; desc: string }> = [
  { pattern: /月末締め?翌月末払/i, desc: '月末締め翌月末払い' },
  { pattern: /月末締/i, desc: '月末締め' },
  { pattern: /翌月(\d+)日/i, desc: '翌月$1日払い' },
  { pattern: /毎月(\d+)日/i, desc: '毎月$1日' },
  { pattern: /月末営業日/i, desc: '月末営業日' },
];

const BANKING_SYSTEMS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /BizSTATION|ビズステーション/i, name: '三菱UFJ BizSTATION' },
  { pattern: /e-ビジネスサイト|eビジネスサイト/i, name: 'みずほe-ビジネスサイト' },
  { pattern: /三井住友.*ネット|SMBCダイレクト|ValueDoor/i, name: '三井住友 ValueDoor' },
  { pattern: /住信SBI/i, name: '住信SBIネット銀行' },
  { pattern: /楽天銀行.*法人/i, name: '楽天銀行法人IB' },
  { pattern: /PayPay銀行/i, name: 'PayPay銀行' },
  { pattern: /ゆうちょ.*ダイレクト/i, name: 'ゆうちょダイレクト' },
];

function extractInfo(group: CompanyGroup): ExtractedInfo {
  const allContent = group.pages.map(p => p.content || '').join('\n\n');

  // Accounting tool
  let accountingTool = '';
  for (const { pattern, tool } of TOOL_PATTERNS) {
    if (pattern.test(allContent)) {
      accountingTool = tool;
      break;
    }
  }

  // Bakuraku
  const useBakuraku = BAKURAKU_PATTERN.test(allContent);
  let bakurakuDetails = '';
  if (useBakuraku) {
    const details: string[] = [];
    if (/バクラク.*債[権務]|債[権務].*バクラク/i.test(allContent)) details.push('債権・債務管理');
    if (/バクラク.*請求書|請求書.*バクラク/i.test(allContent)) details.push('請求書');
    if (/バクラク.*経費|経費.*バクラク/i.test(allContent)) details.push('経費精算');
    bakurakuDetails = details.join(', ') || 'バクラク利用';
  }

  // Banks
  const bankSet = new Set<string>();
  for (const b of (allContent.match(BANK_PATTERN) || [])) {
    if (!/日本銀行|中央銀行/.test(b)) bankSet.add(b);
  }

  // Payment format
  const paymentFormat = FB_PATTERN.test(allContent) ? 'fb' : '';

  // Payment cycle
  let paymentCycle = '';
  for (const { pattern, desc } of PAYMENT_CYCLE_PATTERNS) {
    const m = allContent.match(pattern);
    if (m) {
      paymentCycle = desc.replace(/\$1/, m[1] || '');
      break;
    }
  }

  // Banking system
  let bankingSystem = '';
  for (const { pattern, name } of BANKING_SYSTEMS) {
    if (pattern.test(allContent)) { bankingSystem = name; break; }
  }

  // Source notes
  const sourceNotes: string[] = [];
  const notePatterns = [
    /UPSIDER|法人カード|クレジットカード/i,
    /源泉.*対象|源泉所得税/i,
    /海外送金/i,
    /MF.*債務|MF.*給与|MF.*経費/i,
  ];
  for (const pat of notePatterns) {
    if (pat.test(allContent)) {
      const line = allContent.split('\n').find(l => pat.test(l));
      if (line) sourceNotes.push(line.replace(/^[-#>*\s]+/, '').trim().slice(0, 120));
    }
  }

  const categories = [...new Set(group.pages.map(p => p.category).filter(Boolean))];

  return {
    accountingTool, useBakuraku, bakurakuDetails,
    banks: [...bankSet], paymentCycle, paymentFormat,
    bankingSystem, sourceNotes, categories,
  };
}

// ============================================================
// Slug Generation
// ============================================================

const LEGAL_ENTITIES = [
  '株式会社', '合同会社', '一般社団法人', '一般財団法人',
  '医療法人社団', '医療法人', '有限会社', '合資会社',
  '特定非営利活動法人', 'NPO法人',
];

function generateSlug(companyName: string): string {
  let name = companyName;
  for (const entity of LEGAL_ENTITIES) {
    name = name.replace(entity, '');
  }
  name = name.trim();

  if (/^[\x20-\x7E]+$/.test(name)) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  return name.replace(/\s+/g, '');
}

// ============================================================
// Reference File Generation
// ============================================================

function generateReference(group: CompanyGroup, info: ExtractedInfo): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, '+09:00');
  const slug = generateSlug(group.clientName);
  const tool = info.useBakuraku && info.accountingTool
    ? `bakuraku + ${info.accountingTool}`
    : info.useBakuraku ? 'bakuraku'
    : info.accountingTool || '未確認';

  const pageList = group.pages
    .map(p => `  - ${p.category || '不明'}: ${p.title} (${p.lastEdited.slice(0, 10)})`)
    .join('\n');

  const bankLine = info.banks.length > 0
    ? `- 銀行名: "${info.banks[0]}"\n  <!-- 検出された銀行: ${info.banks.join(', ')} -->`
    : '- 銀行名: ""\n  <!-- 要確認 -->';

  const notesLines = info.sourceNotes.length > 0
    ? info.sourceNotes.map(n => `- ${n}`).join('\n')
    : '<!-- Notionマニュアルから追加情報なし -->';

  return `# ${group.clientName} — クライアントリファレンス

\`\`\`yaml
---
clientSlug: "${slug}"
clientName: "${group.clientName}"
clientNo: "${group.clientNo}"
updatedAt: "${now}"
sourcePages: ${group.pages.length}
---
\`\`\`

## 0. 会計ツール（全ステップ共通）

### 利用ツール
- tool: "${tool}"
- apiAvailable: false
- importFormat: ""
- exportFormat: ""
- manualInstructions: |
    <!-- 要ヒアリング -->

---

## 1. 請求書収集（Step 1: collect）

### 収集方法
- method: manual
- source: ""
- destination: ""

### 収集ルール
- 対象期間の判定方法: ""
- 除外条件: ""

---

## 2. 読取ヒント（Step 2: extract）

### 既知取引先

| 取引先 | フォーマット特徴 | 注意点 |
|--------|----------------|--------|

### 特殊フィールド
- 源泉徴収対象: ${/源泉/.test(info.sourceNotes.join(' ')) ? 'true' : 'false'}
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
${bankLine}
- 支店名: ""
- 口座種別: "普通"
- 口座番号: ""
- 口座名義: ""

### 振込形式
- format: "${info.paymentFormat || 'fb'}"
- feePolicy: ""
  <!-- 要確認: 当方負担 or 先方負担 -->

### 支払サイクル
- cycle: "${info.paymentCycle}"
- paymentDate: ""

---

## 5. 振込実行（Step 5: execute）

### 実行方法
- method: manual
- bankingSystem: "${info.bankingSystem}"
- instructions: |
    <!-- 要ヒアリング -->

### 承認フロー

| 金額帯 | 承認者 |
|--------|--------|
| 全件 | <!-- 要確認 --> |

---

## 6. 消込確認（Step 6: reconcile）

### 消込方法
- method: manual
- source: ""
- instructions: |
    <!-- 要ヒアリング -->

---

## 前提情報（Notionマニュアルから自動抽出）

- 会計ソフト: ${info.accountingTool || '未確認'}
- バクラク: ${info.useBakuraku ? `利用あり（${info.bakurakuDetails}）` : '未確認'}
- 検出銀行: ${info.banks.length > 0 ? info.banks.join(', ') : '未検出'}
- 業務区分: ${info.categories.join(', ') || 'なし'}

### 自動抽出ノート
${notesLines}

### ソースページ一覧
${pageList}
`;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs();
  const isLocal = !!args.local;

  console.error('=== sync-references.ts ===');
  console.error(`Mode: ${isLocal ? 'local cache' : 'Notion API'}`);
  console.error(`Output: ${args.output}`);
  if (args.since) console.error(`Since: ${args.since}`);
  if (args.company) console.error(`Company: ${args.company}`);
  if (args.dryRun) console.error('Dry run: yes');
  if (args.skipContent) console.error('Skip content: yes');
  console.error('');

  // Step 1: Load all pages
  console.error('[1/4] Loading pages...');
  const allPages = isLocal
    ? loadFromLocalCache(args.local!)
    : await queryAllPagesAPI(args.token);
  console.error(`  → ${allPages.length} pages loaded`);

  // Step 2: Group by company
  console.error('[2/4] Grouping by company...');
  const groups = groupByCompany(allPages);
  console.error(`  → ${groups.size} companies`);

  // Apply filters
  let targetGroups = [...groups.entries()];

  if (args.company) {
    targetGroups = targetGroups.filter(([slug, group]) =>
      slug.includes(args.company!) || group.clientName.includes(args.company!)
    );
    console.error(`  → filtered to ${targetGroups.length} matching "${args.company}"`);
  }

  if (args.since) {
    const sinceMs = new Date(args.since).getTime();
    targetGroups = targetGroups.filter(([, g]) =>
      g.pages.some(p => new Date(p.lastEdited).getTime() >= sinceMs)
    );
    console.error(`  → ${targetGroups.length} updated since ${args.since}`);
  }

  // Step 3: Load page content
  if (!args.skipContent) {
    console.error('[3/4] Loading page content...');
    let loaded = 0;
    const total = targetGroups.reduce((s, [, g]) => s + g.pages.length, 0);

    for (const [, group] of targetGroups) {
      for (const page of group.pages) {
        loaded++;
        process.stderr.write(`  ${loaded}/${total} ${page.title.slice(0, 50)}...\r`);
        try {
          page.content = isLocal
            ? loadPageContentLocal(args.local!, page.id)
            : await fetchPageBlocksAPI(args.token, page.id);
        } catch (err: any) {
          console.error(`\n  WARN: ${page.id}: ${err.message}`);
          page.content = '';
        }
      }
    }
    console.error(`  → ${loaded} pages loaded                                  `);
  } else {
    console.error('[3/4] Skipping content (--skip-content)');
  }

  // Step 4: Generate reference files
  console.error('[4/4] Generating references...');

  if (!args.dryRun) {
    fs.mkdirSync(args.output, { recursive: true });
  }

  const stats = { generated: 0, errors: 0 };

  for (const [slug, group] of targetGroups) {
    try {
      const info = extractInfo(group);
      const content = generateReference(group, info);
      const filename = `${slug}.md`;

      if (args.dryRun) {
        console.error(`  [DRY] ${filename} (${group.clientNo} ${group.clientName}, ${group.pages.length} pages, tool=${info.accountingTool || '?'}, bakuraku=${info.useBakuraku})`);
      } else {
        fs.writeFileSync(path.join(args.output, filename), content, 'utf-8');
      }
      stats.generated++;
    } catch (err: any) {
      console.error(`  ERROR: ${slug}: ${err.message}`);
      stats.errors++;
    }
  }

  // Summary
  console.error('');
  console.error('=== Summary ===');
  console.error(`  Total companies: ${groups.size}`);
  console.error(`  Targeted: ${targetGroups.length}`);
  console.error(`  Generated: ${stats.generated}`);
  console.error(`  Errors: ${stats.errors}`);
  if (!args.dryRun) {
    console.error(`  Output: ${path.resolve(args.output)}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
