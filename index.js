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