// NFC-e pela Focus NFe — emitir, cancelar e exportar notas de contas fechadas (mesa) e pedidos do totem.
// CADA RESTAURANTE EMITE COM O PRÓPRIO CNPJ (empresa separada na Focus, com certificado e tokens próprios).
// Variáveis na Vercel:
//   Bávaro ('default' no garçom/PDV, 'bavaro' na gestão):
//     FOCUS_AMBIENTE  ·  FOCUS_TOKEN_HOMOLOGACAO  ·  FOCUS_TOKEN_PRODUCAO   (CNPJ fixo abaixo)
//   Outro restaurante — mesmo nome + _<ID DO RESTAURANTE EM MAIÚSCULAS> (ex.: Prinzen):
//     FOCUS_CNPJ_PRINZEN · FOCUS_AMBIENTE_PRINZEN · FOCUS_TOKEN_HOMOLOGACAO_PRINZEN · FOCUS_TOKEN_PRODUCAO_PRINZEN
//   Sem essas variáveis o restaurante não emite (mensagem "ainda não configurada").
// Códigos fiscais: padrão de restaurante no Simples Nacional, ajustáveis no doc Firestore fiscal/{tenantId} (Bávaro) ou fiscal/{tenantId}__{restauranteId}
//   { cnpj, padrao:{ncm,cfop,csosn,pis,cofins}, regras:[{palavras:[...], ncm, cfop, csosn, cest}], incluirServico:true }  (taxa de serviço entra como 'outras despesas')

const HOSTS = { homologacao: 'https://homologacao.focusnfe.com.br', producao: 'https://api.focusnfe.com.br' };
const CNPJ_BAVARO = '14692372000130'; // Bávaro — Simples Nacional

// Simples Nacional: 5102 / CSOSN 102 (tributada pelo Simples, sem crédito). PIS/COFINS 49.
const PADRAO = { ncm: '21069090', cfop: '5102', csosn: '102', pis: '49', cofins: '49' };
// Só muda o NCM pelo tipo do produto (o imposto continua o padrão até o contador dizer outra coisa)
const REGRAS_PADRAO = [
  { palavras: ['chopp', 'chope', 'cerveja', 'heineken', 'brahma', 'skol', 'stella', 'budweiser', 'corona', 'original', 'amstel', 'spaten', 'eisenbahn', 'itaipava', 'antarctica', 'long neck'], ncm: '22030000' },
  { palavras: ['agua', 'água'], ncm: '22011000' },
  { palavras: ['coca', 'refri', 'refrigerante', 'guarana', 'guaraná', 'fanta', 'sprite', 'pepsi', 'soda', 'tonica', 'tônica', 'schweppes', 'h2oh', 'energetico', 'energético', 'red bull', 'monster'], ncm: '22021000' },
  { palavras: ['suco', 'limonada'], ncm: '20098990' },
  { palavras: ['vinho', 'espumante'], ncm: '22042100' },
  { palavras: ['cachaca', 'cachaça', 'caipirinha', 'caipiroska', 'vodka', 'whisky', 'gin', 'drink', 'dose', 'licor', 'tequila', 'rum'], ncm: '22089000' },
];
const FORMAS = { dinheiro: '01', credito: '03', 'cartao credito': '03', debito: '04', 'cartao debito': '04', pix: '17', vale: '10', 'vale refeicao': '11', voucher: '10' };

function _norm(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }
function _so(t) { return String(t || '').replace(/\D/g, ''); }
function centavos(v) { return Math.round((Number(v) || 0) * 100); }
function reais(c) { return (c / 100).toFixed(2); }

