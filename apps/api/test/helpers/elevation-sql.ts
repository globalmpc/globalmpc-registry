/**
 * The test-only elevation behind `issueTestSession`. Created over the superuser connection, owned
 * by it, and granted to the application role; it bypasses no check the table holds — it writes
 * the proof rows a ceremony writes. The fixture passkey and TOTP are per subject and reused, and
 * their key material is random filler: nothing ever verifies against them.
 */
export const TEST_ELEVATION_SQL = `
  CREATE SCHEMA IF NOT EXISTS test_support;
  GRANT USAGE ON SCHEMA test_support TO mpc_app;
  CREATE OR REPLACE FUNCTION test_support.elevate_session(
    p_session UUID, p_factor core.session_second_factor
  ) RETURNS VOID
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = core, pg_temp AS $fn$
  DECLARE
    v core.sessions;
    v_proof UUID := gen_random_uuid();
    v_challenge UUID := gen_random_uuid();
    v_credential UUID;
    v_totp UUID;
    v_code UUID := gen_random_uuid();
  BEGIN
    SELECT * INTO v FROM core.sessions
    WHERE id = p_session AND subject_id = core.current_actor() FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'no session % of the current actor', p_session; END IF;

    IF p_factor = 'passkey' THEN
      SELECT id INTO v_credential FROM core.webauthn_credentials
      WHERE credential_id = 'fixture-' || replace(v.subject_id::text, '-', '');
      IF v_credential IS NULL THEN
        v_credential := gen_random_uuid();
        INSERT INTO core.webauthn_credentials (
          id, subject_id, credential_id, public_key, aaguid, user_verified, device_type,
          backed_up, name
        ) VALUES (
          v_credential, v.subject_id, 'fixture-' || replace(v.subject_id::text, '-', ''),
          (uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), '00000000-0000-0000-0000-000000000000', true, 'singleDevice', false,
          'Fixture passkey'
        );
      END IF;
      INSERT INTO core.webauthn_challenges (
        id, subject_id, session_id, purpose, challenge, expires_at, consumed_at,
        consumed_by_session_id
      ) VALUES (
        v_challenge, v.subject_id, v.id, 'authentication',
        rtrim(translate(encode((uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())), 'base64'), '+/', '-_'), '='),
        now() + interval '5 minutes', now(), v.id
      );
      INSERT INTO core.session_factor_proofs (
        id, subject_id, session_id, factor, webauthn_challenge_id, webauthn_credential_id
      ) VALUES (v_proof, v.subject_id, v.id, 'passkey', v_challenge, v_credential);
    ELSIF p_factor = 'totp' THEN
      SELECT id INTO v_totp FROM core.totp_authenticators
      WHERE subject_id = v.subject_id AND confirmed_at IS NOT NULL AND revoked_at IS NULL;
      IF v_totp IS NULL THEN
        v_totp := gen_random_uuid();
        INSERT INTO core.totp_authenticators (
          id, subject_id, secret_ciphertext, secret_nonce, pending_expires_at, confirmed_at
        ) VALUES (
          v_totp, v.subject_id, (uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid())),
          substring(uuid_send(gen_random_uuid()) FROM 1 FOR 12), now(), now()
        );
      END IF;
      INSERT INTO core.session_factor_proofs (
        id, subject_id, session_id, factor, totp_authenticator_id, totp_step
      ) VALUES (
        v_proof, v.subject_id, v.id, 'totp', v_totp,
        (extract(epoch FROM clock_timestamp()) * 1000000)::bigint
      );
    ELSE
      INSERT INTO core.recovery_codes (
        id, subject_id, set_id, code_hash, consumed_at, consumed_by_session_id
      ) VALUES (
        v_code, v.subject_id, gen_random_uuid(), encode(sha256(uuid_send(gen_random_uuid())), 'hex'),
        now(), v.id
      );
      INSERT INTO core.session_factor_proofs (
        id, subject_id, session_id, factor, recovery_code_id
      ) VALUES (v_proof, v.subject_id, v.id, 'recovery_code', v_code);
    END IF;

    UPDATE core.sessions
    SET second_factor = p_factor, second_factor_at = now(), second_factor_proof_id = v_proof,
        recovery_limited = (p_factor = 'recovery_code')
    WHERE id = v.id;
  END
  $fn$;
  REVOKE EXECUTE ON FUNCTION test_support.elevate_session(UUID, core.session_second_factor) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION test_support.elevate_session(UUID, core.session_second_factor) TO mpc_app;
`;
