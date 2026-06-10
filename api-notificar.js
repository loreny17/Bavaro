/**
 * Bávaro Ponto — Notificações via Vercel Serverless
 * Arquivo: api/notificar.js
 * 
 * Chamado automaticamente pelo Vercel Cron a cada minuto.
 * Verifica horários e envia notificações FCM.
 */

const SERVICE_ACCOUNT = {
  "type": "service_account",
  "project_id": "gestao-reataurante",
  "private_key_id": "0f887f7d5a40acd98c21ae364ac398d41b468762",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDMpcG5aG0lxCIi\nlrWiHd99zN/DwbhEKMKpEaeR/6fjM1nfWAJqFLz2RtjS0Lq7Z7ciSu1ipjMcMTOL\nJsgeg1f8rKrcovR5PoO+YnH84fxmYiTyn5el09psNT+iKRAm6aQiAjTiTDZAuWk4\nDcxQaScL52YEjViH3bC2X83rvIyM81S2lSvXIt/HbqOCUG+3MO+m0b2ZSYkTCbOq\nQKNFY3WWR9wga/kw0B8FzkXEP7+JgTmPUlAroe1w8NSqEgxtZTysu2gxicS6SAMB\n8Ju2gYJqfur8AZdeRYX9O7Yj3V/CbJxSVkUytTabZ04GNfVFVQsSy2yG6CdeSoAm\n1GK5srXxAgMBAAECggEAKyplX9XKe/ZQWupeGnlhnDfcFP7l/p54XNAH//AkefRp\nZwY50CVarDnKX0E+uevJAZc7Vh0HV9F69UVzXZhHtVi4W3yVw4Mvp7c9IuGJ6xCV\niYWnJ4e1oTBkITC3IvYSNEgx3m/D28ggDP5AE8/yN/0RlDE6NMJKlVVE6o3lOY9y\nvGicfSKZijmJbFt//7XmgPHqrs7MiCtX2LA56Cg336wR2WQOIPZCKAIiIQWoxv/l\n1cFOilebpk+JJT4y1V0cBKg49LKaYsmWXVwXGWws54K//FMmzljvO3I2sgjAkUeB\nmxjOfBxsrMTj2j2dgU26ZcLgz3JxhB0tyl7VdbaexwKBgQD+Yf81TXb27jNjrpag\nYyo9rBndzhWNDVS8QUjEzbJz65N68Op4+/y9gPmiDkYALMZZn0wGKz/vaceLeVT5\nIS6xVkwal/Y/yt2PCicY2VteB942rROvWrrdJtRWvTzT/MxFPYZfaVzWgOwfxvsU\npi/0qAoYn1qygaVFYXC4sRiJcwKBgQDN8tEKiLA4pqd0Rn2bTc457B4KzOg8FKw3\nQR0U4Qt2gaOsyBizSo0Bfe+lriVYa5285X5ohxHxeTVQnuTCtdabmg/5N/0Axmoz\nPozAIAak6gvkubCdWDA6lfLiZEtwbYUZvmv1EP0GMs4Pn4MIa7/zV4SVX4GDJfyw\nLon5akx6CwKBgG++srJCjjDY4IA4cHiSNzsSP+acogDtSzzLXOD/DxY29Pk7nXR6\nFUNVxdM3e+6VvKgf/vByzUopaHvPV9F8jxtdsl64RHcvcXZlWlljGezLfgT8sLoG\nHDIL3Zkg1fi1gzIjXcTJ7vtXdOJcsW0Xt9c8ffrk/Z2OsAAzVqX7PbEbAoGAVP0A\nQQ2ZUzeK4RP5364jDYof96sJp0mMrBylyKj6FwR2q+XDM7HvMI9s5v1PkgaPCJXY\nLYCX6gNv+f4oPyXVE09nihwNv1UiHFWStfJBa6reD5yFgtkSxgp9OenTq+i2RaJs\nYKyLDhTHLnFQHJiClQQnxZCtHJb/iSEbdR7lwnMCgYEAx3fbUGEvWX/xY8xjcbyg\nVQ9LXdYE+cNvjF5YxU14dla0+lQ8JLJ+UvRXh1yc82VYkQ48TkgR9SH3My/GtETl\nnMpp8YwExEp6qPxVv0XjHfETwKWjiw4lnDEXR3o3K1wSaVt97kYyK6AIAs3VqtzQ\ncyWOOql0lJn/boGxm+kj5GE=\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@gestao-reataurante.iam.gserviceaccount.com",
  "client_id": "110720865991709004451",
  "token_uri": "https://oauth2.googleapis.com/token"
};

const PROJECT_ID = 'gestao-reataurante';
const FIRESTORE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FCM_URL = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;

// ── Gera JWT para autenticação Google ──────────────────────────────────────
async function gerarAccessToken() {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: SERVICE_ACCOUNT.token_uri,
    exp: now + 3600,
    iat: now
  };

  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const toSign = `${enc(header)}.${enc(payload)}`;

  // Importa chave privada
  const pemKey = SERVICE_ACCOUNT.private_key;
  const keyData = pemKey
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\n/g, '');
  const binaryKey = Buffer.from(keyData, 'base64');

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    Buffer.from(toSign)
  );
  const jwt = `${toSign}.${Buffer.from(sig).toString('base64url')}`;

  // Troca JWT por access token
  const res = await fetch(SERVICE_ACCOUNT.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await res.json();
  return data.access_token;
}

