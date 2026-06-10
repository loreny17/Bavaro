// api/notificar.js — Bávaro Ponto Notificações
const PROJECT_ID  = 'gestao-reataurante';
const CLIENT_EMAIL = 'firebase-adminsdk-fbsvc@gestao-reataurante.iam.gserviceaccount.com';
const TOKEN_URI   = 'https://oauth2.googleapis.com/token';

// Chave privada linha a linha para evitar problemas de escape
const PRIVATE_KEY = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDMpcG5aG0lxCIi',
  'lrWiHd99zN/DwbhEKMKpEaeR/6fjM1nfWAJqFLz2RtjS0Lq7Z7ciSu1ipjMcMTOL',
  'JsgegIf8rKrcovR5PoO+YnH84fxmYiTyn5el09psNT+iKRAm6aQiAjTiTDZAuWk4',
  'DcxQaScL52YEjViH3bC2X83rvIyM81S2lSvXIt/HbqOCUG+3MO+m0b2ZSYkTCbOq',
  'QKNJY3WWR9wga/kw0B8FzkXEP7+JgTmPUlAroe1w8NSqEgxtZTysu2gxicS6SAMB',
  '8Ju2gYJqfur8AZdeRYX9O7Yj3V/CbJxSVkUytTabZ04GNfVFVQsSy2yG6CdeSoAm',
  '1GK5srXxAgMBAAECggEAKyplX9XKe/ZQWupeGnlhnDfcFP7l/p54XNAH//AkefRp',
  'ZwY50CVarDnKX0E+uevJAZc7Vh0HV9F69UVzXZhHtVi4W3yVw4Mvp7c9IuGJ6xCV',
  'iYWnJ4e1oTBkITC3IvYSNEgx3m/D28ggDP5AE8/yN/0RlDE6NMJKlVVE6o3lOY9y',
  'vGicfSKZijmJbFt//7XmgPHqrs7MiCtX2LA56Cg336wR2WQOIPZCKAIiIQWoxv/l',
  '1cFOilebpk+JJT4y1V0cBKg49LKaYsmWXVwXGWws54K//FMmzljvO3I2sgjAkUeB',
  'mxjOfBxsrMTj2j2dgU26ZcLgz3JxhB0tyl7VdbaexwKBgQD+Yf81TXb27jNjrpag',
  'Yyo9rBndzhWNDVS8QUjEzbJz65N68Op4+/y9gPmiDkYALMZZn0wGKz/vaceLeVT5',
  'IS6xVkwal/Y/yt2PCicY2VteB942rROvWrrdJtRWvTzT/MxFPYZfaVzWgOwfxvsU',
  'pi/0qAoYn1qygaVFYXC4sRiJcwKBgQDN8tEKiLA4pqd0Rn2bTc457B4KzOg8FKw3',
  'QR0U4Qt2gaOsyBizSo0Bfe+lriVYa5285X5ohxHxeTVQnuTCtdabmg/5N/0Axmoz',
  'PozAIAak6gvkubCdWDA6lfLiZEtwbYUZvmv1EP0GMs4Pn4MIa7/zV4SVX4GDJfyw',
  'Lon5akx6CwKBgG++srJCjjDY4IA4cHiSNzsSP+acogDtSzzLXOD/DxY29Pk7nXR6',
  'FUNVxdM3e+6VvKgf/vByzUopaHvPV9F8jxtdsl64RHcvcXZlWlljGezLfgT8sLoG',
  'HDIL3Zkg1fi1gzIjXcTJ7vtXdOJcsW0Xt9c8ffrk/Z2OsAAzVqX7PbEbAoGAVP0A',
  'QQ2ZUzeK4RP5364jDYof96sJp0mMrBylyKj6FwR2q+XDM7HvMI9s5v1PkgaPCJXY',
  'LYCx6gNv+f4oPyXVE09nihwNv1UiHFWStfJBa6reD5yFgtkSxgp9OenTq+i2RaJs',
  'YKyLDhTHLnFQHJiClQQnxZCtHJb/iSEbdR7lwnMCgYEAx3fbUGEvWX/xY8xjcbyg',
  'VQ9LXdYE+cNvjF5YxU14dla0+lQ8JLJ+UvRXh1yc82VYkQ48TkgR9SH3My/GtETl',
  'nMpp8YwExEp6qPxVv0XjHfETwKWjiw4lnDEXR3o3K1wSaVt97kYyK6AIAs3VqtzQ',
  'cyWOOql0lJn/boGxm+kj5GE=',
  '-----END PRIVATE KEY-----'
].join('\n');

