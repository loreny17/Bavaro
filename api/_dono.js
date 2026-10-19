// Confere se quem chamou é o DONO do restaurante (login de verdade, não anônimo).
// Usado pelos logins do PDV (/api/usuarios) e pela configuração da nota fiscal (/api/nfce).
const admin = require('firebase-admin');

// Confere quem está pedindo: precisa ser login de verdade (não anônimo) e dono deste restaurante
async function dono(db, idToken, tenantId) {
  if (!tenantId) throw new Error('Restaurante não informado.');
  if (!idToken) throw new Error('Faça login no PDV.');
  let tok;
  try { tok = await admin.auth().verifyIdToken(String(idToken)); } catch (e) { throw new Error('Login expirado — saia e entre de novo.'); }
  if (tok.firebase && tok.firebase.sign_in_provider === 'anonymous') throw new Error('Entre no PDV com e-mail e senha.');
  const email = String(tok.email || '').toLowerCase();
  const t = await db.collection('tenants').doc(String(tenantId)).get();
  const td = t.exists ? (t.data() || {}) : {};
  if (td.ownerUid === tok.uid || (email && String(td.ownerEmail || '').toLowerCase() === email)) return tok;
  const u = await db.collection('users').doc(tok.uid).get();
  const ud = u.exists ? (u.data() || {}) : {};
  const semLojaFixa = !Array.isArray(ud.restaurantes) || !ud.restaurantes.length;
  if (ud.tenantId === tenantId && semLojaFixa && (!ud.role || ['dono', 'admin'].indexOf(String(ud.role)) >= 0)) return tok;
  throw new Error('Só o dono do restaurante pode fazer isso (entre no PDV com o login do dono).');
}

module.exports = { dono };