function cpfValido(c) {
  c = _so(c); if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  for (let t = 9; t < 11; t++) { let s = 0; for (let i = 0; i < t; i++) s += +c[i] * (t + 1 - i); if (((s * 10) % 11) % 10 !== +c[t]) return false; }
  return true;
}
function cnpjValido(c) {
  c = _so(c); if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (n) => { let s = 0, p = n - 7; for (let i = 0; i < n; i++) { s += +c[i] * p--; if (p < 2) p = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +c[12] && calc(13) === +c[13];
}

function chaveRest(r) { r = String(r || '').trim(); return (!r || r === 'default' || r === 'bavaro') ? 'bavaro' : r; }
function _suf(restId) { const k = chaveRest(restId); return k === 'bavaro' ? '' : '_' + k.toUpperCase().replace(/[^A-Z0-9]/g, '_'); }
function _env(nome, restId) { return process.env[nome + _suf(restId)]; }
// Outros restaurantes ficam em teste até terem FOCUS_AMBIENTE_<ID>=producao
function ambiente(restId) { return String(_env('FOCUS_AMBIENTE', restId) || 'homologacao').toLowerCase().indexOf('prod') === 0 ? 'producao' : 'homologacao'; }
function token(amb, restId) { return _env(amb === 'producao' ? 'FOCUS_TOKEN_PRODUCAO' : 'FOCUS_TOKEN_HOMOLOGACAO', restId); }
function emissor(restId, ambForcado) { const amb = ambForcado || ambiente(restId); return { amb, tk: token(amb, restId), rest: chaveRest(restId) }; }
function authHeader(tk) { return 'Basic ' + Buffer.from(String(tk).trim() + ':').toString('base64'); }

async function configFiscal(db, tenantId, restId) {
  let doc = {};
  const ehBavaro = chaveRest(restId) === 'bavaro';
  try { const d = await db.collection('fiscal').doc(String(tenantId) + (ehBavaro ? '' : '__' + chaveRest(restId))).get(); if (d.exists) doc = d.data() || {}; } catch (e) { /* sem config */ }
  return {
    cnpj: _so(doc.cnpj || _env('FOCUS_CNPJ', restId) || (ehBavaro ? CNPJ_BAVARO : '')),
    padrao: Object.assign({}, PADRAO, doc.padrao || {}),
    regras: (Array.isArray(doc.regras) ? doc.regras : []).concat(REGRAS_PADRAO),
    incluirServico: doc.incluirServico !== false, // padrão: a taxa de serviço entra na nota
  };
}
function fiscalDoItem(nome, cfg) {
  const n = ' ' + _norm(nome) + ' ';
  const r = cfg.regras.find((x) => (x.palavras || []).some((p) => n.indexOf(' ' + _norm(p)) >= 0));
  return Object.assign({}, cfg.padrao, r ? Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'palavras' && v)) : {});
}

// conta fechada → itens da nota (agrupa iguais; kg vira 1 UN com o valor da pesagem)
function montarItens(conta, cfg, amb) {
  const ativos = (conta.itens || []).filter((i) => i && i.status !== 'cancelado');
  const grupos = [];
  ativos.forEach((it) => {
    const kg = it.tipoVenda === 'kg' && it.peso;
    const unit = kg ? centavos(it.preco) : centavos(it.preco);
    const qtd = kg ? 1 : Math.max(1, Math.round(Number(it.qtd) || 1));
    const desc = String(it.nome || 'Item').trim() + (kg ? ' (' + (Number(it.peso) / 1000).toFixed(3).replace('.', ',') + ' kg)' : '');
    const chave = kg ? null : (it.id || it.nome) + '|' + unit;
    const g = chave && grupos.find((x) => x.chave === chave);
    if (g) g.qtd += qtd; else grupos.push({ chave, id: String(it.id || it.nome || 'item'), desc, unit, qtd, nome: it.nome });
  });
  return grupos.filter((g) => g.unit > 0).map((g, i) => {
    const f = fiscalDoItem(g.nome, cfg);
    let descricao = g.desc.slice(0, 120);
    if (amb === 'homologacao' && i === 0) descricao = 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';
    const item = {
      numero_item: i + 1,
      codigo_produto: g.id.slice(0, 60),
      descricao,
      codigo_ncm: _so(f.ncm),
      cfop: _so(f.cfop),
      unidade_comercial: 'UN', unidade_tributavel: 'UN',
      quantidade_comercial: g.qtd, quantidade_tributavel: g.qtd,
      valor_unitario_comercial: reais(g.unit), valor_unitario_tributavel: reais(g.unit),
      valor_bruto: reais(g.unit * g.qtd),
      icms_origem: 0,
      icms_situacao_tributaria: String(f.csosn),
      pis_situacao_tributaria: String(f.pis), cofins_situacao_tributaria: String(f.cofins),
      _c: g.unit * g.qtd,
    };
    if (f.cest) item.cest = _so(f.cest);
    return item;
  });
}

