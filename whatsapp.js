const wppconnect = require('@wppconnect-team/wppconnect');
const { db } = require('./database');
const fs = require('fs');
const path = require('path');

// Verificação inicial do Puppeteer (simplificada)
console.log('🔍 Verificando Puppeteer...');
try {
  const puppeteer = require('puppeteer');
  console.log('✅ Puppeteer disponível - versão:', puppeteer.version || 'N/A');
} catch (error) {
  console.error('❌ Puppeteer não encontrado:', error.message);
}

// Armazenar clientes WhatsApp ativos
const sessions = new Map();

// Cache para controlar mensagens automáticas (evitar spam)
const lastAutoMessages = new Map();

// Configurações com Puppeteer otimizado e novo Headless - MELHORADA PARA RECONEXÃO
const config = {
  folderNameToken: 'tokens',
  mkdirFolderToken: true,
  headless: "new", // MUDANÇA: Usar novo modo Headless
  devtools: false,
  useChrome: true,
  debug: false,
  logQR: false,
  browserWS: '',
  autoRestore: true,        // ✅ NOVO: Sempre tentar restaurar
  waitForLogin: true,       // ✅ NOVO: Aguardar login
  disableWelcome: true,     // ✅ NOVO: Desabilitar tela de boas-vindas
  autoClose: 300000,        // ✅ NOVO: 5 minutos timeout
  createPathFileToken: true, // ✅ NOVO: Criar pasta de token automaticamente
  browserArgs: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-extensions',
    '--disable-plugins',
    '--disable-default-apps',
    '--no-default-browser-check',
    '--disable-sync'
  ],
  puppeteerOptions: {
    headless: "new", // MUDANÇA: Novo modo Headless
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox', 
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor',
      '--no-first-run',
      '--no-zygote',
      '--disable-background-timer-throttling',
      '--no-default-browser-check',
      '--disable-sync'
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
    defaultViewport: { width: 1366, height: 768 },
    timeout: 120000 // ✅ MUDANÇA: Timeout maior para reconexão
  },
  disableWelcome: true,
  updatesLog: false,
  autoClose: 60000,
  tokenStore: 'file'
};

// Classe para gerenciar WhatsApp
class WhatsAppService {
  constructor(io) {
    this.io = io;
    this.initialize();
    this.startCacheCleanup();
  }

  // Método de inicialização assíncrono
  async initialize() {
    try {
      console.log('🚀 Inicializando WhatsApp Service...');
      
      // Fazer limpeza primeiro
      await this.cleanupOnStart();
      
      // Depois inicializar sessões
      await this.initializeSessions();
      
      console.log('✅ WhatsApp Service inicializado com sucesso');
    } catch (error) {
      console.error('❌ Erro na inicialização do WhatsApp Service:', error);
    }
  }

  // Método para limpeza suave (sem matar processos)
  async killOrphanChromeProcesses() {
    try {
      console.log('🧹 Verificando processos Chrome órfãos...');
      // Apenas log - não mata processos para evitar interferir com Chrome pessoal
      console.log('✅ Limpeza suave concluída');
    } catch (error) {
      console.log('⚠️ Erro na verificação:', error.message);
    }
  }

  // Limpeza inicial ao iniciar o serviço - VERSÃO CORRIGIDA
  async cleanupOnStart() {
    try {
      console.log('🧹 Iniciando limpeza inteligente de recursos...');
      
      // Matar processos Chrome órfãos (com await)
      await this.killOrphanChromeProcesses();
      
      // Aguardar um pouco para garantir que os processos foram finalizados
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      const fs = require('fs');
      const path = require('path');
      
      // CORREÇÃO: NÃO apagar tudo, apenas arquivos de lock e temporários
      const browserDataBaseDir = path.resolve('./browser-data');
      if (fs.existsSync(browserDataBaseDir)) {
        try {
          // Só remover arquivos de lock e cache, não os dados da sessão
          this.cleanupLockFiles(browserDataBaseDir);
          console.log('🧹 Arquivos de lock limpos');
        } catch (rmError) {
          console.log('⚠️ Erro ao remover locks:', rmError.message);
        }
      } else {
        // Criar diretório se não existir
        fs.mkdirSync(browserDataBaseDir, { recursive: true });
      }
      
      // CORREÇÃO: Verificar e criar estrutura de tokens corretamente
      const tokensDir = path.resolve('./tokens');
      console.log(`🔍 Verificando diretório de tokens: ${tokensDir}`);
      
      if (fs.existsSync(tokensDir)) {
        try {
          const tokenItems = fs.readdirSync(tokensDir);
          const tokenFolders = tokenItems.filter(item => {
            const itemPath = path.join(tokensDir, item);
            return fs.statSync(itemPath).isDirectory();
          });
          
          console.log(`📁 Encontrados ${tokenFolders.length} tokens salvos`);
          
          // Listar tokens encontrados
          tokenFolders.forEach(folder => {
            const folderPath = path.join(tokensDir, folder);
            const tokenFiles = fs.readdirSync(folderPath);
            console.log(`🔑 Token encontrado: ${folder} (${tokenFiles.length} arquivos)`);
            
            // Verificar se tem arquivos essenciais
            const hasWABrowser = tokenFiles.some(f => f.includes('WA-'));
            const hasSession = tokenFiles.some(f => f.includes('session'));
            console.log(`   📋 Status: WABrowser=${hasWABrowser}, Session=${hasSession}`);
          });
        } catch (readError) {
          console.error(`❌ Erro ao ler diretório de tokens:`, readError.message);
        }
      } else {
        console.log(`📁 Diretório de tokens não existe, criando...`);
        fs.mkdirSync(tokensDir, { recursive: true });
        console.log(`✅ Diretório criado: ${tokensDir}`);
      }
      
      // Verificar/criar diretório de dados do browser
      const browserDataDir = path.resolve('./browser-data');
      if (!fs.existsSync(browserDataDir)) {
        fs.mkdirSync(browserDataDir, { recursive: true });
        console.log(`📁 Diretório browser-data criado: ${browserDataDir}`);
      }
      
      console.log('✅ Limpeza inteligente concluída - tokens preservados');
      
    } catch (error) {
      console.error('❌ Erro na limpeza inicial:', error);
      console.log('⚠️ Continuando inicialização...');
    }
  }

