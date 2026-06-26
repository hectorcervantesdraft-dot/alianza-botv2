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
const processedMessageIds = new Set();

// ── Mutex por número — evita procesamiento concurrente del mismo usuario ──────
const processingLocks = new Set();

const SESSION_TIMEOUT_MS      = 2 * 60 * 1000;          // 2 min — flujo activo
const SESSION_CURP_TIMEOUT_MS = 4 * 60 * 1000;          // 4 min — esperando CURP
const SESSION_DONE_TIMEOUT_MS = 8 * 60 * 60 * 1000;     // 8 hrs — flujo completado

// ─── Google Sheets logging ───────────────────────────────────────────────────
const SHEETS_URL = process.env.SHEETS_URL || 'https://script.google.com/macros/s/AKfycbxvyb-PFYzCr0D_erT0zSyD6vnkrJV-bdfA6PGWhr4jOnxCZqqAe3r48Siv7J0Va61J/exec';

async function logToSheets(telefono, nombre, paso, mensaje, respuesta, estado) {
  try {
    await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono, nombre, paso, mensaje, respuesta, estado }),
    });
  } catch (e) {
    console.error('[SHEETS] Error logging:', e.message);
  }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function logConversation(from, step, inbound, outbound) {
  const line = JSON.stringify({ ts: new Date().toISOString(), from, step, inbound, outbound }) + '\n';
  try { appendFileSync('./conversations.log', line); } catch (e) { console.error('Log error:', e.message); }
  console.log(`[${from}] [${step}] IN: "${inbound}" -> OUT: "${outbound.substring(0, 80)}"`);
  // Log a Google Sheets
  const session = sessions.get(from);
  logToSheets(
    from,
    session?.data?.nombre || '',
    step,
    inbound,
    outbound.substring(0, 200),
    step
  );
}

// ─── Session management ───────────────────────────────────────────────────────

function getSession(from) {
  const existing = sessions.get(from);
  if (existing) {
    const elapsed = Date.now() - existing.lastActivity;
    let timeout = SESSION_TIMEOUT_MS;
    if (existing.step === 'done') timeout = SESSION_DONE_TIMEOUT_MS;
    else if (existing.step === 'curp') timeout = SESSION_CURP_TIMEOUT_MS;
    if (elapsed > timeout) {
      console.log(`[TIMEOUT] Sesión expirada para ${from} (step: ${existing.step}), reiniciando`);
      sessions.delete(from);
    } else {
      existing.lastActivity = Date.now();
      return existing;
    }
  }
  const session = { step: 'start', data: {}, retries: 0, lastActivity: Date.now() };
  sessions.set(from, session);
  return session;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function stripAccents(str) { return str.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function norm(text) { return stripAccents((text || '').trim().toLowerCase()); }
function fill(template, vars) {
  return Object.entries(vars).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v ?? ''), template);
}

function isHandoffKeyword(text) {
  const t = norm(text);
  return (config.handoff_keywords || []).some((kw) => t.includes(norm(kw)));
}

const QUESTION_WORDS = [
  'cuanto', 'cuantos', 'cuanta', 'pagan', 'pago', 'sueldo', 'salario',
  'ganan', 'gano', 'cobran', 'donde', 'cuando', 'como', 'que', 'cual',
  'quien', 'porque', 'zona', 'zonas', 'informacion', 'info',
  'trabajo', 'trabajar', 'empleo', 'interesa', 'interesado',
];

function looksLikeQuestion(text) {
  if (text.includes('?')) return true;
  const words = norm(text).split(/\s+/);
  return QUESTION_WORDS.some((qw) => words.includes(norm(qw)));
}

function looksLikeName(text) {
  if (looksLikeQuestion(text)) return false;
  const words = text.trim().split(/\s+/);
  if (words.length < 1 || words.length > 5) return false;
  const t = norm(text);
  const genericWords = [
    'hola', 'buenas', 'buenos', 'dias', 'tardes', 'noches',
    'ok', 'bien', 'dale', 'sale', 'claro', 'si', 'no',
    'gracias', 'perfecto', 'excelente', 'genial', 'listo',
    'quiero', 'necesito', 'tengo', 'busco', 'bici', 'moto',
  ];
  return !genericWords.some((g) => t === g || t.startsWith(g + ' ') || t.endsWith(' ' + g));
}

