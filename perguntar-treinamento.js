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
    // Três fontes, lidas em paralelo: instruções por vídeo, documento geral
    // de texto livre, e arquivos (imagens/PDF que o Gemini lê diretamente).
    const [restDoc, videosSnap, arquivosSnap] = await Promise.all([
      db.collection('restaurantes').doc(restauranteId).get(),
      db.collection('restaurantes').doc(restauranteId).collection('treinamentos').get(),
      db.collection('restaurantes').doc(restauranteId).collection('arquivos').get(),
    ]);

    const documentoGeral = ((restDoc.data() || {}).documentoGeral || '').trim();

    const comInstrucao = [];
    videosSnap.forEach((doc) => {
      const v = doc.data() || {};
      if (v.instrucao && v.instrucao.trim()) {
        comInstrucao.push({ titulo: v.titulo || '(sem título)', instrucao: v.instrucao.trim(), youtubeId: v.youtubeId || null });
      }
    });

    const arquivos = [];
    arquivosSnap.forEach((doc) => {
      const a = doc.data() || {};
      if (a.url && a.nome) arquivos.push({ nome: a.nome, url: a.url, tipo: a.tipo || 'image/png' });
    });

    // Sem nenhuma das três fontes cadastrada — avisa sem gastar chamada de IA à toa.
    if (!comInstrucao.length && !documentoGeral && !arquivos.length) {
      return res.status(200).json({
        ok: true,
        resposta: 'Ainda não tenho nenhum procedimento cadastrado pra esse restaurante. Peça pro admin preencher a Base de Conhecimento da IA (documento, arquivo ou instrução de vídeo).',
        youtubeId: null,
      });
    }

    // Baixa cada arquivo e converte em base64 pro Gemini "ver" de verdade.
    // Limite de 10 arquivos por pergunta — nunca deve chegar perto disso na
    // prática, é só uma trava de segurança. Arquivo que falhar ao baixar é
    // pulado (não derruba a resposta inteira por causa de um arquivo só).
    const arquivosPraUsar = arquivos.slice(0, 10);
    const partesArquivos = [];
    for (const a of arquivosPraUsar) {
      try {
        const r = await fetch(a.url);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 8 * 1024 * 1024) throw new Error('arquivo grande demais');
        partesArquivos.push({ text: `Arquivo anexado: "${a.nome}"` });
        partesArquivos.push({ inline_data: { mime_type: a.tipo, data: buf.toString('base64') } });
      } catch (e) {
        console.error('[perguntar-treinamento] falhou ao carregar arquivo', a.nome, e.message);
      }
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

Se a resposta vier de um procedimento de vídeo específico da lista abaixo,
cite o título dele exatamente como está escrito. Se vier de um dos arquivos
anexados (imagem ou PDF), cite o nome do arquivo exatamente como foi dado,
em algum ponto da resposta — em qualquer um dos dois casos, assim a pessoa
sabe onde encontrar a fonte completa.

PROCEDIMENTOS DE VÍDEOS CADASTRADOS:
${blocoVideos}${blocoDocumento}
${arquivosPraUsar.length ? `\n\n${arquivosPraUsar.length} arquivo(s) anexado(s) abaixo — leia o conteúdo deles diretamente.` : ''}

PERGUNTA DO FUNCIONÁRIO:
${pergunta}`;

    const parts = [{ text: prompt }, ...partesArquivos];

    const geminiResp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: parts }] }),
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

    // Detecta qual vídeo OU arquivo a resposta citou (match pelo nome exato)
    // pra oferecer o botão de "ver a fonte completa".
    let videoCitado = contexto.find((v) => resposta.indexOf(v.titulo) >= 0);
    let arquivoCitado = arquivosPraUsar.find((a) => resposta.indexOf(a.nome) >= 0);

    return res.status(200).json({
      ok: true,
      resposta: resposta.trim(),
      youtubeId: videoCitado ? videoCitado.youtubeId : null,
      videoTitulo: videoCitado ? videoCitado.titulo : null,
      arquivoUrl: arquivoCitado ? arquivoCitado.url : null,
      arquivoNome: arquivoCitado ? arquivoCitado.nome : null,
      arquivoTipo: arquivoCitado ? arquivoCitado.tipo : null,
    });
  } catch (err) {
    console.error('[perguntar-treinamento] falhou:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
