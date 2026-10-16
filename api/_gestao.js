// ═══════════════════════════════════════════════════════════════
//  GESTÃO do restaurante para o assistente (usado por
//  /api/assistente-garcom e /api/assistente-gestao).
//
//  Lê do Firestore do tenant/restaurante (coleção "configuracoes"):
//    briefing      → { data: { status: {'AAAA-MM-DD': {idForn:'feito'|'nao'}}, forn:[...] } }
//    briefingJogos → { data: { gerado, dias: {'AAAA-MM-DD': [{hora,casa,fora,liga,top}]} } }
//    estoqueV3     → { data: { cats:[{nome, itens:[{nome,qtd,min}]}] } }
//
//  Os dias de pedir são calculados com a MESMA regra do index.html
//  (brfMapaPedido / brfChega / brfItensDoDia). Fuso: America/Sao_Paulo.
//
//  Arquivo começa com "_" → a Vercel não publica como rota; só é importado.
// ═══════════════════════════════════════════════════════════════

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const DIAS_CURTO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
const FECHADO = [0]; // domingo fechado
const SEG_SAB = [1, 2, 3, 4, 5, 6];
const SEG_SEX = [1, 2, 3, 4, 5];

// Mesmos fornecedores padrão do index.html (valem enquanto ninguém editou)
function fornPadrao() {
  return [
    { id: 'concorde', emoji: '📦', nome: 'Concorde', desc: 'embalagens', tipo: 'pedido', modo: 'entrega', entrega: SEG_SEX.slice(), antec: 1, atende: SEG_SEX.slice(), pedir: [], prazo: '12:00', obs: '' },
    { id: 'coxinhas', emoji: '🥟', nome: 'Coxinhas', desc: '', tipo: 'pedido', modo: 'entrega', entrega: SEG_SAB.slice(), antec: 0, atende: SEG_SAB.slice(), pedir: [], prazo: '14:00', obs: '' },
    { id: 'coca', emoji: '🥤', nome: 'Coca-Cola', desc: '', tipo: 'pedido', modo: 'entrega', entrega: [2, 4, 6], antec: 1, atende: SEG_SAB.slice(), pedir: [], prazo: '', obs: '' },
    { id: 'gold', emoji: '🍔', nome: 'Gold', desc: 'pão de hambúrguer', tipo: 'pedido', modo: 'entrega', entrega: SEG_SAB.slice(), antec: 1, atende: SEG_SAB.slice(), pedir: [], prazo: '', obs: '' },
    { id: 'belpan', emoji: '🥖', nome: 'Belpan', desc: 'baguete e broa', tipo: 'pedido', modo: 'entrega', entrega: SEG_SAB.slice(), antec: 1, atende: SEG_SAB.slice(), pedir: [], prazo: '', obs: '' },
    { id: 'molho', emoji: '🍅', nome: 'Molho de tomate', desc: '', tipo: 'pedido', modo: 'entrega', entrega: SEG_SEX.slice(), antec: 1, atende: SEG_SEX.slice(), pedir: [], prazo: '', obs: '' },
    { id: 'povao', emoji: '📦', nome: 'Povão', desc: 'embalagens', tipo: 'pedido', modo: 'direto', entrega: [], antec: 1, atende: SEG_SEX.slice(), pedir: SEG_SEX.slice(), prazo: '', obs: 'entrega em até 2 dias úteis' },
    { id: 'gelo', emoji: '🧊', nome: 'Gelo', desc: '', tipo: 'pedido', modo: 'entrega', entrega: SEG_SAB.slice(), antec: 0, atende: SEG_SAB.slice(), pedir: [], prazo: '', obs: '' },
    { id: 'bebidas', emoji: '🍺', nome: 'Bebidas alcoólicas', desc: '', tipo: 'conferir', modo: 'direto', entrega: [], antec: 1, atende: [], pedir: [5], prazo: '', obs: 'conferir estoque (semanal)' },
    { id: 'sorvetes', emoji: '🍦', nome: 'Sorvetes', desc: '', tipo: 'conferir', modo: 'direto', entrega: [], antec: 1, atende: [], pedir: [5], prazo: '', obs: 'conferir estoque (semanal)' },
  ];
}

