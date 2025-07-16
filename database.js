// database.js - Conexão MySQL e Models
const mysql = require('mysql2');
const util = require('util');
const bcrypt = require('bcryptjs');
require('dotenv').config();

// Criar pool de conexões
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4'
});

const promisePool = pool.promise();

// ✅ FUNÇÃO AUXILIAR PARA PARSING JSON SEGURO
const safeJsonParse = (jsonString, defaultValue = []) => {
  try {
    if (Array.isArray(jsonString) || typeof jsonString === 'object') {
      return jsonString || defaultValue;
    }
    if (!jsonString || jsonString.trim() === '') {
      return defaultValue;
    }
    const parsed = JSON.parse(jsonString);
    return parsed || defaultValue;
  } catch (error) {
    console.error('Erro ao fazer parse JSON:', error.message);
    return defaultValue;
  }
};

// ✅ FUNÇÃO QUERY CORRIGIDA - USA .query() EM VEZ DE .execute()
const query = async (sql, params = []) => {
  try {
    const safeParams = Array.isArray(params)
      ? params.map(p => p === undefined ? null : p)
      : [];

    // ✅ MUDANÇA PRINCIPAL: Usar .query() em vez de .execute()
    const [results] = await promisePool.query(sql, safeParams);
    return results;
    
  } catch (error) {
    console.error('❌ Erro na query:', error.message);
    console.error('❌ SQL:', sql.substring(0, 200));
    throw error;
  }
};

// ✅ FUNÇÃO columnExists CORRIGIDA
async function columnExists(tableName, columnName) {
  try {
    const [rows] = await promisePool.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [tableName, columnName]
    );
    const exists = rows.length > 0;
    console.log(`🔍 Coluna ${columnName} na tabela ${tableName}: ${exists ? 'EXISTS' : 'NOT EXISTS'}`);
    return exists;
  } catch (error) {
    console.log(`❌ Erro ao verificar coluna ${columnName}:`, error.message);
    return true; // Se der erro, assume que existe para evitar tentar criar
  }
}

