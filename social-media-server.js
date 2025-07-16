// social-server.js - Sistema de Redes Sociais SIMPLES
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const axios = require('axios');
const crypto = require('crypto');
const session = require('express-session');

require('dotenv').config();

// ===========================================
// CONFIGURAÇÃO BÁSICA
// ===========================================

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'social-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// ===========================================
// VERIFICAÇÕES INICIAIS
// ===========================================

console.log('🚀 Iniciando Sistema de Redes Sociais...');

// Verificar variáveis obrigatórias
const requiredEnvVars = ['FB_APP_ID', 'FB_APP_SECRET', 'WEBHOOK_BASE_URL'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
    console.error('❌ ERRO: Variáveis de ambiente obrigatórias não encontradas:');
    missingVars.forEach(varName => {
        console.error(`   - ${varName}`);
    });
    console.log('\n📝 Adicione estas variáveis no seu arquivo .env:');
    console.log('FB_APP_ID=seu_app_id_facebook');
    console.log('FB_APP_SECRET=seu_app_secret_facebook');
    console.log('WEBHOOK_BASE_URL=https://seu-dominio.com');
    console.log('\n💡 Obtenha as credenciais em: https://developers.facebook.com');
    process.exit(1);
}

console.log('✅ Configurações carregadas:');
console.log('   App ID:', process.env.FB_APP_ID);
console.log('   Webhook URL:', process.env.WEBHOOK_BASE_URL);

// ===========================================
// GERENCIADOR DE REDES SOCIAIS
// ===========================================

class SocialManager {
    constructor() {
        // Estado das conexões
        this.connections = {
            facebook: {
                connected: false,
                pageAccessToken: null,
                pageId: null,
                pageName: null,
                appScopedUserId: null
            },
            instagram: {
                connected: false,
                accessToken: null,
                businessAccountId: null,
                username: null
            }
        };
        
        // Armazenamento em memória (depois pode virar banco)
        this.conversations = new Map();
        this.messages = new Map();
        
        console.log('💬 Social Manager iniciado');
    }

    // ===========================================
    // FACEBOOK OAUTH
    // ===========================================
    
    generateLoginUrl() {
        const scopes = [
            'pages_manage_metadata',
            'pages_messaging', 
            'pages_read_engagement',
            'pages_show_list'
        ].join(',');
        
        const state = crypto.randomBytes(16).toString('hex');
        const redirectUri = `${process.env.WEBHOOK_BASE_URL}/auth/facebook/callback`;
        
        const params = new URLSearchParams({
            client_id: process.env.FB_APP_ID,
            redirect_uri: redirectUri,
            scope: scopes,
            response_type: 'code',
            state: state
        });
        
        return `https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`;
    }
    
    async handleCallback(code) {
        try {
            console.log('🔄 Processando callback...');
            
            // 1. Trocar code por access token
            const tokenResponse = await axios.get('https://graph.facebook.com/v18.0/oauth/access_token', {
                params: {
                    client_id: process.env.FB_APP_ID,
                    client_secret: process.env.FB_APP_SECRET,
                    redirect_uri: `${process.env.WEBHOOK_BASE_URL}/auth/facebook/callback`,
                    code: code
                }
            });
            
            const userAccessToken = tokenResponse.data.access_token;
            console.log('✅ User token obtido');
            
            // 2. Buscar páginas
            const pagesResponse = await axios.get('https://graph.facebook.com/v18.0/me/accounts', {
                params: {
                    access_token: userAccessToken,
                    fields: 'id,name,access_token,instagram_business_account{id,username}'
                }
            });
            
            const pages = pagesResponse.data.data;
            
            if (pages.length === 0) {
                throw new Error('Nenhuma página encontrada. Você precisa ter uma página do Facebook.');
            }
            
            // 3. Conectar primeira página
            const page = pages[0];
            
            this.connections.facebook = {
                connected: true,
                pageAccessToken: page.access_token,
                pageId: page.id,
                pageName: page.name,
                appScopedUserId: null
            };
            
            console.log(`✅ Facebook conectado: ${page.name}`);
            
            // 4. Conectar Instagram se disponível
            if (page.instagram_business_account) {
                this.connections.instagram = {
                    connected: true,
                    accessToken: page.access_token,
                    businessAccountId: page.instagram_business_account.id,
                    username: page.instagram_business_account.username
                };
                console.log(`📸 Instagram conectado: @${page.instagram_business_account.username}`);
            }
            
            // 5. Configurar webhook
            await this.setupWebhook();
            
            return {
                success: true,
                facebook: this.connections.facebook,
                instagram: this.connections.instagram
            };
            
        } catch (error) {
            console.error('❌ Erro no callback:', error.response?.data || error.message);
            throw error;
        }
    }
    
