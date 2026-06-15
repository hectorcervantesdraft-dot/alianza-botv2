import express from 'express';
import fetch from 'node-fetch';
import { readFileSync, appendFileSync } from 'fs';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'alianza_verify';
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const config = JSON.parse(readFileSync('./flow-config.json', 'utf8'));
const sessions = new Map();

// ─── LOG ────────────────────────────────────────────────────────────────────
function logConversation(from, step, inbound, outbound) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    from,
    step,
    inbound,
    outbound,
  }) + '\n';
  try {
    appendFileSync('./conversations.log', line);
  } catch (e) {
    console.error('Log error:', e.message);
  }
  console.log(`[${from}] [${step}] IN: "${inbound}" -> OUT: "${outbound.substring(0, 60)}..."`);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getSession(from) {
  if (!sessions.has(from)) {
    sessions.set(from, { step: 'start', data: {}, retries: 0 });
  }
  return sessions.get(from);
}

function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function norm(text) {
  return stripAccents((text || '').trim().toLowerCase());
}

function fill(template, vars) {
  return Object.entries(vars).reduce(
    (acc, [k, v]) => acc.replaceAll(`{${k}}`, v ?? ''),
    template
  );
}

function isHandoffKeyword(text) {
  const t = norm(text);
  return (config.handoff_keywords || []).some((kw) => t.includes(norm(kw)));
}

// ─── WHATSAPP SEND ───────────────────────────────────────────────────────────
async function sendMessage(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    console.log(`[DRY RUN] -> ${to}: ${text}`);
    return;
  }
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    }
  );
  if (!res.ok) console.error('WA send error', res.status, await res.text());
}

let cachedImageMediaId = null;

