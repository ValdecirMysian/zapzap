// auth.js - Autenticação, Middleware e Helpers
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./database');

// Gerar token JWT
const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user.id, 
      email: user.email, 
      role: user.role 
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// Verificar token JWT
const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
};

// Middleware de autenticação para rotas
const authMiddleware = async (req, res, next) => {
  try {
    // Verificar token no header, cookie ou sessão
    const token = req.headers.authorization?.replace('Bearer ', '') || 
                  req.cookies?.token || 
                  req.session?.token;

    if (!token) {
      return res.status(401).json({ error: 'Token não fornecido' });
    }

    // Verificar e decodificar token
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({ error: 'Token inválido' });
    }

    // Buscar usuário no banco
    const user = await db.users.findById(decoded.id);
    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'Usuário não encontrado ou inativo' });
    }

    // Adicionar usuário à requisição
    req.user = user;
    next();
  } catch (error) {
    console.error('Erro no middleware de auth:', error);
    res.status(500).json({ error: 'Erro na autenticação' });
  }
};

// Middleware para verificar se é admin
const adminMiddleware = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }
  next();
};

// Middleware para verificar se é supervisor ou admin
const supervisorMiddleware = (req, res, next) => {
  if (!['admin', 'supervisor'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Acesso negado. Apenas supervisores ou administradores.' });
  }
  next();
};

// Helpers de setor
const sectorHelpers = {
  // Lista de setores disponíveis
  getSectors: () => {
    return [
      'Geral',
      'Medicamento',
      'Perfumaria 1',
      'Perfumaria 2',
      'Caixa',
      'Dermocosméticos',
      'Suplementos'
    ];
  },

  // Verificar se usuário tem acesso ao setor
  hasAccessToSector: (user, sector) => {
    if (user.role === 'admin') return true;
    if (user.role === 'supervisor') return true;
    return user.sector === sector || user.sector === 'Geral';
  }
};

// Helpers de upload
const uploadHelpers = {
  // Validar tipo de arquivo
 isValidFileType: (mimetype, category) => {
    const types = {
      image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      audio: [
        'audio/mpeg', 
        'audio/mp3', 
        'audio/ogg', 
        'audio/wav', 
        'audio/webm', 
        'audio/mp4',     // Adicionar MP4 para áudio
        'audio/m4a',     // Adicionar M4A
        'audio/aac'      // Adicionar AAC
      ],
      video: ['video/mp4', 'video/webm', 'video/ogg'],
      document: [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ]
    };

    if (category) {
      return types[category]?.includes(mimetype) || false;
    }

    // Verificar em todas as categorias
    return Object.values(types).flat().includes(mimetype);
  },

  // Gerar nome único para arquivo
  generateFileName: (originalName) => {
    const ext = originalName.split('.').pop();
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(7);
    return `${timestamp}_${random}.${ext}`;
  },

  // Obter categoria do arquivo
  getFileCategory: (mimetype) => {
    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype.startsWith('video/')) return 'video';
    return 'document';
  }
};

// Helpers de mensagem
const messageHelpers = {
  // Formatar mensagem com variáveis
  formatMessage: (template, variables = {}) => {
    let message = template;
    
    // Variáveis padrão do sistema
    const now = new Date();
    const systemVars = {
      data: now.toLocaleDateString('pt-BR'),
      hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      dia_semana: now.toLocaleDateString('pt-BR', { weekday: 'long' }),
      ...variables // Variáveis personalizadas sobrescrevem as padrão
    };

    // Substituir todas as variáveis no formato {{variavel}}
    Object.keys(systemVars).forEach(key => {
      const regex = new RegExp(`{{${key}}}`, 'g');
      message = message.replace(regex, systemVars[key]);
    });

    return message;
  },

  // Obter variáveis disponíveis para mostrar na interface
  getAvailableVariables: () => {
    const now = new Date();
    return {
      nome: {
        description: 'Nome do contato',
        example: 'João Silva',
        value: '{{nome}}'
      },
      data: {
        description: 'Data atual',
        example: now.toLocaleDateString('pt-BR'),
        value: '{{data}}'
      },
      hora: {
        description: 'Hora atual',
        example: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        value: '{{hora}}'
      },
      dia_semana: {
        description: 'Dia da semana',
        example: now.toLocaleDateString('pt-BR', { weekday: 'long' }),
        value: '{{dia_semana}}'
      }
    };
  },

  // Extrair menções de números (@)
  extractMentions: (text) => {
    const regex = /@(\d+)/g;
    const mentions = [];
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      mentions.push(match[1]);
    }
    
    return mentions;
  }
};

