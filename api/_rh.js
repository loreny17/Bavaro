// Funcionários pelo assistente de gestão: ficha, vales, faltas e feriados.
// Mesmo formato do index.html (Gestão Bávaro):
//   funcionarios/{id}           → { id(número), nome, cargo, cpf, nascimento, tel, admissao, agencia, conta,
//                                   cartaoNum, cartaoTipo, pendencias:{itau,vt}, arquivos:[], obs, criadoEm }
//   configuracoes/vfData        → { data: { 'AAAA-MM': { [funcId]: { vales:[{id,val,data,desc}],
//                                   faltas:[{id,data,desc,atestado,horas?}], feriados:[{id,data,desc}] } } } }
// CPF, banco e cartão NÃO vão pra IA.

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function refBase(db, tenantId, restauranteId) {
  const base = db.collection('tenants').doc(tenantId);
  if (!restauranteId || restauranteId === 'default' || restauranteId === 'bavaro') return base;
  return base.collection('restaurantes').doc(restauranteId);
}
function _norm(t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
function _dataOk(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const [a, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function br(iso) { if (!_dataOk(iso)) return iso || ''; const p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
function brCurto(iso) { if (!_dataOk(iso)) return iso || ''; const p = iso.split('-'); return p[2] + '/' + p[1]; }
function reais(v) { return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
function _tempoCasa(adm, hojeKey) {
  if (!_dataOk(adm)) return '';
  const [a1, m1, d1] = adm.split('-').map(Number), [a2, m2, d2] = hojeKey.split('-').map(Number);
  let meses = (a2 - a1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
  if (meses < 0) return 'começa em ' + br(adm);
  const anos = Math.floor(meses / 12); meses %= 12;
  if (!anos && !meses) return 'menos de 1 mês de casa';
  return [anos ? anos + (anos === 1 ? ' ano' : ' anos') : '', meses ? meses + (meses === 1 ? ' mês' : ' meses') : ''].filter(Boolean).join(' e ') + ' de casa';
}
function _idade(nasc, hojeKey) {
  if (!_dataOk(nasc)) return '';
  const [a1, m1, d1] = nasc.split('-').map(Number), [a2, m2, d2] = hojeKey.split('-').map(Number);
  return a2 - a1 - ((m2 < m1 || (m2 === m1 && d2 < d1)) ? 1 : 0);
}
function _mesKey(iso) { return iso.slice(0, 7); }
function _mesesAntes(hojeKey, n) {
  const [a, m] = hojeKey.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1 - n, 1));
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
function _nomeMes(k) { const [a, m] = k.split('-').map(Number); return MESES[m - 1] + '/' + a; }

// ── leitura ──
async function carregar(db, tenantId, restauranteId) {
  const base = refBase(db, tenantId, restauranteId);
  const [snap, vf] = await Promise.all([base.collection('funcionarios').get(), base.collection('configuracoes').doc('vfData').get()]);
  const funcs = [];
  snap.forEach((d) => { const x = d.data(); if (x && x.nome) funcs.push(x); });
  funcs.sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
  return { funcs, vf: (vf.exists && vf.data() && vf.data().data) || {} };
}

// ── é assunto de funcionário? ──
const RE_RH = /\b(funcionari[oa]s?|equipe|colaborador(es)?|vales?\s+(de\s+)?(r\$\s*)?\d|vales?\s+(pro|pra|para|do|da|de)\b|adiantamento|faltas?\s+(pro|pra|para)\b|(marca|marcar|lanca|lancar|lança|lançar|deu|teve)\s+(uma\s+)?falta|faltou|atestado|feriado|admiss|admitid|comecou a trabalhar|começou a trabalhar|tempo de casa|aniversari|ficha d[oa]|cadastra(r)?\s+(o|a)\s+(funcionari[oa]\s+)?[a-z])/;
const RE_RH_NOME = /\b(vale|falta|faltou|feriado|atestado|telefone|celular|whats|zap|numero|contato|admiss|comecou|entrou|nasceu|nascimento|anivers|idade|cargo|funcao|ficha|dados)\b/;
function pareceRH(texto, nomesFunc) {
  const t = _norm(texto);
  if (RE_RH.test(t)) return true;
  return (nomesFunc || []).some((n) => new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(t)) && RE_RH_NOME.test(t);
}
function nomesParaRota(funcs) {
  const s = new Set();
  funcs.forEach((f) => { const n = _norm(f.nome).trim(); if (n.length >= 3) { s.add(n); const p = n.split(/\s+/)[0]; if (p.length >= 3) s.add(p); } });
  return Array.from(s);
}

// ── contexto pra IA ──
function montarContexto(dados, hojeKey) {
  const { funcs, vf } = dados;
  const L = ['\nFUNCIONÁRIOS CADASTRADOS (' + funcs.length + '):'];
  if (!funcs.length) L.push('- nenhum');
  funcs.forEach((f) => {
    const id = _idade(f.nascimento, hojeKey);
    const pend = [];
    if (f.pendencias && f.pendencias.itau) pend.push('falta conta Itaú');
    if (f.pendencias && f.pendencias.vt) pend.push('falta cartão VT');
    L.push('- [id:' + f.id + '] ' + f.nome + (f.cargo ? ' | cargo: ' + f.cargo : '') + (f.tel ? ' | tel: ' + f.tel : ' | tel: não cadastrado') +
      (f.admissao ? ' | admissão: ' + br(f.admissao) + ' (' + _tempoCasa(f.admissao, hojeKey) + ')' : ' | admissão: não cadastrada') +
      (f.nascimento ? ' | nascimento: ' + br(f.nascimento) + (id !== '' ? ' (' + id + ' anos)' : '') : '') +
      (pend.length ? ' | pendências: ' + pend.join(', ') : '') + (f.obs ? ' | obs: ' + String(f.obs).slice(0, 120).replace(/\s+/g, ' ') : ''));
  });
  const nomePorId = {};
  funcs.forEach((f) => { nomePorId[String(f.id)] = f.nome; });
  for (let i = 0; i < 3; i++) {
    const mk = _mesesAntes(hojeKey, i);
    const mes = vf[mk] || {};
    L.push('\nVALES, FALTAS E FERIADOS — ' + _nomeMes(mk) + (i === 0 ? ' (mês atual)' : '') + ':');
    const ids = Object.keys(mes).filter((fid) => { const d = mes[fid] || {}; return (d.vales || []).length || (d.faltas || []).length || (d.feriados || []).length; });
    if (!ids.length) { L.push('- nada lançado'); continue; }
    ids.forEach((fid) => {
      const d = mes[fid];
      const vales = (d.vales || []).slice().sort((a, b) => String(a.data).localeCompare(String(b.data)));
      const faltas = (d.faltas || []).slice().sort((a, b) => String(a.data).localeCompare(String(b.data)));
      const fer = (d.feriados || []).slice().sort((a, b) => String(a.data).localeCompare(String(b.data)));
      const tot = vales.reduce((s, v) => s + (Number(v.val) || 0), 0);
      const partes = [];
      if (vales.length) partes.push('vales ' + reais(tot) + ' (' + vales.map((v) => brCurto(v.data) + ' ' + reais(v.val) + (v.desc ? ' ' + v.desc : '')).join('; ') + ')');
      if (faltas.length) partes.push('faltas ' + faltas.length + ' (' + faltas.map((x) => brCurto(x.data) + (x.atestado ? ' atestado' : '') + (x.horas ? ' ' + x.horas + 'h' : '') + (x.desc ? ' ' + x.desc : '')).join('; ') + ')');
      if (fer.length) partes.push('feriados trabalhados ' + fer.length + ' (' + fer.map((x) => brCurto(x.data) + (x.desc ? ' ' + x.desc : '')).join('; ') + ')');
      L.push('- ' + (nomePorId[fid] || ('funcionário removido ' + fid)) + ': ' + partes.join(' | '));
    });
  }
  return L.join('\n');
}

const PROMPT = `6) Lançar VALE pra um funcionário ("vale de 100 pro Rodrigo"):
{"tipo":"lancarVale","funcionarioId":123,"valor":100,"data":"AAAA-MM-DD","desc":""}
7) Lançar FALTA ("falta pro João", "o João faltou ontem", "atestado da Ana hoje", "o Pedro faltou 2 horas"):
{"tipo":"lancarFalta","funcionarioId":123,"data":"AAAA-MM-DD","atestado":false,"horas":0,"desc":""}
- horas > 0 só se for falta parcial (em horas). atestado true se falar de atestado.
8) Lançar FERIADO trabalhado ("feriado pro João dia 12/10", "marca feriado hoje pra todo mundo" → multiplo com um por funcionário):
{"tipo":"lancarFeriado","funcionarioId":123,"data":"AAAA-MM-DD","desc":"nome do feriado se souber"}
9) Cadastrar funcionário ("cadastra a Luciane, começou dia 10/10"):
{"tipo":"cadastrarFuncionario","funcionario":{"nome":"Luciane","cargo":"","tel":"","admissao":"AAAA-MM-DD","nascimento":"","obs":""}}
10) Mudar dados de um funcionário ("o telefone do João agora é 71 99999-0000", "a Ana agora é cozinheira"):
{"tipo":"editarFuncionario","funcionarioId":123,"campos":{"tel":"..."}}  (campos possíveis: nome, cargo, tel, admissao, nascimento, obs)
REGRAS DE FUNCIONÁRIOS:
- Perguntas ("qual o número do Rodrigo", "quando a Luciane começou", "quanto de vale o João pegou esse mês", "quem faltou essa semana") → formato 1, usando FUNCIONÁRIOS CADASTRADOS e VALES, FALTAS E FERIADOS.
- Use o funcionarioId exato da lista. Se o nome bater com mais de um funcionário, ou com nenhum, responda no formato 1 perguntando qual (cite os nomes completos).
- Datas sempre AAAA-MM-DD. Sem data = hoje. "ontem" = hoje - 1. "dia 10/10" sem ano = o ano atual (se ficar no futuro e for admissão, use o ano anterior).
- "vale de 100" = valor 100. "50 reais de vale" = 50. Sem valor → pergunte no formato 1.
- Cadastro: só o nome é obrigatório; admissão sem data → hoje.`;

function promptRH(podeEditar) {
  if (!podeEditar) return '\nFUNCIONÁRIOS: este usuário NÃO tem acesso a dados de funcionários. Se perguntar ou pedir algo de funcionário (vale, falta, feriado, telefone, admissão, cadastro), responda no formato 1: "🔒 Só o gerente pode ver e lançar dados de funcionários. Use o app de gestão."';
  return '\n' + PROMPT;
}

const TIPOS = ['lancarVale', 'lancarFalta', 'lancarFeriado', 'cadastrarFuncionario', 'editarFuncionario'];

// ── gravação ──
async function executar(db, tenantId, restauranteId, acao, podeEditar, hojeKey) {
  const tipo = acao && acao.tipo;
  if (!podeEditar) return { ok: true, tipo, negado: true, mensagem: '🔒 Só o gerente pode ver e lançar dados de funcionários. Use o app de gestão.' };
  const base = refBase(db, tenantId, restauranteId);

  if (tipo === 'cadastrarFuncionario') {
    const f = acao.funcionario || {};
    const nome = String(f.nome || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!nome) return { ok: true, tipo, mensagem: 'Qual o nome do funcionário?' };
    const snap = await base.collection('funcionarios').get();
    let igual = null;
    snap.forEach((d) => { const x = d.data(); if (x && _norm(x.nome).trim() === _norm(nome)) igual = x; });
    if (igual) return { ok: true, tipo, mensagem: 'Já existe um funcionário chamado ' + igual.nome + ' no cadastro.' };
    const admissao = _dataOk(f.admissao) ? f.admissao : hojeKey;
    const novo = {
      id: Date.now(), nome, cargo: String(f.cargo || '').trim().slice(0, 60), cpf: '',
      nascimento: _dataOk(f.nascimento) ? f.nascimento : '', tel: String(f.tel || '').trim().slice(0, 30), admissao,
      agencia: '', conta: '', cartaoNum: '', cartaoTipo: '', pendencias: { itau: false, vt: false }, arquivos: [],
      obs: String(f.obs || '').trim().slice(0, 500), criadoEm: new Date().toISOString(), criadoPeloAssistente: true,
    };
    await base.collection('funcionarios').doc(String(novo.id)).set(novo);
    return { ok: true, tipo, funcionarioId: novo.id, nome,
      mensagem: '✅ ' + nome + ' cadastrado(a). Admissão: ' + br(admissao) + (novo.cargo ? ' · ' + novo.cargo : '') + (novo.tel ? ' · ' + novo.tel : '') + '.\nCPF, conta e cartão você completa na ficha.',
      desfazer: { acao: 'desfazerRH', lista: 'funcionario', funcionarioId: novo.id } };
  }

  if (tipo === 'editarFuncionario') {
    const ref = base.collection('funcionarios').doc(String(acao.funcionarioId));
    const c = acao.campos || {};
    let saida;
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) { saida = { ok: true, tipo, mensagem: 'Não achei esse funcionário no cadastro.' }; return; }
      const f = s.data();
      const mud = [];
      const rot = { nome: 'nome', cargo: 'cargo', tel: 'telefone', admissao: 'admissão', nascimento: 'nascimento', obs: 'observação' };
      Object.keys(rot).forEach((k) => {
        if (c[k] == null) return;
        let v = String(c[k]).trim();
        if ((k === 'admissao' || k === 'nascimento') && v && !_dataOk(v)) return;
        if (k === 'nome' && !v) return;
        v = v.slice(0, k === 'obs' ? 500 : 80);
        f[k] = v;
        mud.push(rot[k] + ': ' + ((k === 'admissao' || k === 'nascimento') ? br(v) : (v || '(vazio)')));
      });
      if (!mud.length) { saida = { ok: true, tipo, mensagem: 'Não entendi o que mudar na ficha.' }; return; }
      tx.set(ref, f);
      saida = { ok: true, tipo, funcionarioId: f.id, nome: f.nome, mensagem: '✏️ Ficha de ' + f.nome + ' atualizada — ' + mud.join(', ') + '.' };
    });
    return saida;
  }

  if (tipo === 'lancarVale' || tipo === 'lancarFalta' || tipo === 'lancarFeriado') {
    const fid = String(acao.funcionarioId || '');
    const fs = await base.collection('funcionarios').doc(fid).get();
    if (!fid || !fs.exists) return { ok: true, tipo, mensagem: 'Não achei esse funcionário no cadastro.' };
    const func = fs.data();
    const data = _dataOk(acao.data) ? acao.data : hojeKey;
    const mk = _mesKey(data);
    const lista = tipo === 'lancarVale' ? 'vales' : tipo === 'lancarFalta' ? 'faltas' : 'feriados';
    let item;
    if (tipo === 'lancarVale') {
      const val = Math.round(Number(String(acao.valor).replace(',', '.')) * 100) / 100;
      if (!(val > 0)) return { ok: true, tipo, mensagem: 'Qual o valor do vale do ' + func.nome + '?' };
      item = { id: 'v' + Date.now(), val, data, desc: String(acao.desc || '').trim().slice(0, 80) };
    } else if (tipo === 'lancarFalta') {
      const horas = Math.max(0, Math.min(23, Number(acao.horas) || 0));
      item = { id: 'f' + Date.now(), data, desc: String(acao.desc || '').trim().slice(0, 80), atestado: !!acao.atestado };
      if (horas > 0) item.horas = horas;
    } else {
      item = { id: 'fe' + Date.now(), data, desc: String(acao.desc || '').trim().slice(0, 60) };
    }
    const ref = base.collection('configuracoes').doc('vfData');
    let saida;
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      const vf = (s.exists && s.data() && s.data().data) || {};
      if (!vf[mk]) vf[mk] = {};
      if (!vf[mk][fid]) vf[mk][fid] = { vales: [], faltas: [] };
      const d = vf[mk][fid];
      if (!d[lista]) d[lista] = [];
      if (lista === 'faltas' && !item.horas && d.faltas.some((x) => x.data === data && !x.horas)) {
        saida = { ok: true, tipo, mensagem: '⚠️ ' + func.nome + ' já tem falta lançada em ' + br(data) + '.' }; return;
      }
      if (lista === 'feriados' && d.feriados.some((x) => x.data === data)) {
        saida = { ok: true, tipo, mensagem: '⚠️ ' + func.nome + ' já tem feriado lançado em ' + br(data) + '.' }; return;
      }
      d[lista].push(item);
      tx.set(ref, { data: vf });
      const totVale = lista === 'vales' ? d.vales.reduce((t, v) => t + (Number(v.val) || 0), 0) : 0;
      saida = { ok: true, tipo, funcionarioId: func.id, nome: func.nome,
        mensagem: lista === 'vales' ? '💰 Vale de ' + reais(item.val) + ' lançado pro(a) ' + func.nome + ' em ' + br(data) + '. Total de vales em ' + _nomeMes(mk) + ': ' + reais(totVale) + '.'
          : lista === 'faltas' ? (item.atestado ? '📋 Atestado' : item.horas ? '⏱ Falta parcial de ' + item.horas + 'h' : '❌ Falta') + ' lançada pro(a) ' + func.nome + ' em ' + br(data) + '.'
          : '🏛️ Feriado lançado pro(a) ' + func.nome + ' em ' + br(data) + (item.desc ? ' (' + item.desc + ')' : '') + '.',
        desfazer: { acao: 'desfazerRH', lista, mes: mk, funcionarioId: fid, itemId: item.id } };
    });
    return saida;
  }
  return { ok: true, tipo: 'pergunta', resposta: 'Não entendi o que fazer.' };
}