const FS_URL  = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FCM_URL = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;

module.exports = async function handler(req, res) {
  try {
    // Testa geração do token primeiro
    let token;
    try {
      token = await getAccessToken();
    } catch(e) {
      return res.status(500).json({ erro: 'JWT falhou', detalhe: e.message });
    }

    const agora    = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Sao_Paulo'}));
    const hAtual   = agora.getHours();
    const mAtual   = agora.getMinutes();
    const totalMin = hAtual * 60 + mAtual;
    const dias     = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'];
    const diaHoje  = dias[agora.getDay()];
    const hoje     = `${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}`;

    const funcs = await listar('ponto_funcionarios', token);
    const acoes = [];

    for (const doc of funcs) {
      const fcmToken = campo(doc, 'fcmToken');
      if (!fcmToken) continue;
      const nome   = (campo(doc,'nome') || campo(doc,'nomeLogin') || 'Funcionário').split(' ')[0];
      const funcId = doc.name.split('/').pop();
      const hMap   = doc.fields && doc.fields.horarios && doc.fields.horarios.mapValue && doc.fields.horarios.mapValue.fields;
      if (!hMap) continue;
      const h = hMap[diaHoje] && hMap[diaHoje].mapValue && hMap[diaHoje].mapValue.fields;
      if (!h || (h.folga && h.folga.booleanValue)) continue;
      const entrada = h.entrada && h.entrada.stringValue;
      const saida   = h.saida   && h.saida.stringValue;
      if (!entrada) continue;
      const minE = toMin(entrada);
      const minS = toMin(saida);

      if (minE !== null && totalMin === minE - 5)
        if (!await jaRegistrou(funcId, hoje, 'entrada', token))
          acoes.push(fcm(fcmToken, `🔔 Lembrete, ${nome}!`, `Sua entrada é às ${entrada}. Prepare-se!`, '/ponto.html', token));

      if (minE !== null && totalMin === minE)
        if (!await jaRegistrou(funcId, hoje, 'entrada', token))
          acoes.push(fcm(fcmToken, `⏰ Bata o ponto, ${nome}!`, `São ${entrada}. Registre sua entrada agora.`, '/ponto.html', token));

      if (minE !== null && totalMin === minE + 15) {
        if (!await jaRegistrou(funcId, hoje, 'entrada', token)) {
          acoes.push(fcm(fcmToken, `⚠️ ${nome}, você está atrasado!`, `Eram ${entrada} e seu ponto não foi registrado!`, '/ponto.html', token));
          const gestores = await listar('ponto_gestores_tokens', token);
          for (const g of gestores) {
            const gt = campo(g, 'fcmToken');
            if (gt) acoes.push(fcm(gt, `⚠️ Funcionário atrasado!`, `${nome} deveria ter chegado às ${entrada}.`, '/index.html', token));
          }
        }
      }

      if (minE !== null && minS !== null) {
        const meio = Math.floor((minE + minS) / 2);
        if (totalMin === meio && await getStatus(funcId, hoje, token) === 'trabalhando')
          acoes.push(fcm(fcmToken, `☕ Hora do intervalo, ${nome}!`, `Você já trabalhou ${Math.round((meio-minE)/60)}h. Registre o intervalo.`, '/ponto.html', token));
      }

      if (minS !== null && totalMin === minS - 5)
        if (await getStatus(funcId, hoje, token) === 'trabalhando')
          acoes.push(fcm(fcmToken, `🔔 Saída em 5 min, ${nome}!`, `Prepare-se para registrar saída às ${saida}.`, '/ponto.html', token));

      if (minS !== null && totalMin === minS) {
        const st = await getStatus(funcId, hoje, token);
        if (st === 'trabalhando' || st === 'intervalo')
          acoes.push(fcm(fcmToken, `🏠 Hora de ir, ${nome}!`, `Seu horário de saída é ${saida}. Registre antes de sair!`, '/ponto.html', token));
      }
    }

    await Promise.allSettled(acoes);
    res.status(200).json({ status:'ok', hora:`${hAtual}:${pad(mAtual)}`, dia:diaHoje, acoes:acoes.length });

  } catch(e) {
    console.error('[Notificar]', e);
    res.status(500).json({ error: e.message });
  }
};

