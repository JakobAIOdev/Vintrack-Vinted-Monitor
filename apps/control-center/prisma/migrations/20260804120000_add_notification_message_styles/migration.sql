ALTER TABLE "User"
ADD COLUMN "telegram_message_style" VARCHAR(20) NOT NULL DEFAULT 'rich',
ADD COLUMN "discord_message_style" VARCHAR(20) NOT NULL DEFAULT 'rich';
