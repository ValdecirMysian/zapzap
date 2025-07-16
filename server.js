// server.js - Servidor principal
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const session = require('express-session');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
require('dotenv').config();

// Importar módulos locais
const { db, createTables } = require('./database');
const winston = require('winston');

// Configurar sistema de logs estruturados
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'whatsapp-bot' },
  transports: [
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: 'logs/combined.log',
      maxsize: 5242880, // 5MB  
      maxFiles: 5
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ],
});

// Middleware de log para requests
const logRequests = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info('HTTP Request', {
      method: req.method,
      url: req.url,
      status: res.statusCode,
      duration: `${duration}ms`,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
      userId: req.session?.user?.id
    });
  });
  
  next();
};

const NodeCache = require('node-cache');

// Cache para otimizar consultas frequentes
const cache = {
  contacts: new NodeCache({ stdTTL: 300 }), // 5 minutos
  sessions: new NodeCache({ stdTTL: 600 }), // 10 minutos
  stats: new NodeCache({ stdTTL: 180 })     // 3 minutos
};

const MonitoringService = require('./monitoring');

const BackupService = require('./backup');

const WhatsAppService = require('./whatsapp');

const { 
  authMiddleware, 
  generateToken, 
  verifyToken,
  validationHelpers,
  uploadHelpers,
  messageHelpers,
  sectorHelpers,
  reportHelpers
} = require('./auth');

// Função para converter áudio para formato compatível
const convertAudioToOgg = async (inputPath) => {
  try {
    const ffmpeg = require('fluent-ffmpeg');
    const outputPath = inputPath.replace(/\.[^/.]+$/, '_ptt.ogg');
    
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .audioCodec('libopus')
        .audioFrequency(16000)
        .audioChannels(1)
        .audioBitrate('16k')  // Reduzido para PTT
        .audioQuality(10)
        .toFormat('ogg')
        .on('end', () => {
          console.log('✅ Conversão de áudio PTT concluída');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.log('❌ Erro na conversão:', err.message);
          resolve(null); // Retorna null em vez de rejeitar
        })
        .save(outputPath);
    });
  } catch (error) {
    console.log('❌ Erro ao configurar conversão:', error.message);
    return null;
  }
};

// Criar aplicação Express
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Configurar WhatsApp Service (será inicializado depois)
let whatsappService;

// Tornar io global para acesso em outros módulos
global.io = io;

// Configuração do Multer para uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, uploadHelpers.generateFileName(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: parseInt(process.env.MAX_FILE_SIZE || 100) * 1024 * 1024 }, // Aumentado para 100MB
  fileFilter: (req, file, cb) => {
    // Permitir todos os tipos de áudio para PTT
    if (file.mimetype.startsWith('audio/') || uploadHelpers.isValidFileType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido: ' + file.mimetype));
    }
  }
});

// Middleware de erro para Multer
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Arquivo muito grande! Limite: ' + process.env.MAX_FILE_SIZE + 'MB' });
    }
  }
  next(error);
});

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logRequests); 
// Adicionar APÓS a linha app.use('/uploads', express.static('uploads'));
app.use('/uploads', express.static('uploads'));

// Middleware para servir áudios com headers corretos
app.use('/uploads', (req, res, next) => {
  if (req.path.match(/\.(ogg|mp3|wav|webm|m4a)$/i)) {
    res.set({
      'Content-Type': 'audio/ogg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600'
    });
  }
  next();
});
app.use(express.static('public'));

// Configurar sessão - VERSÃO MELHORADA
app.use(session({
  secret: process.env.SESSION_SECRET || 'whatsapp-bot-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  name: 'whatsapp.sid', // Nome customizado do cookie
  cookie: {
    secure: false, // true em produção com HTTPS
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 dias
    sameSite: 'lax' // Proteção CSRF
  },
  // CORREÇÃO: Adicionar verificação de integridade da sessão
  genid: function(req) {
    return require('crypto').randomBytes(16).toString('hex');
  }
}));

// ADICIONAR: Middleware para verificar integridade da sessão
app.use((req, res, next) => {
  // Verificar se a sessão tem dados corrompidos
  if (req.session && typeof req.session.user === 'object' && req.session.user !== null) {
    // Sessão válida
    next();
  } else if (req.session && req.session.user === undefined) {
    // Sessão existe mas usuário foi perdido - regenerar
    req.session.regenerate((err) => {
      if (err) {
        console.error('Erro ao regenerar sessão:', err);
      }
      next();
    });
  } else {
    next();
  }
});

// Configurar EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ===========================================
// ROTAS PÚBLICAS
// ===========================================

// Página inicial - redireciona
app.get('/', (req, res) => {
  if (req.session.user) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// Página de login
app.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }
  res.render('login', { error: null });
});

// Processar login - VERSÃO COM DEBUG
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validar entrada
    if (!email || !password) {
      return res.render('login', { error: 'Email e senha são obrigatórios' });
    }

    // Buscar usuário
    const user = await db.users.findByEmail(email);
    if (!user) {
      return res.render('login', { error: 'Email ou senha incorretos' });
    }

    // Verificar senha
    const bcrypt = require('bcryptjs');
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.render('login', { error: 'Email ou senha incorretos' });
    }

    // Verificar se está ativo
    if (!user.is_active) {
      return res.render('login', { error: 'Usuário inativo' });
    }

    // Criar sessão - VERSÃO SIMPLIFICADA
    const token = generateToken(user);
    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sector: user.sector,
      signature: user.signature
    };
    req.session.token = token;
    req.session.loginTime = new Date();

    // DEBUG: Confirmar criação da sessão
    console.log('✅ Login realizado:', {
      userId: user.id,
      userName: user.name,
      sessionId: req.sessionID,
      hasSession: !!req.session.user,
      sessionData: req.session.user
    });

    // Forçar salvar sessão antes de redirecionar
    req.session.save((err) => {
      if (err) {
        console.error('❌ Erro ao salvar sessão:', err);
        return res.render('login', { error: 'Erro ao criar sessão' });
      }
      
      console.log('✅ Sessão salva com sucesso - Redirecionando...');
      res.redirect('/dashboard');
    });
  } catch (error) {
      logger.error('Erro no login', { 
        error: error.message, 
        email: req.body.email,
        ip: req.ip,
        userAgent: req.get('User-Agent')
      });
      res.render('login', { error: 'Erro ao fazer login' });
    }
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ===========================================
// MIDDLEWARE DE AUTENTICAÇÃO PARA ROTAS PROTEGIDAS - CORRIGIDO
// ===========================================

app.use((req, res, next) => {
  // Rotas públicas (não precisam de autenticação)
  const publicPaths = [
    '/login', 
    '/api/public', 
    '/socket.io',
    '/uploads',
    '/style.css',
    '/app.js',
    '/logo.png',
    '/favicon.ico'
  ];
  
  // Verificar se é rota pública
  const isPublicPath = publicPaths.some(path => req.path.startsWith(path));
  if (isPublicPath) {
    return next();
  }
  
  // CORREÇÃO: Verificar autenticação com debug melhorado e validação
  if (!req.session || !req.session.user || !req.session.user.id) {
    console.log('🔐 DEBUG - Acesso negado para:', req.path);
    console.log('🔐 DEBUG - Session exists:', !!req.session);
    console.log('🔐 DEBUG - Session ID:', req.sessionID);
    console.log('🔐 DEBUG - User in session:', !!req.session?.user);
    console.log('🔐 DEBUG - User ID exists:', !!req.session?.user?.id);
    
    // Verificar se sessão expirou
    if (req.session && req.session.loginTime) {
      const sessionAge = Date.now() - new Date(req.session.loginTime).getTime();
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 dias
      
      if (sessionAge > maxAge) {
        console.log('🔐 DEBUG - Sessão expirada, destruindo...');
        req.session.destroy();
      }
    }
    
    if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
      return res.status(401).json({ 
        error: 'Sessão expirada. Faça login novamente.',
        debug: {
          hasSession: !!req.session,
          hasUser: !!req.session?.user,
          sessionId: req.sessionID
        }
      });
    }
    return res.redirect('/login');
  }
  
  // DEBUG: Log de sessão válida
  console.log('✅ Acesso autorizado para:', req.path, '- Usuário:', req.session.user.name);
  
  next();
});

// ===========================================
// ROTAS PROTEGIDAS - PÁGINAS
// ===========================================

// Dashboard
app.get('/dashboard', async (req, res) => {
  try {
    const stats = await db.queues.getStats(req.session.user.sector);
    const sessions = await db.sessions.list();
    
    res.render('dashboard', {
      user: req.session.user,
      stats,
      sessions,
      sectors: sectorHelpers.getSectors()
    });
  } catch (error) {
    console.error('Erro ao carregar dashboard:', error);
    res.status(500).send('Erro ao carregar dashboard');
  }
});

// ===========================================
// ROTAS API - SESSÕES WHATSAPP
// ===========================================

// Listar sessões
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await db.sessions.list();
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar sessões' });
  }
});

// Rota para testar reconexão - ADICIONAR no server.js
app.post('/api/sessions/test-reconnect', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    
    console.log('🧪 Testando reconexão...');
    
    if (whatsappService && whatsappService.forceReconnectAllSessions) {
      await whatsappService.forceReconnectAllSessions();
      
      res.json({
        success: true,
        message: 'Teste de reconexão executado! Verifique os logs do console.'
      });
    } else {
      res.status(500).json({ error: 'WhatsApp Service não disponível' });
    }
    
  } catch (error) {
    console.error('Erro no teste de reconexão:', error);
    res.status(500).json({ error: error.message });
  }
});

// Criar nova sessão
app.post('/api/sessions', async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Nome da sessão é obrigatório' });
    }

    // Verificar limite de sessões
    const sessions = await db.sessions.list();
    if (sessions.length >= parseInt(process.env.MAX_SESSIONS || 5)) {
      return res.status(400).json({ error: 'Limite de sessões atingido' });
    }

    // Criar sessão no banco
    const sessionId = await db.sessions.create(name);
    
    // Iniciar WhatsApp
    whatsappService.createSession(sessionId, name);
    
    res.json({ success: true, sessionId });
  } catch (error) {
    console.error('Erro ao criar sessão:', error);
    res.status(500).json({ error: 'Erro ao criar sessão' });
  }
});

// Desconectar sessão
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    await whatsappService.disconnectSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao desconectar sessão' });
  }
});

// Excluir sessão definitivamente
app.delete('/api/sessions/:id/delete', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    
    console.log(`🗑️ Tentando excluir sessão ID: ${sessionId}`);
    
    // Validar ID da sessão
    if (isNaN(sessionId) || sessionId <= 0) {
      return res.status(400).json({ error: 'ID da sessão inválido' });
    }
    
    // Buscar informações da sessão antes de excluir
    let sessionInfo = null;
    try {
      const sessionData = await db.query('SELECT * FROM sessions WHERE id = ?', [sessionId]);
      sessionInfo = sessionData.length > 0 ? sessionData[0] : null;
      
      if (!sessionInfo) {
        return res.status(404).json({ error: 'Sessão não encontrada' });
      }
      
      console.log(`🗑️ Sessão encontrada: ${sessionInfo.name}`);
    } catch (dbError) {
      console.error('Erro ao buscar sessão:', dbError);
      return res.status(500).json({ error: 'Erro ao buscar sessão no banco de dados' });
    }
    
    // Desconectar se estiver conectada
    try {
      if (whatsappService && whatsappService.isSessionActive(sessionId)) {
        console.log(`🔌 Desconectando sessão ativa: ${sessionInfo.name}`);
        await whatsappService.disconnectSession(sessionId);
        
        // Aguardar um pouco para garantir desconexão completa
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } catch (disconnectError) {
      console.error('Erro ao desconectar sessão:', disconnectError);
      // Continuar mesmo com erro na desconexão
    }
    
    // Limpar recursos físicos da sessão
    try {
      if (whatsappService && whatsappService.cleanupSessionResources) {
        console.log(`🧹 Limpando recursos da sessão: ${sessionInfo.name}`);
        await whatsappService.cleanupSessionResources(sessionId, sessionInfo.name);
      }
    } catch (cleanupError) {
      console.error('Erro na limpeza de recursos:', cleanupError);
      // Continuar mesmo com erro na limpeza
    }
    
    // Remover registros relacionados do banco (em ordem)
    try {
      console.log(`🗑️ Removendo dados relacionados da sessão ${sessionId}...`);
      
      // 1. Remover mensagens da sessão (só se a coluna session_id existir)
      try {
        await db.query('DELETE FROM messages WHERE session_id = ?', [sessionId]);
        console.log(`✅ Mensagens da sessão ${sessionId} removidas`);
      } catch (messagesError) {
        if (messagesError.code === 'ER_BAD_FIELD_ERROR') {
          console.log(`ℹ️ Coluna session_id não existe na tabela messages, pulando...`);
        } else {
          console.error('Erro ao remover mensagens:', messagesError);
        }
      }
      
      // 2. NÃO tentar finalizar filas - tabela queues não tem session_id
      console.log(`ℹ️ Pulando atualização de filas (sem coluna session_id)`);
      
      // 3. NÃO tentar remover session_numbers - tabela pode não existir
      console.log(`ℹ️ Pulando remoção de números da sessão`);
      
      // 4. Remover apenas a sessão principal
      const deleteResult = await db.query('DELETE FROM sessions WHERE id = ?', [sessionId]);
      
      if (deleteResult.affectedRows === 0) {
        return res.status(404).json({ error: 'Sessão não encontrada para exclusão' });
      }
      
      console.log(`✅ Sessão ${sessionId} (${sessionInfo.name}) excluída com sucesso`);
      
      if (deleteResult.affectedRows === 0) {
        return res.status(404).json({ error: 'Sessão não encontrada para exclusão' });
      }
      
      console.log(`✅ Sessão ${sessionId} (${sessionInfo.name}) excluída com sucesso`);
      
    } catch (dbDeleteError) {
      console.error('Erro ao excluir do banco:', dbDeleteError);
      return res.status(500).json({ 
        error: 'Erro ao excluir sessão do banco de dados',
        details: dbDeleteError.message 
      });
    }

    // Gerenciar tokens salvos
app.get('/api/sessions/tokens', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem ver tokens' });
    }
    
    const fs = require('fs');
    const path = require('path');
    const tokensDir = path.resolve('./tokens');
    const tokens = [];
    
    if (fs.existsSync(tokensDir)) {
      const tokenFolders = fs.readdirSync(tokensDir).filter(item => {
        const itemPath = path.join(tokensDir, item);
        return fs.statSync(itemPath).isDirectory();
      });
      
      for (const folder of tokenFolders) {
        const folderPath = path.join(tokensDir, folder);
        const files = fs.readdirSync(folderPath);
        
        const hasWAFiles = files.some(f => f.includes('WA-') || f.includes('session'));
        const hasSessionData = files.some(f => f.includes('session'));
        
        // Buscar sessão correspondente no banco
        const dbSession = await db.query('SELECT * FROM sessions WHERE name = ?', [folder]);
        
        tokens.push({
          name: folder,
          files: files.length,
          hasWAFiles,
          hasSessionData,
          dbSession: dbSession.length > 0 ? dbSession[0] : null,
          size: this.getFolderSize(folderPath),
          lastModified: fs.statSync(folderPath).mtime
        });
      }
    }
    
    res.json({
      tokensDir,
      tokens,
      total: tokens.length
    });
    
  } catch (error) {
    console.error('Erro ao listar tokens:', error);
    res.status(500).json({ error: 'Erro ao listar tokens' });
  }
});

// Limpar token específico
app.delete('/api/sessions/:id/token', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem limpar tokens' });
    }
    
    const sessionId = parseInt(req.params.id);
    const session = await db.sessions.findById(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    const fs = require('fs');
    const path = require('path');
    
    // Desconectar sessão se estiver ativa
    if (whatsappService.isSessionActive(sessionId)) {
      await whatsappService.disconnectSession(sessionId);
    }
    
    // Remover token
    const tokenPath = path.resolve(`./tokens/${session.name}`);
    const browserPath = path.resolve(`./browser-data/${session.name}`);
    
    if (fs.existsSync(tokenPath)) {
      fs.rmSync(tokenPath, { recursive: true, force: true });
      console.log(`🗑️ Token removido: ${tokenPath}`);
    }
    
    if (fs.existsSync(browserPath)) {
      fs.rmSync(browserPath, { recursive: true, force: true });
      console.log(`🗑️ Dados do browser removidos: ${browserPath}`);
    }
    
    // Atualizar status no banco
    await db.sessions.update(sessionId, {
      status: 'disconnected',
      qrcode: null
    });
    
    res.json({
      success: true,
      message: `Token da sessão "${session.name}" removido com sucesso`
    });
    
  } catch (error) {
    console.error('Erro ao limpar token:', error);
    res.status(500).json({ error: 'Erro ao limpar token' });
  }
});
    
    // Notificar via socket sobre a exclusão
    try {
      if (global.io) {
        global.io.emit('session:deleted', { 
          sessionId, 
          sessionName: sessionInfo.name 
        });
      }
    } catch (socketError) {
      console.error('Erro ao notificar via socket:', socketError);
      // Não falhar por causa do socket
    }
    
    res.json({ 
      success: true, 
      message: `Sessão "${sessionInfo.name}" excluída com sucesso`,
      sessionId: sessionId
    });
    
  } catch (error) {
    console.error('❌ Erro geral ao excluir sessão:', error);
    console.error('❌ Stack trace:', error.stack);
    
    res.status(500).json({ 
      error: 'Erro interno ao excluir sessão',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Erro interno do servidor'
    });
  }
});