  // Função auxiliar para remoção recursiva (compatibilidade)
  removeDirectoryRecursive(dirPath) {
    const fs = require('fs');
    const path = require('path');
    
    try {
      if (fs.existsSync(dirPath)) {
        const files = fs.readdirSync(dirPath);
        files.forEach((file) => {
          const currentPath = path.join(dirPath, file);
          if (fs.lstatSync(currentPath).isDirectory()) {
            this.removeDirectoryRecursive(currentPath); // Recursão
          } else {
            fs.unlinkSync(currentPath); // Remover arquivo
          }
        });
        fs.rmdirSync(dirPath); // Remover diretório vazio
        console.log(`🧹 Diretório removido: ${dirPath}`);
      }
    } catch (error) {
      console.error(`❌ Erro ao remover diretório ${dirPath}:`, error.message);
    }
}

// NOVA FUNÇÃO: Limpar apenas arquivos de lock
cleanupLockFiles(baseDir) {
  const fs = require('fs');
  const path = require('path');
  
  const lockFiles = [
    'SingletonLock',
    'SingletonCookie', 
    'SingletonSocket',
    'lockfile',
    '.lock'
  ];
  
  try {
    const traverseDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      
      const items = fs.readdirSync(dir);
      
      items.forEach(item => {
        const itemPath = path.join(dir, item);
        
        try {
          const stat = fs.statSync(itemPath);
          
          if (stat.isDirectory()) {
            traverseDir(itemPath); // Recursão
          } else if (lockFiles.some(lockFile => item.includes(lockFile))) {
            try {
              fs.unlinkSync(itemPath);
              console.log(`🧹 Lock removido: ${item}`);
            } catch (e) {
              console.log(`⚠️ Erro ao remover lock ${item}:`, e.message);
            }
          }
        } catch (statError) {
          console.log(`⚠️ Erro ao acessar ${item}:`, statError.message);
        }
      });
    };
    
    traverseDir(baseDir);
  } catch (error) {
    console.error('Erro ao limpar locks:', error);
  }
}

  // Inicializar sessões existentes - VERSÃO CORRIGIDA COM MONITORAMENTO
  async initializeSessions() {
    try {
      console.log('🔄 Verificando sessões existentes...');
      
      const dbSessions = await db.sessions.list();
      
      for (const session of dbSessions) {
        if (session.status === 'connected') {
          console.log(`🔍 Tentando restaurar sessão: ${session.name}`);
          
          const fs = require('fs');
          const tokenPath = `./tokens/${session.name}`;
          const hasToken = fs.existsSync(tokenPath);
          
          if (hasToken) {
            console.log(`🔑 Token encontrado para ${session.name}, restaurando...`);
            
            try {
              await this.restoreSession(session.id, session.name);
              
              // ✅ NOVO: Recarregar conversas após restaurar
              setTimeout(async () => {
                await this.reloadRecentConversations(session.id);
              }, 5000); // Aguardar 5 segundos para estabilizar
              
              this.startSessionHealthCheck(session.id, session.name);
              
            } catch (restoreError) {
              console.log(`⚠️ Falha ao restaurar ${session.name}:`, restoreError.message);
              
              setTimeout(() => {
                this.attemptAutoReconnect(session.id, session.name);
              }, 10000);
              
              await db.sessions.update(session.id, { 
                status: 'connecting'
              });
            }
          } else {
            console.log(`❌ Token não encontrado para ${session.name}`);
            await db.sessions.update(session.id, { 
              status: 'disconnected'
            });
          }
        }
      }
      
      console.log('✅ Verificação de sessões concluída');
    } catch (error) {
      console.error('❌ Erro ao inicializar sessões:', error);
    }
  }

  // ✅ NOVA FUNÇÃO: Recarregar conversas recentes após reconexão
  async reloadRecentConversations(sessionId) {
    try {
      console.log(`📜 Recarregando conversas para sessão ${sessionId}...`);
      
      const session = sessions.get(sessionId);
      if (!session || !session.client) {
        console.log('❌ Sessão não encontrada para recarregar conversas');
        return;
      }
      
      const chats = await session.client.getAllChats();
      console.log(`📱 Encontradas ${chats.length} conversas no WhatsApp`);
      
      let reloadedCount = 0;
      
      for (const chat of chats.slice(0, 15)) {
        try {
          if (chat.isGroup || !chat.id || !chat.id.includes('@c.us')) {
            continue;
          }
          
          const contact = await db.contacts.findOrCreate(
            chat.id, 
            chat.name || chat.formattedTitle || chat.id.split('@')[0]
          );
          
          if (chat.t && chat.t > 0) {
            const chatLastMessage = new Date(chat.t * 1000);
            const currentLastMessage = contact.last_message_at ? new Date(contact.last_message_at) : null;
            
            if (!currentLastMessage || chatLastMessage > currentLastMessage) {
              await db.contacts.update(contact.id, {
                last_message: chat.lastMessage?.body?.substring(0, 100) || '[Conversa recarregada]',
                last_message_at: chatLastMessage
              });
              
              console.log(`🔄 Conversa atualizada: ${contact.name || contact.number}`);
              reloadedCount++;
            }
          }
          
        } catch (chatError) {
          console.error(`❌ Erro ao processar conversa ${chat.id}:`, chatError.message);
        }
      }
      
      console.log(`✅ ${reloadedCount} conversas recarregadas para sessão ${sessionId}`);
      
      this.io.emit('conversations:reloaded', {
        sessionId,
        reloadedCount,
        message: `${reloadedCount} conversas recarregadas`,
        timestamp: new Date()
      });
      
    } catch (error) {
      console.error('❌ Erro ao recarregar conversas:', error);
    }
  }

