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
const _reserva = { modelo: null, em: 0 };
const _reservaExcluidos = new Set();

// Descobre, na própria conta do Google, um modelo "flash" rápido que EXISTA
// (nomes de modelo mudam/são aposentados com o tempo — nada de nome fixo).
// Monta uma lista VARIADA de modelos reserva que existem na conta: primeiro
// um "flash" comum (outra fila de capacidade do Google, costuma aguentar o
// pico quando os "lite" estão sobrecarregados), depois um "lite" diferente.
async function _listaReservas(apiKey) {
  if (process.env.GEMINI_MODEL_RESERVA) return process.env.GEMINI_MODEL_RESERVA.split(',').map((x) => x.trim()).filter(Boolean);
  if (_reserva.lista && (Date.now() - _reserva.em) < 60 * 60 * 1000) return _reserva.lista.filter((n) => !_reservaExcluidos.has(n));
  let lista = [];
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
      headers: { 'x-goog-api-key': apiKey }, signal: ctl.signal,
    });
    clearTimeout(to);
    const j = await r.json();
    const nomes = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => /^gemini-\d+(\.\d+)?-flash(-lite)?(-\d{3})?$/.test(n) || /^gemini-flash(-lite)?-latest$/.test(n))
      .filter((n) => n !== GEMINI_MODEL);
    const ord = (arr) => arr.sort((a, b) => ((/preview/.test(a) ? 1 : 0) - (/preview/.test(b) ? 1 : 0)) || (a < b ? 1 : -1));
    const lites = ord(nomes.filter((n) => /lite/.test(n)));
    const flashes = ord(nomes.filter((n) => !/lite/.test(n)));
    for (let i = 0; i < Math.max(lites.length, flashes.length); i++) {
      if (flashes[i]) lista.push(flashes[i]);
      if (lites[i]) lista.push(lites[i]);
    }
    console.log('[assistente-garcom] reservas: ' + lista.slice(0, 6).join(', '));
  } catch (e) {
    console.error('[assistente-garcom] não consegui listar modelos: ' + e.message);
  }
  if (!lista.length) lista = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
  _reserva.lista = lista; _reserva.em = Date.now();
  return lista.filter((n) => !_reservaExcluidos.has(n));
}
// Modelo que acabou de falhar fica "de castigo" por um tempo: sobrecarga (503)
// 2 min; sem cota (429) 15 min. Assim o próximo pedido já vai direto no
// modelo que está respondendo, sem perder tempo tentando o que está caído.
const _esfriando = {};
function _esfriar(modelo, ms) { if (modelo) _esfriando[modelo] = Date.now() + ms; }
function _estaEsfriando(modelo) { return (_esfriando[modelo] || 0) > Date.now(); }

async function _resolverReserva(apiKey, n) {
  const todas = await _listaReservas(apiKey);
  const l = todas.filter((m) => !_estaEsfriando(m)).concat(todas.filter((m) => _estaEsfriando(m)));
  return l[Math.min(n || 0, l.length - 1)] || 'gemini-flash-latest';
}
const TEMPO_MAX_TOTAL_MS = 28000; // limite de cada chamada (o Google às vezes demora)

function _urlModelo(modelo) {
  return 'https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent';
}

// Chamadas "em corrida": a 1ª sai na hora e NÃO é cortada cedo (o Google às
// vezes leva 10-20s e ainda responde). Se demorar, uma 2ª (modelo reserva) e
// depois uma 3ª saem EM PARALELO — vale quem responder primeiro. Se alguma
// falhar antes, a próxima sai na hora, sem esperar o tempo.
function chamarGeminiComRetry(apiKey, body) {
  const plano = _estaEsfriando(GEMINI_MODEL) ? [
    // Principal sobrecarregado agora há pouco: começa pelo reserva
    { modelo: null, reserva: true, nReserva: 0, otimizado: false, atraso: 0 },
    { modelo: null, reserva: true, nReserva: 1, otimizado: false, atraso: 2500 },
    { modelo: GEMINI_MODEL, otimizado: true, atraso: 5000 },
  ] : [
    { modelo: GEMINI_MODEL, otimizado: true, atraso: 0 },
    { modelo: null, reserva: true, nReserva: 0, otimizado: false, atraso: 2500 },
    { modelo: null, reserva: true, nReserva: 1, otimizado: false, atraso: 5500 },
    { modelo: GEMINI_MODEL, otimizado: false, atraso: 10000 },
  ];
  const falhas = [];
  const controles = [];
  const timers = [];

  return new Promise((resolve) => {
    let lancadas = 0, pendentes = 0, terminou = false, ultimoErro = null;

    const finalizar = (resp) => {
      if (terminou) return;
      terminou = true;
      timers.forEach(clearTimeout);
      if (resp && resp.ok) {
        controles.forEach((c) => { if (c.resp !== resp) { try { c.ctl.abort(); } catch (e) {} } });
        controles.forEach((c) => clearTimeout(c.to));
        return resolve(resp);
      }
      const err = ultimoErro || { ok: false, status: 0, text: async () => (falhas.join(' | ') || 'sem resposta') };
      try { err._falhas = falhas; } catch (e) {}
      resolve(err);
    };

    const lancarProxima = () => {
      if (terminou || lancadas >= plano.length) return false;
      const idx = lancadas++;
      const p = plano[idx];
      pendentes++;
      const corpo = JSON.parse(JSON.stringify(body));
      if (p.otimizado) {
        if (_thinkingSuportado) {
          corpo.generationConfig = Object.assign({ thinkingConfig: { thinkingLevel: 'minimal' } }, corpo.generationConfig || {});
        }
      } else {
        delete corpo.generationConfig; // formato simples, o mesmo de sempre
      }
      const ctl = new AbortController();
      const reg = { ctl, resp: null, to: setTimeout(() => ctl.abort(), TEMPO_MAX_TOTAL_MS) };
      controles.push(reg);
      const t0 = Date.now();

      (p.reserva ? _resolverReserva(apiKey, p.nReserva) : Promise.resolve(p.modelo)).then((modeloUsado) => {
        p.modeloUsado = modeloUsado;
        return fetch(_urlModelo(modeloUsado), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(corpo),
          signal: ctl.signal,
        });
      }).then(async (resp) => {
        pendentes--;
        if (terminou) return;
        if (resp.ok) {
          reg.resp = resp;
          console.log('[assistente-garcom] tentativa ' + (idx + 1) + ' (' + (p.modeloUsado || p.modelo) + ') respondeu em ' + (Date.now() - t0) + 'ms');
          return finalizar(resp);
        }
        const errTxt = await resp.clone().text().catch(() => '');
        console.error('[assistente-garcom] tentativa ' + (idx + 1) + ' (' + (p.modeloUsado || p.modelo) + ') status ' + resp.status + ': ' + errTxt.slice(0, 300));
        let msgErro = errTxt;
        try { const je = JSON.parse(errTxt); if (je && je.error && je.error.message) msgErro = je.error.message; } catch (e) {}
        falhas.push((p.modeloUsado || p.modelo) + ' ' + resp.status + ': ' + String(msgErro).replace(/\s+/g, ' ').slice(0, 140));
        if (resp.status === 400 && p.otimizado) _thinkingSuportado = false;
        if (resp.status === 404 && p.reserva) { _reservaExcluidos.add(p.modeloUsado); }
        if (resp.status === 503 || resp.status === 500) _esfriar(p.modeloUsado || p.modelo, 2 * 60 * 1000);
        if (resp.status === 429) _esfriar(p.modeloUsado || p.modelo, 15 * 60 * 1000);
        ultimoErro = resp;
        if (pendentes === 0 && !lancarProxima()) finalizar(null);
      }).catch((e) => {
        pendentes--;
        if (terminou) return;
        console.error('[assistente-garcom] tentativa ' + (idx + 1) + ' (' + (p.modeloUsado || p.modelo) + ') sem resposta após ' + (Date.now() - t0) + 'ms: ' + e.message);
        falhas.push((p.modeloUsado || p.modelo) + ': sem resposta (' + e.message + ')');
        if (pendentes === 0 && !lancarProxima()) finalizar(null);
      });
      return true;
    };

    lancarProxima();
    // Reforços agendados (só saem se ainda não houve resposta)
    plano.slice(1).forEach((p) => {
      timers.push(setTimeout(() => { if (!terminou) lancarProxima(); }, p.atraso));
    });
  });
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
    return { ok: false, detalhe: ((resp._falhas || []).join(' | ') || ('status ' + resp.status)).slice(0, 380) };
  }
  const data = await resp.json();
  let texto = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '';
  texto = texto.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  return { ok: true, texto };
}


