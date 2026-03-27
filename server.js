const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

let whatsappClient = null;
let qrCode = null;
let isReady = false;

function initWhatsApp() {
  if (whatsappClient) {
    console.log('⚠️ Cliente WhatsApp ya inicializado');
    return;
  }

  console.log('🚀 Inicializando cliente WhatsApp...');
  
  whatsappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    }
  });

  whatsappClient.on('qr', async (qr) => {
    console.log('📱 QR generado');
    qrCode = await qrcode.toDataURL(qr);
    io.emit('qr', qrCode);
  });

  whatsappClient.on('authenticated', () => {
    console.log('✅ WhatsApp autenticado');
    qrCode = null;
  });

  whatsappClient.on('ready', () => {
    console.log('✅ WhatsApp listo');
    isReady = true;
    io.emit('whatsapp_ready', { status: 'connected' });
  });

  whatsappClient.on('message', async (message) => {
    console.log('📨 Mensaje:', message.body);
    
    const contact = await message.getContact();
    
    io.emit('new_message', {
      from: message.from,
      fromName: contact.pushname || contact.number,
      body: message.body,
      timestamp: message.timestamp
    });
  });

  whatsappClient.on('disconnected', (reason) => {
    console.log('❌ Desconectado:', reason);
    isReady = false;
    whatsappClient = null;
    io.emit('whatsapp_disconnected', { reason });
  });

  whatsappClient.initialize();
}

io.on('connection', (socket) => {
  console.log('🔌 Cliente conectado');

  if (!whatsappClient) {
    initWhatsApp();
  }

  socket.emit('whatsapp_status', { isReady, qrCode });

  socket.on('send_message', async (data) => {
    const { to, message } = data;
    
    if (!isReady) {
      socket.emit('error', { message: 'WhatsApp no conectado' });
      return;
    }

    try {
      await whatsappClient.sendMessage(to, message);
      socket.emit('message_sent', { to, message });
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('get_chats', async () => {
    if (!isReady) {
      socket.emit('error', { message: 'WhatsApp no conectado' });
      return;
    }

    try {
      const chats = await whatsappClient.getChats();
      const chatList = [];
      
      for (let i = 0; i < Math.min(chats.length, 50); i++) {
        const chat = chats[i];
        const contact = await chat.getContact();
        chatList.push({
          id: chat.id._serialized,
          name: contact.pushname || contact.number,
          lastMessage: chat.lastMessage?.body || '',
          timestamp: chat.timestamp
        });
      }

      socket.emit('chats_list', chatList);
    } catch (error) {
      socket.emit('error', { message: error.message });
    }
  });
});

app.get('/', (req, res) => {
  res.json({ 
    status: 'MIIA Backend Running',
    whatsapp: isReady ? 'connected' : 'disconnected'
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
    whatsapp: isReady
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Servidor en puerto ${PORT}`);
});
