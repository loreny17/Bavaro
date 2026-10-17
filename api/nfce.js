// POST /api/nfce — emitir / cancelar NFC-e de uma conta fechada (lógica em ./_nfce.js)
// body: { acao:'emitir'|'cancelar', tenantId, restauranteId, contaId, documento?, nomeCliente?, formaPagamento?, garcom?, justificativa? }
const nfce = require('./_nfce');
const { getDb, garcomEhAdmin } = require('./_assistente');
const admin = require('firebase-admin');

// PDV logado: confere o token do Firebase e se o usuário é desse restaurante
async function _usuarioDoTenant(db, idToken, tenantId) {
  if (!idToken || !tenantId) return false;
  try {
    const tok = await admin.auth().verifyIdToken(String(idToken));
    const u = await db.collection('users').doc(tok.uid).get();
    if (u.exists && u.data().tenantId === tenantId) return true;
    const t = await db.collection('tenants').doc(tenantId).get();
    const td = t.exists ? (t.data() || {}) : {};
    return td.ownerUid === tok.uid || (!!tok.email && td.ownerEmail === tok.email);
  } catch (e) { return false; }
}

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ ok: true, ambiente: nfce.ambiente() });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });
  const b = req.body || {};
  try {
    const db = getDb();
    if (b.acao === 'exportarLista' || b.acao === 'exportarXmls') {
      if (!(await _usuarioDoTenant(db, b.idToken, b.tenantId))) return res.status(401).json({ ok: false, error: 'Faça login de novo no PDV.' });
      if (b.acao === 'exportarLista') return res.status(200).json(await nfce.listarMes(db, b.tenantId, b.mes, b.incluirTestes === true));
      return res.status(200).json(await nfce.xmlsDasNotas(db, b.tenantId, b.refs));
    }
    if (b.acao === 'cancelar') {
      if (!(await garcomEhAdmin(db, b.restauranteId, String(b.garcom || '')))) return res.status(200).json({ ok: false, error: '🔒 Só o gerente (garçom admin) pode cancelar nota.' });
      return res.status(200).json(await nfce.cancelar(db, b));
    }
    return res.status(200).json(await nfce.emitir(db, b));
  } catch (e) {
    console.error('[nfce]', e);
    return res.status(e.usuario ? 200 : 500).json({ ok: false, error: e.usuario ? e.message : 'Falha ao falar com a Focus: ' + e.message });
  }
};
