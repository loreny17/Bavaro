// api/notificar.js — Bávaro Ponto Notificações
// Vercel Serverless Function (CommonJS)

const SERVICE_ACCOUNT = {
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDMpcG5aG0lxCIi\nlrWiHd99zN/DwbhEKMKpEaeR/6fjM1nfWAJqFLz2RtjS0Lq7Z7ciSu1ipjMcMTOL\nJsgeg1f8rKrcovR5PoO+YnH84fxmYiTyn5el09psNT+iKRAm6aQiAjTiTDZAuWk4\nDcxQaScL52YEjViH3bC2X83rvIyM81S2lSvXIt/HbqOCUG+3MO+m0b2ZSYkTCbOq\nQKNFY3WWR9wga/kw0B8FzkXEP7+JgTmPUlAroe1w8NSqEgxtZTysu2gxicS6SAMB\n8Ju2gYJqfur8AZdeRYX9O7Yj3V/CbJxSVkUytTabZ04GNfVFVQsSy2yG6CdeSoAm\n1GK5srXxAgMBAAECggEAKyplX9XKe/ZQWupeGnlhnDfcFP7l/p54XNAH//AkefRp\nZwY50CVarDnKX0E+uevJAZc7Vh0HV9F69UVzXZhHtVi4W3yVw4Mvp7c9IuGJ6xCV\niYWnJ4e1oTBkITC3IvYSNEgx3m/D28ggDP5AE8/yN/0RlDE6NMJKlVVE6o3lOY9y\nvGicfSKZijmJbFt//7XmgPHqrs7MiCtX2LA56Cg336wR2WQOIPZCKAIiIQWoxv/l\n1cFOilebpk+JJT4y1V0cBKg49LKaYsmWXVwXGWws54K//FMmzljvO3I2sgjAkUeB\nmxjOfBxsrMTj2j2dgU26ZcLgz3JxhB0tyl7VdbaexwKBgQD+Yf81TXb27jNjrpag\nYyo9rBndzhWNDVS8QUjEzbJz65N68Op4+/y9gPmiDkYALMZZn0wGKz/vaceLeVT5\nIS6xVkwal/Y/yt2PCicY2VteB942rROvWrrdJtRWvTzT/MxFPYZfaVzWgOwfxvsU\npi/0qAoYn1qygaVFYXC4sRiJcwKBgQDN8tEKiLA4pqd0Rn2bTc457B4KzOg8FKw3\nQR0U4Qt2gaOsyBizSo0Bfe+lriVYa5285X5ohxHxeTVQnuTCtdabmg/5N/0Axmoz\nPozAIAak6gvkubCdWDA6lfLiZEtwbYUZvmv1EP0GMs4Pn4MIa7/zV4SVX4GDJfyw\nLon5akx6CwKBgG++srJCjjDY4IA4cHiSNzsSP+acogDtSzzLXOD/DxY29Pk7nXR6\nFUNVxdM3e+6VvKgf/vByzUopaHvPV9F8jxtdsl64RHcvcXZlWlljGezLfgT8sLoG\nHDIL3Zkg1fi1gzIjXcTJ7vtXdOJcsW0Xt9c8ffrk/Z2OsAAzVqX7PbEbAoGAVP0A\nQQ2ZUzeK4RP5364jDYof96sJp0mMrBylyKj6FwR2q+XDM7HvMI9s5v1PkgaPCJXY\nLYCX6gNv+f4oPyXVE09nihwNv1UiHFWStfJBa6reD5yFgtkSxgp9OenTq+i2RaJs\nYKyLDhTHLnFQHJiClQQnxZCtHJb/iSEbdR7lwnMCgYEAx3fbUGEvWX/xY8xjcbyg\nVQ9LXdYE+cNvjF5YxU14dla0+lQ8JLJ+UvRXh1yc82VYkQ48TkgR9SH3My/GtETl\nnMpp8YwExEp6qPxVv0XjHfETwKWjiw4lnDEXR3o3K1wSaVt97kYyK6AIAs3VqtzQ\ncyWOOql0lJn/boGxm+kj5GE=\n-----END PRIVATE KEY-----\n",
  client_email: "firebase-adminsdk-fbsvc@gestao-reataurante.iam.gserviceaccount.com",
  token_uri: "https://oauth2.googleapis.com/token"
};
const PROJECT_ID = 'gestao-reataurante';
const FS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const FCM_URL = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;

