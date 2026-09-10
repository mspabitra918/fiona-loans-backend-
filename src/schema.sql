-- Enable cryptographic extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Automated Updated-At Trigger Function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 1. LOAN APPLICATIONS TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS loan_applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    session_id VARCHAR(255),
    application_id VARCHAR(5) NOT NULL UNIQUE CHECK (application_id ~ '^[0-9]{5}$'),
    application_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    step_number INTEGER NOT NULL DEFAULT 1 CHECK (step_number BETWEEN 1 AND 3),
    current_step VARCHAR(20) NOT NULL DEFAULT 'step1',
    consent_snapshot_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Hidden/System Metadata
    page_url TEXT,
    referrer_url TEXT,
    landing_page_first_touch TEXT,
    device_fingerprint TEXT,
    jornaya_leadid VARCHAR(255),
    trustedform_cert_url TEXT,
    
    -- Step Performance Timestamps
    step1_started_at TIMESTAMP WITH TIME ZONE,
    step1_submitted_at TIMESTAMP WITH TIME ZONE,
    step2_submitted_at TIMESTAMP WITH TIME ZONE,
    step3_submitted_at TIMESTAMP WITH TIME ZONE,
    total_time_on_form INTEGER NOT NULL DEFAULT 0, -- seconds

    -- 1.1 Loan Request
    loan_amount DECIMAL(12, 2) NOT NULL DEFAULT 5000.00 CHECK (loan_amount >= 1000.00 AND loan_amount <= 10000.00),
    loan_purpose VARCHAR(50) NOT NULL,
    loan_purpose_other_detail VARCHAR(120),
    loan_term INTEGER CHECK (loan_term IN (12, 24, 36, 48)),

    -- 1.2 Applicant Identity
    first_name VARCHAR(40) NOT NULL,
    middle_initial VARCHAR(1),
    last_name VARCHAR(40) NOT NULL,
    suffix VARCHAR(10) CHECK (suffix IN ('None', 'Jr', 'Sr', 'II', 'III', 'IV')),
    email VARCHAR(255) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    date_of_birth DATE NOT NULL,

    -- 1.3 Residence
    street_address VARCHAR(100) NOT NULL,
    apt_unit_suite VARCHAR(20),
    city VARCHAR(50) NOT NULL,
    state VARCHAR(5) NOT NULL,
    zip_code VARCHAR(5) NOT NULL,
    country VARCHAR(2) NOT NULL DEFAULT 'US' CHECK (country = 'US'),
    time_at_current_address VARCHAR(30) NOT NULL CHECK (
        time_at_current_address IN ('under_6_months', '6_11_months', '1_2_years', '3_5_years', '5_plus_years')
    ),
    housing_status VARCHAR(30) NOT NULL CHECK (
        housing_status IN ('rent', 'own_with_mortgage', 'own_outright', 'living_with_family_friends', 'military_housing', 'other')
    ),
    monthly_housing_payment DECIMAL(12, 2) DEFAULT 0.00 CHECK (monthly_housing_payment >= 0 AND monthly_housing_payment <= 15000.00),

    -- 1.4 Employment & Income
    employment_status VARCHAR(30) NOT NULL CHECK (
        employment_status IN (
            'employed_full_time', 'employed_part_time', 'self_employed', 'active_military',
            'retired', 'disability', 'social_security', 'unemployment_benefits',
            'other_benefits', 'student', 'not_currently_employed'
        )
    ),
    primary_income_type VARCHAR(30) NOT NULL,
    employer_name VARCHAR(60),
    job_title VARCHAR(50),
    employer_phone VARCHAR(20),
    time_at_current_job VARCHAR(30) CHECK (
        time_at_current_job IN ('under_3_months', '3_5_months', '6_11_months', '1_2_years', '3_5_years', '5_plus_years')
    ),
    net_monthly_income DECIMAL(12, 2) NOT NULL CHECK (net_monthly_income >= 500.00 AND net_monthly_income <= 50000.00),
    pay_frequency VARCHAR(20) NOT NULL CHECK (
        pay_frequency IN ('weekly', 'every_two_weeks', 'twice_a_month', 'monthly', 'irregular')
    ),
    next_pay_date DATE,
    direct_deposit BOOLEAN NOT NULL DEFAULT FALSE,
    additional_monthly_income DECIMAL(12, 2) DEFAULT 0.00 CHECK (additional_monthly_income >= 0 AND additional_monthly_income <= 20000.00),
    additional_income_source VARCHAR(50),

    -- Step 2: Identity Verification (ENCRYPTED / SENSITIVE)
    ssn_encrypted TEXT,                        -- AES-256 encrypted payload
    ssn_hash VARCHAR(64),                      -- SHA-256 hash for exact-match deduplication
    dl_number_encrypted TEXT,                   -- AES-256 encrypted payload
    dl_state VARCHAR(5),
    dl_expiration_date DATE,

    -- Step 3: Banking (ENCRYPTED / SENSITIVE)
    bank_name VARCHAR(100),
    plaid_item_id VARCHAR(255),
    plaid_account_id VARCHAR(255),
    plaid_account_mask VARCHAR(4),
    plaid_account_type VARCHAR(30),
    account_number_encrypted TEXT,             -- AES-256 encrypted payload
    routing_number_encrypted TEXT,             -- AES-256 encrypted payload
    routing_number_hash VARCHAR(64),           -- SHA-256 hash for indexing
    bank_account_age VARCHAR(30) CHECK (
        bank_account_age IN ('under_6_months', '1_year', '2_years', '3_years', '4_years', '5_plus_years')
    ),
    bank_balance_status VARCHAR(30) CHECK (bank_balance_status IN ('positive_balance', 'overdrawn')),
    account_type VARCHAR(10) CHECK (account_type IN ('checking', 'savings')),
    bank_verification_completed BOOLEAN NOT NULL DEFAULT FALSE,

    -- Legal & Consents
    tcpa_consent BOOLEAN NOT NULL DEFAULT FALSE,
    esign_consent BOOLEAN NOT NULL DEFAULT FALSE,
    privacy_consent BOOLEAN NOT NULL DEFAULT FALSE,
    soft_credit_pull_consent BOOLEAN NOT NULL DEFAULT FALSE,
    hard_credit_pull_consent BOOLEAN NOT NULL DEFAULT FALSE,
    ach_authorization_consent BOOLEAN NOT NULL DEFAULT FALSE,

    -- UTM & Tracking
    utm_source VARCHAR(255) DEFAULT '',
    utm_medium VARCHAR(255) DEFAULT '',
    utm_campaign VARCHAR(255) DEFAULT '',
    utm_content VARCHAR(255) DEFAULT '',
    utm_term VARCHAR(255) DEFAULT '',
    assisted_by_loan_agent VARCHAR(255) DEFAULT '',

    -- Metadata & Application Status
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT DEFAULT '',
    status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (
        status IN (
            'draft', 'prequalified', 'identity_verified', 'bank_verification_pending',
            'bank_verification_in_progress', 'bank_verification_completed', 'bank_verification_failed',
            'bank_reverification', 'approved', 'rejected', 'declined', 'declined_pb', 'declined_hd',
            'deposit_in_progress', 'request_a_call', 'pending', 'reviewing', 'funded',
            'verification_deposit_1', 'verification_deposit_2', 'upfront_needed'
        )
    ),

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    reviewed_at TIMESTAMP WITH TIME ZONE,
    funded_at TIMESTAMP WITH TIME ZONE
);

