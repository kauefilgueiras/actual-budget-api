import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import * as actual from '@actual-app/api';
import { Readable } from 'node:stream';
import fs from 'fs';
import path from 'path';

const {
  PORT = 8080,
  NODE_ENV = 'production',
  ACTUAL_SERVER_URL,
  ACTUAL_PASSWORD,
  ACTUAL_BUDGET_ID,    // opcional: id (local), groupId ou cloudFileId
  ACTUAL_FILE_PASSWORD // opcional: senha do arquivo (se houver criptografia)
} = process.env;

if (!ACTUAL_SERVER_URL || !ACTUAL_PASSWORD) {
  console.error('Faltam ACTUAL_SERVER_URL e/ou ACTUAL_PASSWORD nas variáveis de ambiente.');
  process.exit(1);
}

const app = express();
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(morgan(NODE_ENV === 'development' ? 'dev' : 'combined'));

const DATA_DIR = path.resolve('./.actual-data');
fs.mkdirSync(DATA_DIR, { recursive: true });

let sdkInited = false;
let fullyReady = false;

function pickFields(b) {
  return {
    name: b?.name,
    id: b?.id || null,                 // existe quando o arquivo já está local
    groupId: b?.groupId || null,       // “sync id” em muitos servidores
    cloudFileId: b?.cloudFileId || null,
    state: b?.state || (b?.id ? 'local' : 'remote')
  };
}

async function ensureSdkInit() {
  if (sdkInited) return;
  await actual.init({
    serverURL: ACTUAL_SERVER_URL,
    password: ACTUAL_PASSWORD,
    dataDir: DATA_DIR,
    // filePassword pode ser definido por loadBudget se o arquivo for criptografado
  });
  sdkInited = true;
}

// tenta SEMPRE **string** (compat máxima com o servidor)
/** baixa e carrega por groupId (string) ou cloudFileId (string) */
async function downloadThenLoadByStrings({ groupId, cloudFileId }) {
  let lastErr;
  if (groupId) {
    try {
      await actual.downloadBudget(groupId);
      await actual.loadBudget(groupId, { password: ACTUAL_FILE_PASSWORD });
      return 'groupId(string)';
    } catch (e) { lastErr = e; }
  }
  if (cloudFileId) {
    try {
      await actual.downloadBudget(cloudFileId);
      await actual.loadBudget(cloudFileId, { password: ACTUAL_FILE_PASSWORD });
      return 'cloudFileId(string)';
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function ensureActualReady() {
  if (fullyReady) return;
  await ensureSdkInit();

  const budgets = await actual.getBudgets();
  if (!budgets || budgets.length === 0) {
    throw new Error('Nenhum orçamento encontrado no servidor Actual.');
  }

  // escolha do arquivo
  let chosen =
    (ACTUAL_BUDGET_ID &&
      budgets.find(b => {
        const f = pickFields(b);
        return [f.id, f.groupId, f.cloudFileId].includes(ACTUAL_BUDGET_ID);
      })) ||
    budgets.find(b => pickFields(b).id) || // prefere o local, se existir
    budgets[0];

  const f = pickFields(chosen);

  // se já existe diretório local com esse id, abrir direto; senão, baixar por strings
  const localDir = f.id ? path.join(DATA_DIR, f.id) : null;
  const hasLocal = localDir && fs.existsSync(localDir);

  if (hasLocal) {
    await actual.loadBudget(f.id, { password: ACTUAL_FILE_PASSWORD });
    console.log(`Budget carregado localmente: id=${f.id} (name="${f.name}")`);
  } else {
    const via = await downloadThenLoadByStrings({ groupId: f.groupId, cloudFileId: f.cloudFileId });
    console.log(`Budget baixado e carregado via ${via}: name="${f.name}", groupId=${f.groupId}, cloudFileId=${f.cloudFileId}`);
  }

  // 🔴 importante: traga as mudanças do servidor após carregar
  await actual.sync();

  fullyReady = true;
}

/* ---------- helpers ---------- */
function accountMatches(a, q) {
  return a.id === q || a.name === q;
}

function toCSV(transactions) {
  const header = [
    'id','date','amount_cents','amount','account_id','payee_id','category_id','notes','imported_id','transfer_id'
  ].join(',');
  const esc = s => `"${String(s ?? '').replaceAll('"','""')}"`;
  const rows = transactions.map(t => [
    esc(t.id),
    esc(t.date),
    t.amount ?? '',
    ((t.amount ?? 0) / 100).toFixed(2),
    esc(t.account),
    esc(t.payee),
    esc(t.category),
    esc(t.notes),
    esc(t.imported_id),
    esc(t.transfer_id)
  ].join(','));
  return [header, ...rows].join('\n');
}

/* ---------- rotas ---------- */
app.get('/health', (_req, res) => res.json({ ok: true }));

// objeto CRU (para depurar IDs no servidor)
app.get('/debug/budgets', async (_req, res) => {
  try {
    await ensureSdkInit();
    const budgets = await actual.getBudgets();
    res.json(budgets);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao depurar budgets' });
  }
});

app.get('/budgets', async (_req, res) => {
  try {
    await ensureActualReady();
    await actual.sync(); // manter lista de arquivos fresca (opcional)
    const budgets = await actual.getBudgets();
    res.json(budgets.map(b => pickFields(b)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao listar budgets' });
  }
});

app.get('/accounts', async (_req, res) => {
  try {
    await ensureActualReady();
    await actual.sync(); // garante saldos/nomes atualizados
    const accounts = await actual.getAccounts();
    res.json(accounts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao listar contas' });
  }
});

// GET /transactions?account=<id|nome>&start=YYYY-MM-DD&end=YYYY-MM-DD[&format=csv]
app.get('/transactions', async (req, res) => {
  try {
    await ensureActualReady();

    // 🔁 sincroniza novamente para pegar qualquer mudança recente do Pluggy
    await actual.sync();

    const { account, start, end, format } = req.query;

    if (!account || !start || !end) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios: account, start, end' });
    }

    const accounts = await actual.getAccounts();
    const acc = accounts.find(a => accountMatches(a, account));
    if (!acc) {
      return res.status(404).json({ error: 'Conta não encontrada', hint: 'Use /accounts para ver as opções' });
    }

    const txs = await actual.getTransactions(acc.id, start, end);

    if (format === 'csv') {
      const csv = toCSV(txs);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="transactions_${acc.id}_${start}_${end}.csv"`);
      Readable.from(csv).pipe(res);
    } else {
      res.json({
        account: { id: acc.id, name: acc.name },
        start, end,
        count: txs.length,
        transactions: txs
      });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao obter transações' });
  }
});

// rota manual para forçar sync quando quiser (útil p/ debug)
app.post('/sync', async (_req, res) => {
  try {
    await ensureActualReady();
    await actual.sync();
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Falha ao sincronizar' });
  }
});

/* ---------- encerramento ---------- */
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
process.on('SIGINT', async () => {
  try { await actual.shutdown(); } catch {}
  process.exit(0);
});
process.on('SIGTERM', async () => {
  try { await actual.shutdown(); } catch {}
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Actual REST API ouvindo em :${PORT} (${NODE_ENV})`);
});
