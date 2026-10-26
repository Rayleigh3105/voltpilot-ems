-- V20261026120000 - Eine OCPP-Säule wird als Leistung geplant, nicht geschaltet (Audit W-02).
--
-- Der Katalogtyp ev-charger kennt nur limit_kw. Bis hierher fiel ConsumerService dabei auf
-- die Regelart on_off zurück; der Optimierer schrieb dann on_off in den Plan, und die Box
-- verwirft dieses Wort an der Säule (capability:unsupported_command) - „Günstig" und
-- „Ziel bis Uhrzeit" kamen nie an. Neue Profile entstehen seither als continuous: die Box
-- trägt den geplanten setpoint_kw als Grenze (consumerCommandsFor, nur limit_kw ohne
-- setpoint_kw). Hier ziehen die bestehenden Profile nach.
--
-- Nur der alte Rückfall wird umgeschrieben: eine Säule hatte keine andere Wahl, on_off ist
-- also nie bewusst eingestellt worden. Idempotent - ein zweiter Lauf findet nichts mehr;
-- auf einer frischen Datenbank ändert sie nichts. Die Migration läuft als Eigentümer
-- (RLS greift nicht).
--
-- Dazu der Nachweiskanal: eine Säule hat keine gebundene Quelle, also blieb
-- confirmation_channel NULL, und die API sperrte jedes kWh-Ziel („Ohne Messung …").
-- Die Box veröffentlicht power_kw je Säulen-Komponente (agent/ocpp_entities.go); nur ein
-- fehlender Kanal wird gesetzt, nie ein vorhandener überschrieben.
UPDATE consumer_profile cp
   SET control_kind = CASE WHEN cp.control_kind = 'on_off' THEN 'continuous'
                           ELSE cp.control_kind END,
       confirmation_channel = COALESCE(cp.confirmation_channel, 'power_kw'),
       version = cp.version + 1,
       updated_at = now()
  FROM measurement_point mp
 WHERE mp.id = cp.entity_id
   AND mp.entity_type = 'ev-charger'
   AND (cp.control_kind = 'on_off' OR cp.confirmation_channel IS NULL);
