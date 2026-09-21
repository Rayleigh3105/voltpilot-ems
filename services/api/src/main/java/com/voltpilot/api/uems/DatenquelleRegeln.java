package com.voltpilot.api.uems;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
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
 * {@link DatenquelleService} (IP-3: anlegen, prüfen, zuweisen) über die Tabellen aus IP-2, und
 * {@link FuehrendeBoxAbleitung} (IP-5) über {@link #fuehrung} — die Vorrang-Reihenfolge der
 * führenden Box, aus der {@code LeadDeviceService} das Ziel von Registry-Push und
 * Flow-Aktivierung bestimmt, und {@link DatenquelleVorschlagService} (IP-4) über
 * {@link #vorschlagsliste} — die Vorschlagsliste der Bestands-Übernahme. Keine Fläche ist
 * umgestellt; Herzschlag und Push-Inhalt sind unberührt. Diese Klasse ist der Vertrag, gegen den
 * die Folgepakete bauen.
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
        OCPP("ocpp", "OCPP-Station"),
        /** Deye über den Datenlogger: Modbus-RTU im Solarman-V5-Rahmen über TCP (IP-4, AP-06 Soll-Regel 8). */
        SOLARMAN_V5("solarman_v5", "Solarman-Datenlogger");

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

    // ------------------------------------------- Gemeinsame Steuerung (AP-15 T6, IP-26)

    /**
     * Wohin ein Wechsel der zuständigen Box führt, VOR der Prüfreihenfolge des Antrags (Familie
     * {@code gemeinsame_steuerung}). Kein Grund des Vokabulars: ob eine Anlage eine Gemeinsame Steuerung hat, ist ein
     * Fakt des Vertrags {@code steuerungsverbund.md}, nicht der Datenquelle — die Schnittstelle antwortet mit ihrem
     * Code {@code gemeinsame_steuerung_aendern} (409).
     */
    public enum WechselWeg {
        /** Der Zuständigkeitswechsel, wie er ist: es entscheidet die Prüfreihenfolge — auch {@code steuerquelle}. */
        ZUSTAENDIGKEITSWECHSEL("zustaendigkeitswechsel"),
        /** Nur als Änderung der Gemeinsamen Steuerung (anhalten → ändern → prüfen → scharfschalten). */
        GEMEINSAME_STEUERUNG_AENDERN("gemeinsame_steuerung_aendern");

        private final String code;

        WechselWeg(String code) {
            this.code = code;
        }

        public String code() {
            return code;
        }
    }

    /** Die Zustände (GET …/gemeinsame-steuerung), in denen eine Gemeinsame Steuerung Mitglieder trägt. */
    private static final Set<String> EINGERICHTET =
            Set.of("erklaert", "beobachtet", "geprueft", "anteile_aktiv", "angehalten");

    /**
     * T6: in einer Anlage MIT eingerichteter Gemeinsamer Steuerung wechselt eine Steuerquelle ihre Box nur über
     * „Gemeinsame Steuerung ändern“ (IP-26 — die AP-06-Sperre {@code steuerquelle} „…erst mit der gemeinsamen
     * Steuerung“ wäre dort eine Sackgasse), ebenso jede Quelle, die sie in einer scharfen oder angehaltenen Anlage
     * trägt ({@code nurAlsAenderung}, IP-8). Ohne Gemeinsame Steuerung, nach dem Auflösen und für jede andere Quelle
     * bleibt der Zuständigkeitswechsel, wie er ist (I6).
     *
     * @param zustand der Zustand der Gemeinsamen Steuerung der Anlage, {@code null} ohne
     * @param nurAlsAenderung das Urteil von {@link SteuerungsverbundRegeln#wechseltNurAlsAenderung}
     */
    public static WechselWeg wegDesWechsels(boolean steuerquelle, String zustand, boolean nurAlsAenderung) {
        if (zustand == null || !EINGERICHTET.contains(zustand)) {
            return WechselWeg.ZUSTAENDIGKEITSWECHSEL;
        }
        return steuerquelle || nurAlsAenderung ? WechselWeg.GEMEINSAME_STEUERUNG_AENDERN
                : WechselWeg.ZUSTAENDIGKEITSWECHSEL;
    }

    /** Der Satz zu {@link WechselWeg#GEMEINSAME_STEUERUNG_AENDERN}: Grund und Weg (Muster AP-03). */
    public static String gemeinsameSteuerungAendern(String kennzeichen) {
        return fuelle(TEXTE.get("gemeinsame_steuerung_aendern"), Map.of("kennzeichen", kennzeichen));
    }

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
        t.put("gemeinsame_steuerung_aendern",
                "{kennzeichen} gehört zur Gemeinsamen Steuerung — ihre Box wechselt nur über „Gemeinsame Steuerung ändern“");
        return Map.copyOf(t);
    }

    /**
     * Warum eine vorhandene Komponente in der Vorschlagsliste der Bestands-Übernahme KEINE Quelle
     * bekommt (§8) — geschlossen, in Prüfreihenfolge, je Grund der Kundensatz. Platzhalter:
     * {@code {anker}}.
     */
    public enum AuslassGrund {
        KEINE_BOX("keine_box",
                "Keine Box liest diese Komponente — ohne Box gibt es keine Datenquelle vorzuschlagen"),
        KEINE_ADRESSE("keine_adresse",
                "Für diese Komponente kennt VoltPilot keine eindeutige Adresse, unter der eine Box sie"
                        + " liest — sie bekommt keine Datenquelle"),
        PROTOKOLL_UNBEKANNT("protokoll_unbekannt",
                "Für dieses Protokoll gibt es noch keine Datenquelle — neue Protokolle kommen nur über"
                        + " den Katalog"),
        ANKER_OHNE_VORSCHLAG("anker_ohne_vorschlag",
                "Wird über {anker} gelesen — dafür gibt es hier keinen Vorschlag");

        private final String code;
        private final String text;

        AuslassGrund(String code, String text) {
            this.code = code;
            this.text = text;
        }

        public String code() {
            return code;
        }

        public String text() {
            return text;
        }
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

    /** Die führende Box ohne Sätze: die Box (oder {@code null}) und woher sie kommt. */
    public record Fuehrung<B>(B box, FuehrungsGrund grund) {}

    /** Was eine Box über ihre Software meldet; {@code supports == null}: kein Block. */
    public record Stand(String version, String release, List<String> supports) {}

    /** Eine Zeile der Tabelle {@code edge-capabilities.json}. */
    public record TabellenEintrag(String code, String name, String abRelease) {}

    public record FaehigkeitStatus(String code, boolean vorhanden, Nachweis nachweis) {}

    public record FaehigkeitenErgebnis(List<FaehigkeitStatus> faehigkeiten, String text) {}

    /**
     * Eine vorhandene Komponente mit ihrem heutigen Anschluss.
     *
     * @param box         die Box, die sie heute liest; {@code null}: keine
     * @param protokoll   ein Wort des Vokabulars — oder das Transport-Wort, das es dort nicht gibt
     *                    (wird verworfen, nie abgebildet); {@code null}: kein lesbarer Weg
     * @param adresse     so, wie eine Quelle sie speichert (§3 Nr. 5); {@code null}: keine
     *                    eindeutige
     * @param gehoertZu   ein komponiertes Geschwister ohne eigenen Anschluss: der Wechselrichter,
     *                    über den es gelesen wird — dann zählen DESSEN Box, Protokoll und Adresse
     * @param kadenzS     wie oft die Box sie heute liest; {@code null}: nicht erhoben
     * @param inBetriebAb der Beginn ihrer Reihe an dieser Box
     */
    public record BestandKomponente(
            String kennzeichen,
            String anlage,
            String box,
            String protokoll,
            String adresse,
            Integer geraeteId,
            String gehoertZu,
            Integer kadenzS,
            Instant inBetriebAb,
            boolean steuerbar) {}

    /** Ein Vorschlag: EINE Quelle mit den Komponenten dahinter und dem Zeitraum ab Reihenbeginn. */
    public record Vorschlag(
            String kennzeichen,
            String anlage,
            String box,
            String protokoll,
            String adresse,
            List<Integer> geraeteIds,
            List<String> komponenten,
            boolean steuerquelle,
            Integer kadenzS,
            List<Zeitraum> zeitraeume) {}

    /** Eine Komponente ohne Vorschlag: der Grund, das verworfene Wort bzw. der Wechselrichter. */
    public record Auslass(String komponente, AuslassGrund grund, String protokoll, String anker, String text) {}

    /** Die Vorschlagsliste: die Vorschläge und — benannt — was keinen bekommt. */
    public record Vorschlagsliste(List<Vorschlag> vorschlaege, List<Auslass> ausgelassen) {}

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
        AntragErgebnis vergeben = adresseAnBoxVergeben(q, ziel, t, quellen, boxNamen);
        if (vergeben != null) {
            return vergeben;
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
        Fuehrung<String> fuehrung = fuehrung(boxen.stream().map(BoxLiest::kennzeichen).toList(),
                speicherBox, gespeichert);
        String box = fuehrung.box();
        FuehrungsGrund grund = fuehrung.grund();
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

    /**
     * Die Vorrang-Reihenfolge allein (E3 = A), für jede Art Box-Kennung — das Kennzeichen der
     * Vektoren wie die Geräte-UUID des Dienstes. {@link #fuehrendeBox} baut daraus die Sätze,
     * {@link FuehrendeBoxAbleitung} das Ziel von Registry-Push und Flow-Aktivierung; die Regel
     * steht damit genau hier.
     */
    public static <B> Fuehrung<B> fuehrung(List<B> boxen, B speicherBox, B gespeichert) {
        if (gespeichert != null) {
            return new Fuehrung<>(gespeichert, FuehrungsGrund.GESPEICHERT);
        }
        if (speicherBox != null) {
            return new Fuehrung<>(speicherBox, FuehrungsGrund.SPEICHER);
        }
        if (boxen.size() == 1) {
            return new Fuehrung<>(boxen.get(0), FuehrungsGrund.EINZIGE);
        }
        return new Fuehrung<>(null, FuehrungsGrund.KEINE_WAHL);
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
     * Welche Fähigkeiten hat eine Box (E12 = A)? Gemeldet ODER laut Tabelle:
     * eine leere/teilweise Meldung entzieht keine durch die Tabelle belegte Fähigkeit.
     * Laut Tabelle vorhanden, wenn das Release der Box im Register nicht vor {@code abRelease} liegt. Ein
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
            if (stand.supports() != null && stand.supports().contains(e.code())) {
                vorhanden = true;
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

    /** Der Erfassungsweg an einer Box — der Schlüssel einer Gruppe (§4.4 Nr. 8). */
    private record Weg(String box, String protokoll, String adresse) {}

    /**
     * Die Vorschlagsliste der Bestands-Übernahme (§4.4 Nr. 8, §8, A9, A12): Komponenten gruppiert
     * nach Box + Protokoll + Adresse, in der Reihenfolge ihres ersten Auftretens; zuständig die
     * heutige Box ab Reihenbeginn. Das ist der EINZIGE Weg, auf dem ein Zeitraum in der
     * Vergangenheit beginnt — er beschreibt, was die Box ohnehin gelesen hat, und wird erst mit
     * der Bestätigung geschrieben.
     *
     * <ul>
     *   <li>Ein komponiertes Geschwister ({@code gehoertZu}) landet in der Quelle seines
     *       Wechselrichters, auch wenn es vor ihm steht; hat der keinen Vorschlag, wird es mit
     *       {@code anker_ohne_vorschlag} ausgelassen.</li>
     *   <li>Was keinen lesbaren Weg hat, wird BENANNT ausgelassen — nie geraten, nie auf ein
     *       anderes Wort abgebildet. Prüfreihenfolge: {@code keine_box} → {@code keine_adresse}
     *       (kein Protokoll) → {@code protokoll_unbekannt} → {@code keine_adresse} (keine
     *       Adresse).</li>
     *   <li>Kennzeichen ab {@code naechsteNummer}; eine Nummer, die {@code belegt} schon trägt,
     *       wird übersprungen (wie {@code uems_datenquelle_kennzeichen()} beim Speichern).</li>
     *   <li>Geräte-IDs aufsteigend (die der Komponenten mit eigenem Weg), Steuerquelle, wenn eine
     *       Komponente steuerbar ist, Lesetakt der kleinste bekannte (sonst {@code null}).</li>
     * </ul>
     *
     * @param namen Kennzeichen → Name, für den Satz von {@code anker_ohne_vorschlag}
     */
    public static Vorschlagsliste vorschlagsliste(List<BestandKomponente> komponenten, int naechsteNummer,
            Collection<String> belegt, Map<String, String> namen) {
        Map<String, Weg> eigenerWeg = new HashMap<>();
        Map<String, Auslass> aus = new HashMap<>();
        for (BestandKomponente k : komponenten) {
            if (k.gehoertZu() != null) {
                continue;
            }
            AuslassGrund g = auslassGrund(k);
            if (g != null) {
                aus.put(k.kennzeichen(), new Auslass(k.kennzeichen(), g,
                        g == AuslassGrund.PROTOKOLL_UNBEKANNT ? k.protokoll() : null, null, g.text()));
            } else {
                eigenerWeg.put(k.kennzeichen(), new Weg(k.box(), k.protokoll(), k.adresse()));
            }
        }
        Map<String, Weg> weg = new HashMap<>(eigenerWeg);
        for (BestandKomponente k : komponenten) {
            if (k.gehoertZu() == null) {
                continue;
            }
            Weg w = eigenerWeg.get(k.gehoertZu());
            if (w != null) {
                weg.put(k.kennzeichen(), w);
            } else {
                AuslassGrund g = AuslassGrund.ANKER_OHNE_VORSCHLAG;
                aus.put(k.kennzeichen(), new Auslass(k.kennzeichen(), g, null, k.gehoertZu(),
                        fuelle(g.text(), Map.of("anker", namen.getOrDefault(k.gehoertZu(), k.gehoertZu())))));
            }
        }

        Map<Weg, List<BestandKomponente>> gruppen = new LinkedHashMap<>();
        List<Auslass> ausgelassen = new ArrayList<>();
        for (BestandKomponente k : komponenten) {
            Weg w = weg.get(k.kennzeichen());
            if (w != null) {
                gruppen.computeIfAbsent(w, x -> new ArrayList<>()).add(k);
            } else {
                ausgelassen.add(aus.get(k.kennzeichen()));
            }
        }

        Set<String> vergeben = Set.copyOf(belegt);
        List<Vorschlag> out = new ArrayList<>();
        int nummer = naechsteNummer;
        for (Map.Entry<Weg, List<BestandKomponente>> e : gruppen.entrySet()) {
            Weg w = e.getKey();
            List<BestandKomponente> g = e.getValue();
            TreeSet<Integer> ids = new TreeSet<>();
            List<String> kennzeichen = new ArrayList<>();
            Instant beginn = g.get(0).inBetriebAb();
            boolean steuerquelle = false;
            Integer kadenz = null;
            for (BestandKomponente k : g) {
                if (k.gehoertZu() == null && k.geraeteId() != null) {
                    ids.add(k.geraeteId());
                }
                kennzeichen.add(k.kennzeichen());
                if (k.inBetriebAb().isBefore(beginn)) {
                    beginn = k.inBetriebAb();
                }
                steuerquelle |= k.steuerbar();
                if (k.kadenzS() != null && (kadenz == null || k.kadenzS() < kadenz)) {
                    kadenz = k.kadenzS();
                }
            }
            while (vergeben.contains("DQ-" + nummer)) {
                nummer++;
            }
            out.add(new Vorschlag("DQ-" + nummer++, g.get(0).anlage(), w.box(), w.protokoll(), w.adresse(),
                    List.copyOf(ids), List.copyOf(kennzeichen), steuerquelle, kadenz,
                    List.of(new Zeitraum(w.box(), beginn, null))));
        }
        return new Vorschlagsliste(List.copyOf(out), List.copyOf(ausgelassen));
    }

    /**
     * Die Eindeutigkeit je Box (§3 Nr. 2) für einen Vorschlag der Bestands-Übernahme: liest an
     * seiner Box ab Reihenbeginn schon eine ANDERE Quelle denselben Weg? Derselbe Grund und Satz
     * wie im Antrag ({@code adresse_an_box_vergeben}). Die übrigen Regeln des Antrags — nie
     * rückwirkend, Prüfung von der Box — gelten für den Bestand nicht: er beschreibt, was die Box
     * ohnehin gelesen hat (§4, §8).
     */
    public static Optional<AntragErgebnis> bestandWegVergeben(Vorschlag v, List<Quelle> quellen,
            Map<String, String> boxNamen) {
        Quelle q = new Quelle(null, v.protokoll(), v.adresse(), null, v.steuerquelle(), false, List.of());
        Instant ab = v.zeitraeume().get(0).von();
        AntragErgebnis selbeBox = adresseAnBoxVergeben(q, v.box(), ab, quellen, boxNamen);
        if (selbeBox != null) {
            return Optional.of(selbeBox);
        }
        // Der Bestands-Assistent kennt keine dokumentierte Netzlage. Eine gleiche Adresse an
        // einer anderen Box darf er deshalb nicht still als „anderes Netz“ deuten: erst über den
        // normalen Anlegeweg Netze eintragen und dort ggf. als Vergleichsquelle bestätigen.
        for (Quelle andere : quellen) {
            if (!andererGleicherWeg(andere, q)) {
                continue;
            }
            for (Zeitraum z : andere.zeitraeume()) {
                if (!z.box().equals(v.box()) && z.reichtUeber(ab)) {
                    return Optional.of(abgelehnt(Grund.NETZLAGE_FEHLT,
                            Map.of("kennzeichen", andere.kennzeichen(), "box", name(boxNamen, z.box()))));
                }
            }
        }
        return Optional.empty();
    }

    /** Der Satz einer Zuständigkeit — „Ab 12.03.2024 00:00 liest Box Halle 1“ ({@code texte.erlaubt}). */
    public static String liestAb(Instant t, String boxName, ZoneId zone) {
        return fuelle(TEXTE.get("erlaubt"), Map.of("zeitpunkt", zeit(t, zone), "box", boxName));
    }

    /** Liest an {@code ziel} ab {@code t} schon eine andere Quelle den Weg von {@code q}? Sonst {@code null}. */
    private static AntragErgebnis adresseAnBoxVergeben(Quelle q, String ziel, Instant t, List<Quelle> quellen,
            Map<String, String> boxNamen) {
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
        return null;
    }

    /** Warum eine Komponente mit EIGENEM Anschluss keinen Vorschlag bekommt — oder {@code null}. */
    private static AuslassGrund auslassGrund(BestandKomponente k) {
        if (k.box() == null) {
            return AuslassGrund.KEINE_BOX;
        }
        if (k.protokoll() == null) {
            return AuslassGrund.KEINE_ADRESSE;
        }
        if (Protokoll.vonCode(k.protokoll()).isEmpty()) {
            return AuslassGrund.PROTOKOLL_UNBEKANNT;
        }
        return k.adresse() == null ? AuslassGrund.KEINE_ADRESSE : null;
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