module.exports = async function handler(req, res) {
  try {
    const token = await getAccessToken();
    const agora = new Date(new Date().toLocaleString('en-US', {timeZone:'America/Sao_Paulo'}));
    const hAtual = agora.getHours();
    const mAtual = agora.getMinutes();
    const totalMin = hAtual * 60 + mAtual;
    const dias = ['domingo','segunda','terca','quarta','quinta','sexta','sabado'];
    const diaHoje = dias[agora.getDay()];
    const hoje = `${agora.getFullYear()}-${pad(agora.getMonth()+1)}-${pad(agora.getDate())}`;

    const funcs = await listar('ponto_funcionarios', token);
    const acoes = [];

    for (const doc of funcs) {
      const fcmToken = campo(doc, 'fcmToken');
      if (!fcmToken) continue;
      const nome = (campo(doc,'nome') || campo(doc,'nomeLogin') || 'Funcionário').split(' ')[0];
      const funcId = doc.name.split('/').pop();
      const hMap = doc.fields && doc.fields.horarios && doc.fields.horarios.mapValue && doc.fields.horarios.mapValue.fields;
      if (!hMap) continue;
      const h = hMap[diaHoje] && hMap[diaHoje].mapValue && hMap[diaHoje].mapValue.fields;
      if (!h || h.folga && h.folga.booleanValue) continue;
      const entrada = h.entrada && h.entrada.stringValue;
      const saida   = h.saida   && h.saida.stringValue;
      if (!entrada) continue;

      const minE = toMin(entrada);
      const minS = toMin(saida);

      // Lembrete 5min antes da entrada
      if (minE !== null && totalMin === minE - 5) {
        if (!await jaRegistrou(funcId, hoje, 'entrada', token))
          acoes.push(fcm(fcmToken, `🔔 Lembrete, ${nome}!`, `Sua entrada é às ${entrada}. Prepare-se!`, token));
      }
      // Entrada em ponto
      if (minE !== null && totalMin === minE) {
        if (!await jaRegistrou(funcId, hoje, 'entrada', token))
          acoes.push(fcm(fcmToken, `⏰ Bata o ponto, ${nome}!`, `São ${entrada}. Registre sua entrada agora.`, token));
      }
      // Atraso 15min
      if (minE !== null && totalMin === minE + 15) {
        if (!await jaRegistrou(funcId, hoje, 'entrada', token)) {
          acoes.push(fcm(fcmToken, `⚠️ ${nome}, você está atrasado!`, `Eram ${entrada} e seu ponto não foi registrado!`, token));
          // Notifica gestores
          const gestores = await listar('ponto_gestores_tokens', token);
          for (const g of gestores) {
            const gt = campo(g, 'fcmToken');
            if (gt) acoes.push(fcm(gt, `⚠️ Funcionário atrasado!`, `${nome} deveria ter chegado às ${entrada}.`, token));
          }
        }
      }
      // Intervalo (meio do turno)
      if (minE !== null && minS !== null) {
        const meio = Math.floor((minE + minS) / 2);
        if (totalMin === meio) {
          const st = await getStatus(funcId, hoje, token);
          if (st === 'trabalhando')
            acoes.push(fcm(fcmToken, `☕ Hora do intervalo, ${nome}!`, `Você já trabalhou ${Math.round((meio-minE)/60)}h. Registre o intervalo.`, token));
        }
      }
      // Lembrete saída 5min antes
      if (minS !== null && totalMin === minS - 5) {
        const st = await getStatus(funcId, hoje, token);
        if (st === 'trabalhando')
          acoes.push(fcm(fcmToken, `🔔 Saída em 5 min, ${nome}!`, `Prepare-se para registrar saída às ${saida}.`, token));
      }
      // Saída em ponto
      if (minS !== null && totalMin === minS) {
        const st = await getStatus(funcId, hoje, token);
        if (st === 'trabalhando' || st === 'intervalo')
          acoes.push(fcm(fcmToken, `🏠 Hora de ir, ${nome}!`, `Seu horário de saída é ${saida}. Registre antes de sair!`, token));
      }
    }

    await Promise.allSettled(acoes);
    res.status(200).json({ status:'ok', hora:`${hAtual}:${pad(mAtual)}`, dia:diaHoje, acoes:acoes.length });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

// ── helpers ──────────────────────────────────────────────────────────────────
function pad(n){ return String(n).padStart(2,'0'); }
function toMin(s){ const p=(s||'').split(':'); return p.length<2?null:parseInt(p[0])*60+parseInt(p[1]); }
function campo(doc,f){ const v=doc&&doc.fields&&doc.fields[f]; if(!v)return null; return v.stringValue||v.integerValue||v.booleanValue||null; }

async function getAccessToken(){
  const https = require('https');
  const crypto = require('crypto');
  const now = Math.floor(Date.now()/1000);
  const header = Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging https://www.googleapis.com/auth/datastore',
    aud: SERVICE_ACCOUNT.token_uri,
    exp: now+3600, iat: now
  })).toString('base64url');
  const toSign = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(toSign); sign.end();
  const sig = sign.sign(SERVICE_ACCOUNT.private_key, 'base64url');
  const jwt = `${toSign}.${sig}`;

  const body = `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`;
  const resp = await fetch(SERVICE_ACCOUNT.token_uri, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body
  });
  const data = await resp.json();
  if(!data.access_token) throw new Error('Token falhou: '+JSON.stringify(data));
  return data.access_token;
}

