package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.kundenbereich.BeendeteKundenbereiche;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.uems.EreignisVokabular.Urteil;
import com.voltpilot.api.uems.KorrekturVorschlagRegeln.Bestehend;
import com.voltpilot.api.uems.KorrekturVorschlagRegeln.Periode;
import com.voltpilot.api.uems.KorrekturVorschlagRegeln.Sperre;
import com.voltpilot.api.uems.KorrekturVorschlagRegeln.Stand;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.UnaryOperator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.stereotype.Component;

/**
 * Das System SCHLÄGT VOR (UEMS AP-08 IP-14, Entscheid E14 = A vom 11.09.2026): aus einer Nachlieferung nach der
 * Frist, aus nachgetragenen Ableseständen nach der Frist und aus einer angefragten Umklassifizierung wird eine
 * Korrektur im Status {@code vorschlag} ({@code messreihe_korrektur}, IP-12) — mit vorbelegter Begründung,
 * Vorschau alt/neu je Viertelstunde und dem Marker {@code correction} im Verlauf.
 *
 * <p><b>Nie automatisch — auch nicht, wenn nur Lücken gefüllt werden.</b> Dieser Lauf schreibt keine Zeile der
 * Viertelstunden-, Versions-, Tages- oder Periodenklasse und kennt keinen Weg zu einer Freigabe: Version 2
 * entsteht erst, wenn ein Mensch freigibt (IP-15/IP-17). Die Datenbank hält das auch gegen diesen Code fest —
 * die Rolle, mit der er schreibt, darf in {@code messreihe_korrektur} nur Fassung 1 anlegen (Trigger
 * {@code messreihe_korrektur_system_nur_vorschlag}, V20260913224500).
 *
 * <p><b>Er rechnet nichts.</b> „Neu“ ist, was {@link ViertelstundeVerdichter#waereZeile} mit derselben
 * Rechenregel heute schriebe; „alt“ ist die neueste gespeicherte Version. Die Sätze spricht
 * {@link KorrekturVorschlagRegeln}.
 *
 * <p><b>Die Brücke zu AP-07 IP-13.</b> {@code messreihe_korrektur_vorschlag} bleibt die ERKENNUNG (eine Zeile je
 * Reihe und Viertelstunde, geschrieben vom {@link SpaetankunftMelder}), die Korrektur ist der VORGANG: offene
 * Zeilen aufeinanderfolgender Viertelstunden werden EINE Korrektur der Art
 * {@code nachlieferung_nach_endgueltigkeit} und gehen in derselben Transaktion auf {@code erledigt}. Vorher
 * zählt der Melder sie noch einmal (eine zweite Welle steht dann mit in der Zeile), und eine Gruppe wartet, bis
 * {@link #RUHE} nach ihrem letzten Eingang vergangen ist und die Verdichtung die Reihe abgearbeitet hat — sonst
 * fände eine spätere Welle nur noch eine erledigte Zeile. Ändert die Nachlieferung keinen Wert, geht die Zeile
 * auf {@code verworfen}: ein Vorschlag ohne Änderung wäre eine erfundene Tatsache.
 *
 * <p><b>Die Doppelvorschlag-Sperre</b> hängt am fachlichen Schlüssel Kundenbereich + Art + Reihe + Zeitraum
 * ({@link KorrekturVorschlagRegeln#sperre}), geprüft unter einer Sperre je Reihe — nie an einem Zeitstempel. Der
 * Stundenlauf darf darum jede Stunde über dieselbe Nachlieferung oder denselben Ablesestand laufen: es bleibt
 * EIN Vorschlag, und über einen entschiedenen fragt er nicht noch einmal.
 *
 * <p>Wiederholbar und abbruchsicher: jede Reihe bzw. jeder Ablesestand in EINER Transaktion (Korrektur, Marker
 * und erledigte Zeilen zusammen); ein Fehler an einer Reihe wird protokolliert und hält die anderen nicht auf.
 * Nicht hier: Freigabe und Vier-Augen (IP-15), Route und Portal (IP-16), Kaskade (IP-17), Rechte (AP-03).
 */
@Component
public class KorrekturVorschlagLauf {

    private static final Logger log = LoggerFactory.getLogger(KorrekturVorschlagLauf.class);
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * So lange nach dem letzten Eingang wartet eine Nachlieferung oder ein Ablesestand, bevor der Vorschlag
     * entsteht: eine Box leert ihren Puffer in mehreren Umschlägen, und der Verdichtungs-Lauf fährt alle fünf
     * Minuten. Drei Takte reichen, damit eine Welle EINE Korrektur wird.
     */
    static final Duration RUHE = Duration.ofMinutes(15);

    /** So weit zurück sucht er Ablesestände — weiter reichen die Rohwerte nicht, aus denen „neu“ entsteht. */
    static final Duration RUECKBLICK = Duration.ofDays(90);

