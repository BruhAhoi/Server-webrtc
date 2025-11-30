import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import 'dotenv/config';

const app = express();
const server = http.createServer(app);
const recorders = {};
const chatHistory = {};

// ⭐ ENHANCED SOCKET.IO CONFIGURATION
const io = new Server(server, {
  cors: {
    origin: [
      "https://collabsphere.space",      // ⭐ Production domain
      "https://www.collabsphere.space",  // ⭐ With www
      "http://localhost:5173",           // ⭐ Vite dev
      "http://localhost:3000",           // ⭐ Alternative dev
      process.env.FRONTEND_URL,          // ⭐ From env var
    ].filter(Boolean), // Remove undefined values
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Content-Type"],
  },
  // ⭐ CRITICAL: Transport configuration
  transports: ['websocket', 'polling'],
  
  // ⭐ CRITICAL: Timeout settings for stability
  pingTimeout: 60000,    // 60 seconds
  pingInterval: 25000,   // 25 seconds
  
  // ⭐ Connection settings
  connectTimeout: 45000,
  upgradeTimeout: 10000,
  
  // ⭐ Max HTTP buffer size
  maxHttpBufferSize: 1e8, // 100 MB (for large files if needed)
});

// ⭐ Trust proxy for Railway
app.set('trust proxy', 1);

// ⭐ Add logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// ⭐ Root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'WebRTC Signaling Server',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// ⭐ Health check endpoint (CRITICAL for monitoring)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    connections: io.engine.clientsCount || 0,
    timestamp: new Date().toISOString(),
  });
});

// ⭐ Socket.IO connection handler
io.on('connection', socket => {
  console.log('✅ New client connected:', socket.id);
  socket.emit('me', socket.id);

  socket.on('disconnect', (reason) => {
    console.log(`🔌 Client disconnected: ${socket.id}, Reason: ${reason}`);
    
    const roomId = socket.roomId;
    if (roomId) {
      console.log(`${socket.name} (${socket.id}) disconnected from ${roomId}`);
      socket.to(roomId).emit('userLeft', socket.id);
      
      const clientsInRoom = io.sockets.adapter.rooms.get(roomId);
      // Xóa lịch sử nếu không còn ai trong room
      if (!clientsInRoom || clientsInRoom.size === 0) {
        console.log(`🗑️ Room ${roomId} is empty, cleaning up chat history`);
        delete chatHistory[roomId];
      }
    }
    
    socket.isSharing = false;
    
    // Clean up recorder if this socket was recording
    for (const [roomId, recorderId] of Object.entries(recorders)) {
      if (recorderId === socket.id) {
        delete recorders[roomId];
        io.to(roomId).emit('recordStopped', { userId: socket.id });
      }
    }
  });

  socket.on('chatMessage', ({ roomId, sender, message }) => {
    const chatMsg = {
      sender,
      message,
      timestamp: new Date().toISOString(),
      userId: socket.id,
    };

    // Lưu vào lịch sử
    if (!chatHistory[roomId]) {
      chatHistory[roomId] = [];
    }
    chatHistory[roomId].push(chatMsg);

    // Giới hạn số lượng
    const MAX_MESSAGES = 100;
    if (chatHistory[roomId].length > MAX_MESSAGES) {
      chatHistory[roomId] = chatHistory[roomId].slice(-MAX_MESSAGES);
    }

    // Broadcast đến tất cả
    io.to(roomId).emit('chatMessage', chatMsg);
  });

  socket.on('requestChatHistory', roomId => {
    const history = chatHistory[roomId] || [];
    socket.emit('chatHistory', history);
    console.log(`✅ Sent ${history.length} messages to ${socket.id}`);
  });

  socket.on('joinRoom', ({ roomId, name }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.name = name || 'Anonymous';

    console.log(`👤 ${name} (${socket.id}) joined ${roomId}`);

    const clientsInRoom = io.sockets.adapter.rooms.get(roomId);

    const usersInRoom = [];
    const usersSharing = [];

    if (clientsInRoom) {
      for (const clientId of clientsInRoom) {
        const clientSocket = io.sockets.sockets.get(clientId);

        if (clientId !== socket.id) {
          usersInRoom.push({
            id: clientId,
            name: clientSocket?.name || 'Anonymous',
          });
        }

        if (clientSocket && clientSocket.isSharing) {
          usersSharing.push(clientId);
        }
      }
    }

    socket.emit('allUsers', { usersInRoom, usersSharing });

    // Thông báo cho những người cũ trong phòng biết có user mới
    socket.to(roomId).emit('userJoined', {
      id: socket.id,
      name: socket.name,
    });
  });

  socket.on('signal', data => {
    const targetId = data.targetId;
    if (targetId) {
      io.to(targetId).emit('signal', {
        from: socket.id,
        signal: data.signal,
      });
    }
  });

  socket.on('requestScreenTrack', ({ targetId }) => {
    console.log(`📺 ${socket.id} requesting screen track from ${targetId}`);
    io.to(targetId).emit('requestScreenTrack', {
      requesterId: socket.id,
    });
  });

  socket.on('screenShareStatus', ({ roomId, isSharing }) => {
    console.log(
      `🖥️ ${socket.name} (${socket.id}) ${isSharing ? 'started' : 'stopped'} screen sharing`
    );

    socket.isSharing = isSharing;

    io.in(roomId).emit('peerScreenShareStatus', {
      userId: socket.id,
      isSharing: isSharing,
    });
  });

  socket.on('requestStartRecord', (roomId, callback) => {
    if (recorders[roomId]) {
      callback({ success: false, message: 'Someone is already recording.' });
      return;
    }
    recorders[roomId] = socket.id;
    io.to(roomId).emit('recordStarted', { userId: socket.id });
    callback({ success: true });
  });

  socket.on('requestStopRecord', roomId => {
    if (recorders[roomId] === socket.id) {
      delete recorders[roomId];
      io.to(roomId).emit('recordStopped', { userId: socket.id });
    }
  });

  socket.on('leaveRoom', () => {
    const roomId = socket.roomId;
    if (roomId) {
      console.log(`👋 ${socket.name} (${socket.id}) left ${roomId}`);
      socket.leave(roomId);
      socket.to(roomId).emit('userLeft', socket.id);
      socket.roomId = null;
    }
  });
});

// ⭐ CRITICAL: Error handling
io.engine.on('connection_error', (err) => {
  console.error('❌ Connection error:', err.req?.url, err.message);
});

const PORT = process.env.PORT || 5000;

// ⭐ CRITICAL: Listen on 0.0.0.0 for Railway
server.listen(PORT, '0.0.0.0', () => {
  console.log('═══════════════════════════════════════════════════');
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 CORS enabled for:`);
  console.log(`   - https://collabsphere.space`);
  console.log(`   - https://www.collabsphere.space`);
  console.log(`   - ${process.env.FRONTEND_URL || 'localhost (dev)'}`);
  console.log(`📡 Socket.IO transports: websocket, polling`);
  console.log(`⏱️  Ping timeout: 60s, interval: 25s`);
  console.log(`🔒 Credentials: enabled`);
  console.log('═══════════════════════════════════════════════════');
});

// ⭐ Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, closing server gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, closing server gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});