async function listar(col, token){
  const r = await fetch(`${FS_URL}/${col}?pageSize=200`, {headers:{Authorization:`Bearer ${token}`}});
  const d = await r.json();
  return d.documents || [];
}

async function query(col, filtros, token){
  const f = filtros.length===1 ? {fieldFilter:filtros[0]} : {compositeFilter:{op:'AND',filters:filtros.map(x=>({fieldFilter:x}))}};
  const r = await fetch(`${FS_URL}:runQuery`, {
    method:'POST',
    headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({structuredQuery:{from:[{collectionId:col}],where:f,limit:1}})
  });
  const d = await r.json();
  return Array.isArray(d)?d:[];
}

async function jaRegistrou(funcId, diaHoje, tipo, token){
  const r = await query('ponto_registros',[
    {field:{fieldPath:'funcId'},op:'EQUAL',value:{stringValue:funcId}},
    {field:{fieldPath:'diaKey'},op:'EQUAL',value:{stringValue:diaHoje}},
    {field:{fieldPath:'tipo'}, op:'EQUAL',value:{stringValue:tipo}}
  ], token);
  return r.some(x=>x.document);
}

async function getStatus(funcId, diaHoje, token){
  const r = await query('ponto_registros',[
    {field:{fieldPath:'funcId'},op:'EQUAL',value:{stringValue:funcId}},
    {field:{fieldPath:'diaKey'},op:'EQUAL',value:{stringValue:diaHoje}}
  ], token);
  const docs = r.filter(x=>x.document).map(x=>x.document);
  if(!docs.length) return 'fora';
  docs.sort((a,b)=>parseInt(campo(b,'ts')||0)-parseInt(campo(a,'ts')||0));
  const tipo = campo(docs[0],'tipo');
  if(tipo==='entrada'||tipo==='fim_intervalo') return 'trabalhando';
  if(tipo==='ini_intervalo') return 'intervalo';
  return 'fora';
}

async function fcm(deviceToken, titulo, corpo, accessToken){
  const r = await fetch(FCM_URL, {
    method:'POST',
    headers:{Authorization:`Bearer ${accessToken}`,'Content-Type':'application/json'},
    body: JSON.stringify({message:{
      token: deviceToken,
      notification:{title:titulo,body:corpo},
      data:{title:titulo,body:corpo,tag:'ponto',url:'/ponto.html'},
      webpush:{
        notification:{title:titulo,body:corpo,icon:'/icon-192.png',badge:'/icon-192.png',requireInteraction:true,tag:'ponto'},
        fcm_options:{link:'/ponto.html'}
      },
      android:{priority:'high',notification:{title:titulo,body:corpo,color:'#d4a843'}}
    }})
  });
  const d = await r.json();
  if(!r.ok) console.warn('[FCM]',d.error&&d.error.message);
  else console.log('[FCM] OK:',titulo);
}
