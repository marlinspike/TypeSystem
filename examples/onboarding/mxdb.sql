-- mxdb: a squadron maintenance database, written without TypeSystem. Terse
-- legacy names, codes instead of words, one relationship the schema never
-- declared, and personal data next to operational data. It is the input
-- to the onboarding demonstration (docs/how-to/onboard-a-source.md).
DROP SCHEMA IF EXISTS mx CASCADE;
CREATE SCHEMA mx;
COMMENT ON SCHEMA mx IS 'Squadron maintenance data system (MXDB)';

CREATE TYPE mx.evt_typ AS ENUM ('SCHED', 'UNSCH', 'TCTO', 'CANN');

CREATE TABLE mx.acft (
  tail_no      varchar(9) PRIMARY KEY,
  mds          varchar(8) NOT NULL,
  unit_cd      varchar(6) NOT NULL,
  base_icao    char(4) NOT NULL,
  mc_stat      char(3) NOT NULL CHECK (mc_stat IN ('FMC', 'PMC', 'NMC')),
  flt_hrs      numeric(8, 1),
  last_insp_dt date,
  depl_loc     varchar(40)
);
COMMENT ON TABLE mx.acft IS 'Aircraft master record: one row per assigned airframe';
COMMENT ON COLUMN mx.acft.mds IS 'Mission design series, e.g. F-16C';
COMMENT ON COLUMN mx.acft.mc_stat IS 'Mission capability: FMC fully, PMC partially, NMC not mission capable';
COMMENT ON COLUMN mx.acft.flt_hrs IS 'Total airframe flight hours';
COMMENT ON COLUMN mx.acft.depl_loc IS 'Forward deployment location. CLASSIFIED: SECRET when populated';

CREATE TABLE mx.tech (
  emp_id      varchar(8) PRIMARY KEY,
  last_nm     varchar(40) NOT NULL,
  first_nm    varchar(40) NOT NULL,
  ssn         char(9),
  home_phone  varchar(20),
  afsc        varchar(6) NOT NULL,
  skill_lvl   smallint CHECK (skill_lvl IN (3, 5, 7, 9))
);
COMMENT ON TABLE mx.tech IS 'Maintenance technicians';
COMMENT ON COLUMN mx.tech.afsc IS 'Air Force Specialty Code';

CREATE TABLE mx.mx_evt (
  evt_id     varchar(12) PRIMARY KEY,
  tail_no    varchar(9) NOT NULL REFERENCES mx.acft (tail_no),
  evt_typ    mx.evt_typ NOT NULL,
  wuc        varchar(5),
  descr      text NOT NULL,
  opened_ts  timestamptz NOT NULL,
  closed_ts  timestamptz
);
COMMENT ON TABLE mx.mx_evt IS 'Maintenance events (discrepancies and scheduled work)';
COMMENT ON COLUMN mx.mx_evt.wuc IS 'Work unit code of the affected system';

CREATE TABLE mx.wrk_ord (
  wo_no      varchar(12) PRIMARY KEY,
  evt_id     varchar(12) NOT NULL REFERENCES mx.mx_evt (evt_id),
  tech_emp   varchar(8),
  stat       varchar(10) NOT NULL CHECK (stat IN ('OPEN', 'INWORK', 'CLOSED')),
  created_ts timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mx.wrk_ord IS 'Work orders opened against maintenance events';
COMMENT ON COLUMN mx.wrk_ord.tech_emp IS 'Assigned technician (emp_id)';

INSERT INTO mx.acft VALUES
  ('AF86-0147', 'F-16C', '388FW', 'KHIF', 'PMC', 7412.3, '2026-09-30', 'FOB ALPHA'),
  ('AF87-0212', 'F-16C', '388FW', 'KHIF', 'FMC', 6980.0, '2026-10-02', NULL),
  ('AF88-0405', 'F-16C', '388FW', 'KHIF', 'NMC', 7120.8, '2026-08-21', NULL),
  ('AF09-4126', 'F-35A', '419FW', 'KHIF', 'FMC', 1840.5, '2026-10-05', NULL);

INSERT INTO mx.tech VALUES
  ('T-5501', 'Rivera', 'Jo', '123456789', '801-555-0100', '2A3X3', 7),
  ('T-5502', 'Okafor', 'Ade', '987654321', '801-555-0101', '2A3X3', 5),
  ('T-5503', 'Chen', 'Mei', NULL, NULL, '2A6X1', 5);

INSERT INTO mx.mx_evt VALUES
  ('EVT-9001', 'AF86-0147', 'SCHED', '11000', 'Phase inspection', '2026-09-28T07:00:00Z', '2026-09-30T16:00:00Z'),
  ('EVT-9002', 'AF86-0147', 'UNSCH', '74000', 'Fire control radar intermittent', '2026-10-11T09:20:00Z', NULL),
  ('EVT-9003', 'AF88-0405', 'UNSCH', '23000', 'Engine borescope finding', '2026-10-09T13:45:00Z', NULL),
  ('EVT-9004', 'AF87-0212', 'TCTO', '14000', 'Canopy seal TCTO 1F-16-1234', '2026-10-01T08:00:00Z', '2026-10-01T15:30:00Z');

INSERT INTO mx.wrk_ord VALUES
  ('WO-0001', 'EVT-9001', 'T-5502', 'CLOSED', '2026-09-28T07:15:00Z'),
  ('WO-0002', 'EVT-9002', 'T-5501', 'INWORK', '2026-10-11T10:00:00Z'),
  ('WO-0003', 'EVT-9003', NULL, 'OPEN', '2026-10-09T14:00:00Z');
