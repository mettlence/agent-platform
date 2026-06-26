// Minimum env to satisfy zod validation when env.ts is imported in tests.
// Real values are not used because tests should mock all I/O.
process.env.NODE_ENV = 'test'
process.env.MONGODB_URI = 'mongodb://localhost:27017'
process.env.MONGODB_DB = 'agent_platform_test'
process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.DISCORD_BOT_TOKEN = 'test-token'
process.env.DISCORD_GUILD_IDS = 'test-guild'
process.env.DISCORD_CS_CHANNEL_IDS = 'test-channel'
process.env.CLICKBANK_API_KEY = 'API-test'
process.env.ASKSABRINA_API_BASE = 'http://localhost/api/agent'
process.env.ASKSABRINA_AGENT_KEY = 'test-key'
