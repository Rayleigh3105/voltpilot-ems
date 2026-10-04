-- MiSpeL MP-27b (Vertrag docs/contracts/v2/mispel-foerderweg.md § 5a, „Umsetzen“): sobald VoltPilot den Tag in
-- voltpilot.mispel.pauschaloption-ab einträgt (E7 = B; Tenor S. 3 Ziff. 9 b), macht der PauschalVormerkungLaeufer
-- aus jeder stehenden Vormerkung eine Fassung von site_foerderweg zum nächsten Monatsersten (§ 21b Abs. 1 S. 2 EEG;
-- A2 S. 52 mit Fn. 40). Die Vormerkung bleibt dabei als Zeile stehen — mit ihren Bestätigungen der Voraussetzungen 2
-- und 4 der Anlage 2 samt Datum (A2 S. 18–19) — und wird aufgehoben; umgesetzt_in nennt die Fassung, die aus ihr
-- wurde. Aufgehoben OHNE umgesetzt_in = vom Kunden zurückgenommen oder geändert.
--
-- Rein additiv: eine leere Spalte, ein CHECK, der jede vorhandene Zeile trägt (umgesetzt_in ist überall leer), und
-- das Spaltenrecht für den Läufer. Ändert keine Bestandszeile.
ALTER TABLE site_pauschal_vormerkung ADD COLUMN IF NOT EXISTS umgesetzt_in UUID;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_pauschal_vormerkung_umgesetzt_fk') THEN
        -- Löscht der Betreiber die Fassung (Admin-Rolle), bleibt die Vormerkung mit ihren Bestätigungen lesbar.
        ALTER TABLE site_pauschal_vormerkung ADD CONSTRAINT site_pauschal_vormerkung_umgesetzt_fk
            FOREIGN KEY (umgesetzt_in) REFERENCES site_foerderweg (id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'site_pauschal_vormerkung_umgesetzt_chk') THEN
        -- Eine umgesetzte Vormerkung steht nicht mehr (höchstens eine stehende je Anlage, Index ..._eine).
        ALTER TABLE site_pauschal_vormerkung ADD CONSTRAINT site_pauschal_vormerkung_umgesetzt_chk
            CHECK (umgesetzt_in IS NULL OR aufgehoben_am IS NOT NULL);
    END IF;
END
$$;

GRANT UPDATE (aufgehoben_am, umgesetzt_in) ON site_pauschal_vormerkung TO ${appDbUser};

COMMENT ON COLUMN site_pauschal_vormerkung.umgesetzt_in IS
    'MiSpeL MP-27b: die Fassung von site_foerderweg, die der PauschalVormerkungLaeufer aus dieser Vormerkung gemacht hat (oder die der Kunde selbst eingetragen hatte); leer = nicht umgesetzt.';