// Chamada direta a UM modelo específico (usada pro "modelo esperto").
async function textoDoModelo(apiKey, parts, maxTokens, modelo, tempoMs) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), tempoMs || 15000);
  try {
    const resp = await fetch(_urlModelo(modelo), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, maxOutputTokens: maxTokens || 1500 } }),
      signal: ctl.signal,
    });
    clearTimeout(to);
    if (!resp.ok) {
      if (resp.status === 503 || resp.status === 500) _esfriar(modelo, 2 * 60 * 1000);
      if (resp.status === 429) _esfriar(modelo, 15 * 60 * 1000);
      console.error('[assistente-garcom] modelo esperto ' + modelo + ' status ' + resp.status);
      return { ok: false };
    }
    const data = await resp.json();
    let texto = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts.map((p) => p.text || '').join('')) || '';
    texto = texto.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    console.log('[assistente-garcom] modelo esperto ' + modelo + ' levou ' + (Date.now() - t0) + 'ms');
    return { ok: true, texto };
  } catch (e) {
    clearTimeout(to);
    console.error('[assistente-garcom] modelo esperto ' + modelo + ' sem resposta: ' + e.message);
    return { ok: false };
  }
}

// Modelo "mais inteligente" pros casos difíceis: um flash COMUM (não lite)
// que exista na conta e não esteja de castigo.
async function _modeloEsperto(apiKey) {
  if (process.env.GEMINI_MODEL_ESPERTO) return process.env.GEMINI_MODEL_ESPERTO;
  const lista = await _listaReservas(apiKey);
  return lista.find((n) => !/lite/.test(n) && !_estaEsfriando(n)) || lista.find((n) => !_estaEsfriando(n)) || null;
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

  const [restDoc, itensSnap, arquivosSnap, gruposSnap, apelidosSnap] = await Promise.all([
    db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId).get(),
    db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId)
      .collection('cardapio').doc('data').collection('itens').get(),
    db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId)
      .collection('assistente_arquivos').get(),
    db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId)
      .collection('cardapio').doc('data').collection('grupos_opcoes').get().catch(() => null),
    db.collection('tenants').doc(tenantId).collection('restaurantes').doc(restauranteId)
      .collection('assistente_apelidos').get().catch(() => null),
  ]);
  // Apelidos aprendidos (quando o garçom escolhe o item certo na confirmação)
  const apelidos = [];
  if (apelidosSnap) apelidosSnap.forEach((d) => {
    const a = d.data() || {};
    if (a.texto && a.itemId) apelidos.push({ texto: String(a.texto), itemId: String(a.itemId), garcom: a.garcom || '', em: a.em || 0 });
  });

  // Grupos de opções/adicionais (ex: "Trocar por batata palito +4,90")
  const grupos = {};
  if (gruposSnap) gruposSnap.forEach((d) => {
    const g = d.data() || {};
    grupos[d.id] = {
      nome: g.nome || '', tipo: g.tipo || 'opcao',
      opcoes: (g.opcoes || []).map((o) => ({
        nome: (o && o.nome) || '', precoExtra: parseFloat(o && o.precoExtra) || 0,
        pausado: !!(o && o.pausado === true && (!o.pausadoAte || o.pausadoAte > Date.now())),
      })),
    };
  });

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
        voz: (it.palavrasVoz || '').toString().trim().slice(0, 120),
        gruposIds: Array.isArray(it.gruposIds) ? it.gruposIds : [],
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

  const dados = { documentoGeral, cardapioCompleto, cardapioKg, comFicha, arquivos, grupos, apelidos };
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