// ── regra de dias (cópia fiel do index.html) ──
// Para cada dia de entrega, em que dia é preciso pedir? → {diaPedido:[diasEntrega]}
function mapaPedido(f) {
  const mapa = {};
  if (f.tipo === 'conferir' || f.modo === 'direto') { (f.pedir || []).forEach((d) => { mapa[d] = []; }); return mapa; }
  const atende = (f.atende && f.atende.length) ? f.atende : SEG_SAB;
  (f.entrega || []).forEach((e) => {
    let d = ((e - (f.antec || 0)) % 7 + 7) % 7, n = 0;
    while ((atende.indexOf(d) < 0 || FECHADO.indexOf(d) >= 0) && n < 7) { d = (d + 6) % 7; n++; }
    if (n >= 7) return;
    (mapa[d] = mapa[d] || []).push(e);
  });
  return mapa;
}
function diasPedido(f) { return Object.keys(mapaPedido(f)).map(Number).sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); }
function chega(f, d) {
  if (f.tipo === 'conferir' || f.modo === 'direto') return f.obs || '';
  const ents = mapaPedido(f)[d] || [];
  const txt = ents.map((e) => (e === d ? 'hoje' : (e === (d + 1) % 7 ? 'amanhã' : DIAS[e])));
  return (txt.length ? 'chega ' + txt.join(' e ') : '') + (f.obs ? (txt.length ? ' · ' : '') + f.obs : '');
}
function _min(hhmm) { const p = String(hhmm || '').split(':'); return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0); }
function itensDoDia(forn, d) {
  const itens = forn.filter((f) => mapaPedido(f)[d] !== undefined);
  itens.sort((a, b) => {
    if (a.prazo && b.prazo) return _min(a.prazo) - _min(b.prazo);
    if (a.prazo) return -1; if (b.prazo) return 1;
    const ca = a.tipo === 'conferir', cb = b.tipo === 'conferir'; if (ca !== cb) return ca ? 1 : -1;
    return 0;
  });
  return itens;
}
function listaDias(arr) {
  if (!arr || !arr.length) return '—';
  return arr.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DIAS_CURTO[d]).join(', ');
}

// ── data/hora em São Paulo ──
function agoraSP(base) {
  const dt = base || new Date();
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
    .formatToParts(dt).forEach((x) => { p[x.type] = x.value; });
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const hora = parseInt(p.hour, 10) % 24;
  return { key: p.year + '-' + p.month + '-' + p.day, ano: +p.year, mes: +p.month, dia: +p.day, dow, minutos: hora * 60 + parseInt(p.minute, 10), hhmm: String(hora).padStart(2, '0') + ':' + p.minute };
}
function somarDias(sp, n) {
  const t = Date.UTC(sp.ano, sp.mes - 1, sp.dia + n);
  const d = new Date(t);
  const ano = d.getUTCFullYear(), mes = d.getUTCMonth() + 1, dia = d.getUTCDate();
  return { key: ano + '-' + String(mes).padStart(2, '0') + '-' + String(dia).padStart(2, '0'), ano, mes, dia, dow: d.getUTCDay() };
}
function ddmm(x) { return String(x.dia).padStart(2, '0') + '/' + String(x.mes).padStart(2, '0'); }

