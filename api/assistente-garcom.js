// ═══════════════════════════════════════════════════════════════
//  POST /api/assistente-garcom
//  Body: { tenantId, restauranteId, texto, historico? }
//
//  Caixa única do app Garçom: a mesma pergunta pode ser uma DÚVIDA
//  ("qual o IBU do IPA?"), um COMANDO DE PEDIDO ("1 pilsen na 34") ou
//  um COMANDO DE CANCELAMENTO. Esta function decide qual é e devolve:
//    { tipo: "pergunta", resposta: "..." }
//    { tipo: "pedido", pedidos: [...] }
//    { tipo: "cancelamento", itens: [...] }
//
//  ⚠️ EM DUAS ETAPAS, DE PROPÓSITO (pra ser rápido):
//  Fichas técnicas, base de conhecimento geral e arquivos anexados só
//  servem pra responder DÚVIDA — pedido e cancelamento nunca precisam
//  disso. Antes, tudo isso (inclusive BAIXAR cada arquivo anexado e
//  converter pra base64) acontecia em TODA pergunta, mesmo pedidos
//  simples — isso que deixava lançar pedido lento. Agora:
//    Etapa 1 (sempre, leve): só cardápio + histórico. Já resolve
//      pedido/cancelamento sozinha — mais rápido, porque o texto que
//      a IA processa é bem menor e não baixa arquivo nenhum.
//    Etapa 2 (só se for dúvida de verdade): aí sim busca fichas,
//      base de conhecimento e arquivos, e responde com tudo isso.
//  Pedido/cancelamento ficam mais rápidos (1 chamada enxuta); dúvida
//  fica com uma chamada extra, mas isso é bem menos frequente que
//  lançar pedido durante o serviço.
//
//  Mesma garantia de sempre: isto SÓ interpreta. Um pedido nunca é
//  lançado por aqui — o app mostra o rascunho e só escreve no banco
//  quando o garçom confirma manualmente.
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

// ─── CHAMADA AO GEMINI COM REENVIO AUTOMÁTICO ───
function _esperar(ms){ return new Promise((r) => setTimeout(r, ms)); }
const CODIGOS_PASSAGEIROS = [429, 500, 502, 503, 504];

let _thinkingSuportado = true;
const GEMINI_MODEL_RESERVA = process.env.GEMINI_MODEL_RESERVA || 'gemini-2.5-flash-lite';
const TEMPO_MAX_TENTATIVA_MS = 9000; // chamada que "pendura" é cortada e refeita

function _urlModelo(modelo) {
  return 'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent';
}

// Tentativa 1 e 2: modelo principal. Tentativa 3: modelo reserva (quando o
// principal está sobrecarregado/limitado, o reserva costuma responder).
async function chamarGeminiComRetry(apiKey, body) {
  let ultimoErro = null;
  const plano = [GEMINI_MODEL, GEMINI_MODEL, GEMINI_MODEL_RESERVA];
  for (let i = 0; i < plano.length; i++) {
    const modelo = plano[i];
    const principal = modelo === GEMINI_MODEL;
    const corpo = JSON.parse(JSON.stringify(body));
    if (i === 0) {
      // 1ª tentativa: formato otimizado (resposta direta, pouco "raciocínio")
      if (_thinkingSuportado) {
        corpo.generationConfig = Object.assign({ thinkingConfig: { thinkingLevel: 'minimal' } }, corpo.generationConfig || {});
      }
    } else {
      // Tentativas 2 e 3: formato SIMPLES (o mesmo que sempre funcionou) —
      // sem ajustes extras que algum modelo possa recusar.
      delete corpo.generationConfig;
    }
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), TEMPO_MAX_TENTATIVA_MS);
    let resp = null;
    try {
      resp = await fetch(_urlModelo(modelo), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(corpo),
        signal: ctl.signal,
      });
    } catch (e) {
      console.error('[assistente-garcom] tentativa ' + (i + 1) + ' (' + modelo + ') sem resposta: ' + e.message);
      clearTimeout(to);
      if (i < plano.length - 1) continue;
      return ultimoErro || { ok: false, status: 0, text: async () => e.message };
    }
    clearTimeout(to);
    if (resp.ok) {
      if (i > 0) console.log('[assistente-garcom] respondeu na tentativa ' + (i + 1) + ' (' + modelo + ')');
      return resp;
    }

    const errTxt = await resp.clone().text().catch(() => '');
    console.error('[assistente-garcom] tentativa ' + (i + 1) + ' (' + modelo + ') status ' + resp.status + ': ' + errTxt.slice(0, 300));

    if (resp.status === 400 && principal && _thinkingSuportado) {
      _thinkingSuportado = false;
      i--; // repete o principal sem o ajuste
      continue;
    }
    ultimoErro = resp;
    if (CODIGOS_PASSAGEIROS.indexOf(resp.status) < 0 && resp.status !== 404) {
      if (principal) continue; // erro "estranho" no principal: ainda vale tentar o reserva
      break;
    }
    if (i === 0) await _esperar(300);
  }
  return ultimoErro;
}

