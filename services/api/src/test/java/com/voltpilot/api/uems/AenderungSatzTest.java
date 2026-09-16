package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Rein, ohne Docker: JE EINTRAGSART ein geprüfter Wortlaut (UEMS AP-04 IP-21). Die Eingänge
 * sind die JSON-Formen, die die bestehenden Schreibwege wirklich schreiben — nicht erfundene;
 * die Vollständigkeit prüft der Test unten gegen die Vokabulare der Migrationen.
 *
 * <p>Der Satz sagt nur das WAS. WANN die Änderung gilt, WANN sie eingetragen wurde, WER sie war
 * und ob sie rückwirkend war, steht an der Zeile selbst — nie im Satz erfunden.
 */
class AenderungSatzTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode j(String text) {
        try {
            return text == null ? null : MAPPER.readTree(text);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String satz(String bezugArt, String art, String alt, String neu) {
        return AenderungSatz.satz(bezugArt, art, j(alt), j(neu), null);
    }

    @Test
    void rollenProtokollNenntDenWertUndSeinenVorgaenger() {
        String alt = "{\"rolle\":\"pv\",\"wert\":{\"art\":\"messkanal\",\"capability\":\"pv_power_kw\",\"name\":\"pv_power_kw\"}}";
        String neu = "{\"rolle\":\"pv\",\"wert\":{\"art\":\"gesamtwert\",\"name\":\"Dach West\"}}";
        assertThat(satz("anlage", "rolle_gesetzt", alt, neu)).isEqualTo("PV-Produktion: „Dach West“ statt „PV-Leistung“");
        assertThat(satz("anlage", "rolle_gesetzt", null, neu)).isEqualTo("PV-Produktion: „Dach West“ zugeordnet");
        assertThat(satz("anlage", "rolle_entzogen", neu, null)).isEqualTo("PV-Produktion entzogen: „Dach West“");
    }

    // ---- Die Messstellen-Einträge (messstelle_aenderung) --------------------------------------

    @Test
    void derLebenszyklusEinerMessstelleSprichtKundensprache() {
        assertThat(satz("messstelle", "angelegt", null,
                "{\"kennzeichen\":\"MS-06\",\"name\":\"Hauptzähler Werk\",\"art\":\"gemessen\"}"))
                .isEqualTo("Messstelle angelegt: Hauptzähler Werk");
        assertThat(satz("messstelle", "bearbeitet", "{\"name\":\"Zähler Halle 2\"}",
                "{\"name\":\"Hauptzähler Werk\"}"))
                .isEqualTo("Messstelle bearbeitet: Name „Zähler Halle 2“ → „Hauptzähler Werk“");
        assertThat(satz("messstelle", "angehalten", "{\"angehalten_ab\":null}",
                "{\"angehalten_ab\":\"2026-11-18T10:40:00Z\"}"))
                .isEqualTo("Messstelle angehalten");
        assertThat(satz("messstelle", "fortgesetzt", null, null)).isEqualTo("Messstelle fortgesetzt");
        assertThat(satz("messstelle", "archiviert", null, null)).isEqualTo("Messstelle archiviert");
        assertThat(satz("messstelle", "nebengroesse_hinzugefuegt", null,
                "{\"groesse\":\"Ladestand\",\"richtung\":\"richtungslos\"}"))
                .isEqualTo("Nebengröße hinzugefügt: Ladestand · richtungslos");
        assertThat(satz("messstelle", "nebengroesse_archiviert", null, "{\"groesse\":\"Ladestand\"}"))
                .isEqualTo("Nebengröße archiviert: Ladestand");
    }

    /** Eine Änderung ohne Vorher-Wert („Notiz erst jetzt gesetzt") behauptet kein „→". */
    @Test
    void bearbeitetNenntNurGeaenderteFelderUndNieEinenErfundenenVorherWert() {
        assertThat(satz("messstelle", "bearbeitet", "{\"notiz\":null}", "{\"notiz\":\"Neu verdrahtet\"}"))
                .isEqualTo("Messstelle bearbeitet: Notiz geändert");
        assertThat(satz("messstelle", "bearbeitet",
                "{\"kennzeichen\":\"MS-06\",\"name\":\"alt\"}",
                "{\"kennzeichen\":\"HZ-WERK\",\"name\":\"neu\"}"))
                .isEqualTo("Messstelle bearbeitet: Kennzeichen „MS-06“ → „HZ-WERK“, Name „alt“ → „neu“");
        // Ein Feld, das kein Kundenwort hat, macht keinen halben Satz.
        assertThat(satz("messstelle", "bearbeitet", null, "{\"unbekannt\":\"x\"}"))
                .isEqualTo("Messstelle bearbeitet");
    }

    @Test
    void ortStellungQuelleUndEinstellungNennenIhreFakten() {
        assertThat(satz("messstelle", "ort_zugeordnet", null,
                "{\"ort_art\":\"bereich\",\"kennzeichen\":\"B-3\",\"gueltig_ab\":\"2026-10-01\"}"))
                .isEqualTo("Ort zugeordnet: B-3");
        assertThat(satz("messstelle", "ort_korrigiert", null, "{\"kennzeichen\":\"G-2\"}"))
                .isEqualTo("Ort berichtigt: G-2");
        assertThat(satz("messstelle", "stellung_zugeordnet", null,
                "{\"stellung\":\"Hauptzähler\",\"unterzaehler_von\":null}"))
                .isEqualTo("Elektrische Stellung zugeordnet: Hauptzähler");
        assertThat(satz("messstelle", "stellung_korrigiert", null,
                "{\"stellung\":\"Unterzähler\",\"unterzaehler_von\":\"MS-01\"}"))
                .isEqualTo("Elektrische Stellung berichtigt: Unterzähler von MS-01");
        assertThat(satz("messstelle", "quelle_gebunden", null,
                "{\"groesse\":\"Wirkenergie\",\"richtung\":\"Bezug\",\"rolle\":\"fuehrend\","
                + "\"kanal\":\"sunspec.model_203.totwhimp\",\"geraet\":\"GR-4\",\"einbau\":\"Z-5b\"}"))
                .isEqualTo("Quelle gebunden: Z-5b · Wirkenergie · Bezug (führend)");
        assertThat(satz("messstelle", "quelle_gebunden", null,
                "{\"groesse\":\"Wirkenergie\",\"richtung\":\"Bezug\",\"rolle\":\"vergleich\",\"einbau\":\"Z-5a\"}"))
                .isEqualTo("Quelle gebunden: Z-5a · Wirkenergie · Bezug (Vergleich)");
        assertThat(satz("messstelle", "quelle_beendet", null,
                "{\"quelle_id\":\"…\",\"einbau\":\"Z-5a\",\"gueltig_bis\":\"2026-11-18T10:40:00+01:00\"}"))
                .isEqualTo("Quelle beendet: Z-5a");
        assertThat(satz("messstelle", "einstellung_geaendert",
                "{\"einbau\":\"Z-5a\",\"art\":\"wandler_strom\",\"wert_text\":\"100/5 A\"}",
                "{\"einbau\":\"Z-5a\",\"art\":\"wandler_strom\",\"wert_text\":\"150/5 A\"}"))
                .isEqualTo("Einstellung geändert: 100/5 A → 150/5 A (Z-5a)");
        assertThat(satz("messstelle", "einstellung_geaendert", null,
                "{\"einbau\":\"Z-5b\",\"wert_text\":\"150/5 A\"}"))
                .isEqualTo("Einstellung geändert: 150/5 A (Z-5b)");
    }

    /** Der Plan-Fall: der Wechsel nennt BEIDE Geräte — deshalb steht er in beiden Protokollen. */
    @Test
    void derZaehlerwechselNenntBeideGeraete() {
        assertThat(satz("messstelle", "zaehler_gewechselt",
                "{\"einbau\":\"Z-5a\",\"seriennummer\":\"1EMH…\"}",
                "{\"vorgaenger\":\"Z-5a\",\"einbau\":\"Z-5b\",\"geraet\":\"GR-4\"}"))
                .isEqualTo("Zähler gewechselt: Z-5a → Z-5b");
    }

    // ---- Die Orts-Einträge (ort_aenderung) ----------------------------------------------------

    @Test
    void dieOrtsstrukturSprichtIhreEigenenObjektarten() {
        assertThat(satz("standort", "angelegt", null, "{\"name\":\"Werk Lindach\",\"kurzzeichen\":\"ST-1\"}"))
                .isEqualTo("Standort angelegt: Werk Lindach");
        assertThat(satz("gebaeude", "angelegt", null, "{\"name\":\"Halle 2\"}"))
                .isEqualTo("Gebäude angelegt: Halle 2");
        assertThat(satz("bereich", "verschoben", null, "{\"kennzeichen\":\"G-2\"}"))
                .isEqualTo("Bereich verschoben: G-2");
        // IP-12: mit den Namen der Elternknoten — alt → neu, das Kurzzeichen des Ziels.
        assertThat(satz("gebaeude", "verschoben", "{\"eltern_name\":\"Werk Ahrenberg\",\"eltern_kurzzeichen\":\"ST-1\"}",
                "{\"eltern_name\":\"Werk Ahrenberg Nord\",\"eltern_kurzzeichen\":\"ST-3\"}"))
                .isEqualTo("Gebäude verschoben: Werk Ahrenberg → Werk Ahrenberg Nord (ST-3)");
        assertThat(satz("bereich", "verschoben", null, "{\"eltern_name\":\"Halle 1\"}"))
                .isEqualTo("Bereich verschoben: Halle 1");
        assertThat(satz("bereich", "korrigiert", null, "{\"kennzeichen\":\"G-2\"}"))
                .isEqualTo("Zuordnung berichtigt: G-2");
        // Die Zuordnung einer Anlage (IP-9/IP-11) erzählt jede Seite — Anlage, neuer, bisheriger Standort.
        assertThat(satz("anlage", "verschoben", null, "{\"anlage_name\":\"Werk Ahrenberg – Halle 2\","
                + "\"standort_name\":\"Werk Ahrenberg Nord\",\"standort_kurzzeichen\":\"ST-3\"}"))
                .isEqualTo("Standort zugeordnet: Werk Ahrenberg Nord (ST-3)");
        assertThat(satz("standort", "verschoben", null,
                "{\"anlage_name\":\"Werk Ahrenberg – Halle 2\",\"richtung\":\"hinzu\"}"))
                .isEqualTo("Anlage zugeordnet: Werk Ahrenberg – Halle 2");
        assertThat(satz("standort", "verschoben", null, "{\"anlage_name\":\"Werk Ahrenberg – Halle 2\","
                + "\"richtung\":\"hinaus\",\"nach_standort_name\":\"Werk Ahrenberg Nord\"}"))
                .isEqualTo("Anlage zieht um: Werk Ahrenberg – Halle 2 → Werk Ahrenberg Nord");
        assertThat(satz("bereich", "flaeche_geaendert", "{\"flaeche_m2\":1200}", "{\"flaeche_m2\":1400}"))
                .isEqualTo("Bezugsfläche geändert: 1.200 m² → 1.400 m²");
        assertThat(satz("standort", "archiviert", null, null)).isEqualTo("Standort archiviert");
        assertThat(satz("standort", "wiederhergestellt", null, null)).isEqualTo("Standort wiederhergestellt");
        assertThat(satz("anlage", "geloescht", null, null)).isEqualTo("Anlage gelöscht");
        assertThat(satz("unternehmen", "bearbeitet", "{\"kurzname\":\"KWA\"}", "{\"kurzname\":\"Ahrenberg\"}"))
                .isEqualTo("Unternehmen bearbeitet: Kurzname „KWA“ → „Ahrenberg“");
    }

    // ---- Die Datenquellen-Einträge (data_source_aenderung) ------------------------------------

    @Test
    void dieDatenquelleNenntIhrPruefergebnisAlsFakt() {
        assertThat(AenderungSatz.satz("datenquelle", "erreichbarkeit_geprueft", null, null, "ok"))
                .isEqualTo("Erreichbarkeit geprüft: ok");
        assertThat(AenderungSatz.satz("datenquelle", "erreichbarkeit_geprueft", null, null, "unreachable"))
                .isEqualTo("Erreichbarkeit geprüft: unreachable");
        // Ohne Ergebnis wird KEINS erfunden.
        assertThat(AenderungSatz.satz("datenquelle", "erreichbarkeit_geprueft", null, null, null))
                .isEqualTo("Erreichbarkeit geprüft");
        assertThat(satz("datenquelle", "angelegt", null, "{\"name\":\"WAGO Halle 2\"}"))
                .isEqualTo("Datenquelle angelegt: WAGO Halle 2");
        assertThat(satz("datenquelle", "zustaendigkeit_begonnen", null, null))
                .isEqualTo("Zuständigkeit begonnen");
        assertThat(satz("datenquelle", "zustaendigkeit_gewechselt", null, null))
                .isEqualTo("Zuständigkeit gewechselt");
        assertThat(satz("datenquelle", "aus_bestand_uebernommen", null, null))
                .isEqualTo("Datenquelle aus dem Bestand übernommen");
    }

    /** AP-10 IP-3: eine eingetragene Formel-Fassung nennt ihre Nummer. */
    @Test
    void eineNeueFormelFassungNenntIhreNummer() throws Exception {
        assertThat(satz("messstelle", "formel_geaendert", null,
                "{\"fassung\": 2, \"formel_typ\": \"gewichtete_summe\", \"gueltig_ab\": \"2026-10-18\"}"))
                .isEqualTo("Formel geändert: Fassung 2");
        assertThat(satz("messstelle", "formel_geaendert", null, null)).isEqualTo("Formel geändert");
    }

    /** AP-10 IP-7: die Prozess-Zuordnung nennt die Prozesse ab dem Tag. */
    @Test
    void eineProzessZuordnungNenntDieProzesse() throws Exception {
        assertThat(satz("messstelle", "prozesse_zugeordnet", "{\"gueltig_ab\": \"2026-10-01\", \"prozesse\": []}",
                "{\"gueltig_ab\": \"2026-10-01\", \"prozesse\": [\"P-1\", \"P-3\"]}"))
                .isEqualTo("Prozesse zugeordnet: P-1, P-3");
        assertThat(satz("messstelle", "prozesse_zugeordnet", null, "{\"gueltig_ab\": \"2027-01-01\", \"prozesse\": []}"))
                .isEqualTo("Prozesse zugeordnet: keine");
    }

    /** AP-10 IP-8: die Verteilung nennt die Anteile ab dem Tag — ohne Zeile „nicht verteilt“, nie 0 %. */
    @Test
    void eineVerteilungNenntDieAnteile() throws Exception {
        assertThat(satz("messstelle", "verteilung_geaendert", null, "{\"gueltig_ab\": \"2027-01-15\", "
                + "\"zeilen\": [{\"kostenstelle\": \"4100\", \"anteil_prozent\": \"60\"}, "
                + "{\"kostenstelle\": \"4200\", \"anteil_prozent\": \"40\"}], \"korrektur\": false}"))
                .isEqualTo("Verteilung auf Kostenstellen geändert: 60\u00a0% 4100, 40\u00a0% 4200");
        assertThat(satz("messstelle", "verteilung_geaendert", null,
                "{\"gueltig_ab\": \"2027-01-15\", \"zeilen\": [{\"kostenstelle\": \"4100\", "
                        + "\"anteil_prozent\": \"33.5\"}, {\"kostenstelle\": \"4200\", \"anteil_prozent\": \"66.5\"}], "
                        + "\"korrektur\": true}"))
                .isEqualTo("Verteilung auf Kostenstellen berichtigt: 33,5\u00a0% 4100, 66,5\u00a0% 4200");
        assertThat(satz("messstelle", "verteilung_geaendert", null,
                "{\"gueltig_ab\": \"2027-02-01\", \"zeilen\": [], \"korrektur\": false}"))
                .isEqualTo("Verteilung auf Kostenstellen geändert: nicht verteilt");
    }

    // ---- Vollständigkeit ----------------------------------------------------------------------

    /**
     * JEDE Art der drei CHECK-Vokabulare hat einen Satz — ein neuer Schreibweg, der den CHECK
     * weitet, fällt hier auf, statt still als Code durchzurutschen.
     */
    @Test
    void jedeArtDerDreiVokabulareHatEinenSatz() {
        List<String> messstelle = List.of("angelegt", "bearbeitet", "angehalten", "fortgesetzt",
                "archiviert", "nebengroesse_hinzugefuegt", "nebengroesse_archiviert", "ort_zugeordnet",
                "ort_korrigiert", "stellung_zugeordnet", "stellung_korrigiert", "quelle_gebunden",
                "quelle_beendet", "einstellung_geaendert", "zaehler_gewechselt");
        List<String> ort = List.of("angelegt", "bearbeitet", "verschoben", "korrigiert",
                "flaeche_geaendert", "archiviert", "wiederhergestellt", "geloescht",
                "zugriff_zugewiesen", "zugriff_entzogen");
        List<String> quelle = List.of("angelegt", "bearbeitet", "erreichbarkeit_geprueft",
                "zustaendigkeit_begonnen", "zustaendigkeit_gewechselt", "aus_bestand_uebernommen");
        for (String art : messstelle) {
            assertThat(satz("messstelle", art, null, null)).as(art).isNotEqualTo(art);
        }
        for (String art : ort) {
            assertThat(satz("standort", art, null, null)).as(art).isNotEqualTo(art);
        }
        for (String art : quelle) {
            assertThat(satz("datenquelle", art, null, null)).as(art).isNotEqualTo(art);
        }
        // Umgekehrt: eine unbekannte Art verschwindet NICHT, sie steht als ihr Code da.
        assertThat(satz("messstelle", "was_ganz_neues", null, null)).isEqualTo("was_ganz_neues");
    }

    /** Die drei Vokabulare oben sind die der Migrationen — nicht eine gepflegte Kopie daneben. */
    @Test
    void dieVokabulareStehenSoInDenMigrationen() throws Exception {
        assertThat(arten("V20260912120000__uems_zaehlerwechsel.sql", "messstelle_aenderung_art_chk"))
                .containsExactlyInAnyOrder("angelegt", "bearbeitet", "angehalten", "fortgesetzt",
                        "archiviert", "nebengroesse_hinzugefuegt", "nebengroesse_archiviert",
                        "ort_zugeordnet", "ort_korrigiert", "stellung_zugeordnet", "stellung_korrigiert",
                        "quelle_gebunden", "quelle_beendet", "einstellung_geaendert", "zaehler_gewechselt");
        // Seit AP-03 IP-9 weitet V20260916150000 diesen CHECK — der LETZTE Stand zählt, nicht der erste.
        assertThat(arten("V20260916150000__uems_zugriff_entzug_protokoll.sql", "ort_aenderung_art_chk"))
                .containsExactlyInAnyOrder("angelegt", "bearbeitet", "verschoben", "korrigiert",
                        "flaeche_geaendert", "archiviert", "wiederhergestellt", "geloescht",
                        "zugriff_zugewiesen", "zugriff_entzogen");
        assertThat(arten("V20260911270000__uems_datenquelle_bestand.sql", "data_source_aenderung_art_chk"))
                .containsExactlyInAnyOrder("angelegt", "bearbeitet", "erreichbarkeit_geprueft",
                        "zustaendigkeit_begonnen", "zustaendigkeit_gewechselt", "aus_bestand_uebernommen");
    }

    /** Die Wörter des LETZTEN {@code art IN (…)} jenes CHECKs in jener Migration. */
    private static Set<String> arten(String migration, String constraint) throws Exception {
        String sql = java.nio.file.Files.readString(java.nio.file.Path.of("src", "main", "resources",
                "db", "migration", migration));
        int chk = sql.lastIndexOf(constraint);
        assertThat(chk).as(constraint + " in " + migration).isGreaterThan(-1);
        int auf = sql.indexOf("art IN (", chk) + "art IN (".length();
        int zu = sql.indexOf("))", auf);
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("'([a-z_]+)'")
                .matcher(sql.substring(auf, zu));
        Set<String> out = new java.util.LinkedHashSet<>();
        while (m.find()) {
            out.add(m.group(1));
        }
        return out;
    }
}
