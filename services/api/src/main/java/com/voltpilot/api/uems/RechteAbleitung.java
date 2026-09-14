package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Die REINE Ableitung der <b>Rechte</b> (UEMS AP-03 IP-1; Regeln im AP-03-Konzept §4.1–§4.7,
 * Entscheide E1, E4, E5, E6, E8, E9, E10, E13, E15 vom 10.09.2026).
 *
 * <p>Aus der Rechte-Matrix ({@code docs/contracts/v2/rechte-matrix.json}, 48 Aktionen × 7
 * Rollen) und den Zuweisungen eines Benutzers wird ein Ja oder Nein mit Grund in Kundensprache:
 * {@link #darf}, dazu {@link #sichtbareStandorte}, {@link #teilansicht}, {@link #summe},
 * {@link #geltungsbereich}, {@link #ocppStufe}, {@link #unterstuetzung}, {@link #gewaehren},
 * {@link #handeingriff} und {@link #zuweisungAendern}. Ohne Spring, ohne Repository, ohne Uhr:
 * „jetzt“ ist immer ein Eingang.
 *
 * <p>Der Zwilling im Portal ist {@code frontend/portal/src/rechte.ts}; beide fahren dieselben
 * Vektoren ({@code docs/contracts/v2/rechte-vectors.json}). <b>Wer die Regel ändert, ändert
 * beide Seiten und die Vektor-Datei.</b>
 *
 * <h2>⚠ Noch ruft fast niemand an</h2>
 *
 * Keine Zuweisungstabelle (IP-2), kein {@code ZugriffContext} und kein {@code /me} (IP-4), kein
 * Filter und kein {@code @Recht}-Interceptor (IP-5 … IP-7), keine Fläche (IP-12). Diese Klasse
 * ist der Vertrag, gegen den die Durchsetzung gebaut wird — sie selbst erzwingt nichts. Die
 * einzige Ausnahme sind die Korrektur-Routen (AP-08 IP-15, {@code KorrekturRechte}): sie rufen
 * {@link #darf} und {@link #korrekturEntscheiden} mit dem heutigen Aufrufer an.
 *
 * <h2>Geltungsbereich vor Aktion (Invariante 4, W2)</h2>
 *
 * Erst wird geprüft, ob das Ziel im Geltungsbereich liegt (sonst 404 — die Existenz wird nie
 * bestätigt), dann, ob die Aktion erlaubt ist (sonst 403 mit {@code rolle_noetig}). Eine Anlage
 * als Ziel wird über ihren Standort ZUM STICHTAG aufgelöst (Folgepaket-Regel 7: Rechte prüfen
 * die heutige Zuweisung, Daten lesen den Stichtag).
 */
public final class RechteAbleitung {

    private RechteAbleitung() {}

    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final DateTimeFormatter DATUM_ZEIT =
            DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");

    /** Die Erinnerung vor dem Ende einer Unterstützung (E6). */
    public static final Duration ERINNERUNG = Duration.ofDays(7);

    /** Die Dauer eines Notfall-Zugriffs (E8). */
    public static final Duration NOTFALL = Duration.ofHours(24);

    /** Die längste Unterstützung in Monaten (E6). */
    public static final int HOECHSTENS_MONATE = 12;

    /** Die Vorgabe-Dauer einer Unterstützung im Gewähren-Dialog (E6). */
    public static final int VORGABE_TAGE = 30;

    // ---------------------------------------------------------------- Vokabular

    /** Ein Vokabular-Wort mit seinem Code aus der Vektor-Datei. */
    public interface Code {
        String code();
    }

    private static <E extends Enum<E> & Code> E vonCode(Class<E> art, String code) {
        for (E e : art.getEnumConstants()) {
            if (e.code().equals(code)) {
                return e;
            }
        }
        throw new IllegalArgumentException("unbekannt in " + art.getSimpleName() + ": " + code);
    }

    /** Die sieben Spalten der Matrix, in der Spaltenreihenfolge der Konzept-Tabelle. */
    public enum Rolle implements Code {
        KUNDENADMINISTRATOR("kundenadministrator", "Kundenadministrator"),
        ENERGIEMANAGER("energiemanager", "Energiemanager"),
        BEARBEITER("bearbeiter", "Bearbeiter"),
        BEDIENBERECHTIGT("bedienberechtigt", "Bedienberechtigt"),
        LESER("leser", "Leser"),
        UNTERSTUETZER("unterstuetzer", "Unterstützer"),
        VOLTPILOT_BETRIEB("voltpilot_betrieb", "VoltPilot-Betrieb");

        private final String code;
        private final String kundenwort;

        Rolle(String code, String kundenwort) {
            this.code = code;
            this.kundenwort = kundenwort;
        }

        @Override
        public String code() {
            return code;
        }

        public String kundenwort() {
            return kundenwort;
        }

        /** Bearbeiter, Bedienberechtigt und Leser gelten je Standort (E1) — sie brauchen einen. */
        public boolean jeStandort() {
            return this == BEARBEITER || this == BEDIENBERECHTIGT || this == LESER;
        }

        public static Rolle vonCode(String code) {
            return RechteAbleitung.vonCode(Rolle.class, code);
        }
    }

    /**
     * Die Reihenfolge, in der {@code rolle_noetig} die KLEINSTE Rolle sucht, die das Recht hätte.
     * Wo Leser es hat, haben es Bearbeiter und Bedienberechtigt auch — die beiden stehen deshalb
     * nie gegeneinander.
     */
    public static final List<Rolle> ROLLE_NOETIG_REIHENFOLGE =
            List.of(
                    Rolle.LESER,
                    Rolle.BEARBEITER,
                    Rolle.BEDIENBERECHTIGT,
                    Rolle.ENERGIEMANAGER,
                    Rolle.KUNDENADMINISTRATOR,
                    Rolle.VOLTPILOT_BETRIEB);

    /** Die Zellen-Codes der Konzept-Legende. */
    public enum Zelle implements Code {
        U("U"),
        S("S"),
        E("E"),
        NEIN("-"),
        P("P"),
        A("A"),
        EI("Ei"),
        B("B");

        private final String code;

        Zelle(String code) {
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }

        public static Zelle vonCode(String code) {
            return RechteAbleitung.vonCode(Zelle.class, code);
        }
    }

    /** Der Umfang einer Unterstützung (E9), AUFSTEIGEND. */
    public enum Umfang implements Code {
        ANSEHEN("ansehen", "Ansehen"),
        EINRICHTEN("einrichten", "Einrichten"),
        EINRICHTEN_UND_BEDIENEN("einrichten_und_bedienen", "Einrichten und Bedienen");

        private final String code;
        private final String kundenwort;

        Umfang(String code, String kundenwort) {
            this.code = code;
            this.kundenwort = kundenwort;
        }

        @Override
        public String code() {
            return code;
        }

        public String kundenwort() {
            return kundenwort;
        }

        public static Umfang vonCode(String code) {
            return RechteAbleitung.vonCode(Umfang.class, code);
        }
    }

    /**
     * Wer anfragt: ein Benutzer des Kundenbereichs, ein Partner-Konto (Installateur, E7) oder ein
     * VoltPilot-Konto. Partner und VoltPilot sind KEINE Benutzer des Kundenbereichs — er existiert
     * für sie nur über eine wirksame Unterstützung.
     */
    public enum Konto implements Code {
        BENUTZER("benutzer"),
        PARTNER("partner"),
        PLATTFORM("plattform");

        private final String code;

        Konto(String code) {
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }

        public static Konto vonCode(String code) {
            return RechteAbleitung.vonCode(Konto.class, code);
        }
    }

    /** Der Zustand des Kontos (§4.8): nur ein aktives Konto hat Rechte. */
    public enum KontoZustand implements Code {
        ANGELEGT("angelegt"),
        AKTIV("aktiv"),
        GESPERRT("gesperrt"),
        ENTFERNT("entfernt");

        private final String code;

        KontoZustand(String code) {
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }

        public static KontoZustand vonCode(String code) {
            return RechteAbleitung.vonCode(KontoZustand.class, code);
        }
    }

    /** Die Art einer Unterstützung (§4.6, E8). */
    public enum Art implements Code {
        INSTALLATEUR("installateur"),
        VOLTPILOT("voltpilot"),
        NOTFALL("notfall");

        private final String code;

        Art(String code) {
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }

        public static Art vonCode(String code) {
            return RechteAbleitung.vonCode(Art.class, code);
        }
    }

    /** Die OCPP-Stufen aus {@code OcppActionPolicy}, AUFSTEIGEND — künftig aus der Zuweisung (E13). */
    public enum OcppStufe implements Code {
        KEINE("keine"),
        CUSTOMER("CUSTOMER"),
        SITE_ADMIN("SITE_ADMIN"),
        PLATFORM("PLATFORM");

        private final String code;

        OcppStufe(String code) {
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }

        public static OcppStufe vonCode(String code) {
            return RechteAbleitung.vonCode(OcppStufe.class, code);
        }
    }

    /** Der Zustand einer Unterstützung (§4.8) — eine Unterstützung wird beendet, nie angehalten. */
    public enum UnterstuetzungsZustand implements Code {
        ENTWURF("entwurf"),
        EINGERICHTET("eingerichtet"),
        AKTIV("aktiv"),
        ARCHIVIERT("archiviert");

        private final String code;

        UnterstuetzungsZustand(String code) {
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }

        public static UnterstuetzungsZustand vonCode(String code) {
            return RechteAbleitung.vonCode(UnterstuetzungsZustand.class, code);
        }
    }

    /** Was an einer Zuweisung geändert wird (§4.7, §5.2). */
    public enum AenderungsArt implements Code {
        ZUWEISEN("zuweisen"),
        ENTZIEHEN("entziehen"),
        SPERREN("sperren"),
        ENTFERNEN("entfernen");

        private final String code;

        AenderungsArt(String code) {
            this.code = code;
        }

        @Override
        public String code() {
            return code;
        }

        public static AenderungsArt vonCode(String code) {
            return RechteAbleitung.vonCode(AenderungsArt.class, code);
        }
    }

    /** Das Grund-Vokabular — die Fehlerkörper des API (§6.2) plus „erlaubt“. */
    public enum Grund implements Code {
        ERLAUBT("erlaubt", 200),
        RECHT_FEHLT("recht_fehlt", 403),
        AUSSERHALB_GELTUNGSBEREICH("ausserhalb_geltungsbereich", 404),
        ZUGRIFF_BEENDET("zugriff_beendet", 404),
        KONTO_NICHT_AKTIV("konto_nicht_aktiv", 401),
        EIGENE_ZUWEISUNG("eigene_zuweisung", 409),
        LETZTER_KUNDENADMINISTRATOR("letzter_kundenadministrator", 409),
        STANDORT_FEHLT("standort_fehlt", 422),
        HOECHSTENS_12_MONATE("hoechstens_12_monate", 422),
        GRUND_FEHLT("grund_fehlt", 422),
        ZWEITE_PERSON_NOETIG("zweite_person_noetig", 403);

        private final String code;
        private final int http;

        Grund(String code, int http) {
            this.code = code;
            this.http = http;
        }

        @Override
        public String code() {
            return code;
        }

        public int http() {
            return http;
        }

        public static Grund vonCode(String code) {
            return RechteAbleitung.vonCode(Grund.class, code);
        }
    }

    /**
     * Die Kundensätze als Vorlagen ({@code {…}} wird eingesetzt) — dieselben stehen im Block
     * {@code texte} der Vektor-Datei; beide Zwillinge prüfen sie dagegen.
     */
    public static final Map<String, String> TEXTE = texte();

    private static Map<String, String> texte() {
        Map<String, String> t = new LinkedHashMap<>();
        t.put("recht_fehlt", "Dafür fehlt Ihnen das Recht.");
        t.put("weg_ein_kundenadministrator", "Ihr Kundenadministrator: {namen}.");
        t.put("weg_kundenadministratoren", "Ihre Kundenadministratoren: {namen}.");
        t.put("weg_voltpilot", "Das übernimmt VoltPilot.");
        t.put("ausserhalb_geltungsbereich", "Diese Seite gibt es für Sie nicht.");
        t.put("zugriff_beendet", "Ihr Zugriff auf {standort} wurde beendet.");
        t.put("unterstuetzung_beendet", "Ihre Unterstützung für {kundenbereich} ist beendet.");
        t.put("kein_standort", "Ihnen ist derzeit kein Standort zugewiesen.");
        t.put("kein_standort_ein_weg", "Ihr Kundenadministrator {namen} kann das ändern.");
        t.put("kein_standort_wege", "Ihre Kundenadministratoren {namen} können das ändern.");
        t.put("wirkt_ab", "Wirkt ab {datum}");
        t.put("teilansicht", "Teilansicht: {n} von {m} Standorten");
        t.put("teilansicht_export", "Teilansicht: {namen} ({n} von {m} Standorten)");
        t.put("standortuebergreifend", "umfasst Standorte außerhalb Ihres Zugriffs");
        t.put("banner_installateur", "{anzeigename} (Installateur) hat Zugriff auf {standorte} bis {ende} — {umfang}");
        t.put("banner_voltpilot", "VoltPilot-Support hat Zugriff auf {standorte} bis {ende} — {umfang}");
        t.put("banner_notfall", "VoltPilot-Support hat Notfall-Zugriff auf {standorte} bis {ende} — Grund: {grund}");
        t.put("banner_unterstuetzer", "Sie arbeiten im Kundenbereich {kundenbereich} · {standorte} · bis {ende}");
        t.put("urheber_installateur", "{anzeigename} (Unterstützung)");
        t.put("urheber_voltpilot", "VoltPilot-Support (Unterstützung)");
        t.put("urheber_notfall", "VoltPilot (Notfall-Zugriff)");
        t.put("endete_zeitablauf", "Endete am {datum} durch Zeitablauf");
        t.put("beendet", "Beendet am {datum}");
        t.put("beendet_von", "Beendet am {datum} durch {name}");
        t.put("gesetzt_von", "gesetzt von {urheber}");
        t.put("bedienrecht_beendet", "gesetzt von {urheber} (Bedienrecht beendet am {zeitpunkt})");
        t.put("hoechstens_12_monate", "Eine Unterstützung ist höchstens 12 Monate gültig. Sie können sie jederzeit verlängern.");
        t.put("standort_fehlt", "Wählen Sie mindestens einen Standort.");
        t.put("grund_fehlt", "Für einen Notfall-Zugriff ist ein Grund Pflicht.");
        t.put("letzter_kundenadministrator", "{kundenbereich} braucht mindestens einen Kundenadministrator. Ernennen Sie zuerst eine weitere Person.");
        t.put("zweite_person", "Freigabe durch eine zweite Person.");
        return Map.copyOf(t);
    }

    private static String text(String schluessel, String... paare) {
        String s = TEXTE.get(schluessel);
        for (int i = 0; i < paare.length; i += 2) {
            s = s.replace("{" + paare[i] + "}", paare[i + 1]);
        }
        return s;
    }

    // ------------------------------------------------------------------- Matrix

    /** Eine Zeile der Matrix: Kennung, Wortlaut und je Rolle der Zellen-Code. */
    public record Aktion(String kennung, String kundenwort, Map<Rolle, Zelle> zellen) {
        public Zelle zelle(Rolle r) {
            return zellen.get(r);
        }

        /** Eine Zeile, die JEDE Rolle mit E trägt, betrifft nur das eigene Konto. */
        boolean eigenesKonto() {
            return zellen.values().stream().allMatch(z -> z == Zelle.E);
        }
    }

    /** Die Rechte-Matrix als Daten. */
    public record Matrix(Map<String, Aktion> aktionen) {
        public Aktion aktion(String kennung) {
            Aktion a = aktionen.get(kennung);
            if (a == null) {
                throw new IllegalArgumentException("unbekannte Aktion: " + kennung);
            }
            return a;
        }
    }

    /** Liest {@code rechte-matrix.json} (schon geparst) — rein, ohne Datei-Zugriff. */
    public static Matrix matrix(JsonNode datei) {
        Map<String, Aktion> aktionen = new LinkedHashMap<>();
        for (JsonNode a : datei.path("aktionen")) {
            Map<Rolle, Zelle> zellen = new EnumMap<>(Rolle.class);
            a.path("zellen").fields().forEachRemaining(
                    e -> zellen.put(Rolle.vonCode(e.getKey()), Zelle.vonCode(e.getValue().asText())));
            if (zellen.size() != Rolle.values().length) {
                throw new IllegalArgumentException("Zeile ohne alle sieben Rollen: " + a.path("kennung"));
            }
            String kennung = a.path("kennung").asText();
            aktionen.put(kennung, new Aktion(kennung, a.path("kundenwort").asText(), Map.copyOf(zellen)));
        }
        return new Matrix(Map.copyOf(aktionen));
    }

    // ---------------------------------------------------------------- Eingänge

    /**
     * Benutzer × Rolle × Geltungsbereich × Gültigkeit (§4.1). {@code standorte == null} heißt
     * Unternehmen (alle Standorte, auch künftige); sonst die ausdrückliche Liste (E5). Eine
     * Unterstützung ist eine Zuweisung der Rolle Unterstützer mit Umfang und Art. Zeit: ab
     * {@code gueltigAb} (Zeitpunkt) bis zum Ende von {@code gueltigBis} und bis {@code beendetAm}
     * (ausschließend). {@code gueltigBis} ist das ENDDATUM einer Unterstützung — ein Kalendertag,
     * einschließlich ({@link #bisZeitpunkt(String)}); nur der Notfall-Zugriff trägt einen Zeitpunkt.
     */
    public record Zuweisung(
            Rolle rolle,
            List<String> standorte,
            Umfang umfang,
            Art art,
            Instant gueltigAb,
            String gueltigBis,
            Instant beendetAm) {

        public boolean unternehmensweit() {
            return standorte == null;
        }

        boolean deckt(String standort) {
            return standorte == null || standorte.contains(standort);
        }

        public boolean wirksam(Instant t) {
            Instant bis = bisZeitpunkt(gueltigBis);
            return !t.isBefore(gueltigAb)
                    && (bis == null || t.isBefore(bis))
                    && (beendetAm == null || t.isBefore(beendetAm));
        }

        /** Beendet oder abgelaufen — war also einmal wirksam oder hätte es sein sollen. */
        boolean vorbei(Instant t) {
            Instant bis = bisZeitpunkt(gueltigBis);
            return (bis != null && !t.isBefore(bis))
                    || (beendetAm != null && !t.isBefore(beendetAm));
        }

        boolean kuenftig(Instant t) {
            return t.isBefore(gueltigAb) && (beendetAm == null || beendetAm.isAfter(gueltigAb));
        }

        /** Das tatsächliche Ende: das frühere von Enddatum und Beenden. */
        Instant ende() {
            Instant bis = bisZeitpunkt(gueltigBis);
            if (beendetAm != null && (bis == null || beendetAm.isBefore(bis))) {
                return beendetAm;
            }
            return bis;
        }
    }

    /**
     * Das Ende einer Gültigkeit als Zeitpunkt (ausschließend). Ein Enddatum (JJJJ-MM-TT) ist ein
     * Kalendertag und gilt EINSCHLIESSLICH: „bis 15.12.2026“ endet am 16.12.2026 um 00:00 in der
     * Zeitzone des Kundenbereichs (AP-03 A4, wie jede tagesgenaue Gültigkeit — AP-02 E9). Nur der
     * Notfall-Zugriff (E8) trägt einen Zeitpunkt: genau 24 h, halboffen.
     */
    public static Instant bisZeitpunkt(String gueltigBis) {
        if (gueltigBis == null) {
            return null;
        }
        return istTag(gueltigBis)
                ? LocalDate.parse(gueltigBis).plusDays(1).atStartOfDay(zone(null)).toInstant()
                : OffsetDateTime.parse(gueltigBis).toInstant();
    }

    private static boolean istTag(String s) {
        return s.length() == 10 && s.charAt(4) == '-' && s.charAt(7) == '-';
    }

    /** Der Anfragende mit seinen Zuweisungen (wirksame, künftige und beendete). */
    public record Benutzer(
            String kennung, String name, Konto konto, KontoZustand zustand, List<Zuweisung> zuweisungen) {}

    public record Standort(String kennzeichen, String name) {}

    public record Person(String kennung, String name) {}

    /**
     * Der Kundenbereich zur Anfragezeit: seine Standorte (m) und seine Kundenadministratoren — sie
     * nennt jeder Grund als Weg (Invariante 13, §5.9).
     */
    public record Kundenbereich(String name, List<Standort> standorte, List<Person> kundenadministratoren) {
        Standort standort(String kennzeichen) {
            for (Standort s : standorte) {
                if (s.kennzeichen().equals(kennzeichen)) {
                    return s;
                }
            }
            return null;
        }

        String standortName(String kennzeichen) {
            Standort s = standort(kennzeichen);
            return s == null ? kennzeichen : s.name();
        }
    }

    /**
     * Die Zuordnung einer Anlage zu einem Standort, tagesgenau (AP-02 E9, wie der
     * Ortsbaum-Vertrag): {@code gueltigAb} ist ein Tag, {@code gueltigBis} der LETZTE
     * gültige Tag, einschließlich ({@code null} = offen).
     */
    public record AnlageStandort(String standort, LocalDate gueltigAb, LocalDate gueltigBis) {}

    public record Anlage(String kennzeichen, List<AnlageStandort> zuordnungen) {
        /**
         * Der Standort zum Stichtag — an dessen Kalendertag in der Zeitzone des
         * Kundenbereichs; {@code null}, wenn die Anlage dann keinem gehört.
         */
        public String standortAm(Instant stichtag) {
            LocalDate tag = stichtag.atZone(zone(null)).toLocalDate();
            for (AnlageStandort z : zuordnungen) {
                if (!tag.isBefore(z.gueltigAb()) && (z.gueltigBis() == null || !tag.isAfter(z.gueltigBis()))) {
                    return z.standort();
                }
            }
            return null;
        }
    }

    /**
     * Worauf eine Aktion zielt: das Unternehmen, einen Standort oder eine Anlage zu einem Stichtag
     * ({@code null} = jetzt).
     */
    public record Ziel(String standort, Anlage anlage, Instant stichtag) {
        public static Ziel unternehmen() {
            return new Ziel(null, null, null);
        }

        public static Ziel standort(String kennzeichen) {
            return new Ziel(kennzeichen, null, null);
        }

        public static Ziel anlage(Anlage anlage, Instant stichtag) {
            return new Ziel(null, anlage, stichtag);
        }

        boolean aufStandort() {
            return standort != null || anlage != null;
        }
    }

    // --------------------------------------------------------------------- darf

    /**
     * Das Ergebnis von {@link #darf}: {@code sichtbar} heißt „nicht 404/401“; {@code rolle} ist die
     * Rolle, die das Recht gibt (Spaltenreihenfolge); {@code rolleNoetig} bzw. {@code umfangNoetig}
     * nennen bei 403, was fehlt; {@code text} ist der Kundensatz (§5.9).
     */
    public record DarfErgebnis(
            boolean darf,
            boolean sichtbar,
            int http,
            Grund grund,
            String standort,
            Rolle rolle,
            Rolle rolleNoetig,
            Umfang umfangNoetig,
            String text) {}

    /** darf(benutzer, aktion, ziel) zum Zeitpunkt {@code jetzt} — Geltungsbereich vor Aktion. */
    public static DarfErgebnis darf(
            Matrix m, Benutzer b, Kundenbereich k, String aktion, Ziel ziel, Instant jetzt) {
        Aktion a = m.aktion(aktion);
        if (b.zustand() != KontoZustand.AKTIV) {
            return new DarfErgebnis(false, false, 401, Grund.KONTO_NICHT_AKTIV, null, null, null, null, null);
        }
        if (a.eigenesKonto()) {
            return erlaubt(null, null);
        }
        String standort = ziel.anlage() != null
                ? ziel.anlage().standortAm(ziel.stichtag() != null ? ziel.stichtag() : jetzt)
                : ziel.standort();
        if (b.konto() == Konto.PLATTFORM && a.zelle(Rolle.VOLTPILOT_BETRIEB) == Zelle.P) {
            return erlaubt(standort, Rolle.VOLTPILOT_BETRIEB);
        }
        List<Zuweisung> wirksam = wirksame(b, jetzt);
        boolean dritter = b.konto() != Konto.BENUTZER;

        DarfErgebnis ausserhalb = geltungsbereichPruefen(b, k, ziel, standort, wirksam, dritter, jetzt);
        if (ausserhalb != null) {
            return ausserhalb;
        }
        for (Rolle r : Rolle.values()) {
            for (Zuweisung z : wirksam) {
                if (z.rolle() == r && gewaehrt(a.zelle(r), z, standort)) {
                    return erlaubt(standort, r);
                }
            }
        }
        Rolle noetig = null;
        Umfang umfangNoetig = null;
        if (dritter) {
            umfangNoetig = standort == null ? null : umfangFuer(a.zelle(Rolle.UNTERSTUETZER));
        } else {
            for (Rolle r : ROLLE_NOETIG_REIHENFOLGE) {
                Zelle c = a.zelle(r);
                boolean haette = r == Rolle.VOLTPILOT_BETRIEB
                        ? c == Zelle.P
                        : c == Zelle.U || (c == Zelle.S && standort != null);
                if (haette) {
                    noetig = r;
                    break;
                }
            }
        }
        String weg = noetig == Rolle.VOLTPILOT_BETRIEB
                ? TEXTE.get("weg_voltpilot")
                : wegZumKundenadministrator(k);
        String satz = TEXTE.get("recht_fehlt") + (weg == null ? "" : " " + weg);
        return new DarfErgebnis(
                false, true, 403, Grund.RECHT_FEHLT, standort, null, noetig, umfangNoetig, satz);
    }

    /** 404, wenn das Ziel außerhalb des Geltungsbereichs liegt; sonst {@code null}. */
    private static DarfErgebnis geltungsbereichPruefen(
            Benutzer b,
            Kundenbereich k,
            Ziel ziel,
            String standort,
            List<Zuweisung> wirksam,
            boolean dritter,
            Instant jetzt) {
        if (!ziel.aufStandort()) {
            // Das Unternehmen: für einen Benutzer des Kundenbereichs immer im Geltungsbereich;
            // Partner und VoltPilot erreichen den Kundenbereich nur über eine Unterstützung.
            if (!dritter || !wirksam.isEmpty()) {
                return null;
            }
            boolean warDa = b.zuweisungen().stream().anyMatch(z -> z.vorbei(jetzt));
            return warDa ? beendet(null, text("unterstuetzung_beendet", "kundenbereich", k.name())) : ausserhalb();
        }
        if (standort == null) {
            // Eine Anlage ohne Standort zum Stichtag sehen nur unternehmensweite Rollen (IP-5).
            return wirksam.stream().anyMatch(Zuweisung::unternehmensweit) ? null : ausserhalb();
        }
        if (k.standort(standort) == null) {
            return ausserhalb();
        }
        if (wirksam.stream().anyMatch(z -> z.deckt(standort))) {
            return null;
        }
        boolean warDa = b.zuweisungen().stream().anyMatch(z -> z.vorbei(jetzt) && z.deckt(standort));
        if (!warDa) {
            return ausserhalb();
        }
        String satz = dritter && wirksam.isEmpty()
                ? text("unterstuetzung_beendet", "kundenbereich", k.name())
                : text("zugriff_beendet", "standort", k.standortName(standort));
        return beendet(standort, satz);
    }

    private static DarfErgebnis erlaubt(String standort, Rolle rolle) {
        return new DarfErgebnis(true, true, 200, Grund.ERLAUBT, standort, rolle, null, null, null);
    }

    /** Außerhalb: die Existenz wird nie bestätigt — auch der Standort steht nicht im Ergebnis. */
    private static DarfErgebnis ausserhalb() {
        return new DarfErgebnis(
                false, false, 404, Grund.AUSSERHALB_GELTUNGSBEREICH, null, null, null, null,
                TEXTE.get("ausserhalb_geltungsbereich"));
    }

    private static DarfErgebnis beendet(String standort, String satz) {
        return new DarfErgebnis(
                false, false, 404, Grund.ZUGRIFF_BEENDET, standort, null, null, null, satz);
    }

    private static List<Zuweisung> wirksame(Benutzer b, Instant jetzt) {
        return b.zuweisungen().stream().filter(z -> z.wirksam(jetzt)).toList();
    }

    /**
     * Gibt die Zelle dieser Zuweisung das Recht am Ziel? U = unternehmensweit, S = je
     * zugewiesenem Standort, A/Ei/B = Unterstützung mit mindestens diesem Umfang am Standort.
     */
    private static boolean gewaehrt(Zelle c, Zuweisung z, String standort) {
        return switch (c) {
            case U -> z.unternehmensweit();
            case S -> standort != null && z.standorte() != null && z.standorte().contains(standort);
            case A, EI, B -> z.rolle() == Rolle.UNTERSTUETZER
                    && standort != null
                    && z.standorte() != null
                    && z.standorte().contains(standort)
                    && z.umfang() != null
                    && z.umfang().compareTo(umfangFuer(c)) >= 0;
            case E, P, NEIN -> false;
        };
    }

    private static Umfang umfangFuer(Zelle c) {
        return switch (c) {
            case A -> Umfang.ANSEHEN;
            case EI -> Umfang.EINRICHTEN;
            case B -> Umfang.EINRICHTEN_UND_BEDIENEN;
            default -> null;
        };
    }

    /** „Ihr Kundenadministrator: Jonas Wendlinger.“ — ohne bekannten Namen kein Weg-Satz. */
    private static String wegZumKundenadministrator(Kundenbereich k) {
        List<String> namen = k.kundenadministratoren().stream().map(Person::name).toList();
        if (namen.isEmpty()) {
            return null;
        }
        return text(
                namen.size() == 1 ? "weg_ein_kundenadministrator" : "weg_kundenadministratoren",
                "namen", ZustandAbleitung.aufzaehlung(namen));
    }

    // ------------------------------------------------------- Vier-Augen (AP-08 E8)

    /** Die Aktion, die eine Korrektur wirksam macht (AP-08 §4.8, E8). */
    public static final String KORREKTUR_FREIGEBEN = "korrektur.freigeben";

    /** Die Aktion, die eine freigegebene Korrektur widerruft (AP-08 §5). */
    public static final String KORREKTUR_ZURUECKNEHMEN = "korrektur.zuruecknehmen";

    /**
     * Darf {@code b} diese Korrektur freigeben oder zurücknehmen? (AP-08 E8, IP-15 — Familie
     * {@code vieraugen}.) Erst {@link #darf} — was dort nicht erlaubt ist, bleibt, wie es ist
     * (404 vor 403; der Unterstützer bekommt immer {@code recht_fehlt}). Dann die Bedingungen,
     * die keine Zelle tragen kann:
     * <ul>
     *   <li>der Bearbeiter gibt nur bei Vier-Augen aus frei (W10) und nimmt nur bei aus und nur die
     *       eigene zurück (§5) — sonst 403 {@code recht_fehlt} mit {@code rolle_noetig}
     *       Energiemanager;</li>
     *   <li>bei Vier-Augen an gibt nie der Ersteller frei — auch mit Recht, auch als
     *       Kundenadministrator: 403 {@code zweite_person_noetig}.</li>
     * </ul>
     *
     * @param ersteller die Kennung der Person, die die Korrektur angelegt hat; {@code null} = ein
     *     Vorschlag des Systems (E14), der von keiner Person stammt
     * @param vierAugen die Einstellung des Unternehmens zum Zeitpunkt DIESER Entscheidung
     */
    public static DarfErgebnis korrekturEntscheiden(
            Matrix m, Benutzer b, Kundenbereich k, String aktion, Ziel ziel, Instant jetzt,
            String ersteller, boolean vierAugen) {
        boolean freigeben = KORREKTUR_FREIGEBEN.equals(aktion);
        if (!freigeben && !KORREKTUR_ZURUECKNEHMEN.equals(aktion)) {
            throw new IllegalArgumentException("keine Entscheidung über eine Korrektur: " + aktion);
        }
        DarfErgebnis d = darf(m, b, k, aktion, ziel, jetzt);
        if (!d.darf()) {
            return d;
        }
        boolean eigene = ersteller != null && ersteller.equals(b.kennung());
        if (d.rolle() == Rolle.BEARBEITER && (vierAugen || (!freigeben && !eigene))) {
            String weg = wegZumKundenadministrator(k);
            return new DarfErgebnis(false, true, 403, Grund.RECHT_FEHLT, d.standort(), null,
                    Rolle.ENERGIEMANAGER, null, TEXTE.get("recht_fehlt") + (weg == null ? "" : " " + weg));
        }
        if (freigeben && vierAugen && eigene) {
            String weg = wegZumKundenadministrator(new Kundenbereich(k.name(), k.standorte(),
                    k.kundenadministratoren().stream().filter(p -> !p.kennung().equals(b.kennung())).toList()));
            return new DarfErgebnis(false, true, 403, Grund.ZWEITE_PERSON_NOETIG, d.standort(), null, null, null,
                    TEXTE.get("zweite_person") + (weg == null ? "" : " " + weg));
        }
        return d;
    }

    // -------------------------------------------------------- sichtbare Standorte

    /** Ein sichtbarer Standort mit den Rollen, die dort wirken, und dem Unterstützungs-Umfang. */
    public record StandortSicht(String kennzeichen, String name, List<Rolle> rollen, Umfang umfang) {}

    /** Ein Standort, dessen Zuweisung erst später wirkt (§4.8 „eingerichtet“). */
    public record Kuenftig(String standort, Instant ab, String text) {}

    public record SichtErgebnis(
            List<StandortSicht> standorte,
            boolean unternehmensweit,
            List<Kuenftig> kuenftig,
            String text,
            TeilansichtErgebnis teilansicht) {}

    /** sichtbareStandorte(benutzer) zum Zeitpunkt {@code jetzt} — die Menge, über die alles läuft. */
    public static SichtErgebnis sichtbareStandorte(
            Benutzer b, Kundenbereich k, Instant jetzt, ZoneId zone) {
        int gesamt = k.standorte().size();
        if (b.zustand() != KontoZustand.AKTIV) {
            return new SichtErgebnis(List.of(), false, List.of(), null, teilansicht(List.of(), gesamt, false));
        }
        List<Zuweisung> wirksam = wirksame(b, jetzt);
        boolean unternehmensweit = wirksam.stream().anyMatch(Zuweisung::unternehmensweit);
        List<StandortSicht> sichtbar = new ArrayList<>();
        List<Kuenftig> kuenftig = new ArrayList<>();
        for (Standort s : k.standorte()) {
            List<Rolle> rollen = new ArrayList<>();
            Umfang umfang = null;
            for (Rolle r : Rolle.values()) {
                for (Zuweisung z : wirksam) {
                    if (z.rolle() == r && z.deckt(s.kennzeichen())) {
                        if (!rollen.contains(r)) {
                            rollen.add(r);
                        }
                        if (z.umfang() != null && (umfang == null || z.umfang().compareTo(umfang) > 0)) {
                            umfang = z.umfang();
                        }
                    }
                }
            }
            if (!rollen.isEmpty()) {
                sichtbar.add(new StandortSicht(s.kennzeichen(), s.name(), List.copyOf(rollen), umfang));
                continue;
            }
            if (b.konto() != Konto.BENUTZER) {
                continue; // Dritte sehen den Kundenbereich erst mit einer wirksamen Unterstützung (§4.6)
            }
            Instant ab = null;
            for (Zuweisung z : b.zuweisungen()) {
                if (z.kuenftig(jetzt) && z.deckt(s.kennzeichen())
                        && (ab == null || z.gueltigAb().isBefore(ab))) {
                    ab = z.gueltigAb();
                }
            }
            if (ab != null) {
                kuenftig.add(new Kuenftig(s.kennzeichen(), ab, text("wirkt_ab", "datum", datum(ab, zone))));
            }
        }
        String satz = null;
        if (sichtbar.isEmpty() && b.konto() == Konto.BENUTZER) {
            satz = TEXTE.get("kein_standort");
            List<String> namen = k.kundenadministratoren().stream().map(Person::name).toList();
            if (!namen.isEmpty()) {
                satz += " " + text(
                        namen.size() == 1 ? "kein_standort_ein_weg" : "kein_standort_wege",
                        "namen", ZustandAbleitung.aufzaehlung(namen));
            }
        }
        List<String> namen = sichtbar.stream().map(StandortSicht::name).toList();
        return new SichtErgebnis(
                List.copyOf(sichtbar),
                unternehmensweit,
                List.copyOf(kuenftig),
                satz,
                teilansicht(namen, gesamt, unternehmensweit));
    }

    // ---------------------------------------------------------------- Teilansicht

    /**
     * Das Ergebnis der Teilansicht-Regel (E10): die Unternehmensebene gibt es ab zwei
     * zugänglichen Standorten; mit weniger als allen ist sie eine Teilansicht. Unternehmensweite
     * Objekte (Kennzahlen, Berichte, Exporte mit Geltungsbereich Unternehmen) sehen nur
     * unternehmensweite Rollen (R-A1).
     */
    public record TeilansichtErgebnis(
            int sichtbar,
            int gesamt,
            boolean unternehmensebene,
            boolean teilansicht,
            String kopfzeile,
            String exportKopfzeile,
            boolean unternehmensweiteObjekte) {}

    /** teilansicht(n, m) — {@code namen} sind die n sichtbaren Standorte in Anzeige-Reihenfolge. */
    public static TeilansichtErgebnis teilansicht(List<String> namen, int gesamt, boolean unternehmensweit) {
        int n = namen.size();
        boolean ebene = n >= 2;
        boolean teil = ebene && n < gesamt;
        String nn = Integer.toString(n);
        String mm = Integer.toString(gesamt);
        return new TeilansichtErgebnis(
                n,
                gesamt,
                ebene,
                teil,
                teil ? text("teilansicht", "n", nn, "m", mm) : null,
                teil ? text("teilansicht_export", "namen", String.join(", ", namen), "n", nn, "m", mm) : null,
                unternehmensweit);
    }

    /** Ein Wert je Messstelle mit ihrem Standort — {@code kwh == null} heißt „nicht gemessen“. */
    public record Wert(String messstelle, String standort, BigDecimal kwh) {}

    /** Die Antwortform einer Summe (R-A2): der Wert und {@code teilansicht {sichtbar, gesamt}}. */
    public record SummeErgebnis(BigDecimal kwh, List<String> messstellen, int sichtbar, int gesamt) {}

    /**
     * Summiert NUR über die sichtbaren Standorte (R-A2). Fehlt ein Eingang, fehlt die Summe ganz —
     * nie eine Teilsumme, nie „Rest“ (R-A3, null ≠ 0).
     */
    public static SummeErgebnis summe(List<Wert> werte, List<String> sichtbar, int gesamt) {
        List<String> messstellen = new ArrayList<>();
        BigDecimal kwh = BigDecimal.ZERO;
        boolean luecke = false;
        for (Wert w : werte) {
            if (!sichtbar.contains(w.standort())) {
                continue;
            }
            messstellen.add(w.messstelle());
            if (w.kwh() == null) {
                luecke = true;
            } else {
                kwh = kwh.add(w.kwh());
            }
        }
        return new SummeErgebnis(
                luecke || messstellen.isEmpty() ? null : kwh, List.copyOf(messstellen), sichtbar.size(), gesamt);
    }

    /** Der Geltungsbereich eines Objekts: das Unternehmen oder eine Liste von Standorten. */
    public record Geltungsbereich(boolean unternehmen, List<String> standorte) {}

    public record GeltungErgebnis(boolean sichtbar, String hinweis) {}

    /**
     * R-A1/R-A5/R-A6: sichtbar, wenn der Geltungsbereich VOLLSTÄNDIG im Zugriff liegt; ein
     * Unternehmens-Objekt nur für unternehmensweite Rollen. Ein Objekt, das sichtbare UND fremde
     * Standorte umfasst, fehlt mit dem Hinweis — ohne Namen, ohne Wert, nie teilgerechnet.
     */
    public static GeltungErgebnis geltungsbereich(
            Geltungsbereich g, List<String> sichtbar, boolean unternehmensweit) {
        if (unternehmensweit) {
            return new GeltungErgebnis(true, null);
        }
        if (g.unternehmen()) {
            return new GeltungErgebnis(false, null);
        }
        long drin = g.standorte().stream().filter(sichtbar::contains).count();
        if (drin == g.standorte().size()) {
            return new GeltungErgebnis(true, null);
        }
        return new GeltungErgebnis(false, drin > 0 ? TEXTE.get("standortuebergreifend") : null);
    }

    // ---------------------------------------------------------------- OCPP-Stufe

    public record OcppErgebnis(OcppStufe stufe, boolean sichtbar, Rolle rolle) {}

    /**
     * Die OCPP-Stufe an einem Standort AUS DER ZUWEISUNG (E13, Wortlaut): CUSTOMER =
     * Bedienberechtigt/Unterstützer-Bedienen, SITE_ADMIN = Kundenadministrator/Bedienberechtigt
     * je E4, PLATFORM = VoltPilot. Die Realm-Rollen {@code site-admin}/{@code admin} bedeuten
     * nichts mehr; Energiemanager, Bearbeiter und Leser haben keine Stufe (Achsentrennung).
     */
    public static OcppErgebnis ocppStufe(Benutzer b, Kundenbereich k, String standort, Instant jetzt) {
        if (b.zustand() != KontoZustand.AKTIV) {
            return new OcppErgebnis(OcppStufe.KEINE, false, null);
        }
        if (b.konto() == Konto.PLATTFORM) {
            return new OcppErgebnis(OcppStufe.PLATFORM, true, Rolle.VOLTPILOT_BETRIEB);
        }
        List<Zuweisung> hier = wirksame(b, jetzt).stream().filter(z -> z.deckt(standort)).toList();
        if (k.standort(standort) == null || hier.isEmpty()) {
            return new OcppErgebnis(OcppStufe.KEINE, false, null);
        }
        for (Rolle r : List.of(Rolle.KUNDENADMINISTRATOR, Rolle.BEDIENBERECHTIGT)) {
            if (hier.stream().anyMatch(z -> z.rolle() == r)) {
                return new OcppErgebnis(OcppStufe.SITE_ADMIN, true, r);
            }
        }
        if (hier.stream().anyMatch(z -> z.rolle() == Rolle.UNTERSTUETZER
                && z.umfang() == Umfang.EINRICHTEN_UND_BEDIENEN)) {
            return new OcppErgebnis(OcppStufe.CUSTOMER, true, Rolle.UNTERSTUETZER);
        }
        return new OcppErgebnis(OcppStufe.KEINE, true, null);
    }

    // ------------------------------------------------------------ Unterstützung

    /** Das Partner- oder VoltPilot-Konto hinter einer Unterstützung. */
    public record Unterstuetzer(String name, String organisation, String anzeigename) {}

    /** Eine gewährte (oder nur angefragte: {@code gewaehrtAm == null}) Unterstützung (§4.6). */
    public record Unterstuetzung(
            Art art,
            Umfang umfang,
            List<String> standorte,
            Instant gewaehrtAm,
            Instant gueltigAb,
            String gueltigBis,
            Instant beendetAm,
            String beendetVon,
            Unterstuetzer unterstuetzer,
            String grund) {}

    public record UnterstuetzungErgebnis(
            UnterstuetzungsZustand zustand,
            Instant endet,
            String beendetDurch,
            String bannerKunde,
            String bannerUnterstuetzer,
            String urheber,
            boolean erinnerung,
            String text) {}

    /**
     * Zustand, Banner und Urheber einer Unterstützung zum Zeitpunkt {@code jetzt} (§4.6–§4.8):
     * Anfrage → entwurf · gewährt, „gültig ab“ in der Zukunft → eingerichtet · gültig → aktiv
     * (Banner für Kunde und Unterstützer, Erinnerung 7 Tage vor dem Ende) · beendet oder
     * abgelaufen → archiviert.
     */
    public static UnterstuetzungErgebnis unterstuetzung(
            Unterstuetzung u, Kundenbereich k, Instant jetzt, ZoneId zone) {
        String anzeigename = u.unterstuetzer() == null ? "" : u.unterstuetzer().anzeigename();
        String urheber = switch (u.art()) {
            case INSTALLATEUR -> text("urheber_installateur", "anzeigename", anzeigename);
            case VOLTPILOT -> TEXTE.get("urheber_voltpilot");
            case NOTFALL -> TEXTE.get("urheber_notfall");
        };
        Instant ablauf = bisZeitpunkt(u.gueltigBis());
        boolean vorzeitig = u.beendetAm() != null && (ablauf == null || u.beendetAm().isBefore(ablauf));
        Instant endet = vorzeitig ? u.beendetAm() : ablauf;
        // In Kundensprache heißt das Ende einer Unterstützung ihr Enddatum („15.12.2026“); nur der
        // Notfall-Zugriff nennt seinen Zeitpunkt („19.11.2026 22:15“).
        String enddatum = u.gueltigBis() != null && istTag(u.gueltigBis())
                ? DATUM.format(LocalDate.parse(u.gueltigBis())) : null;
        if (u.gewaehrtAm() == null) {
            return new UnterstuetzungErgebnis(
                    UnterstuetzungsZustand.ENTWURF, endet, null, null, null, urheber, false, null);
        }
        if (endet != null && !jetzt.isBefore(endet)) {
            String satz = vorzeitig
                    ? (u.beendetVon() == null
                            ? text("beendet", "datum", datum(endet, zone))
                            : text("beendet_von", "datum", datum(endet, zone), "name", u.beendetVon()))
                    : text("endete_zeitablauf", "datum", enddatum != null ? enddatum : datum(endet, zone));
            return new UnterstuetzungErgebnis(
                    UnterstuetzungsZustand.ARCHIVIERT,
                    endet,
                    vorzeitig ? "kundenadministrator" : "zeitablauf",
                    null,
                    null,
                    urheber,
                    false,
                    satz);
        }
        if (jetzt.isBefore(u.gueltigAb())) {
            return new UnterstuetzungErgebnis(
                    UnterstuetzungsZustand.EINGERICHTET, endet, null, null, null, urheber, false,
                    text("wirkt_ab", "datum", datum(u.gueltigAb(), zone)));
        }
        String standorte = ZustandAbleitung.aufzaehlung(
                u.standorte().stream().map(k::standortName).toList());
        String ende = endet == null ? "" : enddatum != null ? enddatum : endeText(endet, zone);
        String kunde = switch (u.art()) {
            case INSTALLATEUR -> text("banner_installateur", "anzeigename", anzeigename,
                    "standorte", standorte, "ende", ende, "umfang", u.umfang().kundenwort());
            case VOLTPILOT -> text("banner_voltpilot", "standorte", standorte, "ende", ende,
                    "umfang", u.umfang().kundenwort());
            case NOTFALL -> text("banner_notfall", "standorte", standorte, "ende", ende,
                    "grund", u.grund() == null ? "" : u.grund());
        };
        String selbst = text("banner_unterstuetzer", "kundenbereich", k.name(), "standorte", standorte,
                "ende", ende);
        boolean erinnerung = u.art() != Art.NOTFALL
                && endet != null
                && Duration.between(jetzt, endet).compareTo(ERINNERUNG) <= 0;
        return new UnterstuetzungErgebnis(
                UnterstuetzungsZustand.AKTIV, endet, null, kunde, selbst, urheber, erinnerung, null);
    }

    /** Ein Antrag im Gewähren-Dialog (bzw. der Notfall-Zugriff von VoltPilot). */
    public record Antrag(
            Art art, Umfang umfang, List<String> standorte, Instant gueltigAb, String gueltigBis, String grund) {}

    public record GewaehrenErgebnis(
            boolean gueltig, int http, Grund grund, String text, Umfang umfang, Instant endet) {}

    /** Die Vorgabe je Art (E9): VoltPilot „Ansehen“, Installateur „Einrichten und Bedienen“. */
    public static Umfang vorgabeUmfang(Art art) {
        return art == Art.INSTALLATEUR ? Umfang.EINRICHTEN_UND_BEDIENEN : Umfang.ANSEHEN;
    }

    /**
     * Prüft einen Antrag (E6/E8/E9, §5.9): mindestens ein Standort · Notfall mit Grund und genau
     * 24 h · sonst Enddatum Pflicht und höchstens 12 Monate · ohne Umfang die Vorgabe je Art.
     */
    public static GewaehrenErgebnis gewaehren(Antrag a, ZoneId zone) {
        if (a.standorte() == null || a.standorte().isEmpty()) {
            return abgelehnt(Grund.STANDORT_FEHLT);
        }
        Umfang umfang = a.umfang() != null ? a.umfang() : vorgabeUmfang(a.art());
        if (a.art() == Art.NOTFALL) {
            if (a.grund() == null || a.grund().isBlank()) {
                return abgelehnt(Grund.GRUND_FEHLT);
            }
            return new GewaehrenErgebnis(true, 201, Grund.ERLAUBT, null, umfang, a.gueltigAb().plus(NOTFALL));
        }
        // Das Enddatum darf höchstens 12 Kalendermonate nach dem Tag von „ab“ liegen (29.02. → 28.02.).
        LocalDate grenze = a.gueltigAb().atZone(zone(zone)).toLocalDate().plusMonths(HOECHSTENS_MONATE);
        if (a.gueltigBis() == null || LocalDate.parse(a.gueltigBis()).isAfter(grenze)) {
            return abgelehnt(Grund.HOECHSTENS_12_MONATE);
        }
        return new GewaehrenErgebnis(true, 201, Grund.ERLAUBT, null, umfang, bisZeitpunkt(a.gueltigBis()));
    }

    private static GewaehrenErgebnis abgelehnt(Grund g) {
        return new GewaehrenErgebnis(false, g.http(), g, TEXTE.get(g.code()), null, null);
    }

    // ------------------------------------------------------------------- Entzug

    /** Ein gesetzter Handeingriff: wer ihn gesetzt hat, wo und bis wann. */
    public record Handeingriff(String standort, Instant bis, String gesetztVon, Benutzer setzer) {}

    public record HandeingriffErgebnis(boolean wirkt, String etikett) {}

    /**
     * E15: ein Entzug beendet keinen Handeingriff — er wirkt bis zu seinem Ablauf, nur sein
     * Etikett ändert sich („gesetzt von Murat Demirci (Bedienrecht beendet am 14.11.2026 09:02)“).
     */
    public static HandeingriffErgebnis handeingriff(
            Matrix m, Handeingriff h, Kundenbereich k, Instant jetzt, ZoneId zone) {
        boolean wirkt = jetzt.isBefore(h.bis());
        Aktion a = m.aktion("handeingriff.setzen");
        DarfErgebnis noch = darf(m, h.setzer(), k, a.kennung(), Ziel.standort(h.standort()), jetzt);
        Instant beendet = null;
        if (!noch.darf()) {
            for (Zuweisung z : h.setzer().zuweisungen()) {
                if (z.vorbei(jetzt) && gewaehrt(a.zelle(z.rolle()), z, h.standort())
                        && (beendet == null || z.ende().isAfter(beendet))) {
                    beendet = z.ende();
                }
            }
        }
        String etikett = beendet == null
                ? text("gesetzt_von", "urheber", h.gesetztVon())
                : text("bedienrecht_beendet", "urheber", h.gesetztVon(),
                        "zeitpunkt", DATUM_ZEIT.format(beendet.atZone(zone(zone))));
        return new HandeingriffErgebnis(wirkt, etikett);
    }

    /** Eine Änderung an den Rechten einer Person (§4.7, §5.2, A8, A9). */
    public record Aenderung(AenderungsArt art, Rolle rolle, List<String> standorte) {}

    public record AenderungErgebnis(boolean erlaubt, int http, Grund grund, Rolle rolleNoetig, String text) {}

    /**
     * Darf {@code handelnder} diese Änderung an {@code betroffener} vornehmen? Erst das Recht
     * (Zuweisen/Entziehen = Rollen verwalten, Sperren/Entfernen = Benutzer verwalten), dann: nie
     * die eigenen Rechte (409), nie den letzten Kundenadministrator (409), eine Rolle je Standort
     * nie ohne Standort (422).
     */
    public static AenderungErgebnis zuweisungAendern(
            Matrix m, Benutzer handelnder, Person betroffener, Aenderung a, Kundenbereich k, Instant jetzt) {
        String aktion = a.art() == AenderungsArt.ZUWEISEN || a.art() == AenderungsArt.ENTZIEHEN
                ? "zuweisung.verwalten"
                : "benutzer.verwalten";
        DarfErgebnis d = darf(m, handelnder, k, aktion, Ziel.unternehmen(), jetzt);
        if (!d.darf()) {
            return new AenderungErgebnis(false, d.http(), d.grund(), d.rolleNoetig(), d.text());
        }
        if (handelnder.kennung().equals(betroffener.kennung())) {
            return new AenderungErgebnis(false, 409, Grund.EIGENE_ZUWEISUNG, null, null);
        }
        boolean nimmtKundenadministrator = a.art() == AenderungsArt.SPERREN
                || a.art() == AenderungsArt.ENTFERNEN
                || (a.art() == AenderungsArt.ENTZIEHEN && a.rolle() == Rolle.KUNDENADMINISTRATOR);
        boolean istKundenadministrator = k.kundenadministratoren().stream()
                .anyMatch(p -> p.kennung().equals(betroffener.kennung()));
        if (nimmtKundenadministrator && istKundenadministrator && k.kundenadministratoren().size() <= 1) {
            return new AenderungErgebnis(false, 409, Grund.LETZTER_KUNDENADMINISTRATOR, null,
                    text("letzter_kundenadministrator", "kundenbereich", k.name()));
        }
        if (a.art() == AenderungsArt.ZUWEISEN && a.rolle().jeStandort()
                && (a.standorte() == null || a.standorte().isEmpty())) {
            return new AenderungErgebnis(false, 422, Grund.STANDORT_FEHLT, null, TEXTE.get("standort_fehlt"));
        }
        return new AenderungErgebnis(true, 200, Grund.ERLAUBT, null, null);
    }

    // --------------------------------------------------------------------- Text

    /** „15.12.2026“ — das Datum in der Zeitzone des Kundenbereichs, nie in UTC. */
    public static String datum(Instant zeitpunkt, ZoneId zeitzone) {
        return DATUM.format(zeitpunkt.atZone(zone(zeitzone)));
    }

    /** Ein Enddatum um Mitternacht heißt „15.12.2026“, sonst mit Uhrzeit „19.11.2026 22:15“. */
    static String endeText(Instant ende, ZoneId zeitzone) {
        ZonedDateTime z = ende.atZone(zone(zeitzone));
        return z.toLocalTime().equals(LocalTime.MIDNIGHT) ? DATUM.format(z) : DATUM_ZEIT.format(z);
    }

    private static ZoneId zone(ZoneId zeitzone) {
        return zeitzone != null ? zeitzone : ZoneId.of("Europe/Berlin");
    }
}
