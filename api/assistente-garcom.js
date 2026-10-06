// ═══════════════════════════════════════════════════════════════
//  POST /api/assistente-garcom
//  Body: { tenantId, restauranteId, texto }
//
//  Caixa única do app Garçom: a mesma pergunta pode ser uma DÚVIDA
//  ("qual o IBU do IPA?") ou um COMANDO DE PEDIDO ("1 pilsen na 34").
//  Esta function decide qual é, numa chamada só, e devolve:
//    { tipo: "pergunta", resposta: "..." }
//  ou
//    { tipo: "pedido", pedidos: [{mesa, itemId, itemNome, itemPreco,
//      quantidade, encontrado, nomeDigitado}] }
//
//  ⚠️ Mesma garantia de sempre: isto SÓ interpreta. Um pedido nunca é
//  lançado por aqui — o app mostra o rascunho e só escreve no banco
//  quando o garçom confirma manualmente. A classificação errada (ex:
//  tratar um pedido como pergunta) é só um incômodo de UX, nunca um
//  risco de dado — porque escrever no banco está noutro passo, sempre
//  atrás de confirmação humana.
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

// ─── CACHE EM MEMÓRIA (por instância do servidor, curta duração) ───
// Buscar cardápio+fichas+base geral do zero a cada pergunta é o que mais
// pesa no tempo de resposta. Se duas perguntas chegarem com menos de 60s
// de intervalo pro MESMO restaurante, a segunda reaproveita o que já foi
// buscado — sem bater no banco de novo. 60s é curto o bastante pra nunca
// responder com cardápio desatualizado de verdade (se alguém mudar o
// cardápio, a diferença prática é no máximo 1 minuto de atraso), mas já
// evita a repetição na correria de perguntas seguidas no mesmo serviço.
// ⚠️ Só funciona enquanto o servidor estiver "quente" (chamadas recentes).
// Depois de um tempo sem uso, a Vercel desliga a function e o cache some
// junto — isso é o "cold start" que às vezes torna a PRIMEIRA pergunta do
// dia mais lenta que as seguintes; não tem como evitar isso sem mudar de
// plano de hospedagem.
const _cacheContexto = {};
const CACHE_TTL_MS = 60 * 1000;