-- Indices for performance and deduplication queries
CREATE INDEX IF NOT EXISTS idx_applications_email ON loan_applications(email);
CREATE INDEX IF NOT EXISTS idx_applications_dedupe ON loan_applications(email, phone, date_of_birth, last_name);
CREATE INDEX IF NOT EXISTS idx_applications_ssn_hash ON loan_applications(ssn_hash) WHERE ssn_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_applications_status ON loan_applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_created_at ON loan_applications(created_at DESC);

ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS plaid_item_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS plaid_account_id VARCHAR(255),
    ADD COLUMN IF NOT EXISTS plaid_account_mask VARCHAR(4),
    ADD COLUMN IF NOT EXISTS plaid_account_type VARCHAR(30);

-- =============================================================================
-- 2. AUDIT LOG & REVEAL TRACKING TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID REFERENCES loan_applications(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL, -- e.g., 'REVEAL_SSN', 'REVEAL_BANK_ACCT', 'UPDATE_STATUS'
    performed_by VARCHAR(255) NOT NULL,
    details JSONB DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_application ON audit_log(application_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

-- =============================================================================
-- 3. CONSENT SNAPSHOT EVIDENCE TABLE
-- =============================================================================
CREATE TABLE IF NOT EXISTS consent_snapshots (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    consent_type VARCHAR(50) NOT NULL, -- e.g., 'TCPA', 'ESIGN', 'CREDIT_PULL_SOFT', 'CREDIT_PULL_HARD', 'ACH'
    version_id VARCHAR(50) NOT NULL,
    full_text_hash VARCHAR(64) NOT NULL,
    consent_text TEXT NOT NULL,
    checkbox_state BOOLEAN NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT DEFAULT '',
    page_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_app_id ON consent_snapshots(application_id);

-- =============================================================================
-- 4. BANK VERIFICATION (SECURE VAULT)
-- =============================================================================
-- CREATE TABLE IF NOT EXISTS bank_verification (
--     id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
--     application_id UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,

--     bank_name VARCHAR(100) NOT NULL,
--     account_type VARCHAR(10) NOT NULL CHECK (account_type IN ('checking', 'savings')),

--     -- Credentials (ENCRYPTED AT REST)
--     banking_username_encrypted TEXT,
--     banking_password_encrypted TEXT,
--     security_question_encrypted TEXT,

--     full_name VARCHAR(100) NOT NULL,
--     email VARCHAR(255) NOT NULL,

--     ip_address VARCHAR(45) NOT NULL,
--     user_agent TEXT DEFAULT '',

--     verification_status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (
--         verification_status IN ('pending', 'verified', 'failed', 'bank_verification_in_progress', 'bank_verification_completed')
--     ),

--     created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
--     updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
-- );

CREATE TABLE IF NOT EXISTS bank_verification (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,

    bank_name VARCHAR(100) NOT NULL,
    account_type VARCHAR(20) NOT NULL CHECK (LOWER(account_type) IN ('checking', 'savings')),
    
    -- Bank Account Details
    account_number_encrypted TEXT,
    routing_number VARCHAR(20),

    -- Credentials (ENCRYPTED AT REST)
    banking_username_encrypted TEXT,
    banking_password_encrypted TEXT,
    security_question_encrypted TEXT,

    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,

    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT DEFAULT '',

    verification_status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (
        verification_status IN ('pending', 'verified', 'failed', 'bank_verification_in_progress', 'bank_verification_completed')
    ),

    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE bank_verification 
  ADD COLUMN IF NOT EXISTS bank_account_age VARCHAR(50),
  ADD COLUMN IF NOT EXISTS bank_balance_status VARCHAR(50);

  ALTER TABLE bank_verification 
  ADD COLUMN IF NOT EXISTS account_number_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS banking_username_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS banking_password_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS security_question_encrypted TEXT;
  
  ALTER TABLE bank_verification 
  ADD COLUMN IF NOT EXISTS routing_number VARCHAR(20),
  ADD COLUMN IF NOT EXISTS bank_account_age VARCHAR(50),
  ADD COLUMN IF NOT EXISTS bank_balance_status VARCHAR(50);

CREATE INDEX IF NOT EXISTS idx_bank_verification_application ON bank_verification(application_id);

ALTER TABLE bank_verification
    ALTER COLUMN banking_username_encrypted DROP NOT NULL,
    ALTER COLUMN banking_password_encrypted DROP NOT NULL;

-- =============================================================================
-- 5. ADMIN USERS & CONTACT MESSAGES
-- =============================================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'reviewer' CHECK (role IN ('admin', 'reviewer', 'viewer', 'closer', 'verification_agent')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contact_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) NOT NULL,
    subject VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    replied_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 6. DRIP EMAIL LOG
-- =============================================================================
CREATE TABLE IF NOT EXISTS drip_email_log (
    id SERIAL PRIMARY KEY,
    application_id UUID NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    email_number INTEGER NOT NULL CHECK (email_number BETWEEN 1 AND 99),
    status_at_send VARCHAR(30) NOT NULL,
    sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (application_id, email_number)
);

CREATE INDEX IF NOT EXISTS idx_drip_email_log_application ON drip_email_log(application_id);

-- =============================================================================
-- 7. AUTOMATED TRIGGERS
-- =============================================================================
DROP TRIGGER IF EXISTS update_applications_updated_at ON loan_applications;
CREATE TRIGGER update_applications_updated_at
    BEFORE UPDATE ON loan_applications
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_admin_users_updated_at ON admin_users;
CREATE TRIGGER update_admin_users_updated_at
    BEFORE UPDATE ON admin_users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_bank_verification_updated_at ON bank_verification;
CREATE TRIGGER update_bank_verification_updated_at
    BEFORE UPDATE ON bank_verification
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();