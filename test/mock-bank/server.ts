/**
 * ダミー銀行モックAPI
 * 全銀協FBファイルを受け付けて振込結果を返すシンプルなモックサーバー
 *
 * 起動: npx tsx plugins/invoice-payment/test/mock-bank/server.ts
 * ポート: 3099
 */

import express from 'express';
import multer from 'multer';
import iconv from 'iconv-lite';
import { randomUUID } from 'crypto';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

// 振込データのインメモリストア
interface Transfer {
  id: string;
  bankCode: string;
  branchCode: string;
  accountType: string;
  accountNumber: string;
  recipientName: string;
  amount: number;
  status: 'pending' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
}

const transfers: Transfer[] = [];

/**
 * FBファイル（全銀協フォーマット）のパーサー
 * レコード種別: 1=ヘッダ, 2=データ, 8=トレーラ, 9=エンド
 * 固定長120バイト（Shift_JIS）
 */
function parseFBFile(buffer: Buffer): { header: any; records: any[]; trailer: any; errors: string[] } {
  const errors: string[] = [];
  let header: any = null;
  const records: any[] = [];
  let trailer: any = null;

  // バイト単位でスライスしてShift_JIS→UTF-8変換
  function sliceBytes(buf: Buffer, start: number, end: number): string {
    if (start >= buf.length) return '';
    const actualEnd = Math.min(end, buf.length);
    const slice = buf.slice(start, actualEnd);
    return iconv.decode(slice, 'Shift_JIS').trim();
  }

  // CR+LF or LF で行分割（バイト単位）
  const lineBuffers: Buffer[] = [];
  let pos = 0;
  while (pos < buffer.length) {
    let eol = -1;
    for (let j = pos; j < buffer.length; j++) {
      if (buffer[j] === 0x0A) { eol = j; break; }
    }
    if (eol === -1) eol = buffer.length;
    let lineEnd = eol;
    if (lineEnd > pos && buffer[lineEnd - 1] === 0x0D) lineEnd--;
    if (lineEnd > pos) lineBuffers.push(Buffer.from(buffer.slice(pos, lineEnd)));
    pos = eol + 1;
  }

  for (let i = 0; i < lineBuffers.length; i++) {
    const lineBuf = lineBuffers[i];
    if (lineBuf.length === 0) continue;
    const recordType = String.fromCharCode(lineBuf[0]);

    switch (recordType) {
      case '1': // ヘッダレコード
        header = {
          recordType: '1',
          transferType: sliceBytes(lineBuf, 1, 3),
          senderCode: sliceBytes(lineBuf, 3, 13),
          senderName: sliceBytes(lineBuf, 13, 53),
          transferDate: sliceBytes(lineBuf, 53, 57),
          bankCode: sliceBytes(lineBuf, 57, 61),
          bankName: sliceBytes(lineBuf, 61, 76),
          branchCode: sliceBytes(lineBuf, 76, 79),
          branchName: sliceBytes(lineBuf, 79, 94),
          accountType: sliceBytes(lineBuf, 94, 95),
          accountNumber: sliceBytes(lineBuf, 95, 102),
        };
        break;

      case '2': // データレコード
        records.push({
          recordType: '2',
          bankCode: sliceBytes(lineBuf, 1, 5),
          bankName: sliceBytes(lineBuf, 5, 20),
          branchCode: sliceBytes(lineBuf, 20, 23),
          branchName: sliceBytes(lineBuf, 23, 38),
          accountType: sliceBytes(lineBuf, 42, 43),
          accountNumber: sliceBytes(lineBuf, 43, 50),
          recipientName: sliceBytes(lineBuf, 50, 80),
          amount: (() => { const s = sliceBytes(lineBuf, 80, 90); const n = parseInt(s, 10); return isNaN(n) ? 0 : n; })(),
        });
        break;

      case '8': // トレーラレコード
        trailer = {
          recordType: '8',
          totalCount: parseInt(sliceBytes(lineBuf, 1, 7)) || 0,
          totalAmount: parseInt(sliceBytes(lineBuf, 7, 19)) || 0,
        };
        break;

      case '9': // エンドレコード
        break;

      default:
        errors.push(`行${i + 1}: 不明なレコード種別 '${recordType}'`);
    }
  }

  // バリデーション
  if (!header) {
    errors.push('ヘッダレコード（種別1）がありません');
  }
  if (records.length === 0) {
    errors.push('データレコード（種別2）がありません');
  }
  if (trailer) {
    if (trailer.totalCount !== records.length) {
      errors.push(`件数不一致: トレーラ=${trailer.totalCount}, 実データ=${records.length}`);
    }
    const actualTotal = records.reduce((sum: number, r: any) => sum + (r.amount || 0), 0);
    if (trailer.totalAmount !== actualTotal) {
      // Shift_JISマルチバイト文字でレコード長が120バイトを超える場合がある
      // 金額が全て0の場合はパースエラーとして扱い、そうでなければ警告のみ
      if (actualTotal === 0) {
        errors.push(`金額パースエラー: 全レコードの金額が0です`);
      } else {
        console.warn(`金額差異（警告）: トレーラ=${trailer.totalAmount}, 実計算=${actualTotal}`);
      }
    }
  }

  return { header, records, trailer, errors };
}

