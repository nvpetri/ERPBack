CREATE TABLE company (
 id uuid PRIMARY KEY, slug varchar(60) UNIQUE NOT NULL, name varchar(100) NOT NULL,
 sector varchar(30) NOT NULL DEFAULT 'RETAIL', primary_color char(7) NOT NULL DEFAULT '#136D5E',
 accent_color char(7) NOT NULL DEFAULT '#D8A34A', logo bytea, logo_version integer NOT NULL DEFAULT 0,
 channels text[] NOT NULL DEFAULT '{COUNTER}', modules text[] NOT NULL DEFAULT '{DASHBOARD,AUDIT}',
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_user (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES company(id), name varchar(80) NOT NULL,
 email varchar(254) NOT NULL, password_hash text, role varchar(10) NOT NULL CHECK (role IN ('MANAGER','CASHIER')),
 enabled boolean NOT NULL DEFAULT true, shared_account boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(company_id,email), UNIQUE(company_id,id)
);
CREATE TABLE session (
 id uuid PRIMARY KEY, company_id uuid NOT NULL, user_id uuid NOT NULL, token_hash char(64) NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(company_id,user_id) REFERENCES app_user(company_id,id)
);
CREATE INDEX session_expiry_idx ON session(expires_at);
CREATE TABLE rate_bucket (key char(64) PRIMARY KEY, count integer NOT NULL, resets_at timestamptz NOT NULL);
CREATE TABLE invitation (
 id uuid PRIMARY KEY, company_id uuid NOT NULL, user_id uuid NOT NULL, token_hash char(64) NOT NULL UNIQUE,
 purpose varchar(10) NOT NULL CHECK(purpose IN ('INVITE','RESET')), expires_at timestamptz NOT NULL, consumed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(company_id,user_id) REFERENCES app_user(company_id,id)
);
CREATE TABLE product (
 id uuid NOT NULL, company_id uuid NOT NULL REFERENCES company(id), sku varchar(40) NOT NULL,
 name varchar(100) NOT NULL, category varchar(60) NOT NULL, unit varchar(2) NOT NULL CHECK(unit IN ('UN','KG')),
 price integer NOT NULL CHECK(price BETWEEN 1 AND 100000000), active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,id), UNIQUE(company_id,sku)
);
CREATE TABLE sale (
 id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES company(id), number bigint GENERATED ALWAYS AS IDENTITY,
 actor_id uuid NOT NULL, channel varchar(20) NOT NULL, status varchar(10) NOT NULL DEFAULT 'COMPLETED' CHECK(status IN ('COMPLETED','CANCELLED')),
 subtotal integer NOT NULL CHECK(subtotal > 0), discount integer NOT NULL CHECK(discount >= 0 AND discount < subtotal),
 total integer NOT NULL CHECK(total = subtotal - discount), version integer NOT NULL DEFAULT 1,
 cancelled_reason varchar(240), created_at timestamptz NOT NULL DEFAULT now(), cancelled_at timestamptz,
 FOREIGN KEY(company_id,actor_id) REFERENCES app_user(company_id,id), UNIQUE(company_id,id)
);
CREATE INDEX sale_company_created_idx ON sale(company_id,created_at DESC,id);
CREATE TABLE sale_item (
 id uuid PRIMARY KEY, company_id uuid NOT NULL, sale_id uuid NOT NULL, product_id uuid NOT NULL,
 sku varchar(40) NOT NULL, name varchar(100) NOT NULL, unit varchar(2) NOT NULL,
 quantity integer NOT NULL CHECK(quantity > 0), price integer NOT NULL CHECK(price > 0), total integer NOT NULL CHECK(total > 0),
 FOREIGN KEY(company_id,sale_id) REFERENCES sale(company_id,id), FOREIGN KEY(company_id,product_id) REFERENCES product(company_id,id)
);
CREATE TABLE payment (
 id uuid PRIMARY KEY, company_id uuid NOT NULL, sale_id uuid NOT NULL,
 method varchar(10) NOT NULL CHECK(method IN ('CASH','PIX','CREDIT','DEBIT')), amount integer NOT NULL CHECK(amount > 0),
 tendered integer, CHECK((method='CASH' AND tendered>=amount) OR (method<>'CASH' AND tendered IS NULL)),
 FOREIGN KEY(company_id,sale_id) REFERENCES sale(company_id,id)
);
CREATE TABLE idempotency (
 company_id uuid NOT NULL REFERENCES company(id), user_id uuid NOT NULL, key uuid NOT NULL, fingerprint char(64) NOT NULL,
 response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,user_id,key),
 FOREIGN KEY(company_id,user_id) REFERENCES app_user(company_id,id)
);
CREATE TABLE audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, company_id uuid NOT NULL,
 table_name varchar(40) NOT NULL, record_id text NOT NULL, operation varchar(10) NOT NULL,
 actor_id uuid, actor_name varchar(80), actor_role varchar(10), shared_account boolean NOT NULL DEFAULT false,
 request_id uuid, source varchar(20) NOT NULL, before_data jsonb, after_data jsonb,
 changed_fields text[] NOT NULL, database_user text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_company_id_idx ON audit(company_id,id DESC);
