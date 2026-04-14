const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'election.db');
const db = new Database(dbPath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize schema
db.exec(`
  -- ═══════════════════════════════════════════════════════════
  -- USERS & AUTH
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'agent',
    phone TEXT,
    avatar_url TEXT,
    preferred_language TEXT DEFAULT 'sv',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══════════════════════════════════════════════════════════
  -- GEOGRAPHIC HIERARCHY
  -- ═══════════════════════════════════════════════════════════

  -- Counties (Län) - 21 in Sweden
  CREATE TABLE IF NOT EXISTS counties (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT,
    population INTEGER,
    geojson TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Municipalities (Kommuner) - 290 in Sweden
  CREATE TABLE IF NOT EXISTS municipalities (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    county_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT,
    population INTEGER,
    geojson TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (county_id) REFERENCES counties(id)
  );

  -- Voting districts (Valdistrikt) - ~6000 in Sweden
  CREATE TABLE IF NOT EXISTS voting_districts (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    municipality_id TEXT NOT NULL,
    name TEXT NOT NULL,
    population INTEGER,
    registered_voters INTEGER,
    postcodes TEXT,
    geojson TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id)
  );

  -- ═══════════════════════════════════════════════════════════
  -- CAMPAIGNS
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    election_type TEXT NOT NULL,
    election_date TEXT,
    party TEXT,
    description TEXT,
    status TEXT DEFAULT 'active',
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (created_by) REFERENCES users(id)
  );

  -- Candidates
  CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    name TEXT NOT NULL,
    party TEXT,
    constituency TEXT,
    bio TEXT,
    photo_url TEXT,
    email TEXT,
    phone TEXT,
    position INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  -- Area assignments (which team covers which area)
  CREATE TABLE IF NOT EXISTS area_assignments (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    municipality_id TEXT,
    district_id TEXT,
    team_leader_id TEXT,
    status TEXT DEFAULT 'assigned',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
    FOREIGN KEY (team_leader_id) REFERENCES users(id)
  );

  -- ═══════════════════════════════════════════════════════════
  -- VOTER DATABASE
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS voters (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    full_name TEXT,
    address TEXT,
    postcode TEXT,
    city TEXT,
    municipality_id TEXT,
    district_id TEXT,
    phone TEXT,
    email TEXT,
    age_group TEXT,
    gender TEXT,
    voting_history TEXT,
    support_status TEXT DEFAULT 'unknown',
    ai_support_score REAL,
    ai_priority_rank INTEGER,
    ai_talking_points TEXT,
    is_contacted INTEGER DEFAULT 0,
    contact_count INTEGER DEFAULT 0,
    last_contacted_at TEXT,
    last_contacted_by TEXT,
    data_quality TEXT DEFAULT 'good',
    notes TEXT,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
    FOREIGN KEY (municipality_id) REFERENCES municipalities(id),
    FOREIGN KEY (district_id) REFERENCES voting_districts(id)
  );

  CREATE INDEX IF NOT EXISTS idx_voters_campaign ON voters(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_voters_postcode ON voters(postcode);
  CREATE INDEX IF NOT EXISTS idx_voters_district ON voters(district_id);
  CREATE INDEX IF NOT EXISTS idx_voters_status ON voters(support_status);
  CREATE INDEX IF NOT EXISTS idx_voters_priority ON voters(ai_priority_rank);

  -- ═══════════════════════════════════════════════════════════
  -- FIELD OPERATIONS - CONTACTS
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    voter_id TEXT NOT NULL,
    campaign_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    contact_type TEXT NOT NULL,
    outcome TEXT NOT NULL,
    notes TEXT,
    follow_up_date TEXT,
    follow_up_done INTEGER DEFAULT 0,
    duration_seconds INTEGER,
    location_lat REAL,
    location_lng REAL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (voter_id) REFERENCES voters(id),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
    FOREIGN KEY (agent_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_voter ON contacts(voter_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_campaign ON contacts(campaign_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_agent ON contacts(agent_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_outcome ON contacts(outcome);

  -- ═══════════════════════════════════════════════════════════
  -- DOOR KNOCKING ROUTES
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    agent_id TEXT,
    district_id TEXT,
    name TEXT,
    voter_ids TEXT,
    optimized_order TEXT,
    status TEXT DEFAULT 'planned',
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id),
    FOREIGN KEY (agent_id) REFERENCES users(id)
  );

  -- ═══════════════════════════════════════════════════════════
  -- ELECTION RESULTS
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS parties (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    name_en TEXT,
    color TEXT,
    logo_url TEXT,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS election_results (
    id TEXT PRIMARY KEY,
    election_year INTEGER NOT NULL,
    election_type TEXT NOT NULL,
    county_code TEXT,
    municipality_code TEXT,
    district_code TEXT,
    level TEXT NOT NULL,
    party_code TEXT NOT NULL,
    votes INTEGER DEFAULT 0,
    vote_percentage REAL,
    seats INTEGER,
    registered_voters INTEGER,
    total_votes INTEGER,
    turnout_percentage REAL,
    valid_votes INTEGER,
    blank_votes INTEGER,
    source TEXT DEFAULT 'val.se',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (party_code) REFERENCES parties(code)
  );

  CREATE INDEX IF NOT EXISTS idx_results_year ON election_results(election_year);
  CREATE INDEX IF NOT EXISTS idx_results_type ON election_results(election_type);
  CREATE INDEX IF NOT EXISTS idx_results_district ON election_results(district_code);
  CREATE INDEX IF NOT EXISTS idx_results_municipality ON election_results(municipality_code);
  CREATE INDEX IF NOT EXISTS idx_results_party ON election_results(party_code);

  -- ═══════════════════════════════════════════════════════════
  -- AI ANALYTICS
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS ai_analyses (
    id TEXT PRIMARY KEY,
    campaign_id TEXT,
    analysis_type TEXT NOT NULL,
    scope_level TEXT,
    scope_code TEXT,
    title TEXT,
    summary TEXT,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  CREATE TABLE IF NOT EXISTS ai_briefings (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL,
    briefing_date TEXT NOT NULL,
    title TEXT,
    content TEXT,
    themes TEXT,
    alerts TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id)
  );

  -- ═══════════════════════════════════════════════════════════
  -- DEMOGRAPHIC DATA (from SCB)
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS area_demographics (
    id TEXT PRIMARY KEY,
    area_code TEXT NOT NULL,
    area_type TEXT NOT NULL,
    population INTEGER,
    median_age REAL,
    median_income INTEGER,
    foreign_born_pct REAL,
    higher_education_pct REAL,
    unemployment_pct REAL,
    avg_household_size REAL,
    data_year INTEGER,
    raw_data TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_demographics_area ON area_demographics(area_code);

  -- ═══════════════════════════════════════════════════════════
  -- TRANSLATIONS
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS translations (
    id TEXT PRIMARY KEY,
    lang TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(lang, key)
  );

  -- ═══════════════════════════════════════════════════════════
  -- SETTINGS
  -- ═══════════════════════════════════════════════════════════
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = db;
