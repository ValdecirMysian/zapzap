-- Script Reset WhatsApp Seguro - Primeiro Uso
SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
SET FOREIGN_KEY_CHECKS = 0;

-- Limpar apenas tabelas que existem
TRUNCATE TABLE `messages`;
TRUNCATE TABLE `contacts`;
TRUNCATE TABLE `contact_notes`;
TRUNCATE TABLE `contact_tag_relations`;
TRUNCATE TABLE `sessions`;
TRUNCATE TABLE `campaigns`;
TRUNCATE TABLE `campaign_logs`;
TRUNCATE TABLE `queues`;
TRUNCATE TABLE `polls`;
TRUNCATE TABLE `poll_responses`;

-- Resetar AUTO_INCREMENT
ALTER TABLE `messages` AUTO_INCREMENT = 1;
ALTER TABLE `contacts` AUTO_INCREMENT = 1;
ALTER TABLE `sessions` AUTO_INCREMENT = 1;
ALTER TABLE `campaigns` AUTO_INCREMENT = 1;
ALTER TABLE `queues` AUTO_INCREMENT = 1;

-- Criar sessão inicial para amanhã
INSERT INTO `sessions` (`name`, `status`, `created_at`) VALUES
('FarmaPro', 'disconnected', NOW());

SET FOREIGN_KEY_CHECKS = 1;

SELECT 'WhatsApp Reset Completo - Pronto para primeiro uso!' as status;