async restoreSession(sessionId, sessionName) {
    console.log(`🔄 Restaurando sessão: ${sessionName}`);
    
    // ✅ CORREÇÃO: Buscar token em múltiplos locais possíveis
    let tokenPath = path.resolve(`./tokens/${sessionName}`);
    let browserPath = path.resolve(`./browser-data/${sessionName}`);
    
    // Se não encontrar, procurar em subpastas (para compatibilidade com instanceId)
    if (!fs.existsSync(tokenPath)) {
      const tokensBaseDir = path.resolve('./tokens');
      if (fs.existsSync(tokensBaseDir)) {
        const items = fs.readdirSync(tokensBaseDir);
        console.log(`🔍 Procurando token em subpastas:`, items);
        
     for (const item of items) {
          const itemPath = path.join(tokensBaseDir, item);
          
          try {
            // Verificar se é pasta
            if (fs.statSync(itemPath).isDirectory()) {
              // Procurar sessionName dentro desta pasta
              const sessionTokenPath = path.join(itemPath, sessionName);
              if (fs.existsSync(sessionTokenPath)) {
                console.log(`🔑 Token encontrado em: ${item}/${sessionName}`);
                tokenPath = sessionTokenPath;
                browserPath = path.resolve(`./browser-data/${item}/${sessionName}`);
                break;
              }
              
              // NOVO: Verificar se a própria pasta instance contém arquivos válidos
              const instanceFiles = fs.readdirSync(itemPath);
              if (instanceFiles.length > 0) {
                // Se contém arquivos e o nome da instância contém parte do sessionName
                if (item.toLowerCase().includes(sessionName.toLowerCase()) || 
                    instanceFiles.some(f => f.includes('WA-') || f.includes('session'))) {
                  console.log(`🔑 Token encontrado na instância: ${item}`);
                  tokenPath = itemPath;
                  browserPath = path.resolve(`./browser-data/${item}`);
                  break;
                }
              }
            }
          } catch (statError) {
            console.log(`⚠️ Erro ao verificar pasta ${item}:`, statError.message);
          }
        }
      }
    }
    
    console.log(`🔍 Verificando paths finais:`);
    console.log(`   Token: ${tokenPath} (existe: ${fs.existsSync(tokenPath)})`);
    console.log(`   Browser: ${browserPath} (existe: ${fs.existsSync(browserPath)})`);
    
    if (fs.existsSync(tokenPath)) {
      const tokenFiles = fs.readdirSync(tokenPath);
      console.log(`🔑 Arquivos de token encontrados: ${tokenFiles.join(', ')}`);
      
      // Verificar se tem arquivos essenciais
const hasWAFiles = tokenFiles.some(f => f.includes('WA-') || f.includes('session'));
const hasAnyFiles = tokenFiles.length > 0;

// Aceitar se tem qualquer arquivo OU arquivos WA
if (!hasAnyFiles) {
        console.log(`⚠️ Token sem arquivos essenciais, limpando e marcando para nova conexão`);
        
        // Limpar token corrompido
        await this.cleanupCorruptedToken(sessionId, sessionName);
        throw new Error('Token inválido - sem arquivos essenciais');
      }
    } else {
      console.log(`❌ Pasta de token não encontrada, marcando para nova conexão`);
      
      // Limpar entrada do banco se token não existe
      await this.cleanupCorruptedToken(sessionId, sessionName);
      throw new Error('Token não encontrado');
    }
    
    try {
      // Configuração para restaurar (sem recriar dados)
      const sessionConfig = {
        ...config,
        session: sessionName,
        folderNameToken: `tokens/${sessionName}`,
        tokenStore: 'file',
        autoRestore: true,
        waitForLogin: true,
        puppeteerOptions: {
          ...config.puppeteerOptions,
          userDataDir: `./browser-data/${sessionName}`,
        },
        statusFind: (statusSession, session) => {
          console.log(`📊 Status da sessão ${sessionName}: ${statusSession}`);
          this.handleStatus(sessionId, statusSession);
        },
        catchQR: (base64Qr, asciiQR) => {
          console.log(`❌ QR Code gerado durante restauração de ${sessionName} - token pode estar inválido`);
          this.handleTokenExpired(sessionId, base64Qr);
        }
      };
      
      const client = await wppconnect.create(sessionConfig);
      
      // Verificar se realmente conectou
      const info = await client.getHostDevice();
      
      if (info && info.id) {
        // Sucesso na restauração
        sessions.set(sessionId, {
          client,
          name: sessionName,
          status: 'connected'
        });
        
        this.setupListeners(sessionId, client);
        
        await db.sessions.update(sessionId, {
          status: 'connected',
          number: info.id.user,
          connected_at: new Date()
        });
        
        this.io.emit('session:restored', {
          sessionId,
          sessionName,
          number: info.id.user
        });
        
        console.log(`✅ Sessão ${sessionName} restaurada com sucesso!`);
        return client;
      } else {
        throw new Error('Falha na verificação do dispositivo');
      }
      
    } catch (error) {
      console.error(`❌ Erro ao restaurar sessão ${sessionName}:`, error);
      throw error;
    }
  }

  // 🔧 NOVO: Monitoramento de saúde da sessão
  startSessionHealthCheck(sessionId, sessionName) {
    const checkInterval = setInterval(async () => {
      try {
        const session = sessions.get(sessionId);
        
        if (!session || !session.client) {
          console.log(`⚠️ Sessão ${sessionName} perdida da memória, limpando monitor`);
          clearInterval(checkInterval);
          return;
        }
        
        // Tentar uma operação simples para verificar conectividade
        try {
          await session.client.getHostDevice();
          // Se chegou até aqui, está conectado
        } catch (testError) {
          console.log(`🔄 Detectada desconexão de ${sessionName}, iniciando reconexão...`);
          clearInterval(checkInterval);
          await this.attemptAutoReconnect(sessionId, sessionName);
        }
        
      } catch (error) {
        console.error(`❌ Erro no health check da sessão ${sessionName}:`, error);
      }
    }, 60000); // Verificar a cada 1 minuto
    
    console.log(`💓 Health check iniciado para: ${sessionName}`);
  }

  // 🔧 NOVO: Tentativa automática de reconexão
  async attemptAutoReconnect(sessionId, sessionName, attempt = 1) {
    const maxAttempts = 3;
    
    if (attempt > maxAttempts) {
      console.log(`❌ Máximo de tentativas de reconexão atingido para ${sessionName}`);
      
      await db.sessions.update(sessionId, { 
        status: 'disconnected',
        qrcode: null 
      });
      
      this.io.emit('session:auto-reconnect-failed', {
        sessionId,
        sessionName,
        message: 'Falha na reconexão automática. Token pode ter expirado.'
      });
      
      return;
    }
    
    try {
      console.log(`🔄 Tentativa ${attempt}/${maxAttempts} de reconexão: ${sessionName}`);
      
      // Limpar sessão atual da memória
      sessions.delete(sessionId);
      
      // Aguardar um pouco antes de tentar
      await new Promise(resolve => setTimeout(resolve, 5000 * attempt));
      
      // Tentar restaurar novamente
      await this.restoreSession(sessionId, sessionName);
      
      // Se chegou até aqui, reconectou com sucesso
      console.log(`✅ Reconexão automática bem-sucedida: ${sessionName}`);
      
      // Reiniciar monitoramento
      this.startSessionHealthCheck(sessionId, sessionName);
      
      this.io.emit('session:auto-reconnected', {
        sessionId,
        sessionName,
        message: 'Sessão reconectada automaticamente!'
      });
      
    } catch (error) {
      console.log(`❌ Tentativa ${attempt} falhou para ${sessionName}: ${error.message}`);
      
      // Tentar novamente
      setTimeout(() => {
        this.attemptAutoReconnect(sessionId, sessionName, attempt + 1);
      }, 10000 * attempt); // Delay progressivo
    }
  }

  // NOVA FUNÇÃO - Adicionar esta função completa
  async cleanupCorruptedToken(sessionId, sessionName) {
    try {
      console.log(`🧹 Limpando token corrompido para sessão: ${sessionName}`);
      
      const fs = require('fs');
      const path = require('path');
      
      // Remover pasta de token se existir
      const tokenPath = path.resolve(`./tokens/${sessionName}`);
      if (fs.existsSync(tokenPath)) {
        try {
          this.removeDirectoryRecursive(tokenPath);
          console.log(`🗑️ Token corrompido removido: ${tokenPath}`);
        } catch (removeError) {
          console.error(`❌ Erro ao remover token: ${removeError.message}`);
        }
      }
      
      // Remover dados do browser se existir
      const browserPath = path.resolve(`./browser-data/${sessionName}`);
      if (fs.existsSync(browserPath)) {
        try {
          this.removeDirectoryRecursive(browserPath);
          console.log(`🗑️ Dados do browser removidos: ${browserPath}`);
        } catch (removeError) {
          console.error(`❌ Erro ao remover browser data: ${removeError.message}`);
        }
      }
      
      // Atualizar status no banco para desconectada
      await db.sessions.update(sessionId, {
        status: 'disconnected',
        qrcode: null,
        number: null,
        connected_at: null
      });
      
      console.log(`✅ Sessão ${sessionName} limpa e marcada como desconectada`);
      
    } catch (error) {
      console.error(`❌ Erro na limpeza do token corrompido:`, error);
    }
  }

  // NOVA FUNÇÃO: Lidar com token expirado
  async handleTokenExpired(sessionId, qrCode) {
    console.log(`🔑 Token expirado para sessão ${sessionId}`);
    
    await db.sessions.update(sessionId, {
      status: 'connecting',
      qrcode: qrCode
    });
    
    this.io.emit('session:token-expired', {
      sessionId,
      qrCode,
      message: 'Token expirado. Escaneie o QR Code novamente.'
    });
  }

  // Criar nova sessão com isolamento para múltiplas instâncias
  async createSession(sessionId, sessionName) {
    try {
      console.log(`🔄 Iniciando sessão: ${sessionName}`);
      
      // Atualizar status no banco
      await db.sessions.update(sessionId, { status: 'connecting' });
      
      // Configuração específica para esta sessão (ISOLAMENTO) - VERSÃO CORRIGIDA
      const sessionConfig = {
        ...config,
        session: sessionName,
        folderNameToken: `tokens/${sessionName}`, // Pasta específica
        tokenStore: 'file',
        createPathFileToken: true,
        waitForLogin: true,
        autoRestore: false, // False para nova sessão
        puppeteerOptions: {
          ...config.puppeteerOptions,
          userDataDir: `./browser-data/${sessionName}`, // Dados únicos do browser
          args: [
            ...config.browserArgs,
            `--user-data-dir=./browser-data/${sessionName}`, // Isolamento completo
            `--remote-debugging-port=${9222 + sessionId}`, // Porta única por sessão
            '--disable-web-security',
            '--no-first-run'
          ]
        },
        browserArgs: [
          ...config.browserArgs,
          `--user-data-dir=./browser-data/${sessionName}`,
          `--remote-debugging-port=${9222 + sessionId}`,
          `--profile-directory=Profile${sessionId}` // Perfil único
        ],
        statusFind: (statusSession, session) => {
          console.log(`Status da sessão ${sessionName}: ${statusSession}`);
          this.handleStatus(sessionId, statusSession);
        },
        catchQR: (base64Qr, asciiQR) => {
          console.log(`📱 QR Code gerado para ${sessionName}`);
          this.handleQRCode(sessionId, base64Qr);
        }
      };

      // Garantir que a pasta existe
      const fs = require('fs');
      const path = require('path');
      const browserDataDir = `./browser-data/${sessionName}`;
      if (!fs.existsSync(browserDataDir)) {
        fs.mkdirSync(browserDataDir, { recursive: true });
        console.log(`📁 Pasta criada: ${browserDataDir}`);
      }
      
      // Configurar callbacks
      const client = await wppconnect.create(sessionConfig);

      // Armazenar cliente
      sessions.set(sessionId, {
        client,
        name: sessionName,
        status: 'connected'
      });

      // Configurar listeners
      this.setupListeners(sessionId, client);

      // Atualizar status no banco
      const info = await client.getHostDevice();
      await db.sessions.update(sessionId, {
        status: 'connected',
        number: info.id.user,
        connected_at: new Date()
      });

      // Emitir evento de conexão
      this.io.emit('session:connected', {
        sessionId,
        sessionName,
        number: info.id.user
      });

      console.log(`✅ Sessão ${sessionName} conectada!`);
      return client;

    } catch (error) {
      console.error(`❌ Erro ao criar sessão ${sessionName}:`, error);
      await db.sessions.update(sessionId, { status: 'disconnected' });
      throw error;
    }
  }
  

  // Configurar listeners de mensagens
  setupListeners(sessionId, client) {
    // Mensagens recebidas
     client.onMessage(async (message) => {
      try {
        // ✅ CORREÇÃO: Filtrar apenas mensagens muito antigas (mais de 1 hora)
        const messageTime = message.t ? message.t * 1000 : Date.now();
        const oneHourAgo = Date.now() - (60 * 60 * 1000); // 1 hora atrás
        
        if (messageTime < oneHourAgo) {
          console.log(`⏰ Mensagem muito antiga ignorada (${Math.floor((Date.now() - messageTime) / 60000)}min atrás)`);
          return;
        }
        
        console.log(`✅ Mensagem processada de: ${message.from}`);
        await this.handleIncomingMessage(sessionId, message);
      } catch (error) {
        console.error('Erro ao processar mensagem:', error);
      }
    });
    // Status da mensagem
    client.onAck(async (ack) => {
      this.io.emit('message:ack', {
        sessionId,
        messageId: ack.id,
        status: ack.ack
      });
    });

    // Presença (digitando)
    client.onPresenceChanged((presenceData) => {
      this.io.emit('contact:presence', {
        sessionId,
        number: presenceData.id,
        presence: presenceData.isOnline ? 'online' : 'offline',
        lastSeen: presenceData.t
      });
    });

    // Estado da conexão
    client.onStateChange((state) => {
      console.log(`Estado da sessão ${sessionId}: ${state}`);
      if (state === 'CONFLICT' || state === 'UNPAIRED' || state === 'UNLAUNCHED') {
        this.handleDisconnect(sessionId);
      }
    });
  }

  // Buscar avatar com múltiplas tentativas e métodos
  async getContactAvatarWithRetry(client, number, contactName, maxRetries = 3) {
    console.log(`🔍 Buscando avatar para: ${contactName || number}`);
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // Delay progressivo entre tentativas
        if (attempt > 0) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          console.log(`🔄 Tentativa ${attempt + 1} para ${contactName || number}`);
        }
        
        // Método 1: getProfilePicFromServer
        try {
          const avatarUrl = await client.getProfilePicFromServer(number);
          if (avatarUrl && typeof avatarUrl === 'string' && avatarUrl.startsWith('http')) {
            console.log(`✅ Avatar encontrado (método 1): ${contactName || number}`);
            return avatarUrl;
          }
        } catch (e) {
          console.log(`⚠️ Método 1 falhou: ${e.message}`);
        }
        
        // Método 2: getContact com fallback
        try {
          const contact = await client.getContact(number);
          if (contact && contact.profilePicThumbObj && contact.profilePicThumbObj.eurl) {
            console.log(`✅ Avatar encontrado (método 2): ${contactName || number}`);
            return contact.profilePicThumbObj.eurl;
          }
        } catch (e) {
          console.log(`⚠️ Método 2 falhou: ${e.message}`);
        }
        
        // Método 3: Buscar dados do perfil
        try {
          const profilePic = await client.getProfilePicUrl(number);
          if (profilePic && profilePic !== 'undefined') {
            console.log(`✅ Avatar encontrado (método 3): ${contactName || number}`);
            return profilePic;
          }
        } catch (e) {
          console.log(`⚠️ Método 3 falhou: ${e.message}`);
        }
        
      } catch (error) {
        console.log(`❌ Tentativa ${attempt + 1} falhou para ${contactName || number}: ${error.message}`);
      }
    }
    
    console.log(`❌ Sem avatar disponível: ${contactName || number} (após ${maxRetries} tentativas)`);
    return null;
  }

  // Processar mensagem recebida - VERSÃO CORRIGIDA
  async handleIncomingMessage(sessionId, message) {
    console.log('📥 Mensagem recebida:', {
      from: message.from,
      type: message.type,
      hasBody: !!message.body,
      bodyPreview: message.body?.substring(0, 50) || '[Mídia]'
    });
    
    // Ignorar mensagens de grupos e status
    if (message.isGroupMsg || message.isStatusReply) {
  console.log('🚫 Ignorando mensagem de grupo/status');
  return;
}

// ✅ NOVO: Filtrar mensagens inválidas
if (!message.from || 
    message.from.includes('status@broadcast') || 
    message.from.includes('@g.us') || 
    message.from === 'status@broadcast') {
  console.log('🚫 Ignorando mensagem de broadcast/grupo:', message.from);
  return;
}

    // CORREÇÃO: Validar message.from
    if (!message.from || typeof message.from !== 'string') {
      console.error('❌ Mensagem sem remetente válido:', message);
      return;
    }

    // CORREÇÃO: Garantir que message.from é uma string válida
    const fromNumber = String(message.from);
    
    // Filtrar números inválidos
    if (!fromNumber.includes('@c.us')) {
      console.log('🚫 Número inválido ignorado:', fromNumber);
      return;
    }

    // Determinar nome do contato com fallbacks
    let contactName = null;
    if (message.sender) {
      contactName = message.sender.pushname || 
                   message.sender.verifiedName || 
                   message.sender.name ||
                   message.sender.formattedName;
    }
    
    if (!contactName) {
      contactName = fromNumber.split('@')[0]; // Usar número como fallback
    }
    
    // Sanitizar nome
    contactName = String(contactName).trim().substring(0, 100);

    console.log(`👤 Processando mensagem de: ${contactName} (${fromNumber})`);

    // Buscar ou criar contato
    const contact = await db.contacts.findOrCreate(fromNumber, contactName);
    
    console.log(`📋 Contato: ID=${contact.id}, Nome=${contact.name}`);

    // Buscar/atualizar avatar sempre (pode ter mudado)
    // Buscar/atualizar avatar com retry melhorado
    try {
      const session = sessions.get(sessionId);
      if (session && session.client) {
        // Só buscar avatar se não tiver ou for muito antigo (7 dias)
        const shouldUpdateAvatar = !contact.avatar || 
          !contact.avatar_updated_at || 
          (new Date() - new Date(contact.avatar_updated_at)) > (7 * 24 * 60 * 60 * 1000);
        
        if (shouldUpdateAvatar) {
          const avatarUrl = await this.getContactAvatarWithRetry(
            session.client, 
            message.from, 
            contact.name || contact.number
          );
          
          if (avatarUrl && contact.avatar !== avatarUrl) {
            await db.contacts.update(contact.id, { 
              avatar: avatarUrl,
              avatar_updated_at: new Date()
            });
            contact.avatar = avatarUrl;

            console.log(`✅ Avatar atualizado para ${contact.name || contact.number}`);
            console.log(`📸 URL: ${avatarUrl.substring(0, 100)}...`);

            // Notificar o frontend em tempo real
            this.io.emit('contact:update', {
              id: contact.id,
              avatar: avatarUrl
            });
          }
        }
      }
    } catch (err) {
      console.error('Falha ao obter avatar:', err.message);
    }

    // Atualizar última mensagem do contato
    await db.contacts.update(contact.id, {
      last_message: message.body?.substring(0, 100) || '[Mídia]',
      last_message_at: new Date()
    });

   // Determinar tipo da mensagem e processar conteúdo
    let messageType = 'text';
    let mediaUrl = null;
    let finalContent = message.body || '';

    console.log('🔍 PROCESSANDO MENSAGEM:', {
      type: message.type,
      mimetype: message.mimetype,
      hasBody: !!message.body,
      bodyLength: message.body?.length || 0,
      hasCaption: !!message.caption,
      isMedia: !!message.isMedia
    });

    // Identificar tipo de mídia - VERSÃO CORRIGIDA E SIMPLIFICADA
    if (message.type === 'image') {
      messageType = 'image';
      finalContent = message.caption || '';
    } else if (message.type === 'video') {
      messageType = 'video';
      finalContent = message.caption || '';
    } else if (message.type === 'audio' || message.type === 'ptt') {
      messageType = 'audio';
      finalContent = '';
    } else if (message.type === 'document') {
      messageType = 'document';
      finalContent = message.caption || message.filename || 'Documento';
    } else if (message.type === 'location') {
      messageType = 'location';
      if (message.lat && message.lng) {
        finalContent = `📍 Localização compartilhada\nLatitude: ${message.lat}\nLongitude: ${message.lng}`;
        if (message.loc) {
          finalContent += `\nEndereço: ${message.loc}`;
        }
      } else {
        finalContent = '📍 Localização compartilhada';
      }
    } else if (message.type === 'vcard' || message.type === 'contact_card') {
      messageType = 'contact';
      if (message.vcardList && message.vcardList.length > 0) {
        const contact = message.vcardList[0];
        finalContent = `👤 Contato compartilhado\nNome: ${contact.displayName || contact.formattedName || 'N/A'}`;
        if (contact.vcard) {
          const phoneMatch = contact.vcard.match(/TEL[^:]*:([^\r\n]+)/);
          if (phoneMatch) {
            finalContent += `\nTelefone: ${phoneMatch[1]}`;
          }
        }
      } else {
        finalContent = '👤 Contato compartilhado';
      }
    } else if (message.type === 'sticker') {
      messageType = 'sticker';
      finalContent = '';
    }

    // Processar mídia - LÓGICA COMPLETAMENTE REESCRITA
    if (['image', 'video', 'audio', 'document', 'sticker'].includes(messageType)) {
      console.log('📎 Processando mídia:', messageType);
      
      try {
        // SEMPRE tentar fazer download primeiro
        message.sessionId = sessionId;
        mediaUrl = await this.downloadMedia(message);
        
        if (mediaUrl) {
          console.log('✅ Mídia baixada com sucesso:', mediaUrl);
        } else {
          console.log('⚠️ Download falhou, tentando alternativas...');
          
          // Fallback 1: Base64 para imagens pequenas/médias
          if ((messageType === 'image' || messageType === 'sticker') && 
              message.body && 
              message.body.length > 500 && 
              message.body.length < 5000000) { // Até 5MB
            
            // Verificar se é base64 válido
            const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
            if (base64Pattern.test(message.body)) {
              mediaUrl = `data:${message.mimetype || 'image/jpeg'};base64,${message.body}`;
              console.log('🔄 Usando base64 como fallback');
            }
          }
          
          // Fallback 2: Áudio em base64
          if (messageType === 'audio' && message.body && message.body.length > 1000) {
            const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
            if (base64Pattern.test(message.body)) {
              mediaUrl = `data:${message.mimetype || 'audio/ogg'};base64,${message.body}`;
              console.log('🔄 Áudio base64 usado como fallback');
            }
          }
          
          // Se ainda não tem mediaUrl, marcar como erro
          if (!mediaUrl) {
            console.log('❌ Falha total ao processar mídia');
            finalContent = `[${messageType.toUpperCase()} - Erro ao baixar]`;
          }
        }
        
      } catch (error) {
        console.error('❌ Erro ao processar mídia:', error);
        finalContent = `[${messageType.toUpperCase()} - Erro: ${error.message}]`;
      }
    }

    // Salvar mensagem no banco
    const messageId = await db.messages.create({
      session_id: sessionId,
      contact_id: contact.id,
      content: finalContent,
      type: messageType,
      media_url: mediaUrl,
      is_from_me: false,
      status: 'received'
    });

    // Incrementar contador de não lidas
    await db.query(
      'UPDATE contacts SET unread_count = unread_count + 1 WHERE id = ?',
      [contact.id]
    );

    // Verificar se contato está em atendimento
    const activeQueue = await db.query(
      'SELECT * FROM queues WHERE contact_id = ? AND status IN (?, ?) ORDER BY id DESC LIMIT 1',
      [contact.id, 'waiting', 'attending']
    );

   // Verificar se há enquete ativa para este contato
    const activePoll = await this.checkActivePoll(contact.id, message.body);
    
    // Se não está em atendimento, adicionar à fila
    if (activeQueue.length === 0 && !activePoll) {
      const sector = await this.determineSector(message.body || '');
      
      // Criar fila primeiro
      const queueId = await db.queues.create(contact.id, sector);
      
     // **CORREÇÃO: SEMPRE TENTAR ENVIAR MENSAGEM DE BOAS-VINDAS**
      try {
        // Verificar se mensagens automáticas estão habilitadas
        const { db: database } = require('./database');
        const autoSettings = await database.settings.getAutoMessages();
        
        if (autoSettings.welcome.enabled) {
          // Verificar horário comercial usando o sistema existente
          const { businessHoursHelpers } = require('./auth');
          const isBusinessTime = await businessHoursHelpers.isBusinessHours();
          
          // Verificar se sistema de horário comercial está habilitado
          const businessHoursEnabled = await database.settings.get('business_hours_enabled');
          
          if (businessHoursEnabled && !isBusinessTime) {
            // Fora do horário: usar mensagem específica de horário comercial
            await this.sendBusinessHoursMessage(sessionId, message.from);
          } else {
            // Dentro do horário OU sistema de horário desabilitado: mensagem de boas-vindas normal
            await this.sendWelcomeMessage(sessionId, message.from, isBusinessTime);
          }
          
          console.log(`✅ Mensagem automática enviada para ${contact.number} - setor ${sector}`);
        } else {
          console.log(`ℹ️ Mensagens de boas-vindas desabilitadas - ${contact.number}`);
        }
      } catch (welcomeError) {
        console.error('❌ Erro ao enviar mensagem de boas-vindas:', welcomeError);
      }
      
      console.log(`Contato ${contact.number} adicionado à fila do setor ${sector}`);
    }

    // Emitir evento para frontend
    this.io.emit('message:received', {
      sessionId,
      messageId,
      contact: {
        id: contact.id,
        number: contact.number,
        name: contact.name
      },
      message: {
        content: finalContent,
        type: messageType,
        mediaUrl: mediaUrl,
        timestamp: new Date()
      }
    });
  }

  // Determinar setor baseado no conteúdo
  async determineSector(content) {
    if (!content) return 'Geral';

    const lowerContent = content.toLowerCase();
    
    // Palavras-chave por setor
    const keywords = {
      'Medicamento': ['remedio', 'medicamento', 'receita', 'generico', 'farmaco', 'comprimido', 'capsula'],
      'Perfumaria 1': ['perfume', 'cosmético', 'shampoo', 'creme', 'hidratante', 'sabonete'],
      'Perfumaria 2': ['maquiagem', 'batom', 'base', 'rímel', 'sombra', 'blush'],
      'Suplementos': ['vitamina', 'suplemento', 'whey', 'proteina', 'creatina', 'omega'],
      'Dermocosméticos': ['dermatite', 'acne', 'pele', 'dermatologico', 'antienvelhecimento'],
      'Caixa': ['pagar', 'pagamento', 'valor', 'preço', 'quanto', 'custo', 'desconto']
    };

    for (const [sector, words] of Object.entries(keywords)) {
      if (words.some(word => lowerContent.includes(word))) {
        return sector;
      }
    }

    return 'Geral';
  }

  // Baixar mídia - VERSÃO CORRIGIDA E ROBUSTA
  async downloadMedia(message) {
    try {
      const session = sessions.get(message.sessionId);
      if (!session || !session.client) {
        console.error('❌ Sessão não encontrada para baixar mídia');
        return null;
      }

      console.log('📥 Tentando baixar mídia...', {
        type: message.type,
        mimetype: message.mimetype,
        hasId: !!message.id
      });

      // Tentar diferentes métodos de download
      let buffer = null;
      
      // Método 1: decryptFile (padrão)
      try {
        buffer = await session.client.decryptFile(message);
        console.log('✅ Download via decryptFile bem-sucedido');
      } catch (decryptError) {
        console.log('⚠️ decryptFile falhou:', decryptError.message);
        
        // Método 2: downloadMedia (alternativo)
        try {
          buffer = await session.client.downloadMedia(message);
          console.log('✅ Download via downloadMedia bem-sucedido');
        } catch (downloadError) {
          console.log('⚠️ downloadMedia também falhou:', downloadError.message);
          
          // Método 3: getFileBuffer (se disponível)
          try {
            if (session.client.getFileBuffer) {
              buffer = await session.client.getFileBuffer(message.id);
              console.log('✅ Download via getFileBuffer bem-sucedido');
            }
          } catch (bufferError) {
            console.log('⚠️ getFileBuffer falhou:', bufferError.message);
          }
        }
      }
      
      if (!buffer || buffer.length === 0) {
        console.error('❌ Todos os métodos de download falharam');
        return null;
      }

      // Determinar extensão baseada no mimetype
      let extension = 'bin';
      if (message.mimetype) {
        const mimetypeLower = message.mimetype.toLowerCase();
        
        // Mapeamento mais completo de mimetypes
        const extensionMap = {
          'image/jpeg': 'jpg',
          'image/jpg': 'jpg',
          'image/png': 'png',
          'image/gif': 'gif',
          'image/webp': 'webp',
          'image/bmp': 'bmp',
          'video/mp4': 'mp4',
          'video/webm': 'webm',
          'video/ogg': 'ogv',
          'video/quicktime': 'mov',
          'video/avi': 'avi',
          'audio/ogg': 'ogg',
          'audio/mpeg': 'mp3',
          'audio/mp3': 'mp3',
          'audio/wav': 'wav',
          'audio/aac': 'aac',
          'audio/webm': 'webm',
          'application/pdf': 'pdf',
          'application/msword': 'doc',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
          'application/vnd.ms-excel': 'xls',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
          'text/plain': 'txt'
        };
        
        extension = extensionMap[mimetypeLower];
        
        if (!extension) {
          // Fallback para extrair da segunda parte do mimetype
          const parts = mimetypeLower.split('/');
          if (parts.length > 1) {
            extension = parts[1].split(';')[0]; // Remove parâmetros extras
            extension = extension.replace(/[^a-zA-Z0-9]/g, '').substring(0, 10) || 'bin';
          }
        }
      }
      
      // Determinar extensão por tipo de mensagem se mimetype falhar
      if (extension === 'bin') {
        const typeExtensions = {
          'image': 'jpg',
          'video': 'mp4',
          'audio': 'ogg',
          'document': 'pdf',
          'sticker': 'webp'
        };
        extension = typeExtensions[message.type] || 'bin';
      }
      
      // Gerar nome único do arquivo
      const timestamp = Date.now();
      const randomId = Math.random().toString(36).substring(2, 8);
      const messageId = message.id ? message.id.replace(/[^a-zA-Z0-9]/g, '').substring(0, 8) : randomId;
      const filename = `${timestamp}_${messageId}.${extension}`;
      const filepath = path.join(__dirname, 'uploads', filename);
      
      // Garantir que a pasta uploads existe
      const uploadsDir = path.join(__dirname, 'uploads');
      if (!fs.existsSync(uploadsDir)) {
        fs.mkdirSync(uploadsDir, { recursive: true });
        console.log('📁 Pasta uploads criada');
      }
      
      // Salvar arquivo
      fs.writeFileSync(filepath, buffer);
      const fileSizeMB = (buffer.length / 1024 / 1024).toFixed(2);
      console.log(`✅ Mídia salva: ${filename} (${fileSizeMB}MB)`);
      
      return `/uploads/${filename}`;
      
    } catch (error) {
      console.error('❌ Erro geral ao baixar mídia:', error);
      return null;
    }
  }

  // Enviar mensagem de boas-vindas
  async sendWelcomeMessage(sessionId, to, isBusinessTime = null) {
  try {
    // ✅ CORREÇÃO: Incluir sessionId na chave do cache
    const lastMessageKey = `welcome_${to}_${sessionId}`;
    const lastMessageTime = lastAutoMessages.get(lastMessageKey);
    const now = Date.now();
    
    if (lastMessageTime && (now - lastMessageTime) < 300000) { // 5 minutos
      console.log(`Mensagem de boas-vindas já enviada recentemente para ${to} via sessão ${sessionId}`);
      return;
    }

      // Mensagem padrão como fallback
      let welcomeMessage = '👋 Olá! Bem-vindo ao nosso atendimento. Em breve um de nossos atendentes irá lhe atender.';
      let messageEnabled = true;
      let messageDelay = 0;
      
      // Se isBusinessTime não foi passado, verificar automaticamente
      if (isBusinessTime === null) {
        try {
          const { businessHoursHelpers } = require('./auth');
          isBusinessTime = await businessHoursHelpers.isBusinessHours();
        } catch (timeError) {
          console.log('⚠️ Erro ao verificar horário, assumindo horário comercial');
          const hour = new Date().getHours();
          isBusinessTime = hour >= 8 && hour < 18;
        }
      }
      
      try {
        // **CORREÇÃO: Forçar recarregamento das configurações sem cache**
        delete require.cache[require.resolve('./database')];
        const database = require('./database');
        
        console.log('🔄 Recarregando configurações de boas-vindas...');
        const autoSettings = await database.db.settings.getAutoMessages();
        
        console.log('📋 Configurações carregadas:', {
          enabled: autoSettings.welcome.enabled,
          message: autoSettings.welcome.message?.substring(0, 50) + '...',
          afterHours: autoSettings.welcome.afterHoursMessage?.substring(0, 50) + '...'
        });
        
        // Aplicar configurações se carregadas com sucesso
        messageEnabled = autoSettings.welcome.enabled;
        if (autoSettings.welcome.message) {
          welcomeMessage = autoSettings.welcome.message;
          console.log('✅ Mensagem de boas-vindas atualizada');
        }
        if (autoSettings.welcome.afterHoursMessage) {
          afterHoursMessage = autoSettings.welcome.afterHoursMessage;
          console.log('✅ Mensagem fora do horário atualizada');
        }
        messageDelay = autoSettings.advanced.messageDelay || 0;
        
        // Verificar horário comercial
        try {
          const authHelpers = require('./auth');
          isBusinessTime = await authHelpers.businessHoursHelpers.isBusinessHours();
        } catch (timeError) {
          console.log('⚠️ Erro ao verificar horário comercial, assumindo horário comercial');
          const hour = new Date().getHours();
          isBusinessTime = hour >= 8 && hour < 18;
        }
        
        console.log('📋 Configurações de boas-vindas carregadas');
      } catch (configError) {
        console.log('⚠️ Usando configurações padrão:', configError.message);
        const hour = new Date().getHours();
        isBusinessTime = hour >= 8 && hour < 18;
      }
      
      // Se mensagens estão desabilitadas
      if (!messageEnabled) {
        console.log('ℹ️ Mensagens de boas-vindas desabilitadas');
        return;
      }
      
      // Escolher mensagem baseada no horário
      let finalMessage = isBusinessTime ? welcomeMessage : afterHoursMessage;
      
      // Processar variáveis básicas
      const saudacao = this.getSaudacao();
      finalMessage = finalMessage
        .replace(/\{\{nome\}\}/g, 'Cliente')
        .replace(/\{\{saudacao\}\}/g, saudacao)
        .replace(/\{\{data\}\}/g, new Date().toLocaleDateString('pt-BR'))
        .replace(/\{\{hora\}\}/g, new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
      
      console.log(`📤 Enviando boas-vindas (${isBusinessTime ? 'comercial' : 'fora do horário'})`);
      
      // Aplicar delay se configurado
      if (messageDelay > 0) {
        await new Promise(resolve => setTimeout(resolve, messageDelay * 1000));
      }
      
      // Enviar mensagem
      await this.sendMessage(sessionId, to, finalMessage);
      
      // Registrar que enviou a mensagem
      lastAutoMessages.set(lastMessageKey, now);
      console.log(`✅ Mensagem de boas-vindas enviada para ${to}`);
      
    } catch (error) {
      console.error('❌ Erro ao enviar mensagem de boas-vindas:', error);
    }
  }

  // Função auxiliar para obter saudação
  getSaudacao() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Bom dia';
    if (hour >= 12 && hour < 18) return 'Boa tarde';
    return 'Boa noite';
  }

  // Enviar mensagem de encerramento
  async sendGoodbyeMessage(sessionId, to, userSignature = null) {
  try {
    // ✅ VERIFICAÇÃO 1: Se sessionId foi especificado, usar APENAS ela
    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session || !session.client) {
        console.log(`❌ Sessão ${sessionId} não está ativa, não enviando despedida`);
        return;
      }
      console.log(`🎯 Usando sessão específica ${sessionId} para despedida`);
    } else {
      console.log(`⚠️ Nenhuma sessão específica fornecida para despedida`);
      return; // ✅ NÃO enviar se não especificou sessão
    }
    
    // Verificar se já enviou mensagem recentemente para evitar spam
    const lastMessageKey = `goodbye_${to}_${sessionId}`;
    const lastMessageTime = lastAutoMessages.get(lastMessageKey);
    const now = Date.now();
    
    if (lastMessageTime && (now - lastMessageTime) < 300000) { // 5 minutos
      console.log(`Despedida já enviada recentemente para ${to} via sessão ${sessionId}`);
      return;
    }
    
    // Mensagem padrão como fallback
    let goodbyeMessage = '👋 Agradecemos seu contato! Caso precise de algo mais, estamos à disposição.';
    let messageEnabled = true;
    let includeSignature = false;
    let includeRating = false;
    let messageDelay = 0;
    
    try {
      const autoSettings = await db.settings.getAutoMessages();
      
      messageEnabled = autoSettings.goodbye.enabled;
      if (autoSettings.goodbye.message) {
        goodbyeMessage = autoSettings.goodbye.message;
      }
      includeSignature = autoSettings.goodbye.includeSignature;
      includeRating = autoSettings.goodbye.includeRating;
      messageDelay = autoSettings.advanced.messageDelay || 0;
      
    } catch (configError) {
      console.log('⚠️ Usando configurações padrão de despedida:', configError.message);
    }
    
    if (!messageEnabled) {
      console.log('ℹ️ Mensagens de despedida desabilitadas');
      return;
    }
    
    // Processar variáveis básicas
    const saudacao = this.getSaudacao();
    let finalMessage = goodbyeMessage
      .replace(/\{\{nome\}\}/g, 'Cliente')
      .replace(/\{\{saudacao\}\}/g, saudacao)
      .replace(/\{\{data\}\}/g, new Date().toLocaleDateString('pt-BR'))
      .replace(/\{\{hora\}\}/g, new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    
    if (includeRating) {
      finalMessage += '\n\n⭐ Avalie nosso atendimento de 1 a 5 estrelas!';
    }
    
    const sendOptions = {};
    if (includeSignature && userSignature) {
      sendOptions.signature = userSignature;
    }
    
    console.log(`📤 Enviando despedida via sessão ${sessionId}`);
    
    if (messageDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, messageDelay * 1000));
    }
    
    // ✅ USAR SESSÃO ESPECÍFICA
    await this.sendMessage(sessionId, to, finalMessage, sendOptions);
    
    // Registrar que enviou a mensagem
    lastAutoMessages.set(lastMessageKey, now);
    console.log(`✅ Despedida enviada para ${to} via sessão ${sessionId}`);
    
  } catch (error) {
    console.error(`❌ Erro ao enviar despedida via sessão ${sessionId}:`, error);
    
    // Fallback simples
    try {
      if (sessionId && sessions.has(sessionId)) {
        await this.sendMessage(sessionId, to, '👋 Agradecemos seu contato!');
        console.log(`✅ Despedida fallback enviada via sessão ${sessionId}`);
      }
    } catch (fallbackError) {
      console.error('❌ Erro no fallback da despedida:', fallbackError);
    }
  }
}

  // Enviar mensagem de horário comercial
  async sendBusinessHoursMessage(sessionId, to) {
    try {
      // Verificar se já enviou mensagem recentemente (últimos 30 minutos)
      const lastMessageKey = `business_hours_${to}`;
      const lastMessageTime = lastAutoMessages.get(lastMessageKey);
      const now = Date.now();
      
      if (lastMessageTime && (now - lastMessageTime) < 1800000) { // 30 minutos
        console.log(`Mensagem de horário comercial já enviada recentemente para ${to}`);
        return;
      }
      
      const { businessHoursHelpers } = require('./auth');
      
      // Obter mensagem configurada
      let message = await db.settings.get('business_hours_message');
      
      if (!message) {
        // Mensagem padrão se não configurada
        message = '🏪 Olá! Nossa farmácia está fechada no momento.\n\n📅 Horário de funcionamento:\nSegunda a Sexta: 8h às 18h\nSábado: 8h às 12h\n\n📝 Sua mensagem foi registrada e responderemos assim que possível.';
      }
      
      // Processar variáveis na mensagem
      message = await businessHoursHelpers.processBusinessHoursMessage(message);
      
      await this.sendMessage(sessionId, to, message, {
        signature: 'Sistema Automático'
      });
      
      // Registrar que enviou a mensagem
      lastAutoMessages.set(lastMessageKey, now);
      console.log(`✅ Mensagem de horário comercial enviada para ${to}`);
      
    } catch (error) {
      console.error('❌ Erro ao enviar mensagem de horário comercial:', error);
    }
  }

  // Enviar mensagem - VERSÃO MELHORADA
  async sendMessage(sessionId, to, content, options = {}) {
    try {
      const session = sessions.get(sessionId);
      if (!session || !session.client) {
        throw new Error('Sessão não encontrada ou desconectada');
      }

      let result;
      
      console.log('📤 Enviando mensagem:', { 
        to: to.substring(0, 20) + '...', 
        type: options.type || 'text', 
        hasPath: !!options.path,
        contentLength: content?.length || 0
      });
      
      // Enviar baseado no tipo
      if (options.type === 'image' && options.path) {
        console.log('🖼️ Enviando imagem:', options.path);
        result = await session.client.sendImage(to, options.path, options.filename || 'image', content || '');
        
      } else if (options.type === 'document' && options.path) {
        console.log('📄 Enviando documento:', options.path);
        
        // Verificar se é áudio sendo enviado como documento
        const isAudio = options.filename && 
                       (options.filename.includes('audio') || 
                        options.path.includes('audio') ||
                        options.filename.match(/\.(ogg|mp3|wav|webm|m4a)$/i));
        
        if (isAudio) {
          console.log('🎵 Áudio detectado - enviando link para reprodução');
          
          // Extrair nome do arquivo para criar link público
          const filename = options.path.split('\\').pop().split('/').pop();
          const audioUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/uploads/${filename}`;
          
          // Enviar link para o áudio
          result = await session.client.sendText(
            to, 
            `🎵 *Mensagem de Voz*\n\n🔗 Clique para ouvir: ${audioUrl}\n\n_Ou acesse o link no seu navegador para reproduzir o áudio_`
          );
          console.log('✅ Link de áudio enviado:', audioUrl);
        } else {
          result = await session.client.sendFile(to, options.path, options.filename || 'document', content || '');
        }
        
      } else if (options.type === 'audio' && options.path) {
        console.log('🎵 Enviando áudio:', options.path);
        
        const fs = require('fs');
        const path = require('path');
        
        // Verificar se arquivo existe
        if (!fs.existsSync(options.path)) {
          throw new Error('Arquivo de áudio não encontrado: ' + options.path);
        }
        
        const fileExtension = path.extname(options.path).toLowerCase();
        console.log('📁 Extensão do arquivo:', fileExtension);
        
        try {
          console.log('🎵 Enviando áudio como mensagem de voz...');
          
          // Ler arquivo como base64
          const audioBuffer = fs.readFileSync(options.path);
          const audioBase64 = audioBuffer.toString('base64');
          
          // Determinar mimetype correto
          let mimeType = 'audio/ogg; codecs=opus';
          if (fileExtension === '.mp3') {
            mimeType = 'audio/mpeg';
          } else if (fileExtension === '.wav') {
            mimeType = 'audio/wav';
          } else if (fileExtension === '.m4a') {
            mimeType = 'audio/mp4';
          } else if (fileExtension === '.webm') {
            mimeType = 'audio/webm; codecs=opus';
          }
          
          // Criar data URI completo
          const audioDataUri = `data:${mimeType};base64,${audioBase64}`;
          
          // Tentar enviar como PTT/Voice
          console.log('🎤 Tentando enviar como mensagem de voz...');
          
          // Método 1: sendPttFromBase64 (mais comum no wppconnect)
          if (session.client.sendPttFromBase64) {
            result = await session.client.sendPttFromBase64(
              to,
              audioBase64,
              'voice-message'
            );
            console.log('✅ Áudio enviado via sendPttFromBase64');
          }
          // Método 2: sendVoice 
          else if (session.client.sendVoice) {
            result = await session.client.sendVoice(
              to,
              audioDataUri
            );
            console.log('✅ Áudio enviado via sendVoice');
          }
          // Método 3: sendAudio com flag PTT
          else if (session.client.sendAudio) {
            result = await session.client.sendAudio(
              to,
              audioDataUri,
              'voice-message',
              '',
              true // flag PTT
            );
            console.log('✅ Áudio enviado via sendAudio com flag PTT');
          }
          // Método 4: sendFile com mimetype de áudio
          else {
            console.log('⚠️ Nenhum método de áudio nativo encontrado, usando sendFile...');
            result = await session.client.sendFile(
              to,
              audioDataUri,
              'voice-message',
              '🎵 Mensagem de voz'
            );
            console.log('✅ Áudio enviado via sendFile');
          }
          
          console.log('✅ Áudio PTT enviado com sucesso');
          
        } catch (audioError) {
          console.error('❌ sendPtt falhou:', audioError.message);
          
          // FALLBACK 1: Tentar sendVoice se existir
          try {
            if (session.client.sendVoice) {
              console.log('🎤 Tentando sendVoice...');
              result = await session.client.sendVoice(
                to,
                options.path
              );
              console.log('✅ Áudio enviado via sendVoice');
            } else {
              throw new Error('sendVoice não disponível');
            }
          } catch (voiceError) {
            console.error('❌ sendVoice falhou:', voiceError.message);
            
            // FALLBACK 2: Enviar como arquivo comum
            try {
              console.log('📄 Tentando como arquivo comum...');
              result = await session.client.sendFile(
                to, 
                options.path, 
                'voice-message.ogg',
                '🎵 Mensagem de voz'
              );
              console.log('✅ Áudio enviado como arquivo');
            } catch (fileError) {
              console.error('❌ Envio como arquivo também falhou:', fileError.message);
              throw new Error(`Falha completa no envio de áudio: ${audioError.message}`);
            }
          }
        }
        
      } else if (options.type === 'video' && options.path) {
        console.log('🎥 Enviando vídeo:', options.path);
        result = await session.client.sendVideoAsGif(to, options.path, options.filename || 'video', content || '');
        
      } else {
        // Mensagem de texto
        let finalContent = content || '';
        if (options.signature) {
          finalContent += `\n\n_${options.signature}_`;
        }
        
        // Verificar se o conteúdo não está vazio
        if (!finalContent.trim()) {
          finalContent = '📝 Mensagem enviada';
        }
        
        result = await session.client.sendText(to, finalContent);
      }

      console.log('✅ Mensagem enviada com sucesso');
      
      return {
        success: true,
        messageId: result?.id || result?._serialized || 'temp_' + Date.now()
      };

    } catch (error) {
      console.error('❌ Erro ao enviar mensagem:', error.message);
      throw new Error(`Falha no envio: ${error.message}`);
    }
  }

  // Lidar com QR Code
  async handleQRCode(sessionId, qrCode) {
    await db.sessions.update(sessionId, {
      qrcode: qrCode,
      status: 'connecting'
    });

    this.io.emit('session:qr', {
      sessionId,
      qrCode
    });
  }

  // Lidar com mudança de status
  async handleStatus(sessionId, status) {
    let dbStatus = 'disconnected';
    
    if (status === 'isLogged' || status === 'inChat') {
      dbStatus = 'connected';
    } else if (status === 'qrReadSuccess' || status === 'isConnecting') {
      dbStatus = 'connecting';
    }

    await db.sessions.update(sessionId, { status: dbStatus });
    
    this.io.emit('session:status', {
      sessionId,
      status: dbStatus
    });
  }

  // Lidar com desconexão
  async handleDisconnect(sessionId) {
    const session = sessions.get(sessionId);
    if (session && session.client) {
      try {
        await session.client.close();
      } catch (error) {
        console.error('Erro ao fechar cliente:', error);
      }
    }

    // Limpar recursos específicos da sessão
    if (session) {
      await this.cleanupSessionResources(sessionId, session.name);
    }

    sessions.delete(sessionId);
    
    await db.sessions.update(sessionId, {
      status: 'disconnected',
      qrcode: null
    });

    this.io.emit('session:disconnected', { sessionId });
    console.log(`🔌 Sessão ${sessionId} desconectada e recursos limpos`);
  }

  // Desconectar sessão
  async disconnectSession(sessionId) {
    await this.handleDisconnect(sessionId);
  }

  // Obter todas as sessões
  getSessions() {
    const activeSessions = [];
    sessions.forEach((session, id) => {
      activeSessions.push({
        id,
        name: session.name,
        status: session.status
      });
    });
    return activeSessions;
  }

  // Verificar se sessão está ativa
  isSessionActive(sessionId) {
    return sessions.has(sessionId);
  }

  // Obter cliente da sessão
  getClient(sessionId) {
    const session = sessions.get(sessionId);
    return session ? session.client : null;
  }
  
  // Verificar e processar enquetes ativas
  async checkActivePoll(contactId, messageText) {
    try {
      // Buscar enquete ativa para este contato
      const activePoll = await db.polls.findActiveByContact(contactId);
      
      if (!activePoll) {
        return false;
      }
      
      // Verificar se expirou
      if (activePoll.expires_at && new Date() > new Date(activePoll.expires_at)) {
        await db.polls.updateStatus(activePoll.id, 'expired');
        return false;
      }
      
      // Verificar se já respondeu
      const hasResponded = await db.pollResponses.hasResponded(activePoll.id, contactId);
      if (hasResponded) {
        return false;
      }
      
      // Processar resposta
      const response = await this.processPollResponse(activePoll, messageText);
      if (response) {
        // Salvar resposta
        await db.pollResponses.create({
          poll_id: activePoll.id,
          contact_id: contactId,
          selected_options: response.selectedOptions,
          response_text: messageText
        });
        
        // Enviar confirmação
        await this.sendPollConfirmation(activePoll, response, contactId);
        
        console.log(`✅ Resposta de enquete processada para contato ${contactId}`);
        return true;
      }
      
      return false;
      
    } catch (error) {
      console.error('Erro ao verificar enquete ativa:', error);
      return false;
    }
  }

  // Processar resposta da enquete
  async processPollResponse(poll, messageText) {
    try {
      const cleanText = messageText.trim().toLowerCase();
      const selectedOptions = [];
      
      // Verificar se é resposta numérica
      const numbers = cleanText.match(/\d+/g);
      if (numbers) {
        for (const num of numbers) {
          const optionIndex = parseInt(num);
          if (optionIndex >= 1 && optionIndex <= poll.options.length) {
            selectedOptions.push(optionIndex);
            
            // Para enquete de escolha única, parar no primeiro número válido
            if (poll.poll_type === 'single') {
              break;
            }
          }
        }
      }
      
      // Se não encontrou números válidos, tentar buscar por texto
      if (selectedOptions.length === 0) {
        for (let i = 0; i < poll.options.length; i++) {
          const option = poll.options[i].toLowerCase();
          if (cleanText.includes(option) || option.includes(cleanText)) {
            selectedOptions.push(i + 1);
            if (poll.poll_type === 'single') {
              break;
            }
          }
        }
      }
      
      if (selectedOptions.length === 0) {
        return null; // Resposta inválida
      }
      
      // Para enquete múltipla, remover duplicatas
      const uniqueOptions = [...new Set(selectedOptions)];
      
      return {
        selectedOptions: uniqueOptions,
        optionTexts: uniqueOptions.map(index => poll.options[index - 1])
      };
      
    } catch (error) {
      console.error('Erro ao processar resposta da enquete:', error);
      return null;
    }
  }

  // Enviar confirmação da resposta
  async sendPollConfirmation(poll, response, contactId) {
    try {
      const contact = await db.query('SELECT number FROM contacts WHERE id = ?', [contactId]);
      if (!contact.length) return;
      
      const selectedTexts = response.optionTexts.join(', ');
      const message = `✅ *Resposta registrada!*\n\n` +
                     `📊 **${poll.question}**\n\n` +
                     `Sua resposta: ${selectedTexts}\n\n` +
                     `_Obrigado por participar!_`;
      
      // Buscar sessão ativa
      const sessions = await db.sessions.list();
      const activeSession = sessions.find(s => s.status === 'connected');
      
      if (activeSession) {
        await this.sendMessage(activeSession.id, contact[0].number, message);
      }
      
    } catch (error) {
      console.error('Erro ao enviar confirmação da enquete:', error);
    }
  }

  // Enviar enquete para contato
  async sendPollToContact(sessionId, contactNumber, pollData) {
    try {
      let message = `📊 *${pollData.question}*\n\n`;
      
      pollData.options.forEach((option, index) => {
        const emoji = pollData.poll_type === 'single' ? '🔘' : '☐';
        message += `${emoji} ${index + 1}. ${option}\n`;
      });
      
      message += `\n_Responda com o número da opção`;
      if (pollData.poll_type === 'multiple') {
        message += ' (pode escolher várias separadas por vírgula)';
      }
      message += '_';
      
      if (pollData.expires_at) {
        const expiresDate = new Date(pollData.expires_at);
        message += `\n\n⏰ _Expira em: ${expiresDate.toLocaleString('pt-BR')}_`;
      }
      
      const result = await this.sendMessage(sessionId, contactNumber, message);
      
      // Atualizar enquete com message_id se disponível
      if (result.messageId && pollData.id) {
        await db.query('UPDATE polls SET message_id = ? WHERE id = ?', [result.messageId, pollData.id]);
      }
      
      return result;
      
    } catch (error) {
      console.error('Erro ao enviar enquete:', error);
      throw error;
    }
  }

  // Limpeza periódica do cache de mensagens automáticas
  startCacheCleanup() {
    setInterval(() => {
      const now = Date.now();
      const maxAge = 3600000; // 1 hora
      
      for (const [key, timestamp] of lastAutoMessages.entries()) {
        if (now - timestamp > maxAge) {
          lastAutoMessages.delete(key);
        }
      }
      
      console.log(`🧹 Cache de mensagens automáticas limpo. Entradas restantes: ${lastAutoMessages.size}`);
    }, 1800000); // Limpar a cada 30 minutos
  }
 // NOVA FUNÇÃO - RESTAURAÇÃO DE SESSÃO
async forceReconnectAllSessions() {
  try {
    console.log('🔄 Forçando reconexão de todas as sessões...');
    
    const dbSessions = await db.sessions.list();
    
    for (const session of dbSessions) {
      if (session.status === 'connected' || session.status === 'connecting') {
        console.log(`🔄 Forçando reconexão: ${session.name}`);
        
        try {
          // Tentar restaurar
          await this.restoreSession(session.id, session.name);
          console.log(`✅ ${session.name} reconectada`);
        } catch (error) {
          console.log(`❌ Falha ao reconectar ${session.name}:`, error.message);
          
          // Marcar como desconectada para tentar nova conexão
          await db.sessions.update(session.id, { status: 'disconnected' });
        }
      }
    }
    
    console.log('✅ Reconexão forçada concluída');
  } catch (error) {
    console.error('❌ Erro na reconexão forçada:', error);
  }
} 
}

// Exportar a classe
module.exports = WhatsAppService;