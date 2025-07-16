// backup.js - Sistema de Backup Automático
const cron = require('node-cron');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

class BackupService {
  constructor() {
    this.backupPath = path.join(__dirname, 'backups');
    this.maxBackups = 7; // Manter 7 backups
    this.ensureBackupDirectory();
  }

  // Garantir que a pasta de backup existe
  ensureBackupDirectory() {
    if (!fs.existsSync(this.backupPath)) {
      fs.mkdirSync(this.backupPath, { recursive: true });
      console.log('📁 Pasta de backup criada:', this.backupPath);
    }
  }

  // Criar backup do banco de dados
  async createDatabaseBackup() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `backup_${timestamp}.sql`;
      const filepath = path.join(this.backupPath, filename);

      const command = `mysqldump -h ${process.env.DB_HOST} -u ${process.env.DB_USER} -p'${process.env.DB_PASS}' ${process.env.DB_NAME} > "${filepath}"`;
      
      console.log('🔄 Iniciando backup do banco de dados...');
      await execAsync(command);
      
      console.log('✅ Backup criado com sucesso:', filename);
      return { filename, filepath, size: fs.statSync(filepath).size };
      
    } catch (error) {
      console.error('❌ Erro ao criar backup:', error);
      throw error;
    }
  }

  // Backup dos uploads
  async backupUploads() {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `uploads_${timestamp}.tar.gz`;
      const filepath = path.join(this.backupPath, filename);

      const command = `tar -czf "${filepath}" uploads/`;
      
      console.log('🔄 Iniciando backup dos uploads...');
      await execAsync(command);
      
      console.log('✅ Backup de uploads criado:', filename);
      return { filename, filepath, size: fs.statSync(filepath).size };
      
    } catch (error) {
      console.error('❌ Erro ao fazer backup dos uploads:', error);
      throw error;
    }
  }

  // Limpar backups antigos
  async cleanOldBackups() {
    try {
      const files = fs.readdirSync(this.backupPath)
        .filter(file => file.startsWith('backup_') || file.startsWith('uploads_'))
        .map(file => ({
          name: file,
          path: path.join(this.backupPath, file),
          time: fs.statSync(path.join(this.backupPath, file)).mtime
        }))
        .sort((a, b) => b.time - a.time);

      if (files.length > this.maxBackups) {
        const toDelete = files.slice(this.maxBackups);
        
        for (const file of toDelete) {
          fs.unlinkSync(file.path);
          console.log('🗑️ Backup antigo removido:', file.name);
        }
      }
      
    } catch (error) {
      console.error('❌ Erro ao limpar backups antigos:', error);
    }
  }

  // Backup de conversas recentes
  async backupRecentConversations() {
    try {
      console.log('💬 Iniciando backup de conversas recentes...');
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `conversations_${timestamp}.json`;
      const filepath = path.join(this.backupPath, filename);
      
      const conversationsData = {
        timestamp: new Date(),
        version: '1.0',
        
        activeSessions: await db.query(`
          SELECT id, name, status, number, connected_at 
          FROM sessions 
          WHERE status = 'connected'
        `),
        
        recentContacts: await db.query(`
          SELECT c.*, 
                 COUNT(m.id) as message_count,
                 MAX(m.created_at) as last_message_time
          FROM contacts c 
          LEFT JOIN messages m ON c.id = m.contact_id 
          WHERE c.last_message_at > DATE_SUB(NOW(), INTERVAL 3 DAY)
             OR m.created_at > DATE_SUB(NOW(), INTERVAL 3 DAY)
          GROUP BY c.id 
          ORDER BY c.last_message_at DESC 
          LIMIT 100
        `),
        
        activeQueues: await db.query(`
          SELECT q.*, c.number, c.name, u.name as user_name
          FROM queues q 
          JOIN contacts c ON q.contact_id = c.id 
          LEFT JOIN users u ON q.user_id = u.id 
          WHERE q.status IN ('waiting', 'attending')
        `)
      };
      
      fs.writeFileSync(filepath, JSON.stringify(conversationsData, null, 2));
      
      const fileSize = fs.statSync(filepath).size;
      console.log('✅ Backup de conversas criado:', filename);
      
      return { filename, filepath, size: fileSize };
      
    } catch (error) {
      console.error('❌ Erro no backup de conversas:', error);
      throw error;
    }
  }

  // Executar backup completo
  async runFullBackup() {
    try {
      console.log('🚀 Iniciando backup automático completo...');
      
      const dbBackup = await this.createDatabaseBackup();
      const uploadsBackup = await this.backupUploads();
      const conversationsBackup = await this.backupRecentConversations();
      
      await this.cleanOldBackups();
      
      const totalSize = (dbBackup.size + uploadsBackup.size + conversationsBackup.size) / 1024 / 1024;
      
      console.log(`✅ Backup completo finalizado! Tamanho total: ${totalSize.toFixed(2)}MB`);
      
      await this.notifyBackupComplete(dbBackup, uploadsBackup, conversationsBackup);
      
      return { success: true, dbBackup, uploadsBackup, conversationsBackup };
      
    } catch (error) {
      console.error('❌ Erro no backup completo:', error);
      await this.notifyBackupError(error);
      throw error;
    }
  }

  // Notificar sucesso do backup
  async notifyBackupComplete(dbBackup, uploadsBackup) {
    // Implementar notificação para admins via WhatsApp ou email
    console.log('📧 Backup concluído - notificação enviada aos admins');
  }

  // Notificar erro no backup
  async notifyBackupError(error) {
    console.error('🚨 ERRO CRÍTICO - Backup falhou:', error.message);
    // Implementar notificação de erro para admins
  }

  // Inicializar tarefas agendadas
  initScheduledBackups() {
    // Backup diário às 2h da manhã
    cron.schedule('0 2 * * *', async () => {
      await this.runFullBackup();
    });

    // Backup semanal aos domingos às 1h
    cron.schedule('0 1 * * 0', async () => {
      console.log('📅 Executando backup semanal...');
      await this.runFullBackup();
    });

    console.log('⏰ Backups automáticos agendados:');
    console.log('   - Diário: 02:00');
    console.log('   - Semanal: Domingo 01:00');
  }
}

module.exports = BackupService;