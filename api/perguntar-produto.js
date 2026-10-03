// ═══════════════════════════════════════════════════════════════
//  POST /api/perguntar-produto
//  Body: { tenantId, restauranteId, pergunta }
//
//  Responde dúvidas de garçom/cliente sobre um item do cardápio (IBU,
//  teor alcoólico, ingredientes, alérgenos...) usando SOMENTE a "Ficha
//  técnica" cadastrada em cada item no PDV. Nunca inventa um valor —
//  informação técnica errada aqui pode ser um problema sério de verdade
//  (ex: alguém com restrição alimentar confiando numa resposta chutada).
//
//  ⚠️ Mesmas credenciais do sistema principal já usadas por sync-cardapio.js
//  e fechar-caixa.js (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
//  FIREBASE_PRIVATE_KEY) e a mesma GEMINI_API_KEY já configurada pro app de
//  Treinamentos — nada de variável de ambiente nova pra esta function.
//  Admin init embutido aqui mesmo (em vez de importar de ./_lib) pela mesma
//  razão documentada em perguntar-treinamento.js: evitar qualquer risco de
//  subpasta mal publicada — esta function fica autocontida.
// ═══════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getDb() {
  if (admin.apps.length) return admin.app().firestore();

  const projectId = process.env.FIREBASE_PROJECT_ID || 'gestao-reataurante';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error('Credenciais do Firebase Admin ausentes (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).');
  }

  admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  return admin.firestore();
}

const TENANT_PADRAO = 'tnt_molrfz1k_rznlgl';
const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  const body = req.body || {};
  const tenantId = (body.tenantId || TENANT_PADRAO).toString();
  const restauranteId = (body.restauranteId || 'default').toString();
  const pergunta = (body.pergunta || '').toString().trim();

  if (!pergunta) return res.status(400).json({ ok: false, error: 'Falta a pergunta' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY não configurada no servidor.' });
  }

  try {
    const db = getDb();
    // Duas fontes, lidas em paralelo: ficha técnica por item (IBU, teor
    // alcoólico...) e a base de conhecimento geral do restaurante (horário,
    // promoções, políticas — tudo que não é de um produto específico).
    const [restDoc, itensSnap] = await Promise.all([
      db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId).get(),
      db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId)
        .collection('cardapio').doc('data').collection('itens').get(),
    ]);

    const documentoGeral = ((restDoc.data() || {}).documentoGeralIA || '').trim();

    const comFicha = [];
    itensSnap.forEach((doc) => {
      const it = doc.data() || {};
      if (it.fichaTecnica && it.fichaTecnica.trim()) {
        comFicha.push({ nome: it.nome || '(sem nome)', ficha: it.fichaTecnica.trim() });
      }
    });

    if (!comFicha.length && !documentoGeral) {
      return res.status(200).json({
        ok: true,
        resposta: 'Ainda não tenho nada cadastrado pra esse restaurante. Peça pro admin preencher a Ficha técnica de algum item ou a Base de Conhecimento da IA, no menu do PDV.',
      });
    }

    const contexto = comFicha.slice(0, 150); // trava de segurança
    const blocoFichas = contexto.length
      ? contexto.map((it, i) => `[${i + 1}] ${it.nome}\n${it.ficha}`).join('\n\n')
      : '(nenhum item com ficha técnica cadastrada)';

    const blocoGeral = documentoGeral
      ? `\n\nBASE DE CONHECIMENTO GERAL DO RESTAURANTE (horário, promoções, políticas...):\n${documentoGeral.slice(0, 40000)}`
      : '';

    const prompt =
`Você é o assistente de um restaurante, ajudando um garçom a responder uma
dúvida de cliente — pode ser sobre um produto do cardápio (ex: IBU de um
chopp, teor alcoólico, ingredientes, alérgenos) ou sobre o restaurante em
geral (horário, promoções, políticas). Responda SOMENTE com base no que
está escrito abaixo, cadastrado pela própria gerência. NUNCA invente ou
estime um valor técnico que não esteja escrito aqui — isso pode ser
perigoso de verdade (ex: alguém com alergia confiando numa resposta errada).

Se a pergunta não tiver relação com nada do que está cadastrado, diga
claramente que essa informação não está disponível ainda — não tente
adivinhar, nem aproximar com base em produtos parecidos.

Responda em português do Brasil, em até 2 frases, direto ao ponto.

FICHAS TÉCNICAS DE ITENS CADASTRADAS:
${blocoFichas}${blocoGeral}

PERGUNTA:
${pergunta}`;

    const geminiResp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    if (!geminiResp.ok) {
      const errTxt = await geminiResp.text().catch(() => '');
      console.error('[perguntar-produto] Gemini falhou:', geminiResp.status, errTxt);
      return res.status(502).json({ ok: false, error: 'Assistente indisponível no momento.' });
    }

    const data = await geminiResp.json();
    const resposta = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || 'Não consegui gerar uma resposta agora.';

    return res.status(200).json({ ok: true, resposta: resposta.trim() });
  } catch (err) {
    console.error('[perguntar-produto] falhou:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
