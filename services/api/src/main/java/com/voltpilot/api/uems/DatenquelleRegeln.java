package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;

/**
 * Die REINEN Regeln des Vertrags <b>„Datenquelle und Zuständigkeit“</b> (UEMS AP-06 IP-1;
 * Prosa in {@code docs/contracts/v2/data-source-assignment.md}, Regeln im AP-06-Konzept
 * §4.1–§4.7, Entscheide E1, E2, E3, E5, E7, E8, E9, E10 = B, E11, E12).
 *
 * <p>Die Datenquelle ist ein eigenes Objekt mit Kennzeichen (E1); gelesen wird sie je Zeitpunkt
 * von höchstens EINER Box (E2), in halboffenen Zeiträumen auf die volle Minute
 * ({@code effective_from} gehört dazu, {@code effective_to} nicht). Ohne Spring, ohne
 * Repository, ohne Uhr — „jetzt“ ist ein Eingang wie jeder andere.
 *
 * <p>Der Zwilling im Portal ist {@code frontend/portal/src/uemsDatenquelle.ts}; beide fahren
 * dieselben Vektoren ({@code docs/contracts/v2/data-source-vectors.json}), die Fähigkeiten
 * stehen als Daten in {@code docs/contracts/v2/edge-capabilities.json}.
 * <b>Wer die Regel ändert, ändert beide Seiten und die Vektor-Datei.</b>
 *
 * <h2>⚠ Wer anruft</h2>
 *
 * {@link DatenquelleService} (IP-3: anlegen, prüfen, zuweisen) über die Tabellen aus IP-2. Kein
 * Push, keine Fläche ist umgestellt; {@code gatewayDevice}, Registry-Push und Herzschlag sind
 * unberührt. Diese Klasse ist der Vertrag, gegen den die Folgepakete bauen.
 *
 * <h2>Die Prüfreihenfolge eines Antrags</h2>
 *
 * <pre>
 *   protokoll_unbekannt → keine_volle_minute → rueckwirkend
 *   → (nur Wechsel) steuerquelle → spaeterer_wechsel_geplant → schon_zustaendig
 *   → adresse_an_box_vergeben → netzlage_fehlt → nur_ein_leser → vergleich_bestaetigen
 *   → pruefung_fehlt → pruefung_gescheitert
 * </pre>
 *
 * Der ERSTE zutreffende Grund entscheidet. Erst die billigen Regeln der Cloud (Zeit, Identität,
 * Doppel-Lesen), dann der Beweis von der Box (Erreichbarkeit vor Zuständigkeit, E11).
 */
public final class DatenquelleRegeln {

    private DatenquelleRegeln() {}

    private static final DateTimeFormatter DATUM_ZEIT = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");

    // ---------------------------------------------------------------- Vokabular

    /** Das geschlossene Vokabular der Protokolle (§4.2) — neue kommen nur über den Katalog. */
    public enum Protokoll {
        MODBUS_TCP("modbus_tcp", "Modbus TCP"),
        SUNSPEC_MODBUS("sunspec_modbus", "SunSpec-Modbus"),
        MQTT("mqtt", "MQTT-Themen"),
        HTTP("http", "HTTP-Auskunft"),
        OCPP("ocpp", "OCPP-Station");

        private final String code;
        private final String kundenwort;

        Protokoll(String code, String kundenwort) {
            this.code = code;
            this.kundenwort = kundenwort;
        }

        public String code() {
            return code;
        }

        public String kundenwort() {
            return kundenwort;
        }

        public static Optional<Protokoll> vonCode(String code) {
            for (Protokoll p : values()) {
                if (p.code.equals(code)) {
                    return Optional.of(p);
                }
            }
            return Optional.empty();
        }
    }

    /** Die drei Antworten auf einen Antrag. */
    public enum Urteil {
        ERLAUBT("erlaubt"),
        BESTAETIGUNG_NOETIG("bestaetigung_noetig"),
        ABGELEHNT("abgelehnt");

        private final String code;

