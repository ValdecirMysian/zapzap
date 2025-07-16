// monitoring.js - Sistema de Monitoramento
const { db } = require('./database');
const fs = require('fs');
const os = require('os');

class MonitoringService {
  constructor(io) {
    this.io = io;
    this.healthChecks = [];
    this.alerts = [];
    this.startMonitoring();
  }

  // Verificar saúde do banco de dados
  async checkDatabase() {
    try {
      await db.query('SELECT 1');
      return { status: 'healthy', response_time: Date.now() };
    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }

  // Verificar sessões WhatsApp
  async checkWhatsAppSessions() {
    try {
      const sessions = await db.sessions.list();
      const connected = sessions.filter(s => s.status === 'connected').length;
      const total = sessions.length;
      
      return {
        status: connected > 0 ? 'healthy' : 'warning',
        connected,
        total,
        details: sessions.map(s => ({ id: s.id, name: s.name, status: s.status }))
      };
    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }

  // Verificar espaço em disco
async checkDiskSpace() {
  try {
    const { execSync } = require('child_process');
    
    if (process.platform === 'win32') {
      // Windows
      const output = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf8' });
      const lines = output.split('\n').filter(line => line.trim());
      
      let totalSize = 0;
      let totalFree = 0;
      
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3 && parts[0] !== 'Caption') {
          const free = parseInt(parts[1]) || 0;
          const size = parseInt(parts[2]) || 0;
          
          if (size > 0) {
            totalSize += size;
            totalFree += free;
          }
        }
      }
      
      const used = totalSize - totalFree;
      const percentage = totalSize > 0 ? Math.round((used / totalSize) * 100) : 0;
      
      return {
        status: percentage < 85 ? 'healthy' : percentage < 95 ? 'warning' : 'critical',
        used: percentage,
        free_gb: Math.round(totalFree / 1024 / 1024 / 1024),
        total_gb: Math.round(totalSize / 1024 / 1024 / 1024)
      };
      
    } else {
      // Linux/Unix
      const output = execSync('df -h /', { encoding: 'utf8' });
      const lines = output.split('\n');
      
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        if (parts.length >= 5) {
          const total = parts[1];
          const used = parts[2];
          const avail = parts[3];
          const percentage = parseInt(parts[4].replace('%', '')) || 0;
          
          return {
            status: percentage < 85 ? 'healthy' : percentage < 95 ? 'warning' : 'critical',
            used: percentage,
            free_gb: avail,
            total_gb: total
          };
        }
      }
      
      // Fallback se não conseguir parsear
      return {
        status: 'unknown',
        used: 0,
        free_gb: 0,
        total_gb: 0
      };
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar disco:', error.message);
    return { 
      status: 'unknown', 
      error: error.message,
      used: 0,
      free_gb: 0,
      total_gb: 0
    };
  }
}

