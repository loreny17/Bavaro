// POST /api/nfce — emitir / cancelar NFC-e de uma conta fechada (lógica em ./_nfce.js)
// body: { acao:'emitir'|'cancelar', tenantId, restauranteId, contaId, documento?, nomeCliente?, formaPagamento?, garcom?, justificativa? }
const nfce = require('./_nfce');
const { getDb, garcomEhAdmin } = require('./_assistente');

module.exports = async (req, res) => {
  if (req.method === 'GET') return res.status(200).json({ ok: true, ambiente: nfce.ambiente() });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use POST' });
  const b = req.body || {};
  try {
    const db = getDb();
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