// ── JWT / OAuth2 ────────────────────────────────────────────────────────────
async function getAccessToken() {
  const crypto = require('crypto');
  const now    = Math.floor(Date.now() / 1000);
  const header  = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({
    iss:   CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud:   TOKEN_URI,
    exp:   now + 3600,
    iat:   now
  }));
  const unsigned = `${header}.${payload}`;
  const signer   = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const sig = signer.sign(PRIVATE_KEY, 'base64url');
  const jwt = `${unsigned}.${sig}`;

  const r = await fetch(TOKEN_URI, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const d = await r.json();
  if (!d.access_token) throw new Error(JSON.stringify(d));
  return d.access_token;
}

function b64u(s) {
  return Buffer.from(s).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function pad(n)   { return String(n).padStart(2,'0'); }
function toMin(s) { const p=(s||'').split(':'); return p.length<2?null:parseInt(p[0])*60+parseInt(p[1]); }
function campo(doc,f) {
  const v = doc && doc.fields && doc.fields[f];
  if (!v) return null;
  return v.stringValue !== undefined ? v.stringValue
       : v.integerValue !== undefined ? v.integerValue
       : v.booleanValue !== undefined ? v.booleanValue : null;
}

async function listar(col, token) {
  const r = await fetch(`${FS_URL}/${col}?pageSize=200`, { headers:{ Authorization:`Bearer ${token}` } });
  const d = await r.json();
  return d.documents || [];
}

async function query(col, filtros, token) {
  const where = filtros.length === 1
    ? { fieldFilter: filtros[0] }
    : { compositeFilter: { op:'AND', filters: filtros.map(f=>({fieldFilter:f})) } };
  const r = await fetch(`${FS_URL}:runQuery`, {
    method:'POST',
    headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ structuredQuery:{ from:[{collectionId:col}], where, limit:1 } })
  });
  const d = await r.json();
  return Array.isArray(d) ? d : [];
}

async function jaRegistrou(funcId, diaHoje, tipo, token) {
  const r = await query('ponto_registros',[
    { field:{fieldPath:'funcId'}, op:'EQUAL', value:{stringValue:funcId}  },
    { field:{fieldPath:'diaKey'}, op:'EQUAL', value:{stringValue:diaHoje} },
    { field:{fieldPath:'tipo'},   op:'EQUAL', value:{stringValue:tipo}    }
  ], token);
  return r.some(x=>x.document);
}

async function getStatus(funcId, diaHoje, token) {
  const r = await query('ponto_registros',[
    { field:{fieldPath:'funcId'}, op:'EQUAL', value:{stringValue:funcId}  },
    { field:{fieldPath:'diaKey'}, op:'EQUAL', value:{stringValue:diaHoje} }
  ], token);
  const docs = r.filter(x=>x.document).map(x=>x.document);
  if (!docs.length) return 'fora';
  docs.sort((a,b)=>parseInt(campo(b,'ts')||0)-parseInt(campo(a,'ts')||0));
  const tipo = campo(docs[0],'tipo');
  if (tipo==='entrada'||tipo==='fim_intervalo') return 'trabalhando';
  if (tipo==='ini_intervalo') return 'intervalo';
  return 'fora';
}

async function fcm(deviceToken, titulo, corpo, url, accessToken) {
  const r = await fetch(FCM_URL, {
    method:'POST',
    headers:{ Authorization:`Bearer ${accessToken}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ message:{
      token: deviceToken,
      notification:{ title:titulo, body:corpo },
      data:{ title:titulo, body:corpo, tag:'ponto', url },
      webpush:{
        notification:{ title:titulo, body:corpo, icon:'/icon-192.png', badge:'/icon-192.png', requireInteraction:true, tag:'ponto' },
        fcm_options:{ link:url }
      },
      android:{ priority:'high', notification:{ title:titulo, body:corpo, color:'#d4a843' } }
    }})
  });
  const d = await r.json();
  if (!r.ok) console.warn('[FCM] Erro:', d.error && d.error.message);
  else       console.log('[FCM] OK:', titulo);
      }
