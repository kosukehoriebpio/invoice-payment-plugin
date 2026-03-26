/**
 * auth.ts — プラグインアクティベーション検証
 *
 * 環境変数 INVOICE_PAYMENT_KEY を検証し、正規ユーザーのみプラグインを利用可能にする。
 * キーは SHA-256 ハッシュで照合（平文キーをコードに含めない）。
 *
 * Usage:
 *   npx tsx scripts/auth.ts
 *   → Exit code 0: 認証成功
 *   → Exit code 1: 認証失敗
 *
 * Setup:
 *   1. 管理者がキーを生成: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *   2. ハッシュを計算: node -e "console.log(require('crypto').createHash('sha256').update('生成したキー').digest('hex'))"
 *   3. ハッシュを VALID_KEY_HASHES に追加
 *   4. ユーザーに平文キーを配布 → 環境変数 INVOICE_PAYMENT_KEY に設定してもらう
 */

import crypto from 'crypto';
import { fileURLToPath } from 'url';

// SHA-256 hashes of valid activation keys
// Multiple hashes can be registered (e.g., per-team or per-user keys with revocation)
const VALID_KEY_HASHES: string[] = [
  // Initial key hash — replace with actual hash after key generation
  // Generate: node -e "console.log(require('crypto').createHash('sha256').update('YOUR_KEY').digest('hex'))"
];

// Also allow a hash file for easier key rotation without code changes
import fs from 'fs';
import path from 'path';

function loadExternalHashes(): string[] {
  // Check for .keyhashes file in plugin root (one level up from scripts/)
  const scriptDir = typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  const hashFile = path.join(scriptDir, '..', '.keyhashes');
  if (fs.existsSync(hashFile)) {
    return fs.readFileSync(hashFile, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));
  }
  return [];
}

function verify(): boolean {
  const key = process.env.INVOICE_PAYMENT_KEY;

  if (!key) {
    console.error('');
    console.error('=== 認証エラー ===');
    console.error('環境変数 INVOICE_PAYMENT_KEY が設定されていません。');
    console.error('');
    console.error('このプラグインは認証が必要です。');
    console.error('管理者からアクティベーションキーを受け取り、以下を設定してください:');
    console.error('');
    console.error('  # Windows (PowerShell)');
    console.error('  $env:INVOICE_PAYMENT_KEY = "your-activation-key"');
    console.error('');
    console.error('  # Mac/Linux');
    console.error('  export INVOICE_PAYMENT_KEY="your-activation-key"');
    console.error('');
    console.error('  # 永続化する場合は .bashrc / .zshrc / PowerShell Profile に追加');
    console.error('');
    return false;
  }

  const keyHash = crypto.createHash('sha256').update(key).digest('hex');
  const allHashes = [...VALID_KEY_HASHES, ...loadExternalHashes()];

  if (allHashes.length === 0) {
    // No hashes configured yet — allow access (initial setup mode)
    console.error('[AUTH] キーハッシュ未設定（初期セットアップモード）— アクセスを許可');
    return true;
  }

  if (allHashes.includes(keyHash)) {
    return true;
  }

  console.error('');
  console.error('=== 認証エラー ===');
  console.error('アクティベーションキーが無効です。');
  console.error('正しいキーを管理者に確認してください。');
  console.error('');
  return false;
}

if (!verify()) {
  process.exit(1);
}

// Success — output nothing, exit 0
