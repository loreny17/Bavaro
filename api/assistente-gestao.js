// POST /api/assistente-gestao — app de gestão (index.html). Mesma lógica do
// assistente do garçom (./_assistente.js), só que sempre no modo GESTÃO
// (pedidos a fornecedores, jogos, estoque) e exigindo o login do Firebase.
module.exports = require('./_assistente').criarHandler('gestao');
