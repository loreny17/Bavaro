// ═══════════════════════════════════════════════════════════════
//  Cliente do Google Sheets — autenticação via Service Account.
//  Também só roda no servidor. Qualquer falha na API do Google NUNCA
//  deve derrubar o caixa: toda função aqui é chamada com try/catch
//  por quem a usa, e o fechamento de conta em si (Firestore) já
//  aconteceu antes — a planilha é só um espelho, nunca a fonte da verdade.
// ═══════════════════════════════════════════════════════════════
const { google } = require('googleapis');

const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1J3nAFJ1LlRaCDlAaeQA8oYSw161sqNEuJ9YwmFsGibg';

let _sheetsClient = null;

function getSheetsClient() {
  if (_sheetsClient) return _sheetsClient;

  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Credenciais do Google Sheets ausentes. Configure GOOGLE_SERVICE_ACCOUNT_EMAIL ' +
      'e GOOGLE_PRIVATE_KEY nas variáveis de ambiente da Vercel.'
    );
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

// Substitui TODO o conteúdo de um intervalo (usado pro Cardápio: a lista
// inteira é recalculada a cada sincronização, não faz sentido "somar").
async function limparEEscrever(range, linhas) {
  const sheets = getSheetsClient();
  // Limpa primeiro (senão itens removidos do cardápio ficariam "fantasmas"
  // na planilha, sobrando de uma sincronização anterior maior).
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range });
  if (!linhas.length) return;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: linhas },
  });
}

// Acrescenta linhas no fim de uma aba (usado pra Vendas_Diarias e
// Resumo_Diario: cada fechamento de caixa ADICIONA, nunca substitui).
async function acrescentar(range, linhas) {
  if (!linhas.length) return;
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: linhas },
  });
}

module.exports = { getSheetsClient, limparEEscrever, acrescentar, SHEET_ID };