    async setupWebhook() {
        try {
            const { pageId, pageAccessToken } = this.connections.facebook;
            
            // Inscrever página no webhook
            await axios.post(`https://graph.facebook.com/v18.0/${pageId}/subscribed_apps`, {
                subscribed_fields: 'messages,messaging_postbacks',
                access_token: pageAccessToken
            });
            
            console.log('✅ Webhook configurado');
        } catch (error) {
            console.warn('⚠️ Webhook não configurado:', error.response?.data || error.message);
        }
    }

    // ===========================================
    // PROCESSAMENTO DE MENSAGENS
    // ===========================================
    
    async processMessage(platform, senderId, messageData) {
        try {
            console.log(`📥 Nova mensagem ${platform} de ${senderId}`);
            
            // Buscar nome do usuário
            let userName = `Usuário ${senderId.slice(-4)}`;
            try {
                const userInfo = await this.getUserInfo(platform, senderId);
                userName = userInfo.name || userName;
            } catch (e) {
                console.warn('⚠️ Não foi possível buscar nome do usuário');
            }
            
            // Criar/atualizar conversa
            const conversationId = `${platform}_${senderId}`;
            
            if (!this.conversations.has(conversationId)) {
                this.conversations.set(conversationId, {
                    id: conversationId,
                    platform,
                    senderId,
                    name: userName,
                    avatar: null,
                    lastMessage: '',
                    lastMessageAt: new Date(),
                    unreadCount: 0
                });
            }
            
            // Salvar mensagem
            const message = {
                id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                conversationId,
                platform,
                senderId,
                content: messageData.text || '',
                type: messageData.attachment ? 'media' : 'text',
                mediaUrl: messageData.attachment?.payload?.url || null,
                isFromMe: false,
                timestamp: new Date()
            };
            
            if (!this.messages.has(conversationId)) {
                this.messages.set(conversationId, []);
            }
            this.messages.get(conversationId).push(message);
            
            // Atualizar conversa
            const conversation = this.conversations.get(conversationId);
            conversation.lastMessage = message.content || '[Mídia]';
            conversation.lastMessageAt = message.timestamp;
            conversation.unreadCount += 1;
            
            // Emitir para frontend
            io.emit('social:message', message);
            io.emit('social:conversation-updated', conversation);
            
            console.log(`✅ Mensagem processada: ${message.content}`);
            
        } catch (error) {
            console.error('❌ Erro ao processar mensagem:', error);
        }
    }
    
    async getUserInfo(platform, userId) {
        const connection = this.connections[platform];
        
        if (platform === 'facebook') {
            const response = await axios.get(`https://graph.facebook.com/v18.0/${userId}`, {
                params: {
                    fields: 'first_name,last_name,profile_pic',
                    access_token: connection.pageAccessToken
                }
            });
            
            return {
                name: `${response.data.first_name} ${response.data.last_name || ''}`.trim(),
                avatar: response.data.profile_pic
            };
        }
        
        if (platform === 'instagram') {
            const response = await axios.get(`https://graph.facebook.com/v18.0/${userId}`, {
                params: {
                    fields: 'name,profile_pic',
                    access_token: connection.accessToken
                }
            });
            
            return {
                name: response.data.name,
                avatar: response.data.profile_pic
            };
        }
    }

    // ===========================================
    // ENVIO DE MENSAGENS
    // ===========================================
    