async function textoDoGemini(apiKey, parts, maxTokens) {
  const t0 = Date.now();
  const resp = await chamarGeminiComRetry(apiKey, {
    contents: [{ parts }],
    generationConfig: { temperature: 0, maxOutputTokens: maxTokens || 1200, responseMimeType: 'application/json' },
  });
  console.log('[assistente-garcom] Gemini levou ' + (Date.now() - t0) + 'ms, status ' + resp.status);
  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    console.error('[assistente-garcom] Gemini falhou mesmo após tentar de novo:', resp.status, errTxt);
    return { ok: false };
  }
  const data = await resp.json();
  let texto = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '';
  texto = texto.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return { ok: true, texto };
}

// ─── CACHE EM MEMÓRIA (por instância do servidor, curta duração) ───
const _cacheContexto = {};
const _cacheArquivos = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // o aquecimento (a cada 4 min) renova antes de vencer

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
  const cardapioKg = [];
  const comFicha = [];
  itensSnap.forEach((doc) => {
    const it = doc.data() || {};
    if (it.disponivel === false) return;
    if (it.tipoVenda === 'kg') {
      cardapioKg.push({
        id: doc.id,
        nome: it.nome || '(sem nome)',
        precoPorKg: typeof it.preco === 'number' ? it.preco : 0,
      });
    } else {
      cardapioCompleto.push({
        id: doc.id,
        nome: it.nome || '(sem nome)',
        preco: typeof it.preco === 'number' ? it.preco : 0,
        precosPorHorario: Array.isArray(it.precosPorHorario) ? it.precosPorHorario : null,
        dica: (it.fichaTecnica || '').trim().slice(0, 100),
      });
    }
    if (it.fichaTecnica && it.fichaTecnica.trim()) {
      comFicha.push({ nome: it.nome || '(sem nome)', ficha: it.fichaTecnica.trim() });
    }
  });

  // Só os METADADOS dos arquivos entram no cache (nome/url/tipo) — os
  // bytes em si só são baixados na Etapa 2, e só quando realmente for
  // uma dúvida — nunca pra pedido/cancelamento.
  const arquivos = [];
  arquivosSnap.forEach((doc) => {
    const a = doc.data() || {};
    if (a.url && a.nome) arquivos.push({ nome: a.nome, url: a.url, tipo: a.tipo || 'image/png' });
  });

  const dados = { documentoGeral, cardapioCompleto, cardapioKg, comFicha, arquivos };
  _cacheContexto[chave] = { em: agora, dados };
  return dados;
}

