// ═══════════════════════════════════════════════════════════════
//  Firebase Admin — só roda no servidor (Vercel Serverless Function)
//  NUNCA importar isto em nenhum arquivo .html. A credencial aqui tem
//  acesso total ao banco (ignora as regras do firestore.rules) — é
//  por isso que ela só pode existir num lugar que o navegador nunca vê.
// ═══════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

function getAdminApp() {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID || 'gestao-reataurante';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // A chave privada chega com \n escapado (literal) nas variáveis de
  // ambiente da Vercel — precisa virar quebra de linha de verdade.
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Credenciais do Firebase Admin ausentes. Configure FIREBASE_CLIENT_EMAIL ' +
      'e FIREBASE_PRIVATE_KEY nas variáveis de ambiente da Vercel.'
    );
  }

  return admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  });
}

function getDb() {
  getAdminApp();
  return admin.firestore();
}

module.exports = { getAdminApp, getDb };
