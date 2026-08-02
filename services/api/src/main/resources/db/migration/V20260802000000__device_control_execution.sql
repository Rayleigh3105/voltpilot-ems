-- =============================================================================
-- V20260802000000 - device_control_status: the in-slot EXECUTION truth.
-- ADDITIVE (nullable columns only; RLS policy + grants are table-level and
-- already cover them).
-- -----------------------------------------------------------------------------
-- Since the in-slot duties (2026-07-30) the edge DELIBERATELY deviates from the
-- plan's watt value: it tracks the measured house deficit (load following) or
-- holds a charge at the measured PV surplus (price-aware trim). `commanded_kw`
-- has carried the CORRECTED value ever since - but nothing said WHY, so the
-- portal could only state that "the device adjusted the value" while the
-- Fahrplan bar next to it showed a different number (Konzept
-- vp-fahrplan-kunde-konzept K2/§5, PR 3).
--
-- The heartbeat's additive `control.execution` block now carries the reason,
-- and the top-level `control_source` (sent for ages, ignored until now) says
-- whether the plan drives the device at all. Both land here.
--
--   control_source       "schedule" | "default" - the device's own COARSE
--                        truth. Deliberately coarse: it collapses every
--                        non-schedule mode (self-consumption fallback, a v2
--                        desired holding the battery, calibration) into
--                        "default", which is exactly why it may never be read
--                        as "the built-in safety rule is running".
--   execution_mode       plan | follow | trim | fallback (NULL on an older
--                        edge, or on a mode that maps onto none of them - the
--                        edge omits the block rather than mislabel it).
--   execution_direction  deepen | reduce - only for mode "follow": the
--                        discharge was RAISED to cover the house, or LIMITED
--                        to what it needs. An unnamed correction reads as a
--                        defect, so the direction is the load-bearing half.
--   execution_planned_kw the setpoint BEFORE the correction, so plan and
--                        execution can stand side by side instead of being two
--                        contradicting numbers under one word.
--   execution_target_kw  the MEASURED value the correction tracks - the house
--                        deficit for "follow", the PV surplus for "trim".
--                        Which one it is follows unambiguously from the mode;
--                        NULL when the device could not measure it (it never
--                        regulates blind, and never reports blind either).
--
-- NULL everywhere = an older edge => every consumer keeps its pre-PR-3
-- behaviour (the generic "the device adjusted the value" wording), never a
-- guessed direction.
--
-- Date-based version per the AGENTS.md migration-version coordination.
-- =============================================================================

ALTER TABLE device_control_status
    ADD COLUMN IF NOT EXISTS control_source       TEXT,
    ADD COLUMN IF NOT EXISTS execution_mode       TEXT,
    ADD COLUMN IF NOT EXISTS execution_direction  TEXT,
    ADD COLUMN IF NOT EXISTS execution_planned_kw DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS execution_target_kw  DOUBLE PRECISION;
