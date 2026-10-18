// POST /api/nfce — emitir / cancelar NFC-e de uma conta fechada (lógica em ./_nfce.js)
// body: { acao:'emitir'|'cancelar'|'exportarLista'|'exportarXmls', tenantId, restauranteId, contaId | (origem:'totem', pedidoId), documento?, formaPagamento?, garcom?, justificativa? }
const nfce = require('./_nfce');
const { getDb, garcomEhAdmin } = require('./_assistente');
const admin = require('firebase-admin');

// PDV logado: confere o token do Firebase e se o usuário é desse restaurante.
// Devolve '' quando ok, ou o motivo da recusa (aparece na tela pra diagnóstico).
async function _motivoRecusa(db, idToken, tenantId) {
  if (!tenantId) return 'o PDV ainda não sabe qual é o restaurante (recarregue a página)';
  if (!idToken) return 'sem login no PDV';
  let tok;
  try { tok = await admin.auth().verifyIdToken(String(idToken)); }
  catch (e) { return 'login expirado ou inválido (' + (e.code || e.message) + ')'; }
  const email = String(tok.email || '').toLowerCase();
  try {
    const u = await db.collection('users').doc(tok.uid).get();
    const ud = u.exists ? (u.data() || {}) : {};
    if (ud.tenantId === tenantId || (Array.isArray(ud.tenantIds) && ud.tenantIds.indexOf(tenantId) >= 0)) return '';
    const t = await db.collection('tenants').doc(tenantId).get();
    const td = t.exists ? (t.data() || {}) : {};
    if (td.ownerUid === tok.uid || (email && String(td.ownerEmail || '').toLowerCase() === email)) return '';
    // PDV desktop entra com login anônimo do Firebase (sem e-mail/cadastro) — mesmo acesso que ele já tem às contas
    if (tok.firebase && tok.firebase.sign_in_provider === 'anonymous' && t.exists) return '';
    return 'o usuário ' + (email || tok.uid) + ' não está vinculado a este restaurante' + (u.exists ? '' : ' (sem cadastro em users)');
  } catch (e) { return 'erro ao conferir o usuário (' + e.message + ')'; }
}

module.exports = async (req, res) => {
  // Link curto pro cliente (WhatsApp): /nota/<ref> → redireciona pro QR Code da SEFAZ com o '|' intacto
  // (o WhatsApp corta link no '|', e a SEFAZ-PR não aceita o '|' codificado)
  if (req.method === 'GET') {
    const ref = String((req.query && req.query.v) || '').replace(/[^A-Za-z0-9_-]/g, '');
    if (!ref) return res.status(200).json({ ok: true });
    try {
      const d = await getDb().collection('nfce').doc(ref).get();
      const n = d.exists ? d.data() : null;
      const destino = n && ((n.impressao && n.impressao.qrCode) || n.qrcodeUrl || n.consultaUrl);
      if (!destino) { res.statusCode = 404; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end('<meta name=viewport content="width=device-width"><p style="font-family:sans-serif;padding:20px">Nota fiscal não encontrada.</p>'); }
      const url = String(destino).trim().replace(/&amp;/g, '&').replace(/%7C/gi, '|');
      res.statusCode = 302;
      res.setHeader('Location', url);
      res.setHeader('Cache-Control', 'no-store');
      return res.end();
    } catch (e) {
      res.statusCode = 500; return res.end('Erro ao abrir a nota.');
    }
  }
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });
  const b = req.body || {};
  try {
    const db = getDb();
    if (b.acao === 'exportarLista' || b.acao === 'exportarXmls') {
      const motivo = await _motivoRecusa(db, b.idToken, b.tenantId);
      if (motivo) { console.warn('[nfce] exportação recusada:', motivo); return res.status(401).json({ ok: false, error: 'Acesso recusado: ' + motivo + '.' }); }
      if (b.acao === 'exportarLista') return res.status(200).json(await nfce.listarMes(db, b.tenantId, b.mes, b.incluirTestes === true, b.restauranteId));
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
