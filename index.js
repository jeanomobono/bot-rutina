// Importar las librerías
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const https = require('https');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Validar variables de entorno críticas antes de iniciar
const variablesRequeridas = [
    'GEMINI_API_KEY',
    'ORDS_CLIENT_ID',
    'ORDS_CLIENT_SECRET',
    'ORDS_TOKEN_URL',
    'ORDS_BASE_URL'
];

const faltantes = variablesRequeridas.filter(v => !process.env[v]);
if (faltantes.length > 0) {
    console.error(`❌ Error crítico: Faltan las siguientes variables de entorno: ${faltantes.join(', ')}`);
    process.exit(1);
}

const app = express();
const puerto = process.env.PORT || 3000;

// Configurar Multer para guardar el audio temporalmente en la memoria RAM
const upload = multer({ storage: multer.memoryStorage() });

// Middleware globales
app.use(express.json());

const ordsBaseUrl = process.env.ORDS_BASE_URL;
const geminiApiKey = process.env.GEMINI_API_KEY;

// Inicializar Gemini
const genAI = new GoogleGenerativeAI(geminiApiKey);

// Configurar el modelo con instrucciones estrictas (Corregido a gemini-2.0-flash)
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: `Eres un asistente médico experto. Escucha el audio del usuario, identifica qué tipo de evento de la rutina diaria de una paciente renal pediátrica está describiendo y devuelve ÚNICAMENTE un objeto JSON válido, sin formato Markdown, sin comillas invertidas y sin texto adicional.
    
    Reglas de mapeo (Usa estos nombres exactos para "endpoint"):
    - Si es alimentación: {"endpoint": "alimentacion", "payload": {"cantidad_ml": numero, "metodo": "Biberon", "notas": "texto"}}
    - Si es pañales: {"endpoint": "panales", "payload": {"tipo": "Orina/Deposicion/Mixto/Seco", "notas": "texto"}}
    - Si es medicación: {"endpoint": "medicacion", "payload": {"nombre_medicamento": "texto", "dosis_ml": numero, "notas": "texto"}}
    - Si es diálisis nocturna: {"endpoint": "dialisis", "payload": {"ultrafiltracion_ml": numero, "drenaje_inicial_ml": numero, "notas": "texto"}}
    - Si es una cita médica: {"endpoint": "citas", "payload": {"peso_kg": numero, "talla_cm": numero, "presion_arterial": "texto", "indicaciones": "texto", "especialista": "texto"}}`
});

// Variables en memoria para actuar como caché
let tokenCachado = null;
let expiracionToken = null;

// Función inteligente para obtener el token con manejo de errores robusto
async function obtenerTokenValido() {
    const ahora = Date.now();

    // 1. Reutilizar token si aún es válido (margen de 1 minuto)
    if (tokenCachado && expiracionToken && ahora < (expiracionToken - 60000)) {
        console.log("♻️ Usando token OAuth desde la caché");
        return tokenCachado;
    }

    // 2. Solicitar un nuevo token
    console.log("🔑 Solicitando un nuevo token a ORDS...");
    const clientId = process.env.ORDS_CLIENT_ID;
    const clientSecret = process.env.ORDS_CLIENT_SECRET;
    const credencialesBase64 = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenUrl = process.env.ORDS_TOKEN_URL;

    try {
        const tokenResponse = await axios.post(tokenUrl, 'grant_type=client_credentials', {
            headers: {
                'Authorization': `Basic ${credencialesBase64}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            httpsAgent: new https.Agent({ family: 4 }) // Mandato IPv4 de GEMINI.md
        });

        // 3. Actualizar la caché
        tokenCachado = tokenResponse.data.access_token;
        expiracionToken = ahora + (tokenResponse.data.expires_in * 1000);

        return tokenCachado;
    } catch (error) {
        console.error('❌ Error al obtener token OAuth de ORDS:', error.response?.data || error.message);
        throw new Error('No se pudo autenticar con el servidor de base de datos.');
    }
}

/**
 * ENDPOINT: Recibe el audio desde la App Móvil
 */
app.post('/api/procesar-audio', upload.single('audio'), async (req, res) => {
    try {
        const archivoAudio = req.file;

        if (!archivoAudio) {
            return res.status(400).json({ error: 'No se recibió ningún archivo de audio.' });
        }

        console.log(`🎤 Audio recibido: ${archivoAudio.originalname} (${archivoAudio.mimetype})`);

        // Preparar contenido para Gemini
        const audioPart = {
            inlineData: {
                data: archivoAudio.buffer.toString('base64'),
                mimeType: archivoAudio.mimetype
            }
        };

        // Procesar con Gemini
        const result = await model.generateContent(["Extrae los datos de este registro de voz.", audioPart]);
        let rawText = result.response.text().trim();
        
        // Limpieza estricta de Markdown (Mandato de GEMINI.md)
        const jsonRespuesta = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

        console.log("🤖 Respuesta IA:", jsonRespuesta);

        // Validar JSON de forma segura
        let datosParseados;
        try {
            datosParseados = JSON.parse(jsonRespuesta);
        } catch (parseError) {
            console.error("❌ Error de parseo JSON:", rawText);
            return res.status(500).json({ 
                error: 'La IA no devolvió un formato válido.',
                detalle: rawText 
            });
        }

        // Enviar a Oracle ORDS
        try {
            const accessToken = await obtenerTokenValido();
            const urlFinal = `${ordsBaseUrl}${datosParseados.endpoint}/`;
            
            console.log(`📤 Enviando a ORDS: ${urlFinal}`);

            const ordsResponse = await axios.post(urlFinal, datosParseados.payload, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                },
                httpsAgent: new https.Agent({ family: 4 }) // Mandato IPv4 de GEMINI.md
            });

            if (ordsResponse.status === 201) {
                res.status(201).json({
                    mensaje: 'Registro guardado exitosamente',
                    datos: datosParseados
                });
            } else {
                res.status(ordsResponse.status).json({ error: 'ORDS no confirmó la creación del registro.' });
            }
        } catch (dbError) {
            console.error('❌ Error en ORDS/DB:', dbError.message);
            res.status(500).json({ error: 'Error al persistir datos en la base de datos.' });
        }

    } catch (error) {
        console.error('❌ Error general procesando audio:', error);
        res.status(500).json({ error: 'Error interno procesando la solicitud.' });
    }
});

// Iniciar servidor
app.listen(puerto, () => {
    console.log(`🚀 Servidor Ruti API listo en puerto ${puerto}`);
});
