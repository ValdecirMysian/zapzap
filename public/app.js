// app.js - JavaScript Frontend Principal

// Função para obter avatar (foto real ou iniciais como fallback)
function getContactAvatar(contact) {
    // Debug para ver o que está chegando
    console.log('🔍 Avatar debug:', contact.name, 'Avatar:', contact.avatar);
    
    // Se tem foto real do WhatsApp, usar ela
    if (contact.avatar && 
        typeof contact.avatar === 'string' && 
        (contact.avatar.startsWith('http') || contact.avatar.startsWith('data:image'))) {
        return contact.avatar;
    }
    
    // Fallback: gerar avatar com iniciais
    return getDefaultAvatar(contact.name || contact.number);
}

// Função para gerar avatar padrão (mantida para fallback)
function getDefaultAvatar(name) {
    // Remover emojis e caracteres especiais
    const cleanName = name ? name.replace(/[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|✨|⭐|💫|🌟/gu, '').trim() : '?';
    const initials = cleanName.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase() || '?';
    const colors = ['#25D366', '#128C7E', '#075E54', '#34B7F1', '#00BFA5'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    
    const svg = `<svg width="50" height="50" xmlns="http://www.w3.org/2000/svg">
        <rect width="50" height="50" fill="${color}"/>
        <text x="50%" y="50%" text-anchor="middle" dy=".3em" fill="white" font-size="20" font-family="Arial">${initials}</text>
    </svg>`;
    
    // Usar encodeURIComponent ao invés de btoa para suportar UTF-8
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

// Variáveis globais
let socket = null;
let currentContact = null;
let currentQueue = null;
let currentSession = null;
let sessions = [];
let contacts = [];
let messages = [];
let quickReplies = [];
let availableTags = [];
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = null;
let recordingTimer = null;
let audioContext = null;
let analyser = null;
let dataArray = null;
let animationId = null;
let isRecordingCancelled = false;

// Variáveis para controle de intervals
let activeIntervals = {
    queueStats: null,
    monitoring: null
};

// Cache inteligente
let cache = {
    tags: {
        data: null,
        timestamp: null,
        duration: 300000 // 5 minutos
    },
    users: {
        data: null,
        timestamp: null,
        duration: 300000 // 5 minutos
    }
};

// Função para verificar se cache é válido
function isCacheValid(cacheKey) {
    const cacheItem = cache[cacheKey];
    if (!cacheItem.data || !cacheItem.timestamp) return false;
    
    const now = Date.now();
    return (now - cacheItem.timestamp) < cacheItem.duration;
}

// Função para salvar no cache
function saveToCache(cacheKey, data) {
    cache[cacheKey] = {
        data: data,
        timestamp: Date.now(),
        duration: cache[cacheKey].duration
    };
}

// Função para limpar todos os intervals
function clearAllIntervals() {
    Object.keys(activeIntervals).forEach(key => {
        if (activeIntervals[key]) {
            clearInterval(activeIntervals[key]);
            activeIntervals[key] = null;
        }
    });
    
    console.log('Todos os intervals foram limpos');
}

// Função para iniciar interval de estatísticas
function startQueueStatsInterval() {
    // Evitar duplicatas
    if (activeIntervals.queueStats) {
        clearInterval(activeIntervals.queueStats);
    }
    
    // Atualizar estatísticas a cada 30 segundos
    activeIntervals.queueStats = setInterval(() => {
        // Só atualizar se página está visível
        if (!document.hidden) {
            updateQueueStats();
        }
    }, 30000);
    
    console.log('Interval de estatísticas iniciado');
}

// Limpar ao sair da página
window.addEventListener('beforeunload', clearAllIntervals);

// Limpar quando página não está visível (economizar recursos)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Pausar apenas alguns intervals quando página não está visível
        if (activeIntervals.queueStats) {
            clearInterval(activeIntervals.queueStats);
            activeIntervals.queueStats = null;
        }
    } else {
        // Retomar quando página volta a ficar visível
        startQueueStatsInterval();
    }
});

// Função para detectar se conteúdo é base64 (evitar mostrar como texto)
function isBase64Content(content) {
    if (!content || typeof content !== 'string') return false;
    
    // Detectar padrões típicos de base64
    const base64Patterns = [
        /^\/9j\/4AAQ/,           // JPEG comum
        /^iVBORw0KGgoAAAANSUhEU/, // PNG comum
        /^UklGR/,                // WEBP/WAV comum
        /^GkXfo/,                // WebM comum
        /^AAAA/,                 // MP4 comum
        /^[A-Za-z0-9+/]{100,}/   // Base64 longo genérico
    ];
    
    // Se tem mais de 100 caracteres e parece base64
    if (content.length > 100) {
        for (const pattern of base64Patterns) {
            if (pattern.test(content)) {
                return true;
            }
        }
        
        // Verificação adicional: se 90%+ são caracteres base64
        const base64Chars = content.match(/[A-Za-z0-9+/=]/g);
        if (base64Chars && (base64Chars.length / content.length) > 0.9) {
            return true;
        }
    }
    
    return false;
}

// Inicialização - VERSÃO ATUALIZADA
$(document).ready(function() {
    console.log('Sistema iniciado!');
    
    // Conectar ao Socket.IO
    connectSocket();
    
    // Carregar dados iniciais
    loadSessions();
    loadContacts();
    loadQuickReplies();
    loadAvailableTags();
    loadTagsForFilter();
    
    // Configurar eventos
    setupEventListeners();
    
    // Iniciar intervals controlados
    startQueueStatsInterval();

    // Som de notificação
    window.notificationSound = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBSl7yvDZiTYIG2m98OScTgwOUaze8cNuIAYylN7');
    
    // ADICIONAR BOTÃO DE PREVIEW
    setTimeout(() => {
        // Adicionar botão de preview na área de digitação
        const previewBtn = $(`
            <button type="button" class="btn btn-outline-secondary btn-sm ms-1" 
                    onclick="previewCurrentMessage()" title="Preview WhatsApp">
                <i class="bi bi-eye"></i>
            </button>
        `);
        
        $('#typing-area .input-group').append(previewBtn);
        
        // Adicionar atalho Ctrl+P para preview
        $(document).on('keydown', function(e) {
            if (e.ctrlKey && e.key === 'p' && $('#message-input').is(':focus')) {
                e.preventDefault();
                previewCurrentMessage();
            }
        });
    }, 1000);
});

// Conectar Socket.IO - VERSÃO MELHORADA COM RECONEXÃO
function connectSocket() {
    socket = io({
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: 5,
        timeout: 20000
    });
    
    // Autenticar socket
    socket.emit('auth', localStorage.getItem('token') || '');
    
    // Entrar na sala do setor
    socket.emit('join:sector', currentUser.sector);
    
    // NOVOS EVENTOS DE CONEXÃO
    socket.on('connect', () => {
        console.log('Socket conectado');
        // Re-autenticar ao reconectar
        socket.emit('auth', localStorage.getItem('token') || '');
        socket.emit('join:sector', currentUser.sector);
    });
    
    socket.on('disconnect', (reason) => {
        console.log('Socket desconectado:', reason);
        if (reason !== 'io client disconnect') {
            showNotification('Conexão', 'Conexão perdida. Tentando reconectar...', 'warning');
        }
    });
    
    socket.on('reconnect', (attemptNumber) => {
        console.log('Socket reconectado após', attemptNumber, 'tentativas');
        showNotification('Conexão', 'Reconectado com sucesso!', 'success');
        
        // Recarregar dados essenciais após reconexão
        setTimeout(() => {
            loadContacts();
            updateQueueStats();
        }, 1000);
    });
    
    socket.on('reconnect_error', (error) => {
        console.error('Erro na reconexão:', error);
    });
    
    socket.on('reconnect_failed', () => {
        console.error('Falha na reconexão após várias tentativas');
        showNotification('Conexão', 'Falha na reconexão. Recarregue a página.', 'error');
    });
    
    // Eventos de sessão
    socket.on('session:connected', (data) => {
        updateSessionStatus(data.sessionId, 'connected');
        showNotification('Sessão Conectada', `WhatsApp ${data.sessionName} conectado!`);
        loadSessions(); // Recarregar sessões
        
        // Se não tiver sessão ativa, definir esta
        if (!currentSession) {
            currentSession = data.sessionId;
        }
    });
    
    socket.on('session:disconnected', (data) => {
        updateSessionStatus(data.sessionId, 'disconnected');
        loadSessions();
    });
    
    socket.on('session:qr', (data) => {
        if ($('#addSessionModal').hasClass('show')) {
            $('#qr-code-area').show();
            $('#qr-code-img').attr('src', data.qrCode);
        }
    });
    
    // Eventos de mensagem
    socket.on('message:received', (data) => {
        handleNewMessage(data);
    });
    
    socket.on('message:ack', (data) => {
        updateMessageStatus(data.messageId, data.status);
    });
    
   // **NOVOS EVENTOS: Fila em tempo real**
    socket.on('queue:finished', (data) => {
        console.log('Fila finalizada recebida:', data);
        
        // Se é o atendimento atual, limpar interface
        if (currentQueue && currentQueue.id === data.id) {
            // Verificar se foi finalizado por outro usuário
            if (data.finished_by !== currentUser.id) {
                showNotification(
                    'Atendimento Finalizado', 
                    `${data.finished_by_name} finalizou este atendimento`, 
                    'info'
                );
                
                // Limpar interface atual
                currentContact = null;
                currentQueue = null;
                $('#chat-header').hide();
                $('#typing-area').hide();
                $('#sidebar-right').hide();
                $('#messages-container').html('<div class="no-chat-selected"><i class="bi bi-chat-dots"></i><p>Selecione uma conversa para começar</p></div>');
            }
        }
        
        // Recarregar dados
        setTimeout(() => {
            loadContacts();
            updateQueueStats();
        }, 1000);
    });

    socket.on('queue:transferred', (data) => {
        console.log('Transferência recebida:', data);
        
        // Se é transferência para meu setor
        if (data.to_sector === currentUser.sector) {
            showNotification(
                'Nova Transferência', 
                `${data.from_user_name || 'Atendente'} transferiu ${data.contact_name} para seu setor`, 
                'info'
            );
        }
        
        // Se é transferência para mim especificamente
        if (data.to_user_id === currentUser.id) {
            showNotification(
                'Transferência Direta', 
                `${data.from_user_name || 'Atendente'} transferiu ${data.contact_name} para você`, 
                'success'
            );
        }
        
        // Se é meu atendimento que foi transferido
        if (currentQueue && currentQueue.id === data.id) {
            currentContact = null;
            currentQueue = null;
            $('#chat-header').hide();
            $('#typing-area').hide();
            $('#sidebar-right').hide();
            $('#messages-container').html('<div class="no-chat-selected"><i class="bi bi-chat-dots"></i><p>Selecione uma conversa para começar</p></div>');
            
            showNotification(
                'Atendimento Transferido', 
                `Atendimento transferido para ${data.to_sector}`, 
                'info'
            );
        }
        
        // Recarregar dados
        setTimeout(() => {
            loadContacts();
            updateQueueStats();
        }, 1000);
    });

    socket.on('queue:updated', (data) => {
        console.log('Fila atualizada:', data);
        
        // Atualizar contadores se necessário
        updateQueueStats();
    });

    // NOVOS EVENTOS: Transferências entre atendentes
    socket.on('queue:transfer-received', (data) => {
        console.log('Transferência recebida:', data);
        showNotification(
            'Nova Transferência', 
            `${data.fromUser} transferiu ${data.contactName} para você`, 
            'info'
        );
        
        // Recarregar dados
        setTimeout(() => {
            loadContacts();
            updateQueueStats();
        }, 1000);
    });
    
    socket.on('queue:transfer-to-sector', (data) => {
        console.log('Transferência para setor recebida:', data);
        showNotification(
            'Transferência para Setor', 
            `${data.fromUser} transferiu ${data.contactName} para seu setor`, 
            'info'
        );
        
        // Recarregar dados
        setTimeout(() => {
            loadContacts();
            updateQueueStats();
        }, 1000);
    });

    socket.on('contact:update', (data) => {
        const c = contacts.find(ct => ct.id === data.id);
        if (c) {
            c.avatar = data.avatar;

            // Lista de conversas
            $(`.contact-item[data-contact-id="${c.id}"] img.contact-avatar`)
                .attr('src', data.avatar);

            // Topo do chat + sidebar direita (se abertos)
            if (currentContact && currentContact.id === c.id) {
                $('#contact-avatar, #info-avatar').attr('src', data.avatar);
            }
        }
    });
    
    // Eventos de digitação
    socket.on('typing:start', (data) => {
        if (currentContact && currentContact.id === data.contactId) {
            $('#typing-indicator').show()
                .find('span').text(data.userName || 'Contato');
        }
    });
    
    socket.on('typing:stop', (data) => {
        if (currentContact && currentContact.id === data.contactId) {
            $('#typing-indicator').hide();
        }
    });
}

// Configurar listeners de eventos
function setupEventListeners() {
    // Enter para enviar mensagem
    $('#message-input').on('keypress', function(e) {
        if (e.which === 13 && !e.shiftKey) {
            e.preventDefault();
            
            // Verificar se é um atalho antes de enviar
            const message = $(this).val().trim();
            if (message.startsWith('/')) {
                processShortcut(message);
            } else {
                sendMessage();
            }
        }
    });
    
    // Detectar scroll no container de mensagens
    let scrollTimeout;
    $('#messages-container').on('scroll', function() {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
            checkAndMarkAsRead();
        }, 500); // Aguarda 500ms após parar de rolar
    });
    
    // Digitando
    let typingTimer;
    $('#message-input').on('input', function() {
        if (currentContact) {
            socket.emit('typing:start', { contactId: currentContact.id });
            clearTimeout(typingTimer);
            typingTimer = setTimeout(() => {
                socket.emit('typing:stop', { contactId: currentContact.id });
            }, 1000);
        }
    });
    
    // Filtros
    $('#filter-sector, #search-contact, #filter-tag').on('change input', function() {
        loadContacts();
        updateActiveFilters();
    });
    
    // Abas de visualização
    $('input[name="view-type"]').on('change', function() {
        loadContacts();
        updateActiveFilters();
    });
    
    // Upload de arquivo
    $('#file-input').on('change', function() {
        if (this.files && this.files[0]) {
            uploadFile(this.files[0]);
        }
    });
    // Preview em tempo real
    $(document).on('input', '#new-reply-content', updateReplyPreview);
    
    // Buscar respostas rápidas
    $(document).on('input', '#search-quick-reply', renderQuickRepliesList);
    
    // Formulário de nova resposta
    $(document).on('submit', '#new-quick-reply-form', handleNewQuickReply);
    
    // Event listeners para enquetes
    $(document).on('input', '#poll-question, #poll-options', updatePollPreview);
    $(document).on('change', '#poll-type', updatePollPreview);
}

// Carregar sessões - VERSÃO MELHORADA COM FALLBACK
async function loadSessions() {
    try {
        const response = await $.get('/api/sessions');
        sessions = response;
        
        console.log('Sessões carregadas:', sessions);
        
        // Atualizar badges de sessão
        const $container = $('#sessions-status');
        $container.empty();
        
        sessions.forEach(session => {
            const isActive = session.status === 'connected' && session.id === currentSession;
            const isConnected = session.status === 'connected';
            
            const $badge = $(`
                <div class="session-badge ${isActive ? 'active' : ''}" 
                     data-session-id="${session.id}">
                    <span onclick="selectSession(${session.id})" style="cursor: pointer; display: flex; align-items: center; gap: 8px;">
                        <i class="bi bi-phone"></i>
                        ${session.name}
                        <span class="status-dot ${session.status}"></span>
                    </span>
                    ${isConnected ? 
                        `<div class="btn-group btn-group-sm ms-2">
                            <button class="btn btn-xs btn-success" onclick="event.stopPropagation(); addNumberToSession(${session.id}, '${session.name.replace(/'/g, "\\'")}')" title="Adicionar número">
                                <i class="bi bi-plus" style="font-size: 10px;"></i>
                            </button>
                            <button class="btn btn-xs btn-warning" onclick="event.stopPropagation(); showSessionNumbers(${session.id})" title="Ver números">
                                <i class="bi bi-list" style="font-size: 10px;"></i>
                            </button>
                            <button class="btn btn-xs btn-danger" onclick="event.stopPropagation(); disconnectSession(${session.id})" title="Desconectar">
                                <i class="bi bi-power" style="font-size: 10px;"></i>
                            </button>
                        </div>` : 
                        `<button class="btn btn-xs btn-danger ms-2" onclick="event.stopPropagation(); deleteSession(${session.id}, '${session.name.replace(/'/g, "\\'")}')" title="Excluir">
                            <i class="bi bi-trash" style="font-size: 10px;"></i>
                        </button>`
                    }
                </div>
            `);
            $container.append($badge);
            
            // Selecionar primeira sessão conectada se não tiver nenhuma selecionada
            if (!currentSession && session.status === 'connected') {
                currentSession = session.id;
                console.log('Sessão ativa detectada:', session.name);
            }
        });
        
        // Destacar sessão ativa
        if (currentSession) {
            $(`.session-badge[data-session-id="${currentSession}"]`).addClass('active');
        }
    } catch (error) {
        console.error('Erro ao carregar sessões:', error);
    }
}

// Desconectar sessão
async function disconnectSession(sessionId) {
    if (!confirm('Deseja desconectar esta sessão?')) return;
    
    try {
        await $.ajax({
            url: `/api/sessions/${sessionId}`,
            method: 'DELETE'
        });
        
        showNotification('Sucesso', 'Sessão desconectada!');
        
        // Se era a sessão atual, limpar
        if (currentSession === sessionId) {
            currentSession = null;
        }
        
        loadSessions();
    } catch (error) {
        console.error('Erro ao desconectar:', error);
        showNotification('Erro', 'Erro ao desconectar sessão', 'error');
    }
}