// Importar contatos do WhatsApp
app.post('/api/contacts/import-from-whatsapp', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'ID da sessão é obrigatório' });
    }
    
    // Verificar se sessão está ativa
    if (!whatsappService.isSessionActive(sessionId)) {
      return res.status(400).json({ error: 'Sessão WhatsApp não está ativa' });
    }
    
    const client = whatsappService.getClient(sessionId);
    if (!client) {
      return res.status(400).json({ error: 'Cliente WhatsApp não encontrado' });
    }
    
    console.log('📞 Iniciando importação de contatos do WhatsApp...');
    console.log(`🔍 Sessão ${sessionId} ativa: ${whatsappService.isSessionActive(sessionId)}`);
    
    // Buscar todos os contatos do WhatsApp
    const whatsappContacts = await client.getAllContacts();
    console.log(`📋 Total de contatos encontrados no WhatsApp: ${whatsappContacts.length}`);
    
    let imported = 0;
    let updated = 0;
    let errors = 0;
    
    for (let i = 0; i < whatsappContacts.length; i++) {
      const contact = whatsappContacts[i];
      
      // Log detalhado dos primeiros 5 contatos para debug
      if (i < 5) {
        console.log(`\n🔍 DEBUG CONTATO ${i + 1}:`, {
          hasContact: !!contact,
          type: typeof contact,
          keys: contact ? Object.keys(contact) : [],
          id: contact?.id,
          number: contact?.number,
          name: contact?.name,
          pushname: contact?.pushname,
          isGroup: contact?.isGroup,
          profilePicThumbObj: contact?.profilePicThumbObj ? {
            hasEurl: !!contact.profilePicThumbObj.eurl,
            hasImg: !!contact.profilePicThumbObj.img,
            eurl: contact.profilePicThumbObj.eurl?.substring(0, 80) + '...',
            imgLength: contact.profilePicThumbObj.img ? contact.profilePicThumbObj.img.length : 0
          } : 'não disponível',
          raw: JSON.stringify(contact).substring(0, 200) + '...'
        });
      }
      
      try {
        // CORREÇÃO PRINCIPAL: Validar estrutura do contato
        if (!contact || typeof contact !== 'object') {
          if (i < 10) console.log(`❌ Contato ${i + 1}: inválido (não é objeto)`);
          errors++;
          continue;
        }
        
        // CORREÇÃO: Extrair ID corretamente do objeto
        let contactId = null;
        
        // Método 1: Se contact.id é objeto, usar _serialized
        if (contact.id && typeof contact.id === 'object' && contact.id._serialized) {
          contactId = contact.id._serialized;
        }
        // Método 2: Se contact.id é string diretamente
        else if (contact.id && typeof contact.id === 'string') {
          contactId = contact.id;
        }
        // Método 3: Fallback para number
        else if (contact.number) {
          contactId = contact.number;
        }
        // Método 4: Fallback para _serialized direto
        else if (contact._serialized) {
          contactId = contact._serialized;
        }
        
        if (!contactId) {
          if (i < 10) console.log(`❌ Contato ${i + 1}: sem ID válido`);
          errors++;
          continue;
        }
        
        // CORREÇÃO: Agora contactId já é string válida
        contactId = String(contactId);
        
        // Log dos filtros aplicados (primeiros 10)
        if (i < 10) {
          console.log(`🔍 Contato ${i + 1} - Filtros:`, {
            contactId: contactId,
            isGroup: contact.isGroup,
            hasGUs: contactId.includes('@g.us'),
            hasBroadcast: contactId.includes('@broadcast'),
            hasStatus: contactId.includes('status@broadcast'),
            hasCUs: contactId.includes('@c.us')
          });
        }
        
        // FILTROS OTIMIZADOS: Aplicar todos de uma vez
        const isGroup = contact.isGroup === true;
        const isGroupAddress = contactId.includes('@g.us');
        const isBroadcast = contactId.includes('@broadcast') || contactId.includes('status@broadcast');
        const isLid = contactId.includes('@lid'); // LinkedIn/Meta contatos
        const isValidContact = contactId.includes('@c.us');
        
        // Log detalhado apenas para os primeiros 10
        if (i < 10) {
          console.log(`🔍 Contato ${i + 1} - Filtros:`, {
            contactId: contactId,
            isGroup,
            isGroupAddress,
            isBroadcast,
            isLid,
            isValidContact
          });
        }
        
        // Aplicar filtros
        if (isGroup) {
          if (i < 10) console.log(`🚫 Contato ${i + 1}: é grupo`);
          continue;
        }
        
        if (isGroupAddress) {
          if (i < 10) console.log(`🚫 Contato ${i + 1}: endereço de grupo`);
          continue;
        }
        
        if (isBroadcast) {
          if (i < 10) console.log(`🚫 Contato ${i + 1}: é broadcast/status`);
          continue;
        }
        
        if (isLid) {
          if (i < 10) console.log(`🚫 Contato ${i + 1}: é contato LinkedIn/Meta (@lid)`);
          continue;
        }
        
        if (!isValidContact) {
          if (i < 10) console.log(`🚫 Contato ${i + 1}: não é contato WhatsApp individual (@c.us)`);
          continue;
        }
        
        // Se chegou até aqui, é um contato válido
        if (i < 10) console.log(`✅ Contato ${i + 1}: VÁLIDO para importação`);
        
        // Validar nome do contato
        let contactName = contact.name || contact.pushname || contact.formattedName;
        if (!contactName) {
          contactName = contactId.split('@')[0]; // Usar número como fallback
        }
        
        // Sanitizar nome (remover caracteres especiais)
        contactName = String(contactName).trim().substring(0, 100);
        
        if (i < 10) {
          console.log(`👤 Contato ${i + 1}: Nome final = "${contactName}"`);
        }
        
        // Verificar se contato já existe
        const existingContact = await db.query(
          'SELECT id FROM contacts WHERE number = ?', 
          [contactId]
        );
        
        if (existingContact.length > 0) {
          // Atualizar contato existente
          const updateData = {
            name: contactName
          };
          
          // CORREÇÃO: Buscar avatar de múltiplas formas
          let avatarUrl = null;
          
          // Método 1: profilePicThumbObj (mais comum)
          if (contact.profilePicThumbObj && contact.profilePicThumbObj.eurl) {
            avatarUrl = contact.profilePicThumbObj.eurl;
          }
          // Método 2: profilePicThumbObj.img (base64)
          else if (contact.profilePicThumbObj && contact.profilePicThumbObj.img) {
            avatarUrl = `data:image/jpeg;base64,${contact.profilePicThumbObj.img}`;
          }
          // Método 3: Buscar via cliente (mais demorado, só para contatos importantes)
          else if (imported + updated < 100) { // Apenas primeiros 100 para não atrasar
            try {
              const client = whatsappService.getClient(sessionId);
              if (client) {
                const profilePic = await client.getProfilePicFromServer(contactId);
                if (profilePic && profilePic.startsWith('http')) {
                  avatarUrl = profilePic;
                }
              }
            } catch (avatarError) {
              // Silencioso - não é crítico
            }
          }
          
          if (avatarUrl) {
            updateData.avatar = avatarUrl;
            updateData.avatar_updated_at = new Date();
            if (i < 10) console.log(`📸 Avatar encontrado para ${contactName}`);
          }
          
          await db.contacts.update(existingContact[0].id, updateData);
          updated++;
          
          if (i < 10) {
            console.log(`🔄 Contato ${i + 1}: ATUALIZADO (ID: ${existingContact[0].id})`);
          }
        } else {
          // Criar novo contato
          const newContact = await db.contacts.findOrCreate(contactId, contactName);
          
          // CORREÇÃO: Buscar avatar de múltiplas formas
          let avatarUrl = null;
          
          // Método 1: profilePicThumbObj (mais comum)
          if (contact.profilePicThumbObj && contact.profilePicThumbObj.eurl) {
            avatarUrl = contact.profilePicThumbObj.eurl;
          }
          // Método 2: profilePicThumbObj.img (base64)
          else if (contact.profilePicThumbObj && contact.profilePicThumbObj.img) {
            avatarUrl = `data:image/jpeg;base64,${contact.profilePicThumbObj.img}`;
          }
          // Método 3: Buscar via cliente (mais demorado, só para contatos importantes)
          else if (imported + updated < 100) { // Apenas primeiros 100 para não atrasar
            try {
              const client = whatsappService.getClient(sessionId);
              if (client) {
                const profilePic = await client.getProfilePicFromServer(contactId);
                if (profilePic && profilePic.startsWith('http')) {
                  avatarUrl = profilePic;
                }
              }
            } catch (avatarError) {
              // Silencioso - não é crítico
            }
          }
          
          if (avatarUrl) {
            await db.contacts.update(newContact.id, {
              avatar: avatarUrl,
              avatar_updated_at: new Date()
            });
            if (i < 10) console.log(`📸 Avatar salvo para ${contactName}`);
          }
          
          imported++;
          
          if (i < 10) {
            console.log(`➕ Contato ${i + 1}: CRIADO (ID: ${newContact.id})`);
          }
        }
        
        // Log de progresso a cada 50 contatos válidos processados
        if ((imported + updated) > 0 && (imported + updated) % 50 === 0) {
          console.log(`📊 Progresso: ${i + 1}/${whatsappContacts.length} - Importados: ${imported}, Atualizados: ${updated}, Erros: ${errors}`);
        }
        
        // Delay reduzido para acelerar importação
        if (i % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
      } catch (contactError) {
        console.error(`❌ Erro ao processar contato ${i + 1}:`, contactError.message);
        if (i < 10) {
          console.error(`❌ Dados do contato problemático:`, contact);
        }
        errors++;
      }
    }
    
    console.log(`✅ Importação concluída: ${imported} novos, ${updated} atualizados, ${errors} erros`);
    
    res.json({
      success: true,
      imported,
      updated,
      errors,
      total: whatsappContacts.length,
      message: `Importação concluída! ${imported} novos contatos, ${updated} atualizados.`
    });
    
  } catch (error) {
    console.error('❌ Erro na importação de contatos:', error);
    res.status(500).json({ 
      error: 'Erro ao importar contatos do WhatsApp',
      details: error.message 
    });
  }
});

// Baixar avatares em lote para contatos existentes
app.post('/api/contacts/download-avatars', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem executar esta ação' });
    }
    
    const { sessionId, limit = 50 } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'ID da sessão é obrigatório' });
    }
    
    if (!whatsappService.isSessionActive(sessionId)) {
      return res.status(400).json({ error: 'Sessão WhatsApp não ativa' });
    }
    
    const client = whatsappService.getClient(sessionId);
    if (!client) {
      return res.status(400).json({ error: 'Cliente WhatsApp não encontrado' });
    }
    
    // Buscar contatos sem avatar
    const contacts = await db.query(`
      SELECT id, number, name 
      FROM contacts 
      WHERE (avatar IS NULL OR avatar = '') 
        AND number LIKE '%@c.us' 
        AND number != 'status@broadcast'
      ORDER BY last_message_at DESC
      LIMIT ?
    `, [limit]);
    
    let success = 0;
    let errors = 0;
    let skipped = 0;
    
    console.log(`📸 Iniciando download de avatares para ${contacts.length} contatos...`);
    
    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];
      
      try {
        console.log(`🔍 Buscando avatar ${i + 1}/${contacts.length}: ${contact.name || contact.number}`);
        
        const avatarUrl = await client.getProfilePicFromServer(contact.number);
        
        if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.startsWith('http')) {
          await db.contacts.update(contact.id, {
            avatar: avatarUrl,
            avatar_updated_at: new Date()
          });
          success++;
          console.log(`✅ Avatar baixado: ${contact.name || contact.number}`);
          
          // Notificar frontend em tempo real
          global.io.emit('contact:update', {
            id: contact.id,
            avatar: avatarUrl
          });
        } else {
          skipped++;
          if (i < 10) console.log(`📷 Sem avatar disponível: ${contact.name || contact.number}`);
        }
        
        // Delay para não sobrecarregar o WhatsApp
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.error(`❌ Erro avatar ${contact.name || contact.number}:`, error.message);
        errors++;
      }
    }
    
    console.log(`✅ Download de avatares concluído: ${success} baixados, ${skipped} sem foto, ${errors} erros`);
    
    res.json({
      success: true,
      message: `Download concluído: ${success} avatares baixados, ${skipped} sem foto, ${errors} erros`,
      avatarsDownloaded: success,
      skipped,
      errors
    });
    
  } catch (error) {
    console.error('Erro no download de avatares:', error);
    res.status(500).json({ 
      error: 'Erro interno',
      details: error.message 
    });
  }
});

// Verificar saúde das sessões
app.get('/api/sessions/health', async (req, res) => {
  try {
    const sessions = await db.sessions.list();
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: {
        total: sessions.length,
        connected: sessions.filter(s => s.status === 'connected').length,
        connecting: sessions.filter(s => s.status === 'connecting').length,
        disconnected: sessions.filter(s => s.status === 'disconnected').length
      },
      memory: {
        total: sessions.length,
        active: 0
      },
      inconsistencies: []
    };
    
    // Verificar sessões ativas na memória
    for (const session of sessions) {
      const isActive = whatsappService && whatsappService.isSessionActive ? whatsappService.isSessionActive(session.id) : false;
      if (isActive) {
        health.memory.active++;
      }
      
      // Detectar inconsistências
      if (session.status === 'connected' && !isActive) {
        health.inconsistencies.push({
          name: session.name,
          issue: 'connected_in_db_but_not_in_memory'
        });
      } else if (session.status === 'disconnected' && isActive) {
        health.inconsistencies.push({
          name: session.name,
          issue: 'active_in_memory_but_disconnected_in_db'
        });
      }
    }
    
    // Definir status geral baseado nas inconsistências
    if (health.inconsistencies.length > 0) {
      health.status = 'warning';
    } else if (health.memory.active === 0) {
      health.status = 'error';
    } else {
      health.status = 'healthy';
    }
    
    res.json(health);
  } catch (error) {
    console.error('Erro ao verificar saúde das sessões:', error);
    res.status(500).json({ 
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Erro interno',
      database: { total: 0, connected: 0, connecting: 0, disconnected: 0 },
      memory: { total: 0, active: 0 },
      inconsistencies: []
    });
  }
});

// Forçar sincronização das sessões
app.post('/api/sessions/force-sync', async (req, res) => {
  try {
    const sessions = await db.sessions.list();
    let synced = 0;
    let errors = 0;
    
    for (const session of sessions) {
      try {
        const isActive = whatsappService && whatsappService.isSessionActive ? whatsappService.isSessionActive(session.id) : false;
        const correctStatus = isActive ? 'connected' : 'disconnected';
        
        if (session.status !== correctStatus) {
          await db.sessions.update(session.id, { status: correctStatus });
          synced++;
          console.log(`✅ Sessão ${session.name} sincronizada: ${session.status} → ${correctStatus}`);
        }
      } catch (sessionError) {
        console.error(`❌ Erro ao sincronizar sessão ${session.name}:`, sessionError);
        errors++;
      }
    }
    
    res.json({
      success: true,
      message: `Sincronização concluída: ${synced} sessões atualizadas, ${errors} erros`,
      synced,
      errors
    });
    
  } catch (error) {
    console.error('Erro na sincronização forçada:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro interno',
      synced: 0,
      errors: 1
    });
  }
});

// ===========================================
// ROTAS API - CONTATOS E CONVERSAS
// ===========================================

// Listar contatos/conversas
app.get('/api/contacts', async (req, res) => {
  try {
    let { sector, search, tag, view } = req.query;
    
    // DEBUG: Ver o que está chegando
    console.log('=== API CONTACTS ===');
    console.log('Filtros recebidos:', { sector, search, tag });
    console.log('Usuário logado:', req.session.user.name, '- Setor:', req.session.user.sector);
    
    // Se o filtro de setor estiver vazio ou for "Geral", mostrar todos
    if (!sector || sector === 'Geral' || sector === '') {
      sector = null; // Forçar null para mostrar todos
    }
    
    const contacts = await db.contacts.list({ sector, search, tag });
    
    console.log(`Contatos encontrados: ${contacts.length}`);
    
    // Otimizar: Buscar todas as informações em uma única query
    const contactIds = contacts.map(c => c.id);
    
    if (contactIds.length > 0) {
      // Query otimizada para buscar todas as filas de uma vez
      const queues = await db.query(`
        SELECT q.*, 
               u1.id as user_id, u1.name as user_name, u1.role as user_role,
               u2.id as assigned_user_id, u2.name as assigned_user_name, u2.role as assigned_user_role,
               q.transferred_at, q.transferred_by, q.transfer_reason
        FROM queues q
        LEFT JOIN users u1 ON q.user_id = u1.id
        LEFT JOIN users u2 ON q.assigned_user_id = u2.id
        WHERE q.contact_id IN (${contactIds.map(() => '?').join(',')}) 
        AND q.status IN ('waiting', 'attending')
        ORDER BY q.contact_id, q.id DESC
      `, contactIds);
      
      // Query otimizada para contar mensagens não lidas
      const unreadCounts = await db.query(`
        SELECT contact_id, COUNT(*) as count 
        FROM messages 
        WHERE contact_id IN (${contactIds.map(() => '?').join(',')}) 
        AND is_from_me = 0 AND status = 'received'
        GROUP BY contact_id
      `, contactIds);
      
      // Mapear resultados para os contatos
      const queueMap = new Map();
      const unreadMap = new Map();
      
      queues.forEach(queue => {
        if (!queueMap.has(queue.contact_id)) {
          queueMap.set(queue.contact_id, queue);
        }
      });
      
      unreadCounts.forEach(unread => {
        unreadMap.set(unread.contact_id, unread.count);
      });
      
      // Adicionar informações aos contatos
      contacts.forEach(contact => {
        const queue = queueMap.get(contact.id);
        contact.queue = queue || null;
        
        if (contact.queue) {
          // CORREÇÃO: Lógica melhorada para "Meus Atendimentos"
          contact.isAssignedToMe = 
            // Atendimento atualmente sendo feito por mim
            (contact.queue.user_id === req.session.user.id && contact.queue.status === 'attending') ||
            // Atendimento transferido para mim (aguardando eu pegar)
            (contact.queue.assigned_user_id === req.session.user.id && contact.queue.status === 'waiting') ||
            // Atendimento que peguei da fila geral do meu setor
            (contact.queue.user_id === req.session.user.id && contact.queue.status !== 'finished');
          
          if (queue.user_id || queue.assigned_user_id) {
            contact.assignedUser = {
              id: queue.assigned_user_id || queue.user_id,
              name: queue.user_name,
              role: queue.user_role
            };
          }
        } else {
          contact.isAssignedToMe = false;
        }
        
        contact.unread_count = unreadMap.get(contact.id) || 0;
      });
    }
    
    // Filtrar por visualização
    let filteredContacts = contacts;
    if (view === 'mine') {
      filteredContacts = contacts.filter(contact => contact.isAssignedToMe);
    }
    
    // Log apenas dos primeiros 5 para não poluir
    console.log('Contatos filtrados:', filteredContacts.slice(0, 5).map(c => ({
      id: c.id,
      name: c.name,
      sector: c.sector,
      queue: c.queue?.status,
      isAssignedToMe: c.isAssignedToMe
    })));
    
    res.json({
      contacts: filteredContacts,
      totalAll: contacts.length,
      totalMine: contacts.filter(c => c.isAssignedToMe).length
    });
  } catch (error) {
    console.error('Erro ao listar contatos:', error);
    res.status(500).json({ error: 'Erro ao listar contatos' });
  }
});

// Obter mensagens de um contato
app.get('/api/contacts/:id/messages', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    const messages = await db.messages.getByContact(contactId);
    res.json(messages.reverse()); // Ordem cronológica
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar mensagens' });
  }
});

// Marcar mensagens como lidas
app.post('/api/contacts/:id/read', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    
    // Marcar todas as mensagens do contato como lidas
    await db.query(
      'UPDATE messages SET status = ? WHERE contact_id = ? AND is_from_me = 0 AND status = ?',
      ['read', contactId, 'received']
    );
    
    // Zerar contador de não lidas
    await db.contacts.update(contactId, { unread_count: 0 });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao marcar como lida:', error);
    res.status(500).json({ error: 'Erro ao marcar mensagens como lidas' });
  }
});

// Apagar todas as mensagens de um contato
app.delete('/api/contacts/:id/messages', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    
    // Apagar todas as mensagens do contato
    await db.query('DELETE FROM messages WHERE contact_id = ?', [contactId]);
    
    // Limpar última mensagem do contato
    await db.contacts.update(contactId, {
      last_message: null,
      last_message_at: null,
      unread_count: 0
    });
    
    // Finalizar qualquer fila ativa
    await db.query(
      'UPDATE queues SET status = ?, finished_at = NOW() WHERE contact_id = ? AND status IN (?, ?)',
      ['finished', contactId, 'waiting', 'attending']
    );
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao apagar mensagens:', error);
    res.status(500).json({ error: 'Erro ao apagar conversa' });
  }
});

// TEMPORÁRIO: Re-baixar mídias sem URL
app.post('/api/fix-media', async (req, res) => {
  try {
    // Buscar mensagens de mídia sem URL
    const messages = await db.query(
      `SELECT m.*, c.number 
       FROM messages m 
       JOIN contacts c ON m.contact_id = c.id 
       WHERE m.type IN ('audio', 'image', 'video', 'document') 
       AND (m.media_url IS NULL OR m.media_url = '')
       ORDER BY m.created_at DESC 
       LIMIT 50`
    );
    
    res.json({
      found: messages.length,
      messages: messages.map(m => ({
        id: m.id,
        type: m.type,
        contact: m.number,
        date: m.created_at
      }))
    });
  } catch (error) {
    console.error('Erro ao buscar mídias:', error);
    res.status(500).json({ error: error.message });
  }
});

// ===========================================
// ROTAS API - ENVIO DE MENSAGENS
// ===========================================

// Enviar áudio gravado
app.post('/api/messages/send-audio', upload.single('audio'), async (req, res) => {
    try {
        const { sessionId, contactId, additionalText } = req.body;
    
    console.log('Enviando áudio:', { sessionId, contactId, hasFile: !!req.file });
    
    if (!req.file) {
      return res.status(400).json({ error: 'Arquivo de áudio não enviado' });
    }
    
    // Buscar contato
    const contact = await db.query('SELECT * FROM contacts WHERE id = ?', [contactId]);
    if (!contact.length) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }

    // Verificar se é um formato de áudio válido
    if (!req.file.mimetype.startsWith('audio/')) {
      return res.status(400).json({ error: 'Arquivo deve ser um áudio' });
    }

    console.log('🎵 Processando áudio recebido:', req.file.mimetype, 'Tamanho:', req.file.size);

    // CONVERSÃO OBRIGATÓRIA para MP3 usando FFmpeg
    let finalAudioPath = req.file.path;
    const path = require('path');
    const fs = require('fs');
    
    try {
      // Sempre converter para MP3 (formato mais compatível)
      const convertedPath = await convertAudioToMp3Server(req.file.path);
      if (convertedPath && fs.existsSync(convertedPath)) {
        finalAudioPath = convertedPath;
        console.log('✅ Áudio convertido para MP3:', convertedPath);
        
        // Remover arquivo original após conversão
        try {
          fs.unlinkSync(req.file.path);
        } catch (unlinkError) {
          console.log('⚠️ Erro ao remover arquivo original:', unlinkError.message);
        }
      } else {
        console.log('⚠️ Conversão falhou, usando arquivo original');
      }
    } catch (conversionError) {
      console.log('⚠️ Erro na conversão:', conversionError.message);
      // Continua com arquivo original se conversão falhar
    }
    
    // Verificar arquivo final
    const fileExists = fs.existsSync(finalAudioPath);
    const fileSize = fileExists ? fs.statSync(finalAudioPath).size : 0;
    
    console.log('📁 Arquivo final:', finalAudioPath);
    console.log('📁 Arquivo existe:', fileExists);
    console.log('📁 Tamanho do arquivo:', fileSize, 'bytes');
    
    if (!fileExists || fileSize === 0) {
      return res.status(400).json({ error: 'Arquivo de áudio inválido após processamento' });
    }

    try {
      // Preparar opções para áudio PTT
      const options = {
        type: 'audio',  // Manter como audio para usar a nova lógica PTT
        path: path.resolve(finalAudioPath),
        filename: 'voice.ogg',  // Nome fixo para PTT
        isPtt: true  // Flag para indicar que é PTT
      };

      console.log('📁 Arquivo para envio:', options.path);
      console.log('📁 Arquivo existe?', require('fs').existsSync(options.path));
      console.log('📁 Tamanho:', require('fs').statSync(options.path).size, 'bytes');

      // Enviar via WhatsApp
      const result = await whatsappService.sendMessage(
        parseInt(sessionId),
        contact[0].number,
        '', // Conteúdo vazio para áudio
        options
      );
      
      console.log('✅ Resultado do envio WhatsApp:', result);

      // Preparar conteúdo da mensagem
        let messageContent = '🎵 Mensagem de voz (PTT)';
        
        // Se há texto adicional (encaminhamento), adicionar
        if (additionalText && additionalText.trim()) {
            messageContent = `📤 *Áudio Encaminhado*\n${additionalText.trim()}\n\n🎵 Mensagem de voz`;
        }
        
        // Salvar no banco como Voice Message
        await db.messages.create({
            session_id: sessionId,
            contact_id: contactId,
            user_id: req.session.user.id,
            content: messageContent,
            type: 'audio',
            media_url: `/uploads/${req.file.filename}`,
            is_from_me: true,
            status: result ? 'sent' : 'error'
        });

      res.json({ 
        success: true, 
        messageId: result.messageId,
        audioUrl: `/uploads/${req.file.filename}`
      });

    } catch (whatsappError) {
      console.error('Erro ao enviar áudio PTT:', whatsappError);
      
      let errorMessage = whatsappError.message;
      let shouldRetry = false;
      
      // Verificar se é erro de formato
      if (errorMessage.includes('InvalidMediaCheckRepairFailedType')) {
        errorMessage = 'Formato de áudio incompatível com PTT. Tente gravar novamente.';
        shouldRetry = true;
      } else if (errorMessage.includes('incompatível com PTT')) {
        errorMessage = 'Formato WebM não suportado. Sistema tentará converter automaticamente.';
        shouldRetry = true;
      }
      
      // Salvar no banco como erro
      await db.messages.create({
        session_id: sessionId,
        contact_id: contactId,
        user_id: req.session.user.id,
        content: '[Erro PTT: ' + errorMessage + ']',
        type: 'audio',
        media_url: `/uploads/${req.file.filename}`,
        is_from_me: true,
        status: 'error'
      });

      return res.status(500).json({ 
        error: errorMessage,
        shouldRetry: shouldRetry
      });
    }

  } catch (error) {
    console.error('Erro ao processar áudio:', error);
    res.status(500).json({ error: 'Erro ao processar áudio: ' + error.message });
  }
});

