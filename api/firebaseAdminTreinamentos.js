// ═══════════════════════════════════════════════════════════════
//  Firebase Admin — projeto bavaro-treinamentos (ISOLADO do sistema
//  principal). Variáveis de ambiente com prefixo TREINAMENTOS_ de
//  propósito, pra nunca se confundir com as credenciais do PDV
//  (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY, do outro projeto).
// ═══════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getAdminAppTreinamentos() {
  var apps = admin.apps.filter(function(a){ return a && a.name === 'treinamentos'; });
  if (apps.length) return apps[0];

  var projectId = process.env.TREINAMENTOS_FIREBASE_PROJECT_ID || 'bavaro-treinamentos';
  var clientEmail = process.env.TREINAMENTOS_FIREBASE_CLIENT_EMAIL;
  var privateKey = (process.env.TREINAMENTOS_FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Credenciais do Firebase Admin (treinamentos) ausentes. Configure ' +
      'TREINAMENTOS_FIREBASE_CLIENT_EMAIL e TREINAMENTOS_FIREBASE_PRIVATE_KEY.'
    );
  }

  return admin.initializeApp({
    credential: admin.credential.cert({ projectId: projectId, clientEmail: clientEmail, privateKey: privateKey }),
  }, 'treinamentos');
}

function getDbTreinamentos() {
  return getAdminAppTreinamentos().firestore();
}

module.exports = { getDbTreinamentos };
