// NFC-e pela Focus NFe — emitir, consultar e cancelar a nota de uma conta fechada.
// Variáveis na Vercel:
//   FOCUS_AMBIENTE          'homologacao' (teste) | 'producao'
//   FOCUS_TOKEN_HOMOLOGACAO / FOCUS_TOKEN_PRODUCAO
//   FOCUS_CNPJ              (opcional) CNPJ do emitente — senão usa o doc fiscal/{tenantId} ou o padrão abaixo
// Códigos fiscais: padrão de restaurante no Simples Nacional, ajustáveis no doc Firestore fiscal/{tenantId}
//   { cnpj, padrao:{ncm,cfop,csosn,pis,cofins}, regras:[{palavras:[...], ncm, cfop, csosn, cest}], incluirServico:false }

const HOSTS = { homologacao: 'https://homologacao.focusnfe.com.br', producao: 'https://api.focusnfe.com.br' };
const CNPJ_PADRAO = { /* tenantId: 'cnpj só números' — preencher */ };

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

function ambiente() { return String(process.env.FOCUS_AMBIENTE || 'homologacao').toLowerCase().indexOf('prod') === 0 ? 'producao' : 'homologacao'; }
function token(amb) { return amb === 'producao' ? process.env.FOCUS_TOKEN_PRODUCAO : process.env.FOCUS_TOKEN_HOMOLOGACAO; }
function authHeader(tk) { return 'Basic ' + Buffer.from(String(tk).trim() + ':').toString('base64'); }