// Função para converter áudio para formato compatível usando FFmpeg
const convertAudioToMp3Server = async (inputPath) => {
  try {
    const path = require('path');
    const fs = require('fs');
    
    // Gerar nome do arquivo de saída
    const ext = path.extname(inputPath);
    const baseName = path.basename(inputPath, ext);
    const outputPath = path.join(path.dirname(inputPath), `${baseName}_converted.mp3`);
    
    console.log('🔄 Convertendo áudio:', inputPath, '→', outputPath);
    
    // Verificar se FFmpeg está disponível
    try {
      const ffmpeg = require('fluent-ffmpeg');
      
      return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .audioCodec('libmp3lame')
          .audioBitrate(128)
          .audioChannels(1)
          .audioFrequency(44100)
          .format('mp3')
          .on('start', (commandLine) => {
            console.log('🎵 FFmpeg iniciado:', commandLine);
          })
          .on('progress', (progress) => {
            console.log('🔄 Progresso:', progress.percent + '%');
          })
          .on('end', () => {
            console.log('✅ Conversão MP3 concluída:', outputPath);
            resolve(outputPath);
          })
          .on('error', (err) => {
            console.error('❌ Erro FFmpeg:', err.message);
            resolve(null);
          })
          .save(outputPath);
      });
      
    } catch (ffmpegError) {
      console.log('⚠️ FFmpeg não disponível, tentando conversão manual...');
      
      // Fallback: tentar renomear para MP3 (funciona para alguns formatos)
      const fallbackPath = inputPath.replace(path.extname(inputPath), '.mp3');
      
      try {
        fs.copyFileSync(inputPath, fallbackPath);
        console.log('✅ Arquivo copiado como MP3:', fallbackPath);
        return fallbackPath;
      } catch (copyError) {
        console.error('❌ Erro no fallback:', copyError.message);
        return null;
      }
    }
    
  } catch (error) {
    console.error('❌ Erro geral na conversão:', error.message);
    return null;
  }
};

// Enviar mensagem
app.post('/api/messages/send', upload.single('media'), async (req, res) => {
  try {
    const { sessionId, contactId, content, type = 'text' } = req.body;
    
    console.log('Enviando mensagem:', { sessionId, contactId, type, hasFile: !!req.file });
    
    // Buscar contato
    const contact = await db.query('SELECT * FROM contacts WHERE id = ?', [contactId]);
    if (!contact.length) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }

    // Processar variáveis no conteúdo da mensagem
    let processedContent = content || '';
    if (processedContent && type === 'text') {
      processedContent = messageHelpers.formatMessage(processedContent, {
        nome: contact[0].name || contact[0].number.split('@')[0]
      });
    }

    // Preparar opções
    const options = {
      type,
      signature: req.session.user.signature
    };
    
    // Se houver mídia
    if (req.file) {
      options.path = path.resolve(req.file.path);
      options.filename = req.file.originalname;
      
      // FORÇAR TIPO COMO DOCUMENT PARA ÁUDIOS
      if (req.file.mimetype && req.file.mimetype.startsWith('audio/')) {
        options.type = 'document'; // Forçar como documento
        console.log('🎵 Áudio detectado, enviando como documento');
      }
      
      console.log('Arquivo para enviar:', options.path);
      console.log('Tipo de mídia:', req.file.mimetype);
      console.log('Tipo de envio:', options.type);
    }

    // Enviar via WhatsApp
    const result = await whatsappService.sendMessage(
      parseInt(sessionId),
      contact[0].number,
      processedContent || '',
      options
    );

    // Determinar status baseado no tipo
    let status = 'sent';
    let finalContent = processedContent || '';
    
    // Para áudios, marcar como disponível internamente
    if (req.file && req.file.mimetype && req.file.mimetype.startsWith('audio/')) {
      status = 'internal'; // Status especial para áudios
      finalContent = '🎵 Mensagem de voz gravada (disponível no sistema)';
    }

    // ✅ SALVAR NO BANCO
    console.log('🔥 TENTANDO SALVAR NO BANCO:', {
      session_id: sessionId,
      contact_id: contactId,
      user_id: req.session.user.id,
      content: finalContent,
      type,
      is_from_me: true
    });

    try {
      // Salvar no banco
      const messageId = await db.messages.create({
        session_id: parseInt(sessionId),
        contact_id: parseInt(contactId),
        user_id: req.session.user.id,
        content: finalContent,
        type,
        media_url: req.file ? `/uploads/${req.file.filename}` : null,
        is_from_me: true,
        status: status
      });

      console.log('✅ MENSAGEM SALVA NO BANCO COM ID:', messageId);

    } catch (dbError) {
      console.error('❌ ERRO AO SALVAR NO BANCO:', dbError);
      console.error('❌ DETALHES DO ERRO:', dbError.message);
      // NÃO falhar o envio por causa do banco
    }

    // ✅ RESPOSTA ÚNICA
    res.json({ success: true, messageId: result.messageId });

  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    res.status(500).json({ error: 'Erro ao enviar mensagem: ' + error.message });
  }
});

// Enviar mensagem para novo contato
app.post('/api/messages/send-to-new-contact', upload.single('media'), async (req, res) => {
  try {
    const { sessionId, number, name, message } = req.body;
    
    console.log('📤 Nova conversa - dados recebidos:', { sessionId, number, name, hasMessage: !!message });
    
    // Validações
    if (!sessionId || !number) {
      return res.status(400).json({ error: 'Sessão e número são obrigatórios' });
    }
    
    if (!message && !req.file) {
      return res.status(400).json({ error: 'Mensagem ou mídia é obrigatória' });
    }
    
    // Formatar número
    const { validationHelpers } = require('./auth');
    const formattedNumber = validationHelpers.formatWhatsAppNumber(number);
    
    console.log('📤 Número formatado:', formattedNumber);
    
    // Criar ou buscar contato
    const contact = await db.contacts.findOrCreate(
      formattedNumber,
      name || formattedNumber.split('@')[0]
    );
    
    console.log('📤 Contato criado/encontrado:', contact.id, contact.name);
    
    // Preparar opções de envio
    const options = {
      signature: req.session.user.signature
    };
    
    if (req.file) {
      options.type = uploadHelpers.getFileCategory(req.file.mimetype);
      options.path = path.resolve(req.file.path);
      options.filename = req.file.originalname;
    }
    
    // Enviar mensagem via WhatsApp
    const result = await whatsappService.sendMessage(
      parseInt(sessionId),
      formattedNumber,
      message || '',
      options
    );
    
    // Salvar mensagem no banco
    const messageId = await db.messages.create({
      session_id: sessionId,
      contact_id: contact.id,
      user_id: req.session.user.id,
      content: message || '',
      type: req.file ? options.type : 'text',
      media_url: req.file ? `/uploads/${req.file.filename}` : null,
      is_from_me: true,
      status: 'sent'
    });
    
    // Atualizar última mensagem do contato
    await db.contacts.update(contact.id, {
      last_message: message ? message.substring(0, 100) : '[Mídia]',
      last_message_at: new Date()
    });
    
    console.log('✅ Mensagem enviada com sucesso para novo contato');
    
    res.json({ 
      success: true, 
      messageId: result.messageId,
      contactId: contact.id,
      message: 'Mensagem enviada com sucesso!'
    });
    
  } catch (error) {
    console.error('❌ Erro ao enviar para novo contato:', error);
    res.status(500).json({ error: 'Erro ao enviar mensagem: ' + error.message });
  }
});

// ===========================================
// ROTAS API - FILAS E ATENDIMENTO
// ===========================================

// Obter estatísticas da fila
app.get('/api/queue/stats', async (req, res) => {
  try {
    const cacheKey = `stats_${req.query.sector || 'all'}`;
    let stats = cache.stats.get(cacheKey);
    
    if (!stats) {
      stats = await db.queues.getStats(req.query.sector);
      cache.stats.set(cacheKey, stats);
    }
    
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao obter estatísticas' });
  }
});

// Pegar próximo da fila
app.post('/api/queue/next', async (req, res) => {
  try {
    const { sector } = req.body;
    const userId = req.session.user.id;
    
    // CORREÇÃO: Priorizar atendimentos transferidos para mim
    let next = await db.query(`
      SELECT q.*, c.name, c.number, c.id as contact_id
      FROM queues q 
      JOIN contacts c ON q.contact_id = c.id 
      WHERE q.assigned_user_id = ? AND q.status = 'waiting'
      ORDER BY q.created_at ASC 
      LIMIT 1
    `, [userId]);
    
    // Se não há transferência específica, pegar da fila geral do setor
    if (next.length === 0) {
      next = await db.query(`
        SELECT q.*, c.name, c.number, c.id as contact_id
        FROM queues q 
        JOIN contacts c ON q.contact_id = c.id 
        WHERE q.sector = ? AND q.status = 'waiting' AND q.assigned_user_id IS NULL
        ORDER BY q.created_at ASC 
        LIMIT 1
      `, [sector || req.session.user.sector]);
    }
    
    if (next.length === 0) {
      return res.json({ success: false, message: 'Fila vazia' });
    }
    
    const queue = next[0];
    
    // Atualizar status para attending
    await db.query(
      'UPDATE queues SET status = ?, user_id = ?, started_at = NOW(), assigned_user_id = NULL WHERE id = ?',
      ['attending', userId, queue.id]
    );
    
    res.json({ success: true, queue });
  } catch (error) {
    console.error('Erro ao pegar próximo da fila:', error);
    res.status(500).json({ error: 'Erro ao processar fila' });
  }
});

// Transferir atendimento - VERSÃO MELHORADA
app.post('/api/queue/transfer', async (req, res) => {
  try {
    const { queueId, newSector, targetUserId, reason } = req.body;
    
    // Buscar informações da fila atual
    const queueInfo = await db.query(
      `SELECT q.*, c.name, c.number 
       FROM queues q 
       JOIN contacts c ON q.contact_id = c.id 
       WHERE q.id = ?`,
      [queueId]
    );
    
    if (queueInfo.length === 0) {
      return res.status(404).json({ error: 'Fila não encontrada' });
    }
    
    const queue = queueInfo[0];
    
    // Se foi especificado um usuário específico para transferir
    if (targetUserId) {
      // CORREÇÃO: Transferência específica com assigned_user_id
      await db.query(
        `UPDATE queues SET 
         sector = ?, 
         assigned_user_id = ?, 
         user_id = NULL, 
         status = 'waiting',
         transferred_at = NOW(),
         transferred_by = ?,
         transfer_reason = ?
         WHERE id = ?`,
        [newSector, targetUserId, req.session.user.id, reason || 'Transferência direta', queueId]
      );
      
      // Notificar o usuário específico via socket
      global.io.to(`user-${targetUserId}`).emit('queue:transfer-received', {
        queueId,
        contactName: queue.name || queue.number,
        fromUser: req.session.user.name,
        reason: reason || 'Transferência direta'
      });
      
    } else {
      // CORREÇÃO: Transferência geral para o setor (limpar ambos os campos)
      await db.query(
        `UPDATE queues SET 
         sector = ?, 
         assigned_user_id = NULL, 
         user_id = NULL, 
         status = 'waiting',
         transferred_at = NOW(),
         transferred_by = ?,
         transfer_reason = ?
         WHERE id = ?`,
        [newSector, req.session.user.id, reason || 'Transferência para setor', queueId]
      );
      
      // Notificar todo o setor
      global.io.to(`sector-${newSector}`).emit('queue:transfer-to-sector', {
        queueId,
        contactName: queue.name || queue.number,
        fromUser: req.session.user.name,
        reason: reason || 'Transferência para setor'
      });
    }
    
    // Log da transferência
    console.log(`Transferência: ${queue.name || queue.number} de ${req.session.user.name} para ${newSector}${targetUserId ? ` (usuário ${targetUserId})` : ''}`);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao transferir:', error);
    res.status(500).json({ error: 'Erro ao transferir' });
  }
});

// Finalizar atendimento
app.post('/api/queue/finish', async (req, res) => {
  try {
    const { queueId, sendGoodbyeMessage = true } = req.body;
    
    // Buscar informações da fila antes de finalizar
    const queueInfo = await db.query(
      `SELECT q.*, c.number, c.name, c.last_message_at
       FROM queues q 
       JOIN contacts c ON q.contact_id = c.id 
       WHERE q.id = ?`,
      [queueId]
    );
    
    if (queueInfo.length === 0) {
      return res.status(404).json({ error: 'Fila não encontrada' });
    }
    
    const queue = queueInfo[0];
    
    // ✅ CORREÇÃO 1: Identificar QUAL sessão deve enviar a despedida
    let targetSessionId = null;
    
    try {
      // Buscar a sessão da última mensagem enviada para este contato
      const lastMessage = await db.query(
        `SELECT session_id FROM messages 
         WHERE contact_id = ? AND is_from_me = 1 
         ORDER BY created_at DESC 
         LIMIT 1`,
        [queue.contact_id]
      );
      
      if (lastMessage.length > 0 && lastMessage[0].session_id) {
        targetSessionId = lastMessage[0].session_id;
        console.log(`🎯 Sessão identificada para despedida: ${targetSessionId}`);
      }
    } catch (sessionError) {
      console.log(`⚠️ Erro ao identificar sessão:`, sessionError.message);
    }
    
    // ✅ CORREÇÃO 2: Se não conseguiu identificar, usar primeira sessão ativa
    if (!targetSessionId) {
      const sessions = await db.sessions.list();
      const activeSession = sessions.find(s => s.status === 'connected');
      
      if (activeSession) {
        targetSessionId = activeSession.id;
        console.log(`🎯 Usando primeira sessão ativa: ${targetSessionId}`);
      }
    }
    
    // Finalizar no banco
    await db.queues.finish(queueId);
    
    // ✅ CORREÇÃO 3: Enviar despedida APENAS se tiver sessão específica
    if (sendGoodbyeMessage && targetSessionId) {
      try {
        // Verificar configurações de mensagem automática
        const autoSettings = await db.settings.getAutoMessages();
        
        if (autoSettings.goodbye.enabled) {
          // Verificar se a sessão específica está ativa
          if (whatsappService.isSessionActive(targetSessionId)) {
            console.log(`📤 Enviando despedida via sessão ${targetSessionId} para ${queue.number}...`);
            
            // ✅ CORREÇÃO PRINCIPAL: Passar sessionId específico
            await whatsappService.sendGoodbyeMessage(
              targetSessionId,  // ⬅️ SESSÃO ESPECÍFICA
              queue.number, 
              req.session.user.signature
            );
            console.log(`✅ Despedida enviada via sessão ${targetSessionId}`);
          } else {
            console.log(`⚠️ Sessão ${targetSessionId} não está ativa, pulando despedida`);
          }
        } else {
          console.log(`ℹ️ Mensagens de despedida desabilitadas nas configurações`);
        }
      } catch (goodbyeError) {
        console.error('❌ Erro ao enviar mensagem de despedida:', goodbyeError);
        // Não falha a finalização se a mensagem der erro
      }
    } else {
      console.log(`ℹ️ Despedida pulada - sendGoodbyeMessage: ${sendGoodbyeMessage}, targetSessionId: ${targetSessionId}`);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao finalizar:', error);
    res.status(500).json({ error: 'Erro ao finalizar' });
  }
});

// ===========================================
// ROTAS API - RESPOSTAS RÁPIDAS
// ===========================================

// Listar respostas rápidas
app.get('/api/quick-replies', async (req, res) => {
  try {
    const replies = await db.quickReplies.list(req.session.user.sector);
    res.json(replies);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar respostas' });
  }
});

// Criar resposta rápida
app.post('/api/quick-replies', async (req, res) => {
  try {
    const { title, content, shortcut, sector } = req.body;
    
    // Validar dados obrigatórios
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Título é obrigatório' });
    }
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Conteúdo é obrigatório' });
    }
    
    // Verificar se atalho já existe (se fornecido)
    if (shortcut && shortcut.trim()) {
      const existingShortcut = await db.query(
        'SELECT id FROM quick_replies WHERE shortcut = ? AND sector = ?', 
        [shortcut.trim(), sector || req.session.user.sector]
      );
      
      if (existingShortcut.length > 0) {
        return res.status(400).json({ error: `Atalho "${shortcut}" já existe neste setor` });
      }
    }
    
    const id = await db.quickReplies.create({
      title: title.trim(),
      content: content.trim(),
      shortcut: shortcut ? shortcut.trim() : null,
      sector: sector || req.session.user.sector,
      user_id: req.session.user.id
    });
    
    res.json({ success: true, id });
  } catch (error) {
    console.error('Erro ao criar resposta rápida:', error);
    res.status(500).json({ error: 'Erro ao criar resposta' });
  }
});

// Excluir resposta rápida
app.delete('/api/quick-replies/:id', async (req, res) => {
  try {
    const replyId = parseInt(req.params.id);
    
    if (!replyId || isNaN(replyId)) {
      return res.status(400).json({ error: 'ID da resposta inválido' });
    }
    
    // Buscar resposta para verificar permissões
    const reply = await db.query('SELECT * FROM quick_replies WHERE id = ?', [replyId]);
    
    if (reply.length === 0) {
      return res.status(404).json({ error: 'Resposta rápida não encontrada' });
    }
    
    // Verificar permissões: apenas criador, admin ou supervisor podem excluir
    const userReply = reply[0];
    const canDelete = req.session.user.role === 'admin' || 
                     req.session.user.role === 'supervisor' || 
                     userReply.user_id === req.session.user.id;
    
    if (!canDelete) {
      return res.status(403).json({ error: 'Sem permissão para excluir esta resposta' });
    }
    
    // Excluir resposta
    await db.query('DELETE FROM quick_replies WHERE id = ?', [replyId]);
    
    console.log(`✅ Resposta rápida excluída: ID ${replyId} por usuário ${req.session.user.name}`);
    
    res.json({ success: true, message: 'Resposta rápida excluída com sucesso' });
    
  } catch (error) {
    console.error('Erro ao excluir resposta rápida:', error);
    res.status(500).json({ error: 'Erro ao excluir resposta' });
  }
});

// Obter variáveis disponíveis para respostas rápidas
app.get('/api/quick-replies/variables', async (req, res) => {
  try {
    const variables = messageHelpers.getAvailableVariables();
    res.json(variables);
  } catch (error) {
    console.error('Erro ao obter variáveis:', error);
    res.status(500).json({ error: 'Erro ao obter variáveis' });
  }
});

// Preview de resposta rápida com variáveis
app.post('/api/quick-replies/preview', async (req, res) => {
  try {
    const { content, contactId } = req.body;
    
    let contactName = 'João Silva'; // Nome exemplo
    
    // Se um contato foi especificado, buscar nome real
    if (contactId) {
      const contact = await db.query('SELECT name, number FROM contacts WHERE id = ?', [contactId]);
      if (contact.length > 0) {
        contactName = contact[0].name || contact[0].number.split('@')[0];
      }
    }
    
    const preview = messageHelpers.formatMessage(content, {
      nome: contactName
    });
    
    res.json({ preview });
  } catch (error) {
    console.error('Erro ao gerar preview:', error);
    res.status(500).json({ error: 'Erro ao gerar preview' });
  }
});

// ===========================================
// ROTAS API - CAMPANHAS
// ===========================================

// Obter variáveis disponíveis para campanhas
app.get('/api/campaigns/variables', authMiddleware, async (req, res) => {
  try {
    const { campaignHelpers } = require('./auth');
    const variables = campaignHelpers.getAvailableVariables();
    
    res.json(variables);
  } catch (error) {
    console.error('Erro ao obter variáveis:', error);
    res.status(500).json({ error: 'Erro ao carregar variáveis' });
  }
});

// Listar campanhas
app.get('/api/campaigns', async (req, res) => {
  try {
    const campaigns = await db.campaigns.list();
    res.json(campaigns);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar campanhas' });
  }
});

