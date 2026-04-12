-- Standard PostgreSQL schema example
--
-- Works on: PostgreSQL, Aurora Serverless v2, RDS PostgreSQL, Neon, Supabase
-- Does NOT work on: Aurora DSQL (use dsql-compatible.sql instead)

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    display_name TEXT,
    avatar_url TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE projects (
    id SERIAL PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'draft')),
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tasks (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    user_id UUID REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT,
    priority INTEGER DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
    done BOOLEAN DEFAULT false,
    due_date DATE,
    created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE comments (
    id SERIAL PRIMARY KEY,
    task_id INTEGER REFERENCES tasks(id),
    user_id UUID REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- Table without user_id: accessible to all authenticated users,
-- or controlled by custom Cedar policies.
CREATE TABLE categories (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);