// ── Firestore ──
function refConfig(db, tenantId, restauranteId) {
  const base = db.collection('tenants').doc(tenantId);
  // Bávaro: "default" no PDV/garçom e "bavaro" na gestão → mesmos docs na raiz do tenant
  if (!restauranteId || restauranteId === 'default' || restauranteId === 'bavaro') return base.collection('configuracoes');
  return base.collection('restaurantes').doc(restauranteId).collection('configuracoes');
}
const _cache = {};
const rh = require('./_rh');
const _nomesFunc = {}; // nomes de funcionários (rota no garçom)
const _nomesForn = {}; // nomes normalizados por tenant|rest (pra reconhecer "remove o Povão" no garçom)
const CACHE_MS = 15000;
function _norm(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

async function carregar(db, tenantId, restauranteId, forcar) {
  const k = tenantId + '|' + (restauranteId || 'default');
  const c = _cache[k];
  if (!forcar && c && Date.now() - c.em < CACHE_MS) return c.dados;
  const col = refConfig(db, tenantId, restauranteId);
  const [b, j, e, r] = await Promise.all([
    col.doc('briefing').get(), col.doc('briefingJogos').get(), col.doc('estoqueV3').get(),
    rh.carregar(db, tenantId, restauranteId).catch((err) => { console.warn('[gestao] funcionários:', err.message); return { funcs: [], vf: {} }; }),
  ]);
  const brf = (b.exists && b.data() && b.data().data) || {};
  const forn = (Array.isArray(brf.forn) && brf.forn.length) ? brf.forn : fornPadrao();
  const dados = {
    status: brf.status || {},
    forn,
    jogos: (j.exists && j.data() && j.data().data) || { dias: {} },
    estoque: (e.exists && e.data() && e.data().data) || { cats: [] },
    temBriefing: b.exists,
    rh: r,
  };
  _cache[k] = { em: Date.now(), dados };
  const nf = new Set();
  forn.forEach((f) => {
    const n = _norm(f.nome).trim(); if (n.length < 3) return;
    nf.add(n); if (/s$/.test(n) && n.length > 4) nf.add(n.slice(0, -1));
    const p1 = n.split(/[\s\-]+/)[0]; if (p1.length >= 4) { nf.add(p1); if (/s$/.test(p1)) nf.add(p1.slice(0, -1)); }
  });
  _nomesForn[k] = Array.from(nf);
  _nomesFunc[k] = rh.nomesParaRota(r.funcs);
  return dados;
}
function limparCache(tenantId, restauranteId) { delete _cache[tenantId + '|' + (restauranteId || 'default')]; }

// ── é pergunta/comando de gestão? (barato: só regex + nomes em cache) ──
const RE_GESTAO = /\b(brie?fi?ng|brifing|brefing|resumo do dia|como (ta|esta|tá|está) o dia|ja fiz|já fiz|fiz o pedido|ja conferi|já conferi|fornecedor(es)?|falta pedir|pedir hoje|pedidos? (de|do|pra|para) (hoje|amanha)|o que (tem|tenho|temos|preciso|precisa|precisamos)( que)? pedir|tem que pedir|ja pedi|já pedi|ja fiz o pedido|nao precisa (de|do|da)|não precisa (de|do|da)|vai chegar|chega(m)? (hoje|amanha)|entrega(m|r)?|jogos?|futebol|campeonato|brasileirao|libertadores|champions|estoque|abaixo do minimo|acabando|briefing|cadastra(r)? o fornecedor|adiciona(r)? o fornecedor|remove(r)? o fornecedor)\b/;
function pareceGestao(texto, tenantId, restauranteId) {
  const t = _norm(texto);
  if (RE_GESTAO.test(t) || RE_GESTAO.test(String(texto || '').toLowerCase())) return true;
  const k = tenantId + '|' + (restauranteId || 'default');
  if (rh.pareceRH(texto, _nomesFunc[k])) return true;
  const nomes = _nomesForn[k] || [];
  // nome de fornecedor + verbo de gestão ("remove o Povão", "a Gold agora entrega...")
  return nomes.some((n) => t.indexOf(n) >= 0) && /\b(remove|exclui|apaga|tira o fornecedor|pedi|pedido|pedir|entrega|chega|precisa|fiz|feito|feita|conferi|conferido|conferida|desmarca)\b/.test(t);
}

// ── texto de contexto pra IA (já com tudo calculado) ──
function montarContexto(dados, podeEditar) {
  const sp = agoraSP();
  const forn = dados.forn;
  const st = dados.status[sp.key] || {};
  const linhas = [];
  linhas.push('AGORA: ' + DIAS[sp.dow] + ', ' + ddmm(sp) + '/' + sp.ano + ', ' + sp.hhmm + ' (horário de Brasília).' + (sp.dow === 0 ? ' DOMINGO: restaurante FECHADO, nenhum pedido hoje.' : ''));

  // pedidos de hoje
  linhas.push('\nPEDIDOS DE HOJE (' + DIAS[sp.dow] + '):');
  if (sp.dow === 0) linhas.push('- (fechado)');
  else {
    const hoje = itensDoDia(forn, sp.dow);
    if (!hoje.length) linhas.push('- nenhum pedido hoje');
    hoje.forEach((f) => {
      const s = st[f.id];
      const situ = s === 'feito' ? 'FEITO' : (s === 'nao' ? 'NÃO PRECISA HOJE' : 'PENDENTE');
      const atrasado = !s && f.prazo && sp.minutos > _min(f.prazo);
      linhas.push('- [id:' + f.id + '] ' + f.nome + (f.desc ? ' (' + f.desc + ')' : '') + (f.tipo === 'conferir' ? ' — SÓ CONFERIR ESTOQUE' : '') +
        ' — ' + situ + (f.prazo ? ' — prazo até ' + f.prazo + (atrasado ? ' (PRAZO JÁ PASSOU)' : '') : '') + (chega(f, sp.dow) ? ' — ' + chega(f, sp.dow) : ''));
    });
  }
  // próximos 6 dias
  linhas.push('\nPRÓXIMOS DIAS (o que pedir em cada dia):');
  for (let i = 1; i <= 6; i++) {
    const d = somarDias(sp, i);
    if (d.dow === 0) { linhas.push('- ' + DIAS[0] + ' ' + ddmm(d) + ': fechado'); continue; }
    const it = itensDoDia(forn, d.dow);
    linhas.push('- ' + (i === 1 ? 'amanhã, ' : '') + DIAS[d.dow] + ' ' + ddmm(d) + ': ' + (it.length ? it.map((f) => f.nome + (f.tipo === 'conferir' ? ' (conferir)' : '') + (f.prazo ? ' até ' + f.prazo : '')).join(', ') : 'nenhum pedido'));
  }
  // entregas previstas (o que está pra chegar)
  linhas.push('\nENTREGAS PREVISTAS (o que chega em cada dia, pela regra de entrega):');
  for (let i = 0; i <= 6; i++) {
    const d = somarDias(sp, i);
    const chegam = [];
    forn.forEach((f) => {
      if (f.tipo === 'conferir' || f.modo === 'direto') return;
      const m = mapaPedido(f);
      Object.keys(m).forEach((dp) => {
        if (m[dp].indexOf(d.dow) < 0) return;
        // o pedido dessa entrega é feito no dia "dp" — até 6 dias antes
        let volta = (d.dow - Number(dp) + 7) % 7;
        const diaPed = somarDias(sp, i - volta);
        const sPed = (dados.status[diaPed.key] || {})[f.id];
        const marca = sPed === 'feito' ? ' (pedido feito ' + (volta === 0 ? 'no mesmo dia' : DIAS[diaPed.dow]) + ')'
          : sPed === 'nao' ? ' (marcado como não precisa)'
          : (i - volta < 0 ? ' (pedido era ' + DIAS[diaPed.dow] + ', sem marcação)' : (i - volta === 0 ? ' (pedido é hoje)' : ' (pedir ' + DIAS[diaPed.dow] + ')'));
        chegam.push(f.nome + marca);
      });
    });
    linhas.push('- ' + (i === 0 ? 'hoje' : i === 1 ? 'amanhã' : DIAS[d.dow]) + ' ' + ddmm(d) + ': ' + (chegam.length ? chegam.join('; ') : '—'));
  }
  // cadastro
  linhas.push('\nFORNECEDORES CADASTRADOS:');
  forn.forEach((f) => {
    const ent = f.tipo !== 'conferir' && f.modo === 'entrega';
    linhas.push('- [id:' + f.id + '] ' + (f.emoji || '') + ' ' + f.nome + (f.desc ? ' (' + f.desc + ')' : '') +
      ' | tipo:' + (f.tipo || 'pedido') + ' | modo:' + (f.modo || 'entrega') +
      (ent ? ' | entrega:' + listaDias(f.entrega) + ' | antec:' + (f.antec || 0) + ' dia(s) | aceita pedido:' + listaDias(f.atende) : ' | ' + (f.tipo === 'conferir' ? 'conferir' : 'pedir') + ':' + listaDias(f.pedir)) +
      ' | dias de pedir calculados:' + listaDias(diasPedido(f)) + (f.prazo ? ' | prazo:' + f.prazo : '') + (f.obs ? ' | obs:' + f.obs : ''));
  });
  // jogos
  linhas.push('\nJOGOS (próximos 7 dias; ⭐ = jogo grande):');
  const dias = (dados.jogos && dados.jogos.dias) || {};
  let temJogo = false;
  for (let i = 0; i < 7; i++) {
    const d = somarDias(sp, i);
    const lista = dias[d.key];
    if (!lista || !lista.length) continue;
    temJogo = true;
    linhas.push('- ' + (i === 0 ? 'HOJE' : i === 1 ? 'AMANHÃ' : DIAS[d.dow]) + ' ' + ddmm(d) + ': ' + lista.map((g) => (g.top ? '⭐ ' : '') + g.hora + ' ' + g.casa + ' x ' + g.fora + ' (' + g.liga + ')').join('; '));
  }
  if (!temJogo) linhas.push('- nenhum jogo carregado' + (dados.jogos && dados.jogos.gerado ? ' (atualizado em ' + dados.jogos.gerado + ')' : ' (a lista de jogos ainda não foi buscada no app de gestão)'));
  else if (dados.jogos.gerado) linhas.push('(lista atualizada em ' + dados.jogos.gerado + ')');
  // estoque
  const cats = (dados.estoque && dados.estoque.cats) || [];
  const baixos = [], todos = [];
  cats.forEach((c) => (c.itens || []).forEach((i) => {
    const q = Number(i.qtd), m = Number(i.min);
    todos.push((c.nome || '') + ': ' + i.nome + ' = ' + (isNaN(q) ? '?' : q) + (m ? ' (mín ' + m + ')' : ''));
    if (Number(i.qtd) <= Number(i.min)) baixos.push(i.nome + ' — tem ' + (isNaN(q) ? '?' : q) + ', mínimo ' + m + (c.nome ? ' [' + c.nome + ']' : ''));
  }));
  linhas.push('\nESTOQUE ABAIXO OU NO MÍNIMO (' + baixos.length + '):');
  linhas.push(baixos.length ? baixos.map((x) => '- ' + x).join('\n') : '- nenhum item abaixo do mínimo');
  if (todos.length) linhas.push('\nESTOQUE COMPLETO:\n' + todos.slice(0, 400).map((x) => '- ' + x).join('\n'));
  if (podeEditar && dados.rh) linhas.push(rh.montarContexto(dados.rh, sp.key));
  return linhas.join('\n');
}

function montarPrompt(texto, contexto, historico, podeEditar) {
  return `Você é o assistente de GESTÃO do restaurante Bávaro: pedidos a fornecedores, entregas, jogos de futebol da semana, estoque e funcionários (ficha, vales, faltas, feriados).
Responda SOMENTE com JSON válido, sem markdown.

${contexto}

${historico ? 'CONVERSA RECENTE:\n' + historico + '\n\n' : ''}MENSAGEM: "${texto}"

FORMATOS DE RESPOSTA:
1) Pergunta (o que pedir, o que chega, jogos, estoque, prazos, funcionários):
{"tipo":"resposta","resposta":"texto curto em português, direto, pode usar quebras de linha e emojis dos fornecedores"}
- Use SÓ os dados acima. Não invente fornecedor, jogo, horário ou quantidade.
- "o que falta pedir hoje" = itens de HOJE com status PENDENTE (avise se o prazo já passou).
- "hoje à noite" = jogos de hoje a partir das 18h. Se não houver, diga que não há.
- Para estoque, use a seção ESTOQUE ABAIXO OU NO MÍNIMO.
- "briefing do dia" / "resumo do dia" (aceite erros de digitação como "brifing") = pedidos de hoje (pendentes e feitos), o que chega hoje, jogos de hoje e estoque abaixo do mínimo. NÃO invente tarefas, avisos ou pendências que não estejam nos dados.
2) Marcar pedido de hoje ("já pedi a coxinha", "fiz o pedido do gelo", "chopp já fiz", "sorvete conferido", "hoje não precisa de Coca", "desmarca o gelo"):
{"tipo":"marcarPedido","fornecedorId":"id","status":"feito"}
- status: "feito" (já pediu), "nao" (não precisa hoje), null (voltar pra pendente).
3) Criar ou editar fornecedor ("adiciona o fornecedor X...", "a Gold agora entrega só de terça a sábado"):
{"tipo":"salvarFornecedor","fornecedor":{...}}
- Editar: inclua "id" do fornecedor existente e SÓ os campos que mudam.
- Novo: sem "id"; inclua nome, emoji, tipo, modo e os dias.
- Campos: emoji, nome, desc, tipo ("pedido"|"conferir"), modo ("entrega"|"direto"), entrega:[dias], antec:0-3 (dias de antecedência pra pedir), atende:[dias em que aceita pedido], pedir:[dias] (modo direto ou conferir), prazo:"HH:MM" ou "", obs.
- Dias: 0=domingo, 1=segunda, 2=terça, 3=quarta, 4=quinta, 5=sexta, 6=sábado. "de terça a sábado" = [2,3,4,5,6].
- "pedir 1 dia antes" = modo "entrega" com antec 1. "até as 16h" = prazo "16:00".
4) Remover fornecedor ("remove o Povão"):
{"tipo":"removerFornecedor","fornecedorId":"id"}
5) Várias ações na mesma frase ("já pedi a coxinha e o gelo", "vale de 50 pro João e falta pra Ana"):
{"tipo":"multiplo","acoes":[{ação 1},{ação 2}]}
${rh.promptRH(podeEditar)}
${podeEditar ? '' : '\nOBS: este usuário NÃO pode criar, editar ou remover fornecedores — se pedir isso, use mesmo assim o formato 3 ou 4 (o sistema vai recusar com a mensagem certa).'}
0) Se a mensagem NÃO for de gestão (é pedido de cliente pra uma mesa, conta, cancelamento, recado pra cozinha, transferência de mesa): {"tipo":"naoGestao"}

Identifique o fornecedor pelo nome falado (sem acento, abreviado, "coxinha" = Coxinhas, "coca" = Coca-Cola) e use o id exato da lista. Se não der pra saber qual é, responda no formato 1 perguntando.`;
}

// ── execução das ações (grava direto no Firestore) ──
function _dias(v) { return Array.isArray(v) ? v.map((x) => parseInt(x, 10)).filter((x) => x >= 0 && x <= 6).filter((x, i, a) => a.indexOf(x) === i) : undefined; }
function _limparForn(f, base) {
  const o = Object.assign({}, base || {});
  if (f.emoji != null) o.emoji = String(f.emoji).slice(0, 4) || '📦';
  if (f.nome != null) o.nome = String(f.nome).trim().slice(0, 40);
  if (f.desc != null) o.desc = String(f.desc).trim().slice(0, 60);
  if (f.tipo != null) o.tipo = f.tipo === 'conferir' ? 'conferir' : 'pedido';
  if (f.modo != null) o.modo = f.modo === 'direto' ? 'direto' : 'entrega';
  ['entrega', 'atende', 'pedir'].forEach((k) => { const d = _dias(f[k]); if (d) o[k] = d; });
  if (f.antec != null) o.antec = Math.max(0, Math.min(3, parseInt(f.antec, 10) || 0));
  if (f.prazo != null) o.prazo = /^\d{1,2}:\d{2}$/.test(String(f.prazo)) ? String(f.prazo).padStart(5, '0') : '';
  if (f.obs != null) o.obs = String(f.obs).trim().slice(0, 80);
  // completa o que faltar (mesmo padrão do formulário do index.html)
  if (!o.emoji) o.emoji = '📦';
  if (!o.tipo) o.tipo = 'pedido';
  if (!o.modo) o.modo = (o.pedir && o.pedir.length && !(o.entrega && o.entrega.length)) ? 'direto' : 'entrega';
  if (!Array.isArray(o.entrega)) o.entrega = [];
  if (!Array.isArray(o.pedir)) o.pedir = [];
  if (!Array.isArray(o.atende) || (!o.atende.length && o.modo === 'entrega' && o.tipo !== 'conferir')) o.atende = SEG_SAB.slice();
  if (o.antec == null) o.antec = 1;
  if (o.prazo == null) o.prazo = '';
  if (o.desc == null) o.desc = '';
  if (o.obs == null) o.obs = '';
  return o;
}
function _idNovo(nome, existentes) {
  let base = _norm(nome).replace(/[^a-z0-9]+/g, '').slice(0, 16) || ('f' + Date.now());
  let id = base, n = 2;
  while (existentes.some((f) => f.id === id)) id = base + n++;
  return id;
}

async function executar(db, tenantId, restauranteId, acao, podeEditar) {
  const tipo = acao && acao.tipo;
  const edita = tipo === 'salvarFornecedor' || tipo === 'removerFornecedor';
  if (edita && !podeEditar) {
    return { ok: true, tipo, negado: true, mensagem: '🔒 Só o gerente pode cadastrar, editar ou remover fornecedores. Peça pelo app de gestão.' };
  }
  const ref = refConfig(db, tenantId, restauranteId).doc('briefing');
  const sp = agoraSP();
  let saida = null;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = (snap.exists && snap.data() && snap.data().data) ? snap.data().data : {};
    if (!data.status) data.status = {};
    if (!Array.isArray(data.forn) || !data.forn.length) data.forn = fornPadrao();
    const forn = data.forn;
    const acharF = (id) => forn.find((f) => f.id === id);

    if (tipo === 'marcarPedido') {
      const f = acharF(acao.fornecedorId);
      if (!f) { saida = { ok: true, tipo, mensagem: 'Não achei esse fornecedor no cadastro.' }; return; }
      const status = acao.status === 'feito' || acao.status === 'nao' ? acao.status : null;
      const deHoje = sp.dow !== 0 && mapaPedido(f)[sp.dow] !== undefined;
      if (!data.status[sp.key]) data.status[sp.key] = {};
      if (status) data.status[sp.key][f.id] = status; else delete data.status[sp.key][f.id];
      saida = { ok: true, tipo, fornecedorId: f.id, nome: f.nome, status,
        mensagem: (status === 'feito' ? '✅ ' + f.emoji + ' ' + f.nome + ' marcado como pedido feito.'
          : status === 'nao' ? '➖ ' + f.emoji + ' ' + f.nome + ': não precisa hoje.'
          : '⬜ ' + f.emoji + ' ' + f.nome + ' voltou para pendente.') + (deHoje ? '' : ' (Obs.: não estava na lista de hoje.)') };
    } else if (tipo === 'salvarFornecedor') {
      const dadosF = acao.fornecedor || {};
      const existente = dadosF.id ? acharF(dadosF.id) : null;
      const novo = _limparForn(dadosF, existente ? JSON.parse(JSON.stringify(existente)) : null);
      if (!novo.nome) { saida = { ok: true, tipo, mensagem: 'Faltou o nome do fornecedor.' }; return; }
      if (!diasPedido(novo).length) { saida = { ok: true, tipo, mensagem: 'Faltaram os dias de ' + (novo.modo === 'entrega' && novo.tipo !== 'conferir' ? 'entrega' : 'pedir') + ' do ' + novo.nome + '.' }; return; }
      if (existente) { novo.id = existente.id; forn[forn.indexOf(existente)] = novo; }
      else { novo.id = _idNovo(novo.nome, forn); forn.push(novo); }
      const dp = diasPedido(novo);
      saida = { ok: true, tipo, fornecedorId: novo.id, nome: novo.nome, fornecedor: novo,
        mensagem: (existente ? '✏️ ' : '✅ ') + novo.emoji + ' ' + novo.nome + (existente ? ' atualizado.' : ' cadastrado.') +
          ' ' + (novo.tipo === 'conferir' ? 'Conferir' : 'Pedir') + ': ' + listaDias(dp) +
          (novo.modo === 'entrega' && novo.tipo !== 'conferir' ? ' (entrega ' + listaDias(novo.entrega) + ')' : '') + (novo.prazo ? ', até ' + novo.prazo : '') + '.' };
    } else if (tipo === 'removerFornecedor') {
      const f = acharF(acao.fornecedorId);
      if (!f) { saida = { ok: true, tipo, mensagem: 'Não achei esse fornecedor no cadastro.' }; return; }
      if (!acao.confirmado) {
        saida = { ok: true, tipo, fornecedorId: f.id, nome: f.nome, precisaConfirmar: true, mensagem: 'Remover o fornecedor ' + f.emoji + ' ' + f.nome + '? Ele sai da lista de pedidos.' };
        return;
      }
      forn.splice(forn.indexOf(f), 1);
      saida = { ok: true, tipo, fornecedorId: f.id, nome: f.nome, removido: true, mensagem: '🗑️ ' + f.nome + ' removido dos fornecedores.' };
    } else {
      saida = { ok: true, tipo: 'resposta', resposta: 'Não entendi o que fazer.' };
      return;
    }
    if (saida && (saida.precisaConfirmar)) return;
    // guarda só os últimos 14 dias de marcações (mesma regra do app)
    const lim = somarDias(sp, -14).key;
    Object.keys(data.status).forEach((k) => { if (k < lim) delete data.status[k]; });
    tx.set(ref, { data });
  });
  limparCache(tenantId, restauranteId);
  return saida;
}

