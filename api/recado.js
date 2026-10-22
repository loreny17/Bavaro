// POST /api/recado — "📣 Falar com garçom": o gerente (garçom admin) manda um recado
// e ele chega como NOTIFICAÇÃO no celular do garçom:
//   • APK do Garçom (Android): notificação nativa, som próprio, botões "Vi" / "Já vou"
//   • iPhone / navegador: notificação web (quando o app estiver instalado e liberado)
//   • App aberto: aparece também um aviso na tela (o app escuta recados_garcom)
//
// body.acao:
//   'registrar' { tenantId, restauranteId, garcom, token, plataforma }  → liga o aparelho ao garçom
//   'listar'    { restauranteId, de }                                   → garçons + quantos aparelhos cada um tem
//   'enviar'    { tenantId, restauranteId, de, para:[nomes]|['__todos__'], texto, urgente }
//   'resposta'  { id, resposta:'visto'|'ja_vou', token? , garcom? }     → botão da notificação / do aviso
const crypto = require('crypto');
const admin = require('firebase-admin');
const { getDb, garcomEhAdmin } = require('./_assistente');

function norm(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
function idDoToken(token) { return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 40); }
const SITE = 'https://bavaro-plum.vercel.app';
const TOKEN_MORTO = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'];

async function garconsDaLoja(db, restauranteId) {
  const d = await db.collection('restaurantes_publicos').doc(String(restauranteId || 'default')).get();
  const gs = (d.exists && d.data() && d.data().garcons) || [];
  return gs.filter((g) => g && g.nome && g.ativo !== false).map((g) => ({ nome: String(g.nome), apelido: String(g.apelido || ''), admin: g.admin === true }));
}
// "Rodrigo" / "rodrigo silva" / apelido → nome cadastrado
function acharGarcom(lista, nome) {
  const n = norm(nome);
  if (!n) return null;
  return lista.find((g) => norm(g.nome) === n || (g.apelido && norm(g.apelido) === n))
    || lista.find((g) => norm(String(g.nome).split(' ')[0]) === n) || null;
}

