-- AP-09 IP-18: additive dritte Bindungsart; bisherige Bindungen bleiben unverändert.
ALTER TABLE bezugsgroesse_kanalbindung
    ADD COLUMN raumtemperatur numeric,
    ADD COLUMN heizgrenze numeric;
ALTER TABLE bezugsgroesse_kanalbindung DROP CONSTRAINT bezugsgroesse_kanalbindung_wertart_check;
ALTER TABLE bezugsgroesse_kanalbindung ADD CONSTRAINT bezugsgroesse_kanalbindung_wertart_check
    CHECK (wertart IN ('counter','state','gauge'));
ALTER TABLE bezugsgroesse_kanalbindung DROP CONSTRAINT bezugskanal_zustand_chk;
ALTER TABLE bezugsgroesse_kanalbindung ADD CONSTRAINT bezugskanal_zustand_chk CHECK (coalesce(
    (wertart='state' AND btrim(zustand)<>'') OR (wertart IN ('counter','gauge') AND zustand IS NULL),false));
ALTER TABLE bezugsgroesse_kanalbindung ADD CONSTRAINT bezugskanal_gradtag_chk CHECK (coalesce(
    (wertart='gauge' AND einheit='°C' AND raumtemperatur IS NOT NULL AND heizgrenze IS NOT NULL
        AND raumtemperatur > heizgrenze AND raumtemperatur NOT IN ('NaN'::numeric,'Infinity'::numeric)
        AND heizgrenze NOT IN ('NaN'::numeric,'-Infinity'::numeric))
    OR (wertart<>'gauge' AND raumtemperatur IS NULL AND heizgrenze IS NULL),false));
GRANT INSERT (raumtemperatur,heizgrenze) ON bezugsgroesse_kanalbindung TO ${appDbUser};