// Preço vigente por horário (fuso de São Paulo — a Vercel roda em UTC).
function precoAtualDoItem(it) {
  const base = (it && it.preco) || 0;
  const faixas = it && it.precosPorHorario;
  if (!faixas || !faixas.length) return base;
  let minAgora;
  try {
    const partesHora = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date()).split(':');
    minAgora = (parseInt(partesHora[0], 10) % 24) * 60 + (parseInt(partesHora[1], 10) || 0);
  } catch (e) {
    const d = new Date(Date.now() - 3 * 3600 * 1000);
    minAgora = d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  let melhor = null, melhorMin = -1;
  faixas.forEach((f) => {
    if (!f || !f.inicio) return;
    const p = String(f.inicio).split(':');
    const minF = (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
    if (minF <= minAgora && minF > melhorMin) { melhor = f.preco; melhorMin = minF; }
  });
  return melhor !== null ? melhor : base;
}

module.exports = async (req, res) => {
  // GET ?aquecer=1 — pra um "despertador" externo (cron-job.org / UptimeRobot)
  // chamar de 5 em 5 minutos, com o app fechado. Só acorda o servidor, abre
  // a conexão com o Google e, se vierem tenantId/restauranteId, já carrega o
  // cardápio. Nunca devolve dado nenhum do restaurante.
  if (req.method === 'GET') {
    try {
      const q = req.query || {};
      const apiKeyG = process.env.GEMINI_API_KEY;
      const tarefas = [];
      if (apiKeyG) {
        tarefas.push((async () => {
          try {
            const ctl = new AbortController();
            const to = setTimeout(() => ctl.abort(), 6000);
            await fetch(GEMINI_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKeyG },
              body: JSON.stringify({ contents: [{ parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 4, temperature: 0 } }),
              signal: ctl.signal,
            }).then((r) => r.text()).catch(() => {});
            clearTimeout(to);
          } catch (e) {}
        })());
      }
      tarefas.push(obterContexto(getDb(), (q.tenantId || TENANT_PADRAO).toString(), (q.restauranteId || 'default').toString()).catch(() => {}));
      await Promise.all(tarefas);
      return res.status(200).json({ ok: true, aquecido: true });
    } catch (e) {
      return res.status(200).json({ ok: false });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST ou GET ?aquecer=1' });
  }

  const body = req.body || {};
  const tenantId = (body.tenantId || TENANT_PADRAO).toString();
  const restauranteId = (body.restauranteId || 'default').toString();

  // Aquecimento: só acorda a função e carrega o contexto no cache. Sem Gemini.
  if (body.aquecer) {
    try {
      // Carrega o cardápio E faz uma chamada mínima ao Gemini, pra conexão
      // (TLS) com o Google já estar aberta quando a pergunta de verdade chegar.
      const apiKeyW = process.env.GEMINI_API_KEY;
      const pingGemini = apiKeyW ? (async () => {
        try {
          const ctl = new AbortController();
          const to = setTimeout(() => ctl.abort(), 6000);
          await fetch(GEMINI_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKeyW },
            body: JSON.stringify({ contents: [{ parts: [{ text: 'ok' }] }], generationConfig: { maxOutputTokens: 4, temperature: 0 } }),
            signal: ctl.signal,
          }).then((r) => r.text()).catch(() => {});
          clearTimeout(to);
        } catch (e) {}
      })() : Promise.resolve();
      await Promise.all([obterContexto(getDb(), tenantId, restauranteId), pingGemini]);
      return res.status(200).json({ ok: true, aquecido: true });
    } catch (e) {
      return res.status(200).json({ ok: false });
    }
  }
  const texto = (body.texto || '').toString().trim();
  const historico = Array.isArray(body.historico) ? body.historico.slice(-12) : [];

  if (!texto) return res.status(400).json({ ok: false, error: 'Falta o texto' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY não configurada no servidor.' });

  try {
    const db = getDb();
    const ctx = await obterContexto(db, tenantId, restauranteId);
    const { documentoGeral, cardapioKg, comFicha, arquivos } = ctx;
    const cardapioCompleto = ctx.cardapioCompleto.map((it) => Object.assign({}, it, { preco: precoAtualDoItem(it) }));

    const listaCardapio = cardapioCompleto.map((it, i) =>
      `${i + 1}. ${it.nome} [id:${it.id}]${it.dica ? ` — ${it.dica}` : ''}`
    ).join('\n');
    const listaCardapioKg = cardapioKg.map((it, i) =>
      `${i + 1}. ${it.nome} [id:${it.id}] — R$ ${it.precoPorKg.toFixed(2)}/kg`
    ).join('\n');
    const blocoHistorico = historico.length
      ? '\n\nHISTÓRICO RECENTE DESTA CONVERSA (mais antigo primeiro):\n' +
        historico.map((h) => `${h.autor === 'usuario' ? 'Funcionário' : h.autor === 'sistema' ? 'Sistema' : 'Você'}: ${h.texto}`).join('\n') +
        '\n\nUse este histórico SÓ pra entender referências à troca anterior ' +
        '(ex: "muda pra 3", "na verdade era o IPA", "cancela aquele"). Nunca ' +
        'repita uma ação que o histórico já mostra como CONFIRMADA — se o ' +
        'funcionário só comentar sobre algo já confirmado, trate como ' +
        'PERGUNTA, não como novo pedido/cancelamento.'
      : '';

    // ═══ ETAPA 1 — leve e rápida: classifica E já resolve pedido/cancelamento ═══
    const promptEtapa1 =
`Você é o assistente do app de um garçom de restaurante. O texto abaixo pode
ser UMA DAS QUATRO COISAS:

(A) Uma DÚVIDA sobre produto (IBU, teor alcoólico, ingredientes, alérgenos)
    ou sobre o restaurante (horário, promoção, política).
(B) Um COMANDO DE PEDIDO pra lançar numa mesa (ex: "1 pilsen na 34", "2
    chopp mesa 12 e 1 coca na 8").
(C) Um COMANDO DE CANCELAMENTO de item já pedido (ex: "cancelar 1 pilsen
    da mesa 10", "tira a coca da 15", "cancela o chopp mesa 8").
(D) Um COMANDO PRA FECHAR/ABRIR A CONTA DE UMA PESSOA pelo NOME, sem dizer
    o número da mesa (ex: "fechar a conta da Sara", "fecha o Fernando",
    "conta da Beatriz", "onde está o João", "fechar da Maria").

Decida qual das quatro é e responda SOMENTE com um JSON válido, sem texto
antes ou depois, sem marcação de código — só o JSON puro.

SE FOR DÚVIDA, responda SÓ isto (a resposta de verdade vem numa etapa
seguinte, com mais informação disponível — aqui é só classificar):
{"tipo":"pergunta"}

SE FOR PEDIDO:
{"tipo":"pedido","pedidos":[{"mesa":34,"itemId":"abc123","quantidade":1,"obs":""}]}
- "itemId" deve ser exatamente um [id:...] da lista de cardápio abaixo.
  NUNCA invente um id que não esteja na lista.
- O texto pode vir de reconhecimento de voz, então pode ter erros de
  grafia/som parecido (ex: "pilsom" por "pilsen", "ipa" ouvido como "ipá"
  ou "aipa", "cocazero" grudado). Tente reconhecer o item mesmo com esse
  tipo de erro fonético, comparando pela PRONÚNCIA/semelhança, não só pela
  escrita exata. Só use "itemId": null (com "nomeDigitado" preenchido) se
  genuinamente não conseguir identificar qual item da lista é, mesmo
  considerando possível erro de voz.
- Pode haver mais de um item com o MESMO NOME no cardápio — nesse caso,
  cada um deles tem uma "dica" diferente (texto depois do "—" na lista),
  que é como esse item específico costuma ser pedido. Se o funcionário
  mencionar algo que bate com a dica de um deles (ex: "alcatra do dia"
  batendo com a dica "Alcatra do dia"), escolha ESSE id específico, não
  o primeiro da lista com aquele nome.
- ITEM POR KG (lista separada "CARDÁPIO POR KG" abaixo — ex: prato de
  buffet pesado na balança): quando o funcionário mencionar um desses
  itens, o objeto do pedido usa um formato DIFERENTE:
  {"mesa":32,"itemId":"xyz","tipoVenda":"kg","valorTotal":24.32}
  ou, se ele disser o peso em vez do valor já calculado:
  {"mesa":32,"itemId":"xyz","tipoVenda":"kg","pesoGramas":350}
  Use "valorTotal" quando o funcionário disser um valor em reais (ex: "um
  prato de 24,32 na mesa 32" — isso é o valor que já saiu na balança,
  use exatamente esse número, não tente adivinhar peso). Use "pesoGramas"
  quando ele disser peso/gramas (ex: "350 gramas de buffet na 10"). NUNCA
  preencha os dois ao mesmo tempo. Itens por kg NÃO têm "quantidade" nem
  "obs" — ignore esses campos pra eles.
- ATALHO COMUM PRA ITEM POR KG, PRIORIDADE ALTA: garçom apressado costuma
  digitar/falar SÓ NÚMEROS, sem citar o nome do produto — ex: "34,15-26",
  "34,15 - 26", "24,32 mesa 10", "17,90, 5", "29,90 na mesa 8". Mesmo SEM
  nenhuma palavra de comida, esse padrão (um número com vírgula/decimal +
  um número inteiro, separados por traço, vírgula, espaço ou "mesa") É um
  pedido de item por kg: o número COM decimal é o valor em reais da
  pesagem, o número INTEIRO é a mesa — NUNCA o contrário, nunca duas
  mesas. Se a lista "CARDÁPIO POR KG" tiver exatamente UM item, SEMPRE
  interprete esse padrão como pedido desse item usando "valorTotal" —
  não precisa o funcionário citar o nome do prato nenhuma vez. Se a lista
  por kg tiver mais de um item e não der pra saber qual dos dois pelo
  texto, retorne com itemId null e nomeDigitado "valor da pesagem sem
  produto identificado" em vez de chutar qual dos dois é.
- NUNCA ESCOLHA UM ITEM (por unidade OU por kg) QUE NÃO FOI CLARAMENTE
  MENCIONADO NO TEXTO, só porque "tem que escolher algum". Isso vale
  mesmo quando o texto é confuso ou só tem números (fora do atalho de kg
  acima). Errar escolhendo o item errado é MUITO PIOR do que admitir que
  não entendeu — um item errado pode sair pra cozinha com nome e preço
  que não têm nada a ver com o que foi pedido. Na dúvida genuína, use
  "itemId": null.
- NOME DO CLIENTE (opcional): se o funcionário disser o nome da pessoa
  dona do pedido (ex: "um prato de 34,15 na mesa 30, nome Fernando",
  "um na 15 de 24,15 pra Beatriz", "cliente Sara"), preencha "cliente"
  com SÓ o primeiro nome/nome falado, com inicial maiúscula, em TODO objeto
  de pedido ligado àquela pessoa. Funciona tanto pra item por kg quanto
  por unidade. NUNCA invente nome; se não foi dito, omita o campo ou "".
  O nome NÃO faz parte do item nem da mesa — não confunda número de mesa
  com nome. Exemplo completo:
  "um prato de 34,15 na mesa 30 nome Fernando e um na 15 de 24,15 nome Beatriz"
  → {"tipo":"pedido","pedidos":[
     {"mesa":30,"itemId":"xyz","tipoVenda":"kg","valorTotal":34.15,"cliente":"Fernando"},
     {"mesa":15,"itemId":"xyz","tipoVenda":"kg","valorTotal":24.15,"cliente":"Beatriz"}]}
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

SE FOR FECHAR CONTA POR NOME:
{"tipo":"fechar","nome":"Sara"}
- "nome" é SÓ o nome da pessoa como foi falado (primeiro nome ou nome
  completo), com inicial maiúscula, sem "conta da", "mesa" ou outras
  palavras. Se o funcionário já falou o NÚMERO DA MESA ("fechar a mesa 12"),
  isso NÃO é este caso — o app já tem outro caminho pra isso: responda
  {"tipo":"fechar","nome":"","mesa":12}.

SE FOR CANCELAMENTO:
{"tipo":"cancelamento","itens":[{"mesa":10,"nomeDigitado":"pilsen","quantidade":1}]}
- "nomeDigitado" é só o texto do produto como foi falado — NÃO tente casar
  com um id do cardápio aqui (o app faz essa checagem depois, olhando o que
  realmente está na conta daquela mesa agora).
- Cada combinação mesa+item é um objeto separado.

CARDÁPIO DISPONÍVEL (pra uso em PEDIDO):
${listaCardapio}
${listaCardapioKg ? `\nCARDÁPIO POR KG (pratos pesados — ver regras de ITEM POR KG acima):\n${listaCardapioKg}` : ''}${blocoHistorico}

TEXTO (mensagem ATUAL do funcionário — interprete este, usando o histórico acima só como apoio):
"${texto}"`;

    const r1 = await textoDoGemini(apiKey, [{ text: promptEtapa1 }], 1500);
    if (!r1.ok) {
      return res.status(502).json({ ok: false, error: 'Assistente indisponível no momento — tenta de novo em alguns segundos.' });
    }

    let parsed;
    try {
      parsed = JSON.parse(r1.texto);
    } catch (e) {
      console.error('[assistente-garcom] JSON inválido (etapa 1):', r1.texto);
      return res.status(200).json({ ok: true, tipo: 'pergunta', resposta: 'Não consegui entender. Tenta reformular.' });
    }

    if (parsed.tipo === 'pedido') {
      const brutos = Array.isArray(parsed.pedidos) ? parsed.pedidos : [];
      const resultado = brutos.map((p) => {
        const mesa = parseInt(p.mesa, 10);
        if (isNaN(mesa)) return null;
        const cliente = (p.cliente || '').toString().trim().slice(0, 40);

        if (p.tipoVenda === 'kg') {
          const itemKg = p.itemId ? cardapioKg.find((c) => c.id === p.itemId) : null;
          if (!itemKg) {
            return { mesa, cliente, tipoVenda: 'kg', encontrado: false, nomeDigitado: p.nomeDigitado || null };
          }
          let valorTotal = null;
          let pesoGramas = null;
          if (typeof p.valorTotal === 'number' && p.valorTotal > 0) {
            valorTotal = Math.round(p.valorTotal * 100) / 100;
          } else if (typeof p.pesoGramas === 'number' && p.pesoGramas > 0) {
            pesoGramas = Math.round(p.pesoGramas);
            valorTotal = Math.round((pesoGramas / 1000) * itemKg.precoPorKg * 100) / 100;
          }
          if (valorTotal === null) {
            return { mesa, cliente, tipoVenda: 'kg', encontrado: false, nomeDigitado: itemKg.nome };
          }
          return {
            mesa, cliente, tipoVenda: 'kg', encontrado: true,
            itemId: itemKg.id, itemNome: itemKg.nome,
            precoBase: itemKg.precoPorKg, peso: pesoGramas, itemPreco: valorTotal,
          };
        }

        const qtd = Math.max(1, parseInt(p.quantidade, 10) || 1);
        const item = p.itemId ? cardapioCompleto.find((c) => c.id === p.itemId) : null;
        return {
          mesa, cliente, quantidade: qtd,
          itemId: item ? item.id : null,
          itemNome: item ? item.nome : null,
          itemPreco: item ? item.preco : null,
          encontrado: !!item,
          nomeDigitado: p.nomeDigitado || null,
          obs: (p.obs || '').toString().trim().slice(0, 140),
        };
      }).filter((p) => p !== null);

      return res.status(200).json({ ok: true, tipo: 'pedido', pedidos: resultado });
    }

    if (parsed.tipo === 'fechar') {
      const nome = (parsed.nome || '').toString().trim().slice(0, 60);
      const mesaF = parseInt(parsed.mesa, 10);
      return res.status(200).json({ ok: true, tipo: 'fechar', nome, mesa: isNaN(mesaF) ? null : mesaF });
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

    // ═══ ETAPA 2 — só roda aqui: era dúvida de verdade. Agora sim busca
    // fichas técnicas, base de conhecimento e arquivos, e baixa os
    // arquivos (isso que é pesado) — nada disso rodou na Etapa 1. ═══
    const blocoFichas = comFicha.length
      ? comFicha.map((it, i) => `[${i + 1}] ${it.nome}\n${it.ficha}`).join('\n\n')
      : '(nenhum item com ficha técnica cadastrada)';
    const blocoGeral = documentoGeral ? `\n\nBASE DE CONHECIMENTO GERAL:\n${documentoGeral.slice(0, 40000)}` : '';

    const arquivosPraUsar = (arquivos || []).slice(0, 10);
    const tArq = Date.now();
    const resultadosArq = await Promise.all(arquivosPraUsar.map(async (a) => {
      try {
        const c = _cacheArquivos[a.url];
        if (c && (Date.now() - c.em) < 30 * 60 * 1000) return { a, b64: c.b64 };
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(a.url, { signal: ctl.signal });
        clearTimeout(to);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) throw new Error('arquivo grande demais');
        const b64 = buf.toString('base64');
        _cacheArquivos[a.url] = { em: Date.now(), b64 };
        return { a, b64 };
      } catch (e) {
        console.error('[assistente-garcom] falhou ao carregar arquivo', a.nome, e.message);
        return null;
      }
    }));
    const partesArquivos = [];
    resultadosArq.forEach((x) => {
      if (!x) return;
      partesArquivos.push({ text: `Arquivo anexado: "${x.a.nome}"` });
      partesArquivos.push({ inline_data: { mime_type: x.a.tipo, data: x.b64 } });
    });
    console.log('[assistente-garcom] arquivos prontos em ' + (Date.now() - tArq) + 'ms');

    const promptEtapa2 =
`Você é o assistente de um restaurante, respondendo a dúvida de um
funcionário. Responda SOMENTE com base nas fichas técnicas, na base de
conhecimento e nos arquivos anexados abaixo (se houver). NUNCA invente um
valor técnico. Se não estiver cadastrado nem nos arquivos, diga isso
claramente. SEMPRE que a resposta vier de um arquivo anexado (imagem ou
PDF), é OBRIGATÓRIO citar o nome dele EXATAMENTE como foi dado no texto
"Arquivo anexado: ..." — sem alterar maiúscula/minúscula, sem abreviar,
em algum ponto da resposta.

Responda em português do Brasil, em até 2 frases, direto ao ponto.
Responda SOMENTE com um JSON válido, sem texto antes ou depois, sem
marcação de código: {"resposta":"texto da resposta"}

FICHAS TÉCNICAS DE ITENS:
${blocoFichas}${blocoGeral}
${arquivosPraUsar.length ? `\n\n${arquivosPraUsar.length} arquivo(s) anexado(s) abaixo — leia o conteúdo deles diretamente.` : ''}${blocoHistorico}

PERGUNTA (mensagem ATUAL do funcionário):
"${texto}"`;

    const parts2 = [{ text: promptEtapa2 }, ...partesArquivos];
    const r2 = await textoDoGemini(apiKey, parts2, 700);
    if (!r2.ok) {
      return res.status(502).json({ ok: false, error: 'Assistente indisponível no momento — tenta de novo em alguns segundos.' });
    }

    let parsed2;
    try {
      parsed2 = JSON.parse(r2.texto);
    } catch (e) {
      parsed2 = { resposta: r2.texto };
    }

    const respostaTexto = (parsed2.resposta || 'Não consegui gerar uma resposta agora.').trim();
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