async function enviarParaAparelho(ap, recado) {
  const titulo = (recado.urgente ? '🚨 ' : '📣 ') + 'Recado de ' + (recado.de || 'gerente');
  const data = {
    tipo: 'recado', id: recado.id, titulo, texto: recado.texto, de: recado.de || '',
    urgente: recado.urgente ? '1' : '0', url: SITE + '/garcom.html?recado=' + recado.id,
  };
  const msg = { token: ap.token, data };
  if (ap.plataforma === 'android') {
    // só "data": quem desenha a notificação é o próprio APK (som, botões, insistente)
    msg.android = { priority: 'high', ttl: 6 * 3600 * 1000 };
  } else {
    msg.webpush = {
      headers: { Urgency: 'high', TTL: String(6 * 3600) },
      notification: {
        title: titulo, body: recado.texto, icon: SITE + '/icon-garcom-192.png', badge: SITE + '/icon-garcom-192.png',
        tag: 'recado-' + recado.id, requireInteraction: true, vibrate: [400, 150, 400, 150, 400],
      },
      fcmOptions: { link: data.url },
    };
  }
  try {
    await admin.messaging().send(msg);
    return { ok: true };
  } catch (e) {
    return { ok: false, codigo: e.code || '', erro: e.message || String(e) };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });
  const b = req.body || {};
  try {
    const db = getDb();

    if (b.acao === 'registrar') {
      const token = String(b.token || '').trim();
      if (!token || token.length < 20 || !b.restauranteId || !b.garcom) return res.status(200).json({ ok: false, error: 'Dados incompletos.' });
      const lista = await garconsDaLoja(db, b.restauranteId);
      const g = acharGarcom(lista, b.garcom);
      if (!g) return res.status(200).json({ ok: false, error: 'Garçom não encontrado nesta loja.' });
      await db.collection('garcom_aparelhos').doc(idDoToken(token)).set({
        tenantId: b.tenantId || null, restauranteId: String(b.restauranteId), garcom: g.nome, garcomNorm: norm(g.nome),
        token, plataforma: b.plataforma === 'android' ? 'android' : 'web',
        modelo: String(b.modelo || '').slice(0, 80), atualizadoEm: Date.now(),
      });
      return res.status(200).json({ ok: true, garcom: g.nome });
    }

    if (b.acao === 'listar') {
      if (!(await garcomEhAdmin(db, b.restauranteId, String(b.de || '')))) return res.status(200).json({ ok: false, error: '🔒 Só o gerente (garçom admin) pode mandar recado.' });
      const lista = await garconsDaLoja(db, b.restauranteId);
      const snap = await db.collection('garcom_aparelhos').where('restauranteId', '==', String(b.restauranteId)).get();
      const cont = {};
      snap.forEach((d) => { const v = d.data() || {}; const k = v.garcomNorm; cont[k] = cont[k] || { android: 0, web: 0 }; cont[k][v.plataforma === 'android' ? 'android' : 'web']++; });
      return res.status(200).json({ ok: true, garcons: lista.map((g) => Object.assign({ nome: g.nome }, cont[norm(g.nome)] || { android: 0, web: 0 })) });
    }

    if (b.acao === 'enviar') {
      const de = String(b.de || '');
      if (!(await garcomEhAdmin(db, b.restauranteId, de))) return res.status(200).json({ ok: false, error: '🔒 Só o gerente (garçom admin) pode mandar recado.' });
      const texto = String(b.texto || '').trim().slice(0, 300);
      if (!texto) return res.status(200).json({ ok: false, error: 'Escreva o recado.' });
      const lista = await garconsDaLoja(db, b.restauranteId);
      const para = Array.isArray(b.para) ? b.para : [];
      let dest = para.indexOf('__todos__') >= 0
        ? lista.filter((g) => { const eu = acharGarcom(lista, de); return !eu || eu.nome !== g.nome; })
        : para.map((n) => acharGarcom(lista, n)).filter(Boolean);
      dest = dest.filter((g, i, a) => a.findIndex((x) => x.nome === g.nome) === i);
      if (!dest.length) return res.status(200).json({ ok: false, error: 'Escolha pra quem é o recado.' });

      const snapAp = await db.collection('garcom_aparelhos').where('restauranteId', '==', String(b.restauranteId)).get();
      const aparelhos = [];
      snapAp.forEach((d) => aparelhos.push(Object.assign({ _id: d.id }, d.data())));

      const resultado = [];
      for (const g of dest) {
        const ref = db.collection('recados_garcom').doc();
        const aps = aparelhos.filter((a) => a.garcomNorm === norm(g.nome));
        const recado = {
          id: ref.id, tenantId: b.tenantId || null, restauranteId: String(b.restauranteId), de, para: g.nome, paraNorm: norm(g.nome),
          texto, urgente: b.urgente === true, criadoEm: Date.now(), status: 'enviado', tokens: aps.map((a) => a.token),
        };
        await ref.set(recado);
        let enviados = 0;
        for (const ap of aps) {
          const r = await enviarParaAparelho(ap, recado);
          if (r.ok) enviados++;
          else if (TOKEN_MORTO.indexOf(r.codigo) >= 0) { try { await db.collection('garcom_aparelhos').doc(ap._id).delete(); } catch (e) { /* ok */ } }
          else console.warn('[recado] envio falhou', g.nome, r.codigo, r.erro);
        }
        await ref.update({ aparelhos: aps.length, notificados: enviados });
        resultado.push({ nome: g.nome, id: ref.id, aparelhos: aps.length, notificados: enviados });
      }
      return res.status(200).json({ ok: true, resultado });
    }

    if (b.acao === 'resposta') {
      const id = String(b.id || '');
      const resp = b.resposta === 'ja_vou' ? 'ja_vou' : 'visto';
      if (!id) return res.status(200).json({ ok: false, error: 'Recado não informado.' });
      const ref = db.collection('recados_garcom').doc(id);
      const d = await ref.get();
      if (!d.exists) return res.status(200).json({ ok: false, error: 'Recado não encontrado.' });
      const r = d.data() || {};
      const okToken = b.token && (r.tokens || []).indexOf(String(b.token)) >= 0;
      const okNome = b.garcom && norm(b.garcom) === r.paraNorm;
      if (!okToken && !okNome) return res.status(200).json({ ok: false, error: 'Esse recado não é pra você.' });
      // "Já vou" vale mais que "Vi" — não volta pra trás
      const upd = { respondidoEm: Date.now() };
      if (resp === 'ja_vou' || r.status !== 'ja_vou') upd.status = resp;
      if (resp === 'visto' && !r.vistoEm) upd.vistoEm = Date.now();
      if (resp === 'ja_vou') upd.jaVouEm = Date.now();
      await ref.update(upd);
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: false, error: 'Ação desconhecida.' });
  } catch (e) {
    console.error('[recado]', e);
    return res.status(200).json({ ok: false, error: e.message || 'Erro' });
  }
};