// Criar campanha
app.post('/api/campaigns', upload.single('media'), async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão para criar campanhas' });
    }
    
    // Extrair dados do FormData após processamento do multer
    const name = req.body.name;
    const content = req.body.content;
    const target_tags = req.body.target_tags;
    const target_sectors = req.body.target_sectors;
    const schedule_type = req.body.schedule_type;
    const scheduled_at = req.body.scheduled_at;
    
    console.log('🔍 BACKEND: Dados brutos recebidos do FormData:');
    console.log('- req.body completo:', req.body);
    console.log('- name:', name);
    console.log('- target_tags:', target_tags, typeof target_tags);
    console.log('- target_sectors:', target_sectors, typeof target_sectors);
    console.log('- schedule_type:', schedule_type);
    
    // Validações
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome da campanha é obrigatório' });
    }
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Conteúdo da mensagem é obrigatório' });
    }
    
    // Parse das tags e setores - VERSÃO CORRIGIDA
    let parsedTags = [];
    let parsedSectors = [];
    
    try {
      // Se target_tags for string, fazer parse JSON
      if (typeof target_tags === 'string') {
        parsedTags = target_tags ? JSON.parse(target_tags) : [];
      } else if (Array.isArray(target_tags)) {
        // Se já for array, usar diretamente
        parsedTags = target_tags;
      } else {
        parsedTags = [];
      }
      
      // Se target_sectors for string, fazer parse JSON  
      if (typeof target_sectors === 'string') {
        parsedSectors = target_sectors ? JSON.parse(target_sectors) : [];
      } else if (Array.isArray(target_sectors)) {
        // Se já for array, usar diretamente
        parsedSectors = target_sectors;
      } else {
        parsedSectors = [];
      }
      
      console.log('🔍 BACKEND: Após parse:');
      console.log('parsedTags:', parsedTags);
      console.log('parsedSectors:', parsedSectors);
      
    } catch (e) {
      console.error('Erro no parse:', e);
      return res.status(400).json({ error: 'Formato inválido de tags ou setores' });
    }
    
    if (parsedTags.length === 0 && parsedSectors.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos uma tag ou setor' });
    }
    
    // Processar agendamento
    let scheduledDate = null;
    let status = 'draft';
    
    if (schedule_type === 'scheduled' && scheduled_at) {
      scheduledDate = new Date(scheduled_at);
      
      if (scheduledDate <= new Date()) {
        return res.status(400).json({ error: 'Data de agendamento deve ser no futuro' });
      }
      
      status = 'scheduled';
    }
    
    // Obter total de contatos
    const targetContacts = await db.campaigns.getTargetContacts(parsedTags, parsedSectors);
    
    if (targetContacts.length === 0) {
      return res.status(400).json({ error: 'Nenhum contato encontrado com as tags/setores selecionados' });
    }
    
    // Dados da campanha
    const campaignData = {
      name: name.trim(),
      content: content.trim(),
      media_url: req.file ? `/uploads/${req.file.filename}` : null,
      media_type: req.file ? uploadHelpers.getFileCategory(req.file.mimetype) : null,
      target_tags: parsedTags,
      target_sectors: parsedSectors,
      scheduled_at: scheduledDate,
      status,
      total_count: targetContacts.length,
      created_by: req.session.user.id
    };
    
    console.log('🔍 BACKEND: Dados para salvar no banco:', campaignData);
    
    const campaignId = await db.campaigns.create(campaignData);
    
    // Se for disparo imediato, iniciar
    if (schedule_type === 'now') {
      console.log('🔍 BACKEND: Iniciando disparo imediato da campanha', campaignId);
      startCampaignDispatch(campaignId).catch(error => {
        console.error('🔴 Erro no processo de disparo:', error);
      });
    }
    
    res.json({ 
      success: true, 
      campaignId,
      message: schedule_type === 'now' ? 
        'Campanha criada e disparo iniciado!' : 
        'Campanha criada com sucesso!',
      totalContacts: targetContacts.length
    });
    
  } catch (error) {
    console.error('Erro ao criar campanha:', error);
    res.status(500).json({ error: 'Erro ao criar campanha: ' + error.message });
  }
});

// ===========================================
// ROTAS API - ANOTAÇÕES DE CONTATOS (seção existente)
// ===========================================

// Obter anotações de um contato
app.get('/api/contacts/:id/notes', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    
    // Buscar anotação simples do contato
    const contact = await db.query('SELECT notes FROM contacts WHERE id = ?', [contactId]);
    
    // Buscar histórico de anotações
    const noteHistory = await db.contactNotes.getByContact(contactId);
    
    res.json({
      currentNote: contact[0]?.notes || '',
      history: noteHistory
    });
  } catch (error) {
    console.error('Erro ao buscar anotações:', error);
    res.status(500).json({ error: 'Erro ao buscar anotações' });
  }
});

// Salvar anotação de um contato
app.post('/api/contacts/:id/notes', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    const { content } = req.body;
    const userId = req.session.user.id;
    
    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Conteúdo da anotação é obrigatório' });
    }
    
    // Salvar anotação simples no contato
    await db.contacts.update(contactId, { notes: content.trim() });
    
    // Criar entrada no histórico
    await db.contactNotes.create(contactId, userId, content.trim());
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao salvar anotação:', error);
    res.status(500).json({ error: 'Erro ao salvar anotação' });
  }
});

// Adicionar anotação ao histórico
app.post('/api/contacts/:id/notes/history', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    const { content } = req.body;
    const userId = req.session.user.id;
    
    if (!content || content.trim() === '') {
      return res.status(400).json({ error: 'Conteúdo da anotação é obrigatório' });
    }
    
    const noteId = await db.contactNotes.create(contactId, userId, content.trim());
    
    // Buscar a anotação criada com dados do usuário
    const newNote = await db.query(
      `SELECT cn.*, u.name as user_name 
       FROM contact_notes cn 
       LEFT JOIN users u ON cn.user_id = u.id 
       WHERE cn.id = ?`,
      [noteId]
    );
    
    res.json({ success: true, note: newNote[0] });
  } catch (error) {
    console.error('Erro ao adicionar anotação ao histórico:', error);
    res.status(500).json({ error: 'Erro ao adicionar anotação' });
  }
});

// Deletar anotação do histórico
app.delete('/api/notes/:id', async (req, res) => {
  try {
    const noteId = parseInt(req.params.id);
    
    // Verificar se a anotação pertence ao usuário (se não for admin)
    if (req.session.user.role !== 'admin') {
      const note = await db.query('SELECT user_id FROM contact_notes WHERE id = ?', [noteId]);
      if (!note.length || note[0].user_id !== req.session.user.id) {
        return res.status(403).json({ error: 'Sem permissão para deletar esta anotação' });
      }
    }
    
    await db.contactNotes.delete(noteId);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao deletar anotação:', error);
    res.status(500).json({ error: 'Erro ao deletar anotação' });
  }
});

// ===========================================
// ROTAS API - TAGS (ADICIONAR ESTA SEÇÃO COMPLETA)  
// ===========================================

// Listar todas as tags
app.get('/api/tags', async (req, res) => {
  try {
    const tags = await db.tags.list(req.session.user.sector);
    res.json(tags);
  } catch (error) {
    console.error('Erro ao listar tags:', error);
    res.status(500).json({ error: 'Erro ao listar tags' });
  }
});

// Criar nova tag
app.post('/api/tags', async (req, res) => {
  try {
    const { name, color } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Nome da tag é obrigatório' });
    }
    
    const tagId = await db.tags.create(name.trim(), color, req.session.user.sector);
    res.json({ success: true, tagId });
  } catch (error) {
    console.error('Erro ao criar tag:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      res.status(400).json({ error: 'Já existe uma tag com este nome' });
    } else {
      res.status(500).json({ error: 'Erro ao criar tag' });
    }
  }
});

// Obter tags de um contato
app.get('/api/contacts/:id/tags', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    const tags = await db.tags.getByContact(contactId);
    res.json(tags);
  } catch (error) {
    console.error('Erro ao buscar tags do contato:', error);
    res.status(500).json({ error: 'Erro ao buscar tags' });
  }
});

// Adicionar tag a um contato
app.post('/api/contacts/:id/tags/:tagId', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    const tagId = parseInt(req.params.tagId);
    
    await db.tags.addToContact(contactId, tagId);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao adicionar tag:', error);
    res.status(500).json({ error: 'Erro ao adicionar tag' });
  }
});

// Remover tag de um contato
app.delete('/api/contacts/:id/tags/:tagId', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    const tagId = parseInt(req.params.tagId);
    
    await db.tags.removeFromContact(contactId, tagId);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover tag:', error);
    res.status(500).json({ error: 'Erro ao remover tag' });
  }
});

// ===========================================
// ROTAS API - ENQUETES/POLLS
// ===========================================

// Criar enquete
app.post('/api/polls', authMiddleware, async (req, res) => {
  try {
    const { contactId, question, options, pollType = 'single', expiresIn } = req.body;
    
    if (!contactId || !question || !options || !Array.isArray(options)) {
      return res.status(400).json({ error: 'Dados da enquete inválidos' });
    }
    
    if (options.length < 2 || options.length > 10) {
      return res.status(400).json({ error: 'A enquete deve ter entre 2 e 10 opções' });
    }
    
    // Verificar se o contato existe
    const contact = await db.query('SELECT * FROM contacts WHERE id = ?', [contactId]);
    if (!contact.length) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }
    
    // Calcular data de expiração se especificada
    let expiresAt = null;
    if (expiresIn) {
      expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + parseInt(expiresIn));
    }
    
    // Criar enquete no banco
    const pollId = await db.polls.create({
      contact_id: contactId,
      user_id: req.session.user.id,
      question: question.trim(),
      options: options.map(opt => opt.trim()),
      poll_type: pollType,
      expires_at: expiresAt
    });
    
    res.json({ success: true, pollId });
    
  } catch (error) {
    console.error('Erro ao criar enquete:', error);
    res.status(500).json({ error: 'Erro ao criar enquete' });
  }
});

// Obter enquetes de um usuário
app.get('/api/polls/my', authMiddleware, async (req, res) => {
  try {
    const polls = await db.polls.findByUser(req.session.user.id);
    
    // Adicionar contagem de respostas para cada enquete
    for (const poll of polls) {
      const responses = await db.pollResponses.findByPoll(poll.id);
      poll.responsesCount = responses.length;
    }
    
    res.json(polls);
    
  } catch (error) {
    console.error('Erro ao listar enquetes:', error);
    res.status(500).json({ error: 'Erro ao listar enquetes' });
  }
});

// Obter detalhes de uma enquete
app.get('/api/polls/:id', authMiddleware, async (req, res) => {
  try {
    const pollId = parseInt(req.params.id);
    const poll = await db.polls.findById(pollId);
    
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }
    
    // Verificar se o usuário tem permissão (criador da enquete ou admin)
    if (poll.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão para ver esta enquete' });
    }
    
    // Buscar respostas
    const responses = await db.pollResponses.findByPoll(pollId);
    
    // Calcular estatísticas
    const stats = {
      totalResponses: responses.length,
      optionCounts: {}
    };
    
    // Inicializar contadores
    poll.options.forEach((option, index) => {
      stats.optionCounts[index + 1] = {
        option: option,
        count: 0,
        percentage: 0
      };
    });
    
    // Contar respostas
    responses.forEach(response => {
      response.selected_options.forEach(optionIndex => {
        if (stats.optionCounts[optionIndex]) {
          stats.optionCounts[optionIndex].count++;
        }
      });
    });
    
    // Calcular percentuais
    Object.keys(stats.optionCounts).forEach(key => {
      const option = stats.optionCounts[key];
      option.percentage = stats.totalResponses > 0 ? 
        Math.round((option.count / stats.totalResponses) * 100) : 0;
    });
    
    res.json({
      poll,
      responses,
      stats
    });
    
  } catch (error) {
    console.error('Erro ao obter enquete:', error);
    res.status(500).json({ error: 'Erro ao carregar enquete' });
  }
});

// Fechar enquete
app.post('/api/polls/:id/close', authMiddleware, async (req, res) => {
  try {
    const pollId = parseInt(req.params.id);
    const poll = await db.polls.findById(pollId);
    
    if (!poll) {
      return res.status(404).json({ error: 'Enquete não encontrada' });
    }
    
    // Verificar permissão
    if (poll.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    await db.polls.updateStatus(pollId, 'closed');
    
    res.json({ success: true, message: 'Enquete fechada com sucesso' });
    
  } catch (error) {
    console.error('Erro ao fechar enquete:', error);
    res.status(500).json({ error: 'Erro ao fechar enquete' });
  }
});

// ===========================================
// ROTAS API - USUÁRIOS (ADMIN) (seção existente)
// ===========================================

// Listar usuários por setor (para transferência específica)
app.get('/api/users/by-sector', async (req, res) => {
  try {
    const { sector } = req.query;
    
    let sql = 'SELECT id, name, role, sector, is_active FROM users WHERE is_active = 1';
    const params = [];
    
    if (sector && sector !== 'all') {
      sql += ' AND (sector = ? OR role IN (?, ?))';
      params.push(sector, 'admin', 'supervisor');
    }
    
    sql += ' ORDER BY role DESC, name';
    
    const users = await db.query(sql, params);
    res.json(users);
    
  } catch (error) {
    console.error('Erro ao listar usuários por setor:', error);
    res.status(500).json({ error: 'Erro ao carregar usuários' });
  }
});

// Obter status de usuários online
app.get('/api/users/online-status', async (req, res) => {
  try {
    const users = await db.users.list();
    
    // Simular status online (pode ser melhorado com Redis ou similar)
    const usersWithStatus = users.map(user => ({
      ...user,
      online: Math.random() > 0.3, // Placeholder - implementar lógica real
      lastSeen: new Date(Date.now() - Math.random() * 3600000) // Última vez visto
    }));
    
    res.json(usersWithStatus);
    
  } catch (error) {
    console.error('Erro ao obter status:', error);
    res.status(500).json({ error: 'Erro ao obter status dos usuários' });
  }
});

// Listar usuários
app.get('/api/users', async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const users = await db.users.list();
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar usuários' });
  }
});

// Criar usuário
app.post('/api/users', async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const { name, email, password, role, sector, signature } = req.body;
    
    // Validar email
    if (!validationHelpers.isValidEmail(email)) {
      return res.status(400).json({ error: 'Email inválido' });
    }
    
    const userId = await db.users.create({
      name,
      email,
      password,
      role,
      sector,
      signature
    });
    
    res.json({ success: true, userId });
  } catch (error) {
    console.error('Erro ao criar usuário:', error);
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// Adicionar número a uma sessão
app.post('/api/sessions/:id/numbers', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }
    
    // Criar entrada para o novo número
    const result = await db.query(
      'INSERT INTO session_numbers (session_id, name, status) VALUES (?, ?, ?)',
      [sessionId, name, 'connecting']
    );
    
    const numberId = result.insertId;
    
    // Iniciar conexão WhatsApp para este número
    // TODO: Implementar conexão múltipla no WhatsAppService
    
    res.json({ success: true, numberId });
  } catch (error) {
    console.error('Erro ao adicionar número:', error);
    res.status(500).json({ error: 'Erro ao adicionar número' });
  }
});

// Listar números de uma sessão
app.get('/api/sessions/:id/numbers', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id);
    
    const numbers = await db.query(
      'SELECT * FROM session_numbers WHERE session_id = ? ORDER BY created_at',
      [sessionId]
    );
    
    res.json(numbers);
  } catch (error) {
    console.error('Erro ao listar números:', error);
    res.status(500).json({ error: 'Erro ao listar números' });
  }
});

// Remover número
app.delete('/api/numbers/:id', async (req, res) => {
  try {
    const numberId = parseInt(req.params.id);
    
    // TODO: Desconectar número no WhatsAppService
    
    await db.query('DELETE FROM session_numbers WHERE id = ?', [numberId]);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Erro ao remover número:', error);
    res.status(500).json({ error: 'Erro ao remover número' });
  }
});

// ===========================================
// ROTAS API - RELATÓRIOS
// ===========================================

app.get('/api/reports/stats', async (req, res) => {
  try {
    const { startDate, endDate, sector } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'Datas obrigatórias' });
    }
    
    const stats = await reportHelpers.generateStats(startDate, endDate, sector);
    res.json(stats);
  } catch (error) {
    console.error('Erro ao gerar relatório:', error);
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

// ===========================================
// ROTAS API - DIAGNÓSTICO DO SISTEMA
// ===========================================

// Diagnóstico completo do sistema
app.get('/api/system/health', authMiddleware, async (req, res) => {
  try {
    const health = {
      timestamp: new Date().toISOString(),
      status: 'healthy',
      whatsapp: {
        sessions: [],
        totalSessions: 0,
        activeSessions: 0
      },
      database: {
        status: 'checking...',
        contacts: 0,
        messages: 0,
        queues: 0,
        campaigns: 0
      },
      system: {
        uptime: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
        nodejs: process.version,
        environment: process.env.NODE_ENV || 'development'
      }
    };
    
    // Verificar WhatsApp
    try {
      const sessions = await db.sessions.list();
      health.whatsapp.totalSessions = sessions.length;
      health.whatsapp.sessions = sessions.map(s => ({
        id: s.id,
        name: s.name,
        status: s.status,
        isActive: whatsappService.isSessionActive(s.id),
        connectedAt: s.connected_at
      }));
      health.whatsapp.activeSessions = health.whatsapp.sessions.filter(s => s.isActive).length;
    } catch (whatsappError) {
      health.whatsapp.error = whatsappError.message;
      health.status = 'warning';
    }
    
    // Verificar banco de dados
    try {
      const [contacts, messages, queues, campaigns] = await Promise.all([
        db.query('SELECT COUNT(*) as count FROM contacts'),
        db.query('SELECT COUNT(*) as count FROM messages'),
        db.query('SELECT COUNT(*) as count FROM queues'),
        db.query('SELECT COUNT(*) as count FROM campaigns')
      ]);
      
      health.database.status = 'connected';
      health.database.contacts = contacts[0].count;
      health.database.messages = messages[0].count;
      health.database.queues = queues[0].count;
      health.database.campaigns = campaigns[0].count;
    } catch (dbError) {
      health.database.status = 'error';
      health.database.error = dbError.message;
      health.status = 'error';
    }
    
    res.json(health);
    
  } catch (error) {
    console.error('Erro no diagnóstico:', error);
    res.status(500).json({ 
      status: 'error',
      error: 'Erro ao gerar diagnóstico',
      details: error.message 
    });
  }
});

// Limpeza de dados corrompidos
app.post('/api/system/cleanup', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem executar limpeza' });
    }
    
    console.log('🧹 Iniciando limpeza de dados corrompidos...');
    
    const stats = {
      contactsFixed: 0,
      messagesFixed: 0,
      queuesFixed: 0,
      duplicatesRemoved: 0
    };
    
    // Limpar contatos com dados inválidos
    const invalidContacts = await db.query(`
      SELECT id, number, name FROM contacts 
      WHERE number IS NULL 
         OR number = '' 
         OR number NOT LIKE '%@c.us'
         OR name IS NULL 
         OR name = ''
         OR LENGTH(name) > 200
    `);
    
    for (const contact of invalidContacts) {
      if (!contact.number || !contact.number.includes('@c.us')) {
        // Remover contato completamente inválido
        await db.query('DELETE FROM contacts WHERE id = ?', [contact.id]);
        console.log(`🗑️ Contato inválido removido: ID ${contact.id}`);
        stats.contactsFixed++;
      } else if (!contact.name || contact.name.length > 200) {
        // Corrigir nome vazio ou muito longo
        const defaultName = contact.number.split('@')[0].substring(0, 100);
        await db.query('UPDATE contacts SET name = ? WHERE id = ?', [defaultName, contact.id]);
        console.log(`✏️ Nome do contato corrigido: ID ${contact.id}`);
        stats.contactsFixed++;
      }
    }
    
    // Remover contatos duplicados (mesmo número)
    const duplicates = await db.query(`
      SELECT number, COUNT(*) as count, GROUP_CONCAT(id) as ids
      FROM contacts 
      WHERE number LIKE '%@c.us'
      GROUP BY number 
      HAVING COUNT(*) > 1
    `);
    
    for (const duplicate of duplicates) {
      const ids = duplicate.ids.split(',');
      const keepId = ids[0]; // Manter o primeiro
      const removeIds = ids.slice(1); // Remover os outros
      
      for (const removeId of removeIds) {
        // Transferir mensagens e filas para o contato que será mantido
        await db.query('UPDATE messages SET contact_id = ? WHERE contact_id = ?', [keepId, removeId]);
        await db.query('UPDATE queues SET contact_id = ? WHERE contact_id = ?', [keepId, removeId]);
        
        // Remover contato duplicado
        await db.query('DELETE FROM contacts WHERE id = ?', [removeId]);
        console.log(`🔄 Contato duplicado removido: ${duplicate.number}`);
        stats.duplicatesRemoved++;
      }
    }
    
    // Limpar mensagens órfãs
    const orphanMessages = await db.query(`
      SELECT m.id FROM messages m 
      LEFT JOIN contacts c ON m.contact_id = c.id 
      WHERE c.id IS NULL
    `);
    
    if (orphanMessages.length > 0) {
      const messageIds = orphanMessages.map(m => m.id);
      await db.query(`DELETE FROM messages WHERE id IN (${messageIds.map(() => '?').join(',')})`, messageIds);
      console.log(`🗑️ ${orphanMessages.length} mensagens órfãs removidas`);
      stats.messagesFixed = orphanMessages.length;
    }
    
    // Limpar filas órfãs
    const orphanQueues = await db.query(`
      SELECT q.id FROM queues q 
      LEFT JOIN contacts c ON q.contact_id = c.id 
      WHERE c.id IS NULL
    `);
    
    if (orphanQueues.length > 0) {
      const queueIds = orphanQueues.map(q => q.id);
      await db.query(`DELETE FROM queues WHERE id IN (${queueIds.map(() => '?').join(',')})`, queueIds);
      console.log(`🗑️ ${orphanQueues.length} filas órfãs removidas`);
      stats.queuesFixed = orphanQueues.length;
    }
    
    console.log('✅ Limpeza concluída:', stats);
    
    res.json({
      success: true,
      message: 'Limpeza concluída com sucesso',
      stats
    });
    
  } catch (error) {
    console.error('❌ Erro na limpeza:', error);
    res.status(500).json({ 
      error: 'Erro ao executar limpeza',
      details: error.message 
    });
  }
});