CREATE FUNCTION erp_audit_safe(value jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; item record;
BEGIN
 IF value IS NULL THEN RETURN NULL; END IF;
 IF jsonb_typeof(value)='object' THEN
  result:='{}'::jsonb;
  FOR item IN SELECT * FROM jsonb_each(value) LOOP
   IF lower(item.key) ~ '(password|token|secret|email|logo)' THEN result:=result||jsonb_build_object(item.key,'[REDACTED]');
   ELSE result:=result||jsonb_build_object(item.key,public.erp_audit_safe(item.value)); END IF;
  END LOOP; RETURN result;
 ELSIF jsonb_typeof(value)='array' THEN
  SELECT COALESCE(jsonb_agg(public.erp_audit_safe(v)),'[]'::jsonb) INTO result FROM jsonb_array_elements(value) v;
  RETURN result;
 END IF;
 RETURN value;
END $$;
CREATE FUNCTION erp_capture_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a jsonb; b jsonb; row_data jsonb; ctx jsonb; fields text[];
BEGIN
 a:=CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) ELSE NULL END;
 b:=CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) ELSE NULL END;
 IF a IS NOT DISTINCT FROM b THEN RETURN NEW; END IF;
 row_data:=COALESCE(b,a); ctx:=COALESCE(NULLIF(current_setting('erp.actor',true),'')::jsonb,'{}'::jsonb);
 SELECT COALESCE(array_agg(k),'{}') INTO fields FROM (SELECT jsonb_object_keys(COALESCE(a,'{}')) k UNION SELECT jsonb_object_keys(COALESCE(b,'{}')) k) keys WHERE a->k IS DISTINCT FROM b->k;
 INSERT INTO public.audit(company_id,table_name,record_id,operation,actor_id,actor_name,actor_role,shared_account,request_id,source,before_data,after_data,changed_fields,database_user)
 VALUES(CASE WHEN TG_TABLE_NAME='company' THEN (row_data->>'id')::uuid ELSE (row_data->>'company_id')::uuid END,TG_TABLE_NAME,row_data->>'id',TG_OP,
 (ctx->>'id')::uuid,ctx->>'name',ctx->>'role',COALESCE((ctx->>'shared_account')::boolean,false),(ctx->>'request_id')::uuid,
 COALESCE(ctx->>'source','SQL'),public.erp_audit_safe(a),public.erp_audit_safe(b),fields,session_user);
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE FUNCTION erp_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Registro imutável; use os fluxos de negócio'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON audit FOR EACH STATEMENT EXECUTE FUNCTION erp_immutable();
CREATE TRIGGER sale_no_delete BEFORE DELETE OR TRUNCATE ON sale FOR EACH STATEMENT EXECUTE FUNCTION erp_immutable();
CREATE TRIGGER sale_item_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON sale_item FOR EACH STATEMENT EXECUTE FUNCTION erp_immutable();
CREATE TRIGGER payment_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON payment FOR EACH STATEMENT EXECUTE FUNCTION erp_immutable();
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['company','app_user','product','sale','sale_item','payment','invitation'] LOOP
  EXECUTE format('CREATE TRIGGER erp_audit BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION erp_capture_change()',t);
  EXECUTE format('CREATE TRIGGER erp_no_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION erp_immutable()',t);
 END LOOP;
END $$;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON audit FROM PUBLIC;