// Helpers de validação
const validationHelpers = {
  // Validar email
  isValidEmail: (email) => {
    const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
  },

  // Validar número de WhatsApp
  isValidWhatsAppNumber: (number) => {
    // Remover caracteres não numéricos
    const cleaned = number.replace(/\D/g, '');
    
    // Verificar se tem o formato correto (código do país + DDD + número)
    return cleaned.length >= 12 && cleaned.length <= 15;
  },

  // Formatar número de WhatsApp
  formatWhatsAppNumber: (number) => {
    let cleaned = number.replace(/\D/g, '');
    
    // Adicionar código do Brasil se não tiver
    if (cleaned.length === 11 && cleaned.startsWith('5')) {
      cleaned = '55' + cleaned;
    }
    
    // Adicionar @c.us
    return cleaned.includes('@c.us') ? cleaned : `${cleaned}@c.us`;
  },

  // Sanitizar entrada do usuário
  sanitizeInput: (input) => {
    if (typeof input !== 'string') return input;
    
    return input
      .trim()
      .replace(/[<>]/g, '') // Remover tags HTML básicas
      .substring(0, 1000); // Limitar tamanho
  }
};

// Helpers de relatório
const reportHelpers = {
  // Gerar estatísticas do período
  generateStats: async (startDate, endDate, sector = null) => {
    const params = [startDate, endDate];
    let sectorCondition = '';
    
    if (sector) {
      sectorCondition = ' AND q.sector = ?';
      params.push(sector);
    }

    // Total de atendimentos
    const totalQuery = `
      SELECT COUNT(*) as total 
      FROM queues q 
      WHERE q.created_at BETWEEN ? AND ? ${sectorCondition}
    `;
    
    // Tempo médio de atendimento
    const avgTimeQuery = `
      SELECT AVG(TIMESTAMPDIFF(MINUTE, started_at, finished_at)) as avg_time
      FROM queues q
      WHERE q.status = 'finished' 
        AND q.started_at IS NOT NULL 
        AND q.finished_at IS NOT NULL
        AND q.created_at BETWEEN ? AND ? ${sectorCondition}
    `;
    
    // Atendimentos por usuário
    const byUserQuery = `
      SELECT u.name, COUNT(*) as count
      FROM queues q
      JOIN users u ON q.user_id = u.id
      WHERE q.status = 'finished'
        AND q.created_at BETWEEN ? AND ? ${sectorCondition}
      GROUP BY u.id, u.name
      ORDER BY count DESC
    `;

    const [total, avgTime, byUser] = await Promise.all([
      db.query(totalQuery, params),
      db.query(avgTimeQuery, params),
      db.query(byUserQuery, params)
    ]);

    return {
      total: total[0].total,
      avgTime: Math.round(avgTime[0].avg_time || 0),
      byUser
    };
  },

  // Estatísticas completas para dashboard
  generateDashboardStats: async (startDate, endDate, sector = null) => {
    const params = [startDate, endDate];
    let sectorCondition = '';
    
    if (sector && sector !== '' && sector !== 'all') {
      sectorCondition = ' AND q.sector = ?';
      params.push(sector);
    }

    // Estatísticas básicas
    const basicStats = await reportHelpers.generateStats(startDate, endDate, sector);
    
    // Atendimentos hoje
    const todayQuery = `
      SELECT COUNT(*) as today_total
      FROM queues q
      WHERE DATE(q.created_at) = CURDATE() ${sectorCondition}
    `;
    
    // Atendimentos finalizados hoje
    const todayFinishedQuery = `
      SELECT COUNT(*) as today_finished
      FROM queues q
      WHERE q.status = 'finished' 
        AND DATE(q.finished_at) = CURDATE() ${sectorCondition}
    `;
    
    // Tempo médio hoje
    const todayAvgTimeQuery = `
      SELECT AVG(TIMESTAMPDIFF(MINUTE, started_at, finished_at)) as today_avg_time
      FROM queues q
      WHERE q.status = 'finished' 
        AND q.started_at IS NOT NULL 
        AND q.finished_at IS NOT NULL
        AND DATE(q.finished_at) = CURDATE() ${sectorCondition}
    `;

    const [todayStats, todayFinished, todayAvgTime] = await Promise.all([
      db.query(todayQuery, sector ? [sector] : []),
      db.query(todayFinishedQuery, sector ? [sector] : []),
      db.query(todayAvgTimeQuery, sector ? [sector] : [])
    ]);

    return {
      ...basicStats,
      todayTotal: todayStats[0].today_total,
      todayFinished: todayFinished[0].today_finished,
      todayAvgTime: Math.round(todayAvgTime[0].today_avg_time || 0)
    };
  },

  // Estatísticas diárias para gráfico
  getDailyStats: async (days = 7, sector = null) => {
    const sectorCondition = sector && sector !== '' && sector !== 'all' ? 'AND q.sector = ?' : '';
    const params = [days];
    if (sectorCondition) params.push(sector);

    const query = `
      SELECT 
        DATE(q.created_at) as date,
        COUNT(*) as total,
        COUNT(CASE WHEN q.status = 'finished' THEN 1 END) as finished,
        AVG(CASE WHEN q.status = 'finished' AND q.started_at IS NOT NULL AND q.finished_at IS NOT NULL 
            THEN TIMESTAMPDIFF(MINUTE, q.started_at, q.finished_at) END) as avg_time
      FROM queues q
      WHERE q.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ${sectorCondition}
      GROUP BY DATE(q.created_at)
      ORDER BY date ASC
    `;

    const results = await db.query(query, params);
    
    // Preencher dias sem dados
    const dailyStats = [];
    for (let i = days - 1; i >= 0; i--) {
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

    return dailyStats;
  },

  // Ranking de atendentes
  getAgentsRanking: async (days = 7, sector = null) => {
    const sectorCondition = sector && sector !== '' && sector !== 'all' ? 'AND q.sector = ?' : '';
    const params = [days];
    if (sectorCondition) params.push(sector);

    const query = `
      SELECT 
        u.name,
        u.sector,
        COUNT(*) as total_chats,
        COUNT(CASE WHEN q.status = 'finished' THEN 1 END) as finished_chats,
        AVG(CASE WHEN q.status = 'finished' AND q.started_at IS NOT NULL AND q.finished_at IS NOT NULL 
            THEN TIMESTAMPDIFF(MINUTE, q.started_at, q.finished_at) END) as avg_time,
        AVG(CASE WHEN q.started_at IS NOT NULL 
            THEN TIMESTAMPDIFF(MINUTE, q.created_at, q.started_at) END) as avg_wait_time
      FROM queues q
      JOIN users u ON q.user_id = u.id
      WHERE q.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) 
        AND q.user_id IS NOT NULL ${sectorCondition}
      GROUP BY u.id, u.name, u.sector
      ORDER BY finished_chats DESC, avg_time ASC
      LIMIT 10
    `;

    const results = await db.query(query, params);
    
    return results.map(agent => ({
      name: agent.name,
      sector: agent.sector,
      totalChats: agent.total_chats,
      finishedChats: agent.finished_chats,
      avgTime: Math.round(agent.avg_time || 0),
      avgWaitTime: Math.round(agent.avg_wait_time || 0),
      efficiency: agent.total_chats > 0 ? Math.round((agent.finished_chats / agent.total_chats) * 100) : 0
    }));
  },

  // Top tags utilizadas
  getTopTags: async (limit = 5, sector = null) => {
    const sectorCondition = sector && sector !== '' && sector !== 'all' ? 'AND (ct.sector = ? OR ct.sector IS NULL)' : '';
    const params = [limit];
    if (sectorCondition) params.push(sector);

    const query = `
      SELECT 
        ct.name,
        ct.color,
        ct.sector,
        COUNT(ctr.contact_id) as usage_count
      FROM contact_tags ct
      JOIN contact_tag_relations ctr ON ct.id = ctr.tag_id
      WHERE 1=1 ${sectorCondition}
      GROUP BY ct.id, ct.name, ct.color, ct.sector
      ORDER BY usage_count DESC
      LIMIT ?
    `;

    return await db.query(query, params);
  }
};

// Helpers gerais
const generalHelpers = {
  // Sleep/delay
  sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

  // Gerar código aleatório
  generateCode: (length = 6) => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  },

  // Paginar resultados
  paginate: (array, page = 1, perPage = 20) => {
    const offset = (page - 1) * perPage;
    const items = array.slice(offset, offset + perPage);
    
    return {
      items,
      currentPage: page,
      perPage,
      total: array.length,
      totalPages: Math.ceil(array.length / perPage)
    };
  }
};