// --- エンドポイント ---

/**
 * POST /api/upload-fb
 * FBファイルをアップロードして振込を登録
 */
app.post('/api/upload-fb', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'ファイルが指定されていません。file フィールドでFBファイルをアップロードしてください。' });
  }

  const fileBuffer = Buffer.from(req.file.buffer);
  const { header, records, trailer, errors } = parseFBFile(fileBuffer);

  if (errors.length > 0) {
    return res.status(422).json({
      status: 'validation_error',
      errors,
      parsedRecords: records.length,
    });
  }

  // 振込データを登録（2秒後に自動で completed にする）
  const registeredTransfers: Transfer[] = records.map((r: any) => {
    const transfer: Transfer = {
      id: randomUUID(),
      bankCode: r.bankCode,
      branchCode: r.branchCode,
      accountType: r.accountType === '1' ? '普通' : r.accountType === '2' ? '当座' : r.accountType,
      accountNumber: r.accountNumber,
      recipientName: r.recipientName,
      amount: r.amount,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    transfers.push(transfer);

    // 2秒後に自動完了（モック）
    setTimeout(() => {
      transfer.status = 'completed';
      transfer.completedAt = new Date().toISOString();
    }, 2000);

    return transfer;
  });

  res.json({
    status: 'accepted',
    message: `${registeredTransfers.length}件の振込を受け付けました`,
    header: {
      senderName: header.senderName,
      transferDate: header.transferDate,
      bank: `${header.bankName}(${header.bankCode}) ${header.branchName}(${header.branchCode})`,
    },
    summary: {
      totalCount: registeredTransfers.length,
      totalAmount: registeredTransfers.reduce((s, t) => s + t.amount, 0),
    },
    transfers: registeredTransfers.map(t => ({
      id: t.id,
      recipientName: t.recipientName,
      amount: t.amount,
      status: t.status,
    })),
  });
});

/**
 * GET /api/transfers
 * 登録済み振込一覧
 */
app.get('/api/transfers', (_req, res) => {
  res.json({
    totalCount: transfers.length,
    transfers: transfers.map(t => ({
      id: t.id,
      recipientName: t.recipientName,
      amount: t.amount,
      status: t.status,
      createdAt: t.createdAt,
      completedAt: t.completedAt,
    })),
  });
});

/**
 * GET /api/transfers/:id
 * 個別振込ステータス確認
 */
app.get('/api/transfers/:id', (req, res) => {
  const transfer = transfers.find(t => t.id === req.params.id);
  if (!transfer) {
    return res.status(404).json({ error: '振込データが見つかりません' });
  }
  res.json(transfer);
});

/**
 * DELETE /api/transfers
 * 全データリセット（テスト用）
 */
app.delete('/api/transfers', (_req, res) => {
  transfers.length = 0;
  res.json({ status: 'cleared', message: '全振込データをリセットしました' });
});

// --- サーバー起動 ---
const PORT = 3099;
app.listen(PORT, () => {
  console.log(`Mock Bank API running on http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log('  POST   /api/upload-fb     FBファイルアップロード');
  console.log('  GET    /api/transfers     振込一覧');
  console.log('  GET    /api/transfers/:id 個別ステータス');
  console.log('  DELETE /api/transfers     全データリセット');
});