// ── fluxo completo: entende a mensagem e responde/age ──
// chamarIA(prompt) → { ok, texto } (JSON da IA)
async function responder(opts) {
  const { db, tenantId, restauranteId, texto, historico, podeEditar, chamarIA, confirmacao } = opts;
  // confirmação de remoção (botão "Remover" no app): sem IA
  if (confirmacao && confirmacao.acao === 'desfazerRH') {
    const rd = await rh.desfazer(db, tenantId, restauranteId, confirmacao, podeEditar);
    rd.gestao = true;
    limparCache(tenantId, restauranteId);
    return rd;
  }
  if (confirmacao && confirmacao.acao === 'removerFornecedor') {
    const rc = await executar(db, tenantId, restauranteId, { tipo: 'removerFornecedor', fornecedorId: confirmacao.fornecedorId, confirmado: true }, podeEditar);
    rc.gestao = true;
    return rc;
  }
  const dados = await carregar(db, tenantId, restauranteId);
  const contexto = montarContexto(dados, podeEditar);
  const hist = (historico || []).slice(-8).map((h) => (h.autor === 'usuario' ? 'Usuário' : 'Assistente') + ': ' + String(h.texto || '').slice(0, 300)).join('\n');
  const r = await chamarIA(montarPrompt(texto, contexto, hist, podeEditar));
  if (!r || !r.ok) return { ok: false, error: 'Assistente indisponível agora. Tente de novo.', detalhe: r && r.detalhe };
  let parsed;
  try { parsed = JSON.parse(r.texto); } catch (e) {
    const m = String(r.texto || '').match(/\{[\s\S]*\}/);
    try { parsed = m ? JSON.parse(m[0]) : null; } catch (e2) { parsed = null; }
  }
  if (!parsed) return { ok: true, tipo: 'pergunta', resposta: 'Não consegui entender. Pode repetir de outro jeito?' };
  if (parsed.tipo === 'naoGestao') return { ok: true, naoGestao: true };

  const umaAcao = async (a) => {
    if (!a || a.tipo === 'resposta' || a.tipo === 'pergunta') return { ok: true, tipo: 'pergunta', resposta: String((a && (a.resposta || a.texto)) || 'Não entendi.') };
    if (rh.TIPOS.indexOf(a.tipo) >= 0) {
      const rr = await rh.executar(db, tenantId, restauranteId, a, podeEditar, agoraSP().key);
      limparCache(tenantId, restauranteId);
      return rr;
    }
    if (['marcarPedido', 'salvarFornecedor', 'removerFornecedor'].indexOf(a.tipo) < 0) return { ok: true, tipo: 'pergunta', resposta: 'Não entendi o que fazer.' };
    return executar(db, tenantId, restauranteId, a, podeEditar);
  };
  if (parsed.tipo === 'multiplo' && Array.isArray(parsed.acoes)) {
    const acoes = [];
    for (const a of parsed.acoes.slice(0, 40).filter((x) => x && x.tipo !== 'naoGestao')) acoes.push(Object.assign(await umaAcao(a), { gestao: true })); // em ordem (mesmo doc)
    return { ok: true, tipo: 'multiplo', gestao: true, acoes };
  }
  const out = await umaAcao(parsed);
  out.gestao = true;
  return out;
}

module.exports = {
  pareceGestao, responder, carregar, executar, montarContexto,
  // expostos pra teste
  _interno: { mapaPedido, diasPedido, chega, itensDoDia, agoraSP, somarDias, fornPadrao, refConfig, _limparForn },
};
