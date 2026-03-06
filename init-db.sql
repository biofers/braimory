CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE thoughts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    content TEXT NOT NULL,
    content_iv TEXT,
    embedding VECTOR(768),
    metadata JSONB DEFAULT '{}',
    source VARCHAR(100) DEFAULT 'mcp',
    tags TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX thoughts_embedding_idx ON thoughts
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

CREATE INDEX thoughts_metadata_idx ON thoughts USING gin (metadata);

CREATE INDEX thoughts_tags_idx ON thoughts USING gin (tags);

CREATE INDEX thoughts_created_idx ON thoughts (created_at DESC);

CREATE INDEX thoughts_source_idx ON thoughts (source);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER thoughts_updated_at
    BEFORE UPDATE ON thoughts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();