    /** VoltPilot selbst, ohne Person — der Ersteller eines System-Vorschlags (Fassung 1). */
    static final ProtokollAkteur SYSTEM = new ProtokollAkteur(null, "VoltPilot",
            RechteAbleitung.Rolle.VOLTPILOT_BETRIEB.code(), ProtokollAkteur.ART_VOLTPILOT);

    static final String ERLEDIGT = "erledigt";
    static final String VERWORFEN = "verworfen";

    private final JdbcTemplate adminJdbc;
    private final ViertelstundeVerdichter verdichter;
    private final SpaetankunftMelder melder;
    private final int jeLauf;

    /** Beendete Kundenbereiche lässt der Läufer aus (AP-20, E10 = A); ohne Spring gilt KEINE. */
    private BeendeteKundenbereiche beendete = BeendeteKundenbereiche.KEINE;

    @Autowired(required = false)
    void setBeendeteKundenbereiche(BeendeteKundenbereiche beendete) {
        this.beendete = beendete;
    }

    public KorrekturVorschlagLauf(
            @Qualifier("adminJdbcTemplate") JdbcTemplate adminJdbc,
            ViertelstundeVerdichter verdichter,
            SpaetankunftMelder melder,
            @Value("${voltpilot.uems.korrektur-vorschlag.je-lauf:200}") int jeLauf) {
        this.adminJdbc = adminJdbc;
        this.verdichter = verdichter;
        this.melder = melder;
        this.jeLauf = jeLauf;
    }

    /** Was ein Lauf tat: neue Vorschläge, geschlossene Zeilen der Erkennung, Sperren und wartende Gruppen. */
    public record Lauf(int vorschlaege, int erledigt, int verworfen, int gesperrt, int wartet) {}

    /** Was eine Anfrage ergab: die Kennung des Vorschlags — oder die benannte Ablehnung (samt sperrender Kennung). */
    public record Ergebnis(String kennung, String ablehnung, String sperrt) {

        static Ergebnis abgelehnt(String grund) {
            return new Ergebnis(null, grund, null);
        }
    }

    record Reihe(UUID tenant, UUID entity, String kanal) {}

    private record Erkennung(int anzahl, Instant letzterEingang, Instant frist) {}

    private record Ablesung(Reihe reihe, UUID ereignisId, Instant zeit, Instant eingang, List<Instant> beginne,
            Instant frist) {}

    private static final class Zaehler {
        int vorschlaege;
        int erledigt;
        int verworfen;
        int gesperrt;
        int wartet;
    }

    /** Ein Takt (im Stundenlauf nach der Endgültigkeit): erst die Nachlieferungen, dann die Ablesestände. */
    public Lauf lauf(Instant jetzt) {
        Zaehler z = new Zaehler();
        for (Reihe r : offeneReihen()) {
            try {
                inTransaktion(con -> {
                    nachlieferung(con, r, jetzt, z);
                    return null;
                });
            } catch (RuntimeException e) {
                log.warn("UEMS Korrektur-Vorschlag: Nachlieferung {} {} übersprungen: {}", r.entity(), r.kanal(),
                        e.toString());
            }
        }
        for (Ablesung a : ablesungen(jetzt)) {
            try {
                inTransaktion(con -> {
                    ablesestaende(con, a, jetzt, z);
                    return null;
                });
            } catch (RuntimeException e) {
                log.warn("UEMS Korrektur-Vorschlag: Ablesestand {} übersprungen: {}", a.ereignisId(), e.toString());
            }
        }
        if (z.vorschlaege + z.erledigt + z.verworfen > 0) {
            log.info("UEMS Korrektur-Vorschlag: {} Vorschläge, {} Zeilen erledigt, {} verworfen, {} gesperrt, "
                    + "{} warten — freigegeben wird von Hand", z.vorschlaege, z.erledigt, z.verworfen, z.gesperrt,
                    z.wartet);
        }
        return new Lauf(z.vorschlaege, z.erledigt, z.verworfen, z.gesperrt, z.wartet);
    }