// botão "Desfazer" (sem IA)
async function desfazer(db, tenantId, restauranteId, c, podeEditar) {
  if (!podeEditar) return { ok: true, tipo: 'desfazerRH', negado: true, mensagem: '🔒 Só o gerente pode alterar dados de funcionários.' };
  const base = refBase(db, tenantId, restauranteId);
  if (c.lista === 'funcionario') {
    const ref = base.collection('funcionarios').doc(String(c.funcionarioId));
    const s = await ref.get();
    if (!s.exists) return { ok: true, tipo: 'desfazerRH', mensagem: 'Esse cadastro já não existe.' };
    const f = s.data();
    const recente = f.criadoPeloAssistente && Date.now() - new Date(f.criadoEm).getTime() < 30 * 60 * 1000;
    if (!recente) return { ok: true, tipo: 'desfazerRH', mensagem: 'Esse cadastro já é antigo — se quiser remover, use o app de gestão.' };
    await ref.delete();
    return { ok: true, tipo: 'desfazerRH', desfeito: true, mensagem: '↩️ Cadastro de ' + f.nome + ' desfeito.' };
  }
  if (!['vales', 'faltas', 'feriados'].includes(c.lista) || !/^\d{4}-\d{2}$/.test(String(c.mes || ''))) return { ok: true, tipo: 'desfazerRH', mensagem: 'Não consegui desfazer.' };
  const ref = base.collection('configuracoes').doc('vfData');
  let saida = { ok: true, tipo: 'desfazerRH', mensagem: 'Esse lançamento já não existe.' };
  await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    const vf = (s.exists && s.data() && s.data().data) || {};
    const d = vf[c.mes] && vf[c.mes][String(c.funcionarioId)];
    if (!d || !Array.isArray(d[c.lista])) return;
    const antes = d[c.lista].length;
    d[c.lista] = d[c.lista].filter((x) => x.id !== c.itemId);
    if (d[c.lista].length === antes) return;
    tx.set(ref, { data: vf });
    saida = { ok: true, tipo: 'desfazerRH', desfeito: true, mensagem: '↩️ Lançamento desfeito.' };
  });
  return saida;
}

module.exports = { carregar, pareceRH, nomesParaRota, montarContexto, promptRH, executar, desfazer, TIPOS, _interno: { _tempoCasa, _idade, _dataOk, refBase } };
