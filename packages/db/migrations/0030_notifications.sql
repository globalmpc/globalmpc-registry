-- Notifications — spec 12 §12.4 R2 scope.
--
-- **Builds something that did not exist.** When a review request, gap, stale, or revoke occurred, the
-- only way for the party to learn was reopening the screen. That does not answer "what changed" —
-- people had to remember the previous state of every screen.
--
-- **Why triggers.** Adding notification creation to each route risks omission with every new
-- route, and an omission shows up only as "no notification arrived". Attached where the event is
-- created (the table), notifications are created whichever path the event came through.
--
-- **The delivery channel is not decided here.** Whether to send via mail, webhook, or push
-- is undecided. This table holds what is needed regardless of that decision — **which
-- notification goes to whom** — and opens the in-app read path first.

CREATE TYPE core.notification_kind AS ENUM (
  'review_assigned',
  'readiness_gap',
  'evidence_stale',
  'registry_revoked'
);

CREATE TABLE core.notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES core.tenants(id),
  kind          core.notification_kind NOT NULL,
  /**
   * To an individual, or to a role?
   *
   * Review assignments go to the assignee. Stale signals and revocations are **events
   * assigned to no one**, so there is no individual — sending them to one person means no one
   * knows while that person is away. Send to the role; anyone holding it reads.
   */
  subject_id    UUID REFERENCES core.subjects(id),
  audience_role TEXT,
  project_id    UUID,
  summary       TEXT NOT NULL CHECK (length(btrim(summary)) > 0),
  /** The screen this notification points to. A notification with nowhere to go must be searched for again. */
  link          TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notification_has_audience CHECK (
    (subject_id IS NOT NULL AND audience_role IS NULL)
    OR (subject_id IS NULL AND audience_role IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id)
);

CREATE INDEX notifications_subject_idx
  ON core.notifications (tenant_id, subject_id, occurred_at DESC)
  WHERE subject_id IS NOT NULL;
CREATE INDEX notifications_role_idx
  ON core.notifications (tenant_id, audience_role, occurred_at DESC)
  WHERE audience_role IS NOT NULL;

/**
 * Read state is **per subject**.
 *
 * Role notifications are seen by several people. A `read_at` on the notification row would hide it
 * from everyone else the moment one person reads it, and if that person does not act, no one sees it again.
 */
CREATE TABLE core.notification_reads (
  notification_id UUID NOT NULL REFERENCES core.notifications(id),
  subject_id      UUID NOT NULL REFERENCES core.subjects(id),
  tenant_id       UUID NOT NULL REFERENCES core.tenants(id),
  read_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, subject_id)
);

ALTER TABLE core.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE core.notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.notification_reads FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_tenant ON core.notifications FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());
CREATE POLICY notification_reads_tenant ON core.notification_reads FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.notifications TO mpc_app;
GRANT SELECT, INSERT ON core.notification_reads TO mpc_app;

-- ---------------------------------------------------------------------------
-- event → notification
-- ---------------------------------------------------------------------------
--
-- Triggers are not `SECURITY DEFINER`. They run inside the tenant of the transaction that
-- created the event, so RLS holds as is — notifications do not leak to other tenants.

/** Review assignment → to the assignee. */
CREATE FUNCTION core.notify_review_assigned() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target_project UUID;
BEGIN
  SELECT c.project_id INTO target_project
  FROM core.verification_cases c WHERE c.id = NEW.case_id;

  INSERT INTO core.notifications (tenant_id, kind, subject_id, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'review_assigned', NEW.subject_id, target_project,
    'Review assigned',
    '/w/projects/' || target_project || '/verification'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER assignments_notify
  AFTER INSERT ON core.assignments
  FOR EACH ROW EXECUTE FUNCTION core.notify_review_assigned();

/**
 * readiness gap → to the data_steward role.
 *
 * A gap is not one person's job. Whoever fills the evidence fills it.
 */
CREATE FUNCTION core.notify_readiness_gap() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'gap' THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'readiness_gap', 'data_steward', NEW.project_id,
    'Readiness assessment found a gap',
    '/w/projects/' || NEW.project_id || '/readiness'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER compliance_assessments_notify
  AFTER INSERT ON core.compliance_assessments
  FOR EACH ROW EXECUTE FUNCTION core.notify_readiness_gap();

/** stale signal → to the data_steward role. An event assigned to no one. */
CREATE FUNCTION core.notify_evidence_stale() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'evidence_stale', 'data_steward', NEW.project_id,
    'Evidence became stale: ' || NEW.reason,
    '/w/work'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_stale_signals_notify
  AFTER INSERT ON core.evidence_stale_signals
  FOR EACH ROW EXECUTE FUNCTION core.notify_evidence_stale();

/**
 * Public record revocation → to the mpc_operator role.
 *
 * Revocation takes down something public; a late notification means citations continue in the meantime.
 */
CREATE FUNCTION core.notify_registry_revoked() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  target_key TEXT;
  target_project UUID;
BEGIN
  IF NEW.status <> 'revoked' OR OLD.status = 'revoked' THEN
    RETURN NEW;
  END IF;

  SELECT e.public_key, p.id INTO target_key, target_project
  FROM core.registry_entries e
  LEFT JOIN core.projects p ON p.id = e.subject_id
  WHERE e.id = NEW.entry_id;

  INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
  VALUES (
    NEW.tenant_id, 'registry_revoked', 'mpc_operator', target_project,
    'Public record revoked: ' || coalesce(target_key, '(no key)'),
    '/w/registries'
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER registry_entry_versions_notify_revoked
  AFTER UPDATE ON core.registry_entry_versions
  FOR EACH ROW EXECUTE FUNCTION core.notify_registry_revoked();