// Criar tabelas se não existirem
const createTables = async () => {
  try {
    // Tabela de usuários
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        role ENUM('admin', 'supervisor', 'atendente') DEFAULT 'atendente',
        sector VARCHAR(50),
        signature TEXT,
        avatar VARCHAR(255),
        is_active TINYINT(1) DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de sessões WhatsApp
    await query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        number VARCHAR(20),
        qrcode TEXT,
        status ENUM('disconnected', 'connecting', 'connected') DEFAULT 'disconnected',
        connected_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de contatos
    await query(`
      CREATE TABLE IF NOT EXISTS contacts (
          id INT(11) AUTO_INCREMENT PRIMARY KEY,
          number VARCHAR(20) UNIQUE NOT NULL,
          name VARCHAR(100),
          avatar VARCHAR(255),
          avatar_updated_at DATETIME,
          tags TEXT,
          sector VARCHAR(50),
          notes TEXT,
          last_message TEXT,
          last_message_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de mensagens
    await query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        session_id INT(11),
        contact_id INT(11),
        user_id INT(11),
        content TEXT,
        type ENUM('text', 'image', 'audio', 'video', 'document', 'location', 'contact', 'sticker') DEFAULT 'text',
        media_url VARCHAR(255),
        is_from_me TINYINT(1) DEFAULT 0,
        status VARCHAR(20),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_contact (contact_id),
        INDEX idx_session (session_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de filas
    await query(`
      CREATE TABLE IF NOT EXISTS queues (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        contact_id INT(11),
        sector VARCHAR(50),
        status ENUM('waiting', 'attending', 'finished', 'transferred') DEFAULT 'waiting',
        priority INT(11) DEFAULT 0,
        user_id INT(11),
        assigned_user_id INT(11),
        started_at DATETIME,
        finished_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_status_sector (status, sector),
        INDEX idx_assigned_user (assigned_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de respostas rápidas
    await query(`
      CREATE TABLE IF NOT EXISTS quick_replies (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        sector VARCHAR(50),
        title VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        shortcut VARCHAR(20),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de campanhas (melhorada para disparos por tags)
    await query(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        media_url VARCHAR(255),
        media_type ENUM('image', 'video', 'audio', 'document') NULL,
        target_tags JSON,
        target_sectors JSON,
        scheduled_at DATETIME,
        started_at DATETIME,
        finished_at DATETIME,
        status ENUM('draft', 'scheduled', 'sending', 'sent', 'cancelled', 'paused') DEFAULT 'draft',
        sent_count INT(11) DEFAULT 0,
        total_count INT(11) DEFAULT 0,
        failed_count INT(11) DEFAULT 0,
        created_by INT(11),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
        
    // Tabela de log de disparos
    await query(`
      CREATE TABLE IF NOT EXISTS campaign_logs (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        campaign_id INT(11) NOT NULL,
        contact_id INT(11) NOT NULL,
        contact_number VARCHAR(20) NOT NULL,
        contact_name VARCHAR(100),
        message_content TEXT,
        status ENUM('pending', 'sent', 'failed', 'delivered', 'read') DEFAULT 'pending',
        sent_at DATETIME,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_campaign (campaign_id),
        INDEX idx_contact (contact_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    
    console.log('✅ Tabelas de campanhas criadas/atualizadas');

    // Tabela de enquetes/polls
    await query(`
      CREATE TABLE IF NOT EXISTS polls (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        contact_id INT(11) NOT NULL,
        user_id INT(11) NOT NULL,
        question TEXT NOT NULL,
        options JSON NOT NULL,
        poll_type ENUM('single', 'multiple') DEFAULT 'single',
        message_id VARCHAR(100),
        status ENUM('active', 'closed', 'expired') DEFAULT 'active',
        expires_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_contact (contact_id),
        INDEX idx_user (user_id),
        INDEX idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Tabela de respostas das enquetes
    await query(`
      CREATE TABLE IF NOT EXISTS poll_responses (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        poll_id INT(11) NOT NULL,
        contact_id INT(11) NOT NULL,
        selected_options JSON NOT NULL,
        response_text TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_poll (poll_id),
        INDEX idx_contact (contact_id),
        UNIQUE KEY unique_poll_response (poll_id, contact_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('✅ Tabelas de enquetes criadas/atualizadas');

    // Tabela de anotações de contatos
    await query(`
      CREATE TABLE IF NOT EXISTS contact_notes (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        contact_id INT(11) NOT NULL,
        user_id INT(11) NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_contact (contact_id),
        INDEX idx_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    // Migração: Adicionar campo notes se não existir
    try {
      if (!(await columnExists('contacts', 'notes'))) {
        await query('ALTER TABLE contacts ADD COLUMN notes TEXT');
        console.log('✅ Campo notes adicionado à tabela contacts');
      } else {
        console.log('✅ Campo notes já existe na tabela contacts');
      }
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log('✅ Campo notes já existe na tabela contacts');
      } else {
        console.error('Erro ao adicionar campo notes:', error.message);
      }
    }

    // Criar tabela de tags se não existir
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS contact_tags (
          id INT(11) AUTO_INCREMENT PRIMARY KEY,
          name VARCHAR(50) NOT NULL UNIQUE,
          color VARCHAR(7) DEFAULT '#6c757d',
          sector VARCHAR(50),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('✅ Tabela contact_tags criada/verificada');
    } catch (error) {
      console.error('Erro ao criar tabela contact_tags:', error.message);
    }
    
    // Criar tabela de relacionamento contato-tags
    try {
      await query(`
        CREATE TABLE IF NOT EXISTS contact_tag_relations (
          id INT(11) AUTO_INCREMENT PRIMARY KEY,
          contact_id INT(11) NOT NULL,
          tag_id INT(11) NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_contact_tag (contact_id, tag_id),
          INDEX idx_contact (contact_id),
          INDEX idx_tag (tag_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);
      console.log('✅ Tabela contact_tag_relations criada/verificada');
    } catch (error) {
      console.error('Erro ao criar tabela contact_tag_relations:', error.message);
    }
    
    // Inserir tags padrão se não existirem
    try {
      const existingTags = await query('SELECT COUNT(*) as count FROM contact_tags');
      if (existingTags[0].count === 0) {
        await query(`
          INSERT INTO contact_tags (name, color, sector) VALUES
          ('Cliente VIP', '#dc3545', 'Geral'),
          ('Problema', '#fd7e14', 'Geral'),
          ('Dúvida', '#20c997', 'Geral'),
          ('Orçamento', '#0d6efd', 'Geral'),
          ('Reclamação', '#dc3545', 'Geral'),
          ('Elogio', '#198754', 'Geral'),
          ('Urgente', '#dc3545', 'Geral'),
          ('Seguimento', '#6f42c1', 'Geral')
        `);
        console.log('✅ Tags padrão criadas');
      }
    } catch (error) {
      console.error('Erro ao criar tags padrão:', error.message);
    }

    // Migração: Adicionar campo started_at se não existir
     try {
      if (!(await columnExists('campaigns', 'started_at'))) {
        await query('ALTER TABLE campaigns ADD COLUMN started_at DATETIME NULL');
        console.log('✅ Campo started_at adicionado à tabela campaigns');
      } else {
        console.log('✅ Campo started_at já existe na tabela campaigns');
      }
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log('✅ Campo started_at já existe na tabela campaigns');
      } else {
        console.error('Erro ao adicionar campo started_at:', error.message);
      }
    }

    // Migração: Adicionar campo finished_at se não existir
    try {
      await query('ALTER TABLE campaigns ADD COLUMN finished_at DATETIME NULL');
      console.log('✅ Campo finished_at adicionado à tabela campaigns');
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log('✅ Campo finished_at já existe na tabela campaigns');
      } else {
        console.error('Erro ao adicionar campo finished_at:', error.message);
      }
    }

    // Migração: Adicionar campo failed_count se não existir
    try {
      await query('ALTER TABLE campaigns ADD COLUMN failed_count INT(11) DEFAULT 0');
      console.log('✅ Campo failed_count adicionado à tabela campaigns');
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log('✅ Campo failed_count já existe na tabela campaigns');
      } else {
        console.error('Erro ao adicionar campo failed_count:', error.message);
      }
    }

    // Migração: Adicionar campo avatar_updated_at se não existir
    try {
      await query('ALTER TABLE contacts ADD COLUMN avatar_updated_at DATETIME NULL');
      console.log('✅ Campo avatar_updated_at adicionado à tabela contacts');
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log('✅ Campo avatar_updated_at já existe na tabela contacts');
      } else {
        console.error('Erro ao adicionar campo avatar_updated_at:', error.message);
      }
    }

    // Migração: Adicionar campo assigned_user_id se não existir
    try {
      await query('ALTER TABLE queues ADD COLUMN assigned_user_id INT(11) NULL');
      console.log('✅ Campo assigned_user_id adicionado à tabela queues');
    } catch (error) {
      if (error.code === 'ER_DUP_FIELDNAME') {
        console.log('✅ Campo assigned_user_id já existe na tabela queues');
      } else {
        console.error('Erro ao adicionar campo assigned_user_id:', error.message);
      }
    }

    // Tabela de configurações do sistema
    await query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        id INT(11) AUTO_INCREMENT PRIMARY KEY,
        setting_key VARCHAR(100) UNIQUE NOT NULL,
        setting_value TEXT,
        setting_type ENUM('string', 'json', 'boolean', 'number') DEFAULT 'string',
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    console.log('✅ Tabela system_settings criada/verificada');

    // Inserir configurações padrão de horário
    try {
      const existingSettings = await query('SELECT COUNT(*) as count FROM system_settings WHERE setting_key LIKE "business_hours%"');
      if (existingSettings[0].count === 0) {
        await query(`
          INSERT INTO system_settings (setting_key, setting_value, setting_type, description) VALUES
          ('business_hours_enabled', 'true', 'boolean', 'Habilitar auto-resposta fora do horário'),
          ('business_hours_schedule', '{"monday":{"enabled":true,"start":"08:00","end":"18:00"},"tuesday":{"enabled":true,"start":"08:00","end":"18:00"},"wednesday":{"enabled":true,"start":"08:00","end":"18:00"},"thursday":{"enabled":true,"start":"08:00","end":"18:00"},"friday":{"enabled":true,"start":"08:00","end":"18:00"},"saturday":{"enabled":true,"start":"08:00","end":"12:00"},"sunday":{"enabled":false,"start":"08:00","end":"18:00"}}', 'json', 'Horários de funcionamento por dia da semana'),
          ('business_hours_message', 'Olá! Nossa farmácia está fechada no momento. 🏪\\n\\n📅 Horário de funcionamento:\\nSegunda a Sexta: 8h às 18h\\nSábado: 8h às 12h\\nDomingo: Fechado\\n\\nSua mensagem foi registrada e responderemos assim que possível. Para emergências, ligue para (11) 99999-9999.', 'string', 'Mensagem enviada fora do horário comercial'),
          ('business_hours_holidays', '[]', 'json', 'Lista de feriados (formato: [{"date":"2024-12-25","name":"Natal"}])'),
          ('business_hours_exceptions', '[]', 'json', 'Exceções de horário (formato: [{"date":"2024-12-24","start":"08:00","end":"14:00"}])')
        `);
        console.log('✅ Configurações padrão de horário comercial criadas');
      }
    } catch (error) {
      console.error('Erro ao criar configurações padrão:', error.message);
    }

    // Criar configurações padrão se não existirem
    console.log('Verificando configurações padrão...');
    
    // Verificar se já existem configurações
    const existingSettings = await query('SELECT COUNT(*) as count FROM system_settings');
    
    if (existingSettings[0].count === 0) {
      console.log('Criando configurações padrão...');
      
      // Configurações de mensagens automáticas
      await query(`INSERT INTO system_settings (setting_key, setting_value, setting_type, description) VALUES 
        ('auto_welcome_enabled', 'true', 'boolean', 'Habilitar mensagem automática de boas-vindas'),
        ('auto_welcome_message', '👋 Olá! Bem-vindo ao nosso atendimento. Em breve um de nossos atendentes irá lhe atender.', 'string', 'Mensagem de boas-vindas'),
        ('auto_welcome_after_hours', '🌙 Olá! Nosso horário de atendimento é de 8h às 18h. Sua mensagem foi registrada e será respondida assim que possível.', 'string', 'Mensagem fora do horário'),
        ('auto_welcome_business_hours', 'true', 'boolean', 'Apenas em horário comercial'),
        ('auto_goodbye_enabled', 'true', 'boolean', 'Habilitar mensagem automática de despedida'),
        ('auto_goodbye_message', '👋 Agradecemos seu contato! Caso precise de algo mais, estamos à disposição.', 'string', 'Mensagem de despedida'),
        ('auto_goodbye_signature', 'true', 'boolean', 'Incluir assinatura do atendente'),
        ('auto_goodbye_rating', 'false', 'boolean', 'Incluir pedido de avaliação'),
        ('auto_message_delay', '2', 'number', 'Delay entre mensagens (segundos)'),
        ('auto_prevent_spam', 'true', 'boolean', 'Prevenir spam'),
        ('auto_spam_interval', '5', 'number', 'Intervalo anti-spam (minutos)'),
        ('auto_log_messages', 'true', 'boolean', 'Registrar mensagens automáticas'),
        ('auto_show_signature', 'false', 'boolean', 'Mostrar assinatura automática')
      `);
      
      console.log('✅ Configurações padrão criadas');
    }

    // Criar usuário admin padrão se não existir
    const adminExists = await query('SELECT id FROM users WHERE email = ?', ['admin@admin.com']);
    if (adminExists.length === 0) {
      const hashedPassword = await bcrypt.hash('admin123', 10);
      await query(
        'INSERT INTO users (name, email, password, role, sector) VALUES (?, ?, ?, ?, ?)',
        ['Administrador', 'admin@admin.com', hashedPassword, 'admin', 'Geral']
      );
      console.log('Usuário admin criado: admin@admin.com / senha: admin123');
    }

    console.log('✅ Banco de dados configurado com sucesso!');
  } catch (error) {
    console.error('❌ Erro ao criar tabelas:', error);
    throw error;
  }
};

// Models (funções para interagir com o banco)
const db = {
  // Conexão
  pool: promisePool,
  query,

  // Usuários
  users: {
    findByEmail: async (email) => {
      const results = await query('SELECT * FROM users WHERE email = ?', [email]);
      return results[0];
    },
    findById: async (id) => {
      const results = await query('SELECT * FROM users WHERE id = ?', [id]);
      return results[0];
    },
    create: async (userData) => {
      const { name, email, password, role, sector, signature } = userData;
      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await query(
        'INSERT INTO users (name, email, password, role, sector, signature) VALUES (?, ?, ?, ?, ?, ?)',
        [name, email, hashedPassword, role || 'atendente', sector, signature]
      );
      return result.insertId;
    },
    update: async (id, userData) => {
      const fields = [];
      const values = [];
      
      Object.keys(userData).forEach(key => {
        if (key !== 'id' && key !== 'password') {
          fields.push(`${key} = ?`);
          values.push(userData[key]);
        }
      });
      
      if (userData.password) {
        fields.push('password = ?');
        values.push(await bcrypt.hash(userData.password, 10));
      }
      
      values.push(id);
      
      await query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
    },
    list: async () => {
      return await query('SELECT id, name, email, role, sector, is_active FROM users ORDER BY name');
    }
  },

  // Sessões WhatsApp
  sessions: {
    create: async (name) => {
      const result = await query(
        'INSERT INTO sessions (name, status) VALUES (?, ?)',
        [name, 'disconnected']
      );
      return result.insertId;
    },
    update: async (id, data) => {
      const fields = [];
      const values = [];
      
      Object.keys(data).forEach(key => {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      });
      
      values.push(id);
      
      await query(
        `UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`,
        values
      );
    },
    list: async () => {
      return await query('SELECT * FROM sessions ORDER BY name');
    },
    findById: async (id) => {
      const results = await query('SELECT * FROM sessions WHERE id = ?', [id]);
      return results[0];
    }
  },

  // Contatos
  contacts: {
  findOrCreate: async (number, name = null) => {
    try {
      // CORREÇÃO: Validar parâmetros de entrada
      if (!number || typeof number !== 'string') {
        throw new Error('Número do contato é obrigatório e deve ser string');
      }
      
      // Sanitizar número
      const cleanNumber = String(number).trim();
      if (!cleanNumber) {
        throw new Error('Número do contato não pode estar vazio');
      }
      
      // Sanitizar nome - CORREÇÃO: garantir que não seja undefined
      let cleanName = name;
      if (cleanName === undefined || cleanName === null || cleanName === '') {
        cleanName = cleanNumber.split('@')[0];
      } else {
        cleanName = String(cleanName).trim().substring(0, 100);
      }
      
      // Buscar contato existente
      let contact = await query('SELECT * FROM contacts WHERE number = ?', [cleanNumber]);
      
      if (contact.length === 0) {
        // CORREÇÃO: Usar INSERT com tratamento de erro
        try {
          const result = await query(
            'INSERT INTO contacts (number, name, created_at) VALUES (?, ?, NOW())',
            [cleanNumber, cleanName]
          );
          
          if (!result.insertId) {
            throw new Error('Falha ao criar contato - ID não retornado');
          }
          
          // Buscar contato recém-criado
          contact = await query('SELECT * FROM contacts WHERE id = ?', [result.insertId]);
          
          if (contact.length === 0) {
            throw new Error('Falha ao buscar contato recém-criado');
          }
          
        } catch (insertError) {
          console.error('❌ Erro ao inserir contato:', insertError);
          
          // Tentar buscar novamente (pode ter sido criado por processo concorrente)
          contact = await query('SELECT * FROM contacts WHERE number = ?', [cleanNumber]);
          
          if (contact.length === 0) {
            throw new Error(`Falha ao criar/encontrar contato: ${insertError.message}`);
          }
        }
      } else {
        // Atualizar nome se foi fornecido um nome melhor
        if (cleanName && cleanName !== cleanNumber.split('@')[0] && contact[0].name !== cleanName) {
          await query('UPDATE contacts SET name = ? WHERE id = ?', [cleanName, contact[0].id]);
          contact[0].name = cleanName;
        }
      }
      
      return contact[0];
      
    } catch (error) {
      console.error('❌ Erro em findOrCreate:', error);
      console.error('❌ Parâmetros:', { number, name });
      throw error;
    }
  },
  
  update: async (id, data) => {
    const fields = [];
    const values = [];
    
    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) { // CORREÇÃO: só adicionar se não for undefined
        fields.push(`${key} = ?`);
        values.push(data[key] === null ? null : data[key]); // Converter explicitamente
      }
    });
    
    if (fields.length === 0) {
      console.log('⚠️ Nenhum campo para atualizar');
      return;
    }
    
    values.push(id);
    
    await query(
      `UPDATE contacts SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
  },
  
  list: async (filters = {}) => {
    let sql = 'SELECT DISTINCT c.* FROM contacts c WHERE 1=1';
    const params = [];
    
    // Ignorar status@broadcast
    sql += ' AND c.number != ?';
    params.push('status@broadcast');
    
    // Filtro por tag (JOIN com tabela de relacionamento)
    if (filters.tag && filters.tag !== '' && filters.tag !== 'all') {
      sql = sql.replace('FROM contacts c', `FROM contacts c 
        JOIN contact_tag_relations ctr ON c.id = ctr.contact_id 
        JOIN contact_tags ct ON ctr.tag_id = ct.id`);
      sql += ' AND ct.id = ?';
      params.push(parseInt(filters.tag) || null); // CORREÇÃO: garantir que seja número ou null
    }
    
    if (filters.sector && filters.sector !== '' && filters.sector !== 'all') {
      sql += ' AND c.sector = ?';
      params.push(filters.sector);
    }
    
    if (filters.search && filters.search.trim() !== '') {
      const searchTerm = `%${filters.search.trim()}%`;
      sql += ' AND (c.number LIKE ? OR c.name LIKE ?)';
      params.push(searchTerm, searchTerm);
    }
    
    // ✅ CORREÇÃO PRINCIPAL: Ordenação correta
    sql += ' ORDER BY CASE WHEN c.last_message_at IS NULL THEN 1 ELSE 0 END, c.last_message_at DESC';
    
    console.log('Query contatos completa:', sql, params);
    const results = await query(sql, params);
    console.log(`Total de contatos encontrados: ${results.length}`);
    
    return results;
  }
  },

  // Mensagens
  messages: {
    create: async (messageData) => {
      const result = await query(
        'INSERT INTO messages (session_id, contact_id, user_id, content, type, media_url, is_from_me, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          messageData.session_id,
          messageData.contact_id,
          messageData.user_id || null,
          messageData.content,
          messageData.type || 'text',
          messageData.media_url || null,
          messageData.is_from_me || 0,
          messageData.status || 'sent'
        ]
      );
      return result.insertId;
    },
    getByContact: async (contactId, limit = 50) => {
      try {
        const safeContactId = parseInt(contactId);
        if (isNaN(safeContactId) || safeContactId <= 0) {
          throw new Error('ID do contato inválido');
        }
        
        const safeLimit = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
        
        // ✅ QUERY ORIGINAL SIMPLES
        const sql = `SELECT m.*, u.name as user_name, u.signature 
                     FROM messages m 
                     LEFT JOIN users u ON m.user_id = u.id 
                     WHERE m.contact_id = ? 
                     ORDER BY m.created_at DESC 
                     LIMIT ` + safeLimit;
        
        return await query(sql, [safeContactId]);
        
      } catch (error) {
        console.error('Erro ao buscar mensagens do contato:', error);
        throw error;
      }
    }
  },

  // Filas
  queues: {
    create: async (contactId, sector) => {
      // Verificar se já existe na fila
      const existing = await query(
        'SELECT id FROM queues WHERE contact_id = ? AND status IN (?, ?)',
        [contactId, 'waiting', 'attending']
      );
      
      if (existing.length > 0) {
        console.log(`Contato ${contactId} já está na fila com ID ${existing[0].id}`);
        return existing[0].id;
      }
      
      const result = await query(
        'INSERT INTO queues (contact_id, sector, status) VALUES (?, ?, ?)',
        [contactId, sector, 'waiting']
      );
      console.log(`Nova fila criada: ID ${result.insertId} para contato ${contactId}`);
      return result.insertId;
    },
    getNext: async (sector, userId) => {
      const queue = await query(
        `SELECT q.*, c.id as contact_id, c.number, c.name, c.avatar 
         FROM queues q 
         JOIN contacts c ON q.contact_id = c.id 
         WHERE q.sector = ? AND q.status = ? 
         ORDER BY q.priority DESC, q.created_at ASC 
         LIMIT 1`,
        [sector, 'waiting']
      );
      
      if (queue.length > 0) {
        await query(
          'UPDATE queues SET status = ?, user_id = ?, assigned_user_id = ?, started_at = NOW() WHERE id = ?',
          ['attending', userId, userId, queue[0].id]
        );
        
        console.log('Próximo da fila:', queue[0]);
        return queue[0];
      }
      
      return null;
    },
    transfer: async (queueId, newSector) => {
      await query(
        'UPDATE queues SET sector = ?, status = ?, user_id = NULL WHERE id = ?',
        [newSector, 'waiting', queueId]
      );
    },
    finish: async (queueId) => {
      await query(
        'UPDATE queues SET status = ?, finished_at = NOW() WHERE id = ?',
        ['finished', queueId]
      );
    },
    getStats: async (sector = null) => {
      let sql = `
        SELECT 
          COUNT(CASE WHEN status = 'waiting' THEN 1 END) as waiting,
          COUNT(CASE WHEN status = 'attending' THEN 1 END) as attending,
          COUNT(CASE WHEN status = 'finished' AND DATE(finished_at) = CURDATE() THEN 1 END) as finished_today
        FROM queues
      `;
      
      const params = [];
      if (sector) {
        sql += ' WHERE sector = ?';
        params.push(sector);
      }
      
      const results = await query(sql, params);
      return results[0];
    }
  },

  // Respostas rápidas
  quickReplies: {
    list: async (sector = null) => {
      if (sector) {
        return await query('SELECT * FROM quick_replies WHERE sector = ? OR sector IS NULL ORDER BY title', [sector]);
      }
      return await query('SELECT * FROM quick_replies ORDER BY sector, title');
    },
    create: async (data) => {
      const result = await query(
        'INSERT INTO quick_replies (sector, title, content, shortcut) VALUES (?, ?, ?, ?)',
        [data.sector, data.title, data.content, data.shortcut || null]
      );
      return result.insertId;
    }
  },

  // Campanhas (Sistema completo de disparos) - VERSÃO CORRIGIDA
  campaigns: {
    // Criar campanha
    create: async (data) => {
      try {
        console.log('💾 DB: Criando campanha:', data.name);
        console.log('💾 DB: Dados completos recebidos:', {
          name: data.name,
          target_tags: data.target_tags,
          target_sectors: data.target_sectors,
          target_tags_type: typeof data.target_tags,
          target_sectors_type: typeof data.target_sectors
        });
        
        const result = await query(
          `INSERT INTO campaigns (name, content, media_url, media_type, target_tags, target_sectors, scheduled_at, status, total_count, created_by) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            data.name, 
            data.content, 
            data.media_url || null,
            data.media_type || null,
            JSON.stringify(data.target_tags || []),
            JSON.stringify(data.target_sectors || []),
            data.scheduled_at || null, 
            data.status || 'draft',
            data.total_count || 0,
            data.created_by
          ]
        );
        
        console.log('💾 DB: Campanha criada com ID:', result.insertId);
        console.log('💾 DB: Tags salvas:', JSON.stringify(data.target_tags || []));
        console.log('💾 DB: Setores salvos:', JSON.stringify(data.target_sectors || []));
        return result.insertId;
      } catch (error) {
        console.error('💾 DB: Erro ao criar campanha:', error);
        throw error;
      }
    },

    // Listar campanhas
    list: async (limit = 50) => {
  try {
    console.log('💾 DB: Buscando campanhas...');
    
    const safeLimit = Math.max(parseInt(limit) || 50, 1);
    
    const results = await query(
      `SELECT c.*, u.name as created_by_name 
       FROM campaigns c 
       LEFT JOIN users u ON c.created_by = u.id 
       ORDER BY c.created_at DESC 
       LIMIT ?`,
      [safeLimit]
    );
    
    console.log('💾 DB: Campanhas encontradas:', results.length);
    
    // ✅ CORREÇÃO: Usar parsing seguro para todos
    return results.map(campaign => {
      campaign.target_tags = safeJsonParse(campaign.target_tags, []);
      campaign.target_sectors = safeJsonParse(campaign.target_sectors, []);
      return campaign;
    });
    
  } catch (error) {
    console.error('💾 DB: Erro ao listar campanhas:', error);
    return []; // Retornar array vazio em caso de erro
  }
},

    // Buscar campanha por ID
    findById: async (id) => {
  try {
    const results = await query('SELECT * FROM campaigns WHERE id = ?', [id]);
    
    if (results.length === 0) {
      return null;
    }
    
    const campaign = results[0];
    
    console.log('💾 Campanha bruta do banco:', {
      id: campaign.id,
      name: campaign.name,
      target_tags_raw: campaign.target_tags,
      target_sectors_raw: campaign.target_sectors
    });
    
    // ✅ CORREÇÃO: Usar função de parsing seguro
    campaign.target_tags = safeJsonParse(campaign.target_tags, []);
    campaign.target_sectors = safeJsonParse(campaign.target_sectors, []);
    
    console.log('💾 Após parsing seguro:', {
      target_tags: campaign.target_tags,
      target_sectors: campaign.target_sectors
    });
    
    return campaign;
  } catch (error) {
    console.error('💾 DB: Erro ao buscar campanha:', error);
    throw error;
  }
},

    // Atualizar status da campanha
    updateStatus: async (id, status, counts = {}) => {
      try {
        const fields = ['status = ?'];
        const values = [status];
        
        if (counts.sent_count !== undefined) {
          fields.push('sent_count = ?');
          values.push(counts.sent_count);
        }
        
        if (counts.failed_count !== undefined) {
          fields.push('failed_count = ?');
          values.push(counts.failed_count);
        }
        
        if (status === 'sending' && !counts.started_at) {
          fields.push('started_at = NOW()');
        }
        
        if (status === 'sent' || status === 'cancelled') {
          fields.push('finished_at = NOW()');
        }
        
        values.push(id);
        
        const result = await query(
          `UPDATE campaigns SET ${fields.join(', ')} WHERE id = ?`,
          values
        );
        
        console.log('💾 DB: Status da campanha atualizado:', id, 'para:', status);
        return result;
      } catch (error) {
        console.error('💾 DB: Erro ao atualizar status da campanha:', error);
        throw error;
      }
    },

    // Obter contatos por tags/setores - VERSÃO CORRIGIDA
    getTargetContacts: async (tags = [], sectors = []) => {
      try {
        console.log('💾 DB: 🔍 Filtrando contatos por tags:', tags, 'setores:', sectors);
        
        // Se não há tags nem setores, retornar array vazio
        if (tags.length === 0 && sectors.length === 0) {
          console.log('💾 DB: ❌ Nenhuma tag ou setor selecionado');
          return [];
        }
        
        let sql = 'SELECT DISTINCT c.* FROM contacts c';
        const params = [];
        const conditions = [];
        
        // Ignorar broadcasts e números de status
        conditions.push("c.number != 'status@broadcast'");
        conditions.push("c.number NOT LIKE '%@g.us'"); // Ignorar grupos
        
        // LÓGICA CORRIGIDA: Filtros independentes
        // Se há tags selecionadas, filtrar por tags
        if (tags.length > 0) {
          sql += ` JOIN contact_tag_relations ctr ON c.id = ctr.contact_id
                   JOIN contact_tags ct ON ctr.tag_id = ct.id`;
          
          // Criar placeholders para as tags
          const tagPlaceholders = tags.map(() => '?').join(',');
          conditions.push(`ct.id IN (${tagPlaceholders})`);
          
          // Adicionar tags aos parâmetros
          tags.forEach(tag => {
            params.push(parseInt(tag)); // Garantir que é número
          });
        }
        
        // Se há setores selecionados E não há tags, filtrar por setores
        // Se há setores E tags, adicionar filtro de setor como AND
        if (sectors.length > 0) {
          const sectorPlaceholders = sectors.map(() => '?').join(',');
          conditions.push(`c.sector IN (${sectorPlaceholders})`);
          
          // Adicionar setores aos parâmetros
          sectors.forEach(sector => {
            params.push(sector);
          });
        }
        
        // Construir WHERE clause
        sql += ` WHERE ${conditions.join(' AND ')}`;
        sql += ' ORDER BY c.name, c.number';
        
        console.log('💾 DB: 📋 Query final:', sql);
        console.log('💾 DB: 📋 Parâmetros:', params);
        
        const results = await query(sql, params);
        console.log(`💾 DB: ✅ Contatos filtrados encontrados: ${results.length}`);
        
        // Filtrar contatos válidos (com número válido)
        const validContacts = results.filter(contact => {
          return contact.number && 
                 contact.number.includes('@c.us') && 
                 contact.number !== 'status@broadcast';
        });
        
        console.log(`💾 DB: ✅ Contatos válidos após filtro: ${validContacts.length}`);
        
        return validContacts;
      } catch (error) {
        console.error('💾 DB: ❌ Erro ao obter contatos alvo:', error);
        throw error;
      }
    },

    // Estatísticas da campanha
    getStats: async (campaignId) => {
      try {
        const results = await query(`
          SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN status = 'sent' THEN 1 END) as sent,
            COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
            COUNT(CASE WHEN status = 'delivered' THEN 1 END) as delivered,
            COUNT(CASE WHEN status = 'read' THEN 1 END) as read_messages,
            COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending
          FROM campaign_logs 
          WHERE campaign_id = ?
        `, [campaignId]);
        
        const result = results[0] || {
          total: 0, sent: 0, failed: 0, delivered: 0, read_messages: 0, pending: 0
        };
        
        // Renomear para compatibilidade com frontend
        return {
          total: result.total,
          sent: result.sent,
          failed: result.failed,
          delivered: result.delivered,
          read: result.read_messages,
          pending: result.pending
        };
      } catch (error) {
        console.error('💾 DB: Erro ao obter estatísticas da campanha:', error);
        throw error;
      }
    }
  },

  // Logs de campanha - VERSÃO CORRIGIDA
  campaignLogs: {
    // Criar log de envio
    create: async (data) => {
      try {
        const result = await query(
          `INSERT INTO campaign_logs (campaign_id, contact_id, contact_number, contact_name, message_content, status) 
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            data.campaign_id, 
            data.contact_id, 
            data.contact_number, 
            data.contact_name || null, 
            data.message_content, 
            data.status || 'pending'
          ]
        );
        return result.insertId;
      } catch (error) {
        console.error('💾 DB: Erro ao criar log de campanha:', error);
        throw error;
      }
    },

    // Atualizar status do log
    updateStatus: async (logId, status, errorMessage = null) => {
      try {
        const fields = ['status = ?'];
        const values = [status];
        
        if (status === 'sent') {
          fields.push('sent_at = NOW()');
        }
        
        if (errorMessage) {
          fields.push('error_message = ?');
          values.push(errorMessage);
        }
        
        values.push(logId);
        
        await query(
          `UPDATE campaign_logs SET ${fields.join(', ')} WHERE id = ?`,
          values
        );
      } catch (error) {
        console.error('💾 DB: Erro ao atualizar status do log:', error);
        throw error;
      }
    },

    // Obter logs pendentes - VERSÃO MELHORADA
    // Obter logs pendentes - VERSÃO CORRIGIDA
getPending: async (campaignId, limit = 10) => {
  try {
    const results = await query(
      `SELECT cl.*, c.name as contact_name_updated
       FROM campaign_logs cl
       LEFT JOIN contacts c ON cl.contact_id = c.id
       WHERE cl.campaign_id = ? AND cl.status = 'pending' 
       ORDER BY cl.id ASC 
       LIMIT ?`,
      [campaignId, limit]
    );
    
    console.log(`💾 DB: Encontrados ${results.length} logs pendentes para campanha ${campaignId}`);
    return results;
  } catch (error) {
    console.error('💾 DB: Erro ao obter logs pendentes:', error);
    return []; // Retornar array vazio em caso de erro
  }
},

    // Listar logs de uma campanha
    getByCampaign: async (campaignId, limit = 100) => {
      try {
        return await query(
          `SELECT cl.*, c.name as contact_name_updated
           FROM campaign_logs cl
           LEFT JOIN contacts c ON cl.contact_id = c.id
           WHERE cl.campaign_id = ?
           ORDER BY cl.created_at DESC
           LIMIT ?`,
          [campaignId, limit]
        );
      } catch (error) {
        console.error('💾 DB: Erro ao listar logs da campanha:', error);
        throw error;
      }
    }
  },

  // Anotações de contatos
  contactNotes: {
    // Listar anotações de um contato
    getByContact: async (contactId) => {
      return await query(
        `SELECT cn.*, u.name as user_name 
         FROM contact_notes cn 
         LEFT JOIN users u ON cn.user_id = u.id 
         WHERE cn.contact_id = ? 
         ORDER BY cn.created_at DESC`,
        [contactId]
      );
    },
    
    // Criar nova anotação
    create: async (contactId, userId, content) => {
      const result = await query(
        'INSERT INTO contact_notes (contact_id, user_id, content) VALUES (?, ?, ?)',
        [contactId, userId, content]
      );
      return result.insertId;
    },
    
    // Atualizar anotação
    update: async (noteId, content) => {
      await query(
        'UPDATE contact_notes SET content = ?, updated_at = NOW() WHERE id = ?',
        [content, noteId]
      );
    },
    
    // Deletar anotação
    delete: async (noteId) => {
      await query(
        'DELETE FROM contact_notes WHERE id = ?',
        [noteId]
      );
    }
  },

  // Tags
  tags: {
    // Listar todas as tags
    list: async (sector = null) => {
      if (sector) {
        return await query('SELECT * FROM contact_tags WHERE sector = ? OR sector IS NULL ORDER BY name', [sector]);
      }
      return await query('SELECT * FROM contact_tags ORDER BY name');
    },
    
    // Criar nova tag
    create: async (name, color, sector) => {
      const result = await query(
        'INSERT INTO contact_tags (name, color, sector) VALUES (?, ?, ?)',
        [name, color || '#6c757d', sector]
      );
      return result.insertId;
    },
    
    // Obter tags de um contato
    getByContact: async (contactId) => {
      return await query(`
        SELECT t.* FROM contact_tags t
        JOIN contact_tag_relations r ON t.id = r.tag_id
        WHERE r.contact_id = ?
        ORDER BY t.name
      `, [contactId]);
    },
    
    // Adicionar tag a um contato
    addToContact: async (contactId, tagId) => {
      await query(
        'INSERT IGNORE INTO contact_tag_relations (contact_id, tag_id) VALUES (?, ?)',
        [contactId, tagId]
      );
    },
    
    // Remover tag de um contato
    removeFromContact: async (contactId, tagId) => {
      await query(
        'DELETE FROM contact_tag_relations WHERE contact_id = ? AND tag_id = ?',
        [contactId, tagId]
      );
    }
  },

  // Enquetes/Polls
  polls: {
    // Criar nova enquete
    create: async (data) => {
      const result = await query(
        `INSERT INTO polls (contact_id, user_id, question, options, poll_type, message_id, expires_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.contact_id,
          data.user_id,
          data.question,
          JSON.stringify(data.options),
          data.poll_type || 'single',
          data.message_id || null,
          data.expires_at || null
        ]
      );
      return result.insertId;
    },

    // Buscar enquete por ID
    findById: async (id) => {
      const results = await query('SELECT * FROM polls WHERE id = ?', [id]);
      if (results.length === 0) return null;
      
      const poll = results[0];
      poll.options = JSON.parse(poll.options);
      return poll;
    },

    // Buscar enquete ativa de um contato
    findActiveByContact: async (contactId) => {
      const results = await query(
        'SELECT * FROM polls WHERE contact_id = ? AND status = ? ORDER BY created_at DESC LIMIT 1',
        [contactId, 'active']
      );
      
      if (results.length === 0) return null;
      
      const poll = results[0];
      poll.options = JSON.parse(poll.options);
      return poll;
    },

    // Atualizar status da enquete
    updateStatus: async (id, status) => {
      await query('UPDATE polls SET status = ? WHERE id = ?', [status, id]);
    },

    // Buscar enquetes de um usuário
    findByUser: async (userId, limit = 50) => {
      const results = await query(
        'SELECT * FROM polls WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
        [userId, limit]
      );
      
      return results.map(poll => {
        poll.options = JSON.parse(poll.options);
        return poll;
      });
    }
  },

  // Respostas de enquetes
  pollResponses: {
    // Criar resposta
    create: async (data) => {
      const result = await query(
        `INSERT INTO poll_responses (poll_id, contact_id, selected_options, response_text) 
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE 
         selected_options = VALUES(selected_options),
         response_text = VALUES(response_text)`,
        [
          data.poll_id,
          data.contact_id,
          JSON.stringify(data.selected_options),
          data.response_text || null
        ]
      );
      return result.insertId;
    },

    // Buscar respostas de uma enquete
    findByPoll: async (pollId) => {
      const results = await query(`
        SELECT pr.*, c.name as contact_name, c.number as contact_number
        FROM poll_responses pr
        LEFT JOIN contacts c ON pr.contact_id = c.id
        WHERE pr.poll_id = ?
        ORDER BY pr.created_at ASC
      `, [pollId]);
      
      return results.map(response => {
        response.selected_options = JSON.parse(response.selected_options);
        return response;
      });
    },

    // Verificar se contato já respondeu
    hasResponded: async (pollId, contactId) => {
      const results = await query(
        'SELECT id FROM poll_responses WHERE poll_id = ? AND contact_id = ?',
        [pollId, contactId]
      );
      return results.length > 0;
    }
  },

  // Settings (Configurações do Sistema)
  settings: {
    // Obter configuração
    get: async (key) => {
      try {
        const results = await query('SELECT * FROM system_settings WHERE setting_key = ?', [key]);
        if (results.length === 0) return null;
        
        const setting = results[0];
        
        // Parse do valor baseado no tipo
        switch (setting.setting_type) {
          case 'json':
            try {
              return JSON.parse(setting.setting_value);
            } catch (e) {
              console.error(`Erro ao fazer parse JSON para setting ${key}:`, e);
              return setting.setting_value;
            }
          case 'boolean':
            return setting.setting_value === 'true' || setting.setting_value === '1' || setting.setting_value === 1;
          case 'number':
            const num = parseFloat(setting.setting_value);
            return isNaN(num) ? 0 : num;
          default:
            return setting.setting_value;
        }
      } catch (error) {
        console.error(`Erro ao obter configuração ${key}:`, error);
        return null;
      }
    },
    
    // Definir configuração
    set: async (key, value, type = 'string', description = '') => {
      try {
        let stringValue = value;
        
        // Validar e converter valor baseado no tipo
        switch (type) {
          case 'json':
            if (typeof value === 'object') {
              stringValue = JSON.stringify(value);
            } else {
              stringValue = value;
            }
            break;
          case 'boolean':
            stringValue = value ? 'true' : 'false';
            break;
          case 'number':
            const num = parseFloat(value);
            stringValue = isNaN(num) ? '0' : num.toString();
            break;
          case 'string':
          default:
            stringValue = value ? value.toString() : '';
            break;
        }
        
        await query(
          `INSERT INTO system_settings (setting_key, setting_value, setting_type, description, updated_at) 
           VALUES (?, ?, ?, ?, NOW()) 
           ON DUPLICATE KEY UPDATE 
           setting_value = VALUES(setting_value), 
           setting_type = VALUES(setting_type),
           description = VALUES(description),
           updated_at = NOW()`,
          [key, stringValue, type, description]
        );
        
        return true;
      } catch (error) {
        console.error(`Erro ao definir configuração ${key}:`, error);
        throw error;
      }
    },
    
    // Listar configurações por prefixo
    list: async (prefix = '') => {
      try {
        const sql = prefix ? 
          'SELECT * FROM system_settings WHERE setting_key LIKE ? ORDER BY setting_key' :
          'SELECT * FROM system_settings ORDER BY setting_key';
        const params = prefix ? [`${prefix}%`] : [];
        
        const results = await query(sql, params);
        const settings = {};
        
        results.forEach(setting => {
          let value = setting.setting_value;
          
          // Parse do valor baseado no tipo
          switch (setting.setting_type) {
            case 'json':
              try {
                value = JSON.parse(value);
              } catch (e) {
                console.error(`Erro ao fazer parse JSON para ${setting.setting_key}:`, e);
                value = setting.setting_value; // Manter como string se não conseguir fazer parse
              }
              break;
            case 'boolean':
              value = value === 'true' || value === '1' || value === 1;
              break;
            case 'number':
              const num = parseFloat(value);
              value = isNaN(num) ? 0 : num;
              break;
            default:
              // string mantém como está
              break;
          }
          
          settings[setting.setting_key] = {
            value,
            type: setting.setting_type,
            description: setting.description || '',
            updated_at: setting.updated_at
          };
        });
        
        return settings;
        
      } catch (error) {
        console.error('Erro ao listar configurações:', error);
        return {};
      }
    },

    // **NOVOS MÉTODOS PARA MENSAGENS AUTOMÁTICAS**
    
    // Obter todas as configurações de mensagens automáticas
    getAutoMessages: async () => {
      try {
        console.log('🔍 getAutoMessages: Iniciando busca...');
        
        // Buscar configurações com prefixo auto_
        const settings = await module.exports.db.settings.list('auto_');
        
        console.log('🔍 getAutoMessages: Settings encontrados:', Object.keys(settings));
        console.log('🔍 getAutoMessages: Welcome message:', settings.auto_welcome_message);
        console.log('🔍 getAutoMessages: Goodbye message:', settings.auto_goodbye_message);
        
        const result = {
          welcome: {
            enabled: settings.auto_welcome_enabled?.value !== false,
            message: settings.auto_welcome_message?.value || '👋 Olá! Bem-vindo ao nosso atendimento. Em breve um de nossos atendentes irá lhe atender.',
            businessHoursOnly: settings.auto_welcome_business_hours?.value !== false,
            afterHoursMessage: settings.auto_welcome_after_hours?.value || '🌙 Olá! Nosso horário de atendimento é de 8h às 18h. Sua mensagem foi registrada e será respondida assim que possível.'
          },
          goodbye: {
            enabled: settings.auto_goodbye_enabled?.value !== false,
            message: settings.auto_goodbye_message?.value || '👋 Agradecemos seu contato! Caso precise de algo mais, estamos à disposição.',
            includeSignature: settings.auto_goodbye_signature?.value !== false,
            includeRating: settings.auto_goodbye_rating?.value === true
          },
          polls: {
            autoSave: settings.polls_auto_save?.value !== false,
            autoExpire: settings.polls_auto_expire?.value !== false,
            expireTime: settings.polls_expire_time?.value || 24,
            expireAction: settings.polls_expire_action?.value || 'close',
            notifyResponse: settings.polls_notify_response?.value !== false,
            notifyCompletion: settings.polls_notify_completion?.value !== false,
            autoConfirm: settings.polls_auto_confirm?.value !== false
          },
          advanced: {
            messageDelay: settings.auto_message_delay?.value || 2,
            preventSpam: settings.auto_prevent_spam?.value !== false,
            spamInterval: settings.auto_spam_interval?.value || 5,
            logMessages: settings.auto_log_messages?.value !== false,
            showAutoSignature: settings.auto_show_signature?.value === true
          }
        };
        
        console.log('🔍 getAutoMessages: Resultado final welcome:', result.welcome.message?.substring(0, 50));
        console.log('🔍 getAutoMessages: Resultado final goodbye:', result.goodbye.message?.substring(0, 50));
        
        return result;
        
      } catch (error) {
        console.error('❌ getAutoMessages: Erro:', error);
        // Retornar configurações padrão em caso de erro
        return {
          welcome: {
            enabled: false,
            message: '👋 Olá! Bem-vindo ao nosso atendimento. Em breve um de nossos atendentes irá lhe atender.',
            businessHoursOnly: true,
            afterHoursMessage: '🌙 Olá! Nosso horário de atendimento é de 8h às 18h. Sua mensagem foi registrada e será respondida assim que possível.'
          },
          goodbye: {
            enabled: false,
            message: '👋 Agradecemos seu contato! Caso precisar de algo mais, estamos à disposição.',
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
    },

    // Deletar configuração específica
    delete: async (key) => {
      try {
        await query('DELETE FROM system_settings WHERE setting_key = ?', [key]);
        return true;
      } catch (error) {
        console.error(`Erro ao deletar configuração ${key}:`, error);
        return false;
      }
    },

    // Verificar se configuração existe
    exists: async (key) => {
      try {
        const results = await query('SELECT COUNT(*) as count FROM system_settings WHERE setting_key = ?', [key]);
        return results[0].count > 0;
      } catch (error) {
        console.error(`Erro ao verificar existência da configuração ${key}:`, error);
        return false;
      }
    }
  }
};

module.exports = {
  db,
  createTables,
  pool,
  query
};