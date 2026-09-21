-- UEMS AP-15 IP-30 (A4, B5): die Verbund-Bilanz rechnet einen Tag, der noch
-- `unbekannt` steht, in den Folgetagen neu — die Boxen puffern 48 h, eine
-- Viertelstunde kann nach dem ersten Lauf (04:37) nachgeliefert werden.
-- Die App-Rolle darf dafür die Urteilsspalten eines Tages ändern; welcher Tag
-- geändert wird, begrenzt VerbundBilanzRepository#nachrechnen auf
-- zustand = 'unbekannt' (ein plausibel/unplausibel-Urteil bleibt, wie es ist).
-- Schlüssel und Zaun (tenant_id, site_id, steuerungsverbund_id, tag) bleiben
-- unveränderlich: nur Spaltenrechte, keine Zeile wird hier geändert.
GRANT UPDATE (zustand, grund, viertelstunden_erwartet, viertelstunden_plausibel,
              viertelstunden_unplausibel, viertelstunden_unbekannt,
              geringstes_ungeregeltes_kw, geringstes_toleranz_kw, geringstes_von,
              grundlage, stufe_vorher, auf_s1_zurueck, gerechnet_am, gerechnet_von,
              hoechstes_ungeregeltes_kw, hoechstes_von)
    ON steuerungsverbund_bilanz TO ${appDbUser};