app.post('/api/system/cleanup-disk', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    
    const fs = require('fs');
    const path = require('path');
    
    let freedSpace = 0;
    const cleanupResults = [];
    
    // 1. Limpar uploads antigos (mais de 30 dias)
    const uploadsDir = path.resolve('./uploads');
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
      
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < thirtyDaysAgo) {
          const size = stats.size;
          fs.unlinkSync(filePath);
          freedSpace += size;
          cleanupResults.push(`Arquivo antigo removido: ${file} (${(size/1024/1024).toFixed(2)}MB)`);
        }
      }
    }
    
    // 2. Limpar logs antigos
    const logsDir = path.resolve('./logs');
    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir);
      for (const file of files) {
        if (file.includes('.log')) {
          const filePath = path.join(logsDir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.size > 100 * 1024 * 1024) { // Logs maiores que 100MB
            const size = stats.size;
            fs.writeFileSync(filePath, ''); // Limpar conteúdo
            freedSpace += size;
            cleanupResults.push(`Log limpo: ${file} (${(size/1024/1024).toFixed(2)}MB)`);
          }
        }
      }
    }
    
    // 3. Limpar tokens órfãos
    const tokensDir = path.resolve('./tokens');
    if (fs.existsSync(tokensDir)) {
      const tokenFolders = fs.readdirSync(tokensDir);
      
      for (const folder of tokenFolders) {
        // Verificar se existe sessão no banco
        const sessionExists = await db.query('SELECT id FROM sessions WHERE name = ?', [folder]);
        
        if (sessionExists.length === 0) {
          const folderPath = path.join(tokensDir, folder);
          const size = getDirSize(folderPath);
          fs.rmSync(folderPath, { recursive: true, force: true });
          freedSpace += size;
          cleanupResults.push(`Token órfão removido: ${folder} (${(size/1024/1024).toFixed(2)}MB)`);
        }
      }
    }
    
    res.json({
      success: true,
      freedSpace: `${(freedSpace/1024/1024).toFixed(2)}MB`,
      cleanupResults,
      message: `Limpeza concluída! ${(freedSpace/1024/1024).toFixed(2)}MB liberados`
    });
    
  } catch (error) {
    console.error('Erro na limpeza:', error);
    res.status(500).json({ error: 'Erro na limpeza' });
  }
});

// ADICIONAR AQUI - Análise detalhada de uso de disco
app.post('/api/system/disk-analysis', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    
    const fs = require('fs');
    const path = require('path');
    
    const analysis = {
      directories: [],
      totalSize: 0,
      recommendations: []
    };
    
    // Função para calcular tamanho de diretório
    function calculateDirSize(dirPath, name) {
      try {
        if (!fs.existsSync(dirPath)) {
          return { name, path: dirPath, size: 0, files: 0, exists: false };
        }
        
        let totalSize = 0;
        let fileCount = 0;
        
        function scanDir(currentPath) {
          const items = fs.readdirSync(currentPath);
          
          for (const item of items) {
            const itemPath = path.join(currentPath, item);
            const stats = fs.statSync(itemPath);
            
            if (stats.isDirectory()) {
              scanDir(itemPath);
            } else {
              totalSize += stats.size;
              fileCount++;
            }
          }
        }
        
        scanDir(dirPath);
        
        return {
          name,
          path: dirPath,
          size: totalSize,
          sizeFormatted: `${(totalSize / 1024 / 1024).toFixed(2)}MB`,
          files: fileCount,
          exists: true
        };
      } catch (error) {
        return {
          name,
          path: dirPath,
          size: 0,
          sizeFormatted: '0MB',
          files: 0,
          exists: false,
          error: error.message
        };
      }
    }
    
    // Analisar diretórios principais
    const dirsToCheck = [
      { name: 'uploads', path: './uploads' },
      { name: 'tokens', path: './tokens' },
      { name: 'browser-data', path: './browser-data' },
      { name: 'logs', path: './logs' },
      { name: 'node_modules', path: './node_modules' },
      { name: 'projeto_raiz', path: './' }
    ];
    
    for (const dir of dirsToCheck) {
      const dirAnalysis = calculateDirSize(path.resolve(dir.path), dir.name);
      analysis.directories.push(dirAnalysis);
      analysis.totalSize += dirAnalysis.size;
    }
    
    // Ordenar por tamanho (maior primeiro)
    analysis.directories.sort((a, b) => b.size - a.size);
    
    // Gerar recomendações
    analysis.directories.forEach(dir => {
      if (dir.size > 100 * 1024 * 1024) { // > 100MB
        if (dir.name === 'node_modules') {
          analysis.recommendations.push(`📦 ${dir.name}: ${dir.sizeFormatted} - Normal para dependências Node.js`);
        } else if (dir.name === 'browser-data') {
          analysis.recommendations.push(`🌐 ${dir.name}: ${dir.sizeFormatted} - Considere limpar dados antigos do browser`);
        } else if (dir.name === 'uploads') {
          analysis.recommendations.push(`📁 ${dir.name}: ${dir.sizeFormatted} - Muitos arquivos de mídia, considere limpeza`);
        } else {
          analysis.recommendations.push(`📊 ${dir.name}: ${dir.sizeFormatted} - Verificar conteúdo`);
        }
      }
    });
    
    // Verificar espaço livre do sistema (Windows)
    try {
      const { execSync } = require('child_process');
      let diskInfo = 'Informações do disco não disponíveis';
      
      if (process.platform === 'win32') {
        diskInfo = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf8' });
      }
      
      analysis.systemDiskInfo = diskInfo;
    } catch (diskError) {
      analysis.systemDiskInfo = 'Não foi possível obter informações do disco: ' + diskError.message;
    }
    
    analysis.totalSizeFormatted = `${(analysis.totalSize / 1024 / 1024).toFixed(2)}MB`;
    
    res.json({
      success: true,
      analysis,
      message: `Análise concluída. Total analisado: ${analysis.totalSizeFormatted}`
    });
    
  } catch (error) {
    console.error('Erro na análise de disco:', error);
    res.status(500).json({ 
      error: 'Erro na análise',
      details: error.message 
    });
  }
});

app.post('/api/system/cleanup-uploads-aggressive', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    
    const { olderThanDays = 7, confirmCleanup = false } = req.body;
    
    if (!confirmCleanup) {
      return res.status(400).json({ error: 'Confirmação obrigatória para limpeza agressiva' });
    }
    
    const fs = require('fs');
    const path = require('path');
    const uploadsDir = path.resolve('./uploads');
    
    let totalFreed = 0;
    let filesRemoved = 0;
    const removedFiles = [];
    
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const cutoffDate = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
      
      console.log(`🧹 Iniciando limpeza agressiva de uploads (> ${olderThanDays} dias)...`);
      
      for (const file of files) {
        const filePath = path.join(uploadsDir, file);
        
        try {
          const stats = fs.statSync(filePath);
          
          // Remover arquivos antigos
          if (stats.mtime.getTime() < cutoffDate) {
            const size = stats.size;
            fs.unlinkSync(filePath);
            
            totalFreed += size;
            filesRemoved++;
            removedFiles.push({
              name: file,
              size: `${(size/1024/1024).toFixed(2)}MB`,
              age: `${Math.floor((Date.now() - stats.mtime.getTime()) / (24*60*60*1000))} dias`
            });
            
            if (filesRemoved % 50 === 0) {
              console.log(`🗑️ ${filesRemoved} arquivos removidos...`);
            }
          }
        } catch (fileError) {
          console.error(`Erro ao processar ${file}:`, fileError.message);
        }
      }
    }
    
    // Limpeza de browser-data antigo
    const browserDataDir = path.resolve('./browser-data');
    if (fs.existsSync(browserDataDir)) {
      const sessions = fs.readdirSync(browserDataDir);
      
      for (const session of sessions) {
        const sessionPath = path.join(browserDataDir, session);
        
        try {
          // Verificar se sessão ainda existe no banco
          const dbSession = await db.query('SELECT id FROM sessions WHERE name = ?', [session]);
          
          if (dbSession.length === 0) {
            // Sessão órfã - remover
            const size = getDirSize(sessionPath);
            fs.rmSync(sessionPath, { recursive: true, force: true });
            totalFreed += size;
            removedFiles.push({
              name: `browser-data/${session}`,
              size: `${(size/1024/1024).toFixed(2)}MB`,
              age: 'sessão órfã'
            });
          }
        } catch (sessionError) {
          console.error(`Erro ao processar sessão ${session}:`, sessionError.message);
        }
      }
    }
    
    const totalFreedMB = (totalFreed / 1024 / 1024).toFixed(2);
    
    console.log(`✅ Limpeza agressiva concluída: ${filesRemoved} arquivos, ${totalFreedMB}MB liberados`);
    
    res.json({
      success: true,
      message: `Limpeza concluída! ${filesRemoved} arquivos removidos, ${totalFreedMB}MB liberados`,
      filesRemoved,
      totalFreedMB: `${totalFreedMB}MB`,
      removedFiles: removedFiles.slice(0, 10), // Mostrar apenas os primeiros 10
      totalRemovedFiles: removedFiles.length
    });
    
  } catch (error) {
    console.error('Erro na limpeza agressiva:', error);
    res.status(500).json({ 
      error: 'Erro na limpeza agressiva',
      details: error.message 
    });
  }
});

// Configurar limpeza automática
app.post('/api/system/auto-cleanup-config', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    
    const { 
      enabled = true,
      maxUploadsSize = 500, // MB
      maxUploadAge = 30, // dias
      maxLogSize = 100, // MB
      cleanupHour = 3, // 3h da manhã
      notifyAdmin = true
    } = req.body;
    
    // Salvar configurações no banco
    await db.settings.set('auto_cleanup_enabled', enabled, 'boolean', 'Limpeza automática habilitada');
    await db.settings.set('auto_cleanup_max_uploads_size', maxUploadsSize, 'number', 'Tamanho máximo da pasta uploads (MB)');
    await db.settings.set('auto_cleanup_max_upload_age', maxUploadAge, 'number', 'Idade máxima dos uploads (dias)');
    await db.settings.set('auto_cleanup_max_log_size', maxLogSize, 'number', 'Tamanho máximo dos logs (MB)');
    await db.settings.set('auto_cleanup_hour', cleanupHour, 'number', 'Hora para executar limpeza (0-23)');
    await db.settings.set('auto_cleanup_notify', notifyAdmin, 'boolean', 'Notificar admin sobre limpeza');
    
    res.json({
      success: true,
      message: 'Configurações de limpeza automática salvas',
      config: { enabled, maxUploadsSize, maxUploadAge, maxLogSize, cleanupHour, notifyAdmin }
    });
    
  } catch (error) {
    console.error('Erro ao configurar limpeza automática:', error);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

// Obter configurações de limpeza automática
app.get('/api/system/auto-cleanup-config', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    
    const config = {
      enabled: await db.settings.get('auto_cleanup_enabled') || true,
      maxUploadsSize: await db.settings.get('auto_cleanup_max_uploads_size') || 500,
      maxUploadAge: await db.settings.get('auto_cleanup_max_upload_age') || 30,
      maxLogSize: await db.settings.get('auto_cleanup_max_log_size') || 100,
      cleanupHour: await db.settings.get('auto_cleanup_hour') || 3,
      notifyAdmin: await db.settings.get('auto_cleanup_notify') || true
    };
    
    res.json({ success: true, config });
    
  } catch (error) {
    console.error('Erro ao obter configurações:', error);
    res.status(500).json({ error: 'Erro ao carregar configurações' });
  }
});

// Executar limpeza automática agora (teste)
app.post('/api/system/auto-cleanup-run', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    
    const result = await executeAutoCleanup();
    
    res.json({
      success: true,
      message: 'Limpeza automática executada',
      result
    });
    
  } catch (error) {
    console.error('Erro na limpeza automática:', error);
    res.status(500).json({ error: 'Erro na limpeza automática' });
  }
});

// Corrigir nomes de contatos
app.post('/api/contacts/fix-names', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    
    // Buscar contatos com nomes que são números
    const badNames = await db.query(`
      SELECT id, number, name 
      FROM contacts 
      WHERE name REGEXP '^[+]?[0-9 ()-]+$' 
         OR name = number 
         OR name IS NULL
      LIMIT 500
    `);
    
    let fixed = 0;
    
    for (const contact of badNames) {
      // Extrair número limpo do WhatsApp ID
      const cleanNumber = contact.number.replace('@c.us', '');
      let newName = cleanNumber;
      
      // Tentar formatar como telefone brasileiro
      if (cleanNumber.startsWith('55') && cleanNumber.length >= 12) {
        const ddd = cleanNumber.substring(2, 4);
        const numero = cleanNumber.substring(4);
        
        if (numero.length === 9) {
          newName = `+55 ${ddd} 9${numero.substring(1, 5)}-${numero.substring(5)}`;
        } else if (numero.length === 8) {
          newName = `+55 ${ddd} ${numero.substring(0, 4)}-${numero.substring(4)}`;
        }
      }
      
      if (newName !== contact.name) {
        await db.contacts.update(contact.id, { name: newName });
        fixed++;
      }
    }
    
    res.json({
      success: true,
      message: `${fixed} nomes de contatos corrigidos`,
      fixed
    });
    
  } catch (error) {
    console.error('Erro ao corrigir nomes:', error);
    res.status(500).json({ error: 'Erro ao corrigir nomes' });
  }
});

// Função auxiliar para calcular tamanho de diretório
function getDirSize(dirPath) {
  let size = 0;
  const fs = require('fs');
  const path = require('path');
  
  try {
    const files = fs.readdirSync(dirPath);
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        size += getDirSize(filePath);
      } else {
        size += stats.size;
      }
    }
  } catch (error) {
    console.error('Erro ao calcular tamanho:', error);
  }
  
  return size;
}

// ===========================================
// ROTAS API - DASHBOARD ESTATÍSTICAS - VERSÃO CORRIGIDA
// ===========================================

// Estatísticas gerais do dashboard
app.get('/api/dashboard/stats', async (req, res) => {
  try {
    const { days = 7, sector } = req.query;
    const userId = req.session.user.id;
    const userRole = req.session.user.role;
    
    console.log('📊 Carregando estatísticas:', { days, sector, userRole });
    
    // Filtros de setor
    let sectorCondition = '';
    let params = [];
    
    if (sector && sector !== '' && sector !== 'all') {
      sectorCondition = ' AND q.sector = ?';
      params.push(sector);
    }
    
    // Filtros por usuário (se atendente)
    let userCondition = '';
    if (userRole === 'atendente') {
      userCondition = ' AND q.user_id = ?';
      params.push(userId);
    }
    
    // ESTATÍSTICAS GERAIS (período completo)
    const generalStatsQuery = `
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN q.status = 'finished' THEN 1 END) as finished,
        AVG(CASE 
          WHEN q.status = 'finished' AND q.started_at IS NOT NULL AND q.finished_at IS NOT NULL 
          THEN TIMESTAMPDIFF(MINUTE, q.started_at, q.finished_at) 
        END) as avgTime
      FROM queues q
      WHERE q.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${sectorCondition} ${userCondition}
    `;
    
    const generalParams = [parseInt(days), ...params];
    const [generalStats] = await db.query(generalStatsQuery, generalParams);
    
    // ESTATÍSTICAS DE HOJE
    const todayStatsQuery = `
      SELECT 
        COUNT(*) as todayTotal,
        COUNT(CASE WHEN q.status = 'finished' THEN 1 END) as todayFinished,
        AVG(CASE 
          WHEN q.status = 'finished' AND q.started_at IS NOT NULL AND q.finished_at IS NOT NULL 
          THEN TIMESTAMPDIFF(MINUTE, q.started_at, q.finished_at) 
        END) as todayAvgTime
      FROM queues q
      WHERE DATE(q.created_at) = CURDATE() ${sectorCondition} ${userCondition}
    `;
    
    const [todayStats] = await db.query(todayStatsQuery, params);
    
    // ATENDIMENTOS POR USUÁRIO (período completo)
    const byUserQuery = `
      SELECT 
        u.name,
        COUNT(*) as count,
        COUNT(CASE WHEN q.status = 'finished' THEN 1 END) as finished
      FROM queues q
      JOIN users u ON q.user_id = u.id
      WHERE q.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) 
        AND q.user_id IS NOT NULL ${sectorCondition} ${userCondition}
      GROUP BY u.id, u.name
      ORDER BY finished DESC, count DESC
    `;
    
    const byUser = await db.query(byUserQuery, generalParams);
    
    // Montar resposta final
    const stats = {
      total: generalStats.total || 0,
      avgTime: Math.round(generalStats.avgTime || 0),
      todayTotal: todayStats.todayTotal || 0,
      todayFinished: todayStats.todayFinished || 0,
      todayAvgTime: Math.round(todayStats.todayAvgTime || 0),
      byUser: byUser || []
    };
    
    console.log('📊 Estatísticas calculadas:', stats);
    
    res.json(stats);
  } catch (error) {
    console.error('Erro ao obter estatísticas do dashboard:', error);
    res.status(500).json({ error: 'Erro ao obter estatísticas' });
  }
});

// Atendimentos por dia (para gráfico) - VERSÃO CORRIGIDA
app.get('/api/dashboard/daily-stats', async (req, res) => {
  try {
    const { days = 7, sector } = req.query;
    const userId = req.session.user.id;
    const userRole = req.session.user.role;
    
    console.log('📈 Carregando estatísticas diárias:', { days, sector, userRole });
    
    // Filtros
    let sectorCondition = '';
    let params = [parseInt(days)];
    
    if (sector && sector !== '' && sector !== 'all') {
      sectorCondition = ' AND q.sector = ?';
      params.push(sector);
    }
    
    let userCondition = '';
    if (userRole === 'atendente') {
      userCondition = ' AND q.user_id = ?';
      params.push(userId);
    }
    
    const query = `
      SELECT 
        DATE(q.created_at) as date,
        COUNT(*) as total,
        COUNT(CASE WHEN q.status = 'finished' THEN 1 END) as finished,
        AVG(CASE 
          WHEN q.status = 'finished' AND q.started_at IS NOT NULL AND q.finished_at IS NOT NULL 
          THEN TIMESTAMPDIFF(MINUTE, q.started_at, q.finished_at) 
        END) as avg_time
      FROM queues q
      WHERE q.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${sectorCondition} ${userCondition}
      GROUP BY DATE(q.created_at)
      ORDER BY date ASC
    `;

    const results = await db.query(query, params);
    
    // Preencher dias sem dados
    const dailyStats = [];
    for (let i = parseInt(days) - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      
      const dayData = results.find(r => r.date && r.date.toISOString().split('T')[0] === dateStr);
      
      dailyStats.push({
        date: dateStr,
        dateFormatted: date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        total: dayData ? dayData.total : 0,
        finished: dayData ? dayData.finished : 0,
        avgTime: dayData ? Math.round(dayData.avg_time || 0) : 0
      });
    }

    console.log('📈 Estatísticas diárias calculadas:', dailyStats.length, 'dias');
    
    res.json(dailyStats);
  } catch (error) {
    console.error('Erro ao obter estatísticas diárias:', error);
    res.status(500).json({ error: 'Erro ao obter estatísticas diárias' });
  }
});

// Ranking de atendentes - VERSÃO CORRIGIDA
app.get('/api/dashboard/agents-ranking', async (req, res) => {
  try {
    const { days = 7, sector } = req.query;
    const userId = req.session.user.id;
    const userRole = req.session.user.role;
    
    console.log('🏆 Carregando ranking de atendentes:', { days, sector, userRole });
    
    // Filtros
    let sectorCondition = '';
    let params = [parseInt(days)];
    
    if (sector && sector !== '' && sector !== 'all') {
      sectorCondition = ' AND q.sector = ?';
      params.push(sector);
    }
    
    let userCondition = '';
    if (userRole === 'atendente') {
      userCondition = ' AND q.user_id = ?';
      params.push(userId);
    }

    const query = `
      SELECT 
        u.name,
        u.sector,
        COUNT(*) as total_chats,
        COUNT(CASE WHEN q.status = 'finished' THEN 1 END) as finished_chats,
        AVG(CASE 
          WHEN q.status = 'finished' AND q.started_at IS NOT NULL AND q.finished_at IS NOT NULL 
          THEN TIMESTAMPDIFF(MINUTE, q.started_at, q.finished_at) 
        END) as avg_time,
        AVG(CASE 
          WHEN q.started_at IS NOT NULL 
          THEN TIMESTAMPDIFF(MINUTE, q.created_at, q.started_at) 
        END) as avg_wait_time
      FROM queues q
      JOIN users u ON q.user_id = u.id
      WHERE q.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) 
        AND q.user_id IS NOT NULL ${sectorCondition} ${userCondition}
      GROUP BY u.id, u.name, u.sector
      HAVING total_chats > 0
      ORDER BY finished_chats DESC, total_chats DESC, avg_time ASC
      LIMIT 20
    `;

    const results = await db.query(query, params);
    
    const ranking = results.map(agent => ({
      name: agent.name,
      sector: agent.sector,
      totalChats: agent.total_chats,
      finishedChats: agent.finished_chats,
      avgTime: Math.round(agent.avg_time || 0),
      avgWaitTime: Math.round(agent.avg_wait_time || 0),
      efficiency: agent.total_chats > 0 ? Math.round((agent.finished_chats / agent.total_chats) * 100) : 0
    }));
    
    console.log('🏆 Ranking calculado:', ranking.length, 'atendentes');
    
    res.json(ranking);
  } catch (error) {
    console.error('Erro ao obter ranking de atendentes:', error);
    res.status(500).json({ error: 'Erro ao obter ranking' });
  }
});

