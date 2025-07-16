// social-frontend.js - Frontend SIMPLES para Redes Sociais
// Substitua o conteúdo do seu app2.js por este código

// app2.js - Sistema de Redes Sociais SIMPLES
let socialSocket = null;
let currentSocialView = 'whatsapp';
let currentSocialContact = null;
let socialConversations = new Map();

// URL do servidor social
function getSocialServerUrl() {
    const hostname = window.location.hostname;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
        return 'http://localhost:3001';
    }
    return `${window.location.protocol}//${hostname}:3001`;
}

// Inicializar sistema social
function initSocialSystem() {
    console.log('🚀 Inicializando Sistema de Redes Sociais...');
    
    // Verificar se elementos existem
    const socialToggleBtn = document.getElementById('social-toggle-btn');
    if (!socialToggleBtn) {
        console.log('ℹ️ Botão de redes sociais não encontrado');
        return;
    }
    
    // Conectar Socket.IO
    connectSocialSocket();
    
    // Verificar status inicial
    checkSocialStatus();
    
    // Verificar callbacks de OAuth
    checkAuthCallbacks();
    
    console.log('✅ Sistema de redes sociais carregado');
}

function connectSocialSocket() {
    const serverUrl = getSocialServerUrl();
    console.log('🌐 Conectando ao servidor social:', serverUrl);
    
    socialSocket = io(serverUrl, {
        timeout: 10000,
        reconnection: true,
        reconnectionDelay: 3000,
        reconnectionAttempts: 5
    });
    
    socialSocket.on('connect', () => {
        console.log('✅ Conectado ao servidor social');
        hideSocialError();
    });
    
    socialSocket.on('connect_error', (error) => {
        console.error('❌ Erro de conexão:', error);
        showSocialError('Servidor social offline. Inicie: node social-media-server.js');
    });
    
    socialSocket.on('social:message', (message) => {
        console.log('📨 Nova mensagem:', message);
        handleNewSocialMessage(message);
    });
    
    socialSocket.on('social:conversation-updated', (conversation) => {
        console.log('🔄 Conversa atualizada:', conversation);
        updateSocialConversationInList(conversation);
    });
    
    socialSocket.on('disconnect', () => {
        console.log('🔌 Desconectado do servidor social');
    });
}

// Verificar status das conexões
async function checkSocialStatus() {
    try {
        const response = await fetch(`${getSocialServerUrl()}/api/social/status`);
        
        if (!response.ok) {
            throw new Error(`Servidor retornou ${response.status}`);
        }
        
        const status = await response.json();
        console.log('📊 Status:', status);
        
        updateConnectionStatus('facebook', status.facebook);
        updateConnectionStatus('instagram', status.instagram);
        
        // Carregar conversas se conectado
        if (status.facebook.connected || status.instagram.connected) {
            loadSocialConversations();
        }
        
    } catch (error) {
        console.error('❌ Erro ao verificar status:', error);
        updateConnectionStatus('facebook', { connected: false });
        updateConnectionStatus('instagram', { connected: false });
        showSocialError('Não foi possível conectar ao servidor social');
    }
}

function updateConnectionStatus(platform, status) {
    // Atualizar status na interface
    const statusEl = document.getElementById(`${platform}-status`);
    if (statusEl) {
        statusEl.className = `platform-status ${status.connected ? 'connected' : 'disconnected'}`;
        statusEl.innerHTML = status.connected ? 
            `<i class="bi bi-check-circle-fill text-success"></i> Conectado` :
            `<i class="bi bi-x-circle-fill text-danger"></i> Desconectado`;
    }
    
    // Mostrar informações se conectado
    const infoEl = document.getElementById(`${platform}-info`);
    if (infoEl) {
        let infoText = '';
        if (status.connected) {
            if (platform === 'facebook' && status.pageName) {
                infoText = `📄 ${status.pageName}`;
            } else if (platform === 'instagram' && status.username) {
                infoText = `📸 @${status.username}`;
            }
        }
        infoEl.innerHTML = infoText;
        infoEl.style.display = infoText ? 'block' : 'none';
    }
}

