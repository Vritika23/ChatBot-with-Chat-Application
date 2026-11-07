from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """All settings come from environment variables (see ../.env.example)."""

    model_config = SettingsConfigDict(extra="ignore")

    database_url: str = "postgresql://chat:chat_dev_password@localhost:5432/chatdb"
    # Separate READ-ONLY login used only for the bot's live-data SQL queries
    readonly_database_url: str = "postgresql://bot_reader:bot_reader_dev@localhost:5432/chatdb"

    kafka_brokers: str = "localhost:9094"
    kafka_enabled: bool = True

    llm_provider: str = "gemini"  # "gemini" or "fake" (offline tests)
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.8-flash"
    embedding_model: str = "gemini-embedding-001"
    embedding_dim: int = 768

    bot_user_id: str = "chatbot"
    bot_sql_tables: str = "products,orders"

    # RAG tuning
    chunk_size: int = 1000        # characters per chunk
    chunk_overlap: int = 200      # characters shared between neighbour chunks
    top_k: int = 5                # chunks given to the LLM
    min_similarity: float = 0.45  # ignore chunks less similar than this (cosine) — tune for your data
    history_messages: int = 10    # past chat messages sent as context

    max_concurrent_chats: int = 8

    @property
    def sql_tables(self) -> list[str]:
        return [t.strip().lower() for t in self.bot_sql_tables.split(",") if t.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


TOPIC_CHAT_MESSAGES = "chat.messages"
TOPIC_BOT_STREAM = "bot.stream"
TOPIC_BOT_REPLIES = "bot.replies"