        Urteil(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /**
     * Jeder Grund mit seinem Kundensatz. Platzhalter: {@code {box}}, {@code {kennzeichen}},
     * {@code {zeitpunkt}}; bei {@link #PRUEFUNG_GESCHEITERT} steht der Satz der Fehlerklasse.
     */
    public enum Grund {
        PROTOKOLL_UNBEKANNT("protokoll_unbekannt", Urteil.ABGELEHNT,
                "Dieses Protokoll kennt VoltPilot nicht — neue Protokolle kommen nur über den Katalog"),
        KEINE_VOLLE_MINUTE("keine_volle_minute", Urteil.ABGELEHNT,
                "Eine Zuständigkeit beginnt auf die volle Minute — bitte eine Uhrzeit ohne Sekunden wählen"),
        LEERER_ZEITRAUM("leerer_zeitraum", Urteil.ABGELEHNT,
                "Das Ende liegt nicht nach dem Beginn — ein Zeitraum dauert mindestens eine Minute"),
        RUECKWIRKEND("rueckwirkend", Urteil.ABGELEHNT,
                "Eine Zuständigkeit beginnt frühestens jetzt — nie rückwirkend"),
        STEUERQUELLE("steuerquelle", Urteil.ABGELEHNT,
                "Diese Quelle steuert — ihre Box kann erst mit der gemeinsamen Steuerung wechseln"),
        SPAETERER_WECHSEL_GEPLANT("spaeterer_wechsel_geplant", Urteil.ABGELEHNT,
                "Ab {zeitpunkt} liest bereits {box} — erst diesen geplanten Wechsel zurücknehmen"),
        SCHON_ZUSTAENDIG("schon_zustaendig", Urteil.ABGELEHNT,
                "{box} liest diese Quelle zu diesem Zeitpunkt bereits"),
        UEBERSCHNEIDUNG("ueberschneidung", Urteil.ABGELEHNT,
                "Überschneidet sich mit der Zuständigkeit von {box} — je Zeitpunkt liest höchstens eine Box"),
        ADRESSE_AN_BOX_VERGEBEN("adresse_an_box_vergeben", Urteil.ABGELEHNT,
                "Diese Adresse liest {box} bereits als {kennzeichen} — Gerät dort hinzufügen?"),
        NETZLAGE_FEHLT("netzlage_fehlt", Urteil.ABGELEHNT,
                "Gleiche Adresse wie {kennzeichen} an {box} — erst das Netz beider Quellen eintragen (Bogen D1/D2)"),
        NUR_EIN_LESER("nur_ein_leser", Urteil.ABGELEHNT,
                "Gleiche Adresse wie {kennzeichen} an {box} im selben Netz — nicht möglich: dieses Gerät"
                        + " verträgt nur einen Leser"),
        VERGLEICH_BESTAETIGEN("vergleich_bestaetigen", Urteil.BESTAETIGUNG_NOETIG,
                "Gleiche Adresse wie {kennzeichen} an {box} im selben Netz — als Vergleichsquelle anlegen"
                        + " (gekennzeichnet)?"),
        PRUEFUNG_FEHLT("pruefung_fehlt", Urteil.ABGELEHNT, "Es fehlt: Prüfung von {box}"),
        PRUEFUNG_GESCHEITERT("pruefung_gescheitert", Urteil.ABGELEHNT, "{fehlerklasse}");

        private final String code;
        private final Urteil urteil;
        private final String text;

        Grund(String code, Urteil urteil, String text) {
            this.code = code;
            this.urteil = urteil;
            this.text = text;
        }

        public String code() {
            return code;
        }

        public Urteil urteil() {
            return urteil;
        }

        public String text() {
            return text;
        }
    }

    /** In dieser Reihenfolge wird ein Antrag geprüft — die Reihenfolge IST die Regel. */
    public static final List<Grund> PRUEFREIHENFOLGE_ANTRAG = List.of(
            Grund.PROTOKOLL_UNBEKANNT, Grund.KEINE_VOLLE_MINUTE, Grund.RUECKWIRKEND,
            Grund.STEUERQUELLE, Grund.SPAETERER_WECHSEL_GEPLANT, Grund.SCHON_ZUSTAENDIG,
            Grund.ADRESSE_AN_BOX_VERGEBEN, Grund.NETZLAGE_FEHLT, Grund.NUR_EIN_LESER,
            Grund.VERGLEICH_BESTAETIGEN, Grund.PRUEFUNG_FEHLT, Grund.PRUEFUNG_GESCHEITERT);

    /** In dieser Reihenfolge wird ein neuer Zeitraum gegen die gespeicherten geprüft. */
    public static final List<Grund> PRUEFREIHENFOLGE_ZEITRAUM =
            List.of(Grund.KEINE_VOLLE_MINUTE, Grund.LEERER_ZEITRAUM, Grund.UEBERSCHNEIDUNG);

    /** In dieser Reihenfolge wird ein Box-Tausch geprüft. */
    public static final List<Grund> PRUEFREIHENFOLGE_TAUSCH =
            List.of(Grund.KEINE_VOLLE_MINUTE, Grund.RUECKWIRKEND);

    /** Wer eine Fehlerklasse feststellen kann. */
    public enum Herkunft {
        BOX("box"),
        CLOUD("cloud");

        private final String code;

        Herkunft(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }

        public static Herkunft vonCode(String code) {
            for (Herkunft h : values()) {
                if (h.code.equals(code)) {
                    return h;
                }
            }
            throw new IllegalArgumentException("unbekannte Herkunft: " + code);
        }
    }

    /**
     * Warum eine Quelle nicht gelesen wird (E5 = A): die Wörter des Verbindungstests
     * ({@code edge-app/core/internal/testconn}), dazu {@code layout_changed} (AP-05) und
     * {@code budget} von der Box sowie {@code box_meldet_sich_nicht}, das nur die Cloud ableitet.
     * Platzhalter: {@code {box}}, {@code {adresse}}.
     */
    public enum Fehlerklasse {
        UNREACHABLE("unreachable", "nicht erreichbar", Herkunft.BOX,
                "{box} erreicht {adresse} nicht — Netz/VLAN prüfen (Bogen D1/D2)"),
        NO_ANSWER("no_answer", "Zeitüberschreitung", Herkunft.BOX,
                "Gerät antwortet nicht rechtzeitig — Geräte-ID, Last oder Watchdog prüfen (Bogen D3/D4)"),
        INVALID_RESPONSE("invalid_response", "Gerät meldet Fehler", Herkunft.BOX,
                "Gerät antwortet mit Fehler — Registerbild oder Vorlage prüfen"),
        IMPLAUSIBLE("implausible", "Werte unplausibel", Herkunft.BOX,
                "Gerät antwortet, die Werte sind aber unplausibel — Vorlage und Wandlerfaktor prüfen"),
        FRONIUS_API("fronius_api", "Solar-API antwortet nicht", Herkunft.BOX,
                "Die Solar-API des Geräts antwortet nicht"),
        TIMEOUT("timeout", "kein Ergebnis", Herkunft.BOX,
                "{box} bekommt von {adresse} kein Ergebnis im Lesefenster"),
        LAYOUT_CHANGED("layout_changed", "Aufbau geändert", Herkunft.BOX,
                "Aufbau geändert — nichts wurde umgehängt"),
        BUDGET("budget", "Budget überschritten", Herkunft.BOX,
                "Diese Quelle passt nicht mehr in das Lesebudget von {box} — Takt strecken oder andere Box"
                        + " wählen"),
        BOX_MELDET_SICH_NICHT("box_meldet_sich_nicht", "Box meldet sich nicht", Herkunft.CLOUD,
                "{box} meldet sich nicht");

        private final String code;
        private final String kundenwort;
        private final Herkunft von;
        private final String text;

        Fehlerklasse(String code, String kundenwort, Herkunft von, String text) {
            this.code = code;
            this.kundenwort = kundenwort;
            this.von = von;
            this.text = text;
        }

        public String code() {
            return code;
        }

        public String kundenwort() {
            return kundenwort;
        }

        public Herkunft von() {
            return von;
        }

        public String text() {
            return text;
        }

        /** Der Kundensatz dieser Klasse für eine Box und eine Adresse. */
        public String satz(String boxName, String adresse) {
            return fuelle(text, Map.of("box", boxName, "adresse", adresse));
        }
    }

    /**
     * Nimmt eine Fehlerklasse an — oder verwirft sie. Nur das exakte Wort zählt (keine
     * Angleichung der Schreibweise), und nur von dem, der sie feststellen kann: eine Box meldet
     * nie, dass sie schweigt, die Cloud nie, dass ein Gerät nicht antwortet.
     */
    public static Optional<Fehlerklasse> fehlerklasse(String code, Herkunft von) {
        for (Fehlerklasse k : Fehlerklasse.values()) {
            if (k.code.equals(code) && k.von == von) {
                return Optional.of(k);
            }
        }
        return Optional.empty();
    }

    /** Woher die führende Box einer Anlage kommt, in Vorrang-Reihenfolge (E3). */
    public enum FuehrungsGrund {
        GESPEICHERT("gespeichert"),
        SPEICHER("speicher"),
        EINZIGE("einzige"),
        KEINE_WAHL("keine_wahl");

        private final String code;

        FuehrungsGrund(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Woher das Urteil über eine Fähigkeit kommt. */
    public enum Nachweis {
        SUPPORTS("supports"),
        TABELLE("tabelle");

        private final String code;

        Nachweis(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Die übrigen Sätze und Satzteile — dieselben wie {@code texte} in der Vektor-Datei. */
    public static final Map<String, String> TEXTE = texte();

    private static Map<String, String> texte() {
        Map<String, String> t = new LinkedHashMap<>();
        t.put("erlaubt", "Ab {zeitpunkt} liest {box}");
        t.put("hinweis_anderes_netz", "Gleiche Adresse wie {kennzeichen} — anderes Netz");
        t.put("hinweis_vergleichsquelle", "Vergleichsquelle zu {kennzeichen} an {box} — gekennzeichnet, ohne Bewertung");
        t.put("ausgebaut", "Ausgebaut am {zeitpunkt} — ersetzt durch {box}");
        t.put("fuehrt", "{box} führt die Anlage");
        t.put("keine_wahl", "Welche Box führt diese Anlage? — Box wählen");
        t.put("rolle_fuehrt", "liest {anzahl} · führt die Anlage");
        t.put("rolle_fuehrt_nicht", "liest {anzahl} · führt die Anlage nicht");
        t.put("anzahl_null", "keine Datenquelle");
        t.put("anzahl_eins", "1 Datenquelle");
        t.put("anzahl_viele", "{n} Datenquellen");
        t.put("software", "Software {stand}");
        t.put("software_unbekannt", "Software-Stand unbekannt");
        t.put("alle_faehigkeiten", "alle Fähigkeiten");
        t.put("update_noetig", "Update nötig für: {liste}");
        return Map.copyOf(t);
    }

    // ------------------------------------------------------------------- Formen

    /**
     * Ein Zeitraum, in dem {@code box} liest: {@code von} gehört dazu, {@code bis} nicht;
     * {@code bis == null} heißt offen.
     */
    public record Zeitraum(String box, Instant von, Instant bis) {

        /** Liest diese Box zum Zeitpunkt {@code t}? */
        public boolean umfasst(Instant t) {
            return !t.isBefore(von) && (bis == null || t.isBefore(bis));
        }

        /** Reicht der Zeitraum über {@code t} hinaus (endet nicht vorher)? */
        boolean reichtUeber(Instant t) {
            return bis == null || bis.isAfter(t);
        }

        boolean ueberschneidet(Zeitraum o) {
            boolean vorOEnde = o.bis == null || von.isBefore(o.bis);
            boolean nachOBeginn = bis == null || o.von.isBefore(bis);
            return vorOEnde && nachOBeginn;
        }
    }

    /** Eine bestehende Datenquelle mit den Zeiträumen ihrer zuständigen Box. */
    public record Quelle(
            String kennzeichen,
            String protokoll,
            String adresse,
            String netz,
            boolean steuerquelle,
            boolean mehrereLeser,
            List<Zeitraum> zeitraeume) {}

    /** Eine Quelle, die neu angelegt werden soll. */
    public record Kandidat(
            String protokoll, String adresse, String netz, List<Integer> geraeteIds, boolean mehrereLeser) {}

    /** Das Ergebnis der Erreichbarkeitsprüfung: „ok“ oder eine Fehlerklasse der Box. */
    public record Pruefung(String box, String ergebnis, Instant zeitpunkt) {}

    public enum Art {
        ANLEGEN,
        WECHSEL
    }

    /** Der Wunsch: {@code kandidat} anlegen oder {@code quelle} übergeben — an {@code box}, ab {@code effectiveFrom}. */
    public record Antrag(
            Art art,
            String quelle,
            Kandidat kandidat,
            String box,
            Instant effectiveFrom,
            Pruefung pruefung,
            boolean vergleichBestaetigt) {}

    /** Das Urteil über einen Antrag, samt Kundensatz und — wenn erlaubt — den Zeiträumen danach. */
    public record AntragErgebnis(
            Urteil urteil,
            Grund grund,
            String text,
            String hinweis,
            boolean vergleichsquelle,
            List<Zeitraum> zeitraeume) {}

    public record ZeitraumErgebnis(boolean gueltig, Grund grund, String text) {}

    /** Die Rolle einer Box: Heimat-Anlage und die Anlagen, die sie führt. */
    public record Rolle(String kennzeichen, String heimatAnlage, List<String> fuehrendFuer) {}

    public record QuellenZeitraeume(String kennzeichen, List<Zeitraum> zeitraeume) {}

    public record TauschErgebnis(
            Urteil urteil, Grund grund, String text, List<QuellenZeitraeume> quellen, Rolle neu) {}

    /** Eine Box einer Anlage und wie viele Datenquellen sie liest. */
    public record BoxLiest(String kennzeichen, String name, int liest) {}

    public record BoxRolle(String box, String text) {}

    public record FuehrungsErgebnis(String box, FuehrungsGrund grund, String text, List<BoxRolle> rollen) {}

    /** Was eine Box über ihre Software meldet; {@code supports == null}: kein Block. */
    public record Stand(String version, String release, List<String> supports) {}

    /** Eine Zeile der Tabelle {@code edge-capabilities.json}. */
    public record TabellenEintrag(String code, String name, String abRelease) {}

    public record FaehigkeitStatus(String code, boolean vorhanden, Nachweis nachweis) {}

    public record FaehigkeitenErgebnis(List<FaehigkeitStatus> faehigkeiten, String text) {}

    /** Eine vorhandene Komponente mit ihrem heutigen Anschluss. */
    public record BestandKomponente(
            String kennzeichen,
            String anlage,
            String box,
            String protokoll,
            String adresse,
            Integer geraeteId,
            Instant inBetriebAb,
            boolean steuerbar) {}

    public record Vorschlag(
            String kennzeichen,
            String anlage,
            String box,
            String protokoll,
            String adresse,
            List<Integer> geraeteIds,
            List<String> komponenten,
            boolean steuerquelle,
            List<Zeitraum> zeitraeume) {}

    // ------------------------------------------------------------------ Antrag

    /**
     * Darf {@code antrag.box()} die Quelle ab {@code antrag.effectiveFrom()} lesen?
     *
     * <p>Beim Wechsel wird der laufende Zeitraum zum Zeitpunkt BEENDET (Ende alt = Beginn neu)
     * und ein offener für die neue Box begonnen — nie überschrieben (AP-00 Regel 4). Die
     * Adresse wird so verglichen, wie sie gespeichert ist.
     *
     * @param boxNamen Kennzeichen → Name, für die Sätze
     */
    public static AntragErgebnis pruefeAntrag(
            Antrag antrag, List<Quelle> quellen, Map<String, String> boxNamen, Instant jetzt, ZoneId zone) {
        boolean wechsel = antrag.art() == Art.WECHSEL;
        Quelle q = wechsel ? finde(quellen, antrag.quelle()) : ausKandidat(antrag.kandidat());
        Instant t = antrag.effectiveFrom();
        String ziel = antrag.box();

        if (Protokoll.vonCode(q.protokoll()).isEmpty()) {
            return abgelehnt(Grund.PROTOKOLL_UNBEKANNT, Map.of());
        }
        if (!volleMinute(t)) {
            return abgelehnt(Grund.KEINE_VOLLE_MINUTE, Map.of());
        }
        if (t.isBefore(jetzt.truncatedTo(ChronoUnit.MINUTES))) {
            return abgelehnt(Grund.RUECKWIRKEND, Map.of());
        }
        Zeitraum letzter = letzter(q.zeitraeume());
        if (wechsel) {
            if (q.steuerquelle()) {
                return abgelehnt(Grund.STEUERQUELLE, Map.of());
            }
            if (letzter != null && t.isBefore(letzter.von())) {
                return abgelehnt(Grund.SPAETERER_WECHSEL_GEPLANT,
                        Map.of("zeitpunkt", zeit(letzter.von(), zone), "box", name(boxNamen, letzter.box())));
            }
            if (letzter != null && letzter.box().equals(ziel) && letzter.umfasst(t)) {
                return abgelehnt(Grund.SCHON_ZUSTAENDIG, Map.of("box", name(boxNamen, ziel)));
            }
        }

        // Eindeutigkeit je Box (§4.3 Nr. 2): an der Ziel-Box liest niemand sonst diesen Weg.
        for (Quelle o : quellen) {
            if (!andererGleicherWeg(o, q)) {
                continue;
            }
            for (Zeitraum z : o.zeitraeume()) {
                if (z.box().equals(ziel) && z.reichtUeber(t)) {
                    return abgelehnt(Grund.ADRESSE_AN_BOX_VERGEBEN,
                            Map.of("box", name(boxNamen, ziel), "kennzeichen", o.kennzeichen()));
                }
            }
        }

        // Doppel-Lesen (E10 = B): gleicher Weg an einer ANDEREN Box.
        String hinweis = null;
        boolean vergleichsquelle = false;
        for (Quelle o : quellen) {
            if (!andererGleicherWeg(o, q)) {
                continue;
            }
            for (Zeitraum z : o.zeitraeume()) {
                if (z.box().equals(ziel) || !z.reichtUeber(t)) {
                    continue;
                }
                Map<String, String> werte = Map.of("kennzeichen", o.kennzeichen(), "box", name(boxNamen, z.box()));
                if (q.netz() == null || o.netz() == null) {
                    return abgelehnt(Grund.NETZLAGE_FEHLT, werte);
                }
                if (q.netz().equals(o.netz())) {
                    boolean einLeser = !q.mehrereLeser() || !o.mehrereLeser() || q.steuerquelle() || o.steuerquelle();
                    if (einLeser) {
                        return abgelehnt(Grund.NUR_EIN_LESER, werte);
                    }
                    if (!antrag.vergleichBestaetigt()) {
                        Grund g = Grund.VERGLEICH_BESTAETIGEN;
                        return new AntragErgebnis(g.urteil(), g, fuelle(g.text(), werte), null, false, null);
                    }
                    vergleichsquelle = true;
                    if (hinweis == null) {
                        hinweis = fuelle(TEXTE.get("hinweis_vergleichsquelle"), werte);
                    }
                } else if (hinweis == null) {
                    hinweis = fuelle(TEXTE.get("hinweis_anderes_netz"), werte);
                }
            }
        }

        // Erreichbarkeit vor Zuständigkeit (E11, §4.4 Nr. 7) — und nur von GENAU dieser Box.
        Pruefung p = antrag.pruefung();
        boolean gueltig = p != null && ziel.equals(p.box())
                && ("ok".equals(p.ergebnis()) || fehlerklasse(p.ergebnis(), Herkunft.BOX).isPresent());
        if (!gueltig) {
            return abgelehnt(Grund.PRUEFUNG_FEHLT, Map.of("box", name(boxNamen, ziel)));
        }
        if (!"ok".equals(p.ergebnis())) {
            Fehlerklasse k = fehlerklasse(p.ergebnis(), Herkunft.BOX).orElseThrow();
            Grund g = Grund.PRUEFUNG_GESCHEITERT;
            return new AntragErgebnis(g.urteil(), g, k.satz(name(boxNamen, ziel), q.adresse()), null, false, null);
        }

        List<Zeitraum> danach = new ArrayList<>();
        for (Zeitraum z : q.zeitraeume()) {
            danach.add(z == letzter && z.reichtUeber(t) ? new Zeitraum(z.box(), z.von(), t) : z);
        }
        danach.add(new Zeitraum(ziel, t, null));
        String text = fuelle(TEXTE.get("erlaubt"), Map.of("zeitpunkt", zeit(t, zone), "box", name(boxNamen, ziel)));
        return new AntragErgebnis(Urteil.ERLAUBT, null, text, hinweis, vergleichsquelle, List.copyOf(danach));
    }

    // ---------------------------------------------------------------- Zeiträume

    /**
     * Die Speicher-Regel (IP-2: Ausschluss überlappender Zeiträume): darf {@code neu} zu
     * {@code bestehend} hinzukommen? Sie beendet nichts von selbst.
     */
    public static ZeitraumErgebnis pruefeZeitraum(
            List<Zeitraum> bestehend, Zeitraum neu, Map<String, String> boxNamen) {
        if (!volleMinute(neu.von()) || (neu.bis() != null && !volleMinute(neu.bis()))) {
            Grund g = Grund.KEINE_VOLLE_MINUTE;
            return new ZeitraumErgebnis(false, g, g.text());
        }
        if (neu.bis() != null && !neu.bis().isAfter(neu.von())) {
            Grund g = Grund.LEERER_ZEITRAUM;
            return new ZeitraumErgebnis(false, g, g.text());
        }
        for (Zeitraum b : bestehend) {
            if (b.ueberschneidet(neu)) {
                Grund g = Grund.UEBERSCHNEIDUNG;
                return new ZeitraumErgebnis(false, g, fuelle(g.text(), Map.of("box", name(boxNamen, b.box()))));
            }
        }
        return new ZeitraumErgebnis(true, null, null);
    }

    /** Welche Box liest zum Zeitpunkt {@code t} — die Herkunft je Wert; null: keine. */
    public static String zustaendigeBox(List<Zeitraum> zeitraeume, Instant t) {
        for (Zeitraum z : zeitraeume) {
            if (z.umfasst(t)) {
                return z.box();
            }
        }
        return null;
    }

    // --------------------------------------------------------------- Box-Tausch

    /**
     * Box tauschen (E7 = A): ab {@code zeitpunkt} übernimmt {@code neu} Heimat-Anlage, Rolle und
     * ALLE Zuständigkeiten von {@code alt} — die laufende wird geteilt, eine geplante wechselt
     * ganz. Was davor liegt, bleibt; nichts wird gelöscht, nie rückwirkend.
     */
    public static TauschErgebnis boxTausch(
            List<Quelle> quellen,
            Rolle alt,
            String neu,
            Instant zeitpunkt,
            Instant jetzt,
            Map<String, String> boxNamen,
            ZoneId zone) {
        if (!volleMinute(zeitpunkt)) {
            Grund g = Grund.KEINE_VOLLE_MINUTE;
            return new TauschErgebnis(g.urteil(), g, g.text(), null, null);
        }
        if (zeitpunkt.isBefore(jetzt.truncatedTo(ChronoUnit.MINUTES))) {
            Grund g = Grund.RUECKWIRKEND;
            return new TauschErgebnis(g.urteil(), g, g.text(), null, null);
        }
        List<QuellenZeitraeume> danach = new ArrayList<>();
        for (Quelle q : quellen) {
            List<Zeitraum> zs = new ArrayList<>();
            for (Zeitraum z : q.zeitraeume()) {
                if (!z.box().equals(alt.kennzeichen()) || !z.reichtUeber(zeitpunkt)) {
                    zs.add(z);
                } else if (!z.von().isBefore(zeitpunkt)) {
                    zs.add(new Zeitraum(neu, z.von(), z.bis()));
                } else {
                    zs.add(new Zeitraum(z.box(), z.von(), zeitpunkt));
                    zs.add(new Zeitraum(neu, zeitpunkt, z.bis()));
                }
            }
            danach.add(new QuellenZeitraeume(q.kennzeichen(), List.copyOf(zs)));
        }
        String text = fuelle(TEXTE.get("ausgebaut"),
                Map.of("zeitpunkt", zeit(zeitpunkt, zone), "box", name(boxNamen, neu)));
        return new TauschErgebnis(Urteil.ERLAUBT, null, text, List.copyOf(danach),
                new Rolle(neu, alt.heimatAnlage(), alt.fuehrendFuer()));
    }

    // ------------------------------------------------------------ führende Box

    /**
     * Die führende Box einer Anlage (E3 = A): die ausdrücklich gewählte, sonst die Box des
     * Speichers, sonst die einzige Box — sonst keine, und das Portal fragt. Nie geraten.
     */
    public static FuehrungsErgebnis fuehrendeBox(List<BoxLiest> boxen, String speicherBox, String gespeichert) {
        String box;
        FuehrungsGrund grund;
        if (gespeichert != null) {
            box = gespeichert;
            grund = FuehrungsGrund.GESPEICHERT;
        } else if (speicherBox != null) {
            box = speicherBox;
            grund = FuehrungsGrund.SPEICHER;
        } else if (boxen.size() == 1) {
            box = boxen.get(0).kennzeichen();
            grund = FuehrungsGrund.EINZIGE;
        } else {
            box = null;
            grund = FuehrungsGrund.KEINE_WAHL;
        }
        List<BoxRolle> rollen = new ArrayList<>();
        String name = null;
        for (BoxLiest b : boxen) {
            boolean fuehrt = b.kennzeichen().equals(box);
            if (fuehrt) {
                name = b.name();
            }
            rollen.add(new BoxRolle(b.kennzeichen(), fuelle(TEXTE.get(fuehrt ? "rolle_fuehrt" : "rolle_fuehrt_nicht"),
                    Map.of("anzahl", anzahl(b.liest())))));
        }
        String text = box == null
                ? TEXTE.get("keine_wahl")
                : fuelle(TEXTE.get("fuehrt"), Map.of("box", name == null ? box : name));
        return new FuehrungsErgebnis(box, grund, text, List.copyOf(rollen));
    }

    private static String anzahl(int n) {
        if (n == 0) {
            return TEXTE.get("anzahl_null");
        }
        if (n == 1) {
            return TEXTE.get("anzahl_eins");
        }
        return fuelle(TEXTE.get("anzahl_viele"), Map.of("n", Integer.toString(n)));
    }

    // -------------------------------------------------------------- Fähigkeiten

    /**
     * Welche Fähigkeiten hat eine Box (E12 = A)? Meldet sie {@code supports[]}, entscheidet
     * allein die Meldung (auch eine leere; fremde Wörter werden verworfen). Sonst die Tabelle:
     * vorhanden, wenn das Release der Box im Register nicht vor {@code abRelease} liegt. Ein
     * Stand ohne Release beweist nichts.
     *
     * @param register die Releases in der Ordnung des Registers ({@code release_seq}), älteste zuerst
     */
    public static FaehigkeitenErgebnis faehigkeiten(Stand stand, List<TabellenEintrag> tabelle, List<String> register) {
        List<FaehigkeitStatus> status = new ArrayList<>();
        List<String> fehlend = new ArrayList<>();
        for (TabellenEintrag e : tabelle) {
            boolean vorhanden;
            Nachweis nachweis;
            if (stand.supports() != null) {
                vorhanden = stand.supports().contains(e.code());
                nachweis = Nachweis.SUPPORTS;
            } else {
                int ist = stand.release() == null ? -1 : register.indexOf(stand.release());
                int ab = e.abRelease() == null ? -1 : register.indexOf(e.abRelease());
                vorhanden = ist >= 0 && ab >= 0 && ist >= ab;
                nachweis = Nachweis.TABELLE;
            }
            status.add(new FaehigkeitStatus(e.code(), vorhanden, nachweis));
            if (!vorhanden) {
                fehlend.add(e.name());
            }
        }
        String gezeigt = stand.release() != null ? stand.release() : stand.version();
        String kopf = gezeigt == null
                ? TEXTE.get("software_unbekannt")
                : fuelle(TEXTE.get("software"), Map.of("stand", gezeigt));
        String rest = fehlend.isEmpty()
                ? TEXTE.get("alle_faehigkeiten")
                : fuelle(TEXTE.get("update_noetig"), Map.of("liste", String.join(", ", fehlend)));
        return new FaehigkeitenErgebnis(List.copyOf(status), kopf + " · " + rest);
    }

    // ------------------------------------------------------------------ Bestand

    /**
     * Die Vorschlagsliste der Bestands-Übernahme (§4.4 Nr. 8, A12): Komponenten gruppiert nach
     * Box + Protokoll + Adresse, in der Reihenfolge ihres ersten Auftretens; Kennzeichen ab
     * {@code naechsteNummer}; zuständig die heutige Box ab Reihenbeginn. Das ist der EINZIGE
     * Weg, auf dem ein Zeitraum in der Vergangenheit beginnt — er beschreibt, was die Box
     * ohnehin gelesen hat, und wird erst mit der Bestätigung geschrieben.
     */
    public static List<Vorschlag> vorschlagsliste(List<BestandKomponente> komponenten, int naechsteNummer) {
        Map<String, List<BestandKomponente>> gruppen = new LinkedHashMap<>();
        for (BestandKomponente k : komponenten) {
            gruppen.computeIfAbsent(k.box() + " " + k.protokoll() + " " + k.adresse(),
                    x -> new ArrayList<>()).add(k);
        }
        List<Vorschlag> out = new ArrayList<>();
        int nummer = naechsteNummer;
        for (List<BestandKomponente> g : gruppen.values()) {
            BestandKomponente erste = g.get(0);
            TreeSet<Integer> ids = new TreeSet<>();
            List<String> namen = new ArrayList<>();
            Instant beginn = erste.inBetriebAb();
            boolean steuerquelle = false;
            for (BestandKomponente k : g) {
                if (k.geraeteId() != null) {
                    ids.add(k.geraeteId());
                }
                namen.add(k.kennzeichen());
                if (k.inBetriebAb().isBefore(beginn)) {
                    beginn = k.inBetriebAb();
                }
                steuerquelle |= k.steuerbar();
            }
            out.add(new Vorschlag("DQ-" + nummer++, erste.anlage(), erste.box(), erste.protokoll(), erste.adresse(),
                    List.copyOf(ids), List.copyOf(namen), steuerquelle,
                    List.of(new Zeitraum(erste.box(), beginn, null))));
        }
        return List.copyOf(out);
    }

    // ------------------------------------------------------------------- Hilfen

    private static Quelle finde(List<Quelle> quellen, String kennzeichen) {
        for (Quelle q : quellen) {
            if (q.kennzeichen().equals(kennzeichen)) {
                return q;
            }
        }
        throw new IllegalArgumentException("unbekannte Quelle: " + kennzeichen);
    }

    private static Quelle ausKandidat(Kandidat k) {
        return new Quelle(null, k.protokoll(), k.adresse(), k.netz(), false, k.mehrereLeser(), List.of());
    }

    /** Eine ANDERE Quelle auf demselben Erfassungsweg (Protokoll + Adresse). */
    private static boolean andererGleicherWeg(Quelle o, Quelle q) {
        if (q.kennzeichen() != null && q.kennzeichen().equals(o.kennzeichen())) {
            return false;
        }
        return o.protokoll().equals(q.protokoll()) && o.adresse().equals(q.adresse());
    }

    /** Der Zeitraum mit dem spätesten Beginn — der, den ein Wechsel beendet. */
    private static Zeitraum letzter(List<Zeitraum> zeitraeume) {
        Zeitraum l = null;
        for (Zeitraum z : zeitraeume) {
            if (l == null || z.von().isAfter(l.von())) {
                l = z;
            }
        }
        return l;
    }

    private static boolean volleMinute(Instant t) {
        return t.getNano() == 0 && Math.floorMod(t.getEpochSecond(), 60) == 0;
    }

    private static AntragErgebnis abgelehnt(Grund g, Map<String, String> werte) {
        return new AntragErgebnis(g.urteil(), g, fuelle(g.text(), werte), null, false, null);
    }

    private static String name(Map<String, String> boxNamen, String kennzeichen) {
        return boxNamen.getOrDefault(kennzeichen, kennzeichen);
    }

    private static String zeit(Instant t, ZoneId zone) {
        return DATUM_ZEIT.format(t.atZone(zone));
    }

    private static String fuelle(String vorlage, Map<String, String> werte) {
        String s = vorlage;
        for (Map.Entry<String, String> e : werte.entrySet()) {
            s = s.replace("{" + e.getKey() + "}", e.getValue());
        }
        return s;
    }
}
