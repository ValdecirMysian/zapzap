// ÚNICA configuração necessária no VPS
fetch('/api/system/auto-cleanup-config', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    enabled: true,
    maxUploadsSize: 500,      // Ajuste conforme seu plano VPS
    maxUploadAge: 30,         
    maxLogSize: 100,          
    cleanupHour: 2,           // 2h da manhã 
    notifyAdmin: true
  })
})
.then(r => r.json())
.then(console.log);

// Ver se está funcionando (opcional)
fetch('/api/system/auto-cleanup-config')
.then(r => r.json())
.then(data => console.log('Status:', data.config.enabled ? '🟢 ATIVO' : '🔴 INATIVO'));