// Top tags utilizadas - VERSÃO CORRIGIDA
app.get('/api/dashboard/top-tags', async (req, res) => {
  try {
    const { limit = 5, sector } = req.query;
    
    console.log('🏷️ Carregando top tags:', { limit, sector });
    
    let sectorCondition = '';
    let params = [parseInt(limit)];
    
    if (sector && sector !== '' && sector !== 'all') {
      sectorCondition = 'AND (ct.sector = ? OR ct.sector IS NULL)';
      params.push(sector);
    }

    const query = `
      SELECT 
        ct.name,
        ct.color,
        ct.sector,
        COUNT(ctr.contact_id) as usage_count
      FROM contact_tags ct
      LEFT JOIN contact_tag_relations ctr ON ct.id = ctr.tag_id
      WHERE 1=1 ${sectorCondition}
      GROUP BY ct.id, ct.name, ct.color, ct.sector
      HAVING usage_count > 0
      ORDER BY usage_count DESC
      LIMIT ?
    `;

    const results = await db.query(query, params);
    
    console.log('🏷️ Top tags calculadas:', results.length, 'tags');
    
    res.json(results);
  } catch (error) {
    console.error('Erro ao obter top tags:', error);
    res.status(500).json({ error: 'Erro ao obter tags' });
  }
});

// ===========================================
// ROTAS API - CONFIGURAÇÕES DE HORÁRIO COMERCIAL
// ===========================================

// Obter configurações de horário comercial
app.get('/api/business-hours/settings', authMiddleware, async (req, res) => {
  try {
    // Apenas supervisores e admins podem ver configurações
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão para visualizar configurações' });
    }
    
    const settings = await db.settings.list('business_hours');
    
    // Formatar resposta
    const response = {
      enabled: settings.business_hours_enabled?.value || false,
      schedule: settings.business_hours_schedule?.value || {},
      message: settings.business_hours_message?.value || '',
      holidays: settings.business_hours_holidays?.value || [],
      exceptions: settings.business_hours_exceptions?.value || []
    };
    
    res.json(response);
  } catch (error) {
    console.error('Erro ao obter configurações de horário:', error);
    res.status(500).json({ error: 'Erro ao carregar configurações' });
  }
});

// Atualizar configurações de horário comercial
app.post('/api/business-hours/settings', authMiddleware, async (req, res) => {
  try {
    // Apenas admins podem alterar configurações
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem alterar configurações' });
    }
    
    const { enabled, schedule, message, holidays, exceptions } = req.body;
    
    // Validar dados
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Campo "enabled" deve ser boolean' });
    }
    
    if (!schedule || typeof schedule !== 'object') {
      return res.status(400).json({ error: 'Campo "schedule" é obrigatório' });
    }
    
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Campo "message" é obrigatório' });
    }
    
    // Salvar configurações
    await db.settings.set('business_hours_enabled', enabled, 'boolean', 'Habilitar auto-resposta fora do horário');
    await db.settings.set('business_hours_schedule', schedule, 'json', 'Horários de funcionamento por dia da semana');
    await db.settings.set('business_hours_message', message, 'string', 'Mensagem enviada fora do horário comercial');
    await db.settings.set('business_hours_holidays', holidays || [], 'json', 'Lista de feriados');
    await db.settings.set('business_hours_exceptions', exceptions || [], 'json', 'Exceções de horário');
    
    res.json({ success: true, message: 'Configurações salvas com sucesso!' });
    
  } catch (error) {
    console.error('Erro ao salvar configurações:', error);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

// Verificar status atual do horário comercial
app.get('/api/business-hours/status', authMiddleware, async (req, res) => {
  try {
    const { businessHoursHelpers } = require('./auth');
    
    const isBusinessTime = await businessHoursHelpers.isBusinessHours();
    const nextHours = await businessHoursHelpers.getNextBusinessHours();
    
    res.json({
      isBusinessTime,
      nextBusinessHours: nextHours,
      currentTime: new Date().toLocaleString('pt-BR'),
      enabled: await db.settings.get('business_hours_enabled') || false
    });
    
  } catch (error) {
    console.error('Erro ao verificar status:', error);
    res.status(500).json({ error: 'Erro ao verificar status' });
  }
});

// Testar mensagem de horário comercial
app.post('/api/business-hours/test-message', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem testar mensagens' });
    }
    
    const { businessHoursHelpers } = require('./auth');
    const { message } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Campo "message" é obrigatório' });
    }
    
    const processedMessage = await businessHoursHelpers.processBusinessHoursMessage(message);
    
    res.json({ 
      success: true, 
      originalMessage: message,
      processedMessage 
    });
    
  } catch (error) {
    console.error('Erro ao testar mensagem:', error);
    res.status(500).json({ error: 'Erro ao processar mensagem' });
  }
});

// ===========================================
// ROTAS API - MENSAGENS AUTOMÁTICAS
// ===========================================

// Obter configurações de mensagens automáticas
app.get('/api/auto-messages/settings', authMiddleware, async (req, res) => {
  try {
    // Apenas supervisores e admins podem ver configurações
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão para visualizar configurações' });
    }
    
    // Usar o novo método simplificado
    const settings = await db.settings.getAutoMessages();
    
    res.json(settings);
    
  } catch (error) {
    console.error('Erro ao obter configurações de mensagens automáticas:', error);
    res.status(500).json({ error: 'Erro ao carregar configurações' });
  }
});

// Salvar configurações de mensagens automáticas
app.post('/api/auto-messages/settings', authMiddleware, async (req, res) => {
  try {
    // Apenas admins podem alterar configurações
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem alterar configurações' });
    }
    
    const { welcome, goodbye, polls, advanced } = req.body;
    
    // Validar dados obrigatórios
    if (!welcome || !goodbye || !polls || !advanced) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }
    
    if (!welcome.message || !welcome.message.trim()) {
      return res.status(400).json({ error: 'Mensagem de boas-vindas é obrigatória' });
    }
    
    if (!goodbye.message || !goodbye.message.trim()) {
      return res.status(400).json({ error: 'Mensagem de despedida é obrigatória' });
    }
    
    // Salvar configurações de boas-vindas
    await db.settings.set('auto_welcome_enabled', welcome.enabled, 'boolean', 'Habilitar mensagem automática de boas-vindas');
    await db.settings.set('auto_welcome_message', welcome.message.trim(), 'string', 'Mensagem de boas-vindas');
    
    // Salvar configurações de despedida
    await db.settings.set('auto_goodbye_enabled', goodbye.enabled, 'boolean', 'Habilitar mensagem automática de despedida');
    await db.settings.set('auto_goodbye_message', goodbye.message.trim(), 'string', 'Mensagem de despedida');
    await db.settings.set('auto_goodbye_signature', goodbye.includeSignature, 'boolean', 'Incluir assinatura do atendente');
    await db.settings.set('auto_goodbye_rating', goodbye.includeRating, 'boolean', 'Incluir pedido de avaliação');
    
    // Salvar configurações de enquetes
    await db.settings.set('polls_auto_save', polls.autoSave, 'boolean', 'Salvar enquetes automaticamente');
    await db.settings.set('polls_auto_expire', polls.autoExpire, 'boolean', 'Expirar enquetes automaticamente');
    await db.settings.set('polls_expire_time', parseInt(polls.expireTime) || 24, 'number', 'Tempo para expirar (horas)');
    await db.settings.set('polls_expire_action', polls.expireAction, 'string', 'Ação ao expirar');
    await db.settings.set('polls_notify_response', polls.notifyResponse, 'boolean', 'Notificar respostas');
    await db.settings.set('polls_notify_completion', polls.notifyCompletion, 'boolean', 'Notificar conclusão');
    await db.settings.set('polls_auto_confirm', polls.autoConfirm, 'boolean', 'Confirmar respostas automaticamente');
    
    // Salvar configurações avançadas
    await db.settings.set('auto_message_delay', parseInt(advanced.messageDelay) || 2, 'number', 'Delay entre mensagens (segundos)');
    await db.settings.set('auto_prevent_spam', advanced.preventSpam, 'boolean', 'Prevenir spam');
    await db.settings.set('auto_spam_interval', parseInt(advanced.spamInterval) || 5, 'number', 'Intervalo anti-spam (minutos)');
    await db.settings.set('auto_log_messages', advanced.logMessages, 'boolean', 'Registrar mensagens automáticas');
    await db.settings.set('auto_show_signature', advanced.showAutoSignature, 'boolean', 'Mostrar assinatura automática');
    
    res.json({ success: true, message: 'Configurações de mensagens automáticas salvas com sucesso!' });
    
  } catch (error) {
    console.error('Erro ao salvar configurações de mensagens automáticas:', error);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

// Testar mensagem automática
app.post('/api/auto-messages/test', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const { type, message, contactId } = req.body;
    
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }
    
    // Buscar contato ou usar dados de exemplo
    let contact = {
      name: 'João Silva',
      number: '5511999999999@c.us'
    };
    
    if (contactId) {
      const realContact = await db.query('SELECT * FROM contacts WHERE id = ?', [contactId]);
      if (realContact.length > 0) {
        contact = realContact[0];
      }
    }
    
    // Processar variáveis na mensagem
    const processedMessage = messageHelpers.formatMessage(message, {
      nome: contact.name || contact.number.split('@')[0],
      saudacao: getGreeting()
    });
    
    res.json({
      success: true,
      originalMessage: message,
      processedMessage: processedMessage,
      usedContact: contact
    });
    
  } catch (error) {
    console.error('Erro ao testar mensagem automática:', error);
    res.status(500).json({ error: 'Erro ao testar mensagem' });
  }
});

// ===========================================
// ROTAS API - RELOAD DE CONFIGURAÇÕES
// ===========================================

// Recarregar configurações sem reiniciar
app.post('/api/system/reload-config', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem recarregar configurações' });
    }
    
    // Limpar cache de configurações
    if (cache && cache.stats) {
      cache.stats.flushAll();
    }
    
    console.log('🔄 Configurações recarregadas por:', req.session.user.name);
    
    // Notificar clientes conectados via socket
    if (global.io) {
      global.io.emit('config:reloaded', {
        message: 'Configurações atualizadas',
        timestamp: new Date()
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Configurações recarregadas! As próximas verificações usarão os novos valores.'
    });
    
  } catch (error) {
    console.error('Erro ao recarregar configurações:', error);
    res.status(500).json({ error: 'Erro ao recarregar configurações' });
  }
});

// **NOVAS ROTAS ADICIONADAS**

// Obter variáveis disponíveis para mensagens automáticas
app.get('/api/auto-messages/variables', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    
    const variables = {
      nome: {
        description: 'Nome do contato',
        example: 'João Silva',
        value: '{{nome}}',
        category: 'contato'
      },
      saudacao: {
        description: 'Saudação automática baseada no horário',
        example: getGreeting(),
        value: '{{saudacao}}',
        category: 'sistema'
      },
      data: {
        description: 'Data atual',
        example: now.toLocaleDateString('pt-BR'),
        value: '{{data}}',
        category: 'data'
      },
      hora: {
        description: 'Hora atual',
        example: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        value: '{{hora}}',
        category: 'data'
      },
      dia_semana: {
        description: 'Dia da semana atual',
        example: now.toLocaleDateString('pt-BR', { weekday: 'long' }),
        value: '{{dia_semana}}',
        category: 'data'
      },
      mes: {
        description: 'Mês atual',
        example: now.toLocaleDateString('pt-BR', { month: 'long' }),
        value: '{{mes}}',
        category: 'data'
      },
      ano: {
        description: 'Ano atual',
        example: now.getFullYear().toString(),
        value: '{{ano}}',
        category: 'data'
      },
      numero: {
        description: 'Número do WhatsApp do contato',
        example: '5511999999999@c.us',
        value: '{{numero}}',
        category: 'contato'
      },
      telefone: {
        description: 'Telefone formatado',
        example: '(11) 99999-9999',
        value: '{{telefone}}',
        category: 'contato'
      }
    };
    
    res.json(variables);
    
  } catch (error) {
    console.error('Erro ao obter variáveis:', error);
    res.status(500).json({ error: 'Erro ao carregar variáveis' });
  }
});

// Obter templates predefinidos para mensagens automáticas
app.get('/api/auto-messages/templates', authMiddleware, async (req, res) => {
  try {
    const templates = {
      pharmacy: {
        name: 'Farmácia',
        description: 'Templates específicos para farmácias',
        welcome: {
          business: '🏥 {{saudacao}}! Bem-vindo à nossa farmácia. Como posso ajudá-lo hoje?',
          afterHours: '🌙 Nossa farmácia está fechada. Horário: Segunda a Sexta 8h-18h, Sábado 8h-12h. Retornaremos assim que possível!'
        },
        goodbye: '💊 Obrigado por escolher nossa farmácia! Sua saúde é nossa prioridade. Volte sempre!',
        category: 'setor'
      },
      formal: {
        name: 'Formal',
        description: 'Linguagem formal e profissional',
        welcome: {
          business: 'Prezado {{nome}}, {{saudacao}}. Agradecemos o seu contato. Em breve um de nossos atendentes especializados irá atendê-lo.',
          afterHours: 'Prezado cliente, nosso horário de atendimento é de segunda a sexta das 8h às 18h. Sua mensagem foi registrada.'
        },
        goodbye: 'Agradecemos a preferência e permanecemos à disposição para futuros esclarecimentos.',
        category: 'estilo'
      },
      casual: {
        name: 'Casual',
        description: 'Linguagem descontraída e amigável',
        welcome: {
          business: 'Oi {{nome}}! 😊 {{saudacao}}! Que bom ter você aqui! Vou te ajudar no que precisar!',
          afterHours: 'Oi! 😴 Estou fora do ar agora, mas volto amanhã cedo! Te respondo assim que der!'
        },
        goodbye: 'Valeu pelo papo, {{nome}}! 😄 Qualquer coisa, é só chamar! Até mais! 👋',
        category: 'estilo'
      },
      minimal: {
        name: 'Minimalista',
        description: 'Mensagens curtas e diretas',
        welcome: {
          business: '{{saudacao}}, {{nome}}! Como posso ajudar?',
          afterHours: 'Fora do horário. Retorno em breve.'
        },
        goodbye: 'Obrigado, {{nome}}! Até logo.',
        category: 'estilo'
      },
      ecommerce: {
        name: 'E-commerce',
        description: 'Para lojas virtuais e vendas',
        welcome: {
          business: '🛒 {{saudacao}}, {{nome}}! Bem-vindo à nossa loja! Posso ajudar com algum produto?',
          afterHours: '🕐 Nossa loja está fechada, mas você pode navegar pelo nosso catálogo! Retornaremos em {{data}}.'
        },
        goodbye: '🛍️ Obrigado pela compra, {{nome}}! Acompanhe seu pedido e volte sempre!',
        category: 'setor'
      },
      support: {
        name: 'Suporte Técnico',
        description: 'Para atendimento técnico e suporte',
        welcome: {
          business: '🔧 {{saudacao}}, {{nome}}! Suporte técnico à disposição. Qual problema posso ajudar a resolver?',
          afterHours: '⏰ Suporte fora do horário. Horário: {{dia_semana}} das 8h às 18h. Registramos sua solicitação.'
        },
        goodbye: '✅ Problema resolvido, {{nome}}! Se precisar de mais ajuda, estaremos aqui!',
        category: 'setor'
      }
    };
    
    res.json(templates);
    
  } catch (error) {
    console.error('Erro ao obter templates:', error);
    res.status(500).json({ error: 'Erro ao carregar templates' });
  }
});

// Aplicar template em mensagens automáticas
app.post('/api/auto-messages/apply-template', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem aplicar templates' });
    }
    
    const { templateKey, applyTo } = req.body;
    
    if (!templateKey) {
      return res.status(400).json({ error: 'Template é obrigatório' });
    }
    
    // Obter templates disponíveis
    const templatesResponse = await fetch(`${req.protocol}://${req.get('host')}/api/auto-messages/templates`, {
      headers: { 'Authorization': req.headers.authorization }
    });
    const templates = await templatesResponse.json();
    
    const selectedTemplate = templates[templateKey];
    if (!selectedTemplate) {
      return res.status(404).json({ error: 'Template não encontrado' });
    }
    
    // Aplicar template baseado na seleção
    const updates = {};
    
    if (!applyTo || applyTo.includes('welcome')) {
      updates.auto_welcome_message = selectedTemplate.welcome.business;
      if (selectedTemplate.welcome.afterHours) {
        updates.auto_welcome_after_hours = selectedTemplate.welcome.afterHours;
      }
    }
    
    if (!applyTo || applyTo.includes('goodbye')) {
      updates.auto_goodbye_message = selectedTemplate.goodbye;
    }
    
    // Salvar atualizações
    for (const [key, value] of Object.entries(updates)) {
      await db.settings.set(key, value, 'string', `Template aplicado: ${selectedTemplate.name}`);
    }
    
    res.json({ 
      success: true, 
      message: `Template "${selectedTemplate.name}" aplicado com sucesso!`,
      appliedFields: Object.keys(updates)
    });
    
  } catch (error) {
    console.error('Erro ao aplicar template:', error);
    res.status(500).json({ error: 'Erro ao aplicar template' });
  }
});

// Função auxiliar para obter saudação
function getGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

// ===========================================
// ROTAS API - DISPAROS POR TAGS
// ===========================================

// Listar campanhas de disparo
app.get('/api/campaigns', authMiddleware, async (req, res) => {
  try {
    // Apenas supervisores e admins podem acessar campanhas
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão para acessar campanhas' });
    }
    
    console.log('📋 Carregando lista de campanhas...');
    
    // ✅ CORREÇÃO 1: Usar query direta em vez de db.campaigns.list()
    let campaigns = [];
    
    try {
      // Query direta para evitar problemas no db.campaigns.list()
      const campaignsRaw = await db.query(`
        SELECT c.*, u.name as created_by_name 
        FROM campaigns c 
        LEFT JOIN users u ON c.created_by = u.id 
        ORDER BY c.created_at DESC 
        LIMIT 50
      `);
      
      console.log('📋 Campanhas encontradas no banco:', campaignsRaw.length);
      
      // ✅ CORREÇÃO 2: Parse manual dos campos JSON
      campaigns = campaignsRaw.map(campaign => {
        // Parse target_tags
        if (campaign.target_tags && typeof campaign.target_tags === 'string') {
          try {
            campaign.target_tags = JSON.parse(campaign.target_tags);
          } catch (e) {
            console.error('Erro ao parsear target_tags:', e);
            campaign.target_tags = [];
          }
        } else {
          campaign.target_tags = campaign.target_tags || [];
        }
        
        // Parse target_sectors  
        if (campaign.target_sectors && typeof campaign.target_sectors === 'string') {
          try {
            campaign.target_sectors = JSON.parse(campaign.target_sectors);
          } catch (e) {
            console.error('Erro ao parsear target_sectors:', e);
            campaign.target_sectors = [];
          }
        } else {
          campaign.target_sectors = campaign.target_sectors || [];
        }
        
        return campaign;
      });
      
      console.log('📋 Campanhas processadas:', campaigns.length);
      
    } catch (queryError) {
      console.error('❌ Erro na query de campanhas:', queryError);
      
      // ✅ CORREÇÃO 3: Fallback - retornar array vazio em vez de falhar
      campaigns = [];
    }
    
    // ✅ CORREÇÃO 4: Adicionar estatísticas apenas se houver campanhas
    if (campaigns.length > 0) {
      try {
        for (const campaign of campaigns) {
          if (campaign.status !== 'draft') {
            try {
              campaign.stats = await db.campaigns.getStats(campaign.id);
            } catch (statsError) {
              console.error(`Erro ao obter stats da campanha ${campaign.id}:`, statsError);
              campaign.stats = { total: 0, sent: 0, failed: 0, pending: 0 };
            }
          }
        }
      } catch (statsError) {
        console.error('Erro ao processar estatísticas:', statsError);
        // Continuar sem as estatísticas
      }
    }
    
    console.log('✅ Lista de campanhas carregada com sucesso');
    res.json(campaigns);
    
  } catch (error) {
    console.error('❌ Erro geral ao listar campanhas:', error);
    console.error('❌ Stack trace:', error.stack);
    
    // ✅ CORREÇÃO 5: Sempre retornar uma resposta válida
    res.status(500).json({ 
      error: 'Erro ao carregar campanhas',
      campaigns: [], // Array vazio para o frontend não quebrar
      details: process.env.NODE_ENV === 'development' ? error.message : 'Erro interno'
    });
  }
});

// Obter contatos por tags/setores (para preview)
app.post('/api/campaigns/preview-contacts', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const { tags = [], sectors = [] } = req.body;
    
    if (tags.length === 0 && sectors.length === 0) {
      return res.json({ contacts: [], total: 0 });
    }
    
    const contacts = await db.campaigns.getTargetContacts(tags, sectors);
    
    // Buscar tags de cada contato para exibição
    for (const contact of contacts) {
      contact.tags = await db.tags.getByContact(contact.id);
    }
    
    res.json({
      contacts: contacts.slice(0, 10), // Mostrar apenas os primeiros 10 no preview
      total: contacts.length
    });
    
  } catch (error) {
    console.error('Erro ao obter preview de contatos:', error);
    res.status(500).json({ error: 'Erro ao carregar contatos' });
  }
});

