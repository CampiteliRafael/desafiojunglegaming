import { Migration } from '@mikro-orm/migrations';

/**
 * Initial schema. Every guarantee required by the challenge (uniqueness, immutability,
 * non-negativity, ledger/balance consistency) is enforced HERE, in the database —
 * application code is only the first line of defence.
 */
export class Migration20260801000001_initial_schema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   text           NOT NULL CHECK (length(player_id) BETWEEN 1 AND 128),
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(20, 2) NOT NULL CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
        version     integer        NOT NULL CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)
      )`);

    // ------------------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text           NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
        external_transaction_id           text           NOT NULL CHECK (length(external_transaction_id) BETWEEN 1 AND 128),
        idempotency_key                   text           NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
        payload_hash                      char(64)       NOT NULL,
        wallet_id                         uuid           NOT NULL REFERENCES wallets (id),
        player_id                         text           NOT NULL,
        round_id                          text           NOT NULL,
        game_id                           text           NOT NULL,
        kind                              text           NOT NULL,
        amount                            numeric(20, 2) NOT NULL,
        currency                          char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        reference_external_transaction_id text,
        reference_transaction_id          uuid           REFERENCES wager_transactions (id),
        status                            text           NOT NULL,
        failure_code                      text,
        observed_balance                  numeric(20, 2),
        reference_attempts                integer        NOT NULL DEFAULT 0,
        next_reference_attempt_at         timestamptz,
        reference_deadline                timestamptz,
        created_at                        timestamptz    NOT NULL,
        processed_at                      timestamptz,

        CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
        CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT ck_wager_tx_kind   CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        CONSTRAINT ck_wager_tx_status CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        CONSTRAINT ck_wager_tx_amount CHECK (amount >= 0 AND (amount > 0 OR kind = 'LOSS')),
        -- OPENING is internal only: never reachable through API / queue
        CONSTRAINT ck_wager_tx_opening_internal CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
        -- REFUND / ROLLBACK must carry a reference; BET / OPENING must not
        CONSTRAINT ck_wager_tx_reference_required CHECK (
          (kind IN ('REFUND','ROLLBACK') AND reference_external_transaction_id IS NOT NULL)
          OR (kind IN ('BET','OPENING') AND reference_external_transaction_id IS NULL)
          OR kind IN ('WIN','LOSS')
        ),
        CONSTRAINT ck_wager_tx_failure_code CHECK (
          (status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)
        ),
        CONSTRAINT ck_wager_tx_processed CHECK (
          status <> 'PROCESSED' OR (processed_at IS NOT NULL AND failure_code IS NULL)
        ),
        CONSTRAINT ck_wager_tx_reversal_has_reference CHECK (
          NOT (status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')) OR reference_transaction_id IS NOT NULL
        ),
        CONSTRAINT ck_wager_tx_attempts CHECK (reference_attempts >= 0)
      )`);

    // A reference can be reverted by at most ONE processed REFUND/ROLLBACK (no double credit/debit).
    this.addSql(`
      CREATE UNIQUE INDEX uq_wager_tx_single_reversal
        ON wager_transactions (reference_transaction_id)
        WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`);
    this.addSql(`CREATE INDEX ix_wager_tx_wallet ON wager_transactions (wallet_id, created_at)`);
    this.addSql(`
      CREATE INDEX ix_wager_tx_pending_reference
        ON wager_transactions (next_reference_attempt_at)
        WHERE status = 'PENDING_REFERENCE'`);

    // ------------------------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        seq            bigint GENERATED ALWAYS AS IDENTITY,
        id             uuid           PRIMARY KEY,
        wallet_id      uuid           NOT NULL REFERENCES wallets (id),
        transaction_id uuid           NOT NULL REFERENCES wager_transactions (id),
        direction      text           NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount         numeric(20, 2) NOT NULL CHECK (amount > 0),
        currency       char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance_before numeric(20, 2) NOT NULL CHECK (balance_before >= 0),
        balance_after  numeric(20, 2) NOT NULL CHECK (balance_after >= 0),
        created_at     timestamptz    NOT NULL,
        -- at most one ledger line per wallet per transaction
        CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id),
        CONSTRAINT uq_ledger_seq UNIQUE (seq),
        -- the arithmetic of every line is verified by the database itself
        CONSTRAINT ck_ledger_balanced CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      )`);
    this.addSql(`CREATE INDEX ix_ledger_wallet_seq ON wallet_ledger_entries (wallet_id, seq)`);

    // ------------------------------------------------------------------ inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text        NOT NULL,
        message_id    text        NOT NULL,
        payload_hash  char(64)    NOT NULL,
        received_at   timestamptz NOT NULL,
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      )`);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid        PRIMARY KEY,
        aggregate_id    text        NOT NULL,
        event_type      text        NOT NULL,
        payload         jsonb       NOT NULL,
        occurred_at     timestamptz NOT NULL,
        attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at timestamptz,
        published_at    timestamptz
      )`);
    this.addSql(`CREATE INDEX ix_outbox_due ON outbox_messages (next_attempt_at, occurred_at) WHERE published_at IS NULL`);
    this.addSql(`CREATE INDEX ix_outbox_pending_age ON outbox_messages (occurred_at) WHERE published_at IS NULL`);

    // ================================================================== triggers
    // ---- ledger is append-only: no UPDATE, DELETE or TRUNCATE, ever.
    this.addSql(`
      CREATE FUNCTION fn_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% not allowed)', TG_OP
          USING ERRCODE = 'integrity_constraint_violation';
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION fn_ledger_immutable()`);
    this.addSql(`
      CREATE TRIGGER trg_ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION fn_ledger_immutable()`);

    // ---- wallets: identity immutable; balance changes <=> version + 1 (guards lost updates)
    this.addSql(`
      CREATE FUNCTION fn_wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'wallet identity columns are immutable' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF (NEW.balance IS DISTINCT FROM OLD.balance) <> (NEW.version = OLD.version + 1)
           OR NEW.version NOT IN (OLD.version, OLD.version + 1) THEN
          RAISE EXCEPTION 'wallet version must increment by one exactly when the balance changes'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_wallet_guard BEFORE UPDATE OR DELETE ON wallets
        FOR EACH ROW EXECUTE FUNCTION fn_wallet_guard()`);

    // ---- wager_transactions: terminal states are final, business fields immutable, never deleted
    this.addSql(`
      CREATE FUNCTION fn_wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION 'wager_transactions cannot be deleted' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'transaction % is in terminal state %', OLD.id, OLD.status
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF NEW.id <> OLD.id OR NEW.provider_id <> OLD.provider_id
           OR NEW.external_transaction_id <> OLD.external_transaction_id
           OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.payload_hash <> OLD.payload_hash
           OR NEW.wallet_id <> OLD.wallet_id OR NEW.player_id <> OLD.player_id
           OR NEW.round_id <> OLD.round_id OR NEW.game_id <> OLD.game_id
           OR NEW.kind <> OLD.kind OR NEW.amount <> OLD.amount OR NEW.currency <> OLD.currency
           OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
           OR NEW.created_at <> OLD.created_at THEN
          RAISE EXCEPTION 'business fields of transaction % are immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.status = 'PENDING_REFERENCE' AND NEW.status = 'PENDING' THEN
          RAISE EXCEPTION 'invalid status transition PENDING_REFERENCE -> PENDING'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION fn_wager_tx_guard()`);

    // ---- balance <=> ledger consistency, checked at COMMIT (deferred constraint triggers)
    //  1. wallets.balance must equal the balance_after of its latest ledger line (0 if none)
    //  2. a PROCESSED balance-affecting transaction must have its ledger line; anything else must not
    this.addSql(`
      CREATE FUNCTION fn_assert_wallet_ledger_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        w_id      uuid;
        w_balance numeric(20, 2);
        l_balance numeric(20, 2);
      BEGIN
        IF TG_TABLE_NAME = 'wallets' THEN w_id := NEW.id; ELSE w_id := NEW.wallet_id; END IF;
        SELECT balance INTO w_balance FROM wallets WHERE id = w_id;
        SELECT balance_after INTO l_balance FROM wallet_ledger_entries WHERE wallet_id = w_id ORDER BY seq DESC LIMIT 1;
        IF w_balance IS DISTINCT FROM COALESCE(l_balance, 0::numeric) THEN
          RAISE EXCEPTION 'wallet % balance % diverges from ledger % (every balance change needs its ledger entry)',
            w_id, w_balance, COALESCE(l_balance, 0)
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ctrg_wallet_matches_ledger AFTER INSERT OR UPDATE OF balance ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_assert_wallet_ledger_consistent()`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ctrg_ledger_matches_wallet AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_assert_wallet_ledger_consistent()`);

    this.addSql(`
      CREATE FUNCTION fn_assert_tx_ledger_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        t_id uuid; t_status text; t_kind text; has_entry boolean;
      BEGIN
        IF TG_TABLE_NAME = 'wager_transactions' THEN t_id := NEW.id; ELSE t_id := NEW.transaction_id; END IF;
        SELECT status, kind INTO t_status, t_kind FROM wager_transactions WHERE id = t_id;
        SELECT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = t_id) INTO has_entry;
        IF (t_status = 'PROCESSED' AND t_kind <> 'LOSS') <> has_entry THEN
          RAISE EXCEPTION 'transaction % (status %, kind %) and its ledger entry are inconsistent', t_id, t_status, t_kind
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NULL;
      END $$`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ctrg_tx_matches_ledger AFTER INSERT OR UPDATE OF status ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_assert_tx_ledger_consistent()`);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ctrg_ledger_matches_tx AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_assert_tx_ledger_consistent()`);

    // ---- outbox event content is immutable
    this.addSql(`
      CREATE FUNCTION fn_outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id <> OLD.id OR NEW.aggregate_id <> OLD.aggregate_id OR NEW.event_type <> OLD.event_type
           OR NEW.payload <> OLD.payload OR NEW.occurred_at <> OLD.occurred_at THEN
          RAISE EXCEPTION 'outbox event content is immutable' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$`);
    this.addSql(`
      CREATE TRIGGER trg_outbox_guard BEFORE UPDATE ON outbox_messages
        FOR EACH ROW EXECUTE FUNCTION fn_outbox_guard()`);
  }

  override async down(): Promise<void> {
    // Reversible: tear down in reverse dependency order. (Dev/test only: destroys financial data.)
    this.addSql(`DROP TABLE IF EXISTS outbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS inbox_messages`);
    this.addSql(`DROP TABLE IF EXISTS wallet_ledger_entries`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions`);
    this.addSql(`DROP TABLE IF EXISTS wallets`);
    for (const fn of [
      'fn_outbox_guard',
      'fn_assert_tx_ledger_consistent',
      'fn_assert_wallet_ledger_consistent',
      'fn_wager_tx_guard',
      'fn_wallet_guard',
      'fn_ledger_immutable',
    ]) {
      this.addSql(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  }
}