    async sendMessage(platform, recipientId, text) {
        try {
            const connection = this.connections[platform];
            
            if (!connection.connected) {
                throw new Error(`${platform} não está conectado`);
            }
            
            let url, payload;
            
            if (platform === 'facebook') {
                url = `https://graph.facebook.com/v18.0/${connection.pageId}/messages`;
                payload = {
                    recipient: { id: recipientId },
                    message: { text: text },
                    access_token: connection.pageAccessToken
                };
            } else if (platform === 'instagram') {
                url = `https://graph.facebook.com/v18.0/${connection.businessAccountId}/messages`;
                payload = {
                    recipient: { id: recipientId },
                    message: { text: text },
                    messaging_type: 'RESPONSE',
                    access_token: connection.accessToken
                };
            }
            
            const response = await axios.post(url, payload);
            
            console.log(`✅ Mensagem enviada para ${recipientId}`);
            
            // Salvar mensagem enviada
            const conversationId = `${platform}_${recipientId}`;
            const message = {
                id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                conversationId,
                platform,
                senderId: recipientId,
                content: text,
                type: 'text',
                mediaUrl: null,
                isFromMe: true,
                timestamp: new Date()
            };
            
            if (!this.messages.has(conversationId)) {
                this.messages.set(conversationId, []);
            }
            this.messages.get(conversationId).push(message);
            
            // Atualizar conversa
            if (this.conversations.has(conversationId)) {
                const conversation = this.conversations.get(conversationId);
                conversation.lastMessage = text;
                conversation.lastMessageAt = message.timestamp;
                
                io.emit('social:conversation-updated', conversation);
            }
            
            io.emit('social:message', message);
            
            return response.data;
            
        } catch (error) {
            console.error(`❌ Erro ao enviar mensagem:`, error.response?.data || error.message);
            throw error;
        }
    }

    // ===========================================
    // UTILITÁRIOS
    // ===========================================
    
    getStatus() {
        return {
            facebook: {
                connected: this.connections.facebook.connected,
                pageName: this.connections.facebook.pageName,
                pageId: this.connections.facebook.pageId
            },
            instagram: {
                connected: this.connections.instagram.connected,
                username: this.connections.instagram.username,
                businessAccountId: this.connections.instagram.businessAccountId
            }
        };
    }
    
    getConversations() {
        return Array.from(this.conversations.values())
            .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
    }
    
    getMessages(conversationId) {
        return this.messages.get(conversationId) || [];
    }
    
    disconnect() {
        this.connections.facebook.connected = false;
        this.connections.instagram.connected = false;
        console.log('📱 Desconectado de todas as plataformas');
    }
}

// Instância global
const socialManager = new SocialManager();

// ===========================================
// ROTAS DE AUTENTICAÇÃO
// ===========================================

// Redirecionar para Facebook
app.get('/auth/facebook', (req, res) => {
    try {
        const loginUrl = socialManager.generateLoginUrl();
        console.log('🔗 Redirecionando para Facebook OAuth');
        res.redirect(loginUrl);
    } catch (error) {
        console.error('❌ Erro ao gerar URL:', error);
        res.status(500).json({ error: error.message });
    }
});

// Callback do Facebook
app.get('/auth/facebook/callback', async (req, res) => {
    try {
        const { code, error } = req.query;
        
        if (error) {
            console.error('❌ Erro de autorização:', error);
            return res.redirect(`${process.env.MAIN_SYSTEM_URL || 'http://localhost:3000'}?social_error=${encodeURIComponent(error)}`);
        }
        
        if (!code) {
            return res.redirect(`${process.env.MAIN_SYSTEM_URL || 'http://localhost:3000'}?social_error=${encodeURIComponent('Código não recebido')}`);
        }
        
        const result = await socialManager.handleCallback(code);
        
        console.log('✅ Callback processado com sucesso');
        res.redirect(`${process.env.MAIN_SYSTEM_URL || 'http://localhost:3000'}?social_success=1`);
        
    } catch (error) {
        console.error('❌ Erro no callback:', error);
        res.redirect(`${process.env.MAIN_SYSTEM_URL || 'http://localhost:3000'}?social_error=${encodeURIComponent(error.message)}`);
    }
});

// ===========================================
// API ROUTES
// ===========================================

// Status das conexões
app.get('/api/social/status', (req, res) => {
    res.json(socialManager.getStatus());
});