// Busca de reserva por nome, quando o modelo não identificar o item:
// ignora acento/maiúscula, compara palavra por palavra com o nome E com as
// "palavras de voz" do item. Só aceita se houver UM item claramente melhor.
function _normTxt(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function _palavras(t) {
  const vazias = { de: 1, da: 1, do: 1, das: 1, dos: 1, a: 1, o: 1, as: 1, os: 1, um: 1, uma: 1, na: 1, no: 1, e: 1, pra: 1, para: 1, mesa: 1 };
  return _normTxt(t).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter((w) => w && !vazias[w] && !/^\d+$/.test(w));
}
function _pontuar(falado, alvo) {
  const ditas = _palavras(falado);
  if (!ditas.length) return 0;
  const doAlvo = _palavras(alvo);
  let ac = 0;
  ditas.forEach((w) => {
    const raiz = w.length > 4 ? w.slice(0, w.length - 1) : w;
    if (doAlvo.some((x) => x === w || x.indexOf(raiz) === 0)) ac++;
  });
  return ac / ditas.length;
}
function _acharItemPorNome(falado, lista) {
  if (!falado) return null;
  const ranq = lista.map((it) => {
    const p1 = _pontuar(falado, it.nome);
    const p2 = it.voz ? Math.max.apply(null, String(it.voz).split(/[,;\/]/).map((v) => _pontuar(falado, v)).concat([0])) : 0;
    // também ao contrário: todas as palavras de uma "palavra de voz" estão no texto
    const p3 = it.voz ? Math.max.apply(null, String(it.voz).split(/[,;\/]/).map((v) => v.trim() ? _pontuar(v, falado) : 0).concat([0])) : 0;
    return { it, p: Math.max(p1, p2, p3) };
  }).filter((o) => o.p >= 1);
  if (ranq.length === 1) return ranq[0].it;
  return null; // nenhum ou mais de um: melhor não chutar
}


// ═══ ATALHO LOCAL (sem IA) pra pedidos SIMPLES ═══
// "1 coca na 13", "2 chopp e 1 agua sem gas na 5", "34,15 na 30".
// Resolve na hora, sem depender do Google (que fica sobrecarregado no
// horário de almoço). Só é usado quando TODOS os itens batem com UM único
// item do cardápio; qualquer dúvida (nome ambíguo, observação, nome de
// cliente, outra ação) cai pra IA normalmente.
// Mais rígido que _acharItemPorNome: TODAS as palavras ditas têm que estar no
// nome do item (ou numa palavra de voz dele), e só UM item pode bater.
function _acharItemRapido(falado, lista) {
  const ok = lista.filter((it) => {
    if (_pontuar(falado, it.nome) >= 1) return true;
    return it.voz ? String(it.voz).split(/[,;\/]/).some((v) => v.trim() && _pontuar(falado, v) >= 1) : false;
  });
  return ok.length === 1 ? ok[0] : null;
}
const _NUM_PALAVRA = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10 };
function _interpretarRapido(texto, cardapio, cardapioKg, kgPadrao, mesaPadrao) {
  let t = _normTxt(texto).replace(/[!?.]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120) return null;
  // verbos de "lançar" no começo
  t = t.replace(/^(e mais|mais|e)\s+/, '');
  t = t.replace(/^(lanca|lance|manda|mande|traz|traga|poe|coloca|bota|desce|pede|pedido de|pedido)\s+/, '');
  // qualquer palavra de outra ação → deixa pra IA
  if (/\b(cancel|tira|troc|transf|passa|muda|fecha|conta|quanto|acabou|voltou|pausa|avisa|recado|repet|rodada|igual|mesma|nome|cliente|pra o|pro |bem |mal |obs|separad|depois|tambem|gelad|quente)/.test(t)) return null;
  const partes = t.split(/\s+(?:e|mais|\+)\s+|\s*\+\s*/).map((x) => x.trim()).filter(Boolean);
  if (!partes.length || partes.length > 6) return null;
  const pedidos = [];
  for (const parte of partes) {
    // prato por kg: "34,15 na 30", "prato de 34,15 na 30", "34,15 - 30"
    let m = parte.match(/^(?:um |1 )?(?:prato de |prato |de )?(\d{1,3}[.,]\d{2})\s*(?:-|\/)?\s*(?:na |no |pra |para )?(?:mesa )?(\d{1,3})?$/);
    // "prato de 1514" (sem vírgula) = 15,14 — só com a palavra "prato"
    const mc = !m && parte.match(/^(?:um |1 )?prato (?:de )?(\d{3,5})\s*(?:(?:na |no |pra |para )(?:mesa )?(\d{1,3}))?$/);
    if (mc && parseInt(mc[1], 10) / 100 >= 3 && parseInt(mc[1], 10) / 100 <= 150) m = [mc[0], (parseInt(mc[1], 10) / 100).toFixed(2), mc[2]];
    if (m) {
      const kg = kgPadrao || (cardapioKg.length === 1 ? cardapioKg[0] : null);
      if (!kg) return null;
      pedidos.push({ mesa: m[2] ? parseInt(m[2], 10) : null, itemId: kg.id, tipoVenda: 'kg', valorTotal: parseFloat(m[1].replace(',', '.')) });
      continue;
    }
    // "2 chopp na 5", "coca na 13", "uma agua sem gas mesa 4"
    m = parte.match(/^(?:(\d{1,2}|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\s+)?(.+?)(?:\s+(?:na|no|pra|para a|para)?\s*(?:mesa\s*)?(\d{1,3}))?$/);
    if (!m || !m[2]) return null;
    const qtd = m[1] ? (_NUM_PALAVRA[m[1]] || parseInt(m[1], 10)) : 1;
    let nome = m[2].replace(/\s+(na|no|pra|para|mesa)$/, '').trim();
    if (!nome || /\d/.test(nome)) return null;
    const item = _acharItemRapido(nome, cardapio);
    if (!item) return null;
    pedidos.push({ mesa: m[3] ? parseInt(m[3], 10) : null, itemId: item.id, quantidade: qtd, obs: '' });
  }
  // mesa dita só no fim vale pras partes anteriores ("2 chopp e 1 coca na 5")
  for (let i = pedidos.length - 1, ultima = null; i >= 0; i--) {
    if (pedidos[i].mesa) ultima = pedidos[i].mesa; else pedidos[i].mesa = ultima;
  }
  if (mesaPadrao) pedidos.forEach((p) => { if (!p.mesa) { p.mesa = mesaPadrao; p._doFoco = true; } });
  // Nenhuma mesa dita = vai tudo pra fila sem mesa. Misturado = deixa pra IA.
  if (pedidos.some((p) => !p.mesa) && pedidos.some((p) => p.mesa)) return null;
  return { tipo: 'pedido', pedidos };
}


// Acha, entre os adicionais/opções DO PRÓPRIO ITEM, o que foi falado
// ("palito", "trocar por palito", "bacon extra"). Devolve as seleções no mesmo
// formato do lançamento manual + o que não bateu (vira observação).
function _resolverAdicionais(textos, item, grupos) {
  const selecoes = [];
  const naoAchados = [];
  let extras = 0;
  const opcoes = [];
  (item.gruposIds || []).forEach((gid) => {
    const g = grupos && grupos[gid];
    if (!g) return;
    g.opcoes.forEach((o) => { if (o.nome && !o.pausado) opcoes.push({ g, o }); });
  });
  (textos || []).forEach((t) => {
    const txt = (t && (t.nome || t.texto)) || t;
    const qtdAd = Math.max(1, parseInt(t && t.qtd, 10) || 1);
    if (!txt || !String(txt).trim()) return;
    const limpo = String(txt).replace(/\b(trocar|troca|troque|por|com|adicional|de|extra|mais)\b/gi, ' ').trim() || String(txt);
    const pont = opcoes.map((x) => ({ x, p: Math.max(_pontuar(limpo, x.o.nome), _pontuar(x.o.nome, limpo) * 0.9) }))
      .filter((r) => r.p >= 0.5).sort((a, b) => b.p - a.p);
    const melhor = pont[0];
    const empate = pont[1] && pont[1].p === melhor.p;
    if (!melhor || empate) { naoAchados.push(String(txt).trim()); return; }
    const { g, o } = melhor.x;
    if (g.tipo === 'adicional') {
      selecoes.push({ grupo: g.nome, opcao: o.nome, precoExtra: o.precoExtra, qtd: qtdAd });
      extras += o.precoExtra * qtdAd;
    } else {
      selecoes.push({ grupo: g.nome, opcao: o.nome, precoExtra: o.precoExtra });
      extras += o.precoExtra;
    }
  });
  return { selecoes, extras: Math.round(extras * 100) / 100, naoAchados };
}


// Itens mais parecidos com o texto falado (pra mostrar como botões)
function _candidatosParecidos(falado, lista) {
  if (!falado) return [];
  return lista.map((it) => {
    const vozes = it.voz ? String(it.voz).split(/[,;\/]/) : [];
    const p = Math.max(_pontuar(falado, it.nome), _pontuar(it.nome, falado) * 0.8,
      ...vozes.map((v) => (v.trim() ? _pontuar(falado, v) : 0)));
    return { it, p };
  }).filter((r) => r.p >= 0.5).sort((a, b) => b.p - a.p).slice(0, 5)
    .map((r) => ({ itemId: r.it.id, itemNome: r.it.nome, itemPreco: r.it.preco }));
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
    if (body.limparCache) delete _cacheContexto[tenantId + '|' + restauranteId];
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
  const historico = Array.isArray(body.historico) ? body.historico.slice(-24) : [];

  if (!texto) return res.status(400).json({ ok: false, error: 'Falta o texto' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY não configurada no servidor.' });

  try {
    const db = getDb();
    const ctx = await obterContexto(db, tenantId, restauranteId);
    const { documentoGeral, comFicha, arquivos } = ctx;
    // Itens pausados ou de categoria pausada (lista mandada pelo app, sempre
    // atualizada): NÃO entram nas opções de pedido — assim, com o mesmo nome
    // em várias categorias, o assistente só enxerga o que está disponível.
    const indisponiveis = new Set(Array.isArray(body.indisponiveis) ? body.indisponiveis.map(String) : []);
    // Apelidos aprendidos viram "palavras de voz" do item (os DESTE garçom
    // têm prioridade quando o mesmo apelido aponta pra itens diferentes)
    const garcomAtual = (body.garcom || '').toString();
    const apelidoPorTexto = {};
    (ctx.apelidos || []).slice().sort((a, b) => (a.em || 0) - (b.em || 0)).forEach((a) => {
      const k = _normTxt(a.texto);
      const atual = apelidoPorTexto[k];
      if (!atual || a.garcom === garcomAtual || atual.garcom !== garcomAtual) apelidoPorTexto[k] = a;
    });
    const vozExtra = {};
    Object.keys(apelidoPorTexto).forEach((k) => {
      const a = apelidoPorTexto[k];
      (vozExtra[a.itemId] = vozExtra[a.itemId] || []).push(a.texto);
    });
    const cardapioCompletoTodos = ctx.cardapioCompleto.map((it) => Object.assign({}, it, {
      preco: precoAtualDoItem(it),
      voz: [it.voz || ''].concat(vozExtra[it.id] || []).filter(Boolean).join(', '),
    }));
    const cardapioKgTodos = ctx.cardapioKg;
    const cardapioCompleto = cardapioCompletoTodos.filter((it) => !indisponiveis.has(String(it.id)));
    const cardapioKg = cardapioKgTodos.filter((it) => !indisponiveis.has(String(it.id)));

    const listaCardapio = cardapioCompleto.map((it, i) =>
      `${i + 1}. ${it.nome} [id:${it.id}]${it.voz ? ` (também chamado: ${it.voz})` : ''}${it.dica ? ` — ${it.dica}` : ''}`
    ).join('\n');
    // Item por kg PADRÃO (o buffet): usado quando o texto não cita outro.
    // Itens "especiais" (sorvete, açaí...) só valem se a palavra for dita.
    const _norm = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const RE_ESPECIAL = /sorvet|acai|picol|doce|sobremes|gelat|frozen|iogurt|sushi|churras/;
    const RE_BUFFET = /buffet|bufe|bufet|refei|almoc|comida|prato|self|livre/;
    let kgPadrao = cardapioKg.find((it) => RE_BUFFET.test(_norm(it.nome)) && !RE_ESPECIAL.test(_norm(it.nome)))
      || cardapioKg.find((it) => !RE_ESPECIAL.test(_norm(it.nome)))
      || cardapioKg[0] || null;
    const palavrasDoItem = (nome) => _norm(nome).split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !/^(prato|quilo|kilo|por|peso|livre|self|service)$/.test(w));
    const textoNorm = _norm(texto);
    const itemKgCitado = (it) => palavrasDoItem(it.nome).some((w) => textoNorm.indexOf(w.slice(0, Math.max(4, w.length - 2))) >= 0);
    // ── COMANDA AO VIVO: o garçom vai falando item por item numa mesa só
    const modoComanda = body.modoComanda && parseInt(body.modoComanda.mesa, 10) ? body.modoComanda : null;
    const mesaPadrao = modoComanda ? parseInt(modoComanda.mesa, 10) : null;
    const listaComanda = modoComanda && Array.isArray(modoComanda.itens) ? modoComanda.itens.slice(0, 40) : [];
    const blocoComanda = modoComanda
      ? `MODO COMANDA AO VIVO — MESA ${mesaPadrao}. O funcionário está anotando o pedido desta mesa falando aos poucos, enquanto conversa com o cliente. Os itens ainda NÃO foram enviados.
- Item falado sem número de mesa → use "mesa": ${mesaPadrao}.
- Ignore conversa que não é pedido (ex: "deixa eu ver", "o que você recomenda", "hmm"): responda {"tipo":"pedido","pedidos":[]}.
- Se ele pedir pra MUDAR/TIRAR algo da LISTA ATUAL abaixo (ex: "tira o chopp", "na verdade são dois", "um deles sem cebola", "esquece a coca"), NÃO é cancelamento: responda
  {"tipo":"ajusteComanda","acoes":[{"acao":"remover","indice":2},{"acao":"quantidade","indice":1,"quantidade":2},{"acao":"obs","indice":3,"obs":"sem cebola"}]}
  usando o NÚMERO do item na LISTA ATUAL. Pode misturar com itens novos usando "multiplo".
LISTA ATUAL (ainda não enviada):
${listaComanda.length ? listaComanda.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(vazia)'}

`
      : '';
    // ── Memória da conversa: rascunho na tela (ainda não confirmado) e mesa em foco
    const rascunho = body.rascunho && Array.isArray(body.rascunho.itens) ? body.rascunho.itens.slice(0, 30) : [];
    // "Mesa em foco" desligada: a mesa muda a cada pedido, então ela NUNCA é
    // puxada da conversa — só vale a mesa dita no próprio texto.
    const mesaFoco = null;
    const blocoRascunho = (rascunho.length && !modoComanda)
      ? `RASCUNHO NA TELA (mostrado ao funcionário, AINDA NÃO CONFIRMADO):
${rascunho.map((t, i) => `${i + 1}. ${t}`).join('\n')}
- Se ele pedir pra MUDAR este rascunho ("muda pra 3", "tira a coca", "a picanha é mal passada", "na verdade era o IPA", "era na mesa 8"), NÃO crie pedido novo: responda
  {"tipo":"ajusteComanda","acoes":[{"acao":"quantidade","indice":1,"quantidade":3},{"acao":"remover","indice":2},{"acao":"obs","indice":1,"obs":"mal passada"},{"acao":"trocar","indice":1,"itemIdNovo":"id-do-IPA"},{"acao":"mesa","indice":1,"mesa":8}]}
  com o NÚMERO do item no rascunho (para "todos", repita a ação pra cada índice). Item NOVO ("e mais uma coca") é PEDIDO normal.

`
      : '';
    const blocoFoco = (mesaFoco && !modoComanda)
      ? `MESA EM FOCO NA CONVERSA: ${mesaFoco}. Se o funcionário não disser a mesa e o contexto indicar que é a mesma ("e mais uma coca", "pra ela uma salada", "fecha ela"), use a mesa ${mesaFoco}. Mas um PRATO NOVO da balança (valor em reais) sem mesa dita NÃO é da mesa em foco: use "mesa": null (vai pra fila sem mesa).\n\n`
      : '';
    const mesasClientes = Array.isArray(body.mesasClientes) ? body.mesasClientes.slice(0, 60) : [];
    const blocoClientes = mesasClientes.length
      ? 'CLIENTES NAS MESAS ABERTAS AGORA (pra entender "pro Fernando" sem o número da mesa):\n' +
        mesasClientes.map((m) => `Mesa ${parseInt(m.mesa, 10)}: ${(m.nomes || []).slice(0, 8).join(', ')}`).join('\n') +
        '\n- Se o funcionário citar um cliente SEM dizer a mesa, use a mesa onde esse nome está, e ponha o nome em "cliente". Se o nome estiver em MAIS DE UMA mesa, não escolha: use "mesa": null.\n\n'
      : '';
    const listaPausados = cardapioCompletoTodos.concat(cardapioKgTodos)
      .filter((it) => indisponiveis.has(String(it.id)))
      .slice(0, 80).map((it) => `- ${it.nome} [id:${it.id}]`).join('\n');
    const listaCardapioKg = cardapioKg.map((it, i) =>
      `${i + 1}. ${it.nome} [id:${it.id}] — R$ ${it.precoPorKg.toFixed(2)}/kg` +
      (kgPadrao && it.id === kgPadrao.id && cardapioKg.length > 1 ? '  ← PADRÃO: use ESTE quando o texto não citar o nome de outro item por kg' : '')
    ).join('\n');
    const blocoHistorico = historico.length
      ? '\n\nHISTÓRICO RECENTE DESTA CONVERSA (mais antigo primeiro):\n' +
        historico.map((h) => `${h.autor === 'usuario' ? 'Funcionário' : h.autor === 'sistema' ? 'Sistema' : 'Você'}: ${h.texto}`).join('\n') +
        '\n\nUse este histórico pra entender o CONTEXTO: referências ("muda pra 3", ' +
        '"na verdade era o IPA", "cancela aquele", "a mesma coisa pra ele") e o que já ' +
        'foi feito. MESA: use SÓ a mesa dita no texto atual — nunca puxe a mesa de ' +
        'mensagens anteriores (sem mesa no texto = "mesa": null, vai pra fila). Nunca ' +
        'repita uma ação que o histórico já mostra como CONFIRMADA — se o ' +
        'funcionário só comentar sobre algo já confirmado, trate como ' +
        'PERGUNTA, não como novo pedido/cancelamento.'
      : '';

    // ═══ ETAPA 1 — leve e rápida: classifica E já resolve pedido/cancelamento ═══
    const promptEtapa1 =
`Você é o assistente do app de um garçom de restaurante. O texto abaixo pode
ser UMA DAS DEZESSETE COISAS (ou VÁRIAS delas — ver AÇÕES MISTURADAS):

(A) Uma DÚVIDA sobre produto (IBU, teor alcoólico, ingredientes, alérgenos)
    ou sobre o restaurante (horário, promoção, política).
(B) Um COMANDO DE PEDIDO pra lançar numa mesa (ex: "1 pilsen na 34", "2
    chopp mesa 12 e 1 coca na 8").
(C) Um COMANDO DE CANCELAMENTO de item já pedido (ex: "cancelar 1 pilsen
    da mesa 10", "tira a coca da 15", "cancela o chopp mesa 8").
(D) Um COMANDO PRA FECHAR/ABRIR A CONTA DE UMA PESSOA pelo NOME, sem dizer
    o número da mesa (ex: "fechar a conta da Sara", "fecha o Fernando",
    "conta da Beatriz", "onde está o João", "fechar da Maria").

(E) Um COMANDO DE TROCA de um item já lançado por outro (ex: "troca a coca
    lata da 25 por uma coca 600", "troque o chopp da mesa 8 pra IPA",
    "na 12 era coca zero, não coca normal").

(F) Um COMANDO DE TRANSFERÊNCIA: mudar a mesa inteira, ou um item, de uma
    mesa pra outra (ex: "transfere a 5 pra 8", "muda a mesa 12 para a 20",
    "passa a coca da 5 pra 8", "muda o chopp da mesa 3 para a 4").

(G) Uma CONSULTA da conta de uma mesa (ex: "quanto tá a 12?", "o que tem
    na mesa 12?", "qual o total da 8?", "conta da 5" — SEM a palavra fechar).
(H) Um aviso de que um item ACABOU ou VOLTOU (ex: "acabou a costela", "não
    tem mais coca zero", "pausa a picanha", "voltou a costela", "chegou
    coca zero de novo").
(I) Um pedido pra REPETIR o que a mesa já pediu (ex: "mais uma rodada na
    15", "repete o pedido da 15", "a mesma coisa na 15", "repete o chopp da
    15", "mais um igual da coca na 8"). ATENÇÃO: "mais 2 chopp na 15" (com
    o item e a quantidade, sem "repete/igual/rodada/mesma coisa") é PEDIDO
    normal, não repetir.

(J) Um RECADO pra cozinha ou pro salão/bar (ex: "avisa a cozinha que a 10
    tá com pressa", "recado pro bar: mesa 4 quer o chopp sem colarinho",
    "fala pra cozinha caprichar no prato da 7").

(K) PAUSAR ou LIBERAR uma CATEGORIA INTEIRA do cardápio (ex: "pausa a
    categoria grelhados", "pausar categoria executivos", "libera a categoria
    porções", "volta a categoria sobremesas"). Só quando a palavra
    "categoria" (ou "a seção", "o grupo") for dita.

(L) Um LEMBRETE pro próprio garçom (ex: "me lembra de levar a sobremesa
    da 8 em 10 minutos", "daqui 5 minutos me avisa de ver a 12").
(M) Um RESUMO DO TURNO do garçom (ex: "quanto eu vendi hoje?", "meu total
    de hoje", "quanto dá meus 10%?").
(N) Um pedido de TRADUÇÃO pra falar com cliente estrangeiro (ex: "como digo
    'o prato demora 20 minutos' em inglês?", "traduz pro espanhol: aceita
    cartão?").

(O) Uma pergunta sobre o TEMPO DE UM PRATO/PEDIDO (ex: "quanto falta pra
    picanha da 8?", "o prato da 8 já saiu?", "a 12 tá esperando faz
    quanto tempo?", "a porção da 5 ficou pronta?").
(P) DIVIDIR A CONTA de uma mesa (ex: "divide a 12 por 3", "a 12 vai rachar
    em 4", "o Fernando paga a picanha e o chopp dele", "a Sara da 5 paga
    só o que é dela", "separa 2 chopp e a porção pra cobrar"). Diferente
    de só "fechar a conta" (que não fala em dividir/quem paga o quê).

(Q) Um RECADO PRA OUTRA LOJA/RESTAURANTE da rede (ex: "manda um recado pra
    loja do centro: preciso de 2 caixas de chopp", "avisa o Bávaro Shopping
    que vou passar lá às 15h", "recado pra outra unidade: ..."). Diferente
    do recado pra cozinha/salão DESTA loja.

Decida qual das dezessete é e responda SOMENTE com um JSON válido, sem texto
antes ou depois, sem marcação de código — só o JSON puro.

SE FOR DÚVIDA, responda SÓ isto (a resposta de verdade vem numa etapa
seguinte, com mais informação disponível — aqui é só classificar):
{"tipo":"pergunta"}

SE FOR PEDIDO:
{"tipo":"pedido","pedidos":[{"mesa":34,"itemId":"abc123","quantidade":1,"obs":"","adicionais":[]}]}
- PEDIDO SEM MESA É VÁLIDO: se o funcionário não disser a mesa (ex: "um
  prato de 15,14 mais 1 coca", "prato de 32,10 e uma água nome Ana"),
  responda o pedido normalmente com "mesa": null em todos os itens — o app
  guarda na FILA SEM MESA e a mesa é escolhida depois. NÃO invente mesa.
- VALOR DE PRATO SEM VÍRGULA: "prato de 1514" ou "1514 de buffet" = R$ 15,14
  (os 2 últimos dígitos são os centavos). Use "valorTotal": 15.14.
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
  mesas. Se a lista "CARDÁPIO POR KG" tiver um item marcado como PADRÃO,
  use SEMPRE esse item PADRÃO, a não ser que o texto cite o nome (ou uma
  palavra do nome) de OUTRO item por kg — ex: "35,40 sorvete na 12" ou
  "kg do sorvete" → item de sorvete; "35,40 na 12" (sem citar nada) →
  item PADRÃO. Nunca escolha um item por kg "especial" (sorvete, açaí etc.)
  sem que essa palavra esteja no texto. Se a lista "CARDÁPIO POR KG" tiver exatamente UM item, SEMPRE
  interprete esse padrão como pedido desse item usando "valorTotal" —
  não precisa o funcionário citar o nome do prato nenhuma vez. Se a lista
  por kg tiver mais de um item e não der pra saber qual dos dois pelo
  texto, retorne com itemId null e nomeDigitado "valor da pesagem sem
  produto identificado" em vez de chutar qual dos dois é.
- AMBIGUIDADE: se o que foi falado puder ser MAIS DE UM item do cardápio
  com a mesma chance (ex: "coca" e existem Coca Lata, Coca 600 e Coca Zero;
  "alcatra" em duas versões), NÃO escolha: use "itemId": null e
  "nomeDigitado" com o texto falado. O app mostra as opções pro garçom
  tocar na certa (e aprende pra próxima vez).
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
- "adicionais": lista de ADICIONAIS/TROCAS PAGAS que o funcionário pediu pro
  item (ex: "com palito", "trocar por palito", "troca a fritas por palito",
  "com bacon extra", "adicional de queijo", "com ovo", "duplo", "triplo",
  "em dobro" — ex: "1 x-burguer duplo na 5" → item X-Burguer com
  adicionais [{"nome":"duplo","qtd":1}], a não ser que exista no cardápio
  um item com "duplo" no próprio nome). Cada um é um objeto
  {"nome":"batata palito","qtd":1} com o nome curto do adicional (sem
  "trocar por"/"com"). "qtd" é o TOTAL daquele adicional na linha: se o
  adicional vale pra todas as unidades ("2 picanha com palito"), use a
  mesma quantidade do item (2). Omita ou [] se não houver. NÃO coloque
  adicionais em "obs" — o sistema confere cada um nos adicionais
  cadastrados no item e cobra o valor.
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

SE FOR RECADO:
{"tipo":"recado","destino":"cozinha","mensagem":"Mesa 10 com pressa","mesa":10}
- "destino": "cozinha" ou "salao" (salão, bar, bebidas, copa), ou o nome
  da impressora se o funcionário disser outro lugar.
- "mensagem": o recado em si, curto e claro, como deve sair impresso
  (sem "avisa a cozinha que"). Inclua a mesa no texto se ela foi dita.
- "mesa": número da mesa se foi dita; senão null.

AÇÕES MISTURADAS: se o texto tiver ações de TIPOS DIFERENTES (ex: "2 chopp
na 5 e fecha a 8", "lança uma coca na 3 e avisa a cozinha que a 3 tá com
pressa"), responda:
{"tipo":"multiplo","acoes":[ {ação 1 completa}, {ação 2 completa} ]}
- Cada ação é um objeto COMPLETO no mesmo formato descrito pro seu tipo.
- Ações do MESMO tipo vão juntas num ÚNICO objeto (ex: vários itens de
  pedido ficam todos dentro de um só {"tipo":"pedido","pedidos":[...]}).
- Coloque as ações na ordem em que foram faladas.
- Se for um tipo só, NÃO use "multiplo" — responda o objeto normal.

SE FOR CONSULTA DE CONTA:
{"tipo":"consulta","mesa":12}

SE FOR RECADO PRA OUTRA LOJA:
{"tipo":"recadoLoja","loja":"centro","mensagem":"Preciso de 2 caixas de chopp"}
- "loja": o nome da loja/restaurante como foi falado.
- "mensagem": o recado em si, claro e completo, como deve sair impresso.

SE FOR TEMPO DO PRATO:
{"tipo":"tempoPrato","mesa":8,"nomeItem":"picanha","itemId":"id-ou-null"}
- "nomeItem"/"itemId": null se ele perguntar da mesa toda.

SE FOR DIVIDIR CONTA:
{"tipo":"dividirConta","mesa":12,"partes":3,"pessoa":null,"itens":[]}
- "partes": em quantas partes iguais (só quando for divisão igual); senão null.
- "pessoa": nome de quem vai pagar uma parte (ex: "Fernando"); senão null.
- "itens": o que essa pessoa paga, [{"nome":"picanha","qtd":1}] — vazio se
  for "o que é dele/dela" (o app pega os itens marcados no nome dela).
- "mesa": null se não foi dita (o app acha pela pessoa).

SE FOR LEMBRETE:
{"tipo":"lembrete","minutos":10,"texto":"levar a sobremesa da 8"}

SE FOR RESUMO DO TURNO:
{"tipo":"resumoTurno"}

SE FOR TRADUÇÃO:
{"tipo":"traducao","texto":"o prato demora 20 minutos","idioma":"inglês","codigoIdioma":"en-US"}
- "codigoIdioma": código BCP-47 do idioma de destino (en-US, es-ES, fr-FR, it-IT, de-DE...).

SE FOR PAUSAR/LIBERAR CATEGORIA:
{"tipo":"pausarCategoria","nomeCategoria":"grelhados","pausar":true}
- "nomeCategoria": o nome da categoria como foi falado.
- "pausar": true pra pausar, false pra liberar/voltar.

SE FOR ITEM QUE ACABOU / VOLTOU:
{"tipo":"pausar","itens":[{"itemId":"abc123","nomeDigitado":"costela","pausar":true}]}
- "pausar": true quando ACABOU (pausar o item), false quando VOLTOU.
- "itemId" é o [id:...] do item no cardápio (lista normal ou por kg),
  identificado como num pedido; se não souber com segurança, null.

SE FOR REPETIR:
{"tipo":"repetir","mesa":15,"itemId":null,"nomeItem":null,"quantidade":null}
- Rodada/pedido inteiro (nenhum item citado): itemId e nomeItem null.
- Um item específico ("repete o chopp da 15"): "nomeItem" é o texto falado
  e "itemId" o [id:...] do cardápio (ou null se não souber).
- "quantidade": só se o funcionário disser quantas vezes ("repete 2 chopp
  da 15" → 2); senão null (repete a mesma quantidade de antes).

SE FOR TRANSFERÊNCIA:
{"tipo":"transferir","transferencias":[{"origem":5,"destino":8,"nomeItem":null,"itemId":null}]}
- "origem" é a mesa de onde sai, "destino" a mesa pra onde vai (números).
- MESA INTEIRA (nenhum item citado): "nomeItem": null, "itemId": null.
- UM ITEM: "nomeItem" é o texto do item como foi falado, e "itemId" é o
  [id:...] do cardápio que corresponde a ele (mesmas regras de PEDIDO:
  abreviação, sem acento, erro de voz); se não souber com segurança, null.
- Cada item transferido é um objeto separado (mesma origem/destino).

SE FOR TROCA:
{"tipo":"troca","trocas":[{"mesa":25,"nomeAntigo":"coca lata","itemIdAntigo":"id-da-coca-lata","itemIdNovo":"abc123","obs":""}]}
- "nomeAntigo" é o texto do item que JÁ ESTÁ na mesa, como foi falado.
- "itemIdAntigo" é o [id:...] do cardápio que corresponde a esse item
  antigo — identifique do MESMO jeito que num pedido (abreviação, sem
  acento, erro de voz: "sem gás" = "AGUA SEM GAS", "coca lata" = "COCA
  COLA LATA"). Se não der pra saber com segurança, use null.
- "itemIdNovo" é o [id:...] do NOVO item, da lista de cardápio abaixo
  (mesmas regras de PEDIDO: nunca invente id; se não identificar o novo
  item com segurança, use "itemIdNovo": null e "nomeNovoDigitado" com o
  texto falado).
- "obs" é observação de preparo pro item NOVO, se houver; senão "".
- Cada troca (mesa + item antigo → item novo) é um objeto separado.

SE FOR CANCELAMENTO:
{"tipo":"cancelamento","itens":[{"mesa":10,"nomeDigitado":"pilsen","itemId":"id-da-pilsen","quantidade":1}]}
- "nomeDigitado" é o texto do produto como foi falado.
- "itemId" é o [id:...] do cardápio que corresponde a esse produto,
  identificado do MESMO jeito que num pedido (abreviação, sem acento, erro
  de voz). Se não der pra saber com segurança, use null. (O app ainda
  confere o que realmente está na conta daquela mesa.)
- Cada combinação mesa+item é um objeto separado.

${blocoComanda}${blocoRascunho}${blocoFoco}${blocoClientes}CARDÁPIO DISPONÍVEL (pra uso em PEDIDO):
${listaCardapio}${listaPausados ? `\n\nITENS PAUSADOS AGORA (NUNCA use em PEDIDO — só pra "voltou"/liberar):\n${listaPausados}` : ''}
${listaCardapioKg ? `\nCARDÁPIO POR KG (pratos pesados — ver regras de ITEM POR KG acima):\n${listaCardapioKg}` : ''}${blocoHistorico}

TEXTO (mensagem ATUAL do funcionário — interprete este, usando o histórico acima só como apoio):
"${texto}"`;

    const rapido = _interpretarRapido(texto, cardapioCompleto, cardapioKg, kgPadrao, mesaPadrao || (!/\d/.test(texto) ? mesaFoco : null));
    if (rapido) console.log('[assistente-garcom] atalho local (sem IA): ' + texto);
    const r1 = rapido ? { ok: true, texto: JSON.stringify(rapido) } : await textoDoGemini(apiKey, [{ text: promptEtapa1 }], 1500);
    if (!r1.ok) {
      return res.status(502).json({ ok: false, error: 'Assistente indisponível no momento — tenta de novo em alguns segundos.', detalhe: (r1 && r1.detalhe) || '' });
    }

    let parsed;
    try {
      parsed = JSON.parse(r1.texto);
    } catch (e) {
      console.error('[assistente-garcom] JSON inválido (etapa 1):', r1.texto);
      return res.status(200).json({ ok: true, tipo: 'pergunta', resposta: 'Não consegui entender. Tenta reformular.' });
    }

    // Interpreta UMA ação (já classificada) e devolve o JSON de resposta,
    // ou null se for dúvida (aí segue pra Etapa 2).
    const _idValido = (id) => !!(id && (cardapioCompletoTodos.some((c) => c.id === id) || cardapioKgTodos.some((c) => c.id === id)));
    const despachar = (parsed) => {
    if (parsed.tipo === 'pedido') {
      const brutos = Array.isArray(parsed.pedidos) ? parsed.pedidos : [];
      const resultado = brutos.map((p) => {
        const semNumero = !/\d/.test(texto);
        const mesaVeioDoFoco = !parseInt(p.mesa, 10) && !mesaPadrao && semNumero && !!mesaFoco;
        // Sem mesa: vai pra FILA SEM MESA (o app guarda e a mesa vem depois)
        const mesa = parseInt(p.mesa, 10) || mesaPadrao || (mesaVeioDoFoco ? mesaFoco : null);
        const cliente = (p.cliente || '').toString().trim().slice(0, 40);

        if (p.tipoVenda === 'kg') {
          let itemKg = p.itemId ? cardapioKg.find((c) => c.id === p.itemId) : null;
          // Trava: escolheu um item por kg que NÃO foi citado no texto (ex: puxou
          // o sorvete sem a palavra "sorvete") → usa o PADRÃO (buffet).
          if (kgPadrao && cardapioKg.length > 1) {
            if (!itemKg || (itemKg.id !== kgPadrao.id && !itemKgCitado(itemKg))) {
              const citado = cardapioKg.find((c) => c.id !== kgPadrao.id && itemKgCitado(c));
              itemKg = citado || kgPadrao;
            }
          }
          if (!itemKg) {
            return { mesa, cliente, tipoVenda: 'kg', encontrado: false, nomeDigitado: p.nomeDigitado || null };
          }
          let valorTotal = null;
          let pesoGramas = null;
          if (typeof p.valorTotal === 'number' && p.valorTotal > 0) {
            valorTotal = Math.round(p.valorTotal * 100) / 100;
            // "prato de 1514" = 15,14 (digitado sem vírgula): só quando o número
            // aparece assim no texto e o resultado é um valor normal de prato
            if (valorTotal >= 300 && Number.isInteger(valorTotal) && new RegExp('(^|[^\\d,.])' + valorTotal + '(?![\\d,.])').test(texto) && valorTotal / 100 >= 3 && valorTotal / 100 <= 150) {
              valorTotal = Math.round(valorTotal) / 100;
            }
          } else if (typeof p.pesoGramas === 'number' && p.pesoGramas > 0) {
            pesoGramas = Math.round(p.pesoGramas);
            valorTotal = Math.round((pesoGramas / 1000) * itemKg.precoPorKg * 100) / 100;
          }
          if (valorTotal === null) {
            return { mesa, cliente, tipoVenda: 'kg', encontrado: false, nomeDigitado: itemKg.nome };
          }
          // Valor fora do normal (ex: "341,5" em vez de "34,15")
          let alerta = null, sugestaoValor = null;
          if (valorTotal > 150) {
            alerta = 'Valor alto pra um prato: R$ ' + valorTotal.toFixed(2).replace('.', ',') + ' — confira';
            if (valorTotal / 10 >= 8 && valorTotal / 10 <= 150) sugestaoValor = Math.round(valorTotal * 10) / 100;
          } else if (pesoGramas && pesoGramas > 3000) {
            alerta = 'Peso alto: ' + pesoGramas + 'g — confira';
          } else if (valorTotal < 3) {
            alerta = 'Valor muito baixo: R$ ' + valorTotal.toFixed(2).replace('.', ',') + ' — confira';
          }
          return {
            mesa, cliente, tipoVenda: 'kg', encontrado: true, mesaDoContexto: mesaVeioDoFoco || !!p._doFoco,
            itemId: itemKg.id, itemNome: itemKg.nome,
            precoBase: itemKg.precoPorKg, peso: pesoGramas, itemPreco: valorTotal,
            alerta, sugestaoValor,
          };
        }

        const qtd = Math.max(1, parseInt(p.quantidade, 10) || 1);
        let item = p.itemId ? cardapioCompleto.find((c) => c.id === p.itemId) : null;
        if (!item && p.nomeDigitado) item = _acharItemPorNome(p.nomeDigitado, cardapioCompleto);
        let obsFinal = (p.obs || '').toString().trim();
        let ad = { selecoes: [], extras: 0, naoAchados: [] };
        if (item && Array.isArray(p.adicionais) && p.adicionais.length) {
          ad = _resolverAdicionais(p.adicionais, item, ctx.grupos);
          // O que não é adicional do item não se perde: vai pra observação
          if (ad.naoAchados.length) obsFinal = [obsFinal].concat(ad.naoAchados).filter(Boolean).join(', ');
        }
        // Rede de segurança: pedaço da observação que é EXATAMENTE um adicional
        // do item (ex: obs "duplo" e o item tem o adicional "Duplo") vira
        // adicional cobrado, em vez de ficar só escrito.
        if (item && obsFinal && (item.gruposIds || []).length) {
          const sobra = [];
          obsFinal.split(/\s*[,;]\s*|\s+e\s+/).forEach((pedaco) => {
            if (!pedaco) return;
            const exato = (item.gruposIds || []).some((gid) => {
              const gg = ctx.grupos && ctx.grupos[gid];
              return gg && gg.opcoes.some((o) => o.nome && !o.pausado && _pontuar(pedaco, o.nome) >= 1 && _pontuar(o.nome, pedaco) >= 1);
            });
            if (exato) {
              const r = _resolverAdicionais([{ nome: pedaco, qtd: qtd }], item, ctx.grupos);
              if (r.selecoes.length) {
                ad.selecoes = ad.selecoes.concat(r.selecoes);
                ad.extras = Math.round((ad.extras + r.extras) * 100) / 100;
                return;
              }
            }
            sobra.push(pedaco);
          });
          obsFinal = sobra.join(', ');
        }
        const precoBaseU = item ? item.preco : null;
        return {
          mesa, cliente, quantidade: qtd, mesaDoContexto: mesaVeioDoFoco || !!p._doFoco,
          itemId: item ? item.id : null,
          itemNome: item ? item.nome : null,
          // preço unitário embute os adicionais (igual ao lançamento manual:
          // total da linha = base×qtd + extras)
          itemPreco: item ? Math.round(((precoBaseU * qtd + ad.extras) / qtd) * 100) / 100 : null,
          precoBase: precoBaseU,
          extras: ad.extras,
          selecoes: ad.selecoes,
          adicionaisNaoAchados: ad.naoAchados,
          alerta: (item && qtd > 10) ? ('Quantidade alta: ' + qtd + 'x — confira') : null,
          // Não reconheceu: manda os itens mais parecidos pro garçom escolher
          candidatos: item ? [] : _candidatosParecidos(p.nomeDigitado, cardapioCompleto),
          encontrado: !!item,
          nomeDigitado: p.nomeDigitado || null,
          obs: obsFinal.slice(0, 140),
        };
      }).filter((p) => p !== null);

      return ({ ok: true, tipo: 'pedido', pedidos: resultado });
    }


    if (parsed.tipo === 'consulta') {
      const mesaC = parseInt(parsed.mesa, 10);
      return ({ ok: true, tipo: 'consulta', mesa: isNaN(mesaC) ? null : mesaC });
    }

    if (parsed.tipo === 'pausar') {
      const brutos = Array.isArray(parsed.itens) ? parsed.itens : [];
      const itens = brutos.map((p) => {
        let id = _idValido(p.itemId) ? p.itemId : null;
        if (!id && p.nomeDigitado) {
          const achado = _acharItemPorNome(p.nomeDigitado, cardapioCompletoTodos.concat(cardapioKgTodos));
          if (achado) id = achado.id;
        }
        const it = id ? (cardapioCompletoTodos.find((c) => c.id === id) || cardapioKgTodos.find((c) => c.id === id)) : null;
        return { itemId: id, itemNome: it ? it.nome : null, nomeDigitado: (p.nomeDigitado || '').toString(), pausar: p.pausar !== false, encontrado: !!it };
      });
      return ({ ok: true, tipo: 'pausar', itens });
    }

    if (parsed.tipo === 'repetir') {
      const mesaR = parseInt(parsed.mesa, 10);
      const qtdR = parseInt(parsed.quantidade, 10);
      return ({
        ok: true, tipo: 'repetir', mesa: isNaN(mesaR) ? null : mesaR,
        itemId: _idValido(parsed.itemId) ? parsed.itemId : null,
        nomeItem: (parsed.nomeItem || '').toString().trim() || null,
        quantidade: isNaN(qtdR) || qtdR < 1 ? null : qtdR,
      });
    }

    if (parsed.tipo === 'transferir') {
      const brutos = Array.isArray(parsed.transferencias) ? parsed.transferencias : [];
      const transferencias = brutos.map((t) => {
        const origem = parseInt(t.origem, 10), destino = parseInt(t.destino, 10);
        if (isNaN(origem) || isNaN(destino)) return null;
        const idOk = _idValido(t.itemId);
        const nomeItem = (t.nomeItem || '').toString().trim();
        return { origem, destino, nomeItem: nomeItem || null, itemId: idOk ? t.itemId : null };
      }).filter((t) => t);
      return ({ ok: true, tipo: 'transferir', transferencias });
    }

    if (parsed.tipo === 'troca') {
      const brutos = Array.isArray(parsed.trocas) ? parsed.trocas : [];
      const trocas = brutos.map((t) => {
        const mesa = parseInt(t.mesa, 10);
        if (isNaN(mesa)) return null;
        const novo = t.itemIdNovo ? cardapioCompleto.find((c) => c.id === t.itemIdNovo) : null;
        return {
          mesa,
          nomeAntigo: (t.nomeAntigo || '').toString().trim(),
          itemIdAntigo: _idValido(t.itemIdAntigo) ? t.itemIdAntigo : null,
          encontradoNovo: !!novo,
          itemIdNovo: novo ? novo.id : null,
          itemNomeNovo: novo ? novo.nome : null,
          itemPrecoNovo: novo ? novo.preco : null,
          nomeNovoDigitado: (t.nomeNovoDigitado || '').toString(),
          obs: (t.obs || '').toString().trim().slice(0, 140),
        };
      }).filter((t) => t && t.nomeAntigo);
      return ({ ok: true, tipo: 'troca', trocas });
    }

    if (parsed.tipo === 'fechar') {
      const nome = (parsed.nome || '').toString().trim().slice(0, 60);
      const mesaF = parseInt(parsed.mesa, 10);
      return ({ ok: true, tipo: 'fechar', nome, mesa: isNaN(mesaF) ? null : mesaF });
    }

    if (parsed.tipo === 'cancelamento') {
      const brutos = Array.isArray(parsed.itens) ? parsed.itens : [];
      const resultado = brutos.map((p) => {
        const mesa = parseInt(p.mesa, 10);
        const qtd = Math.max(1, parseInt(p.quantidade, 10) || 1);
        const idOk = _idValido(p.itemId);
        return { mesa: isNaN(mesa) ? null : mesa, nomeDigitado: (p.nomeDigitado || '').toString(), itemId: idOk ? p.itemId : null, quantidade: qtd };
      }).filter((p) => p.mesa !== null && p.nomeDigitado);

      return ({ ok: true, tipo: 'cancelamento', itens: resultado });
    }

    if (parsed.tipo === 'ajusteComanda') {
      const acoes = (Array.isArray(parsed.acoes) ? parsed.acoes : []).map((a) => {
        const novo = a.itemIdNovo ? cardapioCompleto.find((c) => c.id === a.itemIdNovo) : null;
        return {
          acao: String(a.acao || ''), indice: parseInt(a.indice, 10) || 0,
          quantidade: parseInt(a.quantidade, 10) || null, obs: (a.obs || '').toString().slice(0, 140),
          mesa: parseInt(a.mesa, 10) || null,
          itemIdNovo: novo ? novo.id : null, itemNomeNovo: novo ? novo.nome : null, itemPrecoNovo: novo ? novo.preco : null,
        };
      }).filter((a) => a.indice > 0 && ['remover', 'quantidade', 'obs', 'trocar', 'mesa'].indexOf(a.acao) >= 0)
        .filter((a) => (a.acao !== 'trocar' || a.itemIdNovo) && (a.acao !== 'mesa' || a.mesa));
      return ({ ok: true, tipo: 'ajusteComanda', acoes });
    }
    if (parsed.tipo === 'lembrete') {
      const min = Math.max(1, Math.min(240, parseInt(parsed.minutos, 10) || 5));
      return ({ ok: true, tipo: 'lembrete', minutos: min, texto: (parsed.texto || '').toString().trim().slice(0, 160) });
    }
    if (parsed.tipo === 'resumoTurno') return ({ ok: true, tipo: 'resumoTurno' });
    if (parsed.tipo === 'recadoLoja') {
      return ({ ok: true, tipo: 'recadoLoja', loja: (parsed.loja || '').toString().trim(), mensagem: (parsed.mensagem || '').toString().trim().slice(0, 400) });
    }
    if (parsed.tipo === 'tempoPrato') {
      const mT = parseInt(parsed.mesa, 10);
      return ({ ok: true, tipo: 'tempoPrato', mesa: isNaN(mT) ? null : mT,
        nomeItem: (parsed.nomeItem || '').toString().trim() || null, itemId: _idValido(parsed.itemId) ? parsed.itemId : null });
    }
    if (parsed.tipo === 'dividirConta') {
      const mD = parseInt(parsed.mesa, 10) || mesaPadrao || null;
      const partes = parseInt(parsed.partes, 10);
      return ({ ok: true, tipo: 'dividirConta', mesa: mD, partes: partes > 1 ? Math.min(partes, 50) : null,
        pessoa: (parsed.pessoa || '').toString().trim() || null,
        itens: (Array.isArray(parsed.itens) ? parsed.itens : []).map((x) => ({ nome: String((x && x.nome) || x || '').trim(), qtd: Math.max(1, parseInt(x && x.qtd, 10) || 1) })).filter((x) => x.nome) });
    }
    if (parsed.tipo === 'pausarCategoria') {
      return ({ ok: true, tipo: 'pausarCategoria', nomeCategoria: (parsed.nomeCategoria || '').toString().trim(), pausar: parsed.pausar !== false });
    }
    if (parsed.tipo === 'recado') {
      const mesaRc = parseInt(parsed.mesa, 10);
      return ({ ok: true, tipo: 'recado', destino: (parsed.destino || '').toString().trim().toLowerCase(),
        mensagem: (parsed.mensagem || '').toString().trim().slice(0, 200), mesa: isNaN(mesaRc) ? null : mesaRc });
    }
    return null;
    };

    const resolverTudo = (pp) => {
      if (pp.tipo === 'multiplo') {
        const acoes = (Array.isArray(pp.acoes) ? pp.acoes : [])
          .filter((x) => x && x.tipo && x.tipo !== 'multiplo' && x.tipo !== 'pergunta' && x.tipo !== 'traducao')
          .map((x) => despachar(x)).filter((x) => x);
        if (acoes.length === 1) return acoes[0];
        if (acoes.length > 1) return { ok: true, tipo: 'multiplo', acoes };
        return null;
      }
      return despachar(pp);
    };
    const naoAchados = (sd) => {
      if (!sd) return 0;
      const lista = sd.tipo === 'multiplo' ? sd.acoes : [sd];
      return lista.reduce((n, a) => n + (a.tipo === 'pedido' ? (a.pedidos || []).filter((p) => !p.encontrado && !p.esgotado && !(p.candidatos || []).length).length : 0), 0);
    };

    // ── Tradução (precisa de uma chamada a mais, então fica fora do despachar)
    if (parsed.tipo === 'traducao' && parsed.texto) {
      const pT = `Traduza para ${parsed.idioma || 'inglês'} o texto abaixo, do jeito natural que um garçom falaria com um cliente, educado e curto. Responda SOMENTE com JSON: {"traducao":"...","pronuncia":"como ler em português, aproximado"}\n\nTEXTO: "${String(parsed.texto).slice(0, 300)}"`;
      const rt = await textoDoGemini(apiKey, [{ text: pT }], 400);
      let jt = {};
      try { jt = JSON.parse(rt.texto || '{}'); } catch (e) { jt = { traducao: rt.texto || '' }; }
      return res.status(200).json({ ok: true, tipo: 'traducao', original: parsed.texto, idioma: parsed.idioma || 'inglês',
        codigoIdioma: parsed.codigoIdioma || 'en-US', traducao: jt.traducao || '', pronuncia: jt.pronuncia || '' });
    }

    let saida = resolverTudo(parsed);
    // ── Modelo esperto: o rápido não reconheceu algum item → pergunta de novo
    // pra um modelo mais inteligente e fica com a resposta que acertar mais.
    if (saida && !rapido && naoAchados(saida) > 0) {
      const esperto = await _modeloEsperto(apiKey);
      if (esperto) {
        const rE = await textoDoModelo(apiKey, [{ text: promptEtapa1 }], 1500, esperto, 12000);
        if (rE.ok) {
          try {
            const sE = resolverTudo(JSON.parse(rE.texto));
            if (sE && naoAchados(sE) < naoAchados(saida)) { console.log('[assistente-garcom] modelo esperto resolveu'); saida = sE; }
          } catch (e) { /* resposta inválida: fica com a primeira */ }
        }
      }
    }
    if (saida) {
      if (rapido) saida.rapido = true;
      return res.status(200).json(saida);
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

PERGUNTAS DE ALERGIA/RESTRIÇÃO (ex: "tem algo sem glúten?", "o que não
leva lactose?", "opção vegana?"): liste SÓ os itens cuja ficha técnica ou
base de conhecimento CONFIRMA a resposta, e avise que os outros itens não
têm essa informação cadastrada. Nunca suponha ingrediente.

Responda em português do Brasil, em até 2 frases, direto ao ponto (em
listas de itens, pode usar até 4 frases).
Responda SOMENTE com um JSON válido, sem texto antes ou depois, sem
marcação de código: {"resposta":"texto da resposta"}

FICHAS TÉCNICAS DE ITENS:
${blocoFichas}${blocoGeral}
${arquivosPraUsar.length ? `\n\n${arquivosPraUsar.length} arquivo(s) anexado(s) abaixo — leia o conteúdo deles diretamente.` : ''}${blocoHistorico}

PERGUNTA (mensagem ATUAL do funcionário):
"${texto}"`;

    const parts2 = [{ text: promptEtapa2 }, ...partesArquivos];
    // Dúvida: tenta primeiro o modelo mais inteligente; se falhar, o normal
    let r2 = null;
    const espertoQ = await _modeloEsperto(apiKey);
    if (espertoQ) {
      const rq = await textoDoModelo(apiKey, parts2, 900, espertoQ, 15000);
      if (rq.ok && rq.texto) r2 = rq;
    }
    if (!r2) r2 = await textoDoGemini(apiKey, parts2, 700);
    if (!r2.ok) {
      return res.status(502).json({ ok: false, error: 'Assistente indisponível no momento — tenta de novo em alguns segundos.', detalhe: (r2 && r2.detalhe) || '' });
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