// Helpers de horário comercial
const businessHoursHelpers = {
  // Verificar se está dentro do horário comercial
  isBusinessHours: async () => {
    try {
      const { db } = require('./database');
      const enabled = await db.settings.get('business_hours_enabled');
      if (!enabled) return true; // Se desabilitado, sempre considera horário comercial
      
      const schedule = await db.settings.get('business_hours_schedule');
      const holidays = await db.settings.get('business_hours_holidays') || [];
      const exceptions = await db.settings.get('business_hours_exceptions') || [];
      
      const now = new Date();
      const today = now.toISOString().split('T')[0]; // YYYY-MM-DD
      const currentTime = now.toTimeString().slice(0, 5); // HH:MM
      
      // Usar array com nomes dos dias em inglês
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const dayName = dayNames[now.getDay()]; // 0 = domingo, 1 = segunda, etc.
      
      // Verificar se é feriado
      const isHoliday = holidays.some(holiday => holiday.date === today);
      if (isHoliday) return false;
      
      // Verificar exceções específicas para hoje
      const todayException = exceptions.find(exc => exc.date === today);
      if (todayException) {
        if (!todayException.enabled) return false;
        return currentTime >= todayException.start && currentTime <= todayException.end;
      }
      
      // Verificar horário normal do dia da semana
      const daySchedule = schedule[dayName];
      if (!daySchedule || !daySchedule.enabled) return false;
      
      return currentTime >= daySchedule.start && currentTime <= daySchedule.end;
      
    } catch (error) {
      console.error('Erro ao verificar horário comercial:', error);
      return true; // Em caso de erro, considera que está aberto
    }
  },
  
  // Obter próximo horário de funcionamento
  getNextBusinessHours: async () => {
    try {
      const { db } = require('./database');
      const schedule = await db.settings.get('business_hours_schedule');
      const holidays = await db.settings.get('business_hours_holidays') || [];
      const exceptions = await db.settings.get('business_hours_exceptions') || [];
      
      const now = new Date();
      
      // Nomes dos dias em português para retorno
      const dayNamesPortuguese = {
        sunday: 'Domingo',
        monday: 'Segunda-feira',
        tuesday: 'Terça-feira',
        wednesday: 'Quarta-feira',
        thursday: 'Quinta-feira',
        friday: 'Sexta-feira',
        saturday: 'Sábado'
      };
      
      // Nomes dos dias em inglês para o schedule
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      
      // Verificar os próximos 7 dias
      for (let i = 0; i < 7; i++) {
        const checkDate = new Date(now);
        checkDate.setDate(checkDate.getDate() + i);
        
        const dateStr = checkDate.toISOString().split('T')[0];
        const dayName = dayNames[checkDate.getDay()];
        
        // Verificar se é feriado
        const isHoliday = holidays.some(holiday => holiday.date === dateStr);
        if (isHoliday) continue;
        
        // Verificar exceções
        const exception = exceptions.find(exc => exc.date === dateStr);
        if (exception) {
          if (!exception.enabled) continue;
          return {
            date: dateStr,
            start: exception.start,
            end: exception.end,
            dayName: dayNamesPortuguese[dayName]
          };
        }
        
        // Verificar horário normal
        const daySchedule = schedule[dayName];
        if (daySchedule && daySchedule.enabled) {
          return {
            date: dateStr,
            start: daySchedule.start,
            end: daySchedule.end,
            dayName: dayNamesPortuguese[dayName]
          };
        }
      }
      
      return null; // Não encontrou próximo horário
      
    } catch (error) {
      console.error('Erro ao obter próximo horário:', error);
      return null;
    }
  },
  
  // Processar variáveis na mensagem de horário comercial
  processBusinessHoursMessage: async (message) => {
    try {
      const { db } = require('./database');
      const schedule = await db.settings.get('business_hours_schedule');
      const nextHours = await businessHoursHelpers.getNextBusinessHours();
      
      // Gerar resumo dos horários
      let scheduleText = '';
      const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
      const dayNames = {
        monday: 'Segunda',
        tuesday: 'Terça', 
        wednesday: 'Quarta',
        thursday: 'Quinta',
        friday: 'Sexta',
        saturday: 'Sábado',
        sunday: 'Domingo'
      };
      
      days.forEach(day => {
        const daySchedule = schedule[day];
        if (daySchedule && daySchedule.enabled) {
          scheduleText += `${dayNames[day]}: ${daySchedule.start} às ${daySchedule.end}\n`;
        } else {
          scheduleText += `${dayNames[day]}: Fechado\n`;
        }
      });
      
      // Substituir variáveis
      let processedMessage = message
        .replace(/\{\{horarios\}\}/g, scheduleText.trim())
        .replace(/\{\{proximo_funcionamento\}\}/g, nextHours ? 
          `${nextHours.dayName} às ${nextHours.start}` : 'A definir')
        .replace(/\{\{data_atual\}\}/g, new Date().toLocaleDateString('pt-BR'))
        .replace(/\{\{hora_atual\}\}/g, new Date().toLocaleTimeString('pt-BR', { 
          hour: '2-digit', minute: '2-digit' 
        }));
      
      return processedMessage;
      
    } catch (error) {
      console.error('Erro ao processar mensagem:', error);
      return message;
    }
  }
};

