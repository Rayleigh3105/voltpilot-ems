package com.voltpilot.api.ueberwachung;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * Lesen und Schreiben der Überwachung (Alerting Scheibe 1): {@code ueberwachung},
 * {@code ueberwachung_instanz}, {@code alarm}, {@code alarm_verlauf}, {@code alarm_kennzeichen_lauf}
 * (Migration V20261015130000). Läuft immer unter {@link TenantContext} über die Laufzeitrolle
 * (RLS) - nie über die BYPASSRLS-Admin-Rolle (§6.6: der Läufer selbst hat keinen Zugriffs-Kontext,
 * sieht aber ohne {@code app.zugriff}/{@code app.standort_ids} automatisch das ganze Unternehmen).
 */
@Repository
public class UeberwachungRepository {

    private static final ObjectMapper JSON = new ObjectMapper();

    public record UeberwachungZeile(UUID id, UUID standortId, int fassung, String name, String wertart,
            JsonNode bezug, JsonNode bedingung, String schwere, JsonNode empfaenger, String herkunft,
            String angelegtVon, Instant probelaufBis, JsonNode ruhezeit) {

        /** Im Probelauf (§6.4, §6.8 Entwurf 1): ausgewertet, aber ohne Versand - noch nicht scharf. */
        public boolean imProbelauf(Instant jetzt) {
            return probelaufBis != null && jetzt.isBefore(probelaufBis);
        }
    }

    public record InstanzZeile(String zustand, Instant seit, JsonNode letzterWert, Instant letzteMesszeit,
            UUID offenerAlarm, Instant ausgewertetAm) {
        static final InstanzZeile NEU = new InstanzZeile("normal", null, null, null, null, null);
    }

    public record AlarmZeile(UUID id, String kennzeichen, UUID ueberwachungId, UUID standortId,
            String bezugKennung, String wertart, String schwere, Instant ausgeloestAm, String zustand,
            Instant wiederNormalAm, String gesehenVon, Instant gesehenAm, Instant erledigtAm, boolean probelauf,
            int erinnerungenGesendet, Instant letzteErinnerungAm, UUID unterdrueckDurch) {}

    /**
     * Eine Zeile des Verlaufs-CSV (Entscheid 14A, §6.4 Nr. 8): dieselben Spalten wie das Meldungs-Center,
     * dazu Name und Herkunft der Regel (die Marke "eigene Überwachung") - ein JOIN auf {@code ueberwachung},
     * damit die CSV nie eine zweite Wahrheit über eine Regel führt.
     */
    public record VerlaufZeile(String kennzeichen, String wertart, String regelName, String herkunft,
            String bezugKennung, UUID standortId, String schwere, String zustand, Instant ausgeloestAm,
            Instant wiederNormalAm, String gesehenVon, Instant gesehenAm, Instant erledigtAm) {}

    private final JdbcTemplate jdbc;

    public UeberwachungRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // --------------------------------------------------------------- Aussaat (§7 Scheibe 1, Nr. 7)

    /** Alle Anlagen mit mindestens einer angenommenen Box - die Grundlage von "box.erreichbar". */
    public List<UUID> anlagenMitAngenommenerBox() {
        return jdbc.queryForList(
                "SELECT DISTINCT site_id FROM device WHERE status = 'claimed' AND site_id IS NOT NULL",
                UUID.class);
    }

    /** Alle Anlagen mit mindestens einer gemeldeten Datenquelle - Grundlage von "datenquelle.liefert_daten". */
    public List<UUID> anlagenMitDatenquelle() {
        return jdbc.queryForList("SELECT DISTINCT site_id FROM device_data_source_status", UUID.class);
    }

    /**
     * Alle Anlagen mit mindestens einer Ladesäule - Grundlage der zwei Ladepunkt-Meldungen ab Werk
     * ("Ein Ort fürs Laden" Scheibe 4, E6 = A).
     */
    public List<UUID> anlagenMitLadepunkt() {
        return jdbc.queryForList("SELECT DISTINCT site_id FROM ocpp_station", UUID.class);
    }

