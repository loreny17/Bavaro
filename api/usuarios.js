// POST /api/usuarios — logins do PDV (e-mail + senha) de cada loja.
// Só o DONO do restaurante (dono do tenant, ou usuário dono/admin sem loja fixa) mexe aqui.
// body: { acao:'listar'|'criar'|'senha'|'remover', idToken, tenantId, email?, senha?, nome?, restaurantes?:[ids]|null, uid? }
//   restaurantes = lojas que o login enxerga no PDV (null/vazio = todas)
const { getDb } = require('./_assistente');
const admin = require('firebase-admin');
const { dono: _dono } = require('./_dono');

function _lojas(v) {
  if (!Array.isArray(v)) return null;
  const l = v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 30);
  return l.length ? l : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });
  const b = req.body || {};
  try {
    const db = getDb();
    const tok = await _dono(db, b.idToken, b.tenantId);
    const tenantId = String(b.tenantId);

    if (b.acao === 'listar') {
      const snap = await db.collection('users').where('tenantId', '==', tenantId).get();
      const lista = [];
      snap.forEach((d) => {
        const u = d.data() || {};
        lista.push({ uid: d.id, email: u.email || '', nome: u.nome || '', role: u.role || '', restaurantes: _lojas(u.restaurantes), voce: d.id === tok.uid });
      });
      lista.sort((a, b2) => (a.email || '').localeCompare(b2.email || ''));
      return res.status(200).json({ ok: true, usuarios: lista });
    }

    if (b.acao === 'criar') {
      const email = String(b.email || '').trim().toLowerCase();
      const senha = String(b.senha || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(200).json({ ok: false, error: 'E-mail inválido.' });
      if (senha.length < 6) return res.status(200).json({ ok: false, error: 'A senha precisa ter pelo menos 6 letras/números.' });
      let user;
      try { user = await admin.auth().getUserByEmail(email); } catch (e) { user = null; }
      if (user) {
        const ex = await db.collection('users').doc(user.uid).get();
        if (ex.exists && ex.data().tenantId && ex.data().tenantId !== tenantId) return res.status(200).json({ ok: false, error: 'Esse e-mail já é usado por outro restaurante.' });
        await admin.auth().updateUser(user.uid, { password: senha, disabled: false });
      } else {
        user = await admin.auth().createUser({ email, password: senha, displayName: String(b.nome || '').slice(0, 60) || undefined });
      }
      await db.collection('users').doc(user.uid).set({
        tenantId, email, nome: String(b.nome || '').slice(0, 60), role: 'gerente',
        restaurantes: _lojas(b.restaurantes), criadoEm: Date.now(), criadoPor: tok.email || tok.uid,
      }, { merge: true });
      return res.status(200).json({ ok: true, uid: user.uid });
    }

    // daqui pra baixo: mexe num login existente — tem que ser deste restaurante
    const uid = String(b.uid || '');
    const alvo = uid ? await db.collection('users').doc(uid).get() : null;
    if (!alvo || !alvo.exists || alvo.data().tenantId !== tenantId) return res.status(200).json({ ok: false, error: 'Login não encontrado.' });

    if (b.acao === 'senha') {
      const senha = String(b.senha || '');
      if (senha.length < 6) return res.status(200).json({ ok: false, error: 'A senha precisa ter pelo menos 6 letras/números.' });
      await admin.auth().updateUser(uid, { password: senha });
      return res.status(200).json({ ok: true });
    }
    if (b.acao === 'lojas') {
      await db.collection('users').doc(uid).set({ restaurantes: _lojas(b.restaurantes) }, { merge: true });
      return res.status(200).json({ ok: true });
    }
    if (b.acao === 'remover') {
      if (uid === tok.uid) return res.status(200).json({ ok: false, error: 'Você não pode remover o seu próprio login.' });
      const r = String(alvo.data().role || '');
      if (r === 'dono' || r === 'admin') return res.status(200).json({ ok: false, error: 'Esse é um login de dono — remova pelo app de gestão.' });
      await db.collection('users').doc(uid).delete();
      try { await admin.auth().deleteUser(uid); } catch (e) { /* já não existia */ }
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ ok: false, error: 'Ação desconhecida.' });
  } catch (e) {
    console.error('[usuarios]', e);
    return res.status(200).json({ ok: false, error: e.message || 'Erro' });
  }
};
