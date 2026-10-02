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
const { getDbTreinamentos } = require('./_lib/firebaseAdminTreinamentos');

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
    const snap = await db.collection('restaurantes').doc(restauranteId).collection('treinamentos').get();

    const comInstrucao = [];
    snap.forEach((doc) => {
      const v = doc.data() || {};
      if (v.instrucao && v.instrucao.trim()) {
        comInstrucao.push({ titulo: v.titulo || '(sem título)', instrucao: v.instrucao.trim(), youtubeId: v.youtubeId || null });
      }
    });

    // Sem nada cadastrado ainda — avisa sem gastar chamada de IA à toa.
    if (!comInstrucao.length) {
      return res.status(200).json({
        ok: true,
        resposta: 'Ainda não tenho nenhuma instrução cadastrada pra esse restaurante. Peça pro admin preencher o campo "Instrução resumida" nos vídeos de treinamento.',
        youtubeId: null,
      });
    }

    // Limite de segurança — não deve chegar perto disso na prática.
    const contexto = comInstrucao.slice(0, 80);

    const blocoContexto = contexto.map((v, i) => `[${i + 1}] ${v.titulo}\n${v.instrucao}`).join('\n\n');

    const prompt =
`Você é o assistente interno de treinamento de um restaurante. Responda SOMENTE
com base nos procedimentos abaixo, cadastrados pela própria gerência. Nunca
invente um procedimento que não esteja aqui, mesmo que pareça óbvio.

Se a pergunta não tiver relação com nenhum procedimento listado, diga
claramente que essa informação ainda não está cadastrada e sugira perguntar
a um gerente — não tente adivinhar.

Responda em português do Brasil, em até 3 frases, direto ao ponto, no tom de
quem está ajudando um funcionário durante o serviço.

Se a resposta vier de um procedimento específico da lista, cite o título
dele exatamente como está escrito, em algum ponto da resposta.

PROCEDIMENTOS CADASTRADOS:
${blocoContexto}

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