function matchVehiculo(text) {
  const v = norm(text);
  const rechazos = config.vehiculo_rechazo_palabras || [];
  if (rechazos.some((r) => v.includes(norm(r)))) return 'rechazado';
  if (v.includes('moto') || v.includes('motocicleta')) return 'moto';
  if (v.includes('bici') || v.includes('bicicleta')) return 'bici';
  return null;
}

function matchSiNo(text) {
  const v = norm(text);
  const noWords = ['aun no', 'todavia no', 'no podria', 'no me interesa', 'tampoco'];
  const siWords = ['claro', 'va', 'sale', 'simon', 'obvio', 'me interesa'];
  if (noWords.some((w) => v.includes(w))) return false;
  if (v === 'no' || v.startsWith('no ') || v.endsWith(' no')) return false;
  // 'si' solo como palabra completa
  const words = v.split(/\s+/);
  if (words.includes('si') || words.includes('sí')) return true;
  if (siWords.some((w) => v.includes(w))) return true;
  return null;
}

function matchZonaRechazo(text) {
  const t = norm(text);
  return matchSiNo(text) === false || (config.zona_rechazo_extra || []).some((kw) => t.includes(norm(kw)));
}

function looksLikeCurp(text) {
  const cleaned = text.trim().toUpperCase().replace(/\s/g, '');
  return /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(cleaned);
}

// Detecta si el texto es solo una confirmación simple sin datos reales
function esSoloConfirmacion(text) {
  const v = norm(text);
  const confirmaciones = [
    'si', 'sí', 'ok', 'okay', 'okey', 'claro', 'va', 'sale', 'simon',
    'perfecto', 'listo', 'entendido', 'de acuerdo', 'esta bien', 'está bien',
    'si esta bien', 'sí está bien', 'si ok', 'si claro', 'sí claro',
    'si, claro', 'sí, claro', 'si gracias', 'sí gracias', 'super',
  ];
  const vClean = v.replace(/[.,!¡¿]/g, '').trim();
  return confirmaciones.some((c) => vClean === c || vClean === norm(c));
}

// ─── WhatsApp messaging ───────────────────────────────────────────────────────