async function obterContexto(db, tenantId, restauranteId) {
  const chave = tenantId + '|' + restauranteId;
  const agora = Date.now();
  const cacheado = _cacheContexto[chave];
  if (cacheado && (agora - cacheado.em) < CACHE_TTL_MS) {
    return cacheado.dados;
  }

  const [restDoc, itensSnap, arquivosSnap] = await Promise.all([
    db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId).get(),
    db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId)
      .collection('cardapio').doc('data').collection('itens').get(),
    db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId)
      .collection('assistente_arquivos').get(),
  ]);

  const documentoGeral = ((restDoc.data() || {}).documentoGeralIA || '').trim();
  const cardapioCompleto = [];
  const comFicha = [];
  itensSnap.forEach((doc) => {
    const it = doc.data() || {};
    if (it.disponivel === false) return;
    if (it.tipoVenda !== 'kg') {
      cardapioCompleto.push({ id: doc.id, nome: it.nome || '(sem nome)', preco: typeof it.preco === 'number' ? it.preco : 0 });
    }
    if (it.fichaTecnica && it.fichaTecnica.trim()) {
      comFicha.push({ nome: it.nome || '(sem nome)', ficha: it.fichaTecnica.trim() });
    }
  });

  // Só a METADADOS dos arquivos entram no cache (nome/url/tipo) — os bytes
  // em si são baixados na hora de cada pergunta, nunca guardados em
  // memória entre chamadas (evita inchar a instância do servidor).
  const arquivos = [];
  arquivosSnap.forEach((doc) => {
    const a = doc.data() || {};
    if (a.url && a.nome) arquivos.push({ nome: a.nome, url: a.url, tipo: a.tipo || 'image/png' });
  });

  const dados = { documentoGeral, cardapioCompleto, comFicha, arquivos };
  _cacheContexto[chave] = { em: agora, dados };
  return dados;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  const body = req.body || {};
  const tenantId = (body.tenantId || TENANT_PADRAO).toString();
  const restauranteId = (body.restauranteId || 'default').toString();
  const texto = (body.texto || '').toString().trim();

  if (!texto) return res.status(400).json({ ok: false, error: 'Falta o texto' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY não configurada no servidor.' });

  try {
    const db = getDb();
    const { documentoGeral, cardapioCompleto, comFicha, arquivos } = await obterContexto(db, tenantId, restauranteId);

    const listaCardapio = cardapioCompleto.map((it, i) => `${i + 1}. ${it.nome} [id:${it.id}]`).join('\n');
    const blocoFichas = comFicha.length
      ? comFicha.map((it, i) => `[${i + 1}] ${it.nome}\n${it.ficha}`).join('\n\n')
      : '(nenhum item com ficha técnica cadastrada)';
    const blocoGeral = documentoGeral ? `\n\nBASE DE CONHECIMENTO GERAL:\n${documentoGeral.slice(0, 40000)}` : '';

    // Baixa cada arquivo e converte em base64 pro Gemini "ver" de verdade —
    // mesmo mecanismo já usado no app de Treinamentos. Arquivo que falhar
    // ao baixar é pulado (não derruba a resposta inteira por causa de um
    // arquivo só). Limite de 10 por pergunta, só por segurança.
    const arquivosPraUsar = (arquivos || []).slice(0, 10);
    const partesArquivos = [];
    for (const a of arquivosPraUsar) {
      try {
        const r = await fetch(a.url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) throw new Error('arquivo grande demais');
        partesArquivos.push({ text: `Arquivo anexado: "${a.nome}"` });
        partesArquivos.push({ inline_data: { mime_type: a.tipo, data: buf.toString('base64') } });
      } catch (e) {
        console.error('[assistente-garcom] falhou ao carregar arquivo', a.nome, e.message);
      }
    }

    const prompt =
`Você é o assistente do app de um garçom de restaurante. O texto abaixo pode
ser UMA DAS TRÊS COISAS:

(A) Uma DÚVIDA sobre produto (IBU, teor alcoólico, ingredientes, alérgenos)
    ou sobre o restaurante (horário, promoção, política).
(B) Um COMANDO DE PEDIDO pra lançar numa mesa (ex: "1 pilsen na 34", "2
    chopp mesa 12 e 1 coca na 8").
(C) Um COMANDO DE CANCELAMENTO de item já pedido (ex: "cancelar 1 pilsen
    da mesa 10", "tira a coca da 15", "cancela o chopp mesa 8").

Decida qual das três é e responda SOMENTE com um JSON válido, sem texto
antes ou depois, sem marcação de código — só o JSON puro.

SE FOR DÚVIDA:
{"tipo":"pergunta","resposta":"texto da resposta, até 2 frases, português do Brasil"}
Responda SOMENTE com base nas fichas técnicas, na base de conhecimento e
nos arquivos anexados abaixo (se houver). NUNCA invente um valor técnico.
Se não estiver cadastrado nem nos arquivos, diga isso claramente. SEMPRE
que a resposta vier de um arquivo anexado (imagem ou PDF), é OBRIGATÓRIO
citar o nome dele EXATAMENTE como foi dado no texto "Arquivo anexado:
..." — sem alterar maiúscula/minúscula, sem abreviar, em algum ponto da
resposta. Isso vale tanto pra imagem quanto pra PDF.

SE FOR PEDIDO:
{"tipo":"pedido","pedidos":[{"mesa":34,"itemId":"abc123","quantidade":1,"obs":""}]}
- "itemId" deve ser exatamente um [id:...] da lista de cardápio abaixo.
  NUNCA invente um id — se não reconhecer o item com confiança, use
  "itemId": null e inclua "nomeDigitado" com o texto falado.
- Cada combinação mesa+item é um objeto separado, mesmo com quantidade 1.
- Se mencionar várias mesas, cada uma gera seus próprios itens no array.
- "obs" é uma observação sobre a PREPARAÇÃO do item (ex: "sem salada",
  "sem gelo", "bem passado", "sem cebola") — texto curto, só o essencial,
  SEM repetir o nome do produto. Deixe "" se não houver observação pra
  aquele item específico. Cada observação vale só pro item que está
  associado a ela na frase (ex: "2 bacon, 1 sem salada" significa UM dos
  dois bacons tem a observação "sem salada" — nesse caso gere dois objetos
  separados pro Bacon, um com quantidade 1 e obs "sem salada", outro com
  quantidade 1 e obs "").

SE FOR CANCELAMENTO:
{"tipo":"cancelamento","itens":[{"mesa":10,"nomeDigitado":"pilsen","quantidade":1}]}
- "nomeDigitado" é só o texto do produto como foi falado — NÃO tente casar
  com um id do cardápio aqui (o app faz essa checagem depois, olhando o que
  realmente está na conta daquela mesa agora).
- Cada combinação mesa+item é um objeto separado.

FICHAS TÉCNICAS DE ITENS:
${blocoFichas}${blocoGeral}
${arquivosPraUsar.length ? `\n\n${arquivosPraUsar.length} arquivo(s) anexado(s) abaixo — leia o conteúdo deles diretamente.` : ''}

CARDÁPIO DISPONÍVEL (pra uso em PEDIDO):
${listaCardapio}

TEXTO:
"${texto}"`;

    const parts = [{ text: prompt }, ...partesArquivos];

    const geminiResp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: parts }] }),
    });

    if (!geminiResp.ok) {
      const errTxt = await geminiResp.text().catch(() => '');
      console.error('[assistente-garcom] Gemini falhou:', geminiResp.status, errTxt);
      return res.status(502).json({ ok: false, error: 'Assistente indisponível no momento.' });
    }

    const data = await geminiResp.json();
    let textoResposta = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || '';
    textoResposta = textoResposta.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(textoResposta);
    } catch (e) {
      console.error('[assistente-garcom] JSON inválido:', textoResposta);
      return res.status(200).json({ ok: true, tipo: 'pergunta', resposta: 'Não consegui entender. Tenta reformular.' });
    }

    if (parsed.tipo === 'pedido') {
      const brutos = Array.isArray(parsed.pedidos) ? parsed.pedidos : [];
      const resultado = brutos.map((p) => {
        const mesa = parseInt(p.mesa, 10);
        const qtd = Math.max(1, parseInt(p.quantidade, 10) || 1);
        const item = p.itemId ? cardapioCompleto.find((c) => c.id === p.itemId) : null;
        return {
          mesa: isNaN(mesa) ? null : mesa,
          quantidade: qtd,
          itemId: item ? item.id : null,
          itemNome: item ? item.nome : null,
          itemPreco: item ? item.preco : null,
          encontrado: !!item,
          nomeDigitado: p.nomeDigitado || null,
          obs: (p.obs || '').toString().trim().slice(0, 140),
        };
      }).filter((p) => p.mesa !== null);

      return res.status(200).json({ ok: true, tipo: 'pedido', pedidos: resultado });
    }

    if (parsed.tipo === 'cancelamento') {
      const brutos = Array.isArray(parsed.itens) ? parsed.itens : [];
      const resultado = brutos.map((p) => {
        const mesa = parseInt(p.mesa, 10);
        const qtd = Math.max(1, parseInt(p.quantidade, 10) || 1);
        return { mesa: isNaN(mesa) ? null : mesa, nomeDigitado: (p.nomeDigitado || '').toString(), quantidade: qtd };
      }).filter((p) => p.mesa !== null && p.nomeDigitado);

      return res.status(200).json({ ok: true, tipo: 'cancelamento', itens: resultado });
    }

    // Default: trata como pergunta (cobre tipo==="pergunta" e qualquer formato inesperado)
    const respostaTexto = (parsed.resposta || 'Não consegui gerar uma resposta agora.').trim();
    // Comparação tolerante a maiúscula/minúscula — a IA às vezes cita o
    // nome do arquivo com capitalização levemente diferente (mais comum
    // em respostas vindas de PDF), e uma comparação exata deixava o botão
    // "ver arquivo" de fora mesmo quando a resposta realmente veio dele.
    const respostaMin = respostaTexto.toLowerCase();
    const arquivoCitado = arquivosPraUsar.find((a) => respostaMin.indexOf(a.nome.toLowerCase()) >= 0);
    return res.status(200).json({
      ok: true,
      tipo: 'pergunta',
      resposta: respostaTexto,
      arquivoUrl: arquivoCitado ? arquivoCitado.url : null,
      arquivoNome: arquivoCitado ? arquivoCitado.nome : null,
      arquivoTipo: arquivoCitado ? arquivoCitado.tipo : null,
    });
  } catch (err) {
    console.error('[assistente-garcom] falhou:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