    /**
     * Die angefragte UMKLASSIFIZIERUNG eines fallenden Stands (E4: „Umklassifizierung = Korrektur“): der Bearbeiter
     * sagt, der Sprung zum Zeitpunkt {@code zeitpunkt} sei ein Überlauf mit Wertebereich {@code modul} — oder eine
     * Rücksetzung. Das System rechnet die Viertelstunden mit dieser Deutung durch dieselbe Regel (Z5/Z6), legt den
     * Vorschlag mit {@code akteur} als Ersteller an und ändert nichts. Die Bestätigung ersetzt die
     * Plausibilitätsschranke des Höchstzuwachses, nicht den Wertebereich.
     *
     * @param tenant der Kundenbereich des Aufrufers (TenantContext), nie aus einem Anfragekörper
     */
    public Ergebnis umklassifizierung(UUID tenant, UUID entity, String kanal, Instant zeitpunkt, String richtung,
            BigDecimal modul, ProtokollAkteur akteur, Instant jetzt) {
        UnaryOperator<ZaehlerDeklaration> umdeuten;
        if (KorrekturVorschlagRegeln.ALS_UEBERLAUF.equals(richtung)) {
            if (modul == null || modul.signum() <= 0) {
                return Ergebnis.abgelehnt(KorrekturVorschlagRegeln.WERTEBEREICH_FEHLT);
            }
            umdeuten = d -> new ZaehlerDeklaration(modul, modul, 1, d.neustartVerlustS());
        } else if (KorrekturVorschlagRegeln.ALS_RUECKSETZUNG.equals(richtung)) {
            umdeuten = d -> new ZaehlerDeklaration(null, null, null, d.neustartVerlustS());
        } else {
            return Ergebnis.abgelehnt(KorrekturVorschlagRegeln.RICHTUNG_UNBEKANNT);
        }
        Reihe r = new Reihe(tenant, entity, kanal);
        List<Instant> beginne = KorrekturVorschlagRegeln.viertelstundenUm(zeitpunkt);
        Instant von = beginne.get(0);
        Instant bis = ViertelstundeRegeln.ende(beginne.get(beginne.size() - 1));
        return inTransaktion(con -> {
            sperreReihe(con, r, true);
            if (!reiheHatWerte(con, r, von, bis)) {
                return Ergebnis.abgelehnt(KorrekturVorschlagRegeln.REIHE_UNBEKANNT);
            }
            List<Periode> perioden = perioden(con, r, beginne, jetzt, umdeuten);
            if (!KorrekturVorschlagRegeln.aendertEtwas(perioden)) {
                return Ergebnis.abgelehnt(KorrekturVorschlagRegeln.OHNE_AENDERUNG);
            }
            ArrayNode vorschau = KorrekturVorschlagRegeln.vorschau(perioden);
            Sperre s = KorrekturVorschlagRegeln.sperre(bestehende(con, r, KorrekturVorschlagRegeln.UMKLASSIFIZIERUNG),
                    von, bis, vorschau);
            if (s != null) {
                return new Ergebnis(null, s.grund(), s.kennung());
            }
            ZoneId zone = zone(con, r, von);
            String kennung = anlegen(con, r, KorrekturVorschlagRegeln.UMKLASSIFIZIERUNG, von, bis,
                    KorrekturVorschlagRegeln.umklassifizierung(richtung, zeitpunkt, modul, zone), vorschau, akteur,
                    zone, jetzt);
            return new Ergebnis(kennung, null, null);
        });
    }

    // ----------------------------------------------------------------- Quelle 1: Nachlieferung (Brücke)