async function configFiscal(db, tenantId) {
  let doc = {};
  try { const d = await db.collection('fiscal').doc(String(tenantId)).get(); if (d.exists) doc = d.data() || {}; } catch (e) { /* sem config */ }
  return {
    cnpj: _so(doc.cnpj || process.env.FOCUS_CNPJ || CNPJ_PADRAO[tenantId] || ''),
    padrao: Object.assign({}, PADRAO, doc.padrao || {}),
    regras: (Array.isArray(doc.regras) ? doc.regras : []).concat(REGRAS_PADRAO),
    incluirServico: doc.incluirServico === true,
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

async function chamarFocus(amb, metodo, caminho, corpo) {
  const tk = token(amb);
  if (!tk) throw Object.assign(new Error('Token da Focus (' + amb + ') não configurado na Vercel.'), { usuario: true });
  const r = await fetch(HOSTS[amb] + caminho, {
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

async function _baixarXml(amb, caminho) {
  if (!caminho) return '';
  try {
    const url = /^https?:/.test(caminho) ? caminho : HOSTS[amb] + caminho;
    const r = await fetch(url, { headers: { Authorization: authHeader(token(amb)) } });
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

async function emitir(db, { tenantId, restauranteId, contaId, documento, nomeCliente, formaPagamento, garcom }) {
  const ref0 = db.collection('contas_fechadas').doc(String(contaId || ''));
  const snap = await ref0.get();
  if (!contaId || !snap.exists) return { ok: false, error: 'Conta não encontrada (ela pode ter sido apagada do histórico).' };
  const conta = snap.data();
  if (conta.tenantId && tenantId && conta.tenantId !== tenantId) return { ok: false, error: 'Conta de outro restaurante.' };
  if (conta.nfce && conta.nfce.status === 'autorizado') return { ok: true, jaEmitida: true, nfce: conta.nfce };

  const amb = ambiente();
  const cfg = await configFiscal(db, tenantId || conta.tenantId);
  if (!cfg.cnpj) return { ok: false, error: 'Falta o CNPJ do restaurante na configuração da nota.' };

  const doc = _so(documento);
  if (doc && doc.length === 11 && !cpfValido(doc)) return { ok: false, error: 'CPF inválido — confere os números.' };
  if (doc && doc.length === 14 && !cnpjValido(doc)) return { ok: false, error: 'CNPJ inválido — confere os números.' };
  if (doc && doc.length !== 11 && doc.length !== 14) return { ok: false, error: 'CPF tem 11 números e CNPJ tem 14.' };

  const itens = montarItens(conta, cfg, amb);
  if (!itens.length) return { ok: false, error: 'A conta não tem itens com valor.' };
  let totalC = itens.reduce((s, i) => s + i._c, 0);
  const servicoC = cfg.incluirServico ? centavos(conta.taxa10) : 0;
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
  if (cfg.incluirServico && servicoC > 0) nota.valor_outras_despesas = reais(servicoC);
  if (doc.length === 11) nota.cpf_destinatario = doc;
  if (doc.length === 14) { nota.cnpj_destinatario = doc; nota.indicador_inscricao_estadual_destinatario = 9; }
  if (doc && nomeCliente) nota.nome_destinatario = String(nomeCliente).slice(0, 60);

  const tentativa = ((conta.nfce && conta.nfce.tentativa) || 0) + 1;
  const ref = 'bav' + String(contaId).replace(/[^A-Za-z0-9]/g, '').slice(0, 30) + (tentativa > 1 ? 't' + tentativa : '');

  let { http, j } = await chamarFocus(amb, 'POST', '/v2/nfce?ref=' + encodeURIComponent(ref), nota);
  // assíncrono: espera um pouco a SEFAZ
  for (let i = 0; i < 6 && j && j.status === 'processando_autorizacao'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    ({ http, j } = await chamarFocus(amb, 'GET', '/v2/nfce/' + encodeURIComponent(ref) + '?completo=0'));
  }
  const base = { tentativa, contaId: String(contaId), tenantId: tenantId || conta.tenantId || null, restauranteId: restauranteId || conta.restauranteId || null,
    mesa: conta.mesa != null ? conta.mesa : null, documento: doc || '', total: reais(totalC + servicoC), emitidaPor: garcom || '', itens: itens.length };

  if (j && j.status === 'autorizado') {
    const xml = await _baixarXml(amb, j.caminho_xml_nota_fiscal);
    const nfce = _resumo(amb, ref, j, Object.assign(base, { impressao: Object.assign(dadosDoXml(xml), {
      itens: itens.map((i) => ({ cod: i.codigo_produto, desc: i.descricao, qtd: i.quantidade_comercial, un: i.unidade_comercial, unit: i.valor_unitario_comercial, total: i.valor_bruto })),
      pagamentos: pagamentos.map((p) => ({ forma: p.forma_pagamento, valor: p.valor_pagamento })),
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

async function cancelar(db, { contaId, justificativa, tenantId }) {
  const ref0 = db.collection('contas_fechadas').doc(String(contaId || ''));
  const snap = await ref0.get();
  const conta = snap.exists ? snap.data() : null;
  if (!conta || !conta.nfce || conta.nfce.status !== 'autorizado') return { ok: false, error: 'Não tem nota autorizada nessa conta.' };
  if (conta.tenantId && tenantId && conta.tenantId !== tenantId) return { ok: false, error: 'Conta de outro restaurante.' };
  const just = String(justificativa || 'Cancelamento solicitado pelo estabelecimento').trim();
  if (just.length < 15) return { ok: false, error: 'A justificativa precisa ter pelo menos 15 letras.' };
  const amb = conta.nfce.ambiente || ambiente();
  const { j } = await chamarFocus(amb, 'DELETE', '/v2/nfce/' + encodeURIComponent(conta.nfce.ref), { justificativa: just.slice(0, 255) });
  if (j && j.status === 'cancelado') {
    const nfce = Object.assign({}, conta.nfce, { status: 'cancelado', canceladaEm: Date.now(), justificativa: just, mensagemSefaz: j.mensagem_sefaz || '' });
    await Promise.all([ref0.update({ nfce }), db.collection('nfce').doc(conta.nfce.ref).set(nfce)]);
    return { ok: true, nfce };
  }
  return { ok: false, error: msgErro(j) };
}

module.exports = { emitir, cancelar, ambiente, _interno: { montarItens, montarPagamentos, configFiscal, fiscalDoItem, cpfValido, cnpjValido, dadosDoXml, PADRAO } };