// pagamentos da conta → formas da nota, proporcional até fechar o valor exato da nota
function montarPagamentos(conta, totalC, formaEscolhida) {
  let pg = [];
  if (formaEscolhida) pg = [{ forma: formaEscolhida, valor: totalC / 100 }];
  else pg = (conta.pagamentos || []).filter((p) => p && Number(p.valor) > 0);
  if (!pg.length) return null;
  const somaC = pg.reduce((s, p) => s + centavos(p.valor), 0) || 1;
  const porForma = {};
  pg.forEach((p) => { const cod = FORMAS[_norm(p.forma)] || '99'; porForma[cod] = (porForma[cod] || 0) + centavos(p.valor); });
  const cods = Object.keys(porForma);
  let resto = totalC;
  return cods.map((cod, i) => {
    const v = i === cods.length - 1 ? resto : Math.round(totalC * porForma[cod] / somaC);
    resto -= v;
    const o = { forma_pagamento: cod, valor_pagamento: reais(v) };
    if (cod === '99') o.descricao_pagamento = 'Outros';
    return o;
  });
}

function dataSP() {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second + '-03:00';
}

function _tag(xml, nome) { const m = String(xml).match(new RegExp('<' + nome + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + nome + '>')); return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; }
// dados pra imprimir o DANFE NFC-e no próprio sistema
function dadosDoXml(xml) {
  if (!xml) return {};
  const emit = _tag(xml, 'emit'), end = _tag(emit, 'enderEmit');
  return {
    emitNome: _tag(emit, 'xNome'), emitFantasia: _tag(emit, 'xFant'), emitCnpj: _tag(emit, 'CNPJ'), emitIe: _tag(emit, 'IE'),
    emitEndereco: [_tag(end, 'xLgr'), _tag(end, 'nro')].filter(Boolean).join(', ') + (_tag(end, 'xBairro') ? ' - ' + _tag(end, 'xBairro') : ''),
    emitCidade: _tag(end, 'xMun') + (_tag(end, 'UF') ? '/' + _tag(end, 'UF') : ''),
    qrCode: _tag(xml, 'qrCode'), urlChave: _tag(xml, 'urlChave'),
    protocolo: _tag(xml, 'nProt'), dataAutorizacao: _tag(xml, 'dhRecbto'), dataEmissao: _tag(_tag(xml, 'ide'), 'dhEmi'),
    tributos: _tag(_tag(xml, 'ICMSTot'), 'vTotTrib'),
  };
}

