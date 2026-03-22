// Importar las librerías
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const https = require('https');

const ordsBaseUrl = process.env.ORDS_BASE_URL;

// Obtener el token desde el archivo .env
const token = process.env.TELEGRAM_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

// Inicializar el bot en modo "polling" (consulta a Telegram constantemente si hay mensajes nuevos) forzando IPv4
const bot = new TelegramBot(token, { 
    polling: true,
    request: {
        agentOptions: {
            family: 4 // Esto soluciona el AggregateError
        }
    }
});

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);

// Configurar el modelo con instrucciones estrictas
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: `Eres un asistente médico experto. Escucha el audio del usuario, identifica qué tipo de evento de la rutina diaria de una paciente renal pediátrica está describiendo y devuelve ÚNICAMENTE un objeto JSON válido, sin formato Markdown, sin comillas invertidas y sin texto adicional.
    
    Reglas de mapeo (Usa estos nombres exactos para "endpoint"):
    - Si es alimentación: {"endpoint": "alimentacion", "payload": {"cantidad_ml": numero, "metodo": "Biberon", "notas": "texto"}}
    - Si es pañales: {"endpoint": "panales", "payload": {"tipo": "Orina/Deposicion/Mixto/Seco", "notas": "texto"}}
    - Si es medicación: {"endpoint": "medicacion", "payload": {"nombre_medicamento": "texto", "dosis_ml": numero, "notas": "texto"}}
    - Si es diálisis nocturna: {"endpoint": "dialisis", "payload": {"ultrafiltracion_ml": numero, "drenaje_inicial_ml": numero, "notas": "texto"}}
    - Si es una cita médica: {"endpoint": "citas", "payload": {"peso_kg": numero, "talla_cm": numero, "presion_arterial": "texto", "indicaciones": "texto", "especialista": "texto"}`
});

// Variables en memoria para actuar como caché
let tokenCachado = null;
let expiracionToken = null;

// Función inteligente para obtener el token
async function obtenerTokenValido() {
    const ahora = Date.now();

    // 1. Si tenemos token y la hora actual es menor a la de expiración 
    // (le restamos 1 minuto como margen de seguridad), reutilizamos el token.
    if (tokenCachado && expiracionToken && ahora < (expiracionToken - 60000)) {
        console.log("♻️ Usando token OAuth desde la caché");
        return tokenCachado;
    }

    // 2. Si no hay token o ya caducó, pedimos uno nuevo
    console.log("🔑 Solicitando un nuevo token a ORDS...");
    const clientId = process.env.ORDS_CLIENT_ID;
    const clientSecret = process.env.ORDS_CLIENT_SECRET;
    const credencialesBase64 = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenUrl = process.env.ORDS_TOKEN_URL;

    const tokenResponse = await axios.post(tokenUrl, 'grant_type=client_credentials', {
        headers: {
            'Authorization': `Basic ${credencialesBase64}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        httpsAgent: new https.Agent({ family: 4 })
    });

    // 3. Actualizamos la caché
    tokenCachado = tokenResponse.data.access_token;
    // expires_in viene en segundos. Lo pasamos a milisegundos y se lo sumamos a la hora actual
    expiracionToken = ahora + (tokenResponse.data.expires_in * 1000);

    return tokenCachado;
}

// Manejador para atrapar errores de red y que no se caiga el servidor
bot.on('polling_error', (error) => {
    console.log(`⚠️ Advertencia de red: ${error.message}`);
});

console.log('🤖 Bot iniciado y escuchando mensajes...');

// Escuchar cualquier mensaje de texto
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const textoRecibido = msg.text;

    // Si el mensaje es de texto (no un audio o imagen)
    if (textoRecibido) {
        console.log(`Mensaje recibido de ${msg.from.first_name}: ${textoRecibido}`);
        
        // El bot responde confirmando que leyó el mensaje
        bot.sendMessage(chatId, `Hola ${msg.from.first_name}, recibí tu mensaje: "${textoRecibido}". Pronto aprenderé a escuchar audios.`);
    }
});

// Escuchar específicamente notas de voz
bot.on('voice', async (msg) => {
    const chatId = msg.chat.id;
    const fileId = msg.voice.file_id;
    
    bot.sendMessage(chatId, 'Escuchando tu registro... 🎧');

    try {
        // 1. Obtener el enlace de Telegram
        const fileLink = await bot.getFileLink(fileId);
        
        // 2. Descargar el audio en memoria (como un buffer de datos) (Forzando IPv4 para evitar el Timeout)
        const response = await axios.get(fileLink, { 
         responseType: 'arraybuffer',
         httpsAgent: new https.Agent({ family: 4 }) // <-- Esta es la solución
        });
        const audioBuffer = response.data;
        
        // 3. Convertir el audio a Base64 (el formato que lee Gemini)
        const audioBase64 = Buffer.from(audioBuffer).toString('base64');
        const audioPart = {
            inlineData: {
                data: audioBase64,
                mimeType: 'audio/ogg' // Telegram usa este formato
            }
        };

        // 4. Enviar el audio a Gemini pidiendo que extraiga los datos
        const prompt = "Extrae los datos de este registro de voz.";
        const result = await model.generateContent([prompt, audioPart]);
        
        // 5. Limpiar y mostrar el resultado
        let jsonRespuesta = result.response.text().trim();
        
        // Quitar las comillas invertidas de Markdown por si la IA las incluye
        jsonRespuesta = jsonRespuesta.replace(/```json/gi, '').replace(/```/g, '').trim();

        console.log("Respuesta de la IA:", jsonRespuesta);

        // Validar que realmente sea un JSON antes de enviarlo
        const datosParseados = JSON.parse(jsonRespuesta);
        
        // Avisar al usuario que la IA entendió el mensaje
        bot.sendMessage(chatId, `¡Entendido! Guardando registro de ${datosParseados.endpoint}... ⏳`);

        // 6. Enviar los datos a Oracle ORDS
        
        try {
            // Llamamos a nuestra nueva función (ella decide si recicla o pide uno nuevo)
            const accessToken = await obtenerTokenValido();

            // Extraemos a qué ruta (endpoint) debe ir y qué datos (payload) enviar
            const endpointDestino = datosParseados.endpoint; 
            const payload = datosParseados.payload;
            
            // Construimos la URL final (ej: https://.../ords/api/rutina/alimentacion/)
            const urlFinal = `${ordsBaseUrl}${endpointDestino}/`;
            console.log("URL final:", urlFinal);
            console.log("Datos a enviar:", payload);
            
            // Hacemos el POST a tu base de datos
            const ordsResponse = await axios.post(urlFinal, payload, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`, // Aquí enviamos la llave
                    'Content-Type': 'application/json'
                },
                httpsAgent: new https.Agent({ family: 4 }) 
            });

            // ORDS devuelve un 201 Created cuando el insert es exitoso
            if (ordsResponse.status === 201) {
                bot.sendMessage(chatId, `✅ ¡Listo! Registro guardado exitosamente en la base de datos.`);
            } else {
                bot.sendMessage(chatId, `⚠️ El dato se envió, pero Oracle devolvió un estado inesperado: ${ordsResponse.status}`);
            }

        } catch (dbError) {
            console.error('Error al contactar con Oracle ORDS:', dbError.message);
            bot.sendMessage(chatId, `❌ Error al guardar en la base de datos. Revisa si la URL de ORDS es correcta o si la base de datos está activa.`);
        }

    } catch (error) {
        console.error('Error procesando el audio:', error);
        bot.sendMessage(chatId, 'Hubo un problema al procesar el audio. Intenta hablar más claro o revisa la consola.');
    }
});