// Criar nova campanha
app.post('/api/campaigns', upload.single('media'), authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão para criar campanhas' });
    }
    
    // Extrair dados do FormData corretamente
    const name = req.body.name;
    const content = req.body.content;
    const target_tags = req.body.target_tags;
    const target_sectors = req.body.target_sectors;
    const schedule_type = req.body.schedule_type;
    const scheduled_at = req.body.scheduled_at;
    
    console.log('🔍 BACKEND: Dados brutos recebidos do FormData:');
    console.log('- name:', name);
    console.log('- target_tags:', target_tags, typeof target_tags);
    console.log('- target_sectors:', target_sectors, typeof target_sectors);
    console.log('- schedule_type:', schedule_type);
    
    // Validações
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Nome da campanha é obrigatório' });
    }
    
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Conteúdo da mensagem é obrigatório' });
    }
    
    // Parse das tags e setores - VERSÃO CORRIGIDA
    let parsedTags = [];
    let parsedSectors = [];
    
    console.log('🔍 Dados recebidos do frontend:');
    console.log('target_tags:', target_tags, typeof target_tags);
    console.log('target_sectors:', target_sectors, typeof target_sectors);
    
    try {
      // Se target_tags for string, fazer parse JSON
      if (typeof target_tags === 'string') {
        parsedTags = target_tags ? JSON.parse(target_tags) : [];
      } else if (Array.isArray(target_tags)) {
        // Se já for array, usar diretamente
        parsedTags = target_tags;
      } else {
        parsedTags = [];
      }
      
      // Se target_sectors for string, fazer parse JSON  
      if (typeof target_sectors === 'string') {
        parsedSectors = target_sectors ? JSON.parse(target_sectors) : [];
      } else if (Array.isArray(target_sectors)) {
        // Se já for array, usar diretamente
        parsedSectors = target_sectors;
      } else {
        parsedSectors = [];
      }
      
      console.log('🔍 Após parse:');
      console.log('parsedTags:', parsedTags);
      console.log('parsedSectors:', parsedSectors);
      
    } catch (e) {
      console.error('Erro no parse:', e);
      return res.status(400).json({ error: 'Formato inválido de tags ou setores' });
    }
    
    if (parsedTags.length === 0 && parsedSectors.length === 0) {
      return res.status(400).json({ error: 'Selecione pelo menos uma tag ou setor' });
    }
    
    // Obter total de contatos
    const targetContacts = await db.campaigns.getTargetContacts(parsedTags, parsedSectors);
    
    if (targetContacts.length === 0) {
      return res.status(400).json({ error: 'Nenhum contato encontrado com as tags/setores selecionados' });
    }
    
    // Processar agendamento
    let scheduledDate = null;
    let status = 'draft';
    
    if (schedule_type === 'scheduled' && scheduled_at) {
      scheduledDate = new Date(scheduled_at);
      
      if (scheduledDate <= new Date()) {
        return res.status(400).json({ error: 'Data de agendamento deve ser no futuro' });
      }
      
      status = 'scheduled';
    }
    
    // Dados da campanha
    const campaignData = {
      name: name.trim(),
      content: content.trim(),
      media_url: req.file ? `/uploads/${req.file.filename}` : null,
      media_type: req.file ? uploadHelpers.getFileCategory(req.file.mimetype) : null,
      target_tags: parsedTags,
      target_sectors: parsedSectors,
      scheduled_at: scheduledDate,
      status,
      total_count: targetContacts.length,
      created_by: req.session.user.id
    };
    
    const campaignId = await db.campaigns.create(campaignData);
    
    // Se for disparo imediato, iniciar
    if (schedule_type === 'now') {
      await startCampaignDispatch(campaignId);
    }
    
    res.json({ 
      success: true, 
      campaignId,
      message: schedule_type === 'now' ? 
        'Campanha criada e disparo iniciado!' : 
        'Campanha criada com sucesso!'
    });
    
  } catch (error) {
    console.error('Erro ao criar campanha:', error);
    res.status(500).json({ error: 'Erro ao criar campanha: ' + error.message });
  }
});

// Iniciar disparo de campanha
app.post('/api/campaigns/:id/start', authMiddleware, async (req, res) => {
    try {
        console.log('🎯 ROTA START - Iniciando campanha ID:', req.params.id);
        console.log('🎯 ROTA START - Usuário:', req.session.user?.name, req.session.user?.role);
        console.log('🎯 ROTA START - Headers:', req.headers);
        
        // ===== VERIFICAÇÕES DE SEGURANÇA =====
        
        // 1. Verificar se usuário está autenticado
        if (!req.session.user) {
            console.log('🔴 ERRO: Usuário não autenticado');
            return res.status(401).json({ 
                error: 'Usuário não autenticado. Faça login novamente.' 
            });
        }
        
        // 2. Verificar permissões
        if (!['admin', 'supervisor'].includes(req.session.user.role)) {
            console.log('🔴 ERRO: Usuário sem permissão. Role:', req.session.user.role);
            return res.status(403).json({ 
                error: 'Sem permissão para iniciar campanhas. Função requerida: admin ou supervisor.' 
            });
        }
        
        // 3. Validar ID da campanha
        const campaignId = parseInt(req.params.id);
        if (isNaN(campaignId) || campaignId <= 0) {
            console.log('🔴 ERRO: ID da campanha inválido:', req.params.id);
            return res.status(400).json({ 
                error: 'ID da campanha inválido.' 
            });
        }
        
        console.log('🎯 ROTA START - Campaign ID validado:', campaignId);
        
        // ===== VERIFICAÇÕES DE PREREQUISITOS =====
        
        // 1. Verificar se campanha existe
        const campaign = await db.campaigns.findById(campaignId);
        if (!campaign) {
            console.log('🔴 ERRO: Campanha não encontrada:', campaignId);
            return res.status(404).json({ 
                error: 'Campanha não encontrada.' 
            });
        }
        
        console.log('🎯 ROTA START - Campanha encontrada:', campaign.name, 'Status:', campaign.status);
        
        // 2. Verificar se campanha pode ser iniciada
        if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
            console.log('🔴 ERRO: Status inválido para iniciar:', campaign.status);
            return res.status(400).json({ 
                error: `Campanha não pode ser iniciada. Status atual: ${campaign.status}` 
            });
        }
        
        // 3. Verificar se há sessão WhatsApp ativa
        const sessions = await db.sessions.list();
        const activeSession = sessions.find(s => s.status === 'connected');
        
        if (!activeSession) {
            console.log('🔴 ERRO: Nenhuma sessão WhatsApp ativa');
            console.log('🔴 Sessões disponíveis:', sessions.map(s => ({id: s.id, name: s.name, status: s.status})));
            return res.status(400).json({ 
                error: 'Nenhuma sessão WhatsApp conectada. Conecte um número primeiro.' 
            });
        }
        
        console.log('🎯 ROTA START - Sessão ativa encontrada:', activeSession.name);
        
        // 4. Verificar se há contatos para a campanha
        const targetContacts = await db.campaigns.getTargetContacts(
            campaign.target_tags || [], 
            campaign.target_sectors || []
        );
        
        if (targetContacts.length === 0) {
            console.log('🔴 ERRO: Nenhum contato encontrado');
            console.log('🔴 Tags:', campaign.target_tags);
            console.log('🔴 Setores:', campaign.target_sectors);
            return res.status(400).json({ 
                error: 'Nenhum contato encontrado com as tags/setores selecionados.' 
            });
        }
        
        console.log('🎯 ROTA START - Contatos encontrados:', targetContacts.length);
        
        // ===== INICIAR DISPARO =====
        
        console.log('🎯 ROTA START - Iniciando processo de disparo...');
        
        // Chamar função de disparo (sem await para não travar a resposta)
        startCampaignDispatch(campaignId).catch(error => {
            console.error('🔴 ERRO no processo de disparo:', error);
        });
        
        // Resposta imediata de sucesso
        console.log('🎯 ROTA START - Campanha iniciada com sucesso');
        res.json({ 
            success: true, 
            message: `Campanha "${campaign.name}" iniciada! ${targetContacts.length} contatos serão processados.`,
            campaignId: campaignId,
            totalContacts: targetContacts.length
        });
        
    } catch (error) {
        console.error('🔴 ERRO CRÍTICO na rota /campaigns/:id/start:', error);
        console.error('🔴 ERRO Stack:', error.stack);
        
        // Log adicional para debug
        console.error('🔴 ERRO Params:', req.params);
        console.error('🔴 ERRO Session:', req.session?.user);
        
        res.status(500).json({ 
            error: 'Erro interno do servidor ao iniciar campanha.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Pausar campanha
app.post('/api/campaigns/:id/pause', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const campaignId = parseInt(req.params.id);
    
    await db.campaigns.updateStatus(campaignId, 'paused');
    
    res.json({ success: true, message: 'Campanha pausada!' });
    
  } catch (error) {
    console.error('Erro ao pausar campanha:', error);
    res.status(500).json({ error: 'Erro ao pausar campanha' });
  }
});

// Cancelar campanha
app.post('/api/campaigns/:id/cancel', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const campaignId = parseInt(req.params.id);
    
    await db.campaigns.updateStatus(campaignId, 'cancelled');
    
    res.json({ success: true, message: 'Campanha cancelada!' });
    
  } catch (error) {
    console.error('Erro ao cancelar campanha:', error);
    res.status(500).json({ error: 'Erro ao cancelar campanha' });
  }
});

// Obter detalhes de uma campanha
app.get('/api/campaigns/:id', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const campaignId = parseInt(req.params.id);
    const campaign = await db.campaigns.findById(campaignId);
    
    if (!campaign) {
      return res.status(404).json({ error: 'Campanha não encontrada' });
    }
    
    // Buscar estatísticas
    const stats = await db.campaigns.getStats(campaignId);
    
    // Buscar logs recentes
    const logs = await db.campaignLogs.getByCampaign(campaignId, 50);
    
    res.json({
      campaign,
      stats,
      logs
    });
    
  } catch (error) {
    console.error('Erro ao obter detalhes da campanha:', error);
    res.status(500).json({ error: 'Erro ao carregar campanha' });
  }
});

// Obter estatísticas em tempo real
app.get('/api/campaigns/:id/stats', authMiddleware, async (req, res) => {
  try {
    const campaignId = parseInt(req.params.id);
    const stats = await db.campaigns.getStats(campaignId);
    
    res.json(stats);
    
  } catch (error) {
    console.error('Erro ao obter estatísticas:', error);
    res.status(500).json({ error: 'Erro ao carregar estatísticas' });
  }
});

// ===========================================
// ROTAS API ADICIONAIS - CAMPANHAS
// ===========================================
// Iniciar campanha da lista
async function startCampaign(campaignId) {
  try {
    console.log('🚀 INICIANDO CAMPANHA:', campaignId);
    
    if (!confirm('Deseja iniciar esta campanha agora?')) return;
    
    console.log('🚀 Enviando requisição para iniciar campanha...');
    
    const response = await $.post(`/api/campaigns/${campaignId}/start`);
    
    console.log('🚀 Resposta recebida:', response);
    
    showNotification('Iniciado', response.message, 'success');
    
    // Buscar nome da campanha
    const campaign = campaignsList.find(c => c.id === campaignId);
    if (campaign) {
      showProgressModal(campaignId, campaign.name);
    }
    
    loadCampaignsList();
    
  } catch (error) {
    console.error('🔴 ERRO COMPLETO ao iniciar campanha:', error);
    console.error('🔴 ERRO ResponseJSON:', error.responseJSON);
    console.error('🔴 ERRO Status:', error.status);
    console.error('🔴 ERRO Message:', error.statusText);
    showNotification('Erro', 'Falha ao iniciar campanha', 'error');
  }
}

// Testar mensagem de campanha com variáveis
app.post('/api/campaigns/test-message', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const { message, contactId } = req.body;
    const { campaignHelpers } = require('./auth');
    
    if (!message) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }
    
    // Buscar contato ou usar dados de exemplo
    let contact = {
      name: 'João Silva',
      number: '5511999999999@c.us'
    };
    
    if (contactId) {
      const realContact = await db.query('SELECT * FROM contacts WHERE id = ?', [contactId]);
      if (realContact.length > 0) {
        contact = realContact[0];
      }
    }
    
    const processedMessage = campaignHelpers.processMessageVariables(message, contact);
    
    res.json({
      success: true,
      originalMessage: message,
      processedMessage,
      usedContact: contact
    });
    
  } catch (error) {
    console.error('Erro ao testar mensagem de campanha:', error);
    res.status(500).json({ error: 'Erro ao processar mensagem' });
  }
});

// Duplicar campanha
app.post('/api/campaigns/:id/duplicate', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    const campaignId = parseInt(req.params.id);
    const originalCampaign = await db.campaigns.findById(campaignId);
    
    if (!originalCampaign) {
      return res.status(404).json({ error: 'Campanha não encontrada' });
    }
    
    // Criar nova campanha baseada na original
    const newCampaignData = {
      name: `${originalCampaign.name} (Cópia)`,
      content: originalCampaign.content,
      media_url: originalCampaign.media_url,
      media_type: originalCampaign.media_type,
      target_tags: originalCampaign.target_tags || [],
      target_sectors: originalCampaign.target_sectors || [],
      scheduled_at: null,
      status: 'draft',
      total_count: 0, // Será recalculado
      created_by: req.session.user.id
    };
    
    // Recalcular total de contatos
    const targetContacts = await db.campaigns.getTargetContacts(
      newCampaignData.target_tags,
      newCampaignData.target_sectors
    );
    newCampaignData.total_count = targetContacts.length;
    
    const newCampaignId = await db.campaigns.create(newCampaignData);
    
    res.json({
      success: true,
      campaignId: newCampaignId,
      message: 'Campanha duplicada com sucesso!'
    });
    
  } catch (error) {
    console.error('Erro ao duplicar campanha:', error);
    res.status(500).json({ error: 'Erro ao duplicar campanha' });
  }
});

// Excluir campanha
app.delete('/api/campaigns/:id', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem excluir campanhas' });
    }
    
    const campaignId = parseInt(req.params.id);
    const campaign = await db.campaigns.findById(campaignId);
    
    if (!campaign) {
      return res.status(404).json({ error: 'Campanha não encontrada' });
    }
    
    if (campaign.status === 'sending') {
      return res.status(400).json({ error: 'Não é possível excluir campanha em andamento' });
    }
    
    // Excluir logs da campanha
    await db.query('DELETE FROM campaign_logs WHERE campaign_id = ?', [campaignId]);
    
    // Excluir campanha
    await db.query('DELETE FROM campaigns WHERE id = ?', [campaignId]);
    
    // Excluir arquivo de mídia se existir
    if (campaign.media_url) {
      try {
        const fs = require('fs');
        const filePath = path.resolve('.' + campaign.media_url);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (fileError) {
        console.error('Erro ao excluir arquivo:', fileError);
      }
    }
    
    res.json({ success: true, message: 'Campanha excluída com sucesso!' });
    
  } catch (error) {
    console.error('Erro ao excluir campanha:', error);
    res.status(500).json({ error: 'Erro ao excluir campanha' });
  }
});