// CONECTAR COM FACEBOOK
async function connectWithFacebook() {
    try {
        console.log('🔄 Iniciando conexão com Facebook...');
        showConnectingSpinner(true);
        
        // Verificar se servidor está online
        const healthResponse = await fetch(`${getSocialServerUrl()}/health`);
        if (!healthResponse.ok) {
            throw new Error('Servidor social offline');
        }
        
        // Obter URL de login
        const response = await fetch(`${getSocialServerUrl()}/api/social/login-url`);
        if (!response.ok) {
            throw new Error('Erro ao gerar URL de login');
        }
        
        const data = await response.json();
        console.log('🔗 Abrindo popup de login...');
        
        // Abrir popup
        const popup = window.open(
            data.loginUrl,
            'facebook-login',
            'width=600,height=700,scrollbars=yes,resizable=yes'
        );
        
        if (!popup) {
            throw new Error('Popup bloqueado! Permita popups para este site.');
        }
        
        // Monitorar popup
        const checkInterval = setInterval(() => {
            if (popup.closed) {
                clearInterval(checkInterval);
                showConnectingSpinner(false);
                
                console.log('🪟 Popup fechado, verificando status...');
                setTimeout(() => {
                    checkSocialStatus();
                }, 2000);
            }
        }, 1000);
        
        // Timeout de 5 minutos
        setTimeout(() => {
            if (!popup.closed) {
                popup.close();
                clearInterval(checkInterval);
                showConnectingSpinner(false);
                showAlert('Tempo limite excedido', 'error');
            }
        }, 300000);
        
    } catch (error) {
        console.error('❌ Erro ao conectar:', error);
        showConnectingSpinner(false);
        showAlert('Erro ao conectar: ' + error.message, 'error');
    }
}

function showConnectingSpinner(show) {
    const btn = document.getElementById('connect-facebook-btn');
    if (btn) {
        if (show) {
            btn.innerHTML = '<i class="spinner-border spinner-border-sm me-2"></i>Conectando...';
            btn.disabled = true;
        } else {
            btn.innerHTML = '<i class="bi bi-facebook me-2"></i>Conectar Facebook';
            btn.disabled = false;
        }
    }
}

// DESCONECTAR
async function disconnectSocial() {
    if (!confirm('Deseja desconectar todas as redes sociais?')) {
        return;
    }
    
    try {
        const response = await fetch(`${getSocialServerUrl()}/api/social/disconnect`, {
            method: 'POST'
        });
        
        if (response.ok) {
            showAlert('Desconectado com sucesso!', 'success');
            checkSocialStatus();
            
            // Limpar conversas
            socialConversations.clear();
            updateConversationsList();
            resetSocialChat();
        } else {
            throw new Error('Erro ao desconectar');
        }
    } catch (error) {
        console.error('❌ Erro ao desconectar:', error);
        showAlert('Erro ao desconectar', 'error');
    }
}