async function getImageMediaId() {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return 'DRY_RUN_MEDIA_ID';
  if (cachedImageMediaId) return cachedImageMediaId;
  const path = config.imagen_recordatorio_path;
  const buffer = readFileSync(path);
  const ext = path.split('.').pop().toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('file', new Blob([buffer], { type: mime }), path.split('/').pop());
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`,
    { method: 'POST', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, body: form }
  );
  if (!res.ok) { console.error('Image upload error', res.status, await res.text()); return null; }
  const data = await res.json();
  cachedImageMediaId = data.id;
  return cachedImageMediaId;
}

async function sendImage(to, caption) {
  const mediaId = await getImageMediaId();
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !mediaId) {
    console.log(`[DRY RUN] -> ${to}: [IMAGEN] ${caption || ''}`);
    return;
  }
  const res = await fetch(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: { id: mediaId, caption: caption || '' },
      }),
    }
  );
  if (!res.ok) console.error('WA image error', res.status, await res.text());
}

// ─── MATCH HELPERS ───────────────────────────────────────────────────────────
function matchVehiculo(text) {
  const v = norm(text);
  if (v.includes('moto')) return 'moto';
  if (v.includes('bici')) return 'bici';
  return null;
}

function matchSiNo(text) {
  const v = norm(text);
  const noWords = ['no', 'aun no', 'todavia no', 'no puedo', 'no podria', 'no me interesa', 'tampoco'];
  const siWords = ['si', 'claro', 'va', 'sale', 'simon', 'obvio', 'puedo', 'podria', 'me interesa', 'todos', 'tengo'];
  if (noWords.some((w) => v.includes(w))) return false;
  if (siWords.some((w) => v.includes(w))) return true;
  return null;
}

function matchZonaRechazo(text) {
  const t = norm(text);
  return (
    matchSiNo(text) === false ||
    (config.zona_rechazo_extra || []).some((kw) => t.includes(norm(kw)))
  );
}

// ─── HANDOFF ─────────────────────────────────────────────────────────────────
async function sendHandoff(to, step, inbound) {
  const msg = fill(config.mensajes_handoff.derivar, { handoff_numero: config.handoff_numero });
  await sendMessage(to, msg);
  logConversation(to, step, inbound, msg);
}

// ─── FLOW ────────────────────────────────────────────────────────────────────
async function handleMessage(from, text) {
  const session = getSession(from);
  const M = config.mensajes;
  const MH = config.mensajes_handoff;

  const reply = async (msg) => {
    await sendMessage(from, msg);
    logConversation(from, session.step, text, msg);
  };

  // Handoff por keyword en cualquier paso (excepto done/rechazado)
  if (!['done', 'rechazado'].includes(session.step) && isHandoffKeyword(text)) {
    await sendHandoff(from, session.step, text);
    return;
  }

  switch (session.step) {

    case 'start': {
      const generic = ['hola', 'informacion', 'info', 'interesado', 'interesada', 'buenas', 'mas informacion'];
      const looksLikeName = !generic.some((g) => norm(text).includes(g)) && text.trim().split(/\s+/).length <= 3;
      if (looksLikeName) {
        session.data.nombre = text.trim();
        await reply(fill(M.bienvenida_con_nombre, { nombre: session.data.nombre }));
        session.step = 'zona';
        await reply(fill(M.pedir_zona, { zonas: config.zonas_cobertura_texto }));
      } else {
        await reply(M.bienvenida_sin_nombre);
        session.step = 'nombre';
      }
      break;
    }

    case 'nombre':
      session.data.nombre = text.trim();
      await reply(fill(M.bienvenida_con_nombre, { nombre: session.data.nombre }));
      session.step = 'zona';
      await reply(fill(M.pedir_zona, { zonas: config.zonas_cobertura_texto }));
      break;

    case 'zona': {
      if (matchZonaRechazo(text)) {
        session.step = 'rechazado';
        await reply(M.fuera_zona);
      } else {
        session.data.zona = text;
        session.step = 'vehiculo';
        session.retries = 0;
        await reply(M.pedir_vehiculo);
      }
      break;
    }

    case 'vehiculo': {
      const vehiculo = matchVehiculo(text);
      if (!vehiculo) {
        session.retries = (session.retries || 0) + 1;
        if (session.retries >= 2) {
          await reply(fill(MH.no_entendido, { handoff_numero: config.handoff_numero }));
          session.step = 'done';
        } else {
          await reply(M.pedir_vehiculo_retry);
        }
        break;
      }
      session.data.vehiculo = vehiculo;
      session.step = 'disponibilidad';
      session.retries = 0;
      await reply(M.pedir_disponibilidad);
      break;
    }

    case 'disponibilidad': {
      const puede = matchSiNo(text);
      if (puede === false) {
        session.step = 'rechazado';
        await reply(M.disponibilidad_insuficiente);
      } else if (puede === null) {
        session.retries = (session.retries || 0) + 1;
        if (session.retries >= 2) {
          await reply(fill(MH.no_entendido, { handoff_numero: config.handoff_numero }));
          session.step = 'done';
        } else {
          await reply('¿Puedes confirmar con un "sí" o "no"? 🙏');
        }
      } else {
        session.data.disponibilidad_ok = true;
        session.step = 'done';
        session.retries = 0;
        await reply(fill(M.documentos_recordatorio, { lista: config.documentos_requeridos.join(', ') }));
        await reply(fill(M.mensaje_meet, { meet_link: config.meet_link }));
        await sendImage(from, M.imagen_caption);
        logConversation(from, 'done', text, '[imagen recordatorio]');

        // Notificación al número de operaciones
        const notif = `✅ Nuevo candidato calificado:\nNombre: ${session.data.nombre || 'No capturado'}\nZona: ${session.data.zona || '-'}\nVehículo: ${session.data.vehiculo || '-'}\nTeléfono: +${from}\nSe conecta mañana a las 10am 👉 ${config.meet_link}`;
        await sendMessage(config.numero_operaciones, notif);
      }
      break;
    }

    case 'rechazado':
    case 'done':
    default:
      await reply(M.cierre_generico);
      break;
  }
}

// ─── WEBHOOK ─────────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (message?.type === 'text') {
      await handleMessage(message.from, message.text.body);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

app.get('/', (_req, res) => res.send('Alianza FT Premium bot - OK'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