// Rotas de perfil - ADICIONAR após as outras rotas API
// Atualizar perfil do usuário
app.put('/api/profile', authMiddleware, async (req, res) => {
  try {
    const { name, email, sector, signature } = req.body;
    const userId = req.session.user.id;
    
    if (!name || !email) {
      return res.status(400).json({ error: 'Nome e email são obrigatórios' });
    }
    
    // Verificar se email já existe para outro usuário
    const existingUser = await db.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]);
    if (existingUser.length > 0) {
      return res.status(400).json({ error: 'Este email já está em uso por outro usuário' });
    }
    
    // Atualizar usuário
    await db.users.update(userId, { name, email, sector, signature });
    
    // Atualizar sessão
    req.session.user.name = name;
    req.session.user.email = email;
    req.session.user.sector = sector;
    req.session.user.signature = signature;
    
    res.json({ success: true, message: 'Perfil atualizado com sucesso' });
    
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Alterar senha
app.put('/api/profile/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.session.user.id;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias' });
    }
    
    // Buscar usuário
    const user = await db.users.findById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    // Verificar senha atual
    const bcrypt = require('bcryptjs');
    const validPassword = await bcrypt.compare(currentPassword, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Senha atual incorreta' });
    }
    
    // Atualizar senha
    await db.users.update(userId, { password: newPassword });
    
    res.json({ success: true, message: 'Senha alterada com sucesso' });
    
  } catch (error) {
    console.error('Erro ao alterar senha:', error);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ===========================================
// FUNÇÃO AUXILIAR - INICIAR DISPARO
// ===========================================

async function startCampaignDispatch(campaignId) {
  try {
    console.log(`🚀 startCampaignDispatch - Iniciando disparo da campanha ${campaignId}`);
    
    // Buscar campanha
    console.log(`🚀 startCampaignDispatch - Buscando campanha...`);
    const campaign = await db.campaigns.findById(campaignId);
    if (!campaign) {
      throw new Error('Campanha não encontrada');
    }
    
    console.log(`🚀 startCampaignDispatch - Campanha encontrada:`, campaign.name);
    console.log(`🚀 startCampaignDispatch - Status atual:`, campaign.status);
    
    if (campaign.status !== 'draft' && campaign.status !== 'scheduled') {
      throw new Error('Campanha não pode ser iniciada no status atual: ' + campaign.status);
    }
    
    // Buscar contatos alvo
    console.log(`🚀 startCampaignDispatch - Buscando contatos alvo...`);
    console.log(`🚀 startCampaignDispatch - Tags:`, campaign.target_tags);
    console.log(`🚀 startCampaignDispatch - Setores:`, campaign.target_sectors);
    
    const targetContacts = await db.campaigns.getTargetContacts(
      campaign.target_tags || [], 
      campaign.target_sectors || []
    );
    
    console.log(`🚀 startCampaignDispatch - Contatos encontrados: ${targetContacts.length}`);
    
    if (targetContacts.length === 0) {
      throw new Error('Nenhum contato encontrado');
    }
    
    // Atualizar status para "sending"
    console.log(`🚀 startCampaignDispatch - Atualizando status para sending...`);
    await db.campaigns.updateStatus(campaignId, 'sending');
    
    // Criar logs de envio para todos os contatos
    console.log(`🚀 startCampaignDispatch - Criando logs de envio...`);
    for (const contact of targetContacts) {
      // Processar variáveis na mensagem
      let processedContent = campaign.content
        .replace(/\{\{nome\}\}/g, contact.name || contact.number.split('@')[0])
        .replace(/\{\{numero\}\}/g, contact.number)
        .replace(/\{\{data\}\}/g, new Date().toLocaleDateString('pt-BR'))
        .replace(/\{\{hora\}\}/g, new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
      
      await db.campaignLogs.create({
        campaign_id: campaignId,
        contact_id: contact.id,
        contact_number: contact.number,
        contact_name: contact.name,
        message_content: processedContent,
        status: 'pending'
      });
    }
    
    console.log(`🚀 startCampaignDispatch - Logs criados, iniciando processo de envio...`);
    
    // Iniciar processo de envio em background
    processCampaignQueue(campaignId);
    
    console.log(`✅ startCampaignDispatch - Disparo da campanha ${campaignId} iniciado com sucesso`);
    
  } catch (error) {
    console.error(`❌ startCampaignDispatch - Erro ao iniciar disparo da campanha ${campaignId}:`, error);
    console.error(`❌ startCampaignDispatch - Stack:`, error.stack);
    await db.campaigns.updateStatus(campaignId, 'cancelled');
    throw error;
  }
}

// Processar fila de envios (background)
async function processCampaignQueue(campaignId) {
  console.log(`📤 Processando fila da campanha ${campaignId}`);
  
  // Configurações de rate limiting inteligente
  const BATCH_SIZE = 3; // Reduzido para evitar ban
  const MIN_DELAY = 8000; // 8 segundos entre envios
  const MAX_DELAY = 15000; // 15 segundos máximo
  
  // Função para delay dinâmico baseado no horário
  const getDynamicDelay = () => {
    const hour = new Date().getHours();
    const isBusinessHours = hour >= 8 && hour <= 18;
    const isWeekend = [0, 6].includes(new Date().getDay());
    
    // Mais devagar fora do horário comercial e fins de semana
    let baseDelay = MIN_DELAY;
    if (!isBusinessHours) baseDelay *= 1.5;
    if (isWeekend) baseDelay *= 2;
    
    const randomFactor = Math.random() * (MAX_DELAY - baseDelay);
    return Math.floor(baseDelay + randomFactor);
  };
  
  try {
    // Buscar campanha
    const campaign = await db.campaigns.findById(campaignId);
    if (!campaign || campaign.status !== 'sending') {
      console.log(`⏸️ Campanha ${campaignId} não está em status de envio`);
      return;
    }
    
    // Buscar sessão WhatsApp ativa
    const sessions = await db.sessions.list();
    const activeSession = sessions.find(s => s.status === 'connected');
    
    if (!activeSession) {
      console.error(`❌ Nenhuma sessão WhatsApp ativa para campanha ${campaignId}`);
      await db.campaigns.updateStatus(campaignId, 'cancelled');
      return;
    }
    
    // Processar em lotes menores para não sobrecarregar
    let hasMore = true;
    let sentCount = 0;
    let failedCount = 0;
    let consecutiveErrors = 0;
    
    while (hasMore && campaign.status === 'sending') {
      // Verificar se campanha ainda está ativa
      const currentCampaign = await db.campaigns.findById(campaignId);
      if (!currentCampaign || currentCampaign.status !== 'sending') {
        console.log(`⏸️ Campanha ${campaignId} foi pausada ou cancelada`);
        break;
      }
      
      // Pausar se muitos erros consecutivos
      if (consecutiveErrors >= 5) {
        console.log(`⚠️ Muitos erros consecutivos, pausando campanha ${campaignId}`);
        await db.campaigns.updateStatus(campaignId, 'paused');
        break;
      }
      
      // Buscar próximos logs pendentes (lote menor)
      const pendingLogs = await db.campaignLogs.getPending(campaignId, BATCH_SIZE);
      
      if (pendingLogs.length === 0) {
        hasMore = false;
        break;
      }
      
      // Enviar mensagens com controle de erro
      for (const log of pendingLogs) {
        try {
          console.log(`📤 Enviando para ${log.contact_number} (Enviados: ${sentCount}, Falhas: ${failedCount})`);
          
          // Enviar via WhatsApp
          const options = {};
          if (campaign.media_url && campaign.media_type) {
            options.type = campaign.media_type;
            options.path = path.resolve('.' + campaign.media_url);
            
            // Verificar se arquivo existe
            const fs = require('fs');
            if (!fs.existsSync(options.path)) {
              throw new Error('Arquivo de mídia não encontrado: ' + campaign.media_url);
            }
          }
          
          await whatsappService.sendMessage(
            activeSession.id,
            log.contact_number,
            log.message_content,
            options
          );
          
          // Atualizar log como enviado
          await db.campaignLogs.updateStatus(log.id, 'sent');
          sentCount++;
          consecutiveErrors = 0; // Reset contador de erros
          
          console.log(`✅ Enviado para ${log.contact_number}`);
          
        } catch (sendError) {
          console.error(`❌ Erro ao enviar para ${log.contact_number}:`, sendError.message);
          
          // Atualizar log como falhou
          await db.campaignLogs.updateStatus(log.id, 'failed', sendError.message);
          failedCount++;
          consecutiveErrors++;
        }
        
        // Delay dinâmico entre envios
        const delay = getDynamicDelay();
        console.log(`⏱️ Aguardando ${delay/1000}s antes do próximo envio...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      // Atualizar contadores da campanha
      await db.campaigns.updateStatus(campaignId, 'sending', {
        sent_count: sentCount,
        failed_count: failedCount
      });
      
      // Emitir progresso via socket
      if (global.io) {
        global.io.emit('campaign:progress', {
          campaignId,
          sent: sentCount,
          failed: failedCount,
          total: campaign.total_count
        });
      }
    }
    
    // Finalizar campanha
    if (hasMore === false) {
      await db.campaigns.updateStatus(campaignId, 'sent', {
        sent_count: sentCount,
        failed_count: failedCount
      });
      
      console.log(`🎉 Campanha ${campaignId} finalizada! Enviados: ${sentCount}, Falhas: ${failedCount}`);
      
      // Notificar conclusão
      if (global.io) {
        global.io.emit('campaign:completed', {
          campaignId,
          sent: sentCount,
          failed: failedCount,
          total: campaign.total_count
        });
      }
    }
    
  } catch (error) {
    console.error(`❌ Erro ao processar fila da campanha ${campaignId}:`, error);
    await db.campaigns.updateStatus(campaignId, 'cancelled');
  }
}

// ===========================================
// SOCKET.IO - EVENTOS EM TEMPO REAL
// ===========================================

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);

  // Autenticar socket
  socket.on('auth', (token) => {
    const decoded = verifyToken(token);
    if (decoded) {
      socket.userId = decoded.id;
      socket.join(`user-${decoded.id}`);
      console.log(`Socket autenticado para usuário ${decoded.id}`);
    }
  });

  // Entrar em sala de setor
  socket.on('join:sector', (sector) => {
    socket.join(`sector-${sector}`);
    console.log(`Socket entrou no setor ${sector}`);
  });

  // Eventos de digitação
  socket.on('typing:start', (data) => {
    socket.to(`contact-${data.contactId}`).emit('typing:start', {
      userId: socket.userId,
      contactId: data.contactId
    });
  });

  socket.on('typing:stop', (data) => {
    socket.to(`contact-${data.contactId}`).emit('typing:stop', {
      userId: socket.userId,
      contactId: data.contactId
    });
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

// ===========================================
// INICIALIZAÇÃO DO SERVIDOR
// ===========================================

async function startServer() {
  try {
    // Criar tabelas no banco
    await createTables();
    
    // Inicializar sistema de backup
    //const backupService = new BackupService();
    //backupService.initScheduledBackups();
    
    // Inicializar monitoramento
    const monitoringService = new MonitoringService(io);
    
    // Inicializar WhatsApp Service
    whatsappService = new WhatsAppService(io);
    
    // NOVA VERIFICAÇÃO: Monitorar estado das sessões
    setInterval(async () => {
      try {
        const sessions = await db.sessions.list();
        
        for (const session of sessions) {
          if (session.status === 'connected') {
            const isActive = whatsappService.isSessionActive(session.id);
            
            if (!isActive) {
              console.log(`⚠️ Sessão ${session.name} perdeu conexão, atualizando status...`);
              
              await db.sessions.update(session.id, { 
                status: 'disconnected'
              });
              
              // Notificar frontend
              io.emit('session:disconnected', { sessionId: session.id });
            }
          }
        }
      } catch (error) {
        console.error('Erro na verificação de sessões:', error);
      }
    }, 30000); // A cada 30 segundos

     // ADICIONAR ANTES do console.log final:
    
    // Agendar limpeza automática diária
    const scheduleAutoCleanup = async () => {
      const enabled = await db.settings.get('auto_cleanup_enabled');
      const cleanupHour = await db.settings.get('auto_cleanup_hour') || 3;
      
      if (enabled) {
        const now = new Date();
        const nextCleanup = new Date();
        nextCleanup.setHours(cleanupHour, 0, 0, 0);
        
        // Se já passou da hora hoje, agendar para amanhã
        if (nextCleanup <= now) {
          nextCleanup.setDate(nextCleanup.getDate() + 1);
        }
        
        const msUntilCleanup = nextCleanup.getTime() - now.getTime();
        
        setTimeout(async () => {
          await executeAutoCleanup();
          
          // Reagendar para o próximo dia
          setInterval(executeAutoCleanup, 24 * 60 * 60 * 1000);
        }, msUntilCleanup);
        
        console.log(`🧹 Limpeza automática agendada para ${nextCleanup.toLocaleString('pt-BR')}`);
      }
    };
    
    scheduleAutoCleanup();
    
    // Iniciar servidor
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`
========================================
✅ Servidor rodando!
🌐 URL: http://localhost:${PORT}
👤 Login: admin@admin.com / admin123
========================================
      `);
    });
  } catch (error) {
    console.error('❌ Erro ao iniciar servidor:', error);
    process.exit(1);
  }
}

// Tratamento de erros não capturados
process.on('uncaughtException', (error) => {
  console.error('Erro não capturado:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Promise rejeitada:', error);
});

// Verificar saúde das sessões
app.get('/api/sessions/health', async (req, res) => {
  try {
    const sessions = await db.sessions.list();
    const health = {
      status: 'healthy', // ✅ ADICIONAR ESTA LINHA
      timestamp: new Date().toISOString(),
      database: {
        total: sessions.length,
        connected: sessions.filter(s => s.status === 'connected').length,
        connecting: sessions.filter(s => s.status === 'connecting').length,
        disconnected: sessions.filter(s => s.status === 'disconnected').length
      },
      memory: {
        total: sessions.length,
        active: 0
      },
      inconsistencies: []
    };
    
    // Verificar sessões ativas na memória
    for (const session of sessions) {
      const isActive = whatsappService.isSessionActive(session.id);
      if (isActive) {
        health.memory.active++;
      }
      
      // Detectar inconsistências
      if (session.status === 'connected' && !isActive) {
        health.inconsistencies.push({
          name: session.name,
          issue: 'connected_in_db_but_not_in_memory'
        });
      } else if (session.status === 'disconnected' && isActive) {
        health.inconsistencies.push({
          name: session.name,
          issue: 'active_in_memory_but_disconnected_in_db'
        });
      }
    }
    
    // Definir status geral baseado nas inconsistências
    if (health.inconsistencies.length > 0) {
      health.status = 'warning';
    } else if (health.memory.active === 0) {
      health.status = 'error';
    } else {
      health.status = 'healthy';
    }
    
    res.json(health);
  } catch (error) {
    console.error('Erro ao verificar saúde das sessões:', error);
    res.status(500).json({ 
      status: 'error',
      timestamp: new Date().toISOString(),
      error: 'Erro interno',
      database: { total: 0, connected: 0, connecting: 0, disconnected: 0 },
      memory: { total: 0, active: 0 },
      inconsistencies: []
    });
  }
});

// Forçar sincronização das sessões
app.post('/api/sessions/force-sync', async (req, res) => {
  try {
    const sessions = await db.sessions.list();
    let synced = 0;
    let errors = 0;
    
    for (const session of sessions) {
      try {
        const isActive = whatsappService.isSessionActive(session.id);
        const correctStatus = isActive ? 'connected' : 'disconnected';
        
        if (session.status !== correctStatus) {
          await db.sessions.update(session.id, { status: correctStatus });
          synced++;
          console.log(`✅ Sessão ${session.name} sincronizada: ${session.status} → ${correctStatus}`);
        }
      } catch (sessionError) {
        console.error(`❌ Erro ao sincronizar sessão ${session.name}:`, sessionError);
        errors++;
      }
    }
    
    res.json({
      success: true,
      message: `Sincronização concluída: ${synced} sessões atualizadas, ${errors} erros`,
      synced,
      errors
    });
    
  } catch (error) {
    console.error('Erro na sincronização forçada:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Erro interno',
      synced: 0,
      errors: 1
    });
  }
});

// ===========================================
// SISTEMA DE AGENDAMENTO DE CAMPANHAS
// ===========================================

// Verificar campanhas agendadas a cada minuto
setInterval(async () => {
  try {
    await checkScheduledCampaigns();
  } catch (error) {
    console.error('Erro ao verificar campanhas agendadas:', error);
  }
}, 60000); // 60 segundos

// Função para verificar e executar campanhas agendadas
async function checkScheduledCampaigns() {
  try {
    const now = new Date();
    
    // Buscar campanhas agendadas para agora
    const scheduledCampaigns = await db.query(
      `SELECT * FROM campaigns 
       WHERE status = 'scheduled' 
       AND scheduled_at <= ? 
       AND scheduled_at > DATE_SUB(?, INTERVAL 2 MINUTE)`,
      [now, now]
    );
    
    for (const campaign of scheduledCampaigns) {
      console.log(`⏰ Executando campanha agendada: ${campaign.name} (ID: ${campaign.id})`);
      
      try {
        await startCampaignDispatch(campaign.id);
        console.log(`✅ Campanha ${campaign.id} iniciada com sucesso`);
      } catch (error) {
        console.error(`❌ Erro ao executar campanha agendada ${campaign.id}:`, error);
        await db.campaigns.updateStatus(campaign.id, 'cancelled');
      }
    }
    
  } catch (error) {
    console.error('Erro ao verificar campanhas agendadas:', error);
  }
}

// Função para monitorar campanhas em andamento
setInterval(async () => {
  try {
    await monitorActiveCampaigns();
  } catch (error) {
    console.error('Erro ao monitorar campanhas:', error);
  }
}, 30000); // 30 segundos

async function monitorActiveCampaigns() {
  try {
    // Buscar campanhas que estão "sending" há mais de 2 horas
    const stuckCampaigns = await db.query(
      `SELECT * FROM campaigns 
       WHERE status = 'sending' 
       AND started_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)`
    );
    
    for (const campaign of stuckCampaigns) {
      console.log(`⚠️ Campanha ${campaign.id} travada há mais de 2 horas, cancelando...`);
      
      // Obter estatísticas atuais
      const stats = await db.campaigns.getStats(campaign.id);
      
      await db.campaigns.updateStatus(campaign.id, 'cancelled', {
        sent_count: stats.sent,
        failed_count: stats.failed
      });
      
      // Notificar via socket
      if (global.io) {
        global.io.emit('campaign:stuck', {
          campaignId: campaign.id,
          message: 'Campanha cancelada por inatividade'
        });
      }
    }
    
  } catch (error) {
    console.error('Erro ao monitorar campanhas ativas:', error);
  }
}

// Função para limpeza de logs antigos (executar diariamente)
setInterval(async () => {
  try {
    await cleanupOldCampaignLogs();
  } catch (error) {
    console.error('Erro na limpeza de logs:', error);
  }
}, 24 * 60 * 60 * 1000); // 24 horas

async function cleanupOldCampaignLogs() {
  try {
    // Remover logs de campanhas com mais de 30 dias
    const result = await db.query(
      `DELETE cl FROM campaign_logs cl
       JOIN campaigns c ON cl.campaign_id = c.id
       WHERE c.created_at < DATE_SUB(NOW(), INTERVAL 30 DAY)`
    );
    
    if (result.affectedRows > 0) {
      console.log(`🧹 Limpeza: ${result.affectedRows} logs de campanha removidos`);
    }
    
  } catch (error) {
    console.error('Erro na limpeza de logs:', error);
  }
}

// Recarregar TODOS os avatars
app.post('/api/contacts/refresh-all-avatars', authMiddleware, async (req, res) => {
  try {
    if (req.session.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores podem executar esta ação' });
    }
    
    const sessions = await db.sessions.list();
    const activeSession = sessions.find(s => s.status === 'connected');
    
    if (!activeSession) {
      return res.status(400).json({ error: 'Nenhuma sessão WhatsApp ativa' });
    }
    
    const contacts = await db.query('SELECT id, number, name FROM contacts WHERE number != ? LIMIT 50', ['status@broadcast']);
    const client = whatsappService.getClient(activeSession.id);
    
    if (!client) {
      return res.status(400).json({ error: 'Cliente WhatsApp não encontrado' });
    }
    
    let updated = 0;
    let errors = 0;
    
    for (const contact of contacts) {
      try {
        console.log(`🔍 Buscando avatar para: ${contact.name || contact.number}`);
        const avatarUrl = await client.getProfilePicFromServer(contact.number);
        
        if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.startsWith('http')) {
          await db.contacts.update(contact.id, { avatar: avatarUrl });
          updated++;
          
          // Notificar frontend
          global.io.emit('contact:update', {
            id: contact.id,
            avatar: avatarUrl
          });
          
          console.log(`✅ Avatar atualizado: ${contact.name || contact.number}`);
        } else {
          console.log(`❌ Sem avatar: ${contact.name || contact.number}`);
        }
        
        // Delay para não sobrecarregar
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (avatarError) {
        console.error(`❌ Erro avatar ${contact.number}:`, avatarError.message);
        errors++;
      }
    }
    
    res.json({ 
      success: true, 
      message: `${updated} avatars atualizados, ${errors} erros`,
      updated,
      errors 
    });
    
  } catch (error) {
    console.error('Erro ao atualizar avatars:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Forçar atualização de avatar
app.post('/api/contacts/:id/refresh-avatar', async (req, res) => {
  try {
    const contactId = parseInt(req.params.id);
    const { sessionId } = req.body;
    
    if (!whatsappService.isSessionActive(sessionId)) {
      return res.status(400).json({ error: 'Sessão não ativa' });
    }
    
    const contact = await db.query('SELECT * FROM contacts WHERE id = ?', [contactId]);
    if (!contact.length) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }
    
    // Forçar busca de novo avatar
    const client = whatsappService.getClient(sessionId);
    if (client) {
      try {
        const avatarUrl = await client.getProfilePicFromServer(contact[0].number);
        if (avatarUrl && avatarUrl.startsWith('http')) {
          await db.contacts.update(contactId, { avatar: avatarUrl });
          
          // Notificar frontend
          global.io.emit('contact:update', {
            id: contactId,
            avatar: avatarUrl
          });
          
          res.json({ success: true, avatar: avatarUrl });
        } else {
          res.json({ success: false, message: 'Avatar não disponível' });
        }
      } catch (avatarError) {
        res.json({ success: false, message: 'Erro ao buscar avatar' });
      }
    } else {
      res.status(400).json({ error: 'Cliente WhatsApp não encontrado' });
    }
    
  } catch (error) {
    console.error('Erro ao atualizar avatar:', error);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// Função de limpeza automática
async function executeAutoCleanup() {
  try {
    console.log('🧹 Iniciando limpeza automática...');
    
    const fs = require('fs');
    const path = require('path');
    
    // Carregar configurações
    const config = {
      maxUploadsSize: await db.settings.get('auto_cleanup_max_uploads_size') || 500,
      maxUploadAge: await db.settings.get('auto_cleanup_max_upload_age') || 30,
      maxLogSize: await db.settings.get('auto_cleanup_max_log_size') || 100,
      notifyAdmin: await db.settings.get('auto_cleanup_notify') || true
    };
    
    const result = {
      uploadsFreed: 0,
      logsFreed: 0,
      browserDataFreed: 0,
      filesRemoved: 0,
      actions: []
    };
    
    // 1. Limpeza de uploads antigos
    const uploadsDir = path.resolve('./uploads');
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      const cutoffDate = Date.now() - (config.maxUploadAge * 24 * 60 * 60 * 1000);
      
      let uploadsDirSize = 0;
      files.forEach(file => {
        const filePath = path.join(uploadsDir, file);
        uploadsDirSize += fs.statSync(filePath).size;
      });
      
      // Se pasta muito grande OU arquivos muito antigos
      if (uploadsDirSize > config.maxUploadsSize * 1024 * 1024) {
        let freedSpace = 0;
        let removedFiles = 0;
        
        // Remover arquivos antigos primeiro
        for (const file of files) {
          const filePath = path.join(uploadsDir, file);
          const stats = fs.statSync(filePath);
          
          if (stats.mtime.getTime() < cutoffDate) {
            freedSpace += stats.size;
            fs.unlinkSync(filePath);
            removedFiles++;
          }
        }
        
        result.uploadsFreed = freedSpace;
        result.filesRemoved += removedFiles;
        result.actions.push(`Removidos ${removedFiles} uploads antigos (${(freedSpace/1024/1024).toFixed(2)}MB)`);
      }
    }
    
    // 2. Limpeza de logs grandes
    const logsDir = path.resolve('./logs');
    if (fs.existsSync(logsDir)) {
      const logFiles = fs.readdirSync(logsDir);
      
      for (const logFile of logFiles) {
        const logPath = path.join(logsDir, logFile);
        const stats = fs.statSync(logPath);
        
        if (stats.size > config.maxLogSize * 1024 * 1024) {
          // Manter apenas as últimas 1000 linhas
          const content = fs.readFileSync(logPath, 'utf8');
          const lines = content.split('\n');
          const newContent = lines.slice(-1000).join('\n');
          
          const freedSpace = stats.size - Buffer.byteLength(newContent);
          fs.writeFileSync(logPath, newContent);
          
          result.logsFreed += freedSpace;
          result.actions.push(`Log ${logFile} reduzido (${(freedSpace/1024/1024).toFixed(2)}MB)`);
        }
      }
    }
    
    // 3. Limpeza de sessões órfãs do browser-data
    const browserDataDir = path.resolve('./browser-data');
    if (fs.existsSync(browserDataDir)) {
      const sessions = fs.readdirSync(browserDataDir);
      
      for (const session of sessions) {
        const sessionPath = path.join(browserDataDir, session);
        
        try {
          const dbSession = await db.query('SELECT id FROM sessions WHERE name = ?', [session]);
          
          if (dbSession.length === 0) {
            const size = getDirSize(sessionPath);
            fs.rmSync(sessionPath, { recursive: true, force: true });
            
            result.browserDataFreed += size;
            result.actions.push(`Sessão órfã removida: ${session} (${(size/1024/1024).toFixed(2)}MB)`);
          }
        } catch (sessionError) {
          console.error(`Erro ao processar sessão ${session}:`, sessionError.message);
        }
      }
    }
    
    // 4. Limpeza de mensagens antigas (opcional)
    const messagesDeleted = await db.query(`
      DELETE FROM messages 
      WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY) 
      AND type IN ('image', 'video', 'audio', 'document')
    `);
    
    if (messagesDeleted.affectedRows > 0) {
      result.actions.push(`${messagesDeleted.affectedRows} registros de mídia antiga removidos do banco`);
    }
    
    const totalFreed = result.uploadsFreed + result.logsFreed + result.browserDataFreed;
    
    console.log(`✅ Limpeza automática concluída: ${(totalFreed/1024/1024).toFixed(2)}MB liberados`);
    
    // Notificar admin se configurado
    if (config.notifyAdmin && totalFreed > 0) {
      // Aqui você pode adicionar notificação por email ou webhook
      console.log(`📧 Notificação: Limpeza liberou ${(totalFreed/1024/1024).toFixed(2)}MB`);
    }
    
    return {
      ...result,
      totalFreed: totalFreed,
      totalFreedMB: `${(totalFreed/1024/1024).toFixed(2)}MB`
    };
    
  } catch (error) {
    console.error('❌ Erro na limpeza automática:', error);
    throw error;
  }
}

// Rota para recarregar conversas manualmente
app.post('/api/conversations/reload', authMiddleware, async (req, res) => {
  try {
    if (!['admin', 'supervisor'].includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }
    
    console.log(`🔄 Recarga manual de conversas solicitada por: ${req.session.user.name}`);
    
    const sessions = await db.sessions.list();
    const activeSessions = sessions.filter(s => s.status === 'connected');
    
    if (activeSessions.length === 0) {
      return res.status(400).json({ 
        error: 'Nenhuma sessão WhatsApp ativa encontrada' 
      });
    }
    
    let totalReloaded = 0;
    
    for (const session of activeSessions) {
      try {
        if (whatsappService && whatsappService.reloadRecentConversations) {
          await whatsappService.reloadRecentConversations(session.id);
          totalReloaded++;
        }
      } catch (sessionError) {
        console.error(`Erro ao recarregar sessão ${session.name}:`, sessionError.message);
      }
    }
    
    res.json({ 
      success: true, 
      message: `Conversas recarregadas de ${totalReloaded} sessões`,
      sessionsReloaded: totalReloaded,
      timestamp: new Date()
    });
    
  } catch (error) {
    console.error('Erro na recarga de conversas:', error);
    res.status(500).json({ 
      error: 'Erro interno ao recarregar conversas',
      details: error.message 
    });
  }
});

// Iniciar!
startServer();