// ── Firestore helpers ──────────────────────────────────────────────────────
async function firestoreGet(path, token) {
  const res = await fetch(`${FIRESTORE_URL}/${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return null;
  return res.json();
}

async function firestoreQuery(collection, filters, token) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: filters.length === 1 ? {
        fieldFilter: filters[0]
      } : {
        compositeFilter: {
          op: 'AND',
          filters: filters.map(f => ({ fieldFilter: f }))
        }
      },
      limit: 1
    }
  };
  const res = await fetch(`${FIRESTORE_URL}:runQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) return [];
  return res.json();
}

async function firestoreList(collection, token) {
  const res = await fetch(`${FIRESTORE_URL}/${collection}?pageSize=200`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.documents || [];
}

async function firestoreSet(path, fields, token) {
  const body = { fields: {} };
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') body.fields[k] = { stringValue: v };
    else if (typeof v === 'number') body.fields[k] = { integerValue: String(v) };
    else if (typeof v === 'boolean') body.fields[k] = { booleanValue: v };
  }
  await fetch(`${FIRESTORE_URL}/${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

// ── FCM ────────────────────────────────────────────────────────────────────
async function enviarFCM(token, titulo, corpo, tag, url, accessToken) {
  const msg = {
    message: {
      token,
      notification: { title: titulo, body: corpo },
      data: { title: titulo, body: corpo, tag: tag || 'ponto', url: url || '/ponto.html' },
      webpush: {
        notification: {
          title: titulo, body: corpo,
          icon: '/icon-192.png', badge: '/icon-192.png',
          requireInteraction: true, tag: tag || 'ponto'
        },
        fcm_options: { link: url || '/ponto.html' }
      },
      android: {
        priority: 'high',
        notification: { title: titulo, body: corpo, color: '#d4a843' }
      }
    }
  };
  const res = await fetch(FCM_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(msg)
  });
  const data = await res.json();
  if (!res.ok) {
    console.warn('[FCM] Erro:', data.error?.message);
    return false;
  }
  console.log('[FCM] Enviado:', titulo);
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function horaParaMin(hStr) {
  const p = (hStr || '').split(':');
  if (p.length < 2) return null;
  return parseInt(p[0]) * 60 + parseInt(p[1]);
}

function getField(doc, field) {
  const f = doc?.fields?.[field];
  if (!f) return null;
  return f.stringValue ?? f.integerValue ?? f.booleanValue ?? null;
}

function diaKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function jaRegistrou(funcId, diaHoje, tipo, accessToken) {
  const results = await firestoreQuery('ponto_registros', [
    { field: { fieldPath: 'funcId' }, op: 'EQUAL', value: { stringValue: funcId } },
    { field: { fieldPath: 'diaKey' }, op: 'EQUAL', value: { stringValue: diaHoje } },
    { field: { fieldPath: 'tipo'  }, op: 'EQUAL', value: { stringValue: tipo   } }
  ], accessToken);
  return results.some(r => r.document);
}

async function getStatusAtual(funcId, diaHoje, accessToken) {
  // Busca o último registro do dia
  const results = await firestoreQuery('ponto_registros', [
    { field: { fieldPath: 'funcId' }, op: 'EQUAL', value: { stringValue: funcId } },
    { field: { fieldPath: 'diaKey' }, op: 'EQUAL', value: { stringValue: diaHoje } }
  ], accessToken);
  const docs = results.filter(r => r.document).map(r => r.document);
  if (!docs.length) return 'fora';
  // Pega o mais recente pelo campo ts
  docs.sort((a, b) => {
    const ta = parseInt(getField(a, 'ts') || 0);
    const tb = parseInt(getField(b, 'ts') || 0);
    return tb - ta;
  });
  const tipo = getField(docs[0], 'tipo');
  if (tipo === 'entrada' || tipo === 'fim_intervalo') return 'trabalhando';
  if (tipo === 'ini_intervalo') return 'intervalo';
  return 'fora';
}

// ── Handler principal ──────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Permite chamada manual via GET e pelo cron via GET
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const horaAtual = agora.getHours();
  const minAtual  = agora.getMinutes();
  const totalMin  = horaAtual * 60 + minAtual;
  const diasSem   = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'];
  const diaHoje   = diasSem[agora.getDay()];
  const hoje      = diaKey(agora);

  console.log(`[Notificar] ${hoje} ${horaAtual}:${String(minAtual).padStart(2,'0')} (${diaHoje})`);

  try {
    const accessToken = await gerarAccessToken();
    const docs = await firestoreList('ponto_funcionarios', accessToken);

    const acoes = [];
    const resultados = [];

    for (const doc of docs) {
      const funcId = doc.name.split('/').pop();
      const fcmToken = getField(doc, 'fcmToken');
      if (!fcmToken) continue;

      const nome = (getField(doc, 'nome') || getField(doc, 'nomeLogin') || 'Funcionário').split(' ')[0];

      // Lê horários do funcionário
      const horariosField = doc.fields?.horarios?.mapValue?.fields;
      if (!horariosField) continue;
      const h = horariosField[diaHoje]?.mapValue?.fields;
      if (!h) continue;

      const folga = h.folga?.booleanValue;
      const entrada = h.entrada?.stringValue;
      const saida = h.saida?.stringValue;
      if (folga || !entrada) continue;

      const minEntrada = horaParaMin(entrada);
      const minSaida   = horaParaMin(saida);

      // ── Lembrete 5min antes ──
      if (minEntrada !== null && totalMin === minEntrada - 5) {
        const ja = await jaRegistrou(funcId, hoje, 'entrada', accessToken);
        if (!ja) acoes.push(enviarFCM(fcmToken,
          `🔔 Lembrete, ${nome}!`,
          `Sua entrada é às ${entrada}. Prepare-se!`,
          `lembrete_entrada_${hoje}`, '/ponto.html', accessToken
        ));
      }

      // ── Entrada em ponto ──
      if (minEntrada !== null && totalMin === minEntrada) {
        const ja = await jaRegistrou(funcId, hoje, 'entrada', accessToken);
        if (!ja) acoes.push(enviarFCM(fcmToken,
          `⏰ Bata o ponto, ${nome}!`,
          `São ${entrada}. Registre sua entrada agora.`,
          `entrada_${hoje}`, '/ponto.html', accessToken
        ));
      }

      // ── Atraso 15min ──
      if (minEntrada !== null && totalMin === minEntrada + 15) {
        const ja = await jaRegistrou(funcId, hoje, 'entrada', accessToken);
        if (!ja) {
          acoes.push(enviarFCM(fcmToken,
            `⚠️ ${nome}, você está atrasado!`,
            `Eram ${entrada} e seu ponto não foi registrado. Registre agora!`,
            `atraso_${hoje}`, '/ponto.html', accessToken
          ));
          // Salva atraso no Firestore para o gestor
          acoes.push(firestoreSet(
            `ponto_status_hoje/${funcId}`,
            { funcId, funcNome: getField(doc,'nome')||getField(doc,'nomeLogin')||'', status: 'atrasado', atrasoMin: 15, horaEntradaEsperada: entrada, diaKey: hoje, atualizadoEm: Date.now() },
            accessToken
          ));
          // Notifica gestores
          const gestorDocs = await firestoreList('ponto_gestores_tokens', accessToken);
          for (const gDoc of gestorDocs) {
            const gToken = getField(gDoc, 'fcmToken');
            if (gToken) acoes.push(enviarFCM(gToken,
              `⚠️ Funcionário atrasado!`,
              `${getField(doc,'nome')||getField(doc,'nomeLogin')} deveria ter chegado às ${entrada}.`,
              `gestor_atraso_${hoje}`, '/index.html', accessToken
            ));
          }
        }
      }

      // ── Intervalo (meio do turno) ──
      if (minEntrada !== null && minSaida !== null) {
        const meioDia = Math.floor((minEntrada + minSaida) / 2);
        if (totalMin === meioDia) {
          const status = await getStatusAtual(funcId, hoje, accessToken);
          if (status === 'trabalhando') {
            acoes.push(enviarFCM(fcmToken,
              `☕ Hora do intervalo, ${nome}!`,
              `Você já trabalhou ${Math.round((meioDia - minEntrada)/60)}h. Registre seu intervalo.`,
              `intervalo_${hoje}`, '/ponto.html', accessToken
            ));
          }
        }
      }

      // ── Lembrete saída 5min antes ──
      if (minSaida !== null && totalMin === minSaida - 5) {
        const status = await getStatusAtual(funcId, hoje, accessToken);
        if (status === 'trabalhando') {
          acoes.push(enviarFCM(fcmToken,
            `🔔 Saída em 5 minutos, ${nome}!`,
            `Prepare-se para registrar sua saída às ${saida}.`,
            `lembrete_saida_${hoje}`, '/ponto.html', accessToken
          ));
        }
      }

      // ── Saída em ponto ──
      if (minSaida !== null && totalMin === minSaida) {
        const status = await getStatusAtual(funcId, hoje, accessToken);
        if (status === 'trabalhando' || status === 'intervalo') {
          acoes.push(enviarFCM(fcmToken,
            `🏠 Hora de ir, ${nome}!`,
            `Seu horário de saída é ${saida}. Registre antes de sair!`,
            `saida_${hoje}`, '/ponto.html', accessToken
          ));
        }
      }
    }

    const results = await Promise.allSettled(acoes);
    const ok    = results.filter(r => r.status === 'fulfilled').length;
    const fail  = results.filter(r => r.status === 'rejected').length;

    console.log(`[Notificar] ${ok} OK, ${fail} falhas`);
    res.status(200).json({ ok, fail, hora: `${horaAtual}:${String(minAtual).padStart(2,'0')}`, dia: diaHoje });

  } catch (e) {
    console.error('[Notificar] Erro geral:', e.message);
    res.status(500).json({ error: e.message });
  }
}