// URL de login
app.get('/api/social/login-url', (req, res) => {
    try {
        const loginUrl = socialManager.generateLoginUrl();
        res.json({ loginUrl });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Conversas
app.get('/api/social/conversations', (req, res) => {
    res.json(socialManager.getConversations());
});

// Mensagens de uma conversa
app.get('/api/social/conversations/:conversationId/messages', (req, res) => {
    const { conversationId } = req.params;
    res.json(socialManager.getMessages(conversationId));
});

// Enviar mensagem
app.post('/api/social/send', async (req, res) => {
    try {
        const { platform, recipientId, text } = req.body;
        
        if (!platform || !recipientId || !text) {
            return res.status(400).json({ error: 'Platform, recipientId e text são obrigatórios' });
        }
        
        const result = await socialManager.sendMessage(platform, recipientId, text);
        res.json({ success: true, result });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Desconectar
app.post('/api/social/disconnect', (req, res) => {
    socialManager.disconnect();
    res.json({ success: true, message: 'Desconectado' });
});

// ===========================================
// WEBHOOKS
// ===========================================

// Facebook Webhook - Verificação
app.get('/webhook/facebook', (req, res) => {
    const verifyToken = process.env.FB_WEBHOOK_VERIFY_TOKEN || 'facebook_webhook_2024';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    console.log('🔍 Verificação webhook Facebook:', { mode, token });
    
    if (mode && token === verifyToken) {
        console.log('✅ Webhook Facebook verificado');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Falha na verificação webhook Facebook');
        res.sendStatus(403);
    }
});

// Facebook Webhook - Receber mensagens
app.post('/webhook/facebook', (req, res) => {
    console.log('📨 Webhook Facebook recebido');
    
    req.body.entry?.forEach(entry => {
        entry.messaging?.forEach(async (messagingEvent) => {
            if (messagingEvent.message) {
                await socialManager.processMessage(
                    'facebook',
                    messagingEvent.sender.id,
                    messagingEvent.message
                );
            }
        });
    });
    
    res.sendStatus(200);
});

// Instagram Webhook - Verificação
app.get('/webhook/instagram', (req, res) => {
    const verifyToken = process.env.IG_WEBHOOK_VERIFY_TOKEN || 'instagram_webhook_2024';
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    console.log('🔍 Verificação webhook Instagram:', { mode, token });
    
    if (mode && token === verifyToken) {
        console.log('✅ Webhook Instagram verificado');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Falha na verificação webhook Instagram');
        res.sendStatus(403);
    }
});

// Instagram Webhook - Receber mensagens
app.post('/webhook/instagram', (req, res) => {
    console.log('📨 Webhook Instagram recebido');
    
    req.body.entry?.forEach(entry => {
        entry.messaging?.forEach(async (messagingEvent) => {
            if (messagingEvent.message) {
                await socialManager.processMessage(
                    'instagram',
                    messagingEvent.sender.id,
                    messagingEvent.message
                );
            }
        });
    });
    
    res.sendStatus(200);
});

// ===========================================
// ROTAS DE TESTE E SAÚDE
// ===========================================

app.get('/', (req, res) => {
    res.json({
        message: '🚀 Sistema de Redes Sociais Ativo',
        version: '1.0.0',
        status: 'OK',
        connections: socialManager.getStatus(),
        features: [
            '✅ Facebook Messenger',
            '✅ Instagram Business',
            '✅ OAuth Automático',
            '✅ Webhooks',
            '✅ Socket.IO'
        ]
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        connections: socialManager.getStatus()
    });
});

// ===========================================
// SOCKET.IO
// ===========================================

io.on('connection', (socket) => {
    console.log('📱 Cliente conectado:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('📱 Cliente desconectado:', socket.id);
    });
});

// ===========================================
// INICIAR SERVIDOR
// ===========================================

const PORT = process.env.SOCIAL_PORT || 3001;

server.listen(PORT, () => {
    console.log(`
🎉========================================🎉
🚀 SISTEMA DE REDES SOCIAIS ONLINE!
🌐 URL: http://localhost:${PORT}
🔗 Facebook OAuth: http://localhost:${PORT}/auth/facebook
📊 Status: http://localhost:${PORT}/api/social/status
🏥 Health: http://localhost:${PORT}/health
🎉========================================🎉
    `);
});

// Tratamento de erros
process.on('uncaughtException', (error) => {
    console.error('❌ Erro não capturado:', error);
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Promise rejeitada:', error);
});

module.exports = { socialManager, app, io };