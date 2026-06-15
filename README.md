# Bot de calificación de riders – Alianza FT Premium

Flujo probado: saludo → zona → vehículo → documentos → disponibilidad → agenda
(o cierre cortés si no califica en cualquier paso).

## 1. Editar el flujo (sin tocar código)

Abre `flow-config.json` y completa:

- `zonas_cobertura_texto`: lista real de colonias/zonas (ya está con Taxqueña, Coapa, Polanco, Roma, Reforma, Narvarte, Buenavista, Centro).
- `documentos_requeridos`: lista real.
- `meet_link`: el link fijo de Meet al que se conectan diario a las 10am.
- `imagen_recordatorio_path`: ruta al archivo de imagen que se enviará como recordatorio.
  Coloca el archivo dentro de la carpeta `assets/` (por ejemplo `assets/recordatorio.jpg`).
  La primera vez que el bot necesita enviarla, la sube a WhatsApp y guarda el
  `media_id` en memoria para reusarlo (no la vuelve a subir cada vez).

## 2. Configurar WhatsApp Cloud API (lado de Meta)

1. En developers.facebook.com, crea/usa una App con el producto "WhatsApp".
2. Obtén: `PHONE_NUMBER_ID` y un `WHATSAPP_TOKEN` (token permanente vía System User,
   no el temporal de 24h).
3. Define un `VERIFY_TOKEN` propio (cualquier string que tú elijas).

## 3. Desplegar

Cualquier hosting que corra Node sirve (Railway, Render, Fly.io).

```bash
npm install
WHATSAPP_TOKEN=xxx PHONE_NUMBER_ID=xxx VERIFY_TOKEN=xxx npm start
```

Sin esas variables, el bot corre en "DRY RUN": procesa el flujo y solo
imprime en consola lo que enviaría, sin llamar a WhatsApp. Útil para probar
la lógica antes de conectar el número real.

## 4. Configurar el Webhook en Meta

En el dashboard de WhatsApp > Configuration > Webhook:
- Callback URL: `https://TU-DOMINIO/webhook`
- Verify token: el mismo `VERIFY_TOKEN` que pusiste en el paso 2.
- Suscríbete al campo `messages`.

## 5. Probar

Escribe al número de WhatsApp Business conectado y sigue la conversación.

## Limitaciones de esta versión (a propósito, para mantenerla simple)

- Las sesiones se guardan en memoria: si el servidor se reinicia, se pierden
  conversaciones a medias. Para producción real, cambiar `sessions` (Map)
  por Redis o una tabla en base de datos.
- La detección de respuestas (zona, sí/no, vehículo, días) es por palabras
  clave simples, no IA. Si quieres que entienda fraseos más libres, se puede
  meter una llamada a la API de Claude para interpretar la respuesta antes
  de decidir el siguiente paso.
- No envía mensajes de re-engagement a quien deja de responder (eso
  requeriría plantillas aprobadas por Meta y tiene costo por mensaje).

## Costos esperados

- Mensajería: prácticamente $0, porque las respuestas del bot caen dentro de
  la ventana de 24-72h de mensajes gratuitos (conversación iniciada por el
  lead desde el anuncio).
- Hosting: $0-7 USD/mes en planes gratuitos/básicos de Railway o Render.