// Verificar callbacks de OAuth
function checkAuthCallbacks() {
    const urlParams = new URLSearchParams(window.location.search);
    
    if (urlParams.get('social_success')) {
        console.log('✅ Callback de sucesso detectado');
        showAlert('Redes sociais conectadas com sucesso!', 'success');
        
        // Limpar URL
        window.history.replaceState({}, document.title, window.location.pathname);
        
        // Verificar status
        setTimeout(() => {
            checkSocialStatus();
        }, 1000);
    }
    
    if (urlParams.get('social_error')) {
        console.log('❌ Callback de erro detectado');
        const error = urlParams.get('social_error');
        showAlert('Erro ao conectar: ' + decodeURIComponent(error), 'error');
        
        // Limpar URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

// Alternar entre WhatsApp e Redes Sociais
function toggleSocialView() {
    const chatArea = document.querySelector('.chat-area');
    const socialArea = document.getElementById('social-media-area');
    const toggleBtn = document.getElementById('social-toggle-btn');
    
    if (currentSocialView === 'whatsapp') {
        // Ir para redes sociais
        chatArea.style.display = 'none';
        socialArea.style.display = 'block';
        
        currentSocialView = 'social';
        loadSocialConversations();
        
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="bi bi-whatsapp"></i> Voltar ao WhatsApp';
            toggleBtn.className = 'btn btn-sm btn-outline-success';
        }
        
    } else {
        // Voltar para WhatsApp
        chatArea.style.display = 'flex';
        socialArea.style.display = 'none';
        
        resetSocialChat();
        currentSocialView = 'whatsapp';
        
        if (toggleBtn) {
            toggleBtn.innerHTML = '<i class="bi bi-instagram"></i> Redes Sociais';
            toggleBtn.className = 'btn btn-sm btn-outline-info';
        }
    }
}

function resetSocialChat() {
    const noSelected = document.getElementById('no-social-chat-selected');
    const chatHeader = document.getElementById('social-chat-header');
    const messagesContainer = document.getElementById('social-messages-container');
    const typingArea = document.getElementById('social-typing-area');
    
    if (noSelected) noSelected.style.display = 'flex';
    if (chatHeader) chatHeader.style.display = 'none';
    if (messagesContainer) messagesContainer.style.display = 'none';
    if (typingArea) typingArea.style.display = 'none';
    
    currentSocialContact = null;
}

// Modal de conexões
function showSocialConnections() {
    $('#socialConnectionsModal').modal('show');
    checkSocialStatus();
}

// Carregar conversas sociais
async function loadSocialConversations() {
    try {
        const response = await fetch(`${getSocialServerUrl()}/api/social/conversations`);
        
        if (!response.ok) {
            throw new Error('Erro ao carregar conversas');
        }
        
        const conversations = await response.json();
        console.log('💬 Conversas carregadas:', conversations.length);
        
        // Atualizar mapa local
        socialConversations.clear();
        conversations.forEach(conv => {
            socialConversations.set(conv.id, conv);
        });
        
        updateConversationsList();
        
    } catch (error) {
        console.error('❌ Erro ao carregar conversas:', error);
    }
}

function updateConversationsList() {
    const listEl = document.getElementById('social-conversations-list');
    if (!listEl) return;
    
    if (socialConversations.size === 0) {
        listEl.innerHTML = `
            <div class="no-conversations text-center py-4">
                <i class="bi bi-chat-dots" style="font-size: 2rem; opacity: 0.3;"></i>
                <p class="text-muted mt-2">Nenhuma conversa ainda</p>
                <small class="text-muted">As conversas aparecerão aqui quando alguém enviar uma mensagem</small>
            </div>
        `;
        return;
    }
    
    // Código para mostrar conversas aqui...
}

// Envio de mensagens sociais
async function sendSocialMessage() {
    const input = document.getElementById('social-message-input');
    const text = input.value.trim();
    
    if (!text || !currentSocialContact) return;
    
    const conversation = socialConversations.get(currentSocialContact);
    if (!conversation) return;
    
    try {
        console.log('📤 Enviando mensagem...');
        
        const response = await fetch(`${getSocialServerUrl()}/api/social/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                platform: conversation.platform,
                recipientId: conversation.senderId,
                text: text
            })
        });
        
        if (!response.ok) {
            throw new Error('Erro ao enviar mensagem');
        }
        
        console.log('✅ Mensagem enviada');
        input.value = '';
        
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error);
        showAlert('Erro ao enviar mensagem: ' + error.message, 'error');
    }
}

function handleNewSocialMessage(message) {
    // Processar nova mensagem
    console.log('📨 Mensagem recebida:', message);
}

function updateSocialConversationInList(conversation) {
    socialConversations.set(conversation.id, conversation);
    updateConversationsList();
}

// Utilitários
function showAlert(message, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    if (window.showNotification) {
        showNotification(type === 'error' ? 'Erro' : 'Info', message, type);
    } else {
        alert(message);
    }
}

function showSocialError(message) {
    console.warn('⚠️', message);
}

function hideSocialError() {
    console.log('✅ Erro social resolvido');
}

// Inicialização
document.addEventListener('DOMContentLoaded', function() {
    console.log('🚀 Carregando sistema de redes sociais...');
    
    // Solicitar permissão para notificações
    if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
    }
    
    // Inicializar sistema
    initSocialSystem();
    
    // Enter para enviar mensagem
    const messageInput = document.getElementById('social-message-input');
    if (messageInput) {
        messageInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendSocialMessage();
            }
        });
    }
});

// Exportar funções para uso global
window.connectWithFacebook = connectWithFacebook;
window.disconnectSocial = disconnectSocial;
window.toggleSocialView = toggleSocialView;
window.showSocialConnections = showSocialConnections;
window.sendSocialMessage = sendSocialMessage;
window.getSocialServerUrl = getSocialServerUrl;
window.checkSocialStatus = checkSocialStatus;