    /**
     * Sät die Zeile ab Werk (Entscheid 2A), idempotent (Teil-Index {@code uq_ueberwachung_ab_werk}).
     * Empfänger: Kundenadministrator und Energiemanager als Rollen, erst beim Versand aufgelöst
     * (§6.4 "Mehrere Empfänger") - so bekommt eine neue Kollegin die Meldungen ohne Regeländerung.
     */
    public void seedAbWerk(UUID anlageId, UUID standortId, WerteKatalog.Eintrag eintrag) {
        WerteKatalog.Vorschlag v = eintrag.vorschlag();
        String bedingung = """
                {"art":"zustand","ziel":%s,"dauer_s":%d,"erholen_s":%d}
                """.formatted(toJsonArray(v.ziel()), v.dauerS(), v.erholenS());
        String bezug = "{\"anlage\":\"" + anlageId + "\"}";
        String empfaenger = "[{\"rolle\":\"kundenadministrator\"},{\"rolle\":\"energiemanager\"}]";
        jdbc.update("""
                INSERT INTO ueberwachung (tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                       empfaenger, herkunft, aktiv, angelegt_von)
                VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?::jsonb, 'ab_werk', true, 'system')
                ON CONFLICT DO NOTHING
                """,
                TenantContext.get(), standortId, eintrag.name(), eintrag.wertart(), bezug, bedingung,
                v.schwere(), empfaenger);
    }

    /** Privatkunde (Entscheid 15C, §6.10): der Kundenbereich hat die Betriebsart {@code endkunde}. */
    public boolean istEndkunde() {
        List<String> rows = jdbc.query("SELECT betriebsart FROM tenant WHERE id = ?",
                (rs, n) -> rs.getString(1), TenantContext.get());
        return !rows.isEmpty() && "endkunde".equals(rows.get(0));
    }

    /** Alle Anlagen des Kundenbereichs (RLS-Mandantenzaun) - Grundlage der Preis-Hinweis-Aussaat (15C). */
    public List<UUID> alleAnlagen() {
        return jdbc.queryForList("SELECT id FROM site", UUID.class);
    }

    // --------------------------------------------------------------------- Auswahl (§6.4 "Gilt für", Scheibe 4)

    /**
     * Die Anlagen EINES Standorts HEUTE (Alerting Scheibe 4, §6.4 "alle Anlagen des Standorts X") -
     * wird bei JEDEM Lauf neu gelesen, damit eine neu zugeordnete Anlage sofort mitüberwacht ist
     * ("neu hinzukommende Bezüge sind sofort mit überwacht").
     */
    public List<UUID> anlagenDesStandorts(UUID standortId) {
        return jdbc.query("""
                SELECT a.site_id FROM anlage_standort a
                 WHERE a.tenant_id = ? AND a.standort_id = ? AND a.aufgehoben_am IS NULL
                   AND daterange(a.gueltig_ab, a.gueltig_bis, '[]') @> uems_zugriff_heute(a.tenant_id)
                """, (rs, n) -> rs.getObject(1, UUID.class), TenantContext.get(), standortId);
    }

    /** Wie {@link #anlagenMitAngenommenerBox()}, aber auf einen Standort eingeschränkt ("alle Boxen des Standorts"). */
    public List<UUID> anlagenDesStandortsMitBox(UUID standortId) {
        return jdbc.query("""
                SELECT DISTINCT d.site_id FROM device d
                 JOIN anlage_standort a ON a.site_id = d.site_id AND a.tenant_id = ?
                WHERE d.status = 'claimed' AND d.site_id IS NOT NULL AND a.standort_id = ?
                  AND a.aufgehoben_am IS NULL
                  AND daterange(a.gueltig_ab, a.gueltig_bis, '[]') @> uems_zugriff_heute(a.tenant_id)
                """, (rs, n) -> rs.getObject(1, UUID.class), TenantContext.get(), standortId);
    }