  // Verificar uso de memória
  checkMemoryUsage() {
    const usage = process.memoryUsage();
    const total = os.totalmem();
    const used = (usage.rss / total) * 100;
    
    return {
      status: used < 80 ? 'healthy' : used < 90 ? 'warning' : 'critical',
      used: Math.round(used),
      rss_mb: Math.round(usage.rss / 1024 / 1024),
      heap_used_mb: Math.round(usage.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(usage.heapTotal / 1024 / 1024)
    };
  }

  // Verificar filas de atendimento
  async checkQueueHealth() {
    try {
      const stats = await db.queues.getStats();
      const totalWaiting = stats.waiting || 0;
      
      return {
        status: totalWaiting < 10 ? 'healthy' : totalWaiting < 25 ? 'warning' : 'critical',
        waiting: totalWaiting,
        attending: stats.attending || 0,
        finished_today: stats.finished_today || 0
      };
    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }

  // Verificar campanhas ativas
  async checkActiveCampaigns() {
    try {
      const campaigns = await db.query(
        "SELECT COUNT(*) as sending FROM campaigns WHERE status = 'sending'"
      );
      
      const stuckCampaigns = await db.query(`
        SELECT COUNT(*) as stuck FROM campaigns 
        WHERE status = 'sending' 
        AND started_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)
      `);
      
      return {
        status: stuckCampaigns[0].stuck > 0 ? 'warning' : 'healthy',
        sending: campaigns[0].sending,
        stuck: stuckCampaigns[0].stuck
      };
    } catch (error) {
      return { status: 'unhealthy', error: error.message };
    }
  }

  // Executar verificação completa de saúde
  async runHealthCheck() {
    const startTime = Date.now();
    
    try {
      const [database, whatsapp, disk, queue, campaigns] = await Promise.all([
        this.checkDatabase(),
        this.checkWhatsAppSessions(),
        this.checkDiskSpace(),
        this.checkQueueHealth(),
        this.checkActiveCampaigns()
      ]);

      const memory = this.checkMemoryUsage();
      const uptime = Math.round(process.uptime());
      
      const healthReport = {
        timestamp: new Date().toISOString(),
        uptime_seconds: uptime,
        uptime_human: this.formatUptime(uptime),
        overall_status: this.calculateOverallStatus([database, whatsapp, disk, memory, queue, campaigns]),
        checks: {
          database,
          whatsapp,
          disk,
          memory,
          queue,
          campaigns
        },
        response_time: Date.now() - startTime
      };

      // Verificar se precisa alertar
      await this.processHealthAlerts(healthReport);
      
      return healthReport;
      
    } catch (error) {
      return {
        timestamp: new Date().toISOString(),
        overall_status: 'critical',
        error: error.message
      };
    }
  }

  // Calcular status geral
  calculateOverallStatus(checks) {
    const statuses = checks.map(check => check.status);
    
    if (statuses.includes('critical') || statuses.includes('unhealthy')) {
      return 'critical';
    } else if (statuses.includes('warning')) {
      return 'warning';
    } else {
      return 'healthy';
    }
  }

  // Processar alertas baseados na saúde
  async processHealthAlerts(healthReport) {
    const { overall_status, checks } = healthReport;
    
    // Alertar se sistema crítico
    if (overall_status === 'critical') {
      await this.sendCriticalAlert(healthReport);
    }
    
    // Alertar se WhatsApp desconectado
    if (checks.whatsapp.connected === 0) {
      await this.sendWhatsAppAlert();
    }
    
    // Alertar se fila muito cheia
    if (checks.queue.waiting > 20) {
      await this.sendQueueAlert(checks.queue.waiting);
    }
  }

  // Enviar alerta crítico
  async sendCriticalAlert(healthReport) {
    const message = `🚨 ALERTA CRÍTICO - Sistema WhatsApp Bot

⏰ Horário: ${new Date().toLocaleString('pt-BR')}
📊 Status Geral: ${healthReport.overall_status.toUpperCase()}

🔍 Verificações:
- Banco: ${healthReport.checks.database.status}
- WhatsApp: ${healthReport.checks.whatsapp.connected} sessões ativas
- Disco: ${healthReport.checks.disk.used}% usado
- Memória: ${healthReport.checks.memory.used}% usada
- Fila: ${healthReport.checks.queue.waiting} aguardando

⚡ Ação necessária: Verificar sistema imediatamente!`;

    console.error('🚨 ALERTA CRÍTICO:', message);
    
    // Emitir via socket para admins conectados
    this.io.emit('system:critical-alert', {
      type: 'critical',
      message,
      healthReport
    });
  }

  // Formatar tempo de atividade
  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) {
      return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes}m`;
    } else {
      return `${minutes}m`;
    }
  }

  // Iniciar monitoramento contínuo
  startMonitoring() {
    // Verificação a cada 2 minutos
    setInterval(async () => {
      try {
        const health = await this.runHealthCheck();
        
        // Emitir status para frontend
        this.io.emit('system:health', health);
        
      } catch (error) {
        console.error('❌ Erro na verificação de saúde:', error);
      }
    }, 2 * 60 * 1000); // 2 minutos

    console.log('💓 Monitoramento de saúde iniciado (verificação a cada 2min)');
  }

  // Enviar alerta específico de WhatsApp
  async sendWhatsAppAlert() {
    console.warn('⚠️ ALERTA: Nenhuma sessão WhatsApp conectada!');
  }

  // Enviar alerta de fila cheia
  async sendQueueAlert(waitingCount) {
    console.warn(`⚠️ ALERTA: ${waitingCount} contatos aguardando atendimento!`);
  }
}

module.exports = MonitoringService;