// Função para excluir sessão com tratamento completo de erros
async function deleteSession(sessionId, sessionName = '') {
    const confirmMessage = sessionName 
        ? `Deseja realmente EXCLUIR a sessão "${sessionName}"?\n\nEsta ação irá:\n• Desconectar o WhatsApp\n• Remover todas as mensagens\n• Limpar arquivos e tokens\n\nEsta ação NÃO PODE ser desfeita!`
        : 'Deseja realmente EXCLUIR esta sessão? Esta ação não pode ser desfeita!';
    
    if (!confirm(confirmMessage)) {
        return;
    }
    
    // Mostrar loading
    const loadingToast = showNotification('Processando', 'Excluindo sessão...', 'info', 0);
    
    try {
        console.log(`🗑️ Iniciando exclusão da sessão ${sessionId}`);
        
        const response = await fetch(`/api/sessions/${sessionId}/delete`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // Fechar loading
        if (loadingToast && loadingToast.close) {
            loadingToast.close();
        }
        
        if (response.ok) {
            const result = await response.json();
            console.log('✅ Sessão excluída:', result);
            
            showNotification('Sucesso', result.message || 'Sessão excluída com sucesso', 'success');
            
            // Recarregar lista de sessões
            await loadSessions();
            
        } else {
            // Tratar erros HTTP específicos
            let errorMessage = 'Erro ao excluir sessão';
            
            try {
                const errorData = await response.json();
                errorMessage = errorData.error || errorMessage;
                
                if (errorData.details) {
                    console.error('Detalhes do erro:', errorData.details);
                }
            } catch (parseError) {
                console.error('Erro ao fazer parse da resposta de erro:', parseError);
            }
            
            console.error(`❌ Erro HTTP ${response.status}:`, errorMessage);
            showNotification('Erro', errorMessage, 'error');
        }
        
    } catch (networkError) {
        // Fechar loading em caso de erro
        if (loadingToast && loadingToast.close) {
            loadingToast.close();
        }
        
        console.error('❌ Erro de rede ao excluir sessão:', networkError);
        
        let errorMessage = 'Erro de conexão ao excluir sessão';
        if (networkError.message.includes('Failed to fetch')) {
            errorMessage = 'Erro de conexão com o servidor';
        } else if (networkError.message) {
            errorMessage = networkError.message;
        }
        
        showNotification('Erro', errorMessage, 'error');
    }
}

// Selecionar sessão
function selectSession(sessionId) {
    const session = sessions.find(s => s.id === sessionId);
    if (!session || session.status !== 'connected') {
        showNotification('Aviso', 'Esta sessão não está conectada', 'warning');
        return;
    }
    
    currentSession = sessionId;
    $('.session-badge').removeClass('active');
    $(`.session-badge[data-session-id="${sessionId}"]`).addClass('active');
    
    showNotification('Sessão Selecionada', `Usando: ${session.name}`);
}

// Carregar contatos - VERSÃO MELHORADA COM FALLBACK
async function loadContacts() {
    const $list = $('#contacts-list');
    
    try {
        const sector = $('#filter-sector').val();
        const search = $('#search-contact').val();
        const tag = $('#filter-tag').val();
        const view = $('input[name="view-type"]:checked').val();
        
        console.log('Carregando contatos...');
        console.log('Filtros:', { sector, search, tag, view });
        
        // Mostrar loading apenas se lista estiver vazia
        if (contacts.length === 0) {
            $list.html(`
                <div class="loading-state text-center py-4">
                    <div class="spinner-border text-primary" role="status">
                        <span class="visually-hidden">Carregando...</span>
                    </div>
                    <p class="mt-2 text-muted">Carregando contatos...</p>
                </div>
            `);
        }
        
        const response = await $.get('/api/contacts', { sector, search, tag, view });
        contacts = response.contacts || response;
        
        // Atualizar contadores das abas
        if (response.totalAll !== undefined) {
            $('#all-count').text(response.totalAll);
            $('#mine-count').text(response.totalMine);
        }
        
        console.log('Contatos carregados:', contacts);
        renderContactsList();
        
    } catch (error) {
        console.error('Erro ao carregar contatos:', error);
        
        // Fallback: mostrar erro com opção de tentar novamente
        $list.html(`
            <div class="error-state text-center py-4">
                <i class="bi bi-exclamation-triangle text-warning" style="font-size: 2rem;"></i>
                <h6 class="mt-2">Falha ao carregar contatos</h6>
                <p class="text-muted small">Verifique sua conexão e tente novamente</p>
                <button class="btn btn-sm btn-outline-primary" onclick="loadContacts()">
                    <i class="bi bi-arrow-clockwise"></i> Tentar novamente
                </button>
            </div>
        `);
        
        // Manter dados antigos se existirem
        if (contacts.length > 0) {
            console.log('Mantendo contatos em cache');
            renderContactsList();
        }
        
        showNotification('Erro', 'Falha ao carregar contatos', 'error');
    }
}

// Renderizar lista de contatos
function renderContactsList() {
    const $list = $('#contacts-list');
    $list.empty();
    
    console.log('Renderizando contatos:', contacts.length);
    
    if (contacts.length === 0) {
        $list.html('<div class="no-contacts">Nenhum contato encontrado</div>');
        return;
    }
    
    // Separar contatos por status
    const waiting = contacts.filter(c => c.queue?.status === 'waiting');
    const attending = contacts.filter(c => c.queue?.status === 'attending');
    const others = contacts.filter(c => !c.queue || c.queue.status === 'finished');
    
    console.log('Aguardando:', waiting.length, 'Em atendimento:', attending.length);
    
    // Mostrar primeiro os que estão aguardando
    if (waiting.length > 0) {
        $list.append('<div class="contacts-section-title">🔔 Aguardando Atendimento (' + waiting.length + ')</div>');
        waiting.forEach(contact => renderContactItem(contact, $list));
    }
    
    // Depois os em atendimento
    if (attending.length > 0) {
        $list.append('<div class="contacts-section-title">💬 Em Atendimento</div>');
        attending.forEach(contact => renderContactItem(contact, $list));
    }
    
    // Por último os outros
    if (others.length > 0) {
        $list.append('<div class="contacts-section-title">📋 Conversas</div>');
        others.forEach(contact => renderContactItem(contact, $list));
    }
}

// Função corrigida para renderizar item de contato (sem duplicação)
function renderContactItem(contact, $list) {
    const lastMessage = contact.last_message || 'Clique para iniciar conversa';
    const time = contact.last_message_at ? formatTime(contact.last_message_at) : '';
    const unread = contact.unread_count || 0;
    
    // Determinar classe baseada na função do usuário atribuído
    let assignedClass = '';
    let assignedInfo = '';
    
    if (contact.assignedUser) {
        assignedClass = `assigned-to-${contact.assignedUser.role}`;
        if (contact.assignedUser.id !== currentUser.id) {
            assignedInfo = `<small class="text-muted">Atendido por: ${contact.assignedUser.name}</small>`;
        }
    }
    
    const $item = $(`
        <div class="contact-item ${contact.queue?.status === 'attending' && contact.queue?.user_id === currentUser.id ? 'active' : ''} ${assignedClass}" 
             data-contact-id="${contact.id}">
            <img src="${getContactAvatar(contact)}" class="contact-avatar" onerror="this.src='${getDefaultAvatar(contact.name || contact.number)}'">
            <div class="contact-info">
                <div class="contact-name">${contact.name || contact.number}</div>
                <div class="contact-last-message">${escapeHtml(lastMessage)}</div>
                ${assignedInfo}
            </div>
            <div class="contact-meta">
                <div class="contact-time">${time}</div>
                ${unread > 0 ? `<span class="badge bg-success">${unread}</span>` : ''}
                ${contact.queue ? `<span class="badge bg-${getQueueColor(contact.queue.status)}">${getQueueLabel(contact.queue.status)}</span>` : ''}
            </div>
        </div>
    `);
    
    $item.on('click', () => selectContact(contact));
    $list.append($item);
}

// Verificar se está no final do scroll
function isAtBottom(element) {
    return element.scrollHeight - element.scrollTop <= element.clientHeight + 50; // 50px de margem
}

// Marcar mensagens como lidas se estiver no final
async function checkAndMarkAsRead() {
    if (!currentContact) return;
    
    const container = document.getElementById('messages-container');
    if (isAtBottom(container)) {
        // Se está no final, marcar como lido
        await markMessagesAsRead(currentContact.id);
    }
}

// Selecionar contato
async function selectContact(contact) {
    console.log('Selecionando contato:', contact);
    
    currentContact = contact;
    currentQueue = contact.queue;
    
    // Verificar se temos uma sessão ativa
    if (!currentSession) {
        showNotification('Erro', 'Nenhuma sessão WhatsApp conectada!', 'error');
        return;
    }
    
    // Atualizar UI
    $('.contact-item').removeClass('active');
    $(`.contact-item[data-contact-id="${contact.id}"]`).addClass('active');
    
    // Mostrar área de chat
    $('#chat-header').show();
    $('#typing-area').show();
    $('#sidebar-right').show();
    $('.no-chat-selected').hide();
    
    // Atualizar informações do contato - com verificação de null
    const contactName = contact.name || contact.number;
    
    // Montar HTML do nome com badge se necessário
    let nameHtml = contactName;
    
    // Adicionar badge de função se estiver sendo atendido
    if (contact.assignedUser && contact.queue?.status === 'attending') {
        const roleIcons = {
            'admin': '👑',
            'supervisor': '⭐', 
            'atendente': '👤'
        };
        const roleNames = {
            'admin': 'Admin',
            'supervisor': 'Supervisor',
            'atendente': 'Atendente'
        };
        
        nameHtml = `${contactName} <span class="badge role-badge-${contact.assignedUser.role}">
            ${roleIcons[contact.assignedUser.role]} ${roleNames[contact.assignedUser.role]}
        </span>`;
    }
    
    $('#contact-name').html(nameHtml);
    const avatarUrl = getContactAvatar(contact);
    $('#contact-avatar').attr('src', avatarUrl)
                        .attr('onerror', `this.src='${getDefaultAvatar(contact.name || contact.number)}'`);
    $('#contact-status').text(contact.assignedUser ? `Atendido por ${contact.assignedUser.name}` : 'Online');
    
    // Carregar mensagens
    await loadMessages(contact.id);
    
    // Atualizar sidebar direita
    updateContactInfo(contact);
    
    // Focar no input
    $('#message-input').focus();
}

// ===========================================
// SISTEMA DE ENCAMINHAMENTO DE MENSAGENS
// ===========================================

// Mostrar modal de encaminhar mensagem
function showForwardModal(messageId) {
    // Buscar dados da mensagem
    const $messageElement = $(`.message[data-message-id="${messageId}"]`);
    const messageType = $messageElement.data('message-type');
    const messageContent = $messageElement.data('message-content');
    const mediaUrl = $messageElement.data('media-url');
    
    // Preencher modal
    $('#forward-message-id').val(messageId);
    $('#forward-message-type').val(messageType);
    $('#forward-message-content').val(messageContent);
    $('#forward-media-url').val(mediaUrl);
    
    // Mostrar preview da mensagem
    let previewHtml = '';
    if (messageType === 'text') {
        previewHtml = `<div class="text-preview">${messageContent}</div>`;
    } else if (messageType === 'image' && mediaUrl) {
        previewHtml = `<div class="media-preview"><img src="${mediaUrl}" style="max-width: 100px; max-height: 100px;"> <small>Imagem</small></div>`;
    } else if (messageType === 'audio' && mediaUrl) {
        previewHtml = `<div class="media-preview"><i class="bi bi-music-note"></i> Áudio</div>`;
    } else if (messageType === 'video' && mediaUrl) {
        previewHtml = `<div class="media-preview"><i class="bi bi-play-circle"></i> Vídeo</div>`;
    } else if (messageType === 'document' && mediaUrl) {
        previewHtml = `<div class="media-preview"><i class="bi bi-file-earmark"></i> Documento</div>`;
    } else {
        previewHtml = `<div class="media-preview"><i class="bi bi-chat"></i> ${messageType}</div>`;
    }
    
    $('#forward-preview').html(previewHtml);
    
    // Carregar lista de contatos
    loadContactsForForward();
    
    $('#forwardModal').modal('show');
}

// Carregar contatos para encaminhamento
async function loadContactsForForward() {
    try {
        const response = await $.get('/api/contacts', { limit: 100 });
        const contacts = response.contacts || response;
        
        const $list = $('#forward-contacts-list');
        $list.empty();
        
        if (contacts.length === 0) {
            $list.html('<p class="text-muted">Nenhum contato encontrado</p>');
            return;
        }
        
        contacts.forEach(contact => {
            const $contactItem = $(`
                <div class="forward-contact-item" onclick="selectForwardContact('${contact.id}', '${escapeHtml(contact.name || contact.number)}')">
                    <img src="${getContactAvatar(contact)}" class="forward-contact-avatar">
                    <div class="forward-contact-info">
                        <div class="forward-contact-name">${escapeHtml(contact.name || contact.number)}</div>
                        <div class="forward-contact-number">${contact.number}</div>
                    </div>
                    <div class="forward-contact-check">
                        <i class="bi bi-circle"></i>
                    </div>
                </div>
            `);
            $list.append($contactItem);
        });
        
    } catch (error) {
        console.error('Erro ao carregar contatos:', error);
        $('#forward-contacts-list').html('<p class="text-danger">Erro ao carregar contatos</p>');
    }
}

// Selecionar contato para encaminhar
function selectForwardContact(contactId, contactName) {
    // Remover seleção anterior
    $('.forward-contact-item').removeClass('selected');
    $('.forward-contact-check i').removeClass('bi-check-circle-fill').addClass('bi-circle');
    
    // Marcar novo selecionado
    const $item = $(`.forward-contact-item:contains("${contactName}")`).first();
    $item.addClass('selected');
    $item.find('.forward-contact-check i').removeClass('bi-circle').addClass('bi-check-circle-fill');
    
    // Armazenar ID selecionado
    $('#selected-forward-contact').val(contactId);
    
    // Habilitar botão
    $('#forward-send-btn').prop('disabled', false);
}

// Encaminhar mensagem
async function forwardMessage() {
    try {
        const messageId = $('#forward-message-id').val();
        const messageType = $('#forward-message-type').val();
        const messageContent = $('#forward-message-content').val();
        const mediaUrl = $('#forward-media-url').val();
        const targetContactId = $('#selected-forward-contact').val();
        const additionalText = $('#forward-additional-text').val().trim();
        
        if (!targetContactId) {
            showNotification('Erro', 'Selecione um contato para encaminhar', 'error');
            return;
        }
        
        if (!currentSession) {
            showNotification('Erro', 'Nenhuma sessão WhatsApp ativa', 'error');
            return;
        }
        
        // Mostrar loading
        const $btn = $('#forward-send-btn');
        const originalText = $btn.html();
        $btn.html('<span class="spinner-border spinner-border-sm me-2"></span>Encaminhando...')
            .prop('disabled', true);
        
        // Preparar dados para envio
        const formData = new FormData();
        formData.append('sessionId', currentSession);
        formData.append('contactId', targetContactId);
        formData.append('type', messageType);
        
        // Adicionar texto adicional se houver
        let finalContent = '';
        if (additionalText) {
            finalContent = additionalText + '\n\n';
        }
        
        if (messageType === 'text') {
            finalContent += '📤 *Mensagem Encaminhada:*\n' + messageContent;
            formData.append('content', finalContent);
        } else {
            finalContent += '📤 *Mídia Encaminhada*';
            if (messageContent && messageContent.trim()) {
                finalContent += '\n' + messageContent;
            }
            formData.append('content', finalContent);
            
           // Para mídias, precisamos baixar e reenviar
        if (mediaUrl) {
            try {
                const response = await fetch(mediaUrl);
                const blob = await response.blob();
                
                // Para áudios, usar a rota específica de áudio
                if (messageType === 'audio') {
                    console.log('🎵 Encaminhando áudio via rota específica...');
                    
                    // Preparar FormData específico para áudio
                    const audioFormData = new FormData();
                    audioFormData.append('audio', blob, getMediaFileName(mediaUrl, messageType));
                    audioFormData.append('sessionId', currentSession);
                    audioFormData.append('contactId', targetContactId);
                    
                    // Adicionar comentário se houver
                    if (additionalText) {
                        audioFormData.append('additionalText', additionalText);
                    }
                    
                    // Enviar via rota específica de áudio
                    const audioResponse = await $.ajax({
                        url: '/api/messages/send-audio',
                        type: 'POST',
                        data: audioFormData,
                        processData: false,
                        contentType: false
                    });
                    
                    showNotification('Sucesso', 'Áudio encaminhado como mensagem de voz!', 'success');
                    
                } else {
                    // Para outras mídias, usar rota normal
                    formData.append('media', blob, getMediaFileName(mediaUrl, messageType));
                }
                
            } catch (mediaError) {
                console.error('Erro ao baixar mídia:', mediaError);
                // Enviar só o texto se mídia falhar
                formData.set('content', finalContent + '\n\n❌ *Erro: Mídia não pôde ser encaminhada*');
            }
        }

        // Função específica para encaminhar áudio
async function forwardAudioMessage(messageId, targetContactId, additionalText = '') {
    try {
        const $messageElement = $(`.message[data-message-id="${messageId}"]`);
        const mediaUrl = $messageElement.data('media-url');
        
        if (!mediaUrl) {
            throw new Error('URL do áudio não encontrada');
        }
        
        console.log('🎵 Baixando áudio para encaminhamento:', mediaUrl);
        
        // Baixar o arquivo de áudio
        const response = await fetch(mediaUrl);
        if (!response.ok) {
            throw new Error('Erro ao baixar áudio');
        }
        
        const audioBlob = await response.blob();
        console.log('🎵 Áudio baixado:', audioBlob.size, 'bytes');
        
        // Verificar se é um áudio válido
        if (!audioBlob.type.startsWith('audio/') && audioBlob.size === 0) {
            throw new Error('Arquivo de áudio inválido');
        }
        
        // Preparar FormData para envio
        const formData = new FormData();
        formData.append('audio', audioBlob, 'forwarded_voice.ogg');
        formData.append('sessionId', currentSession);
        formData.append('contactId', targetContactId);
        
        if (additionalText && additionalText.trim()) {
            formData.append('additionalText', additionalText.trim());
        }
        
        console.log('🎵 Enviando áudio encaminhado...');
        
        // Enviar via rota específica de áudio
        const result = await $.ajax({
            url: '/api/messages/send-audio',
            type: 'POST',
            data: formData,
            processData: false,
            contentType: false,
            timeout: 60000 // 1 minuto para áudios
        });
        
        console.log('✅ Áudio encaminhado com sucesso:', result);
        return result;
        
    } catch (error) {
        console.error('❌ Erro ao encaminhar áudio:', error);
        throw error;
    }
}
        
        // Enviar mensagem (apenas se não for áudio, pois áudio já foi enviado acima)
        if (messageType !== 'audio' || !mediaUrl) {
            const response = await $.ajax({
                url: '/api/messages/send',
                type: 'POST',
                data: formData,
                processData: false,
                contentType: false
            });
        }
        }
        
       // Enviar mensagem (apenas se não for áudio)
        if (messageType === 'audio' && mediaUrl) {
            // Áudio já foi enviado via função específica acima
            console.log('✅ Áudio encaminhado via rota específica');
        } else {
            // Enviar outras mídias/textos via rota normal
            const response = await $.ajax({
                url: '/api/messages/send',
                type: 'POST',
                data: formData,
                processData: false,
                contentType: false
            });
            
            console.log('✅ Mídia/texto encaminhado via rota normal');
        }
        
        showNotification('Sucesso', 'Mensagem encaminhada com sucesso!', 'success');
        
        // Fechar modal
        $('#forwardModal').modal('hide');
        
        // Resetar botão
        $btn.html(originalText).prop('disabled', true);
        
        // Limpar seleção
        $('#selected-forward-contact').val('');
        $('#forward-additional-text').val('');
        
    } catch (error) {
        console.error('Erro ao encaminhar mensagem:', error);
        
        // Resetar botão
        const $btn = $('#forward-send-btn');
        $btn.html('<i class="bi bi-arrow-right"></i> Encaminhar').prop('disabled', true);
        
        const errorMsg = error.responseJSON?.error || 'Erro ao encaminhar mensagem';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Função auxiliar para gerar nome do arquivo de mídia
function getMediaFileName(url, type) {
    let extension = url.split('.').pop().split('?')[0];
    const timestamp = Date.now();
    
    // Para áudios, forçar extensão .ogg para melhor compatibilidade
    if (type === 'audio') {
        extension = 'ogg';
    }
    
    switch (type) {
        case 'image': return `forwarded_image_${timestamp}.${extension}`;
        case 'video': return `forwarded_video_${timestamp}.${extension}`;
        case 'audio': return `forwarded_voice_${timestamp}.${extension}`;
        case 'document': return `forwarded_document_${timestamp}.${extension}`;
        default: return `forwarded_file_${timestamp}.${extension}`;
    }
}

// Buscar contatos para encaminhamento
function searchForwardContacts() {
    const searchTerm = $('#forward-search').val().toLowerCase();
    const $items = $('.forward-contact-item');
    
    $items.each(function() {
        const contactName = $(this).find('.forward-contact-name').text().toLowerCase();
        const contactNumber = $(this).find('.forward-contact-number').text().toLowerCase();
        
        if (contactName.includes(searchTerm) || contactNumber.includes(searchTerm)) {
            $(this).show();
        } else {
            $(this).hide();
        }
    });
}

// Carregar mensagens
async function loadMessages(contactId) {
    try {
        const response = await $.get(`/api/contacts/${contactId}/messages`);
        messages = response;
        
        renderMessages();
        scrollToBottom();
        
        // Aguardar um momento e verificar se está no final para marcar como lida
        setTimeout(() => {
            checkAndMarkAsRead();
        }, 500);
        
    } catch (error) {
        console.error('Erro ao carregar mensagens:', error);
    }
}

// Marcar mensagens como lidas
async function markMessagesAsRead(contactId) {
    try {
        // Verificar se há mensagens não lidas
        const contact = contacts.find(c => c.id === contactId);
        if (!contact || contact.unread_count === 0) {
            return; // Não fazer nada se já está tudo lido
        }
        
        await $.post(`/api/contacts/${contactId}/read`);
        
        // Atualizar contador visual com animação
        const $badge = $(`.contact-item[data-contact-id="${contactId}"] .badge.bg-success`);
        if ($badge.length > 0) {
            $badge.fadeOut(300, function() {
                $(this).remove();
            });
        }
        
        // Atualizar o contato na lista
        if (contact) {
            contact.unread_count = 0;
        }
        
        console.log(`✓ Mensagens do contato ${contactId} marcadas como lidas`);
    } catch (error) {
        console.error('Erro ao marcar como lida:', error);
    }
}

// Renderizar mensagens
function renderMessages() {
    const $container = $('#messages-container');
    $container.empty();
    
    let lastDate = null;
    
    messages.forEach(message => {
        // Adicionar separador de data
        const messageDate = new Date(message.created_at).toLocaleDateString();
        if (messageDate !== lastDate) {
            $container.append(`
                <div class="date-separator">
                    <span>${messageDate}</span>
                </div>
            `);
            lastDate = messageDate;
        }
        
        // Renderizar mensagem
        const $message = createMessageElement(message);
        $container.append($message);
    });
}

// Criar elemento de mensagem
function createMessageElement(message) {
    const isFromMe = message.is_from_me;
    const time = formatTime(message.created_at);
    let content = '';
    
    switch (message.type) {
        case 'text':
            content = `<div class="message-text">${escapeHtml(message.content)}</div>`;
            break;
        case 'image': {
    let imgSrc = null;
    let imageText = '';

    // Prioridade: media_url sempre primeiro
    if (message.media_url && message.media_url !== 'null' && message.media_url !== '') {
        imgSrc = message.media_url;
        console.log('🖼️ Usando media_url para imagem:', imgSrc.substring(0, 50) + '...');
    } 
    // Fallback: base64 no content (somente se não tem media_url)
    else if (message.content && message.content.length > 100) {
        // Verificar se parece ser base64 válido
        const base64Pattern = /^[A-Za-z0-9+/]+=*$/;
        const cleanContent = message.content.replace(/\s/g, ''); // Remove espaços
        
        if (base64Pattern.test(cleanContent)) {
            imgSrc = `data:image/jpeg;base64,${cleanContent}`;
            console.log('🖼️ Usando base64 do content para imagem');
        }
    }

    // Processar texto da imagem (legenda)
    if (message.content && 
        message.content.length < 1000 && // Legendas são geralmente curtas
        message.content !== '[Mídia]' &&
        message.content !== '[IMAGEM]' &&
        !message.content.match(/^[A-Za-z0-9+/]+=*$/)) { // Não é base64
        imageText = message.content;
    }

    if (imgSrc) {
        content = `
            <div class="message-media">
                <img src="${imgSrc}" alt="Imagem" onclick="openMedia('${imgSrc}')" 
                     style="max-width: 300px; border-radius: 8px; cursor: pointer;"
                     onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                <div style="display: none; color: #dc3545; font-style: italic;">❌ Erro ao carregar imagem</div>
            </div>
            ${imageText ? `<div class="message-text">${escapeHtml(imageText)}</div>` : ''}
        `;
    } else {
        content = `<div class="message-text">🖼️ [Imagem não disponível]</div>`;
    }
    break;
}
       case 'audio':
            if (message.media_url && message.media_url !== 'null') {
                // Player de áudio MELHORADO com destaque para áudio interno
                const audioId = 'audio-' + message.id;
                const isInternal = message.status === 'internal';
                
                content = `
                    <div class="message-audio ${isInternal ? 'internal-audio' : ''}">
                        <div class="audio-player" id="player-${message.id}">
                            <button class="audio-btn play-btn" onclick="toggleAudio('${audioId}', '${message.media_url}')">
                                <i class="bi bi-play-fill"></i>
                            </button>
                            <div class="audio-progress">
                                <div class="audio-time">0:00</div>
                                <div class="progress" style="height: 4px;">
                                    <div class="progress-bar" id="progress-${message.id}" style="width: 0%"></div>
                                </div>
                                <div class="audio-duration" id="duration-${message.id}">0:00</div>
                            </div>
                            <a href="${message.media_url}" download="audio-message.ogg" class="btn btn-sm btn-outline-primary ms-2" title="Download">
                                <i class="bi bi-download"></i>
                            </a>
                        </div>
                        ${isInternal ? '<small class="text-info"><i class="bi bi-info-circle"></i> Áudio disponível apenas no sistema</small>' : ''}
                        <audio id="${audioId}" preload="metadata" style="display: none;">
                            <source src="${message.media_url}" type="audio/ogg">
                            <source src="${message.media_url}" type="audio/mpeg">
                            <source src="${message.media_url}" type="audio/wav">
                        </audio>
                    </div>
                `;
            } else {
                content = `<div class="message-text">🎵 [Áudio gravado - disponível no sistema]</div>`;
            }
            break;
        case 'video':
            if (message.media_url && message.media_url !== 'null') {
                // CORREÇÃO: Verificar se content é texto válido (não base64)
                const hasValidText = message.content && 
                                   !isBase64Content(message.content) && 
                                   message.content !== '[Mídia]' &&
                                   message.content.length < 500;
                
                content = `
                    <div class="message-media">
                        <video controls style="max-width: 300px;">
                            <source src="${message.media_url}" type="video/mp4">
                            <source src="${message.media_url}" type="video/webm">
                            Seu navegador não suporta vídeo.
                        </video>
                    </div>
                    ${hasValidText ? `<div class="message-text">${escapeHtml(message.content)}</div>` : ''}
                `;
            } else {
                content = `<div class="message-text">[Vídeo não disponível]</div>`;
            }
            break;
        case 'document':
            if (message.media_url && message.media_url !== 'null') {
                const fileName = message.media_url.split('/').pop();
                // CORREÇÃO: Verificar se content é texto válido (não base64)
                const hasValidText = message.content && 
                                   !isBase64Content(message.content) && 
                                   message.content !== '[Mídia]' &&
                                   message.content.length < 500;
                
                content = `
                    <div class="message-document">
                        <i class="bi bi-file-earmark"></i>
                        <a href="${message.media_url}" target="_blank" download>${fileName}</a>
                    </div>
                    ${hasValidText ? `<div class="message-text">${escapeHtml(message.content)}</div>` : ''}
                `;
            } else {
                content = `<div class="message-text">[Documento não disponível]</div>`;
            }
            break;
            
            case 'sticker':
    if (message.media_url && message.media_url !== 'null') {
        content = '<div class="message-media">' +
                 '<img src="' + message.media_url + '" alt="Sticker" class="sticker-image" ' +
                 'onclick="openMedia(\'' + message.media_url + '\')" ' +
                 'style="max-width: 150px; border-radius: 12px;">' +
                 '</div>';
    } else {
        content = '<div class="message-text">🎭 Figurinha</div>';
    }
    break;
    
case 'contact':
    content = `
        <div class="message-contact" style="background: #f8f9fa; padding: 12px; border-radius: 8px; border-left: 4px solid #0d6efd;">
            <div class="d-flex align-items-center">
                <i class="bi bi-person-vcard-fill text-primary" style="font-size: 1.5rem; margin-right: 10px;"></i>
                <div class="contact-info">
                    <div class="fw-bold">👤 Contato Compartilhado</div>
                    <div class="text-muted small">${escapeHtml(message.content || 'Informações do contato')}</div>
                </div>
            </div>
        </div>
    `;
    break;
    
case 'location':
    // Tentar extrair coordenadas da mensagem
    let locationText = message.content || '📍 Localização compartilhada';
    let hasCoordinates = false;
    
    if (message.content && message.content.includes('Latitude:')) {
        hasCoordinates = true;
    }
    
    content = `
        <div class="message-location" style="background: #e8f5e8; padding: 12px; border-radius: 8px; border-left: 4px solid #198754;">
            <div class="d-flex align-items-start">
                <i class="bi bi-geo-alt-fill text-success" style="font-size: 1.5rem; margin-right: 10px; margin-top: 2px;"></i>
                <div class="location-info">
                    <div class="fw-bold">📍 Localização Compartilhada</div>
                    <div class="text-muted small">${escapeHtml(locationText)}</div>
                    ${hasCoordinates ? `
                        <div class="mt-2">
                            <button class="btn btn-sm btn-outline-success" onclick="openLocation('${escapeHtml(message.content)}')" title="Abrir no mapa">
                                <i class="bi bi-map"></i> Ver no Mapa
                            </button>
                        </div>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
    break;

        default:
    if (message.content && !isBase64Content(message.content)) {
        content = '<div class="message-text">' + escapeHtml(message.content) + '</div>';
    } else {
        content = '<div class="message-text">[Mensagem]</div>';
    }
}
    
    // Botão de encaminhar (apenas para mensagens recebidas)
    const forwardButton = !isFromMe ? `
        <button class="btn btn-xs btn-outline-primary message-forward-btn" 
                onclick="showForwardModal('${message.id}')" 
                title="Encaminhar mensagem">
            <i class="bi bi-arrow-right"></i>
        </button>
    ` : '';

    return $(`
        <div class="message ${isFromMe ? 'sent' : 'received'}" data-message-id="${message.id}" data-message-type="${message.type}" data-message-content="${escapeHtml(message.content || '')}" data-media-url="${message.media_url || ''}">
            ${content}
            <div class="message-info">
                ${isFromMe && message.user_name ? `<span class="message-author">${message.user_name}</span>` : ''}
                <span class="message-time">${time}</span>
                ${isFromMe ? `<span class="message-status ${message.status}"><i class="bi bi-check2-all"></i></span>` : ''}
                ${forwardButton}
            </div>
        </div>
    `);
}

// ===== SISTEMA UNIFICADO DE CONVERSÃO DE ÁUDIO =====
// Configurações de formato por tipo
const AUDIO_FORMATS_CONFIG = {
  mp3: {
    mimeTypes: ['audio/mpeg', 'audio/mp3'],
    audioBitsPerSecond: 128000,
    priority: 1
  },
  ogg: {
    mimeTypes: ['audio/ogg', 'audio/ogg; codecs=opus'],
    audioBitsPerSecond: 64000,
    priority: 2
  },
  wav: {
    mimeTypes: ['audio/wav'],
    audioBitsPerSecond: 32000,
    priority: 3
  },
  webm: {
    mimeTypes: ['audio/webm'],
    audioBitsPerSecond: 64000,
    priority: 4
  }
};

// Função unificada de conversão de áudio
async function convertAudioToFormat(audioBlob, preferredFormat = 'mp3') {
  return new Promise((resolve) => {
    try {
      console.log(`🔄 Iniciando conversão para ${preferredFormat.toUpperCase()}...`);
      console.log('📁 Blob original:', audioBlob.type, 'Tamanho:', (audioBlob.size / 1024).toFixed(2) + 'KB');
      
      // Verificar se já está no formato desejado
      if (audioBlob.type && AUDIO_FORMATS_CONFIG[preferredFormat]?.mimeTypes.includes(audioBlob.type)) {
        console.log('✅ Áudio já está no formato correto:', preferredFormat);
        resolve(audioBlob);
        return;
      }
      
      // Encontrar melhor formato suportado
      const bestFormat = findBestSupportedFormat(preferredFormat);
      if (!bestFormat) {
        console.log('⚠️ Nenhum formato suportado, usando blob original');
        resolve(audioBlob);
        return;
      }
      
      // Executar conversão
      performAudioConversion(audioBlob, bestFormat, resolve);
      
    } catch (error) {
      console.error('❌ Erro geral na conversão:', error);
      resolve(audioBlob); // Fallback
    }
  });
}

// Encontrar melhor formato suportado
function findBestSupportedFormat(preferredFormat) {
  // Tentar formato preferido primeiro
  if (AUDIO_FORMATS_CONFIG[preferredFormat]) {
    for (const mimeType of AUDIO_FORMATS_CONFIG[preferredFormat].mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        return {
          format: preferredFormat,
          mimeType,
          ...AUDIO_FORMATS_CONFIG[preferredFormat]
        };
      }
    }
  }
  
  // Procurar por prioridade
  const sortedFormats = Object.entries(AUDIO_FORMATS_CONFIG)
    .sort(([,a], [,b]) => a.priority - b.priority);
  
  for (const [formatName, config] of sortedFormats) {
    for (const mimeType of config.mimeTypes) {
      if (MediaRecorder.isTypeSupported(mimeType)) {
        console.log('✅ Formato suportado encontrado:', formatName);
        return {
          format: formatName,
          mimeType,
          ...config
        };
      }
    }
  }
  
  return null;
}

// Executar conversão de áudio
function performAudioConversion(audioBlob, formatConfig, resolve) {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const url = URL.createObjectURL(audioBlob);
  
  fetch(url)
    .then(response => response.arrayBuffer())
    .then(arrayBuffer => audioContext.decodeAudioData(arrayBuffer))
    .then(audioBuffer => {
      const destination = audioContext.createMediaStreamDestination();
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(destination);
      
      const options = {
        mimeType: formatConfig.mimeType,
        audioBitsPerSecond: formatConfig.audioBitsPerSecond
      };
      
      const recorder = new MediaRecorder(destination.stream, options);
      const chunks = [];
      
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      
      recorder.onstop = () => {
        const convertedBlob = new Blob(chunks, { type: formatConfig.mimeType });
        URL.revokeObjectURL(url);
        console.log(`✅ Áudio convertido para ${formatConfig.format.toUpperCase()}:`, (convertedBlob.size / 1024).toFixed(2) + 'KB');
        resolve(convertedBlob);
      };
      
      recorder.onerror = (error) => {
        console.error('❌ Erro no MediaRecorder:', error);
        URL.revokeObjectURL(url);
        resolve(audioBlob); // Fallback
      };
      
      // Iniciar conversão
      recorder.start();
      source.start();
      
      // Timeout de segurança
      setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 30000);
      
      source.onended = () => {
        setTimeout(() => {
          if (recorder.state === 'recording') recorder.stop();
        }, 100);
      };
    })
    .catch(error => {
      console.error('❌ Erro na conversão:', error);
      URL.revokeObjectURL(url);
      resolve(audioBlob); // Fallback
    });
}

// Funções de compatibilidade (mantém funcionalidade existente)
async function convertAudioToMp3(audioBlob) {
  return convertAudioToFormat(audioBlob, 'mp3');
}

async function convertAudioToOgg(audioBlob) {
  return convertAudioToFormat(audioBlob, 'ogg');
}

async function convertAudioToCompatibleFormat(audioBlob) {
  return convertAudioToFormat(audioBlob, 'mp3'); // MP3 como padrão para WhatsApp
}

// Função para controlar áudio
function toggleAudio(audioId, mediaUrl) {
    console.log('Tentando tocar áudio:', audioId, mediaUrl);
    
    const audio = document.getElementById(audioId);
    const playBtn = $(`#player-${audioId.split('-')[1]} .play-btn i`);
    
    if (!audio) {
        console.error('Elemento de áudio não encontrado:', audioId);
        return;
    }
    
    // Se o áudio não carregou ainda, tentar forçar
    if (audio.readyState === 0) {
        console.log('Áudio não carregado, tentando carregar...');
        audio.load();
        
        // Tentar reproduzir após carregar
        audio.addEventListener('loadeddata', function() {
            console.log('Áudio carregado, tentando reproduzir...');
            audio.play().catch(e => {
                console.error('Erro ao reproduzir áudio:', e);
                // Tentar abrir em nova aba se falhar
                if (confirm('Não foi possível reproduzir o áudio aqui. Deseja abrir em nova aba?')) {
                    window.open(mediaUrl, '_blank');
                }
            });
        }, { once: true });
        
        // Erro ao carregar
        audio.addEventListener('error', function(e) {
            console.error('Erro ao carregar áudio:', e);
            alert('Erro ao carregar áudio. O arquivo pode estar corrompido ou em formato incompatível.');
        }, { once: true });
    } else if (audio.paused) {
        console.log('Reproduzindo áudio...');
        audio.play().catch(e => {
            console.error('Erro ao reproduzir áudio:', e);
            if (confirm('Não foi possível reproduzir o áudio aqui. Deseja abrir em nova aba?')) {
                window.open(mediaUrl, '_blank');
            }
        });
        playBtn.removeClass('bi-play-fill').addClass('bi-pause-fill');
    } else {
        console.log('Pausando áudio...');
        audio.pause();
        playBtn.removeClass('bi-pause-fill').addClass('bi-play-fill');
    }
    
    // Atualizar duração
    audio.addEventListener('loadedmetadata', function() {
        const duration = formatAudioTime(audio.duration);
        $(`#duration-${audioId.split('-')[1]}`).text(duration);
    });
    
    // Atualizar progresso
    audio.addEventListener('timeupdate', function() {
        const progress = (audio.currentTime / audio.duration) * 100;
        $(`#progress-${audioId.split('-')[1]}`).css('width', progress + '%');
        $(`#player-${audioId.split('-')[1]} .audio-time`).text(formatAudioTime(audio.currentTime));
    });
    
    // Quando terminar
    audio.addEventListener('ended', function() {
        playBtn.removeClass('bi-pause-fill').addClass('bi-play-fill');
        $(`#progress-${audioId.split('-')[1]}`).css('width', '0%');
    });
}

// Formatar tempo do áudio
function formatAudioTime(seconds) {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Processar atalhos de respostas rápidas - VERSÃO ATUALIZADA
function processShortcut(message) {
    const shortcut = message.substring(1).toLowerCase(); // Remove o "/" e deixa minúsculo
    
    console.log('🔍 Processando atalho:', shortcut);
    
    // Buscar resposta rápida pelo atalho
    const quickReply = quickReplies.find(reply => 
        reply.shortcut && reply.shortcut.toLowerCase() === shortcut
    );
    
    if (quickReply) {
        console.log('✅ Atalho encontrado:', quickReply.title);
        
        // APLICAR FORMATAÇÃO ANTES DE INSERIR
        const formattedContent = formatMessageForWhatsApp(quickReply.content);
        
        // Substituir o conteúdo no input
        $('#message-input').val(formattedContent);
        
        // Mostrar notificação
        showNotification('Atalho Aplicado', `"${quickReply.title}" carregado e formatado!`, 'success');
        
        // Focar no input para o usuário poder editar se quiser
        $('#message-input').focus();
        
        // Posicionar cursor no final
        const input = $('#message-input')[0];
        input.setSelectionRange(input.value.length, input.value.length);
        
        // Se mensagem for longa, mostrar preview automático
        if (formattedContent.length > 500) {
            setTimeout(() => {
                previewWhatsAppMessage(formattedContent);
            }, 1000);
        }
        
    } else {
        console.log('❌ Atalho não encontrado:', shortcut);
        
        // Mostrar atalhos disponíveis
        const availableShortcuts = quickReplies
            .filter(reply => reply.shortcut)
            .map(reply => `/${reply.shortcut}`)
            .join(', ');
        
        if (availableShortcuts) {
            showNotification('Atalho não encontrado', 
                `Atalhos disponíveis: ${availableShortcuts}`, 'warning');
        } else {
            showNotification('Atalho não encontrado', 
                'Nenhum atalho configurado. Crie respostas rápidas com atalhos!', 'warning');
        }
        
        // Limpar o input
        $('#message-input').val('');
    }
}

// Enviar mensagem - VERSÃO ATUALIZADA COM FORMATAÇÃO
async function sendMessage() {
    const content = $('#message-input').val().trim();
    if (!content || !currentContact) return;
    
    if (!currentSession) {
        showNotification('Erro', 'Nenhuma sessão WhatsApp ativa. Conecte um número primeiro.', 'error');
        return;
    }
    
    try {
        // Limpar input
        $('#message-input').val('').focus();
        
        // Marcar mensagens como lidas ao responder
        await markMessagesAsRead(currentContact.id);
        
        // USAR NOVA FORMATAÇÃO
        const formattedContent = formatMessageForWhatsApp(content);
        
        // Adicionar mensagem temporária
        const tempMessage = {
            id: 'temp-' + Date.now(),
            content: formattedContent,
            type: 'text',
            is_from_me: true,
            created_at: new Date(),
            user_name: currentUser.name,
            status: 'sending'
        };
        
        messages.push(tempMessage);
        renderMessages();
        scrollToBottom();
        
        // Enviar para o servidor
        const response = await $.post('/api/messages/send', {
            sessionId: currentSession,
            contactId: currentContact.id,
            content: formattedContent,
            type: 'text'
        });
        
        // Atualizar mensagem temporária
        const index = messages.findIndex(m => m.id === tempMessage.id);
        if (index !== -1) {
            messages[index].id = response.messageId;
            messages[index].status = 'sent';
            renderMessages();
        }
        
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
        showNotification('Erro', 'Falha ao enviar mensagem', 'error');
    }
}

// Upload de arquivo
async function uploadFile(file) {
    if (!currentContact) return;
    
    if (!currentSession) {
        showNotification('Erro', 'Nenhuma sessão WhatsApp ativa. Conecte um número primeiro.', 'error');
        return;
    }
    
    console.log('Enviando arquivo:', file.name, file.type, file.size);
    
    const formData = new FormData();
    formData.append('media', file);
    formData.append('sessionId', currentSession);
    formData.append('contactId', currentContact.id);
    formData.append('content', $('#message-input').val() || '');
    formData.append('type', getFileType(file));
    
    try {
        // Mostrar progresso
        showNotification('Enviando', 'Enviando arquivo...');
        
        const response = await $.ajax({
            url: '/api/messages/send',
            type: 'POST',
            data: formData,
            processData: false,
            contentType: false,
            xhr: function() {
                const xhr = new window.XMLHttpRequest();
                xhr.upload.addEventListener("progress", function(evt) {
                    if (evt.lengthComputable) {
                        const percentComplete = evt.loaded / evt.total * 100;
                        console.log('Upload: ' + percentComplete.toFixed(0) + '%');
                    }
                }, false);
                return xhr;
            }
        });
        
        console.log('Resposta do upload:', response);
        
        // Limpar input
        $('#message-input').val('');
        $('#file-input').val('');
        
        // Recarregar mensagens
        await loadMessages(currentContact.id);
        
        showNotification('Sucesso', 'Arquivo enviado!', 'success');
    } catch (error) {
        console.error('Erro ao enviar arquivo:', error);
        console.error('Detalhes:', error.responseJSON);
        showNotification('Erro', error.responseJSON?.error || 'Falha ao enviar arquivo', 'error');
    }
}

// Pegar próximo da fila
async function getNextFromQueue() {
    try {
        const sector = $('#filter-sector').val() || currentUser.sector;
        const response = await $.post('/api/queue/next', { sector });
        
        if (response.success) {
            showNotification('Novo Atendimento', `Atendendo ${response.queue.name || response.queue.number}`);
            
            // Limpar filtros temporariamente para garantir que o contato apareça
            $('#filter-sector').val('');
            $('#search-contact').val('');
            
            // Forçar recarregamento completo
            await loadContacts();
            
            // Aguardar DOM atualizar
            setTimeout(() => {
                // Procurar o contato pelo ID correto
                const contact = contacts.find(c => c.id === response.queue.contact_id);
                
                if (contact) {
                    // Atualizar a queue do contato
                    contact.queue = {
                        id: response.queue.id,
                        status: 'attending',
                        user_id: currentUser.id,
                        assigned_user_id: currentUser.id
                    };
                    
                    // Adicionar informações do usuário atual
                    contact.assignedUser = {
                        id: currentUser.id,
                        name: currentUser.name,
                        role: currentUser.role
                    };
                    
                    // Selecionar e abrir a conversa
                    selectContact(contact);
                    
                    // Rolar para o contato na lista
                    const $contactItem = $(`.contact-item[data-contact-id="${contact.id}"]`);
                    if ($contactItem.length) {
                        $contactItem[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                } else {
                    console.error('Contato não encontrado na lista. ID procurado:', response.queue.contact_id);
                    console.log('Contatos disponíveis:', contacts.map(c => ({id: c.id, name: c.name})));
                    
                    // Tentar recarregar novamente
                    setTimeout(async () => {
                        await loadContacts();
                        const retryContact = contacts.find(c => c.id === response.queue.contact_id);
                        if (retryContact) {
                            selectContact(retryContact);
                        }
                    }, 1000);
                }
                
                // Restaurar filtro do setor após abrir o contato
                setTimeout(() => {
                    $('#filter-sector').val(sector);
                }, 1000);
            }, 500);
            
        } else {
            showNotification('Fila Vazia', 'Não há atendimentos aguardando', 'info');
        }
    } catch (error) {
        console.error('Erro ao pegar próximo da fila:', error);
        showNotification('Erro', 'Falha ao processar fila', 'error');
    }
}

// Transferir atendimento
function transferChat() {
    if (!currentQueue) return;
    
    $('#transferModal').modal('show');
}

async function confirmTransfer() {
    if (!currentQueue) return;
    
    try {
        const newSector = $('#transfer-sector').val();
        const reason = $('#transfer-reason').val();
        const targetUserId = $('#transfer-user').val(); // Novo campo
        
        console.log('Transferindo para:', { newSector, targetUserId, reason });
        
        await $.post('/api/queue/transfer', {
            queueId: currentQueue.id,
            newSector,
            targetUserId: targetUserId || null,
            reason
        });
        
        $('#transferModal').modal('hide');
        
        const transferMsg = targetUserId ? 
            `Atendimento transferido para usuário específico em ${newSector}` :
            `Atendimento transferido para ${newSector}`;
            
        showNotification('Transferido', transferMsg, 'success');
        
        // Limpar conversa atual
        currentContact = null;
        currentQueue = null;
        $('#chat-header').hide();
        $('#typing-area').hide();
        $('#sidebar-right').hide();
        $('#messages-container').html('<div class="no-chat-selected"><i class="bi bi-chat-dots"></i><p>Selecione uma conversa para começar</p></div>');
        
        // Recarregar contatos e estatísticas
        await Promise.all([
            loadContacts(),
            updateQueueStats()
        ]);
        
    } catch (error) {
        console.error('Erro ao transferir:', error);
        showNotification('Erro', 'Falha ao transferir atendimento', 'error');
    }
}

// Finalizar atendimento - mostrar modal
function finishChat() {
    if (!currentQueue) return;
    
    $('#finishModal').modal('show');
}

// Confirmar finalização
async function confirmFinish() {
    if (!currentQueue) return;
    
    try {
        const sendGoodbye = $('#sendGoodbyeCheck').is(':checked');
        
        // Mostrar loading
        const $btn = $('#finishModal .btn-success');
        const originalText = $btn.html();
        $btn.html('<span class="spinner-border spinner-border-sm me-2"></span>Finalizando...').prop('disabled', true);
        
        await $.post('/api/queue/finish', {
            queueId: currentQueue.id,
            sendGoodbyeMessage: sendGoodbye
        });
        
      $('#finishModal').modal('hide');
        
        // Resetar botão
        $btn.html(originalText).prop('disabled', false);
        
        if (sendGoodbye) {
            showNotification('Finalizado', 'Atendimento finalizado e mensagem de despedida enviada!', 'success');
        } else {
            showNotification('Finalizado', 'Atendimento finalizado com sucesso!', 'success');
        }
        
        // **NOVO: Emitir evento Socket.IO para outros usuários**
        socket.emit('queue:finish', {
            id: currentQueue.id,
            contact_id: currentQueue.contact_id,
            contact_name: currentContact ? currentContact.name : 'Cliente',
            contact_number: currentContact ? currentContact.number : '',
            sector: currentQueue.sector,
            assigned_user_id: currentQueue.assigned_user_id,
            finished_by: currentUser.id,
            finished_by_name: currentUser.name,
            finished_at: new Date().toISOString()
        });
        
        // Limpar conversa
        currentContact = null;
        currentQueue = null;
        $('#chat-header').hide();
        $('#typing-area').hide();
        $('#sidebar-right').hide();
        $('#messages-container').html('<div class="no-chat-selected"><i class="bi bi-chat-dots"></i><p>Selecione uma conversa para começar</p></div>');
        
        // Recarregar
        await loadContacts();
        await updateQueueStats();
    } catch (error) {
        console.error('Erro ao finalizar:', error);
        
        // Resetar botão em caso de erro
        const $btn = $('#finishModal .btn-success');
        $btn.html('<i class="bi bi-check-circle"></i> Finalizar Atendimento').prop('disabled', false);
        
        showNotification('Erro', 'Falha ao finalizar atendimento', 'error');
    }
}

// Criar nova sessão
function showAddSession() {
    $('#addSessionModal').modal('show');
    $('#qr-code-area').hide();
    $('#qr-code-img').attr('src', '');
    $('#session-name').val('').prop('disabled', false);
    $('.modal-footer button').prop('disabled', false);
}

async function createSession() {
    const name = $('#session-name').val().trim();
    if (!name) {
        alert('Digite um nome para a sessão');
        return;
    }
    
    try {
        const response = await $.post('/api/sessions', { name });
        
        if (response.success) {
            showNotification('Aguarde', 'Gerando QR Code...');
            // O QR code será mostrado via socket
            
            // Desabilitar campos enquanto gera QR
            $('#session-name').prop('disabled', true);
            $('.modal-footer button').prop('disabled', true);
        }
    } catch (error) {
        console.error('Erro ao criar sessão:', error);
        showNotification('Erro', error.responseJSON?.error || 'Falha ao criar sessão', 'error');
    }
}

// Atualizar status da sessão
function updateSessionStatus(sessionId, status) {
    const $badge = $(`.session-badge[data-session-id="${sessionId}"] .status-dot`);
    $badge.removeClass('connected connecting disconnected').addClass(status);
    
    // Se conectou com sucesso, fechar modal e reabilitar
    if (status === 'connected' && $('#addSessionModal').hasClass('show')) {
        $('#addSessionModal').modal('hide');
        $('#session-name').prop('disabled', false);
        $('.modal-footer button').prop('disabled', false);
        loadSessions();
    }
}

// Carregar respostas rápidas
async function loadQuickReplies() {
    try {
        const response = await $.get('/api/quick-replies');
        quickReplies = response;
    } catch (error) {
        console.error('Erro ao carregar respostas rápidas:', error);
    }
}

// Carregar tags disponíveis - VERSÃO COM CACHE
async function loadAvailableTags() {
    try {
        // Verificar cache primeiro
        if (isCacheValid('tags')) {
            console.log('Tags carregadas do cache');
            availableTags = cache.tags.data;
            return;
        }
        
        console.log('Carregando tags do servidor...');
        const response = await $.get('/api/tags');
        availableTags = response;
        
        // Salvar no cache
        saveToCache('tags', response);
        
        console.log('Tags carregadas e cacheadas:', availableTags);
    } catch (error) {
        console.error('Erro ao carregar tags:', error);
        
        // Usar cache antigo em caso de erro, se disponível
        if (cache.tags.data) {
            console.log('Usando tags do cache devido ao erro');
            availableTags = cache.tags.data;
        }
    }
}

// Mostrar respostas rápidas
function showQuickReplies() {
    const $modal = $('#quickRepliesModal');
    const $list = $('#quick-replies-list');
    
    // Carregar variáveis disponíveis
    loadAvailableVariables();
    
    // Renderizar lista de respostas
    renderQuickRepliesList();
    
    $modal.modal('show');
}

// Carregar usuários para transferência específica
async function loadUsersForTransfer() {
    try {
        const sector = $('#transfer-sector').val();
        const $userSelect = $('#transfer-user');
        
        // Limpar opções existentes (manter primeira)
        $userSelect.find('option:not(:first)').remove();
        
        const users = await $.get('/api/users/by-sector', { sector });
        
        users.forEach(user => {
            // Não incluir o próprio usuário atual
            if (user.id !== currentUser.id) {
                const roleIcon = {
                    'admin': '👑',
                    'supervisor': '⭐',
                    'atendente': '👤'
                };
                
                $userSelect.append(`
                    <option value="${user.id}">
                        ${roleIcon[user.role]} ${user.name} (${user.role})
                    </option>
                `);
            }
        });
        
    } catch (error) {
        console.error('Erro ao carregar usuários:', error);
    }
}

// Renderizar lista de respostas rápidas
function renderQuickRepliesList() {
    const $list = $('#quick-replies-list');
    const searchTerm = $('#search-quick-reply').val().toLowerCase();
    
    $list.empty();
    
    const filteredReplies = quickReplies.filter(reply => 
        reply.title.toLowerCase().includes(searchTerm) || 
        reply.content.toLowerCase().includes(searchTerm)
    );
    
    if (filteredReplies.length === 0) {
        $list.html('<p class="text-muted text-center">Nenhuma resposta encontrada</p>');
        return;
    }
    
    filteredReplies.forEach(reply => {
        // Processar variáveis para preview
        const previewContent = processVariablesForPreview(reply.content);
        
        const $item = $(`
            <div class="quick-reply-item" data-id="${reply.id}">
                <div class="reply-header">
                    <h6>${reply.title}</h6>
                    <div class="reply-actions">
                        ${reply.shortcut ? 
                            `<span class="shortcut-badge" title="Digite /${reply.shortcut} no chat">
                                <i class="bi bi-lightning"></i> /${reply.shortcut}
                            </span>` : ''}
                        <button class="btn btn-xs btn-outline-danger ms-2" onclick="deleteQuickReply(${reply.id}, '${escapeHtml(reply.title)}')" title="Excluir resposta">
                            <i class="bi bi-trash"></i>
                        </button>
                    </div>
                </div>
                <div class="reply-content">
                    <div class="original-content">${escapeHtml(reply.content)}</div>
                    ${hasVariables(reply.content) ? 
                        `<div class="preview-content">
                            <small class="text-muted">Preview:</small><br>
                            <em>${escapeHtml(previewContent)}</em>
                        </div>` : ''}
                </div>
            </div>
        `);
        
        $item.on('click', () => {
            $('#message-input').val(reply.content);
            $('#quickRepliesModal').modal('hide');
            $('#message-input').focus();
        });
        
        $list.append($item);
    });
}

// Excluir resposta rápida
async function deleteQuickReply(replyId, replyTitle) {
    if (!confirm(`Deseja realmente excluir a resposta rápida "${replyTitle}"?\n\nEsta ação não pode ser desfeita.`)) {
        return;
    }
    
    try {
        const response = await $.ajax({
            url: `/api/quick-replies/${replyId}`,
            method: 'DELETE'
        });
        
        if (response.success) {
            showNotification('Sucesso', 'Resposta rápida excluída!', 'success');
            
            // Remover visualmente da lista
            $(`.quick-reply-item[data-id="${replyId}"]`).fadeOut(300, function() {
                $(this).remove();
                
                // Se não há mais respostas, mostrar mensagem
                if ($('.quick-reply-item').length === 0) {
                    $('#quick-replies-list').html('<p class="text-muted text-center">Nenhuma resposta encontrada</p>');
                }
            });
            
            // Recarregar lista de respostas
            await loadQuickReplies();
        }
        
    } catch (error) {
        console.error('Erro ao excluir resposta rápida:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao excluir resposta';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Verificar se o conteúdo tem variáveis
function hasVariables(content) {
    return /\{\{[^}]+\}\}/.test(content);
}

// Processar variáveis para preview
function processVariablesForPreview(content) {
    const now = new Date();
    const contactName = currentContact ? (currentContact.name || currentContact.number.split('@')[0]) : 'João Silva';
    
    return content
        .replace(/\{\{nome\}\}/g, contactName)
        .replace(/\{\{data\}\}/g, now.toLocaleDateString('pt-BR'))
        .replace(/\{\{hora\}\}/g, now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))
        .replace(/\{\{dia_semana\}\}/g, now.toLocaleDateString('pt-BR', { weekday: 'long' }));
}

// Carregar variáveis disponíveis
async function loadAvailableVariables() {
    try {
        const variables = await $.get('/api/quick-replies/variables');
        renderVariablesList(variables);
    } catch (error) {
        console.error('Erro ao carregar variáveis:', error);
    }
}

// Renderizar lista de variáveis
function renderVariablesList(variables) {
    const $list = $('#variables-list');
    $list.empty();
    
    Object.keys(variables).forEach(key => {
        const variable = variables[key];
        const $item = $(`
            <div class="variable-item" onclick="insertVariable('${variable.value}')">
                <div class="variable-code">${variable.value}</div>
                <div class="variable-info">
                    <strong>${variable.description}</strong>
                    <div class="variable-example">Exemplo: ${variable.example}</div>
                </div>
            </div>
        `);
        $list.append($item);
    });
}

// Inserir variável no campo ativo
function insertVariable(variableCode) {
    const $activeField = $('#new-reply-content:focus, #message-input:focus');
    
    if ($activeField.length > 0) {
        const field = $activeField[0];
        const start = field.selectionStart;
        const end = field.selectionEnd;
        const value = field.value;
        
        const newValue = value.substring(0, start) + variableCode + value.substring(end);
        field.value = newValue;
        
        // Posicionar cursor após a variável
        field.selectionStart = field.selectionEnd = start + variableCode.length;
        field.focus();
        
        // Atualizar preview se estiver no formulário
        if (field.id === 'new-reply-content') {
            updateReplyPreview();
        }
    } else {
        // Se nenhum campo estiver focado, mostrar mensagem
        showNotification('Dica', 'Clique no campo de texto antes de inserir a variável', 'info');
    }
}

// Atualizar preview da resposta em tempo real
function updateReplyPreview() {
    const content = $('#new-reply-content').val();
    const $preview = $('#reply-preview');
    
    if (!content.trim()) {
        $preview.text('Digite o conteúdo acima para ver o preview...');
        return;
    }
    
    const preview = processVariablesForPreview(content);
    $preview.text(preview);
}

// Adicionar nova resposta rápida
async function addQuickReply() {
    const title = prompt('Título da resposta:');
    if (!title) return;
    
    const content = prompt('Conteúdo da resposta:');
    if (!content) return;
    
    const shortcut = prompt('Atalho (opcional):');
    
    try {
        // Validar atalho se fornecido
        if (shortcut) {
            // Remover "/" se o usuário digitou
            const cleanShortcut = shortcut.replace(/^\/+/, '');
            
            // Verificar se já existe
            const existingShortcut = quickReplies.find(reply => 
                reply.shortcut && reply.shortcut.toLowerCase() === cleanShortcut.toLowerCase()
            );
            
            if (existingShortcut) {
                showNotification('Erro', `Atalho "/${cleanShortcut}" já existe!`, 'error');
                return;
            }
        }

        await $.post('/api/quick-replies', {
            title,
            content,
            shortcut: shortcut ? shortcut.replace(/^\/+/, '') : '', // Remove "/" extras
            sector: currentUser.sector || 'Geral' // CORREÇÃO: usar setor do usuário atual
        });
        
        await loadQuickReplies();
        showQuickReplies();
    } catch (error) {
        console.error('Erro ao criar resposta rápida:', error);
        showNotification('Erro', 'Falha ao criar resposta', 'error');
    }
}

// Atualizar estatísticas da fila - VERSÃO MELHORADA
async function updateQueueStats() {
    try {
        const response = await $.get('/api/queue/stats', {
            sector: $('#filter-sector').val() || currentUser.sector
        });
        
        // Atualizar com animação suave
        animateStatUpdate('#queue-waiting', response.waiting);
        animateStatUpdate('#queue-attending', response.attending);
        animateStatUpdate('#queue-finished', response.finished_today);
        
        // Atualizar também as estatísticas mini no cabeçalho
        $('#queue-waiting-mini').text(response.waiting);
        $('#queue-attending-mini').text(response.attending);
        $('#queue-finished-mini').text(response.finished_today);
        
    } catch (error) {
        console.error('Erro ao atualizar estatísticas:', error);
        
        // Indicar erro visual sem quebrar a interface
        $('.stat-value').addClass('stat-error');
        setTimeout(() => {
            $('.stat-value').removeClass('stat-error');
        }, 2000);
    }
}

// Função auxiliar para animar atualizações de estatísticas
function animateStatUpdate(selector, newValue) {
    const $element = $(selector);
    const currentValue = parseInt($element.text()) || 0;
    
    if (currentValue !== newValue) {
        $element.addClass('stat-updating');
        setTimeout(() => {
            $element.text(newValue);
            $element.removeClass('stat-updating');
        }, 150);
    }
}

// Atualizar informações do contato (sidebar direita)
function updateContactInfo(contact) {
    $('#info-name').text(contact.name || contact.number);
    $('#info-number').text(contact.number);
    
    // Usar foto real quando disponível
    const avatarUrl = getContactAvatar(contact);
    $('#info-avatar').attr('src', avatarUrl)
                     .attr('onerror', `this.src='${getDefaultAvatar(contact.name || contact.number)}'`);
    
    // Carregar tags do contato
    loadContactTags(contact.id);
    
    // Carregar anotações
    loadContactNotes(contact.id);
}

// Lidar com nova mensagem recebida
function handleNewMessage(data) {
    console.log('Nova mensagem recebida:', data);
    
    // Tocar som
    if (window.notificationSound) {
        window.notificationSound.play().catch(e => console.log('Erro ao tocar som:', e));
    }
    
    // Mostrar notificação
    const contactName = data.contact.name || data.contact.number;
    const messagePreview = data.message.content ? data.message.content.substring(0, 50) + '...' : '[Mídia]';
    showNotification(`Nova Mensagem de ${contactName}`, messagePreview);
    
    // Se for do contato atual, adicionar à conversa
    if (currentContact && currentContact.id === data.contact.id) {
        messages.push({
            id: data.messageId,
            contact_id: data.contact.id,
            content: data.message.content,
            type: data.message.type,
            media_url: data.message.mediaUrl,
            is_from_me: false,
            created_at: data.message.timestamp,
            status: 'received'
        });
        
        renderMessages();
        scrollToBottom();
        
        // Se o usuário está vendo a conversa e está no final, marcar como lida
        setTimeout(() => {
            const container = document.getElementById('messages-container');
            if (!document.hidden && isAtBottom(container)) {
                markMessagesAsRead(data.contact.id);
            }
        }, 1000);
    }
    
    // IMPORTANTE: Sempre recarregar lista de contatos para mostrar nova mensagem
    setTimeout(() => {
        loadContacts();
    }, 500);
    
    // Atualizar estatísticas se houver nova entrada na fila
    updateQueueStats();
}

// Funções auxiliares
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

function formatTime(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
        return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        return 'Ontem';
    } else if (diffDays < 7) {
        return date.toLocaleDateString('pt-BR', { weekday: 'short' });
    } else {
        return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    }
}

function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
}

function getQueueColor(status) {
    const colors = {
        'waiting': 'warning',
        'attending': 'primary',
        'finished': 'success',
        'transferred': 'info'
    };
    return colors[status] || 'secondary';
}

function getQueueLabel(status) {
    const labels = {
        'waiting': 'Aguardando',
        'attending': 'Em Atendimento',
        'finished': 'Finalizado',
        'transferred': 'Transferido'
    };
    return labels[status] || status;
}

function getFileType(file) {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('audio/')) return 'audio';
    if (file.type.startsWith('video/')) return 'video';
    return 'document';
}

function selectFile() {
    $('#file-input').click();
}

function showEmojis() {
    $('#emojiModal').modal('show');
    showEmojiCategory('smileys'); // Mostrar categoria padrão
}

// Sistema de Emojis
const emojiCategories = {
    smileys: ['😀','😃','😄','😁','😅','😂','🤣','😊','😇','🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','😵','😪','🤤','😴','🥱','😷','🤒','🤕','🤢','🤮','🤧','🥴','😈','👿'],
    gestures: ['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐','🖖','👋','🤏','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪','🦾','🦿','🦵','🦶','👂','🦻','👃','🧠','🦷','🦴','👀','👁','👅','👄','💋','🩸'],
    objects: ['📱','💻','⌨️','🖥','🖨','🖱','💾','💿','📷','📹','🎥','📞','☎️','📠','📺','📻','🎙','🎚','🎛','⏰','⏲','⏱','🕐','🕑','🕒','🕓','🕔','🕕','🕖','🕗','🕘','🕙','🕚','🕛','📡','🔋','🔌','💡','🔦','🕯','🪔','🧯','🛢','💸','💵','💴','💶','💷','💰','💳','💎','⚖️','🧰','🔧','🔨','⚒','🛠','⛏','🔩','⚙️','🧱','⛓','🧲','🔫','💣','🧨','🔪','🗡','⚔️','🛡','🚬','⚰️','⚱️','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳','💊','💉','🩹','🩺','🌡','🧬','🧫','🧪','🧹','🧺','🧻','🧼','🧽','🪒','🧴','🚿','🛁','🛀'],
    symbols: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','❤️‍🔥','❤️‍🩹','💟','☮️','✝️','☪️','🕉','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉','♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶','🈚','🈸','🈺','🈷️','✴️','🆚','💮','🉐','㊙️','㊗️','🈴','🈵','🈹','🈲','🅰️','🅱️','🆎','🆑','🅾️','🆘','❌','⭕','🛑','⛔','📛','🚫','💯','💢','♨️','🚷','🚯','🚳','🚱','🔞','📵','🚭','❗','❕','❓','❔','‼️','⁉️','🔅','🔆','〽️','⚠️','🚸','🔱','⚜️','🔰','♻️','✅','🈯','💹','❇️','✳️','❎','🌐','💠','Ⓜ️','🌀','💤','🏧','🚾','♿','🅿️','🈳','🈂️','🛂','🛃','🛄','🛅','🚹','🚺','🚼','🚻','🚮','🎦','📶','🈁','🔣','ℹ️','🔤','🔡','🔠','🆖','🆗','🆙','🆒','🆕','🆓','0️⃣','1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟','🔢','#️⃣','*️⃣','⏏️','▶️','⏸','⏯','⏹','⏺','⏭','⏮','⏩','⏪','⏫','⏬','◀️','🔼','🔽','➡️','⬅️','⬆️','⬇️','↗️','↘️','↙️','↖️','↕️','↔️','↪️','↩️','⤴️','⤵️','🔀','🔁','🔂','🔄','🔃','🎵','🎶','➕','➖','➗','✖️','♾','💲','💱','™️','©️','®️','〰️','➰','➿','🔚','🔙','🔛','🔝','🔜','✔️','☑️','🔘','🔴','🟠','🟡','🟢','🔵','🟣','⚫','⚪','🟤','🔺','🔻','🔸','🔹','🔶','🔷','🔳','🔲','▪️','▫️','◾','◽','◼️','◻️','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🟫','🔈','🔇','🔉','🔊','🔔','🔕','📣','📢','👁‍🗨','💬','💭','🗯','♠️','♣️','♥️','♦️','🃏','🎴','🀄','🕐','🕑','🕒','🕓','🕔','🕕','🕖','🕗','🕘','🕙','🕚','🕛','🕜','🕝','🕞','🕟','🕠','🕡','🕢','🕣','🕤','🕥','🕦','🕧'],
    food: ['🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥','🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶','🫑','🌽','🥕','🫒','🧄','🧅','🥔','🍠','🥐','🥯','🍞','🥖','🥨','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🥩','🍗','🍖','🌭','🍔','🍟','🍕','🫓','🥪','🥙','🧆','🌮','🌯','🫔','🥗','🥘','🫕','🥫','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🦪','🍤','🍙','🍚','🍘','🍥','🥠','🥮','🍢','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🍩','🍪','🌰','🥜','🍯','🥛','🍼','🫖','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🧉','🍾','🧊','🥄','🍴','🍽','🥣','🥡','🥢','🧂'],
    nature: ['🌸','🌺','🌻','🌷','🌹','🥀','🌼','🌵','🌲','🌳','🌴','🌱','🌿','☘️','🍀','🍁','🍂','🍃','🍄','🌾','🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐽','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🐥','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🦟','🦗','🕷','🕸','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏','🐪','🐫','🦒','🦘','🐃','🐂','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐕‍🦺','🐈','🐓','🦃','🦚','🦜','🦢','🦩','🕊','🐇','🦝','🦨','🦡','🦦','🦥','🐁','🐀','🐿','🦔','🐾','🐉','🐲','🌵','🎄','🌲','🌳','🌴','🌱','🌿','☘️','🍀','🎍','🎋','🍃','🍂','🍁','🍄','🐚','🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','🌞','🌝','🌛','🌜','🌚','🌕','🌖','🌗','🌘','🌑','🌒','🌓','🌔','🌙','🌎','🌍','🌏','🪐','💫','⭐','🌟','✨','⚡','☄️','💥','🔥','🌪','🌈','☀️','🌤','⛅','🌥','☁️','🌦','🌧','⛈','🌩','🌨','❄️','☃️','⛄','🌬','💨','💧','💦','☔','☂️','🌊','🌫'],
    places: ['🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏪','🏫','🏩','💒','🏛','⛪','🕌','🕍','🛕','🕋','⛩','🛤','🛣','🗾','🎑','🏞','🌅','🌄','🌠','🎇','🎆','🌇','🌆','🏙','🌃','🌌','🌉','🌁','🏰','🏯','🏟','🗼','🗽','🎠','🎡','🎢','💈','🎪','🚂','🚃','🚄','🚅','🚆','🚇','🚈','🚉','🚊','🚝','🚞','🚋','🚌','🚍','🚎','🚐','🚑','🚒','🚓','🚔','🚕','🚖','🚗','🚘','🚙','🛻','🚚','🚛','🚜','🏎','🏍','🛵','🦽','🦼','🛺','🚲','🛴','🛹','🛼','🚏','🛣','🛤','🛢','⛽','🚨','🚥','🚦','🛑','🚧','⚓','⛵','🛶','🚤','🛳','⛴','🛥','🚢','✈️','🛩','🛫','🛬','🪂','💺','🚁','🚟','🚠','🚡','🛰','🚀','🛸','🏗','🏭','🏠','🏡','🏘','🏚','🏢','🏬','🏣','🏤','🏥','🏦','🏪','🏫','🏩','💒','🏛','⛪','🕌','🕍','🛕','🕋','⛩','🛤','🛣','🗾','🎑','🏞','🌅','🌄','🌠','🎇','🎆','🌇','🌆','🏙','🌃','🌌','🌉','🌁']
};

// Mostrar categoria de emojis
function showEmojiCategory(category) {
    const grid = document.getElementById('emoji-grid');
    const emojis = emojiCategories[category] || [];
    
    // Atualizar botões ativos
    $('.emoji-categories button').removeClass('active');
    $(`.emoji-categories button[onclick*="${category}"]`).addClass('active');
    
    // Renderizar emojis
    grid.innerHTML = emojis.map(emoji => 
        `<span class="emoji-item" onclick="insertEmoji('${emoji}')">${emoji}</span>`
    ).join('');
}

// Inserir emoji no campo de mensagem
function insertEmoji(emoji) {
    const input = document.getElementById('message-input');
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const text = input.value;
    
    input.value = text.substring(0, start) + emoji + text.substring(end);
    input.selectionStart = input.selectionEnd = start + emoji.length;
    input.focus();
    
    $('#emojiModal').modal('hide');
}

function closeSidebar() {
    $('#sidebar-right').hide();
}

function showProfile() {
    $('#profileModal').modal('show');
    
    // Preencher dados do usuário
    $('#profile-name').val(currentUser.name || '');
    $('#profile-email').val(currentUser.email || '');
    $('#profile-sector').val(currentUser.sector || '');
    $('#profile-signature').val(currentUser.signature || '');
    $('#profile-role').text(currentUser.role || 'N/A');
    
    // Mostrar avatar se houver
    if (currentUser.avatar) {
        $('#profile-avatar-preview').attr('src', currentUser.avatar).show();
    } else {
        $('#profile-avatar-preview').hide();
    }
}

// Salvar perfil
async function saveProfile() {
    try {
        const profileData = {
            name: $('#profile-name').val().trim(),
            email: $('#profile-email').val().trim(),
            sector: $('#profile-sector').val(),
            signature: $('#profile-signature').val().trim()
        };
        
        // Validações
        if (!profileData.name) {
            showNotification('Erro', 'Nome é obrigatório', 'error');
            return;
        }
        
        if (!profileData.email || !isValidEmail(profileData.email)) {
            showNotification('Erro', 'Email válido é obrigatório', 'error');
            return;
        }
        
        showNotification('Salvando', 'Atualizando perfil...');
        
        const response = await $.ajax({
            url: '/api/profile',
            method: 'PUT',
            data: JSON.stringify(profileData),
            contentType: 'application/json'
        });
        
        if (response.success) {
            // Atualizar dados locais
            currentUser.name = profileData.name;
            currentUser.email = profileData.email;
            currentUser.sector = profileData.sector;
            currentUser.signature = profileData.signature;
            
            // Atualizar interface
            $('#user-name').text(currentUser.name);
            
            $('#profileModal').modal('hide');
            showNotification('Sucesso', 'Perfil atualizado com sucesso!', 'success');
        }
        
    } catch (error) {
        console.error('Erro ao salvar perfil:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao salvar perfil';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Alterar senha
async function changePassword() {
    const currentPassword = $('#current-password').val();
    const newPassword = $('#new-password').val();
    const confirmPassword = $('#confirm-password').val();
    
    if (!currentPassword || !newPassword || !confirmPassword) {
        showNotification('Erro', 'Preencha todos os campos de senha', 'error');
        return;
    }
    
    if (newPassword !== confirmPassword) {
        showNotification('Erro', 'Nova senha e confirmação não coincidem', 'error');
        return;
    }
    
    if (newPassword.length < 6) {
        showNotification('Erro', 'Nova senha deve ter pelo menos 6 caracteres', 'error');
        return;
    }
    
    try {
        showNotification('Alterando', 'Alterando senha...');
        
        const response = await $.ajax({
            url: '/api/profile/password',
            method: 'PUT',
            data: JSON.stringify({
                currentPassword,
                newPassword
            }),
            contentType: 'application/json'
        });
        
        if (response.success) {
            // Limpar campos
            $('#current-password, #new-password, #confirm-password').val('');
            
            showNotification('Sucesso', 'Senha alterada com sucesso!', 'success');
        }
        
    } catch (error) {
        console.error('Erro ao alterar senha:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao alterar senha';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Função auxiliar para validar email
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Enviar enquete
async function sendPoll() {
    const question = $('#poll-question').val().trim();
    const optionsText = $('#poll-options').val().trim();
    const type = $('#poll-type').val();
    
    if (!question) {
        showNotification('Erro', 'Digite a pergunta da enquete', 'error');
        return;
    }
    
    const options = optionsText.split('\n').filter(opt => opt.trim());
    
    if (options.length < 2) {
        showNotification('Erro', 'Adicione pelo menos 2 opções', 'error');
        return;
    }
    
    if (options.length > 10) {
        showNotification('Erro', 'Máximo de 10 opções permitidas', 'error');
        return;
    }
    
    if (!currentContact) {
        showNotification('Erro', 'Selecione um contato primeiro', 'error');
        return;
    }
    
    if (!currentSession) {
        showNotification('Erro', 'Nenhuma sessão WhatsApp ativa', 'error');
        return;
    }
    
    try {
        // Fechar modal
        $('#pollModal').modal('hide');
        
        // Criar enquete no banco de dados
        const pollData = await $.post('/api/polls', {
            contactId: currentContact.id,
            question: question,
            options: options,
            pollType: type,
            expiresIn: 24 // 24 horas para expirar
        });
        
        if (!pollData.success) {
            throw new Error(pollData.error || 'Erro ao criar enquete');
        }
        
        // Formatar mensagem da enquete
        let pollMessage = `📊 *${question}*\n\n`;
        
        options.forEach((option, index) => {
            const emoji = type === 'single' ? '🔘' : '☐';
            const number = index + 1;
            pollMessage += `${emoji} ${number}. ${option}\n`;
        });
        
        pollMessage += `\n_Responda com o número da opção${type === 'multiple' ? ' (pode escolher várias separadas por vírgula)' : ''}_`;
        pollMessage += `\n\n⏰ _Esta enquete expira em 24 horas_`;
        
        // Enviar mensagem via WhatsApp
        const result = await $.post('/api/messages/send', {
            sessionId: currentSession,
            contactId: currentContact.id,
            content: pollMessage,
            type: 'text'
        });
        
        if (result.success) {
            showNotification('Sucesso', 'Enquete enviada!', 'success');
            
            // Adicionar mensagem à conversa atual
            const tempMessage = {
                id: result.messageId,
                content: pollMessage,
                type: 'text',
                is_from_me: true,
                created_at: new Date(),
                user_name: currentUser.name,
                status: 'sent'
            };
            
            messages.push(tempMessage);
            renderMessages();
            scrollToBottom();
        } else {
            throw new Error(result.error || 'Erro ao enviar mensagem');
        }
        
    } catch (error) {
        console.error('Erro ao enviar enquete:', error);
        showNotification('Erro', 'Falha ao enviar enquete: ' + error.message, 'error');
    }
}

// Função showUsers será definida no dashboard.ejs

function showReports() {
    showDashboard();
}

// Mostrar enquetes criadas
function showMyPolls() {
    $('#myPollsModal').modal('show');
    loadMyPolls();
}

// Carregar minhas enquetes
async function loadMyPolls() {
    try {
        showNotification('Carregando', 'Carregando suas enquetes...');
        
        const polls = await $.get('/api/polls/my');
        renderMyPolls(polls);
        
    } catch (error) {
        console.error('Erro ao carregar enquetes:', error);
        showNotification('Erro', 'Falha ao carregar enquetes', 'error');
    }
}

// Renderizar lista de enquetes
function renderMyPolls(polls) {
    const $list = $('#my-polls-list');
    $list.empty();
    
    if (polls.length === 0) {
        $list.html(`
            <div class="text-center py-4">
                <i class="bi bi-ui-checks" style="font-size: 3rem; opacity: 0.3;"></i>
                <h5 class="mt-3 text-muted">Nenhuma enquete criada</h5>
                <p class="text-muted">Crie sua primeira enquete em uma conversa!</p>
            </div>
        `);
        return;
    }
    
    polls.forEach(poll => {
        const createdDate = new Date(poll.created_at).toLocaleString('pt-BR');
        const statusColor = poll.status === 'active' ? 'success' : poll.status === 'expired' ? 'warning' : 'secondary';
        const statusText = poll.status === 'active' ? 'Ativa' : poll.status === 'expired' ? 'Expirada' : 'Fechada';
        
        const $pollItem = $(`
            <div class="poll-item card mb-3">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <h6 class="card-title">${escapeHtml(poll.question)}</h6>
                            <p class="text-muted small mb-2">
                                Criada em: ${createdDate}<br>
                                ${poll.options.length} opções • ${poll.responsesCount || 0} respostas
                            </p>
                        </div>
                        <span class="badge bg-${statusColor}">${statusText}</span>
                    </div>
                    <div class="poll-actions">
                        <button class="btn btn-sm btn-outline-primary" onclick="viewPollDetails(${poll.id})">
                            <i class="bi bi-eye"></i> Ver Resultados
                        </button>
                        ${poll.status === 'active' ? `
                            <button class="btn btn-sm btn-outline-warning" onclick="closePoll(${poll.id})">
                                <i class="bi bi-stop-circle"></i> Fechar
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `);
        
        $list.append($pollItem);
    });
}
// Ver detalhes da enquete
async function viewPollDetails(pollId) {
    try {
        const response = await $.get(`/api/polls/${pollId}`);
        showPollResults(response);
        
    } catch (error) {
        console.error('Erro ao carregar detalhes da enquete:', error);
        showNotification('Erro', 'Falha ao carregar detalhes', 'error');
    }
}

// Mostrar resultados da enquete
function showPollResults(data) {
    const { poll, responses, stats } = data;
    
    $('#pollResultsModal').modal('show');
    $('#poll-results-question').text(poll.question);
    $('#poll-results-total').text(stats.totalResponses);
    
    const $results = $('#poll-results-details');
    $results.empty();
    
    // Mostrar estatísticas por opção
    Object.keys(stats.optionCounts).forEach(key => {
        const option = stats.optionCounts[key];
        
        const $optionResult = $(`
            <div class="option-result mb-3">
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <span><strong>${key}. ${escapeHtml(option.option)}</strong></span>
                    <span class="text-muted">${option.count} votos (${option.percentage}%)</span>
                </div>
                <div class="progress">
                    <div class="progress-bar" role="progressbar" style="width: ${option.percentage}%">
                    </div>
                </div>
            </div>
        `);
        
        $results.append($optionResult);
    });
    
    // Mostrar respostas individuais
    if (responses.length > 0) {
        $results.append('<hr><h6>Respostas:</h6>');
        
        responses.forEach(response => {
            const responseDate = new Date(response.created_at).toLocaleString('pt-BR');
            const selectedOptions = response.selected_options.map(index => 
                `${index}. ${poll.options[index - 1]}`
            ).join(', ');
            
            const $responseItem = $(`
                <div class="response-item mb-2 p-2 border rounded">
                    <div class="d-flex justify-content-between">
                        <strong>${escapeHtml(response.contact_name || response.contact_number)}</strong>
                        <small class="text-muted">${responseDate}</small>
                    </div>
                    <div class="text-primary">${escapeHtml(selectedOptions)}</div>
                </div>
            `);
            
            $results.append($responseItem);
        });
    }
}

// Fechar enquete
async function closePoll(pollId) {
    if (!confirm('Deseja realmente fechar esta enquete? Ela não receberá mais respostas.')) {
        return;
    }
    
    try {
        await $.post(`/api/polls/${pollId}/close`);
        showNotification('Sucesso', 'Enquete fechada com sucesso!', 'success');
        loadMyPolls(); // Recarregar lista
        
    } catch (error) {
        console.error('Erro ao fechar enquete:', error);
        showNotification('Erro', 'Falha ao fechar enquete', 'error');
    }
}

// Função para mostrar configurações de horário (chamada pelo menu)
function showBusinessHoursSettings() {
    // A função já foi definida acima na seção de horário comercial
    if (typeof window.showBusinessHoursSettings === 'function') {
        
        window.showBusinessHoursSettings();
    } else {
        // Fallback se função não estiver disponível
        if (!['admin', 'supervisor'].includes(currentUser.role)) {
            showNotification('Erro', 'Sem permissão para acessar configurações', 'error');
            return;
        }
        
        $('#businessHoursModal').modal('show');
        setTimeout(() => {
            loadBusinessHoursSettings();
            refreshBusinessStatus();
        }, 300);
    }
}

// ===========================================
// SISTEMA DE MENSAGENS AUTOMÁTICAS
// ===========================================

// Variáveis globais para mensagens automáticas
let autoMessagesSettings = null;

// Mostrar configurações de mensagens automáticas
function showAutoMessagesSettings() {
    // Verificar permissão
    if (!['admin', 'supervisor'].includes(currentUser.role)) {
        showNotification('Erro', 'Sem permissão para acessar configurações', 'error');
        return;
    }
    
    $('#autoMessagesModal').modal('show');
    
    // Carregar configurações após modal abrir
    setTimeout(() => {
        loadAutoMessagesSettings();
        setupAutoMessagesListeners();
    }, 300);
}

// Carregar configurações do servidor
async function loadAutoMessagesSettings() {
  try {
    showNotification('Carregando', 'Carregando configurações...');
    
    // Buscar configurações do servidor
    const settings = await $.get('/api/auto-messages/settings');
    autoMessagesSettings = settings;
    
    // Preencher formulários
    populateAutoMessagesForm(settings);
    
    // Carregar variáveis disponíveis
    await loadAutoMessageVariables();
    
    // Carregar templates disponíveis
    await loadAutoMessageTemplates();
    
    console.log('Configurações de mensagens automáticas carregadas:', settings);
    
  } catch (error) {
    console.error('Erro ao carregar configurações:', error);
    showNotification('Erro', 'Falha ao carregar configurações', 'error');
    
    // Usar configurações padrão em caso de erro
    autoMessagesSettings = getDefaultAutoMessagesSettings();
    populateAutoMessagesForm(autoMessagesSettings);
  }
}

// ===========================================
// RELOAD DE CONFIGURAÇÕES SEM RESTART
// ===========================================

// Recarregar configurações sem reiniciar servidor
async function reloadConfigurations() {
  try {
    showNotification('Aplicando', 'Aplicando configurações...', 'info');
    
    const response = await $.ajax({
      url: '/api/system/reload-config',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    if (response.success) {
      showNotification('Sucesso', response.message, 'success');
      console.log('✅ Configurações recarregadas com sucesso');
    } else {
      showNotification('Erro', response.error || 'Erro ao aplicar configurações', 'error');
    }
    
  } catch (error) {
    console.error('Erro ao recarregar configurações:', error);
    
    if (error.status === 403) {
      showNotification('Erro', 'Sem permissão para aplicar configurações', 'error');
    } else {
      showNotification('Erro', 'Falha ao aplicar configurações', 'error');
    }
  }
}

// Salvar e aplicar configurações automaticamente
async function saveAndApplyConfigurations(endpoint, formData) {
  try {
    showNotification('Salvando', 'Salvando configurações...', 'info');
    
    // 1. Salvar configurações
    const saveResponse = await $.ajax({
      url: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify(formData)
    });
    
    if (saveResponse.success) {
      showNotification('Salvo', 'Configurações salvas!', 'success');
      
      // 2. Aplicar imediatamente
      setTimeout(async () => {
        await reloadConfigurations();
      }, 500);
      
    } else {
      showNotification('Erro', saveResponse.error || 'Erro ao salvar', 'error');
    }
    
  } catch (error) {
    console.error('Erro ao salvar configurações:', error);
    showNotification('Erro', 'Falha ao salvar configurações', 'error');
  }
}

// **NOVAS FUNÇÕES ADICIONADAS**

// Obter configurações padrão
function getDefaultAutoMessagesSettings() {
  return {
    welcome: {
      enabled: false,
      message: '👋 Olá! Bem-vindo ao nosso atendimento. Em breve um de nossos atendentes irá lhe atender.',
      businessHoursOnly: true,
      afterHoursMessage: '🌙 Olá! Nosso horário de atendimento é de 8h às 18h. Sua mensagem foi registrada e será respondida assim que possível.'
    },
    goodbye: {
      enabled: false,
      message: '👋 Agradecemos seu contato! Caso precise de algo mais, estamos à disposição.',
      includeSignature: true,
      includeRating: false
    },
    polls: {
      autoSave: true,
      autoExpire: true,
      expireTime: 24,
      expireAction: 'close',
      notifyResponse: true,
      notifyCompletion: true,
      autoConfirm: true
    },
    advanced: {
      messageDelay: 2,
      preventSpam: true,
      spamInterval: 5,
      logMessages: true,
      showAutoSignature: false
    }
  };
}

// Carregar variáveis disponíveis
async function loadAutoMessageVariables() {
  try {
    const variables = await $.get('/api/auto-messages/variables');
    renderAutoMessageVariables(variables);
  } catch (error) {
    console.error('Erro ao carregar variáveis:', error);
  }
}

// Renderizar variáveis disponíveis
function renderAutoMessageVariables(variables) {
  const containers = ['#welcome-variables', '#goodbye-variables'];
  
  containers.forEach(containerSelector => {
    const $container = $(containerSelector);
    $container.empty();
    
    // Agrupar por categoria
    const categories = {};
    Object.keys(variables).forEach(key => {
      const variable = variables[key];
      const category = variable.category || 'outros';
      
      if (!categories[category]) {
        categories[category] = [];
      }
      categories[category].push(variable);
    });
    
    // Renderizar por categoria
    Object.keys(categories).forEach(categoryName => {
      const categoryVariables = categories[categoryName];
      
      const categoryNames = {
        'contato': '👤 Contato',
        'sistema': '⚙️ Sistema', 
        'data': '📅 Data/Hora',
        'outros': '📝 Outros'
      };
      
      $container.append(`
        <div class="variable-category">
          <h6 class="variable-category-title">${categoryNames[categoryName] || categoryName}</h6>
          <div class="variable-buttons">
            ${categoryVariables.map(variable => `
              <button type="button" class="btn btn-outline-secondary btn-sm variable-btn" 
                      onclick="insertAutoMessageVariable('${variable.value}', '${containerSelector}')" 
                      title="${variable.description} - Ex: ${variable.example}">
                ${variable.value}
              </button>
            `).join('')}
          </div>
        </div>
      `);
    });
  });
}

// Inserir variável na mensagem
function insertAutoMessageVariable(variableCode, containerSelector) {
  // Determinar qual campo de texto usar baseado no container
  let targetFieldId = '#welcome-message';
  
  if (containerSelector.includes('welcome')) {
    // Verificar se está na aba de horário comercial ou fora do horário
    const activeTab = $('#welcome-tabs .nav-link.active').attr('href');
    if (activeTab === '#welcome-after-hours-tab') {
      targetFieldId = '#welcome-after-hours';
    }
  } else if (containerSelector.includes('goodbye')) {
    targetFieldId = '#goodbye-message';
  }
  
  const $field = $(targetFieldId);
  if ($field.length === 0) return;
  
  const field = $field[0];
  const start = field.selectionStart || 0;
  const end = field.selectionEnd || 0;
  const value = field.value;
  
  const newValue = value.substring(0, start) + variableCode + value.substring(end);
  field.value = newValue;
  
  // Posicionar cursor após a variável
  field.selectionStart = field.selectionEnd = start + variableCode.length;
  field.focus();
  
  // Atualizar preview
  if (targetFieldId.includes('welcome')) {
    updateWelcomePreview();
  } else if (targetFieldId.includes('goodbye')) {
    updateGoodbyePreview();
  }
}

// Carregar templates disponíveis
async function loadAutoMessageTemplates() {
  try {
    const templates = await $.get('/api/auto-messages/templates');
    renderAutoMessageTemplates(templates);
  } catch (error) {
    console.error('Erro ao carregar templates:', error);
  }
}

// Renderizar templates disponíveis
function renderAutoMessageTemplates(templates) {
  const $container = $('#templates-list');
  $container.empty();
  
  // Agrupar templates por categoria
  const categories = {};
  Object.keys(templates).forEach(key => {
    const template = templates[key];
    const category = template.category || 'outros';
    
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push({ key, ...template });
  });
  
  // Renderizar por categoria
  Object.keys(categories).forEach(categoryName => {
    const categoryTemplates = categories[categoryName];
    
    const categoryNames = {
      'setor': '🏢 Por Setor',
      'estilo': '🎨 Por Estilo',
      'outros': '📝 Outros'
    };
    
    $container.append(`
      <div class="template-category mb-4">
        <h6 class="template-category-title">${categoryNames[categoryName] || categoryName}</h6>
        <div class="row">
          ${categoryTemplates.map(template => `
            <div class="col-md-6 mb-3">
              <div class="template-card card">
                <div class="card-body">
                  <h6 class="card-title">${template.name}</h6>
                  <p class="card-text text-muted small">${template.description}</p>
                  <div class="template-preview mb-2">
                    <small><strong>Boas-vindas:</strong></small>
                    <div class="text-truncate small text-muted">${template.welcome.business}</div>
                    <small><strong>Despedida:</strong></small>
                    <div class="text-truncate small text-muted">${template.goodbye}</div>
                  </div>
                  <button class="btn btn-sm btn-outline-primary" onclick="applyTemplate('${template.key}')">
                    <i class="bi bi-download"></i> Aplicar Template
                  </button>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `);
  });
  
  if (Object.keys(categories).length === 0) {
    $container.html('<p class="text-muted text-center">Nenhum template disponível</p>');
  }
}

// Preencher formulários com dados
function populateAutoMessagesForm(settings) {
    // Boas-vindas
    $('#welcome-enabled').prop('checked', settings.welcome?.enabled || false);
    $('#welcome-message').val(settings.welcome?.message || '');
    $('#welcome-after-hours').val(settings.welcome?.afterHoursMessage || '');
    
    // Despedida
    $('#goodbye-enabled').prop('checked', settings.goodbye?.enabled || false);
    $('#goodbye-message').val(settings.goodbye?.message || '');
    $('#goodbye-include-signature').prop('checked', settings.goodbye?.includeSignature || false);
    $('#goodbye-include-rating').prop('checked', settings.goodbye?.includeRating || false);
    
    // Enquetes
    $('#polls-auto-save').prop('checked', settings.polls?.autoSave || false);
    $('#polls-auto-expire').prop('checked', settings.polls?.autoExpire || false);
    $('#polls-expire-time').val(settings.polls?.expireTime || 24);
    $('#polls-expire-action').val(settings.polls?.expireAction || 'close');
    $('#polls-notify-response').prop('checked', settings.polls?.notifyResponse || false);
    $('#polls-notify-completion').prop('checked', settings.polls?.notifyCompletion || false);
    $('#polls-auto-confirm').prop('checked', settings.polls?.autoConfirm || false);
    
    // Avançado
    $('#auto-message-delay').val(settings.advanced?.messageDelay || 2);
    $('#prevent-spam').prop('checked', settings.advanced?.preventSpam || false);
    $('#spam-interval').val(settings.advanced?.spamInterval || 5);
    $('#log-auto-messages').prop('checked', settings.advanced?.logMessages || false);
    $('#show-auto-signature').prop('checked', settings.advanced?.showAutoSignature || false);
    
    // Atualizar previews
    updateWelcomePreview();
    updateGoodbyePreview();
}

// Configurar event listeners
function setupAutoMessagesListeners() {
    // Preview em tempo real para boas-vindas
    $('#welcome-message').off('input').on('input', updateWelcomePreview);
    $('#welcome-after-hours').off('input').on('input', updateWelcomePreview);
    
    // Preview em tempo real para despedida
    $('#goodbye-message').off('input').on('input', updateGoodbyePreview);
    $('#goodbye-include-signature, #goodbye-include-rating').off('change').on('change', updateGoodbyePreview);
}

// Atualizar preview de boas-vindas
function updateWelcomePreview() {
    const message = $('#welcome-message').val();
    const $preview = $('#welcome-preview-content');
    
    if (!message.trim()) {
        $preview.html('<em class="text-muted">Digite uma mensagem para ver o preview...</em>');
        return;
    }
    
    // Preview simples com variáveis substituídas
    let preview = message
        .replace(/\{\{nome\}\}/g, 'João Silva')
        .replace(/\{\{saudacao\}\}/g, getSaudacaoAtual())
        .replace(/\{\{hora\}\}/g, new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    
    preview = preview.replace(/\n/g, '<br>');
    $preview.html(preview);
}

// Atualizar preview de despedida
function updateGoodbyePreview() {
    let message = $('#goodbye-message').val();
    const includeSignature = $('#goodbye-include-signature').is(':checked');
    const includeRating = $('#goodbye-include-rating').is(':checked');
    const $preview = $('#goodbye-preview-content');
    
    if (!message.trim()) {
        $preview.html('<em class="text-muted">Digite uma mensagem para ver o preview...</em>');
        return;
    }
    
    // Adicionar assinatura se habilitado
    if (includeSignature && currentUser.signature) {
        message += `\n\n_${currentUser.signature}_`;
    }
    
    // Adicionar avaliação se habilitado
    if (includeRating) {
        message += '\n\n⭐ Avalie nosso atendimento de 1 a 5 estrelas!';
    }
    
    let preview = message.replace(/\n/g, '<br>');
    $preview.html(preview);
}

// Testar mensagem de boas-vindas
async function testWelcomeMessage() {
    const message = $('#welcome-message').val().trim();
    
    if (!message) {
        showNotification('Erro', 'Digite uma mensagem para testar', 'error');
        return;
    }
    
    try {
        showNotification('Testando', 'Processando mensagem de boas-vindas...');
        
        // Simular processamento
        setTimeout(() => {
            showNotification('Teste Concluído', 'Mensagem de boas-vindas testada!', 'success');
            updateWelcomePreview();
        }, 1000);
        
    } catch (error) {
        console.error('Erro ao testar mensagem:', error);
        showNotification('Erro', 'Falha ao testar mensagem', 'error');
    }
}

// Testar mensagem de despedida
async function testGoodbyeMessage() {
    const message = $('#goodbye-message').val().trim();
    
    if (!message) {
        showNotification('Erro', 'Digite uma mensagem para testar', 'error');
        return;
    }
    
    try {
        showNotification('Testando', 'Processando mensagem de despedida...');
        
        setTimeout(() => {
            showNotification('Teste Concluído', 'Mensagem de despedida testada!', 'success');
            updateGoodbyePreview();
        }, 1000);
        
    } catch (error) {
        console.error('Erro ao testar mensagem:', error);
        showNotification('Erro', 'Falha ao testar mensagem', 'error');
    }
}

// Restaurar mensagens padrão
function resetWelcomeMessage() {
    if (!confirm('Deseja restaurar as mensagens padrão de boas-vindas?')) return;
    
    $('#welcome-message').val('👋 Olá! Bem-vindo ao nosso atendimento. Em breve um de nossos atendentes irá lhe atender.');
    $('#welcome-after-hours').val('🌙 Olá! Nosso horário de atendimento é de 8h às 18h. Sua mensagem foi registrada e será respondida assim que possível.');
    
    updateWelcomePreview();
    showNotification('Restaurado', 'Mensagens padrão de boas-vindas restauradas!', 'success');
}

function resetGoodbyeMessage() {
    if (!confirm('Deseja restaurar a mensagem padrão de despedida?')) return;
    
    $('#goodbye-message').val('👋 Agradecemos seu contato! Caso precise de algo mais, estamos à disposição.');
    
    updateGoodbyePreview();
    showNotification('Restaurado', 'Mensagem padrão de despedida restaurada!', 'success');
}

// Aplicar template do servidor
async function applyTemplate(templateKey) {
  try {
    if (!confirm('Deseja aplicar este template? Isso irá sobrescrever as mensagens atuais.')) {
      return;
    }
    
    showNotification('Aplicando', 'Aplicando template...');
    
    const response = await $.post('/api/auto-messages/apply-template', {
      templateKey: templateKey
    });
    
    if (response.success) {
      showNotification('Sucesso', response.message, 'success');
      
      // Recarregar configurações para refletir as mudanças
      setTimeout(() => {
        loadAutoMessagesSettings();
      }, 1000);
    }
    
  } catch (error) {
    console.error('Erro ao aplicar template:', error);
    const errorMsg = error.responseJSON?.error || 'Erro ao aplicar template';
    showNotification('Erro', errorMsg, 'error');
  }
}

// Testar mensagem de boas-vindas melhorada
async function testWelcomeMessage() {
  const message = $('#welcome-message').val().trim();
  
  if (!message) {
    showNotification('Erro', 'Digite uma mensagem para testar', 'error');
    return;
  }
  
  try {
    showNotification('Testando', 'Processando mensagem de boas-vindas...');
    
    const response = await $.post('/api/auto-messages/test', {
      type: 'welcome',
      message: message,
      contactId: currentContact?.id || null
    });
    
    if (response.success) {
      // Mostrar resultado no preview
      $('#welcome-preview-content').html(response.processedMessage.replace(/\n/g, '<br>'));
      
      showNotification('Teste Concluído', 'Mensagem de boas-vindas testada com sucesso!', 'success');
      
      // Mostrar modal com resultado detalhado se necessário
      if (response.originalMessage !== response.processedMessage) {
        console.log('Mensagem original:', response.originalMessage);
        console.log('Mensagem processada:', response.processedMessage);
        console.log('Contato usado:', response.usedContact);
      }
    }
    
  } catch (error) {
    console.error('Erro ao testar mensagem:', error);
    showNotification('Erro', 'Falha ao testar mensagem', 'error');
  }
}

// Testar mensagem de despedida melhorada
async function testGoodbyeMessage() {
  const message = $('#goodbye-message').val().trim();
  
  if (!message) {
    showNotification('Erro', 'Digite uma mensagem para testar', 'error');
    return;
  }
  
  try {
    showNotification('Testando', 'Processando mensagem de despedida...');
    
    const response = await $.post('/api/auto-messages/test', {
      type: 'goodbye',
      message: message,
      contactId: currentContact?.id || null
    });
    
    if (response.success) {
      // Mostrar resultado no preview
      $('#goodbye-preview-content').html(response.processedMessage.replace(/\n/g, '<br>'));
      
      showNotification('Teste Concluído', 'Mensagem de despedida testada com sucesso!', 'success');
    }
    
  } catch (error) {
    console.error('Erro ao testar mensagem:', error);
    showNotification('Erro', 'Falha ao testar mensagem', 'error');
  }
}

// Exportar configurações (funcionalidade extra)
function exportAutoMessagesConfig() {
  try {
    const config = {
      exportDate: new Date().toISOString(),
      settings: autoMessagesSettings,
      version: '1.0'
    };
    
    const dataStr = JSON.stringify(config, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    
    const link = document.createElement('a');
    link.href = URL.createObjectURL(dataBlob);
    link.download = `mensagens_automaticas_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    
    showNotification('Exportado', 'Configurações exportadas com sucesso!', 'success');
    
  } catch (error) {
    console.error('Erro ao exportar:', error);
    showNotification('Erro', 'Falha ao exportar configurações', 'error');
  }
}

// Importar configurações (funcionalidade extra)
function importAutoMessagesConfig() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  
  input.onchange = function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const config = JSON.parse(e.target.result);
        
        if (!config.settings) {
          throw new Error('Arquivo de configuração inválido');
        }
        
        if (confirm('Deseja importar estas configurações? Isso irá sobrescrever as configurações atuais.')) {
          autoMessagesSettings = config.settings;
          populateAutoMessagesForm(config.settings);
          
          showNotification('Importado', 'Configurações importadas! Não esqueça de salvar.', 'success');
        }
        
      } catch (error) {
        console.error('Erro ao importar:', error);
        showNotification('Erro', 'Arquivo de configuração inválido', 'error');
      }
    };
    
    reader.readAsText(file);
  };
  
  input.click();
}

// Salvar configurações de mensagens automáticas
async function saveAutoMessagesSettings() {
    try {
        // Verificar permissão
        if (currentUser.role !== 'admin') {
            showNotification('Erro', 'Apenas administradores podem salvar configurações', 'error');
            return;
        }
        
        showNotification('Salvando', 'Salvando configurações...');
        
        // Coletar dados dos formulários
        const settings = {
            welcome: {
                enabled: $('#welcome-enabled').is(':checked'),
                message: $('#welcome-message').val().trim(),
            },
            goodbye: {
                enabled: $('#goodbye-enabled').is(':checked'),
                message: $('#goodbye-message').val().trim(),
                includeSignature: $('#goodbye-include-signature').is(':checked'),
                includeRating: $('#goodbye-include-rating').is(':checked')
            },
            polls: {
                autoSave: $('#polls-auto-save').is(':checked'),
                autoExpire: $('#polls-auto-expire').is(':checked'),
                expireTime: parseInt($('#polls-expire-time').val()) || 24,
                expireAction: $('#polls-expire-action').val(),
                notifyResponse: $('#polls-notify-response').is(':checked'),
                notifyCompletion: $('#polls-notify-completion').is(':checked'),
                autoConfirm: $('#polls-auto-confirm').is(':checked')
            },
            advanced: {
                messageDelay: parseInt($('#auto-message-delay').val()) || 2,
                preventSpam: $('#prevent-spam').is(':checked'),
                spamInterval: parseInt($('#spam-interval').val()) || 5,
                logMessages: $('#log-auto-messages').is(':checked'),
                showAutoSignature: $('#show-auto-signature').is(':checked')
            }
        };
        
        // Validações
        if (!settings.welcome.message) {
            showNotification('Erro', 'Mensagem de boas-vindas não pode estar vazia', 'error');
            return;
        }
        
        if (!settings.goodbye.message) {
            showNotification('Erro', 'Mensagem de despedida não pode estar vazia', 'error');
            return;
        }
        
        console.log('Salvando configurações de mensagens automáticas:', settings);
        
        // CORREÇÃO: Fazer requisição real para o servidor
        const response = await $.ajax({
            url: '/api/auto-messages/settings',
            method: 'POST',
            data: JSON.stringify(settings),
            contentType: 'application/json',
            processData: false
        });
        
        if (response.success) {
            autoMessagesSettings = settings;
            showNotification('Sucesso', 'Configurações de mensagens automáticas salvas!', 'success');
        } else {
            throw new Error(response.error || 'Erro desconhecido');
        }
        
    } catch (error) {
        console.error('Erro ao salvar configurações:', error);
        const errorMsg = error.responseJSON?.error || error.message || 'Falha ao salvar configurações';
        showNotification('Erro', errorMsg, 'error');
    }
}

// ===== ADICIONAR TODAS ESSAS FUNÇÕES NO FINAL DO ARQUIVO =====

// Variáveis para os gráficos
let dailyChart = null;
let tagsChart = null;

// Mostrar dashboard
function showDashboard() {
    $('#dashboardModal').modal('show');
    setTimeout(() => {
        loadDashboardData();
    }, 300); // Aguardar modal abrir para renderizar gráficos
}

// Carregar dados do dashboard
async function loadDashboardData() {
    try {
        const period = $('#dashboard-period').val();
        const sector = $('#dashboard-sector').val();
        
        showNotification('Carregando', 'Atualizando estatísticas...');
        
        // Carregar estatísticas gerais
        const [stats, dailyStats, agentsRanking, topTags] = await Promise.all([
            $.get('/api/dashboard/stats', { days: period, sector }),
            $.get('/api/dashboard/daily-stats', { days: period, sector }),
            $.get('/api/dashboard/agents-ranking', { days: period, sector }),
            $.get('/api/dashboard/top-tags', { limit: 5, sector })
        ]);
        
        // Atualizar cards
        updateDashboardCards(stats);
        
        // Atualizar gráficos
        updateDailyChart(dailyStats);
        updateTagsChart(topTags);
        
        // Atualizar ranking
        updateAgentsRanking(agentsRanking);
        
        showNotification('Sucesso', 'Dashboard atualizado!', 'success');
        
    } catch (error) {
        console.error('Erro ao carregar dashboard:', error);
        showNotification('Erro', 'Falha ao carregar estatísticas', 'error');
    }
}

// Atualizar cards de estatísticas
function updateDashboardCards(stats) {
    $('#total-chats').text(stats.total || 0);
    $('#today-chats').text(stats.todayTotal || 0);
    
    $('#finished-chats').text(stats.byUser?.reduce((sum, user) => sum + user.count, 0) || 0);
    $('#today-finished').text(stats.todayFinished || 0);
    
    $('#avg-time').text(stats.avgTime || 0);
    $('#today-avg-time').text(stats.todayAvgTime || 0);
    
    // Calcular eficiência
    const efficiency = stats.total > 0 ? Math.round((stats.todayFinished / stats.todayTotal) * 100) : 0;
    $('#efficiency').text(efficiency);
}

// Atualizar gráfico diário
function updateDailyChart(dailyStats) {
    const ctx = document.getElementById('dailyChart').getContext('2d');
    
    // Destruir gráfico anterior se existir
    if (dailyChart) {
        dailyChart.destroy();
    }
    
    dailyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: dailyStats.map(day => day.dateFormatted),
            datasets: [
                {
                    label: 'Total de Atendimentos',
                    data: dailyStats.map(day => day.total),
                    borderColor: '#471e8a',
                    backgroundColor: 'rgba(71, 30, 138, 0.1)',
                    tension: 0.4,
                    fill: true
                },
                {
                    label: 'Finalizados',
                    data: dailyStats.map(day => day.finished),
                    borderColor: '#28a745',
                    backgroundColor: 'rgba(40, 167, 69, 0.1)',
                    tension: 0.4,
                    fill: true
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1
                    }
                }
            },
            plugins: {
                legend: {
                    position: 'top'
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        afterBody: function(tooltipItems) {
                            const dataIndex = tooltipItems[0].dataIndex;
                            const avgTime = dailyStats[dataIndex].avgTime;
                            return `Tempo médio: ${avgTime}min`;
                        }
                    }
                }
            }
        }
    });
}

// Atualizar gráfico de tags
function updateTagsChart(topTags) {
    const ctx = document.getElementById('tagsChart').getContext('2d');
    
    // Destruir gráfico anterior se existir
    if (tagsChart) {
        tagsChart.destroy();
    }
    
    if (topTags.length === 0) {
        ctx.fillStyle = '#666';
        ctx.font = '14px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('Nenhuma tag encontrada', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }
    
    tagsChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: topTags.map(tag => tag.name),
            datasets: [{
                data: topTags.map(tag => tag.usage_count),
                backgroundColor: topTags.map(tag => tag.color || '#6c757d'),
                borderWidth: 2,
                borderColor: '#fff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        padding: 20,
                        usePointStyle: true
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = Math.round((value / total) * 100);
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

// Atualizar ranking de atendentes
function updateAgentsRanking(agentsRanking) {
    const $tbody = $('#agents-ranking');
    $tbody.empty();
    
    if (agentsRanking.length === 0) {
        $tbody.html('<tr><td colspan="8" class="text-center text-muted">Nenhum dado encontrado</td></tr>');
        return;
    }
    
    agentsRanking.forEach((agent, index) => {
        const position = index + 1;
        const medal = position <= 3 ? getMedalIcon(position) : position;
        
        const $row = $(`
            <tr>
                <td class="text-center">${medal}</td>
                <td><strong>${agent.name}</strong></td>
                <td><span class="badge bg-info">${agent.sector}</span></td>
                <td>${agent.totalChats}</td>
                <td>${agent.finishedChats}</td>
                <td>
                    <div class="d-flex align-items-center">
                        <div class="progress flex-grow-1 me-2" style="height: 20px;">
                            <div class="progress-bar" style="width: ${agent.efficiency}%"></div>
                        </div>
                        <small>${agent.efficiency}%</small>
                    </div>
                </td>
                <td>${agent.avgTime}min</td>
                <td>${agent.avgWaitTime}min</td>
            </tr>
        `);
        
        $tbody.append($row);
    });
}

// Ícones de medalha para o ranking
function getMedalIcon(position) {
    const medals = {
        1: '<i class="bi bi-trophy-fill text-warning fs-4" title="1º Lugar"></i>',
        2: '<i class="bi bi-award-fill text-secondary fs-4" title="2º Lugar"></i>',
        3: '<i class="bi bi-award-fill text-warning fs-4" title="3º Lugar"></i>'
    };
    return medals[position] || position;
}

// Recarregar avatar de um contato específico
async function refreshContactAvatar(contactId) {
    try {
        if (!currentSession) {
            showNotification('Erro', 'Nenhuma sessão ativa', 'error');
            return;
        }
        
        const contact = contacts.find(c => c.id === contactId);
        if (!contact) return;
        
        // Força atualização do avatar via backend
        await $.post(`/api/contacts/${contactId}/refresh-avatar`, {
            sessionId: currentSession
        });
        
        showNotification('Sucesso', 'Avatar atualizado!', 'success');
        
    } catch (error) {
        console.error('Erro ao atualizar avatar:', error);
        showNotification('Erro', 'Falha ao atualizar avatar', 'error');
    }
}

// Recarregar TODOS os avatars (apenas admin)
async function refreshAllAvatars() {
    if (currentUser.role !== 'admin') {
        showNotification('Erro', 'Apenas administradores podem executar esta ação', 'error');
        return;
    }
    
    if (!confirm('Deseja recarregar TODAS as fotos dos contatos?\n\nIsso pode demorar alguns minutos e usar dados da internet.')) {
        return;
    }
    
    try {
        showNotification('Processando', 'Recarregando fotos... Isso pode demorar alguns minutos.', 'info');
        
        const response = await $.ajax({
            url: '/api/contacts/refresh-all-avatars',
            method: 'POST',
            timeout: 300000 // 5 minutos
        });
        
        showNotification('Sucesso', `${response.updated} fotos atualizadas! ${response.errors} erros.`, 'success');
        
        // Recarregar lista de contatos para ver as fotos
        setTimeout(() => {
            loadContacts();
        }, 2000);
        
    } catch (error) {
        console.error('Erro ao recarregar avatars:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao recarregar fotos';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Exportar dados do dashboard
function exportDashboardData() {
    // TODO: Implementar exportação para Excel/PDF
    showNotification('Info', 'Exportação em desenvolvimento', 'info');
}

// ===========================================
// SISTEMA DE DISPAROS POR TAGS
// ===========================================

// Variáveis globais para campanhas
let campaignsList = [];
let availableCampaignTags = [];
let campaignVariables = {};
let selectedTags = [];
let selectedSectors = [];
let previewContacts = [];
let activeCampaignId = null;

// Mostrar modal de campanhas
function showCampaignsModal() {
    // Verificar permissão
    if (!['admin', 'supervisor'].includes(currentUser.role)) {
        showNotification('Erro', 'Sem permissão para acessar campanhas', 'error');
        return;
    }
    
    $('#campaignsModal').modal('show');
    
    // Carregar dados após modal abrir
    setTimeout(() => {
        loadCampaignsList();
        loadCampaignTags();
        loadCampaignVariables();
        setupCampaignListeners();
    }, 300);
}

// Carregar lista de campanhas
async function loadCampaignsList() {
    try {
        showNotification('Carregando', 'Carregando campanhas...');
        
        const response = await $.get('/api/campaigns');
        campaignsList = response;
        
        renderCampaignsList();
        
        console.log('Campanhas carregadas:', campaignsList.length);
        
    } catch (error) {
        console.error('Erro ao carregar campanhas:', error);
        showNotification('Erro', 'Falha ao carregar campanhas', 'error');
        
        $('#campaigns-list').html(`
            <div class="alert alert-danger">
                <i class="bi bi-exclamation-triangle"></i>
                <strong>Erro ao carregar campanhas</strong>
                <p class="mb-0">Tente recarregar a página ou contate o suporte.</p>
            </div>
        `);
    }
}

// Renderizar lista de campanhas
function renderCampaignsList() {
    const $list = $('#campaigns-list');
    $list.empty();
    
    if (campaignsList.length === 0) {
        $list.html(`
            <div class="empty-campaigns text-center py-5">
                <i class="bi bi-megaphone" style="font-size: 4rem; opacity: 0.3;"></i>
                <h5 class="mt-3 text-muted">Nenhuma campanha criada</h5>
                <p class="text-muted">Crie sua primeira campanha de disparo por tags!</p>
                <button class="btn btn-primary" onclick="showNewCampaignTab()">
                    <i class="bi bi-plus"></i> Criar Primeira Campanha
                </button>
            </div>
        `);
        return;
    }
    
    campaignsList.forEach(campaign => {
        const $campaignCard = createCampaignCard(campaign);
        $list.append($campaignCard);
    });
}

// Criar card de campanha
function createCampaignCard(campaign) {
    const statusIcons = {
        'draft': 'bi-file-earmark',
        'scheduled': 'bi-calendar-event',
        'sending': 'bi-hourglass-split',
        'sent': 'bi-check-circle',
        'cancelled': 'bi-x-circle',
        'paused': 'bi-pause-circle'
    };
    
    const statusColors = {
        'draft': 'secondary',
        'scheduled': 'warning',
        'sending': 'primary',
        'sent': 'success',
        'cancelled': 'danger',
        'paused': 'warning'
    };
    
    const statusLabels = {
        'draft': 'Rascunho',
        'scheduled': 'Agendada',
        'sending': 'Enviando',
        'sent': 'Enviada',
        'cancelled': 'Cancelada',
        'paused': 'Pausada'
    };
    
    const createdDate = new Date(campaign.created_at).toLocaleDateString('pt-BR');
    const scheduledDate = campaign.scheduled_at ? 
        new Date(campaign.scheduled_at).toLocaleString('pt-BR') : null;
    
    // Calcular progresso se houver estatísticas
    let progressHtml = '';
    if (campaign.stats && campaign.total_count > 0) {
        const percentage = Math.round((campaign.stats.sent / campaign.total_count) * 100);
        progressHtml = `
            <div class="progress mt-2" style="height: 6px;">
                <div class="progress-bar bg-success" style="width: ${percentage}%"></div>
            </div>
            <small class="text-muted">
                ${campaign.stats.sent}/${campaign.total_count} enviados
                ${campaign.stats.failed > 0 ? ` • ${campaign.stats.failed} falhas` : ''}
            </small>
        `;
    }
    
    return $(`
        <div class="campaign-card" data-campaign-id="${campaign.id}">
            <div class="card mb-3">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start mb-2">
                        <h6 class="card-title mb-0">${escapeHtml(campaign.name)}</h6>
                        <span class="badge bg-${statusColors[campaign.status]}">
                            <i class="${statusIcons[campaign.status]}"></i>
                            ${statusLabels[campaign.status]}
                        </span>
                    </div>
                    
                    <p class="card-text text-muted small mb-2">
                        ${escapeHtml(campaign.content.substring(0, 100))}${campaign.content.length > 100 ? '...' : ''}
                    </p>
                    
                    <div class="campaign-info small">
                        <div class="row">
                            <div class="col-6">
                                <i class="bi bi-calendar3"></i> ${createdDate}
                                ${scheduledDate ? `<br><i class="bi bi-clock"></i> ${scheduledDate}` : ''}
                            </div>
                            <div class="col-6 text-end">
                                <i class="bi bi-people"></i> ${campaign.total_count} contatos
                                ${campaign.media_url ? '<br><i class="bi bi-paperclip"></i> Com mídia' : ''}
                            </div>
                        </div>
                    </div>
                    
                    ${progressHtml}
                    
                    <div class="campaign-actions mt-3">
                        <div class="btn-group btn-group-sm" role="group">
                            <button class="btn btn-outline-primary" onclick="viewCampaignDetails(${campaign.id})" title="Ver detalhes">
                                <i class="bi bi-eye"></i>
                            </button>
                            
                            ${campaign.status === 'draft' ? `
                                <button class="btn btn-outline-success" onclick="startCampaign(${campaign.id})" title="Iniciar">
                                    <i class="bi bi-play"></i>
                                </button>
                            ` : ''}
                            
                            ${campaign.status === 'sending' ? `
                                <button class="btn btn-outline-warning" onclick="pauseCampaignFromList(${campaign.id})" title="Pausar">
                                    <i class="bi bi-pause"></i>
                                </button>
                            ` : ''}
                            
                            ${campaign.status === 'paused' ? `
                                <button class="btn btn-outline-success" onclick="resumeCampaign(${campaign.id})" title="Retomar">
                                    <i class="bi bi-play"></i>
                                </button>
                            ` : ''}
                            
                            <button class="btn btn-outline-secondary" onclick="duplicateCampaign(${campaign.id})" title="Duplicar">
                                <i class="bi bi-files"></i>
                            </button>
                            
                            ${currentUser.role === 'admin' && ['draft', 'cancelled', 'sent'].includes(campaign.status) ? `
                                <button class="btn btn-outline-danger" onclick="deleteCampaign(${campaign.id})" title="Excluir">
                                    <i class="bi bi-trash"></i>
                                </button>
                            ` : ''}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `);
}

// Carregar tags disponíveis
async function loadCampaignTags() {
    try {
        const response = await $.get('/api/tags');
        availableCampaignTags = response;
        
        renderTagsSelection();
        
    } catch (error) {
        console.error('Erro ao carregar tags:', error);
        $('#tags-selection').html('<p class="text-danger">Erro ao carregar tags</p>');
    }
}

// Renderizar seleção de tags
function renderTagsSelection() {
    const $container = $('#tags-selection');
    $container.empty();
    
    if (availableCampaignTags.length === 0) {
        $container.html(`
            <div class="alert alert-warning">
                <i class="bi bi-exclamation-triangle"></i>
                <strong>Nenhuma tag encontrada</strong>
                <p class="mb-0">Crie tags primeiro para poder fazer disparos direcionados.</p>
            </div>
        `);
        return;
    }
    
    availableCampaignTags.forEach(tag => {
        const $tagCheckbox = $(`
            <div class="form-check form-check-inline tag-checkbox">
                <input class="form-check-input tag-input" type="checkbox" 
                       id="tag-${tag.id}" value="${tag.id}">
                <label class="form-check-label tag-label" for="tag-${tag.id}" 
                       style="background-color: ${tag.color};">
                    ${tag.name}
                </label>
            </div>
        `);
        
        $container.append($tagCheckbox);
    });
}

// Carregar variáveis disponíveis
async function loadCampaignVariables() {
    try {
        const response = await $.get('/api/campaigns/variables');
        campaignVariables = response;
        
        renderVariablesButtons();
        
    } catch (error) {
        console.error('Erro ao carregar variáveis:', error);
    }
}

// Renderizar botões de variáveis
function renderVariablesButtons() {
    const $container = $('#campaign-variables');
    $container.empty();
    
    Object.keys(campaignVariables).forEach(key => {
        const variable = campaignVariables[key];
        
        const $btn = $(`
            <button type="button" class="btn btn-outline-secondary btn-sm me-1 mb-1" 
                    onclick="insertCampaignVariable('${variable.value}')" 
                    title="${variable.description} - Ex: ${variable.example}">
                ${variable.value}
            </button>
        `);
        
        $container.append($btn);
    });
}

// Configurar event listeners
function setupCampaignListeners() {
    // Seleção de tags
    $(document).off('change', '.tag-input').on('change', '.tag-input', function() {
        updateSelectedTags();
    });
    
    // Seleção de setores
    $(document).off('change', '.sector-checkbox').on('change', '.sector-checkbox', function() {
        updateSelectedSectors();
    });
    
    // Preview da mensagem em tempo real
    $(document).off('input', '#campaign-content').on('input', '#campaign-content', updateCampaignMessagePreview);
    
    // Agendamento
    $(document).off('change', 'input[name="schedule-type"]').on('change', 'input[name="schedule-type"]', function() {
        const isScheduled = $(this).val() === 'scheduled';
        $('#schedule-datetime').prop('disabled', !isScheduled);
        
        if (isScheduled) {
            // Definir data mínima como agora + 10 minutos
            const now = new Date();
            now.setMinutes(now.getMinutes() + 10);
            const minDateTime = now.toISOString().slice(0, 16);
            $('#schedule-datetime').attr('min', minDateTime);
        }
    });
    
    // Upload de mídia
    $(document).off('change', '#campaign-media').on('change', '#campaign-media', handleMediaUpload);
    
    // Mostrar/ocultar botões baseado na tab ativa
    $(document).off('shown.bs.tab', '#campaignTabs button').on('shown.bs.tab', '#campaignTabs button', function(e) {
        const activeTab = $(e.target).attr('data-bs-target');
        
        if (activeTab === '#new-campaign-pane') {
            $('#test-campaign-btn, #create-campaign-btn').show();
        } else {
            $('#test-campaign-btn, #create-campaign-btn').hide();
        }
    });
}

// Atualizar tags selecionadas
function updateSelectedTags() {
    selectedTags = [];
    $('.tag-input:checked').each(function() {
        selectedTags.push(parseInt($(this).val()));
    });
    
    console.log('Tags selecionadas:', selectedTags);
    updateContactsPreview();
}

// Atualizar setores selecionados
function updateSelectedSectors() {
    selectedSectors = [];
    $('.sector-checkbox:checked').each(function() {
        selectedSectors.push($(this).val());
    });
    
    console.log('Setores selecionados:', selectedSectors);
    updateContactsPreview();
}

// Atualizar preview de contatos
async function updateContactsPreview() {
    const $preview = $('#contacts-preview');
    const $count = $('#contacts-count');
    
    if (selectedTags.length === 0 && selectedSectors.length === 0) {
        $preview.html(`
            <div class="text-muted text-center py-3">
                <i class="bi bi-people"></i>
                <p class="mb-0">Selecione tags ou setores para ver os contatos</p>
            </div>
        `);
        $count.text('0');
        updateSendInfo(0);
        return;
    }
    
    try {
        $preview.html(`
            <div class="text-center py-2">
                <div class="spinner-border spinner-border-sm" role="status"></div>
                <span class="ms-2">Carregando contatos...</span>
            </div>
        `);
        
        const response = await $.post('/api/campaigns/preview-contacts', {
            tags: selectedTags,
            sectors: selectedSectors
        });
        
        previewContacts = response.contacts;
        const total = response.total;
        
        $count.text(total);
        updateSendInfo(total);
        
        if (total === 0) {
            $preview.html(`
                <div class="alert alert-warning">
                    <i class="bi bi-exclamation-triangle"></i>
                    <strong>Nenhum contato encontrado</strong>
                    <p class="mb-0">Nenhum contato possui as tags/setores selecionados.</p>
                </div>
            `);
            return;
        }
        
        // Mostrar preview dos primeiros contatos
        let previewHtml = `<div class="contacts-preview-list">`;
        
        previewContacts.forEach(contact => {
            const tagsHtml = contact.tags?.map(tag => 
                `<span class="badge me-1" style="background-color: ${tag.color};">${tag.name}</span>`
            ).join('') || '';
            
            previewHtml += `
                <div class="contact-preview-item">
                    <div class="d-flex justify-content-between align-items-center">
                        <div>
                            <strong>${escapeHtml(contact.name || contact.number)}</strong>
                            <div class="small text-muted">${contact.number}</div>
                            ${tagsHtml ? `<div class="mt-1">${tagsHtml}</div>` : ''}
                        </div>
                        <div class="text-muted">
                            <i class="bi bi-whatsapp"></i>
                        </div>
                    </div>
                </div>
            `;
        });
        
        if (total > 10) {
            previewHtml += `
                <div class="text-center text-muted py-2">
                    <small>... e mais ${total - 10} contatos</small>
                </div>
            `;
        }
        
        previewHtml += `</div>`;
        $preview.html(previewHtml);
        
    } catch (error) {
        console.error('Erro ao carregar preview:', error);
        $preview.html(`
            <div class="alert alert-danger">
                <i class="bi bi-exclamation-triangle"></i>
                <strong>Erro ao carregar contatos</strong>
            </div>
        `);
    }
}

// Atualizar informações de envio
function updateSendInfo(totalContacts) {
    $('#total-contacts').text(totalContacts);
    
    if (totalContacts > 0) {
        // Calcular tempo estimado (5 segundos por contato)
        const totalMinutes = Math.ceil((totalContacts * 5) / 60);
        let timeText = '';
        
        if (totalMinutes < 60) {
            timeText = `${totalMinutes} minuto${totalMinutes > 1 ? 's' : ''}`;
        } else {
            const hours = Math.floor(totalMinutes / 60);
            const minutes = totalMinutes % 60;
            timeText = `${hours}h${minutes > 0 ? ` ${minutes}min` : ''}`;
        }
        
        $('#estimated-time').text(timeText);
    } else {
        $('#estimated-time').text('-');
    }
}

// Inserir variável na mensagem
function insertCampaignVariable(variable) {
    const $textarea = $('#campaign-content');
    const textarea = $textarea[0];
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    
    const newValue = value.substring(0, start) + variable + value.substring(end);
    $textarea.val(newValue);
    
    // Posicionar cursor após a variável
    textarea.selectionStart = textarea.selectionEnd = start + variable.length;
    textarea.focus();
    
    updateCampaignMessagePreview();
}

// Atualizar preview da mensagem
function updateCampaignMessagePreview() {
    const message = $('#campaign-content').val();
    const $preview = $('#preview-message-content');
    
    if (!message.trim()) {
        $preview.html('<em class="text-muted">Digite uma mensagem para ver o preview...</em>');
        return;
    }
    
    // Preview simples (sem chamar servidor)
    let preview = message
        .replace(/\{\{nome\}\}/g, 'João Silva')
        .replace(/\{\{saudacao\}\}/g, getSaudacaoAtual())
        .replace(/\{\{telefone\}\}/g, '(11) 99999-9999')
        .replace(/\{\{data\}\}/g, new Date().toLocaleDateString('pt-BR'))
        .replace(/\{\{hora\}\}/g, new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }))
        .replace(/\{\{dia\}\}/g, new Date().toLocaleDateString('pt-BR', { weekday: 'long' }))
        .replace(/\{\{mes\}\}/g, new Date().toLocaleDateString('pt-BR', { month: 'long' }))
        .replace(/\{\{ano\}\}/g, new Date().getFullYear().toString());
    
    // Quebras de linha
    preview = preview.replace(/\n/g, '<br>');
    
    $preview.html(preview);
}

// Obter saudação atual
function getSaudacaoAtual() {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Bom dia';
    if (hour >= 12 && hour < 18) return 'Boa tarde';
    return 'Boa noite';
}

// Handle upload de mídia
function handleMediaUpload() {
    const file = this.files[0];
    const $preview = $('#media-preview');
    
    if (!file) {
        $preview.hide().empty();
        return;
    }
    
    // Verificar tamanho (16MB máximo)
    const maxSize = 16 * 1024 * 1024;
    if (file.size > maxSize) {
        showNotification('Erro', 'Arquivo muito grande! Máximo: 16MB', 'error');
        $(this).val('');
        return;
    }
    
    // Mostrar preview
    const fileType = file.type.split('/')[0];
    let previewHtml = '';
    
    switch (fileType) {
        case 'image':
            const imageUrl = URL.createObjectURL(file);
            previewHtml = `
                <div class="media-preview-item">
                    <img src="${imageUrl}" alt="Preview" style="max-width: 200px; max-height: 150px; border-radius: 8px;">
                    <div class="mt-2">
                        <strong>${file.name}</strong>
                        <div class="text-muted small">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
                    </div>
                </div>
            `;
            break;
            
        case 'video':
            previewHtml = `
                <div class="media-preview-item">
                    <div class="file-icon">
                        <i class="bi bi-play-circle" style="font-size: 3rem; color: #dc3545;"></i>
                    </div>
                    <div class="mt-2">
                        <strong>${file.name}</strong>
                        <div class="text-muted small">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
                    </div>
                </div>
            `;
            break;
            
        case 'audio':
            previewHtml = `
                <div class="media-preview-item">
                    <div class="file-icon">
                        <i class="bi bi-music-note-beamed" style="font-size: 3rem; color: #198754;"></i>
                    </div>
                    <div class="mt-2">
                        <strong>${file.name}</strong>
                        <div class="text-muted small">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
                    </div>
                </div>
            `;
            break;
            
        default:
            previewHtml = `
                <div class="media-preview-item">
                    <div class="file-icon">
                        <i class="bi bi-file-earmark" style="font-size: 3rem; color: #6c757d;"></i>
                    </div>
                    <div class="mt-2">
                        <strong>${file.name}</strong>
                        <div class="text-muted small">${(file.size / 1024 / 1024).toFixed(2)} MB</div>
                    </div>
                </div>
            `;
    }
    
    $preview.html(previewHtml).show();
}

// ===========================================
// FUNÇÕES DE AÇÃO DAS CAMPANHAS
// ===========================================

// Mostrar tab de nova campanha
function showNewCampaignTab() {
    $('#new-campaign-tab').tab('show');
}

// Testar mensagem da campanha
async function testCampaignMessage() {
    const message = $('#campaign-content').val().trim();
    
    if (!message) {
        showNotification('Erro', 'Digite uma mensagem para testar', 'error');
        return;
    }
    
    try {
        showNotification('Testando', 'Processando mensagem...');
        
        // Usar primeiro contato do preview se disponível
        const contactId = previewContacts.length > 0 ? previewContacts[0].id : null;
        
        const response = await $.post('/api/campaigns/test-message', {
            message,
            contactId
        });
        
        // Mostrar resultado em modal ou alert
        const processedMessage = response.processedMessage;
        const usedContact = response.usedContact;
        
        showNotification('Teste Concluído', 'Mensagem processada com sucesso!', 'success');
        
        // Atualizar preview com resultado real
        $('#preview-message-content').html(processedMessage.replace(/\n/g, '<br>'));
        
        console.log('Teste da mensagem:', response);
        
    } catch (error) {
        console.error('Erro ao testar mensagem:', error);
        showNotification('Erro', 'Falha ao testar mensagem', 'error');
    }
}

// Criar campanha
async function createCampaign() {
    try {
        // Validações
        const name = $('#campaign-name').val().trim();
        const content = $('#campaign-content').val().trim();
        const scheduleType = $('input[name="schedule-type"]:checked').val();
        const scheduledAt = $('#schedule-datetime').val();
        
        if (!name) {
            showNotification('Erro', 'Nome da campanha é obrigatório', 'error');
            return;
        }
        
        if (!content) {
            showNotification('Erro', 'Conteúdo da mensagem é obrigatório', 'error');
            return;
        }
        
        if (scheduleType === 'scheduled' && !scheduledAt) {
            showNotification('Erro', 'Data de agendamento é obrigatória', 'error');
            return;
        }
        
        // Coletar tags e setores selecionados DIRETAMENTE dos checkboxes
        const collectedTags = [];
        const collectedSectors = [];
        
        // Coletar tags marcadas
        $('.tag-input:checked').each(function() {
            collectedTags.push(parseInt($(this).val()));
        });
        
        // Coletar setores marcados
        $('.sector-checkbox:checked').each(function() {
            collectedSectors.push($(this).val());
        });
        
        console.log('🔍 FRONTEND: Tags coletadas diretamente:', collectedTags);
        console.log('🔍 FRONTEND: Setores coletados diretamente:', collectedSectors);
        
        // Validação APÓS coletar as tags
        if (collectedTags.length === 0 && collectedSectors.length === 0) {
            showNotification('Erro', 'Selecione pelo menos uma tag ou setor', 'error');
            return;
        }
        
        // Confirmar criação
        const totalContacts = $('#total-contacts').text();
        const confirmMessage = scheduleType === 'now' ? 
            `Confirma o disparo IMEDIATO para ${totalContacts} contatos?` :
            `Confirma o agendamento da campanha para ${totalContacts} contatos?`;
        
        if (!confirm(confirmMessage)) {
            return;
        }
        
        // Preparar FormData com as tags coletadas
        const formData = new FormData();
        formData.append('name', name);
        formData.append('content', content);
        formData.append('target_tags', JSON.stringify(collectedTags));
        formData.append('target_sectors', JSON.stringify(collectedSectors));
        formData.append('schedule_type', scheduleType);
        
        console.log('🔍 FRONTEND: Enviando dados finais:');
        console.log('- collectedTags:', collectedTags);
        console.log('- collectedSectors:', collectedSectors);
        console.log('- target_tags JSON:', JSON.stringify(collectedTags));
        console.log('- target_sectors JSON:', JSON.stringify(collectedSectors));
        
        if (scheduleType === 'scheduled') {
            formData.append('scheduled_at', scheduledAt);
        }
        
        // Adicionar mídia se houver
        const mediaFile = $('#campaign-media')[0].files[0];
        if (mediaFile) {
            formData.append('media', mediaFile);
        }
        
        // Mostrar loading
        const $btn = $('#create-campaign-btn');
        const originalText = $btn.html();
        $btn.html('<span class="spinner-border spinner-border-sm me-2"></span>Criando...')
            .prop('disabled', true);
        
        // Enviar para servidor
        const response = await $.ajax({
            url: '/api/campaigns',
            type: 'POST',
            data: formData,
            processData: false,
            contentType: false,
            timeout: 30000
        });
        
        showNotification('Sucesso', response.message, 'success');
        
        // Se for disparo imediato, mostrar modal de progresso
        if (scheduleType === 'now') {
            activeCampaignId = response.campaignId;
            showProgressModal(response.campaignId, name);
        }
        
        // Limpar formulário
        resetCampaignForm();
        
        // Recarregar lista
        setTimeout(() => {
            loadCampaignsList();
            $('#campaigns-list-tab').tab('show');
        }, 1000);
        
        // Resetar botão
        $btn.html(originalText).prop('disabled', false);
        
    } catch (error) {
        console.error('Erro ao criar campanha:', error);
        
        // Resetar botão
        const $btn = $('#create-campaign-btn');
        $btn.html('<i class="bi bi-send"></i> Criar Campanha').prop('disabled', false);
        
        const errorMsg = error.responseJSON?.error || 'Erro ao criar campanha';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Resetar formulário de campanha
function resetCampaignForm() {
    $('#new-campaign-form')[0].reset();
    $('#campaign-media').val('');
    $('#media-preview').hide().empty();
    $('.tag-input').prop('checked', false);
    $('.sector-checkbox').prop('checked', false);
    $('input[name="schedule-type"][value="now"]').prop('checked', true);
    $('#schedule-datetime').prop('disabled', true);
    
    selectedTags = [];
    selectedSectors = [];
    previewContacts = [];
    
    $('#contacts-count').text('0');
    $('#contacts-preview').html(`
        <div class="text-muted text-center py-3">
            <i class="bi bi-people"></i>
            <p class="mb-0">Selecione tags ou setores para ver os contatos</p>
        </div>
    `);
    
    updateSendInfo(0);
    updateCampaignMessagePreview();
}

// Mostrar modal de progresso
function showProgressModal(campaignId, campaignName) {
    activeCampaignId = campaignId;
    
    $('#progress-campaign-name').text(campaignName);
    $('#progress-bar').css('width', '0%');
    $('#progress-text').text('0%');
    $('#progress-sent').text('0');
    $('#progress-failed').text('0');
    $('#progress-total').text($('#total-contacts').text());
    $('#current-contact-name').text('Preparando...');
    $('#time-remaining').text('Calculando...');
    
    $('#campaignProgressModal').modal('show');
    
    // Iniciar monitoramento
    startProgressMonitoring(campaignId);
}

// Monitorar progresso da campanha
function startProgressMonitoring(campaignId) {
    const progressInterval = setInterval(async () => {
        try {
            const stats = await $.get(`/api/campaigns/${campaignId}/stats`);
            updateProgressDisplay(stats);
            
            // Parar monitoramento se campanha terminou
            if (stats.sent + stats.failed >= stats.total && stats.total > 0) {
                clearInterval(progressInterval);
                
                setTimeout(() => {
                    $('#campaignProgressModal').modal('hide');
                    showNotification('Concluído', 
                        `Campanha finalizada! ${stats.sent} enviados, ${stats.failed} falhas`, 
                        stats.failed === 0 ? 'success' : 'warning'
                    );
                }, 2000);
            }
            
        } catch (error) {
            console.error('Erro ao monitorar progresso:', error);
            clearInterval(progressInterval);
        }
    }, 2000); // Verificar a cada 2 segundos
}

// Atualizar display de progresso
function updateProgressDisplay(stats) {
    const total = parseInt($('#progress-total').text());
    const percentage = total > 0 ? Math.round(((stats.sent + stats.failed) / total) * 100) : 0;
    
    $('#progress-bar').css('width', percentage + '%');
    $('#progress-text').text(percentage + '%');
    $('#progress-sent').text(stats.sent);
    $('#progress-failed').text(stats.failed);
    
    // Calcular tempo restante
    if (stats.sent > 0 && total > 0) {
        const remaining = total - (stats.sent + stats.failed);
        const estimatedMinutes = Math.ceil((remaining * 5) / 60); // 5 segundos por envio
        
        if (estimatedMinutes > 0) {
            $('#time-remaining').text(estimatedMinutes + ' minuto' + (estimatedMinutes > 1 ? 's' : ''));
        } else {
            $('#time-remaining').text('Finalizando...');
        }
    }
}

// Pausar campanha
async function pauseCampaign() {
    if (!activeCampaignId) return;
    
    try {
        await $.post(`/api/campaigns/${activeCampaignId}/pause`);
        showNotification('Pausado', 'Campanha pausada com sucesso!', 'warning');
        
        $('#campaignProgressModal').modal('hide');
        loadCampaignsList();
        
    } catch (error) {
        console.error('Erro ao pausar campanha:', error);
        showNotification('Erro', 'Falha ao pausar campanha', 'error');
    }
}

// Cancelar campanha
async function cancelCampaign() {
    if (!activeCampaignId) return;
    
    if (!confirm('Deseja realmente CANCELAR esta campanha? Esta ação não pode ser desfeita.')) {
        return;
    }
    
    try {
        await $.post(`/api/campaigns/${activeCampaignId}/cancel`);
        showNotification('Cancelado', 'Campanha cancelada!', 'warning');
        
        $('#campaignProgressModal').modal('hide');
        loadCampaignsList();
        
    } catch (error) {
        console.error('Erro ao cancelar campanha:', error);
        showNotification('Erro', 'Falha ao cancelar campanha', 'error');
    }
}

// Iniciar campanha da lista
async function startCampaign(campaignId) {
    try {
        if (!confirm('Deseja iniciar esta campanha agora?')) return;
        
        const response = await $.post(`/api/campaigns/${campaignId}/start`);
        showNotification('Iniciado', response.message, 'success');
        
        // Buscar nome da campanha
        const campaign = campaignsList.find(c => c.id === campaignId);
        if (campaign) {
            showProgressModal(campaignId, campaign.name);
        }
        
        loadCampaignsList();
        
    } catch (error) {
        console.error('Erro ao iniciar campanha:', error);
        showNotification('Erro', 'Falha ao iniciar campanha', 'error');
    }
}

// Pausar campanha da lista
async function pauseCampaignFromList(campaignId) {
    try {
        await $.post(`/api/campaigns/${campaignId}/pause`);
        showNotification('Pausado', 'Campanha pausada!', 'warning');
        loadCampaignsList();
        
    } catch (error) {
        console.error('Erro ao pausar:', error);
        showNotification('Erro', 'Falha ao pausar campanha', 'error');
    }
}

// Retomar campanha pausada
async function resumeCampaign(campaignId) {
    try {
        await $.post(`/api/campaigns/${campaignId}/start`);
        showNotification('Retomado', 'Campanha retomada!', 'success');
        
        const campaign = campaignsList.find(c => c.id === campaignId);
        if (campaign) {
            showProgressModal(campaignId, campaign.name);
        }
        
        loadCampaignsList();
        
    } catch (error) {
        console.error('Erro ao retomar:', error);
        showNotification('Erro', 'Falha ao retomar campanha', 'error');
    }
}

// Ver detalhes da campanha
async function viewCampaignDetails(campaignId) {
    try {
        $('#campaignDetailsModal').modal('show');
        
        const response = await $.get(`/api/campaigns/${campaignId}`);
        const { campaign, stats, logs } = response;
        
        renderCampaignDetails(campaign, stats, logs);
        
    } catch (error) {
        console.error('Erro ao carregar detalhes:', error);
        $('#campaign-details-content').html(`
            <div class="alert alert-danger">
                <i class="bi bi-exclamation-triangle"></i>
                <strong>Erro ao carregar detalhes</strong>
            </div>
        `);
    }
}

// Renderizar detalhes da campanha
function renderCampaignDetails(campaign, stats, logs) {
    const createdDate = new Date(campaign.created_at).toLocaleString('pt-BR');
    const scheduledDate = campaign.scheduled_at ? 
        new Date(campaign.scheduled_at).toLocaleString('pt-BR') : null;
    
    let detailsHtml = `
        <div class="campaign-details">
            <div class="row mb-4">
                <div class="col-md-6">
                    <h6><i class="bi bi-info-circle"></i> Informações Gerais</h6>
                    <table class="table table-sm">
                        <tr><td><strong>Nome:</strong></td><td>${escapeHtml(campaign.name)}</td></tr>
                        <tr><td><strong>Status:</strong></td><td><span class="badge bg-primary">${campaign.status}</span></td></tr>
                        <tr><td><strong>Criado em:</strong></td><td>${createdDate}</td></tr>
                        ${scheduledDate ? `<tr><td><strong>Agendado para:</strong></td><td>${scheduledDate}</td></tr>` : ''}
                        <tr><td><strong>Total de contatos:</strong></td><td>${campaign.total_count}</td></tr>
                    </table>
                </div>
                <div class="col-md-6">
                    <h6><i class="bi bi-graph-up"></i> Estatísticas</h6>
                    <div class="row text-center">
                        <div class="col-3">
                            <div class="stat-number text-success">${stats.sent}</div>
                            <div class="stat-label">Enviados</div>
                        </div>
                        <div class="col-3">
                            <div class="stat-number text-danger">${stats.failed}</div>
                            <div class="stat-label">Falhas</div>
                        </div>
                        <div class="col-3">
                            <div class="stat-number text-info">${stats.delivered}</div>
                            <div class="stat-label">Entregues</div>
                        </div>
                        <div class="col-3">
                            <div class="stat-number text-warning">${stats.pending}</div>
                            <div class="stat-label">Pendentes</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="mb-4">
                <h6><i class="bi bi-chat-text"></i> Mensagem</h6>
                <div class="message-content">
                    ${escapeHtml(campaign.content).replace(/\n/g, '<br>')}
                </div>
                ${campaign.media_url ? `
                    <div class="mt-2">
                        <i class="bi bi-paperclip"></i> 
                        <a href="${campaign.media_url}" target="_blank">Ver mídia anexa</a>
                    </div>
                ` : ''}
            </div>
    `;
    
    // Logs recentes
    if (logs.length > 0) {
        detailsHtml += `
            <div class="mb-4">
                <h6><i class="bi bi-list"></i> Logs Recentes (${logs.length} últimos)</h6>
                <div class="logs-container" style="max-height: 300px; overflow-y: auto;">
                    <table class="table table-sm">
                        <thead>
                            <tr>
                                <th>Contato</th>
                                <th>Status</th>
                                <th>Data</th>
                                <th>Erro</th>
                            </tr>
                        </thead>
                        <tbody>
        `;
        
        logs.forEach(log => {
            const logDate = new Date(log.sent_at || log.created_at).toLocaleString('pt-BR');
            const statusColors = {
                'sent': 'success',
                'failed': 'danger',
                'delivered': 'info',
                'pending': 'warning'
            };
            
            detailsHtml += `
                <tr>
                    <td>${escapeHtml(log.contact_name || log.contact_number)}</td>
                    <td><span class="badge bg-${statusColors[log.status] || 'secondary'}">${log.status}</span></td>
                    <td>${logDate}</td>
                    <td>${log.error_message ? `<small class="text-danger">${escapeHtml(log.error_message)}</small>` : '-'}</td>
                </tr>
            `;
        });
        
        detailsHtml += `
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }
    
    detailsHtml += `</div>`;
    
    $('#campaign-details-content').html(detailsHtml);
    
    // Ações baseadas no status
    let actionsHtml = '';
    
    if (campaign.status === 'draft') {
        actionsHtml += `<button class="btn btn-success me-2" onclick="startCampaign(${campaign.id}); $('#campaignDetailsModal').modal('hide');">
            <i class="bi bi-play"></i> Iniciar
        </button>`;
    }
    
    if (campaign.status === 'sending') {
        actionsHtml += `<button class="btn btn-warning me-2" onclick="pauseCampaignFromList(${campaign.id}); $('#campaignDetailsModal').modal('hide');">
            <i class="bi bi-pause"></i> Pausar
        </button>`;
    }
    
    actionsHtml += `<button class="btn btn-outline-secondary me-2" onclick="duplicateCampaign(${campaign.id}); $('#campaignDetailsModal').modal('hide');">
        <i class="bi bi-files"></i> Duplicar
    </button>`;
    
    if (currentUser.role === 'admin' && ['draft', 'cancelled', 'sent'].includes(campaign.status)) {
        actionsHtml += `<button class="btn btn-outline-danger" onclick="deleteCampaign(${campaign.id}); $('#campaignDetailsModal').modal('hide');">
            <i class="bi bi-trash"></i> Excluir
        </button>`;
    }
    
    $('#campaign-detail-actions').html(actionsHtml);
}

// Duplicar campanha
async function duplicateCampaign(campaignId) {
    try {
        const response = await $.post(`/api/campaigns/${campaignId}/duplicate`);
        showNotification('Sucesso', response.message, 'success');
        loadCampaignsList();
        
    } catch (error) {
        console.error('Erro ao duplicar:', error);
        showNotification('Erro', 'Falha ao duplicar campanha', 'error');
    }
}

// Excluir campanha
async function deleteCampaign(campaignId) {
    const campaign = campaignsList.find(c => c.id === campaignId);
    
    if (!confirm(`Deseja realmente EXCLUIR a campanha "${campaign?.name}"?\n\nEsta ação não pode ser desfeita!`)) {
        return;
    }
    
    try {
        const response = await $.ajax({
            url: `/api/campaigns/${campaignId}`,
            method: 'DELETE'
        });
        
        showNotification('Excluído', response.message, 'success');
        loadCampaignsList();
        
    } catch (error) {
        console.error('Erro ao excluir:', error);
        showNotification('Erro', 'Falha ao excluir campanha', 'error');
    }
}

// ===========================================
// SOCKET.IO - EVENTOS EM TEMPO REAL
// ===========================================

// Adicionar eventos de campanha no socket existente
if (typeof socket !== 'undefined' && socket) {
    // Progresso da campanha
    socket.on('campaign:progress', (data) => {
        if (data.campaignId === activeCampaignId) {
            updateProgressDisplay({
                sent: data.sent,
                failed: data.failed,
                total: data.total
            });
        }
    });
    
    // Campanha concluída
    socket.on('campaign:completed', (data) => {
        if (data.campaignId === activeCampaignId) {
            setTimeout(() => {
                $('#campaignProgressModal').modal('hide');
                showNotification('Concluído', 
                    `Campanha finalizada! ${data.sent} enviados, ${data.failed} falhas`, 
                    data.failed === 0 ? 'success' : 'warning'
                );
                loadCampaignsList();
            }, 2000);
        }
    });
    
    // Campanha travada
    socket.on('campaign:stuck', (data) => {
        if (data.campaignId === activeCampaignId) {
            $('#campaignProgressModal').modal('hide');
            showNotification('Cancelado', data.message, 'warning');
            loadCampaignsList();
        }
    });
}

// Event listeners para o dashboard
$(document).on('change', '#dashboard-period, #dashboard-sector', loadDashboardData);

// ===========================================
// SISTEMA DE HORÁRIO COMERCIAL
// ===========================================

// Variáveis globais para horário comercial
let businessHoursSettings = null;
let businessHoursStatus = null;

// Mostrar configurações de horário comercial
function showBusinessHoursSettings() {
    // Verificar permissão
    if (!['admin', 'supervisor'].includes(currentUser.role)) {
        showNotification('Erro', 'Sem permissão para acessar configurações', 'error');
        return;
    }
    
    $('#businessHoursModal').modal('show');
    
    // Carregar configurações após modal abrir
    setTimeout(() => {
        loadBusinessHoursSettings();
        refreshBusinessStatus();
    }, 300);
}

// Carregar configurações do servidor
async function loadBusinessHoursSettings() {
    try {
        showNotification('Carregando', 'Carregando configurações...');
        
        const response = await $.get('/api/business-hours/settings');
        businessHoursSettings = response;
        
        // Preencher formulário
        populateBusinessHoursForm(response);
        updateSchedulePreview();
        
        console.log('Configurações carregadas:', response);
        
    } catch (error) {
        console.error('Erro ao carregar configurações:', error);
        showNotification('Erro', 'Falha ao carregar configurações', 'error');
    }
}

// Preencher formulário com dados do servidor
function populateBusinessHoursForm(settings) {
    // Habilitar/desabilitar sistema
    $('#business-hours-enabled').prop('checked', settings.enabled || false);
    
    // Horários da semana
    const schedule = settings.schedule || {};
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    
    days.forEach(day => {
        const dayData = schedule[day] || { enabled: false, start: '08:00', end: '18:00' };
        
        $(`#${day}-enabled`).prop('checked', dayData.enabled || false);
        $(`#${day}-start`).val(dayData.start || '08:00');
        $(`#${day}-end`).val(dayData.end || '18:00');
        
        // Habilitar/desabilitar campos de hora
        toggleDayInputs(day, dayData.enabled);
    });
    
    // Mensagem
    $('#business-hours-message').val(settings.message || '');
    updateMessagePreview();
    
    // Feriados e exceções
    populateHolidays(settings.holidays || []);
    populateExceptions(settings.exceptions || []);
    
    // Configurar listeners
    setupBusinessHoursListeners();
}

// Configurar event listeners
function setupBusinessHoursListeners() {
    // Toggle dias da semana
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    days.forEach(day => {
        $(`#${day}-enabled`).off('change').on('change', function() {
            toggleDayInputs(day, $(this).is(':checked'));
            updateSchedulePreview();
        });
        
        $(`#${day}-start, #${day}-end`).off('change').on('change', updateSchedulePreview);
    });
    
    // Preview da mensagem em tempo real
    $('#business-hours-message').off('input').on('input', updateMessagePreview);
    
    // Toggle sistema geral
    $('#business-hours-enabled').off('change').on('change', function() {
        const enabled = $(this).is(':checked');
        $('.schedule-container')[enabled ? 'removeClass' : 'addClass']('disabled-section');
    });
}

// Habilitar/desabilitar campos de horário
function toggleDayInputs(day, enabled) {
    $(`#${day}-start, #${day}-end`).prop('disabled', !enabled);
    $(`.day-schedule:has(#${day}-enabled)`)[enabled ? 'removeClass' : 'addClass']('disabled-day');
}

// Atualizar preview dos horários
function updateSchedulePreview() {
    const $preview = $('#schedule-preview');
    let previewHtml = '<div class="schedule-summary">';
    
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const dayNames = {
        monday: 'Segunda-feira',
        tuesday: 'Terça-feira',
        wednesday: 'Quarta-feira',
        thursday: 'Quinta-feira',
        friday: 'Sexta-feira',
        saturday: 'Sábado',
        sunday: 'Domingo'
    };
    
    days.forEach(day => {
        const enabled = $(`#${day}-enabled`).is(':checked');
        const start = $(`#${day}-start`).val();
        const end = $(`#${day}-end`).val();
        
        const statusClass = enabled ? 'text-success' : 'text-muted';
        const statusIcon = enabled ? '🟢' : '🔴';
        const timeText = enabled ? `${start} às ${end}` : 'Fechado';
        
        previewHtml += `
            <div class="schedule-item ${statusClass}">
                ${statusIcon} <strong>${dayNames[day]}:</strong> ${timeText}
            </div>
        `;
    });
    
    previewHtml += '</div>';
    $preview.html(previewHtml);
}

// Atualizar preview da mensagem
function updateMessagePreview() {
    const message = $('#business-hours-message').val();
    const $preview = $('#preview-content');
    
    if (!message.trim()) {
        $preview.html('<em class="text-muted">Digite uma mensagem para ver o preview...</em>');
        return;
    }
    
    // Preview simples (sem processar variáveis do servidor)
    let preview = message
        .replace(/\{\{horarios\}\}/g, 'Segunda: 8h às 18h\nTerça: 8h às 18h\n...')
        .replace(/\{\{proximo_funcionamento\}\}/g, 'Segunda-feira às 08:00')
        .replace(/\{\{data_atual\}\}/g, new Date().toLocaleDateString('pt-BR'))
        .replace(/\{\{hora_atual\}\}/g, new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
    
    // Quebras de linha
    preview = preview.replace(/\n/g, '<br>');
    
    $preview.html(preview);
}

// Templates de horário
function setScheduleTemplate(template) {
    const templates = {
        commercial: {
            monday: { enabled: true, start: '08:00', end: '18:00' },
            tuesday: { enabled: true, start: '08:00', end: '18:00' },
            wednesday: { enabled: true, start: '08:00', end: '18:00' },
            thursday: { enabled: true, start: '08:00', end: '18:00' },
            friday: { enabled: true, start: '08:00', end: '18:00' },
            saturday: { enabled: true, start: '08:00', end: '12:00' },
            sunday: { enabled: false, start: '08:00', end: '18:00' }
        },
        extended: {
            monday: { enabled: true, start: '08:00', end: '20:00' },
            tuesday: { enabled: true, start: '08:00', end: '20:00' },
            wednesday: { enabled: true, start: '08:00', end: '20:00' },
            thursday: { enabled: true, start: '08:00', end: '20:00' },
            friday: { enabled: true, start: '08:00', end: '20:00' },
            saturday: { enabled: true, start: '08:00', end: '20:00' },
            sunday: { enabled: false, start: '08:00', end: '18:00' }
        },
        closed: {
            monday: { enabled: false, start: '08:00', end: '18:00' },
            tuesday: { enabled: false, start: '08:00', end: '18:00' },
            wednesday: { enabled: false, start: '08:00', end: '18:00' },
            thursday: { enabled: false, start: '08:00', end: '18:00' },
            friday: { enabled: false, start: '08:00', end: '18:00' },
            saturday: { enabled: false, start: '08:00', end: '18:00' },
            sunday: { enabled: false, start: '08:00', end: '18:00' }
        }
    };
    
    const selectedTemplate = templates[template];
    if (!selectedTemplate) return;
    
    // Aplicar template
    Object.keys(selectedTemplate).forEach(day => {
        const dayData = selectedTemplate[day];
        
        $(`#${day}-enabled`).prop('checked', dayData.enabled);
        $(`#${day}-start`).val(dayData.start);
        $(`#${day}-end`).val(dayData.end);
        
        toggleDayInputs(day, dayData.enabled);
    });
    
    updateSchedulePreview();
    
    const templateNames = {
        commercial: 'Comercial',
        extended: 'Estendido',
        closed: 'Tudo Fechado'
    };
    
    showNotification('Template Aplicado', `Template "${templateNames[template]}" aplicado!`, 'success');
}

// Inserir variável na mensagem
function insertBusinessVariable(variable) {
    const $textarea = $('#business-hours-message');
    const textarea = $textarea[0];
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    
    const newValue = value.substring(0, start) + variable + value.substring(end);
    $textarea.val(newValue);
    
    // Posicionar cursor após a variável
    textarea.selectionStart = textarea.selectionEnd = start + variable.length;
    textarea.focus();
    
    updateMessagePreview();
}

// Testar mensagem no servidor
async function testBusinessMessage() {
    const message = $('#business-hours-message').val().trim();
    
    if (!message) {
        showNotification('Erro', 'Digite uma mensagem para testar', 'error');
        return;
    }
    
    try {
        showNotification('Testando', 'Processando mensagem...');
        
        const response = await $.post('/api/business-hours/test-message', { message });
        
        // Mostrar resultado
        $('#test-result').show();
        $('#test-output').text(response.processedMessage);
        
        showNotification('Sucesso', 'Mensagem testada com sucesso!', 'success');
        
    } catch (error) {
        console.error('Erro ao testar mensagem:', error);
        showNotification('Erro', 'Falha ao testar mensagem', 'error');
    }
}

// Restaurar mensagem padrão
function resetDefaultMessage() {
    if (!confirm('Deseja restaurar a mensagem padrão? Isso irá sobrescrever a mensagem atual.')) {
        return;
    }
    
    const defaultMessage = `Olá! Nossa farmácia está fechada no momento. 🏪

📅 Horário de funcionamento:
{{horarios}}

Sua mensagem foi registrada e responderemos assim que possível. Para emergências, ligue para (11) 99999-9999.

Próximo funcionamento: {{proximo_funcionamento}}`;
    
    $('#business-hours-message').val(defaultMessage);
    updateMessagePreview();
    
    showNotification('Restaurado', 'Mensagem padrão restaurada!', 'success');
}

// Adicionar feriado
function addHoliday() {
    const date = $('#holiday-date').val();
    const name = $('#holiday-name').val().trim();
    
    if (!date || !name) {
        showNotification('Erro', 'Preencha data e nome do feriado', 'error');
        return;
    }
    
    // Verificar duplicatas
    if (businessHoursSettings.holidays.some(h => h.date === date)) {
        showNotification('Erro', 'Já existe um feriado nesta data', 'error');
        return;
    }
    
    businessHoursSettings.holidays.push({ date, name });
    populateHolidays(businessHoursSettings.holidays);
    
    // Limpar campos
    $('#holiday-date').val('');
    $('#holiday-name').val('');
    
    showNotification('Adicionado', `Feriado "${name}" adicionado!`, 'success');
}

// Adicionar exceção de horário
function addException() {
    const date = $('#exception-date').val();
    const start = $('#exception-start').val();
    const end = $('#exception-end').val();
    
    if (!date || !start || !end) {
        showNotification('Erro', 'Preencha todos os campos da exceção', 'error');
        return;
    }
    
    if (start >= end) {
        showNotification('Erro', 'Horário de início deve ser menor que o fim', 'error');
        return;
    }
    
    // Verificar duplicatas
    if (businessHoursSettings.exceptions.some(e => e.date === date)) {
        showNotification('Erro', 'Já existe uma exceção para esta data', 'error');
        return;
    }
    
    businessHoursSettings.exceptions.push({ 
        date, 
        start, 
        end, 
        enabled: true 
    });
    populateExceptions(businessHoursSettings.exceptions);
    
    // Limpar campos
    $('#exception-date').val('');
    $('#exception-start').val('08:00');
    $('#exception-end').val('14:00');
    
    showNotification('Adicionado', 'Exceção de horário adicionada!', 'success');
}

// Popular lista de feriados
function populateHolidays(holidays) {
    const $container = $('#holidays-list');
    $container.empty();
    
    if (holidays.length === 0) {
        $container.html('<p class="text-muted"><em>Nenhum feriado cadastrado</em></p>');
        return;
    }
    
    holidays.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    holidays.forEach((holiday, index) => {
        const formattedDate = new Date(holiday.date + 'T00:00:00').toLocaleDateString('pt-BR');
        
        const $item = $(`
            <div class="exception-item">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <strong>${holiday.name}</strong>
                        <div class="text-muted small">${formattedDate}</div>
                    </div>
                    <button class="btn btn-sm btn-outline-danger" onclick="removeHoliday(${index})" title="Remover">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
        `);
        
        $container.append($item);
    });
}

// Popular lista de exceções
function populateExceptions(exceptions) {
    const $container = $('#exceptions-list');
    $container.empty();
    
    if (exceptions.length === 0) {
        $container.html('<p class="text-muted"><em>Nenhuma exceção cadastrada</em></p>');
        return;
    }
    
    exceptions.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    exceptions.forEach((exception, index) => {
        const formattedDate = new Date(exception.date + 'T00:00:00').toLocaleDateString('pt-BR');
        
        const $item = $(`
            <div class="exception-item">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <strong>${formattedDate}</strong>
                        <div class="text-muted small">${exception.start} às ${exception.end}</div>
                    </div>
                    <button class="btn btn-sm btn-outline-danger" onclick="removeException(${index})" title="Remover">
                        <i class="bi bi-trash"></i>
                    </button>
                </div>
            </div>
        `);
        
        $container.append($item);
    });
}

// Remover feriado
function removeHoliday(index) {
    if (!confirm('Deseja remover este feriado?')) return;
    
    businessHoursSettings.holidays.splice(index, 1);
    populateHolidays(businessHoursSettings.holidays);
    
    showNotification('Removido', 'Feriado removido!', 'success');
}

// Remover exceção
function removeException(index) {
    if (!confirm('Deseja remover esta exceção?')) return;
    
    businessHoursSettings.exceptions.splice(index, 1);
    populateExceptions(businessHoursSettings.exceptions);
    
    showNotification('Removido', 'Exceção removida!', 'success');
}

// Salvar configurações
async function saveBusinessHoursSettings() {
    try {
        // Validar se é admin
        if (currentUser.role !== 'admin') {
            showNotification('Erro', 'Apenas administradores podem salvar configurações', 'error');
            return;
        }
        
        showNotification('Salvando', 'Salvando configurações...');
        
        // Coletar dados do formulário
    const enabled = $('#business-hours-enabled').is(':checked');
    const message = $('#business-hours-message').val().trim();
    
    if (!message) {
      showNotification('Erro', 'Mensagem não pode estar vazia', 'error');
      return;
    }
    
    // Coletar horários
    const schedule = {};
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    
    days.forEach(day => {
      schedule[day] = {
        enabled: $(`#${day}-enabled`).is(':checked'),
        start: $(`#${day}-start`).val(),
        end: $(`#${day}-end`).val()
      };
    });
    
    // DEBUG: Verificar tags e setores coletados
    console.log('🔍 FRONTEND: Tags selecionadas:', selectedTags);
    console.log('🔍 FRONTEND: Setores selecionados:', selectedSectors);
    
    // Dados para enviar
    const data = {
      enabled,
      schedule,
      message,
      holidays: businessHoursSettings?.holidays || [],
      exceptions: businessHoursSettings?.exceptions || []
    };
        
        console.log('Salvando configurações:', data);
        
        // Enviar para servidor
        const response = await $.ajax({
  url: '/api/business-hours/settings',
  method: 'POST',
  data: JSON.stringify(data),      // <- serializa para JSON
  contentType: 'application/json', // <- avisa o servidor
  processData: false               // <- impede jQuery de alterar o corpo
});
        
        showNotification('Sucesso', 'Configurações salvas com sucesso!', 'success');
        
        // Atualizar status
        setTimeout(() => {
            refreshBusinessStatus();
        }, 1000);
        
    } catch (error) {
        console.error('Erro ao salvar:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao salvar configurações';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Atualizar status do horário comercial
async function refreshBusinessStatus() {
    try {
        const response = await $.get('/api/business-hours/status');
        businessHoursStatus = response;
        
        // Atualizar interface
        updateBusinessStatusDisplay(response);
        
    } catch (error) {
        console.error('Erro ao obter status:', error);
        $('#status-title').text('Erro ao verificar status');
        $('#status-description').text('Falha na conexão com o servidor');
    }
}

// Atualizar display do status
function updateBusinessStatusDisplay(status) {
    const $alert = $('#business-status-alert');
    const $indicator = $('#status-indicator');
    const $title = $('#status-title');
    const $description = $('#status-description');
    
    if (status.enabled) {
        if (status.isBusinessTime) {
            $alert.removeClass('alert-warning alert-danger').addClass('alert-success');
            $indicator.html('<i class="bi bi-check-circle-fill text-success"></i>');
            $title.text('🟢 Farmácia ABERTA');
            $description.text(`Horário comercial ativo - ${status.currentTime}`);
        } else {
            $alert.removeClass('alert-success alert-danger').addClass('alert-warning');
            $indicator.html('<i class="bi bi-clock-fill text-warning"></i>');
            $title.text('🟡 Farmácia FECHADA');
            
            let nextInfo = 'Verificando próximo horário...';
            if (status.nextBusinessHours) {
                nextInfo = `Próximo funcionamento: ${status.nextBusinessHours.dayName} às ${status.nextBusinessHours.start}`;
            }
            $description.text(`Auto-resposta ativa - ${nextInfo}`);
        }
    } else {
        $alert.removeClass('alert-success alert-warning').addClass('alert-info');
        $indicator.html('<i class="bi bi-info-circle-fill text-info"></i>');
        $title.text('ℹ️ Sistema DESABILITADO');
        $description.text('Auto-resposta de horário comercial desabilitada - Sempre considera como aberto');
    }
}

// Funções placeholder para botões da sessão (implementar futuramente)
function addNumberToSession(sessionId, sessionName) {
    alert('Função em desenvolvimento: Adicionar número à sessão');
}

function showSessionNumbers(sessionId) {
    alert('Função em desenvolvimento: Mostrar números da sessão');
}

function openMedia(url) {
    window.open(url, '_blank');
}

// Função para abrir localização no mapa
function openLocation(locationText) {
    try {
        // Extrair coordenadas do texto
        const latMatch = locationText.match(/Latitude:\s*([-\d.]+)/);
        const lngMatch = locationText.match(/Longitude:\s*([-\d.]+)/);
        
        if (latMatch && lngMatch) {
            const lat = latMatch[1];
            const lng = lngMatch[1];
            
            // Abrir no Google Maps
            const mapsUrl = `https://www.google.com/maps?q=${lat},${lng}`;
            window.open(mapsUrl, '_blank');
        } else {
            showNotification('Erro', 'Coordenadas não encontradas na mensagem', 'error');
        }
    } catch (error) {
        console.error('Erro ao abrir localização:', error);
        showNotification('Erro', 'Erro ao processar localização', 'error');
    }
}

// ===========================================
// SISTEMA DE ENQUETES/POLLS
// ===========================================

// Mostrar modal de criar enquete
function showPollModal() {
    if (!currentContact) {
        showNotification('Erro', 'Selecione um contato primeiro', 'error');
        return;
    }
    
    if (!currentSession) {
        showNotification('Erro', 'Nenhuma sessão WhatsApp ativa', 'error');
        return;
    }
    
    // Limpar formulário
    $('#poll-question').val('');
    $('#poll-options').val('');
    $('#poll-type').val('single');
    updatePollPreview();
    
    $('#pollModal').modal('show');
}

// Atualizar preview da enquete em tempo real
function updatePollPreview() {
    const question = $('#poll-question').val().trim();
    const optionsText = $('#poll-options').val().trim();
    const type = $('#poll-type').val();
    const $preview = $('#poll-preview');
    
    if (!question && !optionsText) {
        $preview.html('<div class="text-muted">Digite a pergunta e opções para ver o preview...</div>');
        return;
    }
    
    const options = optionsText.split('\n').filter(opt => opt.trim());
    
    let previewHtml = '<div class="poll-preview-content">';
    
    if (question) {
        previewHtml += `<div class="poll-question"><strong>📊 ${escapeHtml(question)}</strong></div>`;
    }
    
    if (options.length > 0) {
        previewHtml += '<div class="poll-options mt-2">';
        options.forEach((option, index) => {
            const emoji = type === 'single' ? '🔘' : '☐';
            previewHtml += `<div class="poll-option">${emoji} ${index + 1}. ${escapeHtml(option)}</div>`;
        });
        previewHtml += '</div>';
        
        previewHtml += `<div class="poll-instructions mt-2">`;
        previewHtml += `<small class="text-muted"><em>Responda com o número da opção`;
        if (type === 'multiple') {
            previewHtml += ' (pode escolher várias separadas por vírgula)';
        }
        previewHtml += '</em></small></div>';
    }
    
    previewHtml += '</div>';
    
    $preview.html(previewHtml);
}

// Enviar enquete
async function sendPoll() {
    const question = $('#poll-question').val().trim();
    const optionsText = $('#poll-options').val().trim();
    const type = $('#poll-type').val();
    
    if (!question) {
        showNotification('Erro', 'Digite a pergunta da enquete', 'error');
        return;
    }
    
    const options = optionsText.split('\n').filter(opt => opt.trim());
    
    if (options.length < 2) {
        showNotification('Erro', 'Adicione pelo menos 2 opções', 'error');
        return;
    }
    
    if (options.length > 10) {
        showNotification('Erro', 'Máximo de 10 opções permitidas', 'error');
        return;
    }
    
    if (!currentContact) {
        showNotification('Erro', 'Selecione um contato primeiro', 'error');
        return;
    }
    
    if (!currentSession) {
        showNotification('Erro', 'Nenhuma sessão WhatsApp ativa', 'error');
        return;
    }
    
    try {
        // Fechar modal
        $('#pollModal').modal('hide');
        
        // Mostrar loading
        showNotification('Criando', 'Criando enquete...');
        
        // Criar enquete no banco de dados
        const pollData = await $.post('/api/polls', {
            contactId: currentContact.id,
            question: question,
            options: options,
            pollType: type,
            expiresIn: 24 // 24 horas para expirar
        });
        
        if (!pollData.success) {
            throw new Error(pollData.error || 'Erro ao criar enquete');
        }
        
        // Formatar mensagem da enquete
        let pollMessage = `📊 *${question}*\n\n`;
        
        options.forEach((option, index) => {
            const emoji = type === 'single' ? '🔘' : '☐';
            const number = index + 1;
            pollMessage += `${emoji} ${number}. ${option}\n`;
        });
        
        pollMessage += `\n_Responda com o número da opção${type === 'multiple' ? ' (pode escolher várias separadas por vírgula)' : ''}_`;
        pollMessage += `\n\n⏰ _Esta enquete expira em 24 horas_`;
        
        // Enviar mensagem via WhatsApp
        const result = await $.post('/api/messages/send', {
            sessionId: currentSession,
            contactId: currentContact.id,
            content: pollMessage,
            type: 'text'
        });
        
        if (result.success) {
            showNotification('Sucesso', 'Enquete enviada!', 'success');
            
            // Adicionar mensagem à conversa atual
            const tempMessage = {
                id: result.messageId,
                content: pollMessage,
                type: 'text',
                is_from_me: true,
                created_at: new Date(),
                user_name: currentUser.name,
                status: 'sent'
            };
            
            messages.push(tempMessage);
            renderMessages();
            scrollToBottom();
        } else {
            throw new Error(result.error || 'Erro ao enviar mensagem');
        }
        
    } catch (error) {
        console.error('Erro ao enviar enquete:', error);
        showNotification('Erro', 'Falha ao enviar enquete: ' + error.message, 'error');
    }
}

// Mostrar enquetes criadas
function showMyPolls() {
    $('#myPollsModal').modal('show');
    loadMyPolls();
}

// Carregar minhas enquetes
async function loadMyPolls() {
    try {
        const polls = await $.get('/api/polls/my');
        renderMyPolls(polls);
        
    } catch (error) {
        console.error('Erro ao carregar enquetes:', error);
        showNotification('Erro', 'Falha ao carregar enquetes', 'error');
    }
}

// Renderizar lista de enquetes
function renderMyPolls(polls) {
    const $list = $('#my-polls-list');
    $list.empty();
    
    if (polls.length === 0) {
        $list.html(`
            <div class="text-center py-4">
                <i class="bi bi-ui-checks" style="font-size: 3rem; opacity: 0.3;"></i>
                <h5 class="mt-3 text-muted">Nenhuma enquete criada</h5>
                <p class="text-muted">Crie sua primeira enquete em uma conversa!</p>
            </div>
        `);
        return;
    }
    
    polls.forEach(poll => {
        const createdDate = new Date(poll.created_at).toLocaleString('pt-BR');
        const statusColor = poll.status === 'active' ? 'success' : poll.status === 'expired' ? 'warning' : 'secondary';
        const statusText = poll.status === 'active' ? 'Ativa' : poll.status === 'expired' ? 'Expirada' : 'Fechada';
        
        const $pollItem = $(`
            <div class="poll-item card mb-3">
                <div class="card-body">
                    <div class="d-flex justify-content-between align-items-start">
                        <div>
                            <h6 class="card-title">${escapeHtml(poll.question)}</h6>
                            <p class="text-muted small mb-2">
                                Criada em: ${createdDate}<br>
                                ${poll.options.length} opções • ${poll.responsesCount || 0} respostas
                            </p>
                        </div>
                        <span class="badge bg-${statusColor}">${statusText}</span>
                    </div>
                    <div class="poll-actions">
                        <button class="btn btn-sm btn-outline-primary" onclick="viewPollDetails(${poll.id})">
                            <i class="bi bi-eye"></i> Ver Resultados
                        </button>
                        ${poll.status === 'active' ? `
                            <button class="btn btn-sm btn-outline-warning" onclick="closePoll(${poll.id})">
                                <i class="bi bi-stop-circle"></i> Fechar
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `);
        
        $list.append($pollItem);
    });
}

// Ver detalhes da enquete
async function viewPollDetails(pollId) {
    try {
        const response = await $.get(`/api/polls/${pollId}`);
        showPollResults(response);
        
    } catch (error) {
        console.error('Erro ao carregar detalhes da enquete:', error);
        showNotification('Erro', 'Falha ao carregar detalhes', 'error');
    }
}

// Mostrar resultados da enquete
function showPollResults(data) {
    const { poll, responses, stats } = data;
    
    $('#pollResultsModal').modal('show');
    $('#poll-results-question').text(poll.question);
    $('#poll-results-total').text(stats.totalResponses);
    
    const $results = $('#poll-results-details');
    $results.empty();
    
    // Mostrar estatísticas por opção
    Object.keys(stats.optionCounts).forEach(key => {
        const option = stats.optionCounts[key];
        
        const $optionResult = $(`
            <div class="option-result mb-3">
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <span><strong>${key}. ${escapeHtml(option.option)}</strong></span>
                    <span class="text-muted">${option.count} votos (${option.percentage}%)</span>
                </div>
                <div class="progress">
                    <div class="progress-bar" role="progressbar" style="width: ${option.percentage}%">
                    </div>
                </div>
            </div>
        `);
        
        $results.append($optionResult);
    });
    
    // Mostrar respostas individuais
    if (responses.length > 0) {
        $results.append('<hr><h6>Respostas:</h6>');
        
        responses.forEach(response => {
            const responseDate = new Date(response.created_at).toLocaleString('pt-BR');
            const selectedOptions = response.selected_options.map(index => 
                `${index}. ${poll.options[index - 1]}`
            ).join(', ');
            
            const $responseItem = $(`
                <div class="response-item mb-2 p-2 border rounded">
                    <div class="d-flex justify-content-between">
                        <strong>${escapeHtml(response.contact_name || response.contact_number)}</strong>
                        <small class="text-muted">${responseDate}</small>
                    </div>
                    <div class="text-primary">${escapeHtml(selectedOptions)}</div>
                </div>
            `);
            
            $results.append($responseItem);
        });
    }
}

// Fechar enquete
async function closePoll(pollId) {
    if (!confirm('Deseja realmente fechar esta enquete? Ela não receberá mais respostas.')) {
        return;
    }
    
    try {
        await $.post(`/api/polls/${pollId}/close`);
        showNotification('Sucesso', 'Enquete fechada com sucesso!', 'success');
        loadMyPolls(); // Recarregar lista
        
    } catch (error) {
        console.error('Erro ao fechar enquete:', error);
        showNotification('Erro', 'Falha ao fechar enquete', 'error');
    }
}

// Carregar tags do contato
async function loadContactTags(contactId) {
    try {
        const tags = await $.get(`/api/contacts/${contactId}/tags`);
        
        const $tagsContainer = $('#contact-tags');
        $tagsContainer.empty();
        
        if (tags.length > 0) {
            tags.forEach(tag => {
                const $tagElement = $(`
                    <span class="contact-tag me-1 mb-1" style="background-color: ${tag.color};" data-tag-id="${tag.id}">
                        ${tag.name}
                        <button class="tag-remove-btn" onclick="removeTagFromContact(${tag.id})" title="Remover tag">
                            <i class="bi bi-x"></i>
                        </button>
                    </span>
                `);
                $tagsContainer.append($tagElement);
            });
        }
        
        // Adicionar botão para adicionar nova tag
        $tagsContainer.append(`
            <button class="btn btn-sm btn-outline-primary add-tag-btn" onclick="showAddTagModal()">
                <i class="bi bi-plus"></i> Tag
            </button>
        `);
        
    } catch (error) {
        console.error('Erro ao carregar tags do contato:', error);
        showNotification('Erro', 'Falha ao carregar tags', 'error');
    }
}

// Mostrar modal para adicionar tag
function showAddTagModal() {
    if (!currentContact) {
        showNotification('Erro', 'Nenhum contato selecionado', 'error');
        return;
    }
    
    $('#addTagModal').modal('show');
    loadTagsForModal();
}

// Carregar tags no modal
function loadTagsForModal() {
    const $tagsList = $('#available-tags-list');
    $tagsList.empty();
    
    if (availableTags.length === 0) {
        $tagsList.html('<p class="text-muted">Nenhuma tag disponível</p>');
        return;
    }
    
    availableTags.forEach(tag => {
        const $tagItem = $(`
            <div class="tag-item" onclick="addTagToContact(${tag.id})">
                <span class="tag-preview" style="background-color: ${tag.color};">${tag.name}</span>
            </div>
        `);
        $tagsList.append($tagItem);
    });
}

// Adicionar tag ao contato
async function addTagToContact(tagId) {
    if (!currentContact) return;
    
    try {
        await $.post(`/api/contacts/${currentContact.id}/tags/${tagId}`);
        
        showNotification('Sucesso', 'Tag adicionada!', 'success');
        $('#addTagModal').modal('hide');
        
        // Recarregar tags do contato
        loadContactTags(currentContact.id);
        
    } catch (error) {
        console.error('Erro ao adicionar tag:', error);
        showNotification('Erro', 'Erro ao adicionar tag', 'error');
    }
}

// Remover tag do contato
async function removeTagFromContact(tagId) {
    if (!currentContact) return;
    
    if (!confirm('Deseja remover esta tag?')) return;
    
    try {
        await $.ajax({
            url: `/api/contacts/${currentContact.id}/tags/${tagId}`,
            method: 'DELETE'
        });
        
        showNotification('Sucesso', 'Tag removida!', 'success');
        
        // Remover visualmente
        $(`.contact-tag[data-tag-id="${tagId}"]`).fadeOut(300, function() {
            $(this).remove();
        });
        
    } catch (error) {
        console.error('Erro ao remover tag:', error);
        showNotification('Erro', 'Erro ao remover tag', 'error');
    }
}

// Criar nova tag
async function createNewTag() {
    const name = $('#new-tag-name').val().trim();
    const color = $('#new-tag-color').val();
    
    if (!name) {
        showNotification('Erro', 'Digite um nome para a tag', 'error');
        return;
    }
    
    try {
        await $.post('/api/tags', { name, color });
        
        showNotification('Sucesso', 'Tag criada!', 'success');
        
        // Limpar campos
        $('#new-tag-name').val('');
        $('#new-tag-color').val('#6c757d');
        
        // Recarregar tags disponíveis
        await loadAvailableTags();
        loadTagsForModal();
        
    } catch (error) {
        console.error('Erro ao criar tag:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao criar tag';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Função addTag atualizada (para compatibilidade)
function addTag() {
    showAddTagModal();
}

// Carregar anotações do contato
async function loadContactNotes(contactId) {
    try {
        const response = await $.get(`/api/contacts/${contactId}/notes`);
        
        // Preencher textarea com anotação atual
        $('#contact-notes').val(response.currentNote || '');
        
        // Mostrar histórico de anotações
        const $history = $('#contact-history');
        $history.empty();
        
        if (response.history && response.history.length > 0) {
            response.history.forEach(note => {
                const $noteItem = $(`
                    <div class="history-item mb-2" data-note-id="${note.id}">
                        <div class="d-flex justify-content-between align-items-start">
                            <small class="text-muted">
                                <i class="bi bi-person"></i> ${note.user_name || 'Sistema'} - 
                                ${formatDate(note.created_at)}
                            </small>
                            ${note.user_id === currentUser.id || currentUser.role === 'admin' ? 
                                `<button class="btn btn-xs btn-outline-danger" onclick="deleteNote(${note.id})" title="Deletar">
                                    <i class="bi bi-trash" style="font-size: 10px;"></i>
                                </button>` : ''}
                        </div>
                        <div class="note-content">${escapeHtml(note.content)}</div>
                    </div>
                `);
                $history.append($noteItem);
            });
        } else {
            $history.html('<p class="text-muted">Nenhuma anotação no histórico</p>');
        }
    } catch (error) {
        console.error('Erro ao carregar anotações:', error);
        showNotification('Erro', 'Falha ao carregar anotações', 'error');
    }
}

// Salvar anotações
async function saveNotes() {
    if (!currentContact) {
        showNotification('Erro', 'Nenhum contato selecionado', 'error');
        return;
    }
    
    const notes = $('#contact-notes').val().trim();
    
    if (!notes) {
        showNotification('Aviso', 'Digite uma anotação antes de salvar', 'warning');
        return;
    }
    
    try {
        await $.post(`/api/contacts/${currentContact.id}/notes`, {
            content: notes
        });
        
        showNotification('Sucesso', 'Anotação salva com sucesso!', 'success');
        
        // Recarregar anotações para atualizar o histórico
        setTimeout(() => {
            loadContactNotes(currentContact.id);
        }, 500);
        
    } catch (error) {
        console.error('Erro ao salvar anotação:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao salvar anotação';
        showNotification('Erro', errorMsg, 'error');
    }
}

function showNotification(title, body, type = 'info') {
    const toast = new bootstrap.Toast(document.getElementById('notificationToast'));
    $('#notificationToast .toast-header strong').text(title);
    $('#toast-body').text(body);
    
    // Mudar cor baseado no tipo
    const $toast = $('#notificationToast');
    $toast.removeClass('bg-success bg-danger bg-warning bg-info');
    
    switch(type) {
        case 'success':
            $toast.addClass('bg-success text-white');
            break;
        case 'error':
            $toast.addClass('bg-danger text-white');
            break;
        case 'warning':
            $toast.addClass('bg-warning');
            break;
        default:
            $toast.addClass('bg-info text-white');
    }
    
    toast.show();
    
    // Notificação do navegador se permitido
    if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/logo.png' });
    }
}

// Pedir permissão para notificações
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

// Apagar conversa
async function deleteConversation() {
    if (!currentContact) return;
    
    if (!confirm(`Deseja apagar TODAS as mensagens com ${currentContact.name || currentContact.number}?\n\nEsta ação não pode ser desfeita!`)) {
        return;
    }
    
    try {
        // Apagar mensagens do banco
        await $.ajax({
            url: `/api/contacts/${currentContact.id}/messages`,
            method: 'DELETE'
        });
        
        // Se houver fila ativa, finalizar também
        if (currentQueue) {
            await $.post('/api/queue/finish', { queueId: currentQueue.id });
        }
        
        showNotification('Sucesso', 'Conversa apagada!', 'success');
        
        // Limpar conversa atual
        currentContact = null;
        currentQueue = null;
        $('#chat-header').hide();
        $('#typing-area').hide();
        $('#sidebar-right').hide();
        $('#messages-container').html('<div class="no-chat-selected"><i class="bi bi-chat-dots"></i><p>Selecione uma conversa para começar</p></div>');
        
        // Recarregar contatos
        await loadContacts();
    } catch (error) {
        console.error('Erro ao apagar conversa:', error);
        showNotification('Erro', 'Falha ao apagar conversa', 'error');
    }
}

// Função para atualizar status da mensagem
function updateMessageStatus(messageId, status) {
    const $message = $(`.message[data-message-id="${messageId}"]`);
    if ($message.length) {
        $message.find('.message-status').removeClass('sending sent delivered read').addClass(status);
    }
}

// Formatar data para exibição
function formatDate(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) {
        return 'Hoje às ' + date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays === 1) {
        return 'Ontem às ' + date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } else if (diffDays < 7) {
        return date.toLocaleDateString('pt-BR', { weekday: 'short' }) + ' às ' + 
               date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } else {
        return date.toLocaleDateString('pt-BR') + ' às ' + 
               date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    }
}

// Adicionar nova anotação ao histórico
async function addNoteToHistory() {
    if (!currentContact) {
        showNotification('Erro', 'Nenhum contato selecionado', 'error');
        return;
    }
    
    const content = prompt('Nova anotação:');
    if (!content || content.trim() === '') return;
    
    try {
        await $.post(`/api/contacts/${currentContact.id}/notes/history`, {
            content: content.trim()
        });
        
        showNotification('Sucesso', 'Anotação adicionada ao histórico!', 'success');
        loadContactNotes(currentContact.id);
        
    } catch (error) {
        console.error('Erro ao adicionar anotação:', error);
        showNotification('Erro', 'Erro ao adicionar anotação', 'error');
    }
}

// Deletar anotação do histórico
async function deleteNote(noteId) {
    if (!confirm('Deseja deletar esta anotação?')) return;
    
    try {
        await $.ajax({
            url: `/api/notes/${noteId}`,
            method: 'DELETE'
        });
        
        showNotification('Sucesso', 'Anotação deletada!', 'success');
        
        // Remover visualmente
        $(`.history-item[data-note-id="${noteId}"]`).fadeOut(300, function() {
            $(this).remove();
        });
        
    } catch (error) {
        console.error('Erro ao deletar anotação:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao deletar anotação';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Limpar anotações
function clearNotes() {
    if (confirm('Deseja limpar a anotação?')) {
        $('#contact-notes').val('');
    }
}

// Carregar tags para o filtro
async function loadTagsForFilter() {
    try {
        const $select = $('#filter-tag');
        
        // Manter a opção "Todas as Tags"
        $select.find('option:not([value="all"])').remove();
        
        if (availableTags.length > 0) {
            availableTags.forEach(tag => {
                $select.append(`
                    <option value="${tag.id}" style="color: ${tag.color};">
                        ${tag.name}
                    </option>
                `);
            });
        }
        
        console.log('Tags carregadas para filtro:', availableTags.length);
    } catch (error) {
        console.error('Erro ao carregar tags para filtro:', error);
    }
}

// Atualizar resumo dos filtros no cabeçalho
function updateFilterSummary() {
    const sector = $('#filter-sector').val() || 'Todos os Setores';
    const tagId = $('#filter-tag').val();
    const search = $('#search-contact').val();
    const view = $('input[name="view-type"]:checked').val();
    
    let summaryParts = [];
    
    // Setor
    if (sector !== 'Todos os Setores') {
        summaryParts.push(sector);
    } else {
        summaryParts.push('Geral');
    }
    
    // Tag
    if (tagId && tagId !== 'all') {
        const tag = availableTags.find(t => t.id == tagId);
        if (tag) {
            summaryParts.push(tag.name);
        }
    } else {
        summaryParts.push('Todas as Tags');
    }
    
    // Busca
    if (search) {
        summaryParts.push(`"${search}"`);
    }
    
    // Visualização
    if (view === 'mine') {
        summaryParts.push('Meus Atendimentos');
    }
    
    $('#filter-summary-text').text(summaryParts.join(' • '));
}

// Atualizar filtros ativos visualmente
function updateActiveFilters() {
    const $container = $('#active-filters');
    const $list = $('#active-filters-list');
    const activeFilters = [];
    
    // Atualizar resumo no cabeçalho
    updateFilterSummary();
    
    // Verificar filtro de setor
    const sector = $('#filter-sector').val();
    if (sector) {
        activeFilters.push({
            type: 'sector',
            label: `Setor: ${sector}`,
            value: sector
        });
    }
    
    // Verificar filtro de tag
    const tagId = $('#filter-tag').val();
    if (tagId && tagId !== 'all') {
        const tag = availableTags.find(t => t.id == tagId);
        if (tag) {
            activeFilters.push({
                type: 'tag',
                label: `Tag: ${tag.name}`,
                value: tagId,
                color: tag.color
            });
        }
    }
    
    // Verificar busca
    const search = $('#search-contact').val();
    if (search) {
        activeFilters.push({
            type: 'search',
            label: `Busca: "${search}"`,
            value: search
        });
    }
    
    // Renderizar filtros ativos
    $list.empty();
    
    if (activeFilters.length > 0) {
        $container.show();
        
        activeFilters.forEach(filter => {
            const $badge = $(`
                <span class="badge rounded-pill active-filter-badge" 
                      style="background-color: ${filter.color || '#6c757d'};">
                    ${filter.label}
                    <button class="filter-remove-btn" onclick="removeFilter('${filter.type}', '${filter.value}')" title="Remover filtro">
                        <i class="bi bi-x"></i>
                    </button>
                </span>
            `);
            $list.append($badge);
        });
        
        // Botão para limpar todos
        $list.append(`
            <button class="btn btn-sm btn-outline-secondary clear-all-filters" onclick="clearAllFilters()">
                <i class="bi bi-x-circle"></i> Limpar Todos
            </button>
        `);
    } else {
        $container.hide();
    }
}

// Remover filtro específico
function removeFilter(type, value) {
    switch (type) {
        case 'sector':
            $('#filter-sector').val('');
            break;
        case 'tag':
            $('#filter-tag').val('all');
            break;
        case 'search':
            $('#search-contact').val('');
            break;
    }
    
    loadContacts();
    updateActiveFilters();
}

// Limpar todos os filtros
function clearAllFilters() {
    $('#filter-sector').val('');
    $('#filter-tag').val('all');
    $('#search-contact').val('');
    
    loadContacts();
    updateActiveFilters();
}

// Atualizar loadAvailableTags para recarregar o filtro também
async function loadAvailableTags() {
    try {
        const response = await $.get('/api/tags');
        availableTags = response;
        console.log('Tags carregadas:', availableTags);
        
        // Atualizar filtro de tags
        loadTagsForFilter();
    } catch (error) {
        console.error('Erro ao carregar tags:', error);
    }
}

// Lidar com formulário de nova resposta rápida
async function handleNewQuickReply(e) {
    e.preventDefault();
    
    const title = $('#new-reply-title').val().trim();
    const content = $('#new-reply-content').val().trim();
    const shortcut = $('#new-reply-shortcut').val().trim();
    const sector = $('#new-reply-sector').val();
    
    if (!title || !content) {
        showNotification('Erro', 'Título e conteúdo são obrigatórios', 'error');
        return;
    }
    
    try {
        await $.post('/api/quick-replies', {
            title,
            content,
            shortcut,
            sector
        });
        
        showNotification('Sucesso', 'Resposta rápida criada!', 'success');
        
        // Limpar formulário
        $('#new-quick-reply-form')[0].reset();
        $('#reply-preview').text('Digite o conteúdo acima para ver o preview...');
        
        // Recarregar respostas
        await loadQuickReplies();
        
        // Voltar para a aba de usar
        $('#use-reply-tab').tab('show');
        renderQuickRepliesList();
        
    } catch (error) {
        console.error('Erro ao criar resposta rápida:', error);
        showNotification('Erro', 'Falha ao criar resposta rápida', 'error');
    }
}

// ===== SISTEMA DE GRAVAÇÃO DE ÁUDIO =====

// Iniciar gravação de áudio
async function startRecording() {
    try {
        // Verificar se tem contato selecionado
        if (!currentContact) {
            showNotification('Erro', 'Selecione um contato primeiro', 'error');
            return;
        }

        if (!currentSession) {
            showNotification('Erro', 'Nenhuma sessão WhatsApp ativa', 'error');
            return;
        }

        // ← ADICIONAR ESTA LINHA AQUI
        isRecordingCancelled = false;

        console.log('Iniciando gravação de áudio...');

        // Solicitar permissão para microfone
        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                sampleRate: 44100
            } 
        });

        // Configurar MediaRecorder com melhor formato disponível
        let options = {};
        
        // Lista de formatos em ordem de preferência (MP3 primeiro para WhatsApp)
        const formatOptions = [
          { mimeType: 'audio/mpeg', audioBitsPerSecond: 128000 }, // MP3 - melhor para WhatsApp
          { mimeType: 'audio/mp3', audioBitsPerSecond: 128000 },
          { mimeType: 'audio/ogg', audioBitsPerSecond: 64000 },
          { mimeType: 'audio/wav' },
          { mimeType: 'audio/webm' }, // Último recurso
          {} // Padrão do navegador
        ];
        
        // Encontrar primeiro formato suportado
        for (const option of formatOptions) {
          if (!option.mimeType || MediaRecorder.isTypeSupported(option.mimeType)) {
            options = option;
            console.log('🎙️ Formato selecionado:', option.mimeType || 'padrão do navegador');
            break;
          }
        }
        
        console.log('🎙️ Usando formato de áudio:', options.mimeType || 'padrão');
        
        mediaRecorder = new MediaRecorder(stream, options);
        audioChunks = [];

        // Configurar AudioContext para visualização
        setupAudioVisualization(stream);

        // Event listeners
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };

       mediaRecorder.onstop = () => {
            console.log('Gravação finalizada');
            stream.getTracks().forEach(track => track.stop());
            if (audioContext) {
                audioContext.close();
            }
            
            // Verificar se foi cancelado antes de processar
            if (!isRecordingCancelled) {
                console.log('✅ Processando áudio (não foi cancelado)');
                processRecordedAudio();
            } else {
                console.log('❌ Áudio cancelado - não será enviado');
                audioChunks = [];
            }
        };

        // Iniciar gravação
        mediaRecorder.start();
        recordingStartTime = Date.now();
        
        // Atualizar interface
        showRecordingInterface();
        startRecordingTimer();

        console.log('Gravação iniciada com sucesso');

    } catch (error) {
        console.error('Erro ao iniciar gravação:', error);
        
        let errorMessage = 'Erro ao acessar microfone';
        if (error.name === 'NotAllowedError') {
            errorMessage = 'Permissão de microfone negada. Permita o acesso e tente novamente.';
        } else if (error.name === 'NotFoundError') {
            errorMessage = 'Microfone não encontrado. Verifique se está conectado.';
        }
        
        showNotification('Erro', errorMessage, 'error');
    }
}

// Parar gravação e enviar
function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        console.log('✅ Parando gravação para ENVIAR...');
        isRecordingCancelled = false; // Garantir que não está marcado como cancelado
        mediaRecorder.stop();
        stopRecordingTimer();
        hideRecordingInterface();
    }
}

// Cancelar gravação
function cancelRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        console.log('❌ Cancelando gravação - NÃO ENVIAR...');
        isRecordingCancelled = true; // Marcar como cancelado ANTES de parar
        mediaRecorder.stop();
        
        // Limpar dados
        audioChunks = [];
        
        stopRecordingTimer();
        hideRecordingInterface();
        
        showNotification('Cancelado', 'Gravação cancelada', 'info');
    }
}

// Configurar visualização de áudio
function setupAudioVisualization(stream) {
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        
        analyser.fftSize = 256;
        const bufferLength = analyser.frequencyBinCount;
        dataArray = new Uint8Array(bufferLength);
        
        source.connect(analyser);
        
        // Iniciar animação
        drawWaveform();
    } catch (error) {
        console.error('Erro ao configurar visualização:', error);
    }
}

// Desenhar forma de onda
function drawWaveform() {
    if (!analyser || !dataArray) return;
    
    const canvas = document.getElementById('waveform-canvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    animationId = requestAnimationFrame(drawWaveform);
    
    analyser.getByteFrequencyData(dataArray);
    
    // Limpar canvas
    ctx.fillStyle = '#f8f9fa';
    ctx.fillRect(0, 0, width, height);
    
    // Desenhar barras
    const barWidth = (width / dataArray.length) * 2.5;
    let barHeight;
    let x = 0;
    
    for (let i = 0; i < dataArray.length; i++) {
        barHeight = (dataArray[i] / 255) * height * 0.8;
        
        // Gradient para as barras
        const gradient = ctx.createLinearGradient(0, height, 0, height - barHeight);
        gradient.addColorStop(0, '#471e8a');
        gradient.addColorStop(1, '#923bf6');
        
        ctx.fillStyle = gradient;
        ctx.fillRect(x, height - barHeight, barWidth, barHeight);
        
        x += barWidth + 1;
    }
}

// Mostrar interface de gravação
function showRecordingInterface() {
    $('#normal-input-area').hide();
    $('#audio-recording-area').show();
    
    // Vibrar dispositivo se disponível
    if (navigator.vibrate) {
        navigator.vibrate(100);
    }
}

// Esconder interface de gravação
function hideRecordingInterface() {
    $('#audio-recording-area').hide();
    $('#normal-input-area').show();
    
    // Parar animação
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
}

// Timer da gravação
function startRecordingTimer() {
    recordingTimer = setInterval(() => {
        if (recordingStartTime) {
            const elapsed = Date.now() - recordingStartTime;
            const minutes = Math.floor(elapsed / 60000);
            const seconds = Math.floor((elapsed % 60000) / 1000);
            
            const timeString = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            $('#recording-timer').text(timeString);
            
            // Limite de 5 minutos
            if (elapsed > 300000) { // 5 minutos
                stopRecording();
                showNotification('Aviso', 'Gravação limitada a 5 minutos', 'warning');
            }
        }
    }, 1000);
}

// Parar timer
function stopRecordingTimer() {
    if (recordingTimer) {
        clearInterval(recordingTimer);
        recordingTimer = null;
    }
    recordingStartTime = null;
}

// Processar áudio gravado
async function processRecordedAudio() {
  try {
    if (audioChunks.length === 0) {
      console.log('Nenhum áudio para processar');
      return;
    }

    console.log('Processando áudio gravado...');
    
    // Criar blob do áudio com tipo correto
    const mimeType = mediaRecorder.mimeType || 'audio/webm';
    let audioBlob = new Blob(audioChunks, { type: mimeType });
    
    console.log('📁 Blob original criado com tipo:', mimeType);
    console.log('📁 Tamanho original:', (audioBlob.size / 1024 / 1024).toFixed(2) + 'MB');
    
    // ENVIAR ÁUDIO ORIGINAL - conversão será feita no servidor
    console.log('📤 Enviando áudio para conversão no servidor...');
    console.log('📁 Formato original:', audioBlob.type);
    console.log('📁 Tamanho:', (audioBlob.size / 1024 / 1024).toFixed(2) + 'MB');
    
    
    // Verificar tamanho (máximo 16MB)
    const maxSize = 16 * 1024 * 1024; // 16MB
    if (audioBlob.size > maxSize) {
      showNotification('Erro', 'Áudio muito grande. Limite: 16MB', 'error');
      return;
    }

    // Enviar áudio
    await sendAudioMessage(audioBlob);

  } catch (error) {
    console.error('Erro ao processar áudio:', error);
    showNotification('Erro', 'Falha ao processar áudio gravado', 'error');
  }
}

// Converter áudio para formato OGG/Opus compatível
async function convertAudioToOgg(inputBlob) {
  return new Promise((resolve) => {
    try {
      console.log('🔄 Iniciando conversão de áudio...');
      
      // Criar URL do blob
      const url = URL.createObjectURL(inputBlob);
      
      // Criar elemento de áudio
      const audio = new Audio(url);
      audio.preload = 'metadata';
      
      audio.onloadedmetadata = () => {
        try {
          // Criar AudioContext
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          
          // Criar MediaStreamDestination
          const destination = audioContext.createMediaStreamDestination();
          
          // Criar source do áudio
          const source = audioContext.createMediaElementSource(audio);
          source.connect(destination);
          
          // Configurar MediaRecorder para OGG
          const options = { 
            mimeType: 'audio/ogg; codecs=opus',
            audioBitsPerSecond: 32000 // Reduzir qualidade para compatibilidade
          };
          
          // Verificar se OGG é suportado
          if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.log('⚠️ OGG não suportado, usando WAV');
            options.mimeType = 'audio/wav';
          }
          
          const recorder = new MediaRecorder(destination.stream, options);
          const chunks = [];
          
          recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
              chunks.push(event.data);
            }
          };
          
          recorder.onstop = () => {
            const convertedBlob = new Blob(chunks, { type: options.mimeType });
            URL.revokeObjectURL(url);
            console.log('✅ Conversão concluída:', options.mimeType);
            resolve(convertedBlob);
          };
          
          // Iniciar gravação e reprodução
          recorder.start();
          audio.play();
          
          // Parar quando o áudio terminar
          audio.onended = () => {
            recorder.stop();
          };
          
          // Timeout de segurança (10 segundos)
          setTimeout(() => {
            if (recorder.state === 'recording') {
              recorder.stop();
            }
          }, 10000);
          
        } catch (error) {
          console.log('❌ Erro na conversão:', error);
          URL.revokeObjectURL(url);
          resolve(null);
        }
      };
      
      audio.onerror = () => {
        console.log('❌ Erro ao carregar áudio para conversão');
        URL.revokeObjectURL(url);
        resolve(null);
      };
      
    } catch (error) {
      console.log('❌ Erro geral na conversão:', error);
      resolve(null);
    }
  });
}

// Enviar mensagem de áudio
async function sendAudioMessage(audioBlob) {
  try {
    console.log('Enviando áudio...');
    
    showNotification('Enviando', 'Enviando áudio...');

    // Determinar extensão baseada no tipo MIME (priorizar MP3)
    let extension = 'mp3'; // Padrão MP3 para melhor compatibilidade
    const blobType = audioBlob.type || 'audio/mpeg';
    
    if (blobType.includes('mp3') || blobType.includes('mpeg')) {
        extension = 'mp3';
    } else if (blobType.includes('ogg')) {
        extension = 'ogg';
    } else if (blobType.includes('wav')) {
        extension = 'wav';
    } else if (blobType.includes('webm')) {
        extension = 'webm';
    }
    
    console.log('🔍 Tipo de blob:', blobType);
    console.log('📁 Extensão determinada:', extension);

    // Preparar dados para envio
    const formData = new FormData();
    formData.append('audio', audioBlob, `voice-message.${extension}`);
    formData.append('sessionId', currentSession);
    formData.append('contactId', currentContact.id);

    console.log('📤 Enviando áudio via rota específica...');

    // Usar rota específica de áudio
    const response = await $.ajax({
      url: '/api/messages/send-audio',
      type: 'POST',
      data: formData,
      processData: false,
      contentType: false,
      timeout: 60000
    });

        console.log('Áudio enviado com sucesso:', response);
        
        showNotification('Voice Message Enviado', 'Mensagem de voz enviada como PTT!', 'success');

        // Recarregar mensagens para mostrar o áudio enviado
        if (currentContact) {
            await loadMessages(currentContact.id);
        }

    } catch (error) {
        console.error('Erro ao enviar áudio:', error);
        
        let errorMessage = 'Falha ao enviar áudio';
        if (error.responseJSON && error.responseJSON.error) {
            errorMessage = error.responseJSON.error;
        } else if (error.statusText === 'timeout') {
            errorMessage = 'Timeout: Áudio muito grande ou conexão lenta';
        }
        
        showNotification('Erro', errorMessage, 'error');
    }
}

// Verificar suporte a gravação de áudio
function checkAudioRecordingSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        console.warn('Gravação de áudio não suportada neste navegador');
        $('#mic-btn').prop('disabled', true).attr('title', 'Gravação não suportada neste navegador');
        return false;
    }
    return true;
}

// Inicializar suporte a áudio quando o documento carregar
$(document).ready(function() {
    checkAudioRecordingSupport();
    
    // Atalho: segurar Espaço para gravar (opcional)
    let spacePressed = false;
    
    $(document).on('keydown', function(e) {
        if (e.code === 'Space' && !spacePressed && $('#message-input').is(':focus') && $('#message-input').val().trim() === '') {
            e.preventDefault();
            spacePressed = true;
            startRecording();
        }
    });
    
    $(document).on('keyup', function(e) {
        if (e.code === 'Space' && spacePressed) {
            e.preventDefault();
            spacePressed = false;
            stopRecording();
        }
    });
    });
    

// Formatar número de WhatsApp
function formatWhatsAppNumber(number) {
    // Remover caracteres não numéricos
    let cleaned = number.replace(/\D/g, '');
    
    // Se começar com 0, remover
    if (cleaned.startsWith('0')) {
        cleaned = cleaned.substring(1);
    }
    
    // Se não tem código do país (menos de 12 dígitos), adicionar 55
    if (cleaned.length === 11 || cleaned.length === 10) {
        cleaned = '55' + cleaned;
    }
    
    // Adicionar @c.us se não tiver
    if (!cleaned.includes('@c.us')) {
        cleaned = cleaned + '@c.us';
    }
    
    return cleaned;
}

 // ===========================================
// SISTEMA DE NOVA CONVERSA
// ===========================================

// Mostrar modal de nova conversa
function showNewContactModal() {
    if (!currentSession) {
        showNotification('Erro', 'Nenhuma sessão WhatsApp conectada!', 'error');
        return;
    }
    
    // Limpar campos
    $('#new-contact-number').val('');
    $('#new-contact-name').val('');
    $('#new-contact-message').val('');
    $('#new-contact-media').val('');
    
    $('#newContactModal').modal('show');
}

// Importar contatos do WhatsApp
async function importWhatsAppContacts() {
    if (!currentSession) {
        showNotification('Erro', 'Nenhuma sessão WhatsApp ativa', 'error');
        return;
    }
    
    if (!confirm('Deseja importar todos os contatos do seu WhatsApp?\n\nIsso pode demorar alguns minutos.')) {
        return;
    }
    
    try {
        showNotification('Importando', 'Importando contatos do WhatsApp...', 'info');
        
        const response = await $.ajax({
            url: '/api/contacts/import-from-whatsapp',
            method: 'POST',
            data: JSON.stringify({ sessionId: currentSession }),
            contentType: 'application/json',
            timeout: 300000 // 5 minutos
        });
        
        showNotification('Sucesso', response.message, 'success');
        
        // Recarregar lista de contatos
        setTimeout(() => {
            loadContacts();
        }, 2000);
        
    } catch (error) {
        console.error('Erro ao importar contatos:', error);
        const errorMsg = error.responseJSON?.error || 'Erro ao importar contatos';
        showNotification('Erro', errorMsg, 'error');
    }
}

// Enviar mensagem para novo contato
async function sendToNewContact() {
    try {
        // Validações
        const number = $('#new-contact-number').val().trim();
        const name = $('#new-contact-name').val().trim();
        const message = $('#new-contact-message').val().trim();
        const mediaFile = $('#new-contact-media')[0].files[0];
        
        if (!number) {
            showNotification('Erro', 'Número é obrigatório', 'error');
            return;
        }
        
        if (!message && !mediaFile) {
            showNotification('Erro', 'Digite uma mensagem ou selecione uma mídia', 'error');
            return;
        }
        
        if (!currentSession) {
            showNotification('Erro', 'Nenhuma sessão WhatsApp ativa', 'error');
            return;
        }
        
        // Mostrar loading
        const $btn = $('.modal-footer .btn-success');
        const originalText = $btn.html();
        $btn.html('<span class="spinner-border spinner-border-sm me-2"></span>Enviando...')
            .prop('disabled', true);
        
        // Preparar FormData
        const formData = new FormData();
        formData.append('sessionId', currentSession);
        formData.append('number', number);
        formData.append('name', name || '');
        
        // USAR FORMATAÇÃO NOVA PARA MENSAGEM
        if (message) {
            const formattedMessage = formatMessageForWhatsApp(message);
            formData.append('message', formattedMessage);
        }
        
        if (mediaFile) {
            formData.append('media', mediaFile);
        }
        
        console.log('📤 Enviando para novo contato:', { number, name, hasMedia: !!mediaFile });
        
        // Enviar para servidor
        const response = await $.ajax({
            url: '/api/messages/send-to-new-contact',
            type: 'POST',
            data: formData,
            processData: false,
            contentType: false,
            timeout: 30000
        });
        
        showNotification('Sucesso', 'Mensagem enviada com sucesso!', 'success');
        
        // Fechar modal
        $('#newContactModal').modal('hide');
        
        // Recarregar lista de contatos
        setTimeout(() => {
            loadContacts();
        }, 1000);
        
        // Resetar botão
        $btn.html(originalText).prop('disabled', false);
        
    } catch (error) {
        console.error('Erro ao enviar para novo contato:', error);
        
        // Resetar botão
        const $btn = $('.modal-footer .btn-success');
        $btn.html('<i class="bi bi-send"></i> Enviar Mensagem').prop('disabled', false);
        
        const errorMsg = error.responseJSON?.error || 'Erro ao enviar mensagem';
        showNotification('Erro', errorMsg, 'error');
    }
}

// ===========================================
// SISTEMA DE FORMATAÇÃO PARA WHATSAPP
// ===========================================

// Função para formatar mensagem para WhatsApp
function formatMessageForWhatsApp(content) {
    if (!content) return '';
    
    console.log('🎨 Formatando mensagem para WhatsApp...');
    
    // 1. Normalizar quebras de linha
    let formatted = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // 2. Garantir formatação de negrito (WhatsApp usa *)
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '*$1*'); // **texto** -> *texto*
    
    // 3. Garantir formatação de itálico (WhatsApp usa _)
    formatted = formatted.replace(/_(.*?)_/g, '_$1_');
    
    // 4. Garantir formatação de código (WhatsApp usa ```)
    formatted = formatted.replace(/`(.*?)`/g, '```$1```');
    
    // 5. Limpar múltiplas quebras consecutivas (máximo 2)
    formatted = formatted.replace(/\n{3,}/g, '\n\n');
    
    // 6. Garantir espaçamento adequado após seções
    formatted = formatted.replace(/━━━━━.*?━━━━━/g, (match) => {
        return match + '\n';
    });
    
    // 7. Tratar emojis que podem não funcionar
    const emojiMap = {
        '▪': '•',
        '▫': '◦',
        '🏆': '👑',
        '━': '═'
    };
    
    Object.keys(emojiMap).forEach(emoji => {
        formatted = formatted.replace(new RegExp(emoji, 'g'), emojiMap[emoji]);
    });
    
    // 8. Verificar limite de caracteres do WhatsApp (4096)
    if (formatted.length > 4000) {
        console.warn('⚠️ Mensagem muito longa, pode ser cortada no WhatsApp');
        formatted = formatted.substring(0, 3950) + '\n\n... _(mensagem cortada por limite)_';
    }
    
    // 9. Remover espaços desnecessários no início/fim de linhas
    formatted = formatted.split('\n').map(line => line.trim()).join('\n');
    
    // 10. Garantir que não termine com quebra de linha
    formatted = formatted.replace(/\n+$/, '');
    
    console.log('✅ Mensagem formatada para WhatsApp:', formatted.length, 'caracteres');
    
    return formatted;
}

// Função para preview da mensagem formatada
function previewWhatsAppMessage(content) {
    const formatted = formatMessageForWhatsApp(content);
    
    // Mostrar preview em modal
    $('#whatsappPreviewModal').modal('show');
    $('#whatsapp-preview-content').html(formatted.replace(/\n/g, '<br>'));
    $('#whatsapp-char-count').text(`${formatted.length}/4096 caracteres`);
    
    // Indicador visual de tamanho
    const percentage = (formatted.length / 4096) * 100;
    $('#whatsapp-char-progress').css('width', percentage + '%');
    
    if (percentage > 90) {
        $('#whatsapp-char-progress').addClass('bg-danger').removeClass('bg-success bg-warning');
    } else if (percentage > 70) {
        $('#whatsapp-char-progress').addClass('bg-warning').removeClass('bg-success bg-danger');
    } else {
        $('#whatsapp-char-progress').addClass('bg-success').removeClass('bg-warning bg-danger');
    }
    
    return formatted;
}

// Função melhorada para enviar mensagem com formatação
async function sendFormattedMessage(content, contactId = null, sessionId = null) {
    try {
        // Se não informado, usar contato e sessão atual
        const targetContactId = contactId || currentContact?.id;
        const targetSessionId = sessionId || currentSession;
        
        if (!targetContactId || !targetSessionId) {
            showNotification('Erro', 'Contato ou sessão não selecionados', 'error');
            return;
        }
        
        // Formatar mensagem
        const formattedContent = formatMessageForWhatsApp(content);
        
        console.log('📤 Enviando mensagem formatada...');
        
        // Verificar se precisa quebrar em múltiplas mensagens
        if (formattedContent.length > 4000) {
            return await sendLongMessage(formattedContent, targetContactId, targetSessionId);
        }
        
        // Enviar mensagem normal
        const response = await $.post('/api/messages/send', {
            sessionId: targetSessionId,
            contactId: targetContactId,
            content: formattedContent,
            type: 'text'
        });
        
        if (response.success) {
            showNotification('Enviado', 'Mensagem formatada enviada!', 'success');
            
            // Atualizar conversa se for o contato atual
            if (targetContactId === currentContact?.id) {
                await loadMessages(targetContactId);
            }
        }
        
        return response;
        
    } catch (error) {
        console.error('Erro ao enviar mensagem formatada:', error);
        showNotification('Erro', 'Falha ao enviar mensagem', 'error');
        return null;
    }
}

// Função para quebrar mensagens muito longas
async function sendLongMessage(content, contactId, sessionId) {
    try {
        console.log('📄 Mensagem longa detectada, quebrando em partes...');
        
        // Quebrar por seções (usando separadores)
        const sections = content.split(/═══════.*?══════=/);
        const messages = [];
        
        let currentMessage = '';
        
        for (let i = 0; i < sections.length; i++) {
            const section = sections[i].trim();
            
            if (currentMessage.length + section.length < 3800) {
                currentMessage += section;
                if (i < sections.length - 1) {
                    currentMessage += '\n═══════════════════════\n';
                }
            } else {
                if (currentMessage) {
                    messages.push(currentMessage.trim());
                }
                currentMessage = section;
            }
        }
        
        if (currentMessage) {
            messages.push(currentMessage.trim());
        }
        
        // Enviar mensagens em sequência
        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const isLast = i === messages.length - 1;
            
            // Adicionar indicador de continuação
            let finalMsg = msg;
            if (!isLast) {
                finalMsg += '\n\n📄 _(continua na próxima mensagem...)_';
            }
            
            await $.post('/api/messages/send', {
                sessionId: sessionId,
                contactId: contactId,
                content: finalMsg,
                type: 'text'
            });
            
            // Delay entre mensagens para não ser spam
            if (!isLast) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        showNotification('Enviado', `Mensagem enviada em ${messages.length} partes!`, 'success');
        
        return { success: true, parts: messages.length };
        
    } catch (error) {
        console.error('Erro ao enviar mensagem longa:', error);
        throw error;
    }
}

// Preview da mensagem atual
function previewCurrentMessage() {
    const content = $('#message-input').val().trim();
    if (!content) {
        showNotification('Aviso', 'Digite uma mensagem para ver o preview', 'warning');
        return;
    }
    
    previewWhatsAppMessage(content);
}

// Função para enviar mensagem do preview
function sendPreviewedMessage() {
    const content = $('#message-input').val().trim();
    if (!content) return;
    
    $('#whatsappPreviewModal').modal('hide');
    sendFormattedMessage(content);
    $('#message-input').val('').focus();
}

// Função para testar formatação
function testWhatsAppFormatting() {
    const testMessage = `🏥 *TESTE DE FORMATAÇÃO* 🏥
═══════════════════════════════

📱 **Negrito duplo** -> *Negrito simples*
📝 _Itálico_ funciona
📄 \`Código\` -> \`\`\`Código\`\`\`

🔸 Lista com bullets:
- Item 1
- Item 2
- Item 3

📊 *SEÇÃO IMPORTANTE*
═══════════════════════

✅ Formatação aplicada!`;

    previewWhatsAppMessage(testMessage);
}