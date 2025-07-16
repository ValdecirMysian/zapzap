// Teste de variáveis de ambiente
console.log('🔍 Testando carregamento do .env...');

// Carregar dotenv
require('dotenv').config();

console.log('📋 Variáveis carregadas:');
console.log('DB_HOST:', process.env.DB_HOST || 'NÃO ENCONTRADA');
console.log('DB_USER:', process.env.DB_USER || 'NÃO ENCONTRADA');
console.log('DB_PASSWORD:', process.env.DB_PASSWORD ? '✅ DEFINIDA' : '❌ NÃO ENCONTRADA');
console.log('DB_NAME:', process.env.DB_NAME || 'NÃO ENCONTRADA');

// Teste de conexão
if (process.env.DB_PASSWORD) {
    console.log('\n🔄 Testando conexão com banco...');
    
    const mysql = require('mysql2/promise');
    
    async function testConnection() {
        try {
            const connection = await mysql.createConnection({
                host: process.env.DB_HOST,
                port: process.env.DB_PORT,
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                database: process.env.DB_NAME
            });
            
            console.log('✅ Conexão estabelecida com sucesso!');
            await connection.end();
            
        } catch (error) {
            console.log('❌ Erro na conexão:', error.message);
            
            if (error.code === 'ER_ACCESS_DENIED_ERROR') {
                console.log('\n🔧 Possíveis soluções:');
                console.log('1. Verifique a senha no cPanel');
                console.log('2. Redefina a senha do usuário no MySQL Databases');
                console.log('3. Certifique-se que o usuário tem permissão no banco');
            } else if (error.code === 'ER_BAD_DB_ERROR') {
                console.log('\n🔧 O banco de dados não existe. Crie no cPanel:');
                console.log('Nome: whatsapp_system');
            }
        }
    }
    
    testConnection();
} else {
    console.log('\n❌ PROBLEMA: Senha não encontrada no .env');
    console.log('Verifique se o arquivo .env existe e tem a linha DB_PASSWORD=sua_senha');
}