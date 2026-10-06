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

// ─── CHAMADA AO GEMINI COM REENVIO AUTOMÁTICO ───
// A própria API do Gemini, de vez em quando, devolve um erro passageiro
// (sobrecarga momentânea, limite de uso por segundo) — não é bug nosso, é
// normal em qualquer API de IA. Antes, isso virava "assistente
// indisponível" na hora, e a pessoa tinha que perguntar de novo na mão
// pra funcionar (o que sempre funcionava, confirmando que era passageiro).
// Agora o servidor tenta sozinho, até 2 vezes a mais, com uma pausa curta
// entre tentativas — só erro de verdade (ou 3 tentativas sem sucesso)
// chega a aparecer pro usuário.
function _esperar(ms){ return new Promise((r) => setTimeout(r, ms)); }
const CODIGOS_PASSAGEIROS = [429, 500, 502, 503, 504];

async function chamarGeminiComRetry(apiKey, body) {
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const resp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (resp.ok) return resp;

    ultimoErro = resp;
    if (CODIGOS_PASSAGEIROS.indexOf(resp.status) < 0) break; // erro que não é passageiro — não adianta tentar de novo
    if (tentativa < 3) await _esperar(tentativa * 500); // 500ms, depois 1000ms
  }
  return ultimoErro;
}

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
  const cardapioKg = []; // itens vendidos por peso (ex: prato de buffet) — separados dos de unidade
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
      // A Ficha técnica também entra aqui (resumida) — é o que permite
      // diferenciar itens de MESMO NOME na hora de montar um pedido (ex:
      // três itens chamados "Alcatra Grelhada", cada um com uma nota
      // diferente escrita na ficha, tipo "Alcatra do dia").
      cardapioCompleto.push({
        id: doc.id,
        nome: it.nome || '(sem nome)',
        preco: typeof it.preco === 'number' ? it.preco : 0,
        dica: (it.fichaTecnica || '').trim().slice(0, 100),
      });
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

  const dados = { documentoGeral, cardapioCompleto, cardapioKg, comFicha, arquivos };
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
  // Histórico curto da conversa atual (opcional — só o chat do app manda
  // isso; a caixa simples da tela de mesas não manda, então cada pergunta
  // continua sendo tratada isolada ali, como sempre foi). Usado só pra
  // entender referências tipo "muda pra 3" se referindo à troca anterior —
  // nunca pra inventar dado novo que não esteja em nenhum deles.
  const historico = Array.isArray(body.historico) ? body.historico.slice(-12) : [];

  if (!texto) return res.status(400).json({ ok: false, error: 'Falta o texto' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY não configurada no servidor.' });

  try {
    const db = getDb();
    const { documentoGeral, cardapioCompleto, cardapioKg, comFicha, arquivos } = await obterContexto(db, tenantId, restauranteId);

    const listaCardapio = cardapioCompleto.map((it, i) =>
      `${i + 1}. ${it.nome} [id:${it.id}]${it.dica ? ` — ${it.dica}` : ''}`
    ).join('\n');
    const listaCardapioKg = cardapioKg.map((it, i) =>
      `${i + 1}. ${it.nome} [id:${it.id}] — R$ ${it.precoPorKg.toFixed(2)}/kg`
    ).join('\n');
    const blocoFichas = comFicha.length
      ? comFicha.map((it, i) => `[${i + 1}] ${it.nome}\n${it.ficha}`).join('\n\n')
      : '(nenhum item com ficha técnica cadastrada)';
    const blocoGeral = documentoGeral ? `\n\nBASE DE CONHECIMENTO GERAL:\n${documentoGeral.slice(0, 40000)}` : '';

    const blocoHistorico = historico.length
      ? '\n\nHISTÓRICO RECENTE DESTA CONVERSA (mais antigo primeiro):\n' +
        historico.map((h) => `${h.autor === 'usuario' ? 'Funcionário' : h.autor === 'sistema' ? 'Sistema' : 'Você'}: ${h.texto}`).join('\n') +
        '\n\nUse este histórico SÓ pra entender referências à troca anterior ' +
        '(ex: "muda pra 3", "na verdade era o IPA", "cancela aquele"). Nunca ' +
        'repita uma ação que o histórico já mostra como CONFIRMADA — se o ' +
        'funcionário só comentar sobre algo já confirmado, trate como ' +
        'PERGUNTA, não como novo pedido/cancelamento.'
      : '';

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
${listaCardapioKg ? `\nCARDÁPIO POR KG (pratos pesados — ver regras de ITEM POR KG acima):\n${listaCardapioKg}` : ''}${blocoHistorico}

TEXTO (mensagem ATUAL do funcionário — interprete este, usando o histórico acima só como apoio):
"${texto}"`;

    const parts = [{ text: prompt }, ...partesArquivos];

    const geminiResp = await chamarGeminiComRetry(apiKey, { contents: [{ parts: parts }] });

    if (!geminiResp.ok) {
      const errTxt = await geminiResp.text().catch(() => '');
      console.error('[assistente-garcom] Gemini falhou mesmo após tentar de novo:', geminiResp.status, errTxt);
      return res.status(502).json({ ok: false, error: 'Assistente indisponível no momento — tenta de novo em alguns segundos.' });
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
        if (isNaN(mesa)) return null;

        // ── Item por kg (prato de buffet pesado) — formato separado ──
        if (p.tipoVenda === 'kg') {
          const itemKg = p.itemId ? cardapioKg.find((c) => c.id === p.itemId) : null;
          if (!itemKg) {
            return {
              mesa, tipoVenda: 'kg', encontrado: false,
              nomeDigitado: p.nomeDigitado || null,
            };
          }
          let valorTotal = null;
          let pesoGramas = null;
          if (typeof p.valorTotal === 'number' && p.valorTotal > 0) {
            valorTotal = Math.round(p.valorTotal * 100) / 100; // confia no valor dito (já saiu da balança)
          } else if (typeof p.pesoGramas === 'number' && p.pesoGramas > 0) {
            pesoGramas = Math.round(p.pesoGramas);
            valorTotal = Math.round((pesoGramas / 1000) * itemKg.precoPorKg * 100) / 100;
          }
          if (valorTotal === null) {
            return { mesa, tipoVenda: 'kg', encontrado: false, nomeDigitado: itemKg.nome };
          }
          return {
            mesa, tipoVenda: 'kg', encontrado: true,
            itemId: itemKg.id, itemNome: itemKg.nome,
            precoBase: itemKg.precoPorKg, peso: pesoGramas, itemPreco: valorTotal,
          };
        }

        // ── Item normal (por unidade) ──
        const qtd = Math.max(1, parseInt(p.quantidade, 10) || 1);
        const item = p.itemId ? cardapioCompleto.find((c) => c.id === p.itemId) : null;
        return {
          mesa, quantidade: qtd,
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
