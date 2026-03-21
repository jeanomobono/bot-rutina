// Importar las librerías
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

// Obtener el token desde el archivo .env
const token = process.env.TELEGRAM_TOKEN;

// Inicializar el bot en modo "polling" (consulta a Telegram constantemente si hay mensajes nuevos) forzando IPv4
const bot = new TelegramBot(token, { 
    polling: true,
    request: {
        agentOptions: {
            family: 4 // Esto soluciona el AggregateError
        }
    }
});

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
    
    // Telegram guarda la nota de voz en un objeto llamado 'voice'
    const fileId = msg.voice.file_id;
    
    console.log(`🎤 Nota de voz recibida. ID del archivo: ${fileId}`);
    bot.sendMessage(chatId, 'Procesando tu nota de voz, dame un segundo...');

    try {
        // Pedimos a Telegram el enlace directo para acceder a este audio
        const fileLink = await bot.getFileLink(fileId);
        
        console.log(`🔗 Enlace del audio: ${fileLink}`);
        bot.sendMessage(chatId, `¡Tengo el audio! Aquí está el link temporal: ${fileLink}`);
        
        // En el siguiente paso, enviaremos este "fileLink" a la IA para que lo escuche
        
    } catch (error) {
        console.error('Error al obtener el enlace del audio:', error);
        bot.sendMessage(chatId, 'Hubo un problema al procesar el audio.');
    }
});