// Helpers de campanha e disparos
const campaignHelpers = {
  // Processar variáveis em mensagens de campanha
  processMessageVariables: (message, contact, customVars = {}) => {
    const now = new Date();
    
    // Variáveis padrão
    const variables = {
      nome: contact.name || contact.number.split('@')[0] || 'Cliente',
      numero: contact.number,
      telefone: contact.number.replace('@c.us', '').replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3'),
      data: now.toLocaleDateString('pt-BR'),
      hora: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
      dia: now.toLocaleDateString('pt-BR', { weekday: 'long' }),
      mes: now.toLocaleDateString('pt-BR', { month: 'long' }),
      ano: now.getFullYear().toString(),
      saudacao: campaignHelpers.getSaudacao(),
      ...customVars // Variáveis personalizadas sobrescrevem as padrão
    };
    
    // Substituir todas as variáveis
    let processedMessage = message;
    Object.keys(variables).forEach(key => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      processedMessage = processedMessage.replace(regex, variables[key]);
    });
    
    return processedMessage;
  },
  
  // Obter saudação baseada no horário
  getSaudacao: () => {
    const hour = new Date().getHours();
    
    if (hour >= 5 && hour < 12) return 'Bom dia';
    if (hour >= 12 && hour < 18) return 'Boa tarde';
    return 'Boa noite';
  },
  
  // Validar agendamento
  validateSchedule: (scheduledAt) => {
    const now = new Date();
    const scheduleDate = new Date(scheduledAt);
    
    if (scheduleDate <= now) {
      return { valid: false, error: 'Data deve ser no futuro' };
    }
    
    // Não permitir mais de 30 dias no futuro
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + 30);
    
    if (scheduleDate > maxDate) {
      return { valid: false, error: 'Data não pode ser mais de 30 dias no futuro' };
    }
    
    return { valid: true };
  },
  
  // Calcular estimativa de tempo de envio
  calculateSendTime: (totalContacts, delaySeconds = 5) => {
    const totalMinutes = Math.ceil((totalContacts * delaySeconds) / 60);
    
    if (totalMinutes < 60) {
      return `${totalMinutes} minuto${totalMinutes > 1 ? 's' : ''}`;
    }
    
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    
    let result = `${hours} hora${hours > 1 ? 's' : ''}`;
    if (minutes > 0) {
      result += ` e ${minutes} minuto${minutes > 1 ? 's' : ''}`;
    }
    
    return result;
  },
  
  // Obter variáveis disponíveis para campanhas
  getAvailableVariables: () => {
    const now = new Date();
    
    return {
      nome: {
        description: 'Nome do contato',
        example: 'João Silva',
        value: '{{nome}}'
      },
      numero: {
        description: 'Número do WhatsApp',
        example: '5511999999999@c.us',
        value: '{{numero}}'
      },
      telefone: {
        description: 'Telefone formatado',
        example: '(11) 99999-9999',
        value: '{{telefone}}'
      },
      saudacao: {
        description: 'Saudação automática (Bom dia/Boa tarde/Boa noite)',
        example: campaignHelpers.getSaudacao(),
        value: '{{saudacao}}'
      },
      data: {
        description: 'Data atual',
        example: now.toLocaleDateString('pt-BR'),
        value: '{{data}}'
      },
      hora: {
        description: 'Hora atual',
        example: now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        value: '{{hora}}'
      },
      dia: {
        description: 'Dia da semana',
        example: now.toLocaleDateString('pt-BR', { weekday: 'long' }),
        value: '{{dia}}'
      },
      mes: {
        description: 'Mês atual',
        example: now.toLocaleDateString('pt-BR', { month: 'long' }),
        value: '{{mes}}'
      },
      ano: {
        description: 'Ano atual',
        example: now.getFullYear().toString(),
        value: '{{ano}}'
      }
    };
  }
};

module.exports = {
  // Auth
  generateToken,
  verifyToken,
  authMiddleware,
  adminMiddleware,
  supervisorMiddleware,
  
  // Helpers
  sectorHelpers,
  uploadHelpers,
  messageHelpers,
  validationHelpers,
  reportHelpers,
  generalHelpers,
  businessHoursHelpers,
  campaignHelpers
};