// Importar las librerías
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const puerto = 3000;

// Configurar Multer para guardar el audio temporalmente en la memoria RAM
const upload = multer({ storage: multer.memoryStorage() });

// Middleware globales
app.use(express.json());

const ordsBaseUrl = process.env.ORDS_BASE_URL;

// Obtener el token desde el archivo .env
const geminiApiKey = process.env.GEMINI_API_KEY;

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

/**
 * NUEVO ENDPOINT: Recibe el audio desde Flutter/Kotlin
 * El celular debe enviar la petición POST con FormData y el campo "audio"
 */

app.post('/api/procesar-audio', upload.single('audio'), async (req, res) => {
    try {
        // 1. Recibir el audio desde la app móvil
        const archivoAudio = req.file;

        if (!archivoAudio) {
            return res.status(400).json({ error: 'No se recibió ningún archivo de audio.' });
        }

        console.log(`🎤 Audio recibido desde la App: ${archivoAudio.originalname}`);

        // 2. Convertir el audio a Base64 para Gemini (ahora viene desde req.file.buffer)
        const audioBase64 = archivoAudio.buffer.toString('base64');
        const audioPart = {
            inlineData: {
                data: audioBase64,
                mimeType: archivoAudio.mimetype
            }
        };

        // 3. Enviar el audio a Gemini pidiendo que extraiga los datos
        const prompt = "Extrae los datos de este registro de voz.";
        const result = await model.generateContent([prompt, audioPart]);

        let jsonRespuesta = result.response.text().trim();
        // Quitar las comillas invertidas de Markdown por si la IA las incluye
        jsonRespuesta = jsonRespuesta.replace(/```json/gi, '').replace(/```/g, '').trim();

        console.log("Respuesta de la IA:", jsonRespuesta);

        // Validar que realmente sea un JSON antes de enviarlo
        const datosParseados = JSON.parse(jsonRespuesta);

        // 4. Enviar los datos a Oracle ORDS

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
                res.status(201).json({
                    mensaje: 'Registro guardado exitosamente',
                    datos: datosParseados
                });
            } else {
                res.status(ordsResponse.status).json({ error: 'Fallo al guardar en Oracle' });
            }
        } catch (dbError) {
            console.error('Error al contactar con Oracle ORDS:', dbError.message);
            res.status(500).json({ error: `Error al guardar en la base de datos. Revisa si la URL de ORDS es correcta o si la base de datos está activa.` });
        }

    } catch (error) {
        console.error('Error procesando el audio:', error);
        res.status(500).json({ error: 'Error interno del servidor procesando el registro.' });
    }
});

// Levantar el servidor
app.listen(puerto, () => {
    console.log(`🚀 Servidor API de la rutina corriendo en el puerto ${puerto}`);
});