async function sendMessage(to, text) {
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) { console.log(`[DRY RUN] -> ${to}: ${text}`); return; }
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  });
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
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/media`, {
    method: 'POST', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }, body: form,
  });
  if (!res.ok) { console.error('Image upload error', res.status, await res.text()); return null; }
  const data = await res.json();
  cachedImageMediaId = data.id;
  return cachedImageMediaId;
}

async function sendImage(to, caption) {
  try {
    const mediaId = await getImageMediaId();
    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !mediaId) {
      console.log(`[DRY RUN] -> ${to}: [IMAGEN] ${caption || ''}`);
      return;
    }
    const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'image', image: { id: mediaId, caption: caption || '' } }),
    });
    if (!res.ok) console.error('WA image error', res.status, await res.text());
  } catch (e) {
    console.error('sendImage failed (non-blocking):', e.message);
  }
}

async function sendHandoff(to, step, inbound) {
  const msg = fill(config.mensajes_handoff.derivar, { handoff_numero: config.handoff_numero });
  await sendMessage(to, msg);
  logConversation(to, step, inbound, msg);
}

// ─── Main message handler ─────────────────────────────────────────────────────

async function handleMessage(from, text) {
  const session = getSession(from);
  const M = config.mensajes;
  const MH = config.mensajes_handoff;

  const reply = async (msg) => {
    await sendMessage(from, msg);
    logConversation(from, session.step, text, msg);
  };

  // Handoff keywords — solo aplica antes de done/rechazado
  if (!['done', 'rechazado'].includes(session.step) && isHandoffKeyword(text)) {
    await sendHandoff(from, session.step, text);
    await sendMessage(config.numero_operaciones,
      `💬 Candidato con dudas (handoff):\nNombre: ${session.data.nombre || 'No capturado'}\nPaso: ${session.step}\nMensaje: ${text}\nTeléfono: +${from}`);
    session.step = 'done';
    return;
  }

  switch (session.step) {

    // ── start ────────────────────────────────────────────────────────────────
    case 'start': {
      if (looksLikeName(text)) {
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

    // ── nombre ───────────────────────────────────────────────────────────────
    case 'nombre': {
      if (looksLikeQuestion(text)) {
        session.retries = (session.retries || 0) + 1;
        if (session.retries >= 2) {
          await sendHandoff(from, session.step, text);
          await sendMessage(config.numero_operaciones,
            `💬 Handoff en captura de nombre:\nMensaje: ${text}\nTeléfono: +${from}`);
          session.step = 'done';
        } else {
          await reply('Para poder ayudarte necesito saber tu nombre primero 🙂 ¿Cómo te llamas?');
        }
        break;
      }
      session.data.nombre = text.trim();
      await reply(fill(M.bienvenida_con_nombre, { nombre: session.data.nombre }));
      session.step = 'zona';
      session.retries = 0;
      await reply(fill(M.pedir_zona, { zonas: config.zonas_cobertura_texto }));
      break;
    }

    // ── zona ─────────────────────────────────────────────────────────────────
    case 'zona': {
      if (matchZonaRechazo(text)) {
        session.step = 'rechazado';
        await reply(M.fuera_zona);
        await sendMessage(config.numero_operaciones,
          `❌ Rechazado por zona:\nNombre: ${session.data.nombre || 'No capturado'}\nZona mencionada: ${text}\nTeléfono: +${from}`);
        break;
      }
      const zonaValida = matchSiNo(text) === true ||
        (config.zonas_cobertura_lista || []).some((z) => norm(text).includes(norm(z)));
      if (!zonaValida) {
        session.retries = (session.retries || 0) + 1;
        if (session.retries >= 2) {
          await reply(fill(MH.no_entendido, { handoff_numero: config.handoff_numero }));
          await sendMessage(config.numero_operaciones,
            `🔀 Handoff por zona no confirmada:\nNombre: ${session.data.nombre || 'No capturado'}\nMensaje: ${text}\nTeléfono: +${from}`);
          session.step = 'done';
        } else {
          await reply(fill(M.pedir_zona, { zonas: config.zonas_cobertura_texto }));
        }
        break;
      }
      session.data.zona = text;
      session.step = 'vehiculo';
      session.retries = 0;
      await reply(M.pedir_vehiculo);
      break;
    }

    // ── vehiculo ──────────────────────────────────────────────────────────────
    case 'vehiculo': {
      const vehiculo = matchVehiculo(text);
      if (vehiculo === 'rechazado') {
        session.step = 'rechazado';
        await reply(M.vehiculo_no_aplica);
        await sendMessage(config.numero_operaciones,
          `❌ Rechazado por vehículo:\nNombre: ${session.data.nombre || 'No capturado'}\nVehículo mencionado: ${text}\nTeléfono: +${from}`);
        break;
      }
      if (!vehiculo) {
        session.retries = (session.retries || 0) + 1;
        if (session.retries >= 2) {
          await reply(fill(MH.no_entendido, { handoff_numero: config.handoff_numero }));
          await sendMessage(config.numero_operaciones,
            `🔀 Handoff por vehículo no reconocido:\nNombre: ${session.data.nombre || 'No capturado'}\nTeléfono: +${from}`);
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

    // ── disponibilidad ────────────────────────────────────────────────────────
    case 'disponibilidad': {
      const puede = matchSiNo(text);
      if (puede === false) {
        session.step = 'rechazado';
        await reply(M.disponibilidad_insuficiente);
        await sendMessage(config.numero_operaciones,
          `❌ Rechazado por disponibilidad:\nNombre: ${session.data.nombre || 'No capturado'}\nVehículo: ${session.data.vehiculo || '-'}\nTeléfono: +${from}`);
      } else if (puede === null) {
        session.retries = (session.retries || 0) + 1;
        if (session.retries >= 2) {
          await reply(fill(MH.no_entendido, { handoff_numero: config.handoff_numero }));
          await sendMessage(config.numero_operaciones,
            `🔀 Handoff por disponibilidad no confirmada:\nNombre: ${session.data.nombre || 'No capturado'}\nTeléfono: +${from}`);
          session.step = 'done';
        } else {
          await reply('¿Puedes confirmar con un "sí" o "no"? 🙏');
        }
      } else {
        session.data.disponibilidad_ok = true;
        session.step = 'curp';
        session.retries = 0;
        await reply(fill(M.calificado_intro, {
          meet_link: config.meet_link,
          lista: config.documentos_requeridos.join(', '),
        }));
        await reply(M.pedir_curp);
      }
      break;
    }

    // ── curp ──────────────────────────────────────────────────────────────────
    case 'curp': {
      const t = norm(text);
      const noCurp = ['no se', 'no sé', 'no la tengo', 'no tengo', 'no recuerdo', 'no la recuerdo', 'no la se'];
      const sinCurp = noCurp.some((w) => t.includes(w));

      if (sinCurp) {
        // No tiene CURP — avanza sin problema
        session.data.curp = 'No proporcionada';
      } else if (esSoloConfirmacion(text)) {
        // Respondió "Sí", "Ok", "Claro" etc. — todavía no ha dado la CURP
        session.retries = (session.retries || 0) + 1;
        if (session.retries >= 2) {
          // Después de 2 intentos sin CURP — avanza de todas formas
          session.data.curp = 'No proporcionada';
        } else {
          await reply(M.pedir_curp);
          break;
        }
      } else if (looksLikeCurp(text)) {
        // CURP válida con formato correcto
        session.data.curp = text.trim().toUpperCase().replace(/\s/g, '');
      } else {
        // Texto libre — guardamos tal cual (CURP mal escrita, parcial, o cualquier dato)
        session.data.curp = text.trim().toUpperCase();
      }

      session.step = 'done';
      session.data.completado = true;
      await sendImage(from, M.imagen_caption);
      await reply(fill(M.mensaje_meet, { meet_link: config.meet_link }));
      await reply(M.mensaje_final);
      logConversation(from, 'done', text, '[imagen + meet + mensaje final]');
      const notif = `✅ Nuevo candidato calificado:\nNombre: ${session.data.nombre || 'No capturado'}\nZona: ${session.data.zona || '-'}\nVehículo: ${session.data.vehiculo || '-'}\nCURP: ${session.data.curp || '-'}\nTeléfono: +${from}\nSe conecta mañana a las 10am 👉 ${config.meet_link}`;
      await sendMessage(config.numero_operaciones, notif);
      break;
    }

    // ── done ──────────────────────────────────────────────────────────────────
    case 'done': {
      if (session.data.completado) {
        await reply(M.mensaje_final);
      } else {
        await reply(`Para cualquier duda escríbenos directamente 👉 https://wa.me/525580971200\n\nSi te equivocaste o quieres empezar de nuevo, espera 2 minutos y escríbenos nuevamente 🙂`);
      }
      break;
    }

    // ── rechazado ─────────────────────────────────────────────────────────────
    case 'rechazado':
    default: {
      await sendMessage(from, `Si en algún momento cambia tu situación, escríbenos 👉 https://wa.me/525580971200`);
      logConversation(from, 'rechazado', text, 'cierre');
      break;
    }
  }
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  // Responder 200 inmediatamente para que Meta no reintente
  res.sendStatus(200);
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;

    const msgId = message.id;
    const from  = message.from;

    // Deduplicación por ID
    if (processedMessageIds.has(msgId)) {
      console.log(`[DEDUP] Mensaje duplicado ignorado: ${msgId}`);
      return;
    }
    processedMessageIds.add(msgId);
    if (processedMessageIds.size > 10000) {
      processedMessageIds.delete(processedMessageIds.values().next().value);
    }

    // Loguear mensaje entrante en Google Sheets (no bloquea)
    const sessionForLog = sessions.get(from);
    logToSheets(
      from,
      sessionForLog?.data?.nombre || '',
      sessionForLog?.step || 'start',
      message.text.body,
      '',
      'entrante'
    );

    // Mutex por número — si ya se está procesando un mensaje de este número, encolar
    if (processingLocks.has(from)) {
      console.log(`[MUTEX] Mensaje de ${from} llegó mientras se procesaba otro — ignorado`);
      return;
    }
    processingLocks.add(from);
    try {
      await handleMessage(from, message.text.body);
    } finally {
      processingLocks.delete(from);
    }
  } catch (err) {
    console.error(err);
  }
});

app.get('/', (_req, res) => res.send('Alianza FT Premium bot - OK'));
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
