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
    # Comma-separated backup chat models, used when the main one is overloaded (503) or times out
    gemini_fallback_models: str = ""
    embedding_model: str = "gemini-embedding-001"
    embedding_dim: int = 768
    # Real-API safety nets: Gemini sometimes answers 503 "high demand" / 429 "rate limit",
    # or simply takes minutes. Retry those, and never wait forever on one request.
    llm_timeout_s: float = 60.0   # per HTTP request to Gemini
    llm_retries: int = 3          # attempts PER MODEL for 429 / 5xx errors (then the next fallback model)

    bot_user_id: str = "chatbot"
    bot_sql_tables: str = "products,orders"

    # RAG tuning
    chunk_size: int = 1000        # characters per chunk
    chunk_overlap: int = 200      # characters shared between neighbour chunks
    top_k: int = 5                # chunks given to the LLM
    min_similarity: float = 0.60  # ignore chunks less similar than this (cosine). Measured with gemini-embedding-001 (768-d): relevant 0.66-0.73, unrelated 0.49-0.55
    history_messages: int = 10    # past chat messages sent as context

    max_concurrent_chats: int = 8

    @property
    def fallback_models(self) -> list[str]:
        return [m.strip() for m in self.gemini_fallback_models.split(",") if m.strip()]

    @property
    def sql_tables(self) -> list[str]:
        return [t.strip().lower() for t in self.bot_sql_tables.split(",") if t.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


TOPIC_CHAT_MESSAGES = "chat.messages"
TOPIC_BOT_STREAM = "bot.stream"
TOPIC_BOT_REPLIES = "bot.replies"