    private List<Reihe> offeneReihen() {
        return adminJdbc.query("""
                SELECT tenant_id, entity_id, messkanal FROM messreihe_korrektur_vorschlag
                 WHERE zustand = 'offen' AND NOT (tenant_id = ANY (?::uuid[]))
                 GROUP BY tenant_id, entity_id, messkanal
                 ORDER BY min(endgueltig_ab)
                 LIMIT ?
                """, (rs, n) -> new Reihe(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3)),
                beendete.sqlFeld(), jeLauf); // Kundenbereich beendet: bleibt liegen
    }

    private void nachlieferung(Connection con, Reihe r, Instant jetzt, Zaehler z) throws SQLException {
        if (!sperreReihe(con, r, false)) {
            return;
        }
        // Die offenen Zeilen unter Zeilensperre — und noch einmal gezählt: kam seit dem Melder eine zweite Welle,
        // steht sie jetzt in der Zeile, bevor die Zeile auf erledigt geht.
        for (Instant b : offeneZeilen(con, r)) {
            melder.melden(con, r.tenant(), r.entity(), r.kanal(), b);
        }
        Map<Instant, Erkennung> zeilen = erkennungen(con, r);
        for (List<Instant> gruppe : KorrekturVorschlagRegeln.zusammenhaengend(new ArrayList<>(zeilen.keySet()))) {
            if (gruppe.stream().anyMatch(b -> zeilen.get(b).letzterEingang().isAfter(jetzt.minus(RUHE)))
                    || arbeitOffen(con, r, gruppe.get(0).minus(ViertelstundeRegeln.LAENGE),
                            ViertelstundeRegeln.ende(gruppe.get(gruppe.size() - 1)).plus(ViertelstundeRegeln.LAENGE))) {
                z.wartet++;
                continue;
            }
            // Der Nachbar davor und danach gehört dazu, wenn er sich ändert: ein nachgelieferter Wert genau auf der
            // Grenze ist der Endstand der Viertelstunde davor (Z1), ohne dass sie selbst einen Nachzügler hat.
            List<Periode> perioden = perioden(con, r, gruppe, jetzt, null);
            for (Instant nachbar : List.of(gruppe.get(0).minus(ViertelstundeRegeln.LAENGE),
                    ViertelstundeRegeln.ende(gruppe.get(gruppe.size() - 1)))) {
                Periode p = perioden(con, r, List.of(nachbar), jetzt, null).get(0);
                if (p.aendert()) {
                    perioden.add(p);
                }
            }
            perioden.sort(Comparator.comparing(Periode::von));
            Instant von = perioden.get(0).von();
            Instant bis = ViertelstundeRegeln.ende(perioden.get(perioden.size() - 1).von());
            if (!KorrekturVorschlagRegeln.aendertEtwas(perioden)) {
                z.verworfen += schliessen(con, r, von, bis, VERWORFEN, KorrekturVorschlagRegeln.NOTIZ_VERWORFEN,
                        jetzt);
                continue;
            }
            ArrayNode vorschau = KorrekturVorschlagRegeln.vorschau(perioden);
            Sperre s = KorrekturVorschlagRegeln.sperre(bestehende(con, r, KorrekturVorschlagRegeln.NACHLIEFERUNG),
                    von, bis, vorschau);
            if (s != null) {
                z.gesperrt++;
                if (KorrekturVorschlagRegeln.SCHON_ENTSCHIEDEN.equals(s.grund())) {
                    z.erledigt += schliessen(con, r, von, bis, ERLEDIGT,
                            KorrekturVorschlagRegeln.notizErledigt(s.kennung()), jetzt);
                }
                continue;
            }
            ZoneId zone = zone(con, r, von);
            int anzahl = gruppe.stream().mapToInt(b -> zeilen.get(b).anzahl()).sum();
            Instant eingang = gruppe.stream().map(b -> zeilen.get(b).letzterEingang()).max(Instant::compareTo)
                    .orElseThrow();
            Instant frist = gruppe.stream().map(b -> zeilen.get(b).frist()).min(Instant::compareTo).orElseThrow();
            String kennung = anlegen(con, r, KorrekturVorschlagRegeln.NACHLIEFERUNG, von, bis,
                    KorrekturVorschlagRegeln.nachlieferung(von, bis, anzahl, eingang, frist, zone), vorschau, SYSTEM,
                    zone, jetzt);
            z.vorschlaege++;
            z.erledigt += schliessen(con, r, von, bis, ERLEDIGT, KorrekturVorschlagRegeln.notizErledigt(kennung),
                    jetzt);
        }
    }

    /**
     * Hat der Verdichtungs-Lauf in diesem Zeitraum (samt Nachbarn) noch Arbeit für die Reihe? Dann ist die
     * Nachlieferung womöglich nicht ganz gezählt. Nur der Zeitraum: die laufende Viertelstunde einer Reihe, die
     * weiter liefert, hält keinen Vorschlag auf.
     */
    private static boolean arbeitOffen(Connection con, Reihe r, Instant von, Instant bis) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT EXISTS (SELECT 1 FROM messreihe_viertelstunde_arbeit "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?)")) {
            reiheImZeitraum(ps, r, von, bis);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    private static List<Instant> offeneZeilen(Connection con, Reihe r) throws SQLException {
        List<Instant> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT intervall_beginn FROM messreihe_korrektur_vorschlag "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND zustand = 'offen' "
                + "ORDER BY intervall_beginn FOR UPDATE")) {
            reihe(ps, r);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(rs.getTimestamp(1).toInstant());
                }
            }
        }
        return aus;
    }

    private static Map<Instant, Erkennung> erkennungen(Connection con, Reihe r) throws SQLException {
        Map<Instant, Erkennung> aus = new TreeMap<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT intervall_beginn, anzahl, letzte_eingangszeit, "
                + "endgueltig_ab FROM messreihe_korrektur_vorschlag WHERE tenant_id = ? AND entity_id = ? "
                + "AND messkanal = ? AND zustand = 'offen'")) {
            reihe(ps, r);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.put(rs.getTimestamp(1).toInstant(), new Erkennung(rs.getInt(2),
                            rs.getTimestamp(3).toInstant(), rs.getTimestamp(4).toInstant()));
                }
            }
        }
        return aus;
    }

    /** Die offenen Zeilen im Zeitraum schließen — die EINE Spalte, die AP-08 an der Erkennung schreibt. */
    private static int schliessen(Connection con, Reihe r, Instant von, Instant bis, String zustand, String notiz,
            Instant jetzt) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("UPDATE messreihe_korrektur_vorschlag SET zustand = ?, "
                + "erledigt_am = ?, erledigt_notiz = ?, geaendert_am = now() WHERE tenant_id = ? AND entity_id = ? "
                + "AND messkanal = ? AND zustand = 'offen' AND intervall_beginn >= ? AND intervall_beginn < ?")) {
            ps.setString(1, zustand);
            ps.setTimestamp(2, Timestamp.from(jetzt));
            ps.setString(3, notiz);
            ps.setObject(4, r.tenant());
            ps.setObject(5, r.entity());
            ps.setString(6, r.kanal());
            ps.setTimestamp(7, Timestamp.from(von));
            ps.setTimestamp(8, Timestamp.from(bis));
            return ps.executeUpdate();
        }
    }

    // ------------------------------------------------------------ Quelle 2: Ablesestände nach der Frist

    /**
     * Gerätegrenzen MIT Ableseständen, die eingingen, als ihre Viertelstunde schon endgültig war — der
     * Verdichtungs-Lauf rührt eine endgültige Zeile nicht an ({@code BruchEreignisse}), der Nachtrag wirkt nur
     * über eine Korrektur (F12). Dieselbe Auswahl der Viertelstunden wie dort.
     */
    private List<Ablesung> ablesungen(Instant jetzt) {
        record Treffer(Reihe reihe, UUID ereignisId, Instant zeit, Instant eingang, Instant beginn, Instant frist) {}
        List<Treffer> treffer = adminJdbc.query("""
                SELECT e.tenant_id, v.entity_id, v.messkanal, e.ereignis_id, e.zeit, e.eingang,
                       v.intervall_beginn, v.endgueltig_ab
                  FROM messreihe_ereignis e
                  JOIN messreihe_viertelstunde v
                    ON v.tenant_id = e.tenant_id AND v.entity_id = e.entity_id
                   AND (e.messkanal IS NULL OR v.messkanal = e.messkanal)
                   AND v.intervall_beginn IN (to_timestamp(floor(extract(epoch FROM e.zeit) / 900) * 900),
                                              to_timestamp(ceil(extract(epoch FROM e.zeit) / 900) * 900 - 900))
                 WHERE e.art = 'device_boundary' AND NOT e.aus_bestand
                   AND (e.nutzlast->>'endstand' IS NOT NULL OR e.nutzlast->>'anfangsstand' IS NOT NULL)
                   AND e.eingang > ? AND e.eingang <= ? AND e.zeit >= ?
                   AND v.zustand = 'endgueltig' AND e.eingang > v.endgueltig_ab
                 ORDER BY e.eingang, e.tenant_id, v.entity_id, v.messkanal, v.intervall_beginn
                """, (rs, n) -> new Treffer(new Reihe(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
                        rs.getString(3)), rs.getObject(4, UUID.class), rs.getTimestamp(5).toInstant(),
                        rs.getTimestamp(6).toInstant(), rs.getTimestamp(7).toInstant(), rs.getTimestamp(8).toInstant()),
                Timestamp.from(jetzt.minus(RUECKBLICK)), Timestamp.from(jetzt.minus(RUHE)),
                Timestamp.from(jetzt.minus(RUECKBLICK)));
        // Je Reihe und Meldung EIN Vorschlag über ihre (höchstens zwei) Viertelstunden; eine Fortschreibung derselben
        // Meldung zählt mit ihrer jüngsten Zeit und ihrem jüngsten Eingang.
        Map<String, List<Treffer>> jeMeldung = new LinkedHashMap<>();
        for (Treffer t : treffer) {
            jeMeldung.computeIfAbsent(t.reihe() + "|" + t.ereignisId(), k -> new ArrayList<>()).add(t);
        }
        return jeMeldung.values().stream().limit(jeLauf).map(ts -> new Ablesung(ts.get(0).reihe(),
                ts.get(0).ereignisId(),
                ts.stream().map(Treffer::zeit).max(Instant::compareTo).orElseThrow(),
                ts.stream().map(Treffer::eingang).max(Instant::compareTo).orElseThrow(),
                ts.stream().map(Treffer::beginn).distinct().sorted().toList(),
                ts.stream().map(Treffer::frist).min(Instant::compareTo).orElseThrow())).toList();
    }

    private void ablesestaende(Connection con, Ablesung a, Instant jetzt, Zaehler z) throws SQLException {
        Reihe r = a.reihe();
        if (!sperreReihe(con, r, false)) {
            return;
        }
        Instant von = a.beginne().get(0);
        Instant bis = ViertelstundeRegeln.ende(a.beginne().get(a.beginne().size() - 1));
        List<Periode> perioden = perioden(con, r, a.beginne(), jetzt, null);
        if (!KorrekturVorschlagRegeln.aendertEtwas(perioden)) {
            return;
        }
        ArrayNode vorschau = KorrekturVorschlagRegeln.vorschau(perioden);
        if (KorrekturVorschlagRegeln.sperre(bestehende(con, r, KorrekturVorschlagRegeln.ABLESESTAENDE), von, bis,
                vorschau) != null) {
            z.gesperrt++;
            return;
        }
        ZoneId zone = zone(con, r, von);
        anlegen(con, r, KorrekturVorschlagRegeln.ABLESESTAENDE, von, bis,
                KorrekturVorschlagRegeln.ablesestaende(a.zeit(), a.eingang(), a.frist(), zone), vorschau, SYSTEM, zone,
                jetzt);
        z.vorschlaege++;
    }

    // -------------------------------------------------------------------------------- Die Vorschau

    /** Alt und neu je Viertelstunde — neu aus dem Verdichtungs-Lauf, gerechnet, nie geschrieben. */
    private List<Periode> perioden(Connection con, Reihe r, List<Instant> beginne, Instant jetzt,
            UnaryOperator<ZaehlerDeklaration> umdeuten) throws SQLException {
        Map<Instant, Stand> alt = altStaende(con, r, beginne.get(0),
                ViertelstundeRegeln.ende(beginne.get(beginne.size() - 1)));
        List<Periode> aus = new ArrayList<>();
        for (Instant b : beginne) {
            Map<String, Object> z = verdichter.waereZeile(con, r.tenant(), r.entity(), r.kanal(), b, jetzt, umdeuten);
            Stand neu = z == null ? Stand.keineWerte()
                    : new Stand(null, (BigDecimal) z.get("menge"), zustand((String) z.get("menge_zustand")),
                            saetze((String) z.get("kennzeichen")), (Integer) z.get("erhalten"),
                            (Integer) z.get("erwartet"), (Integer) z.get("abdeckung_prozent"),
                            (BigDecimal) z.get("mittel"), (BigDecimal) z.get("energie"));
            aus.add(new Periode(b, alt.getOrDefault(b, Stand.keineWerte()), neu));
        }
        return aus;
    }

    /**
     * Die neueste gespeicherte Version je Viertelstunde: Version 1 aus der Verdichtung, darüber Menge, Zustand und
     * Kennzeichen einer späteren Version (IP-13). Eine Viertelstunde ohne beides fehlt in der Antwort.
     */
    private static Map<Instant, Stand> altStaende(Connection con, Reihe r, Instant von, Instant bis)
            throws SQLException {
        Map<Instant, Stand> aus = new TreeMap<>();
        try (PreparedStatement ps = con.prepareStatement("SELECT intervall_beginn, version, menge, menge_zustand, "
                + "kennzeichen::text, erhalten, erwartet, abdeckung_prozent, mittel, energie FROM messreihe_viertelstunde "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?")) {
            reiheImZeitraum(ps, r, von, bis);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.put(rs.getTimestamp(1).toInstant(), new Stand(rs.getInt(2), rs.getBigDecimal(3),
                            zustand(rs.getString(4)), saetze(rs.getString(5)), (Integer) rs.getObject(6),
                            (Integer) rs.getObject(7), (Integer) rs.getObject(8), rs.getBigDecimal(9),
                            rs.getBigDecimal(10)));
                }
            }
        }
        try (PreparedStatement ps = con.prepareStatement("SELECT DISTINCT ON (intervall_beginn) intervall_beginn, "
                + "version, menge, menge_zustand, kennzeichen::text FROM messreihe_viertelstunde_version "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ? ORDER BY intervall_beginn, version DESC")) {
            reiheImZeitraum(ps, r, von, bis);
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    Instant b = rs.getTimestamp(1).toInstant();
                    Stand eins = aus.getOrDefault(b, Stand.keineWerte());
                    aus.put(b, new Stand(rs.getInt(2), rs.getBigDecimal(3), rs.getString(4), saetze(rs.getString(5)),
                            eins.erhalten(), eins.erwartet(), eins.abdeckungProzent(), eins.mittel(), eins.energie()));
                }
            }
        }
        return aus;
    }

    /** Eine Reihe ohne Regel (Zustand, Text) trägt keinen Mengen-Zustand — dann sagt die Vorschau „keine Werte“. */
    private static String zustand(String gespeichert) {
        return gespeichert == null ? ErgebnisZustand.KEINE_WERTE : gespeichert;
    }

    private static List<String> saetze(String json) throws SQLException {
        if (json == null) {
            return List.of();
        }
        try {
            List<String> aus = new ArrayList<>();
            JSON.readTree(json).forEach(n -> aus.add(n.asText()));
            return aus;
        } catch (JsonProcessingException e) {
            throw new SQLException("Kennzeichen nicht lesbar: " + json, e);
        }
    }

    private static boolean reiheHatWerte(Connection con, Reihe r, Instant von, Instant bis) throws SQLException {
        try (PreparedStatement ps = con.prepareStatement("SELECT EXISTS (SELECT 1 FROM messreihe_viertelstunde "
                + "WHERE tenant_id = ? AND entity_id = ? AND messkanal = ? AND intervall_beginn >= ? "
                + "AND intervall_beginn < ?)")) {
            reiheImZeitraum(ps, r, von, bis);
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    // -------------------------------------------------------------------------- Sperre und Anlage

    /**
     * Die Sperre je Reihe bis zum Ende der Transaktion — unter ihr sind „gibt es schon einen?“ und „anlegen“ EIN
     * Zug. {@code warten}: eine Anfrage wartet, der Lauf überspringt eine gehaltene Reihe bis zum nächsten Takt.
     */
    static boolean sperreReihe(Connection con, Reihe r, boolean warten) throws SQLException {
        String sql = warten ? "SELECT true FROM pg_advisory_xact_lock(hashtextextended(?, 0))"
                : "SELECT pg_try_advisory_xact_lock(hashtextextended(?, 0))";
        try (PreparedStatement ps = con.prepareStatement(sql)) {
            ps.setString(1, "uems-korrektur-vorschlag:" + r.tenant() + ":" + r.entity() + ":" + r.kanal());
            try (ResultSet rs = ps.executeQuery()) {
                rs.next();
                return rs.getBoolean(1);
            }
        }
    }

    /** Die Vorschläge derselben Art an genau dieser Reihe dieses Kundenbereichs, mit ihrem Status heute. */
    static List<Bestehend> bestehende(Connection con, Reihe r, String art) throws SQLException {
        List<Bestehend> aus = new ArrayList<>();
        try (PreparedStatement ps = con.prepareStatement("""
                SELECT k.kennung, k.von, k.bis, k.vorschau::text, s.status
                  FROM messreihe_korrektur k
                  JOIN LATERAL (SELECT f.status FROM messreihe_korrektur f
                                 WHERE f.tenant_id = k.tenant_id AND f.kennung = k.kennung
                                 ORDER BY f.fassung DESC LIMIT 1) s ON true
                 WHERE k.tenant_id = ? AND k.fassung = 1 AND k.art = ?
                   AND k.reihen @> ?::jsonb AND jsonb_array_length(k.reihen) = 1
                 ORDER BY k.created_at, k.kennung
                """)) {
            ps.setObject(1, r.tenant());
            ps.setString(2, art);
            ps.setString(3, reihen(r).toString());
            try (ResultSet rs = ps.executeQuery()) {
                while (rs.next()) {
                    aus.add(new Bestehend(rs.getString(1), rs.getTimestamp(2).toInstant(),
                            rs.getTimestamp(3).toInstant(), rs.getString(5), json(rs.getString(4))));
                }
            }
        }
        return aus;
    }

    /**
     * Legt den Vorschlag an (Fassung 1, Kennung im Jahr der Erfassung in der Zone des Standorts) und hängt den
     * Marker {@code correction} mit Status {@code vorschlag} an — dieselbe Transaktion.
     */
    static String anlegen(Connection con, Reihe r, String art, Instant von, Instant bis, String begruendung,
            ArrayNode vorschau, ProtokollAkteur akteur, ZoneId zone, Instant jetzt) throws SQLException {
        String kennung = MessreiheFassungen.naechsteKennung(new JdbcTemplate(new SingleConnectionDataSource(con, true)),
                MessreiheKorrekturRepository.TABELLE, "K", r.tenant(), zone);
        try (PreparedStatement ps = con.prepareStatement("INSERT INTO messreihe_korrektur (tenant_id, kennung, fassung, "
                + "status, art, reihen, von, bis, begruendung, vorschau, actor_sub, actor_name, actor_rolle, actor_art) "
                + "VALUES (?, ?, 1, ?, ?, ?::jsonb, ?, ?, ?, ?::jsonb, ?, ?, ?, ?)")) {
            ps.setObject(1, r.tenant());
            ps.setString(2, kennung);
            ps.setString(3, EreignisVokabular.KORREKTUR_STATUS.get(0));
            ps.setString(4, art);
            ps.setString(5, reihen(r).toString());
            ps.setTimestamp(6, Timestamp.from(von));
            ps.setTimestamp(7, Timestamp.from(bis));
            ps.setString(8, begruendung);
            ps.setString(9, vorschau.toString());
            ps.setString(10, akteur.sub());
            ps.setString(11, akteur.name());
            ps.setString(12, akteur.rolle());
            ps.setString(13, akteur.art());
            ps.executeUpdate();
        }
        marker(con, r, kennung, art, von, bis, jetzt);
        return kennung;
    }

    /**
     * Der Verlauf-Marker: {@code correction}, Urheber {@code cloud}, Status {@code vorschlag} — die Cloud meldet nie
     * mehr.
     */
    private static void marker(Connection con, Reihe r, String kennung, String art, Instant von, Instant bis,
            Instant jetzt) throws SQLException {
        String status = EreignisVokabular.KORREKTUR_STATUS.get(0);
        UUID id = UUID.nameUUIDFromBytes(("correction:" + r.tenant() + ":" + kennung + ":" + status)
                .getBytes(StandardCharsets.UTF_8));
        ObjectNode e = JSON.createObjectNode();
        e.put("ereignis_id", id.toString());
        e.put("art", "correction");
        e.put("von", uhr(von));
        e.put("bis", uhr(bis));
        e.put("komponente", r.entity().toString());
        e.put("messkanal", r.kanal());
        e.put("korrektur", kennung);
        e.put("korrektur_art", art);
        e.put("status", status);
        Urteil urteil = EreignisVokabular.pruefe(e, Urheber.CLOUD);
        if (!urteil.angenommen()) {
            // Ein Urteil gegen die EIGENE Meldung ist ein Fehler im Code: laut, und der Vorschlag rollt mit zurück.
            throw new IllegalStateException("correction-Meldung verworfen: " + urteil.grund() + " " + urteil.hinweis());
        }
        ObjectNode kennungen = JSON.createObjectNode().put("komponente", r.entity().toString());
        ObjectNode nutzlast = JSON.createObjectNode().put("korrektur", kennung).put("korrektur_art", art)
                .put("status", status);
        try (PreparedStatement ps = con.prepareStatement("""
                INSERT INTO messreihe_ereignis (zeit, tenant_id, ereignis_id, art, urheber, von, bis, kennungen,
                       entity_id, messkanal, nutzlast, eingang)
                VALUES (?, ?, ?, 'correction', 'cloud', ?, ?, ?::jsonb, ?, ?, ?::jsonb, ?)
                ON CONFLICT DO NOTHING
                """)) {
            ps.setTimestamp(1, Timestamp.from(von));
            ps.setObject(2, r.tenant());
            ps.setObject(3, id);
            ps.setTimestamp(4, Timestamp.from(von));
            ps.setTimestamp(5, Timestamp.from(bis));
            ps.setString(6, kennungen.toString());
            ps.setObject(7, r.entity());
            ps.setString(8, r.kanal());
            ps.setString(9, nutzlast.toString());
            ps.setTimestamp(10, Timestamp.from(jetzt));
            ps.executeUpdate();
        }
    }

    // ---------------------------------------------------------------------------------- Hilfen

    private static ArrayNode reihen(Reihe r) {
        ArrayNode a = JSON.createArrayNode();
        a.addObject().put("entity_id", r.entity().toString()).put("messkanal", r.kanal());
        return a;
    }

    private static ZoneId zone(Connection con, Reihe r, Instant von) throws SQLException {
        return ReihenKontext.zeitzonen(con, List.of(new ReihenKontext.Frage(r.tenant(), r.entity(),
                LocalDate.ofInstant(von, ZoneOffset.UTC)))).get(0).zone();
    }

    private static JsonNode json(String text) throws SQLException {
        try {
            return JSON.readTree(text);
        } catch (JsonProcessingException e) {
            throw new SQLException("Vorschau nicht lesbar", e);
        }
    }

    private static String uhr(Instant t) {
        return t.truncatedTo(ChronoUnit.SECONDS).toString();
    }

    private static void reihe(PreparedStatement ps, Reihe r) throws SQLException {
        ps.setObject(1, r.tenant());
        ps.setObject(2, r.entity());
        ps.setString(3, r.kanal());
    }

    private static void reiheImZeitraum(PreparedStatement ps, Reihe r, Instant von, Instant bis) throws SQLException {
        reihe(ps, r);
        ps.setTimestamp(4, Timestamp.from(von));
        ps.setTimestamp(5, Timestamp.from(bis));
    }

    private interface Zug<T> {
        T fahren(Connection con) throws SQLException;
    }

    /** EINE Transaktion je Reihe bzw. Anfrage: Korrektur, Marker und erledigte Zeilen gehören zusammen. */
    private <T> T inTransaktion(Zug<T> zug) {
        return adminJdbc.execute((Connection con) -> {
            boolean autoCommit = con.getAutoCommit();
            con.setAutoCommit(false);
            try {
                T ergebnis = zug.fahren(con);
                con.commit();
                return ergebnis;
            } catch (Exception e) {
                con.rollback();
                throw e instanceof SQLException sql ? sql
                        : new SQLException("UEMS Korrektur-Vorschlag fehlgeschlagen", e);
            } finally {
                con.setAutoCommit(autoCommit);
            }
        });
    }
}
