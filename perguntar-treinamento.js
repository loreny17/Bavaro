// ═══════════════════════════════════════════════════════════════
//  POST /api/perguntar-treinamento
//  Body: { restauranteId, pergunta }
//
//  Busca as "instruções resumidas" cadastradas pelo admin nos vídeos
//  desse restaurante e pergunta pro Gemini SÓ com base nelas — nunca
//  deixa a IA responder com conhecimento genérico da internet (seria
//  perigoso: ela poderia "inventar" um procedimento plausível, mas
//  errado, pra uma pergunta operacional real).
// ═══════════════════════════════════════════════════════════════
// ⚠️ Antes importava de ./_lib/firebaseAdminTreinamentos.js — trazido pra
// dentro deste mesmo arquivo porque o upload da subpasta via GitHub mobile
// causou idas e vindas (pasta errada, nome errado) difíceis de depurar à
// distância. Sem pasta aninhada = sem essa categoria inteira de problema.
const admin = require('firebase-admin');

function getDbTreinamentos() {
  var apps = admin.apps.filter(function(a){ return a && a.name === 'treinamentos'; });
  if (apps.length) return apps[0].firestore();

  var projectId = process.env.TREINAMENTOS_FIREBASE_PROJECT_ID || 'bavaro-treinamentos';
  var clientEmail = process.env.TREINAMENTOS_FIREBASE_CLIENT_EMAIL;
  var privateKey = (process.env.TREINAMENTOS_FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Credenciais do Firebase Admin (treinamentos) ausentes. Configure ' +
      'TREINAMENTOS_FIREBASE_CLIENT_EMAIL e TREINAMENTOS_FIREBASE_PRIVATE_KEY.'
    );
  }

  var app = admin.initializeApp({
    credential: admin.credential.cert({ projectId: projectId, clientEmail: clientEmail, privateKey: privateKey }),
  }, 'treinamentos');
  return app.firestore();
}

const GEMINI_MODEL = 'gemini-3.1-flash-lite'; // leve e barato — suficiente pra isto
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  const body = req.body || {};
  const restauranteId = (body.restauranteId || '').toString().trim();
  const pergunta = (body.pergunta || '').toString().trim();

  if (!restauranteId) return res.status(400).json({ ok: false, error: 'Falta restauranteId' });
  if (!pergunta) return res.status(400).json({ ok: false, error: 'Falta a pergunta' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: 'GEMINI_API_KEY não configurada no servidor.' });
  }

  try {
    const db = getDbTreinamentos();
    // Duas fontes, lidas em paralelo: as instruções por vídeo E o documento
    // geral de texto livre — as duas alimentam a mesma resposta.
    const [restDoc, videosSnap] = await Promise.all([
      db.collection('restaurantes').doc(restauranteId).get(),
      db.collection('restaurantes').doc(restauranteId).collection('treinamentos').get(),
    ]);

    const documentoGeral = ((restDoc.data() || {}).documentoGeral || '').trim();

    const comInstrucao = [];
    videosSnap.forEach((doc) => {
      const v = doc.data() || {};
      if (v.instrucao && v.instrucao.trim()) {
        comInstrucao.push({ titulo: v.titulo || '(sem título)', instrucao: v.instrucao.trim(), youtubeId: v.youtubeId || null });
      }
    });

    // Sem nenhuma das duas fontes cadastrada — avisa sem gastar chamada de IA à toa.
    if (!comInstrucao.length && !documentoGeral) {
      return res.status(200).json({
        ok: true,
        resposta: 'Ainda não tenho nenhum procedimento cadastrado pra esse restaurante. Peça pro admin preencher o documento geral ou a instrução de algum vídeo de treinamento.',
        youtubeId: null,
      });
    }

    // Limite de segurança — não deve chegar perto disso na prática.
    const contexto = comInstrucao.slice(0, 80);

    const blocoVideos = contexto.length
      ? contexto.map((v, i) => `[${i + 1}] ${v.titulo}\n${v.instrucao}`).join('\n\n')
      : '(nenhum vídeo com instrução cadastrada)';

    // Documento geral entra como um bloco à parte, sem título de vídeo
    // associado — por isso não aciona o botão "assistir vídeo" na resposta,
    // o que é o comportamento certo (não existe vídeo pra esse conteúdo).
    const blocoDocumento = documentoGeral
      ? `\n\nDOCUMENTO GERAL DE PROCEDIMENTOS (sem vídeo associado):\n${documentoGeral.slice(0, 40000)}`
      : '';

    const prompt =
`Você é o assistente interno de treinamento de um restaurante. Responda SOMENTE
com base nos procedimentos abaixo, cadastrados pela própria gerência. Nunca
invente um procedimento que não esteja aqui, mesmo que pareça óbvio.

Se a pergunta não tiver relação com nenhum procedimento listado, diga
claramente que essa informação ainda não está cadastrada e sugira perguntar
a um gerente — não tente adivinhar.

Responda em português do Brasil, em até 3 frases, direto ao ponto, no tom de
quem está ajudando um funcionário durante o serviço.

Se a resposta vier de um procedimento de vídeo específico da lista abaixo
(não do documento geral), cite o título dele exatamente como está escrito,
em algum ponto da resposta.

PROCEDIMENTOS DE VÍDEOS CADASTRADOS:
${blocoVideos}${blocoDocumento}

PERGUNTA DO FUNCIONÁRIO:
${pergunta}`;

    const geminiResp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    if (!geminiResp.ok) {
      const errTxt = await geminiResp.text().catch(() => '');
      console.error('[perguntar-treinamento] Gemini falhou:', geminiResp.status, errTxt);
      return res.status(502).json({ ok: false, error: 'Assistente indisponível no momento (' + geminiResp.status + ').' });
    }

    const data = await geminiResp.json();
    const resposta = (data.candidates && data.candidates[0] && data.candidates[0].content &&
      data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
      data.candidates[0].content.parts[0].text) || 'Não consegui gerar uma resposta agora.';

    // Detecta qual vídeo a resposta citou (match pelo título exato) pra
    // oferecer o botão "assistir ao vídeo completo".
    let videoCitado = contexto.find((v) => resposta.indexOf(v.titulo) >= 0);

    return res.status(200).json({
      ok: true,
      resposta: resposta.trim(),
      youtubeId: videoCitado ? videoCitado.youtubeId : null,
      videoTitulo: videoCitado ? videoCitado.titulo : null,
    });
  } catch (err) {
    console.error('[perguntar-treinamento] falhou:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