async function chamarFocus(em, metodo, caminho, corpo) {
  const tk = em.tk;
  if (!tk) throw Object.assign(new Error('A nota fiscal ainda não foi configurada para este restaurante (falta o token da Focus de ' + (em.amb === 'producao' ? 'produção' : 'homologação') + ').'), { usuario: true });
  const r = await fetch(HOSTS[em.amb] + caminho, {
    method: metodo,
    headers: { Authorization: authHeader(tk), 'Content-Type': 'application/json' },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let j = null; const txt = await r.text();
  try { j = JSON.parse(txt); } catch (e) { j = { mensagem: txt.slice(0, 300) }; }
  return { http: r.status, j };
}
function msgErro(j) {
  if (!j) return 'Sem resposta da Focus.';
  const erros = Array.isArray(j.erros) ? j.erros.map((e) => (e.campo ? e.campo + ': ' : '') + (e.mensagem || '')).join('; ') : '';
  return [j.mensagem_sefaz, j.mensagem, erros].filter(Boolean).join(' — ') || ('Status ' + (j.status || '?'));
}

async function _baixarXml(em, caminho) {
  if (!caminho || !em.tk) return '';
  try {
    const url = /^https?:/.test(caminho) ? caminho : HOSTS[em.amb] + caminho;
    const r = await fetch(url, { headers: { Authorization: authHeader(em.tk) } });
    return r.ok ? await r.text() : '';
  } catch (e) { return ''; }
}

function _resumo(amb, ref, j, extra) {
  const base = HOSTS[amb];
  const abs = (p) => (p ? (/^https?:/.test(p) ? p : base + p) : '');
  return Object.assign({
    ref, ambiente: amb, status: j.status, numero: j.numero ? String(j.numero) : '', serie: j.serie ? String(j.serie) : '',
    chave: String(j.chave_nfe || '').replace(/^NFe/, ''), mensagemSefaz: j.mensagem_sefaz || '', statusSefaz: j.status_sefaz || '',
    danfeUrl: abs(j.caminho_danfe), xmlUrl: abs(j.caminho_xml_nota_fiscal), qrcodeUrl: j.qrcode_url || '', consultaUrl: j.url_consulta_nf || '',
    atualizadoEm: Date.now(),
  }, extra || {});
}

// Mesa (contas_fechadas) ou totem (tenants/{t}/restaurantes/{r}/pedidos_totem) — devolve no formato de conta
async function _origem(db, b) {
  if (b.origem === 'totem') {
    if (!b.pedidoId || !b.tenantId || !b.restauranteId) return null;
    const ref = db.collection('tenants').doc(String(b.tenantId)).collection('restaurantes').doc(String(b.restauranteId)).collection('pedidos_totem').doc(String(b.pedidoId));
    const s = await ref.get();
    if (!s.exists) return null;
    const p = s.data() || {};
    return { ref, id: 'tot' + b.pedidoId, conta: { tenantId: b.tenantId, restauranteId: b.restauranteId, mesa: null, senha: p.senha, itens: p.itens || [], taxa10: 0,
      pagamentos: p.formaPagamento ? [{ forma: p.formaPagamento, valor: p.total }] : [], nfce: p.nfce } };
  }
  if (!b.contaId) return null;
  const ref = db.collection('contas_fechadas').doc(String(b.contaId));
  const s = await ref.get();
  return s.exists ? { ref, id: String(b.contaId), conta: s.data() } : null;
}

async function emitir(db, b) {
  const { tenantId, documento, nomeCliente, formaPagamento, garcom } = b;
  const o = await _origem(db, b);
  if (!o) return { ok: false, error: b.origem === 'totem' ? 'Pedido do totem não encontrado.' : 'Conta não encontrada (ela pode ter sido apagada do histórico).' };
  const ref0 = o.ref, conta = o.conta, contaId = o.id;
  const restauranteId = conta.restauranteId || b.restauranteId;
  if (conta.tenantId && tenantId && conta.tenantId !== tenantId) return { ok: false, error: 'Conta de outro restaurante.' };
  if (conta.nfce && conta.nfce.status === 'autorizado') return { ok: true, jaEmitida: true, nfce: conta.nfce };

  const em = emissor(restauranteId);
  const amb = em.amb;
  const cfg = await configFiscal(db, tenantId || conta.tenantId, restauranteId);
  if (!cfg.cnpj) return { ok: false, error: 'A nota fiscal ainda não foi configurada para este restaurante (falta o CNPJ).' };
  if (!em.tk) return { ok: false, error: 'A nota fiscal ainda não foi configurada para este restaurante (falta o token da Focus).' };

  const doc = _so(documento);
  if (doc && doc.length === 11 && !cpfValido(doc)) return { ok: false, error: 'CPF inválido — confere os números.' };
  if (doc && doc.length === 14 && !cnpjValido(doc)) return { ok: false, error: 'CNPJ inválido — confere os números.' };
  if (doc && doc.length !== 11 && doc.length !== 14) return { ok: false, error: 'CPF tem 11 números e CNPJ tem 14.' };

  const itens = montarItens(conta, cfg, amb);
  if (!itens.length) return { ok: false, error: 'A conta não tem itens com valor.' };
  let totalC = itens.reduce((s, i) => s + i._c, 0);
  const servicoC = cfg.incluirServico ? Math.max(0, centavos(conta.taxa10)) : 0;
  // Taxa de serviço = "outras despesas acessórias" (vOutro), rateada entre os itens
  if (servicoC > 0) {
    let resto = servicoC;
    itens.forEach((it, k) => {
      const v = k === itens.length - 1 ? resto : Math.round(servicoC * it._c / totalC);
      resto -= v;
      if (v > 0) it.valor_outras_despesas = reais(v);
    });
  }
  const pagamentos = montarPagamentos(conta, totalC + servicoC, formaPagamento);
  if (!pagamentos) return { ok: false, precisaForma: true, error: 'Essa conta não tem pagamento registrado. Escolha a forma de pagamento.' };
  itens.forEach((i) => { delete i._c; });

  const nota = {
    cnpj_emitente: cfg.cnpj,
    data_emissao: dataSP(),
    natureza_operacao: 'VENDA AO CONSUMIDOR',
    tipo_documento: 1, finalidade_emissao: 1, consumidor_final: 1, presenca_comprador: 1, local_destino: 1, modalidade_frete: 9,
    valor_produtos: reais(totalC),
    valor_total: reais(totalC + servicoC),
    items: itens,
    formas_pagamento: pagamentos,
  };
  if (conta.mesa != null && conta.mesa !== '') nota.informacoes_adicionais_contribuinte = 'Mesa ' + conta.mesa;
  else if (conta.senha) nota.informacoes_adicionais_contribuinte = 'Totem senha ' + conta.senha;
  if (servicoC > 0) {
    nota.valor_outras_despesas = reais(servicoC);
    nota.informacoes_adicionais_contribuinte = (nota.informacoes_adicionais_contribuinte ? nota.informacoes_adicionais_contribuinte + '. ' : '') + 'Taxa de servico R$ ' + reais(servicoC).replace('.', ',');
  }
  if (doc.length === 11) nota.cpf_destinatario = doc;
  if (doc.length === 14) { nota.cnpj_destinatario = doc; nota.indicador_inscricao_estadual_destinatario = 9; }
  if (doc && nomeCliente) nota.nome_destinatario = String(nomeCliente).slice(0, 60);

  const tentativa = ((conta.nfce && conta.nfce.tentativa) || 0) + 1;
  const ref = 'bav' + String(contaId).replace(/[^A-Za-z0-9]/g, '').slice(0, 30) + (tentativa > 1 ? 't' + tentativa : '');

  let { http, j } = await chamarFocus(em, 'POST', '/v2/nfce?ref=' + encodeURIComponent(ref), nota);
  // assíncrono: espera um pouco a SEFAZ
  for (let i = 0; i < 6 && j && j.status === 'processando_autorizacao'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    ({ http, j } = await chamarFocus(em, 'GET', '/v2/nfce/' + encodeURIComponent(ref) + '?completo=0'));
  }
  const base = { tentativa, contaId: String(contaId), origem: b.origem === 'totem' ? 'totem' : 'mesa', tenantId: tenantId || conta.tenantId || null, restauranteId: restauranteId || null,
    mesa: conta.mesa != null ? conta.mesa : null, documento: doc || '', emitidaEm: Date.now(), total: reais(totalC + servicoC), emitidaPor: garcom || '', itens: itens.length };

  if (j && j.status === 'autorizado') {
    const xml = await _baixarXml(em, j.caminho_xml_nota_fiscal);
    const nfce = _resumo(amb, ref, j, Object.assign(base, { impressao: Object.assign(dadosDoXml(xml), {
      itens: itens.map((i) => ({ cod: i.codigo_produto, desc: i.descricao, qtd: i.quantidade_comercial, un: i.unidade_comercial, unit: i.valor_unitario_comercial, total: i.valor_bruto })),
      pagamentos: pagamentos.map((p) => ({ forma: p.forma_pagamento, valor: p.valor_pagamento })),
      produtos: reais(totalC), servico: reais(servicoC),
    }) }));
    await Promise.all([
      ref0.update({ nfce }),
      db.collection('nfce').doc(ref).set(nfce),
    ]);
    return { ok: true, nfce };
  }
  const erro = msgErro(j);
  const nfceErro = _resumo(amb, ref, j || {}, Object.assign(base, { status: (j && j.status) || 'erro', erro }));
  try { await ref0.update({ nfce: nfceErro }); } catch (e) { /* conta pode ter sumido */ }
  return { ok: false, error: erro, http, nfce: nfceErro };
}

async function cancelar(db, b) {
  const { justificativa, tenantId } = b;
  const o = await _origem(db, b);
  const ref0 = o && o.ref;
  const conta = o ? o.conta : null;
  if (!conta || !conta.nfce || conta.nfce.status !== 'autorizado') return { ok: false, error: 'Não tem nota autorizada nessa conta.' };
  if (conta.tenantId && tenantId && conta.tenantId !== tenantId) return { ok: false, error: 'Conta de outro restaurante.' };
  const just = String(justificativa || 'Cancelamento solicitado pelo estabelecimento').trim();
  if (just.length < 15) return { ok: false, error: 'A justificativa precisa ter pelo menos 15 letras.' };
  const em = emissor(conta.nfce.restauranteId || conta.restauranteId, conta.nfce.ambiente);
  const { j } = await chamarFocus(em, 'DELETE', '/v2/nfce/' + encodeURIComponent(conta.nfce.ref), { justificativa: just.slice(0, 255) });
  if (j && j.status === 'cancelado') {
    const nfce = Object.assign({}, conta.nfce, { status: 'cancelado', canceladaEm: Date.now(), justificativa: just, mensagemSefaz: j.mensagem_sefaz || '' });
    await Promise.all([ref0.update({ nfce }), db.collection('nfce').doc(conta.nfce.ref).set(nfce)]);
    return { ok: true, nfce };
  }
  return { ok: false, error: msgErro(j) };
}

// ── Exportação mensal pra contabilidade ──
function _mesDaNota(n) {
  const d = n.impressao && n.impressao.dataEmissao;
  if (d && /^\d{4}-\d{2}/.test(d)) return d.slice(0, 7);
  const ts = n.emitidaEm || n.atualizadoEm;
  if (!ts) return '';
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date(ts)).forEach((x) => { p[x.type] = x.value; });
  return p.year + '-' + p.month;
}
async function listarMes(db, tenantId, mes, incluirTestes, restauranteId) {
  if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) return { ok: false, error: 'Mês inválido.' };
  const snap = await db.collection('nfce').where('tenantId', '==', tenantId).get();
  const notas = [];
  snap.forEach((d) => {
    const n = d.data() || {};
    if (_mesDaNota(n) !== mes) return;
    if (chaveRest(n.restauranteId) !== chaveRest(restauranteId)) return; // cada restaurante tem o seu CNPJ
    if (!incluirTestes && n.ambiente !== 'producao') return;
    if (n.status !== 'autorizado' && n.status !== 'cancelado') return;
    notas.push({
      ref: n.ref || d.id, numero: n.numero, serie: n.serie, chave: n.chave, status: n.status, ambiente: n.ambiente,
      data: (n.impressao && n.impressao.dataEmissao) || (n.emitidaEm ? new Date(n.emitidaEm).toISOString() : ''),
      total: n.total, documento: n.documento || '', mesa: n.mesa, formas: ((n.impressao && n.impressao.pagamentos) || []).map((p) => p.forma + ':' + p.valor),
    });
  });
  notas.sort((a, b) => (Number(a.serie) - Number(b.serie)) || (Number(a.numero) - Number(b.numero)));
  return { ok: true, mes, notas };
}
async function xmlsDasNotas(db, tenantId, refs) {
  const lista = (Array.isArray(refs) ? refs : []).slice(0, 40).map(String);
  const saida = [];
  let i = 0;
  async function trabalhador() {
    while (i < lista.length) {
      const ref = lista[i++];
      try {
        const d = await db.collection('nfce').doc(ref).get();
        const n = d.exists ? d.data() : null;
        if (!n || n.tenantId !== tenantId) { saida.push({ ref, erro: 'não encontrada' }); continue; }
        const em = emissor(n.restauranteId, n.ambiente);
        const xml = await _baixarXml(em, n.xmlUrl);
        let xmlCancelamento = '';
        if (n.status === 'cancelado') {
          const c = await chamarFocus(em, 'GET', '/v2/nfce/' + encodeURIComponent(ref));
          if (c.j && c.j.caminho_xml_cancelamento) xmlCancelamento = await _baixarXml(em, c.j.caminho_xml_cancelamento);
        }
        saida.push({ ref, numero: n.numero, serie: n.serie, chave: n.chave, status: n.status, xml, xmlCancelamento, erro: xml ? '' : 'XML não baixou' });
      } catch (e) { saida.push({ ref, erro: e.message }); }
    }
  }
  await Promise.all([1, 2, 3, 4, 5, 6].map(trabalhador));
  return { ok: true, arquivos: saida };
}

module.exports = { emitir, cancelar, ambiente, listarMes, xmlsDasNotas, _interno: { chaveRest, emissor, montarItens, montarPagamentos, configFiscal, fiscalDoItem, cpfValido, cnpjValido, dadosDoXml, PADRAO } };