    /** Die Gebotszone einer Anlage, oder {@code null} ohne eine (ältere Anlage ohne Preisreihe). */
    public String biddingZone(UUID anlageId) {
        List<String> rows = jdbc.query("SELECT bidding_zone FROM site WHERE id = ?",
                (rs, n) -> rs.getString(1), anlageId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Sät den Preis-Hinweis ab Werk EINGESCHALTET (Entscheid 15C, Abweichung von Empfehlung A,
     * §6.10 Punkt 4): die Schwelle kommt aus den eigenen Daten der Anlage (§6.1 Nr. 9 "Vorgaben,
     * die meistens passen"), nicht aus dem generischen {@code vorschlag}-Block des Katalogs (der
     * kennt nur Ziel-Zustände, keine Zahl) - deshalb ein eigener Säe-Weg statt {@link #seedAbWerk}.
     */
    public void seedAbWerkPreis(UUID anlageId, UUID standortId, WerteKatalog.Eintrag eintrag, double schwelle,
            double rueckkehr) {
        String bedingung = """
                {"art":"unter","schwelle":%s,"rueckkehr":%s,"dauer_s":300,"erholen_s":300}
                """.formatted(schwelle, rueckkehr);
        String bezug = "{\"anlage\":\"" + anlageId + "\"}";
        String empfaenger = "[{\"rolle\":\"kundenadministrator\"}]";
        jdbc.update("""
                INSERT INTO ueberwachung (tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                       empfaenger, herkunft, aktiv, angelegt_von)
                VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, 'hinweis', ?::jsonb, 'ab_werk', true, 'system')
                ON CONFLICT DO NOTHING
                """,
                TenantContext.get(), standortId, eintrag.name(), eintrag.wertart(), bezug, bedingung, empfaenger);
    }

    /** Alle Anlagen mit einem hinterlegten Leistungspreis (Alerting Scheibe 4, §6.10 Punkt 3) -
     * Grundlage der Aussaat "Lastspitze droht" (Entscheid 2A, nur Dringend-Vorschlag ab Werk). */
    public List<UUID> anlagenMitLeistungspreis() {
        return jdbc.queryForList("SELECT id FROM site WHERE leistungspreis_eur_kw IS NOT NULL", UUID.class);
    }

    /**
     * Sät "Lastspitze droht" ab Werk EINGESCHALTET (Entscheid 2A, Dringend - der einzige
     * Dringend-Vorschlag ab Werk, §6.10 Punkt 3): wie {@link #seedAbWerkPreis} ein eigener Säe-Weg,
     * weil die Schwelle aus der laufenden Abrechnungsperiode der Anlage kommt, nicht aus dem
     * generischen {@code vorschlag}-Block des Katalogs.
     */
    public void seedAbWerkLastspitze(UUID anlageId, UUID standortId, WerteKatalog.Eintrag eintrag, double schwelle,
            double rueckkehr) {
        String bedingung = """
                {"art":"ueber","schwelle":%s,"rueckkehr":%s,"dauer_s":60,"erholen_s":300}
                """.formatted(schwelle, rueckkehr);
        String bezug = "{\"anlage\":\"" + anlageId + "\"}";
        String empfaenger = "[{\"rolle\":\"kundenadministrator\"},{\"rolle\":\"energiemanager\"}]";
        jdbc.update("""
                INSERT INTO ueberwachung (tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                       empfaenger, herkunft, aktiv, angelegt_von)
                VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb, 'dringend', ?::jsonb, 'ab_werk', true, 'system')
                ON CONFLICT DO NOTHING
                """,
                TenantContext.get(), standortId, eintrag.name(), eintrag.wertart(), bezug, bedingung, empfaenger);
    }

    /**
     * Legt eine selbst angelegte Überwachung an (Alerting Scheibe 2, §6.8 "Vom Wert zur fertigen
     * Regel: drei Taps"): {@code herkunft} ist {@code 'eigen'} (additiv seit {@code V20261015140000})
     * oder, seit Scheibe 6 ({@code V20261017050000}, Entscheid 10A), {@code 'steuerung'} ("In
     * Überwachung umwandeln" einer alten {@code vp.notify.push}-Regelkarte) - die Rechte-Prüfung
     * (ueberwachung.eigene/verwalten) UND die Zulässigkeit des Herkunfts-Worts stehen in
     * {@link UeberwachungAnlegenService}, nicht hier.
     */
    public UUID erstelleSelbstAngelegt(UUID standortId, String name, String wertart, String bezugJson,
            String bedingungJson, String schwere, String empfaengerJson, String herkunft, String angelegtVon,
            Instant probelaufBis) {
        UUID id = UUID.randomUUID();
        jdbc.update("""
                INSERT INTO ueberwachung (id, tenant_id, standort_id, name, wertart, bezug, bedingung, schwere,
                       empfaenger, herkunft, aktiv, angelegt_von, probelauf_bis)
                VALUES (?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?::jsonb, ?, true, ?, ?)
                """,
                id, TenantContext.get(), standortId, name, wertart, bezugJson, bedingungJson, schwere,
                empfaengerJson, herkunft, angelegtVon, ts(probelaufBis));
        return id;
    }

    /** "Jetzt scharf schalten" (§6.8 Entwurf 1, per Tipper statt nach 30 Tagen): beendet den Probelauf sofort. */
    public boolean scharfSchalten(UUID id) {
        return jdbc.update("UPDATE ueberwachung SET probelauf_bis = NULL, geaendert_am = now() "
                + "WHERE id = ? AND probelauf_bis IS NOT NULL", id) > 0;
    }

    /**
     * Eine einzelne Regel - für die Rechte-Prüfung beim "scharf schalten"/Löschen (angelegt_von,
     * Empfänger). {@code geloescht_am IS NULL}: eine gelöschte Regel ist für jede Aktion an ihrer
     * Kennung (scharf schalten, Stummschalten, externe Empfänger) ebenso verschwunden wie aus der
     * "Überwachungen"-Liste - ihr Verlauf bleibt trotzdem über {@code alarm}/{@code alarm_verlauf}
     * erreichbar (Entscheid 3B).
     */
    public Optional<UeberwachungZeile> einzelneRegel(UUID id) {
        return jdbc.query("""
                SELECT id, standort_id, fassung, name, wertart, bezug::text AS bezug_json,
                       bedingung::text AS bedingung_json, schwere, empfaenger::text AS empfaenger_json,
                       herkunft, angelegt_von, probelauf_bis, ruhezeit::text AS ruhezeit_json
                  FROM ueberwachung WHERE id = ? AND geloescht_am IS NULL
                """, UeberwachungRepository::zeile, id).stream().findFirst();
    }

    /**
     * Löscht eine Regel (Soft-Delete, Abnahme-Befund, Entscheid 3B: Verlauf bleibt erhalten) -
     * {@code false}, wenn sie schon gelöscht ist oder nicht existiert (idempotent für den Dienst).
     * Physisch geht nicht: jeder jemals ausgelöste Alarm verweist per Fremdschlüssel auf diese Zeile.
     */
    public boolean loeschen(UUID id, String von, Instant jetzt) {
        return jdbc.update("""
                UPDATE ueberwachung SET geloescht_am = ?, geloescht_von = ?, geaendert_am = ?
                 WHERE id = ? AND geloescht_am IS NULL
                """, ts(jetzt), von, ts(jetzt), id) > 0;
    }

    private static String toJsonArray(List<String> werte) {
        if (werte == null || werte.isEmpty()) {
            return "[]";
        }
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < werte.size(); i++) {
            if (i > 0) {
                b.append(',');
            }
            b.append('"').append(werte.get(i)).append('"');
        }
        return b.append(']').toString();
    }

    // --------------------------------------------------------------------- Regeln lesen

    /** Alle aktiven Regeln des Kundenbereichs, älteste zuerst - ohne eine gelöschte (Entscheid 3B). */
    public List<UeberwachungZeile> aktive() {
        return jdbc.query("""
                SELECT id, standort_id, fassung, name, wertart, bezug::text AS bezug_json,
                       bedingung::text AS bedingung_json, schwere, empfaenger::text AS empfaenger_json,
                       herkunft, angelegt_von, probelauf_bis, ruhezeit::text AS ruhezeit_json
                  FROM ueberwachung WHERE aktiv = true AND geloescht_am IS NULL ORDER BY angelegt_am
                """, UeberwachungRepository::zeile);
    }

    /**
     * Der Verlauf je Periode für den CSV-Export (Entscheid 14A): jeder Alarm, der in {@code [von, bis)}
     * ausgelöst wurde, älteste zuerst - unabhängig vom heutigen Zustand (auch ein noch aktiver Alarm
     * aus der Periode gehört zu ihrem Verlauf).
     */
    public List<VerlaufZeile> verlaufJePeriode(Instant von, Instant bis) {
        return jdbc.query("""
                SELECT a.kennzeichen, a.wertart, u.name AS regel_name, u.herkunft, a.bezug_kennung,
                       a.standort_id, a.schwere, a.zustand, a.ausgeloest_am, a.wieder_normal_am,
                       a.gesehen_von, a.gesehen_am, a.erledigt_am
                  FROM alarm a JOIN ueberwachung u ON u.id = a.ueberwachung_id
                 WHERE a.ausgeloest_am >= ? AND a.ausgeloest_am < ?
                 ORDER BY a.ausgeloest_am
                """, UeberwachungRepository::verlaufZeile, ts(von), ts(bis));
    }

    private static VerlaufZeile verlaufZeile(ResultSet rs, int n) throws SQLException {
        return new VerlaufZeile(rs.getString("kennzeichen"), rs.getString("wertart"), rs.getString("regel_name"),
                rs.getString("herkunft"), rs.getString("bezug_kennung"), rs.getObject("standort_id", UUID.class),
                rs.getString("schwere"), rs.getString("zustand"), instant(rs.getTimestamp("ausgeloest_am")),
                instant(rs.getTimestamp("wieder_normal_am")), rs.getString("gesehen_von"),
                instant(rs.getTimestamp("gesehen_am")), instant(rs.getTimestamp("erledigt_am")));
    }

    private static UeberwachungZeile zeile(ResultSet rs, int n) throws SQLException {
        return new UeberwachungZeile(rs.getObject("id", UUID.class), rs.getObject("standort_id", UUID.class),
                rs.getInt("fassung"), rs.getString("name"), rs.getString("wertart"),
                json(rs.getString("bezug_json")), json(rs.getString("bedingung_json")), rs.getString("schwere"),
                json(rs.getString("empfaenger_json")), rs.getString("herkunft"), rs.getString("angelegt_von"),
                instant(rs.getTimestamp("probelauf_bis")), json(rs.getString("ruhezeit_json")));
    }

    private static JsonNode json(String text) {
        try {
            return text == null ? null : JSON.readTree(text);
        } catch (java.io.IOException e) {
            throw new IllegalStateException("Überwachung: ungültiges JSON '" + text + "'", e);
        }
    }

    /** Das Kurzzeichen eines Standorts (für {@code RechteAbleitung.Ziel.standort(kennzeichen)}, §6.6). */
    public String standortKurzzeichen(UUID standortId) {
        List<String> rows = jdbc.query("SELECT kurzzeichen FROM standort WHERE id = ? AND tenant_id = ?",
                (rs, n) -> rs.getString(1), standortId, TenantContext.get());
        return rows.isEmpty() ? null : rows.get(0);
    }

    /** Die Zeitzone eines Standorts (Alerting Scheibe 3, §6.4: "in der Zeitzone des Standorts"). */
    public String standortZeitzone(UUID standortId) {
        if (standortId == null) {
            return null;
        }
        List<String> rows = jdbc.query("SELECT zeitzone FROM standort WHERE id = ? AND tenant_id = ?",
                (rs, n) -> rs.getString(1), standortId, TenantContext.get());
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Die Anlage, auf die ein Alarm-Bezug zeigt - parst {@code "anlage:<id>"} direkt, löst
     * {@code "komponente:<id>;kanal=..."} über die Komponente auf (Alerting Scheibe 3, §6.4:
     * Stummschaltung einer ganzen Anlage muss auch komponentenbezogene Alarme treffen).
     */
    public UUID anlageDesAlarmBezugs(String bezugKennung) {
        String[] teile = bezugKennung.split(":", 2);
        if (teile.length != 2) {
            return null;
        }
        String id = teile[1].split(";", 2)[0];
        UUID uuid;
        try {
            uuid = UUID.fromString(id);
        } catch (IllegalArgumentException e) {
            return null;
        }
        return "komponente".equals(teile[0]) ? anlageDerKomponente(uuid) : uuid;
    }

    /** Der Anzeigename der Anlage - für die Texte nach außen (§6.8). */
    public String anlageName(UUID anlageId) {
        List<String> rows = jdbc.query("SELECT name FROM site WHERE id = ?",
                (rs, n) -> rs.getString(1), anlageId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    /**
     * Die Anlage einer Komponente (Alerting Scheibe 2, Familie {@code geraet.messwert}, §6.3 Nr. 1):
     * eine Komponente IST ein Messpunkt ({@code measurement_point.id} - dieselbe Kennung, die
     * {@code telemetry_v2.entity_id} als Text trägt). {@code null}, wenn sie nicht (mehr) existiert
     * oder nicht sichtbar ist.
     */
    public UUID anlageDerKomponente(UUID komponenteId) {
        List<UUID> rows = jdbc.query("SELECT site_id FROM measurement_point WHERE id = ?",
                (rs, n) -> rs.getObject(1, UUID.class), komponenteId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    // --------------------------------------------------------------------- Standort einer Anlage

    /**
     * Der Standort, an dem die Anlage HEUTE hängt (Zeitzone des Kundenbereichs, wie
     * {@code uems_zugriff_anlage_sichtbar}) - {@code null}, wenn sie keinem gültig zugeordnet ist.
     */
    public UUID standortHeute(UUID anlageId) {
        List<UUID> rows = jdbc.query("""
                SELECT a.standort_id FROM anlage_standort a
                 WHERE a.tenant_id = ? AND a.site_id = ? AND a.aufgehoben_am IS NULL
                   AND daterange(a.gueltig_ab, a.gueltig_bis, '[]') @> uems_zugriff_heute(a.tenant_id)
                 ORDER BY a.gueltig_ab DESC LIMIT 1
                """, (rs, n) -> rs.getObject(1, UUID.class), TenantContext.get(), anlageId);
        return rows.isEmpty() ? null : rows.get(0);
    }

    // --------------------------------------------------------------------- Instanz (§6.5)

    public InstanzZeile instanz(UUID ueberwachungId, String bezugKennung) {
        List<InstanzZeile> rows = jdbc.query("""
                SELECT zustand, seit, letzter_wert::text AS letzter_wert_json, letzte_messzeit, offener_alarm,
                       ausgewertet_am
                  FROM ueberwachung_instanz WHERE ueberwachung_id = ? AND bezug_kennung = ?
                """, (rs, n) -> new InstanzZeile(rs.getString("zustand"), instant(rs.getTimestamp("seit")),
                        json(rs.getString("letzter_wert_json")), instant(rs.getTimestamp("letzte_messzeit")),
                        rs.getObject("offener_alarm", UUID.class), instant(rs.getTimestamp("ausgewertet_am"))),
                ueberwachungId, bezugKennung);
        return rows.isEmpty() ? InstanzZeile.NEU : rows.get(0);
    }

    public void instanzSpeichern(UUID ueberwachungId, String bezugKennung, String zustand, Instant seit,
            String letzterWertJson, Instant letzteMesszeit, UUID offenerAlarm, Instant jetzt) {
        jdbc.update("""
                INSERT INTO ueberwachung_instanz (tenant_id, ueberwachung_id, bezug_kennung, zustand, seit,
                       letzter_wert, letzte_messzeit, ausgewertet_am, offener_alarm)
                VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
                ON CONFLICT (tenant_id, ueberwachung_id, bezug_kennung) DO UPDATE SET
                       zustand = EXCLUDED.zustand, seit = EXCLUDED.seit, letzter_wert = EXCLUDED.letzter_wert,
                       letzte_messzeit = EXCLUDED.letzte_messzeit, ausgewertet_am = EXCLUDED.ausgewertet_am,
                       offener_alarm = EXCLUDED.offener_alarm
                """, TenantContext.get(), ueberwachungId, bezugKennung, zustand, ts(seit), letzterWertJson,
                ts(letzteMesszeit), ts(jetzt), offenerAlarm);
    }

    // --------------------------------------------------------------------- Kennzeichen (§9)

    /** AL-JJJJ-nnnnnn, nie wiederverwendet - der Zähler je Kundenbereich und Jahr, atomar erhöht. */
    public String naechstesKennzeichen(Instant jetzt) {
        int jahr = jetzt.atZone(ZoneOffset.UTC).getYear();
        Integer nr = jdbc.queryForObject("""
                INSERT INTO alarm_kennzeichen_lauf (tenant_id, jahr, naechste_nr) VALUES (?, ?, 2)
                ON CONFLICT (tenant_id, jahr) DO UPDATE SET naechste_nr = alarm_kennzeichen_lauf.naechste_nr + 1
                RETURNING naechste_nr - 1
                """, Integer.class, TenantContext.get(), jahr);
        return "AL-%d-%06d".formatted(jahr, nr);
    }

    // --------------------------------------------------------------------- Alarm (§6.5, §9)

    public UUID alarmErzeugen(UeberwachungZeile regel, String bezugKennung, UUID standortId, Instant jetzt,
            String wertJson, boolean probelauf) {
        return alarmErzeugen(regel, bezugKennung, standortId, jetzt, wertJson, probelauf, null);
    }

    /**
     * Wie oben, aber mit {@code unterdrueckDurch} (Alerting Scheibe 4, §6.4 Nr. 7 "Abhängige
     * Meldungen schweigen"): der Alarm EINER Box-/Datenquelle-Meldung derselben Anlage, unter der
     * dieser Alarm im Center steht - ausgewertet und nachweisbar (§6.5), aber ohne eigenen Versand
     * (siehe {@link UeberwachungsService#ausloesen}).
     */
    public UUID alarmErzeugen(UeberwachungZeile regel, String bezugKennung, UUID standortId, Instant jetzt,
            String wertJson, boolean probelauf, UUID unterdrueckDurch) {
        UUID id = UUID.randomUUID();
        String kennzeichen = naechstesKennzeichen(jetzt);
        jdbc.update("""
                INSERT INTO alarm (id, tenant_id, standort_id, kennzeichen, ueberwachung_id, fassung,
                       bezug_kennung, wertart, schwere, ausgeloest_am, wert_beim_ausloesen, zustand, probelauf,
                       unterdrueckt_durch)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, 'aktiv', ?, ?)
                """, id, TenantContext.get(), standortId, kennzeichen, regel.id(), regel.fassung(),
                bezugKennung, regel.wertart(), regel.schwere(), ts(jetzt), wertJson, probelauf, unterdrueckDurch);
        return id;
    }

    /**
     * Ein aktiver (nicht erledigter) Alarm einer der gegebenen Wertarten AUF DERSELBEN ANLAGE - für
     * die Unterdrückung abhängiger Meldungen (§6.4 Nr. 7): "meldet sich eine Box nicht, gehen
     * 'keine Daten' ihrer Geräte und Werte nicht einzeln hinaus". Nur Anlagen-Bezüge (die
     * gatenden Wertarten {@code box.erreichbar}/{@code datenquelle.liefert_daten} haben immer
     * {@code bezug = anlage}, §6.3).
     */
    public Optional<UUID> aktiverAlarmAufAnlage(UUID anlageId, List<String> wertarten) {
        List<UUID> rows = jdbc.query("""
                SELECT id FROM alarm WHERE bezug_kennung = ? AND wertart = ANY (?) AND zustand <> 'erledigt'
                 ORDER BY ausgeloest_am LIMIT 1
                """, (rs, n) -> rs.getObject(1, UUID.class), "anlage:" + anlageId, wertarten.toArray(String[]::new));
        return rows.isEmpty() ? Optional.empty() : Optional.of(rows.get(0));
    }

    public void alarmVerlauf(UUID alarmId, String art, String wer, String text, String wertJson) {
        jdbc.update("""
                INSERT INTO alarm_verlauf (tenant_id, alarm_id, art, wer, wert, text)
                VALUES (?, ?, ?, ?, ?::jsonb, ?)
                """, TenantContext.get(), alarmId, art, wer, wertJson, text);
    }

    /** Jeder noch offene (nicht erledigte) Alarm EINER Regel - zum Schließen beim Löschen der Regel. */
    public List<AlarmZeile> offeneAlarmeDerRegel(UUID ueberwachungId) {
        return jdbc.query("SELECT " + ALARM_SPALTEN + " FROM alarm WHERE ueberwachung_id = ? AND zustand <> 'erledigt'",
                UeberwachungRepository::alarmZeile, ueberwachungId);
    }

    /**
     * Schließt einen Alarm, weil seine Regel gelöscht wurde (Abnahme-Befund, Entscheid 3B: der
     * Alarm selbst und sein Verlauf bleiben - nur sein Zustand wechselt, wie {@link #alarmWiederNormal}).
     * Anders als dort kein {@code wieder_normal_am}: der Wert ist nicht zurückgekehrt, die Regel
     * wurde entfernt.
     */
    public void alarmSchliessenRegelGeloescht(UUID alarmId, Instant jetzt) {
        jdbc.update("""
                UPDATE alarm SET zustand = 'erledigt', erledigt_am = ?, erledigt_durch = 'regel_geloescht'
                 WHERE id = ?
                """, ts(jetzt), alarmId);
    }

    public void alarmWiederNormal(UUID alarmId, Instant jetzt, boolean erledigen) {
        if (erledigen) {
            jdbc.update("""
                    UPDATE alarm SET wieder_normal_am = ?, zustand = 'erledigt', erledigt_am = ?,
                           erledigt_durch = 'wert' WHERE id = ?
                    """, ts(jetzt), ts(jetzt), alarmId);
        } else {
            jdbc.update("UPDATE alarm SET wieder_normal_am = ? WHERE id = ?", ts(jetzt), alarmId);
        }
    }

    /** "Gesehen" (3B: freiwillig, speist nur den Verlauf - keine Quittierungspflicht). */
    public boolean gesehen(UUID alarmId, String wer, Instant jetzt) {
        return jdbc.update("""
                UPDATE alarm SET gesehen_von = ?, gesehen_am = ? WHERE id = ? AND gesehen_von IS NULL
                """, wer, ts(jetzt), alarmId) > 0;
    }

    private static final String ALARM_SPALTEN = "id, kennzeichen, ueberwachung_id, standort_id, bezug_kennung, "
            + "wertart, schwere, ausgeloest_am, zustand, wieder_normal_am, gesehen_von, gesehen_am, erledigt_am, "
            + "probelauf, erinnerungen_gesendet, letzte_erinnerung_am, unterdrueckt_durch";

    public Optional<AlarmZeile> alarm(UUID id) {
        return jdbc.query("SELECT " + ALARM_SPALTEN + " FROM alarm WHERE id = ?",
                UeberwachungRepository::alarmZeile, id).stream().findFirst();
    }

    /** Jetzt = nicht erledigt; Verlauf = erledigt - höchstens {@code limit}, jüngste zuerst. */
    public List<AlarmZeile> liste(boolean erledigt, int limit) {
        return jdbc.query("SELECT " + ALARM_SPALTEN + " FROM alarm WHERE (zustand = 'erledigt') = ? "
                + "ORDER BY ausgeloest_am DESC LIMIT ?", UeberwachungRepository::alarmZeile, erledigt, limit);
    }

    public long ungeseheneZahl() {
        Long n = jdbc.queryForObject(
                "SELECT count(*) FROM alarm WHERE zustand <> 'erledigt' AND gesehen_von IS NULL", Long.class);
        return n == null ? 0 : n;
    }

    /** Für die Farbe der Glocke (§6.8: "Mit einer dringenden Meldung trägt die Zahl die Farbe für Dringend"). */
    public boolean hatUngeseheneDringende() {
        Boolean b = jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM alarm "
                + "WHERE zustand <> 'erledigt' AND gesehen_von IS NULL AND schwere = 'dringend')", Boolean.class);
        return Boolean.TRUE.equals(b);
    }

    /**
     * Dringende, nicht gesehene Alarme mit noch offenen Erinnerungen (Alerting Scheibe 3, §6.5):
     * nach 1 Stunde, danach alle 4 Stunden, höchstens dreimal; endet bei "Gesehen" ODER "Erledigt"
     * (Entscheid 3B - {@code zustand = 'aktiv'} schließt beides aus).
     */
    public List<AlarmZeile> dringendOhneGesehenFuerErinnerung() {
        return jdbc.query("SELECT " + ALARM_SPALTEN + " FROM alarm WHERE zustand = 'aktiv' "
                + "AND schwere = 'dringend' AND gesehen_von IS NULL AND erinnerungen_gesendet < 3",
                UeberwachungRepository::alarmZeile);
    }

    public void erinnerungVermerken(UUID alarmId, Instant jetzt) {
        jdbc.update("UPDATE alarm SET erinnerungen_gesendet = erinnerungen_gesendet + 1, letzte_erinnerung_am = ? "
                + "WHERE id = ?", ts(jetzt), alarmId);
    }

    /**
     * Für die Tages-Zusammenfassung (§6.4 Nr. 6): aktive Meldungen jeder Stufe PLUS Hinweise, die
     * heute ausgelöst wurden (ein Hinweis erledigt sich meist sofort selbst und wäre sonst nie
     * zu sehen) - "mit aktiven Meldungen und Hinweisen des Tages".
     */
    public List<AlarmZeile> fuerZusammenfassung(Instant tagBeginn) {
        return jdbc.query("SELECT " + ALARM_SPALTEN + " FROM alarm "
                + "WHERE zustand <> 'erledigt' OR (schwere = 'hinweis' AND ausgeloest_am >= ?) "
                + "ORDER BY ausgeloest_am DESC", UeberwachungRepository::alarmZeile, ts(tagBeginn));
    }

    private static AlarmZeile alarmZeile(ResultSet rs, int n) throws SQLException {
        return new AlarmZeile(rs.getObject("id", UUID.class), rs.getString("kennzeichen"),
                rs.getObject("ueberwachung_id", UUID.class), rs.getObject("standort_id", UUID.class),
                rs.getString("bezug_kennung"), rs.getString("wertart"), rs.getString("schwere"),
                instant(rs.getTimestamp("ausgeloest_am")), rs.getString("zustand"),
                instant(rs.getTimestamp("wieder_normal_am")), rs.getString("gesehen_von"),
                instant(rs.getTimestamp("gesehen_am")), instant(rs.getTimestamp("erledigt_am")),
                rs.getBoolean("probelauf"), rs.getInt("erinnerungen_gesendet"),
                instant(rs.getTimestamp("letzte_erinnerung_am")), rs.getObject("unterdrueckt_durch", UUID.class));
    }

    private static Timestamp ts(Instant i) {
        return i == null ? null : Timestamp.from(i);
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }
}
