package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Die REINEN Regeln der logischen Messstelle (UEMS AP-04 IP-1, Prosa in
 * {@code docs/contracts/v2/messstelle.md}): Kennzeichen, Größen-Katalog,
 * Lebenszyklus, Quellenbindung mit Zeitstrahl und elektrische Stellung.
 *
 * <p>Ohne Spring, ohne Repository, ohne Uhr (das {@link ZustandAbleitung}-Muster)
 * — jede Regel ist ohne einen einzigen Container prüfbar. Der Zwilling im Portal
 * ist {@code frontend/portal/src/uemsMessstelle.ts}; beide fahren dieselben
 * Vektoren ({@code docs/contracts/v2/messstelle-vectors.json}).
 * <b>Wer eine Regel ändert, ändert beide Seiten und die Vektor-Datei.</b>
 *
 * <h2>Wer anruft</h2>
 *
 * {@link MessstelleService} (Kennzeichen, Größen, Lebenszyklus, IP-3) und
 * {@link MessstelleQuelleService} (Quellenbindung, Beenden, Rückwirkung, IP-13); die
 * Tabellen {@code messstelle*} und {@code messstelle_quelle} sagen dasselbe an der
 * Datenbankgrenze. Ort und Stellung (IP-7) rufen noch nicht an.
 *
 * <h2>Die Regeln, die man ohne Nachlesen braucht</h2>
 *
 * <ul>
 *   <li><b>Kennzeichen (E7):</b> automatisch {@code MS-0001} … fortlaufend je
 *       Kundenbereich, änderbar auf 2–16 Zeichen aus {@code A–Z 0–9 - . /}. Nichts
 *       wird umgewandelt — {@code ms-01} ist ein Formfehler. Belegt ist, was eine
 *       Messstelle trägt, ein archiviertes UND das frühere Kennzeichen einer
 *       umbenannten (Regel 9 „nie wiederverwendet“).
 *   <li><b>Lebenszyklus (E8, E9):</b> eine Quelle ist keine Voraussetzung;
 *       eine berechnete Messstelle bleibt ohne Formel (bis AP-10) ein Entwurf und
 *       braucht keinen Ort.
 *   <li><b>Quellenbindung (Regeln 1, 2, 5–7):</b> je Größe und Zeitpunkt höchstens
 *       EINE führende Quelle. Die einzige Änderung an Bestehendem: eine neue offene
 *       führende Quelle beendet die laufende genau zu ihrem Beginn. Lücken sind
 *       erlaubt und im Zeitstrahl ein eigener Abschnitt ohne Quelle.
 *   <li><b>Stellung (Regel 8, E12):</b> „Unterzähler von“ zeigt auf eine
 *       Messstelle derselben Anlage, nie auf sich selbst, nie im Kreis; je Anlage
 *       und Richtung höchstens ein Hauptzähler, alle an DEMSELBEN Zähler.
 * </ul>
 */
public final class MessstelleRegeln {

    /** Womit ein automatisches Kennzeichen beginnt. */
    public static final String KENNZEICHEN_PRAEFIX = "MS-";

    /** Mit wie vielen Ziffern die laufende Nummer mindestens geschrieben wird. */
    public static final int KENNZEICHEN_STELLEN = 4;

    /** Welche Zeichen ein Kennzeichen tragen darf (E7). */
    public static final String KENNZEICHEN_MUSTER = "^[A-Z0-9./-]{2,16}$";

    public static final int KENNZEICHEN_MIN_ZEICHEN = 2;
    public static final int KENNZEICHEN_MAX_ZEICHEN = 16;

    private static final Pattern KENNZEICHEN = Pattern.compile(KENNZEICHEN_MUSTER);

    /** Das geschlossene Vokabular der Medien, in dieser Reihenfolge (AP-00 E11). */
    public static final List<String> MEDIEN =
            List.of("Strom", "Gas", "Wärme", "Kälte", "Wasser", "Druckluft");

    /** Was der Anlege-Dialog im ersten Umfang anbietet. */
    public static final List<String> MEDIEN_WAEHLBAR = List.of("Strom");

    public static final List<String> LEBENSZYKLUS =
            List.of("entwurf", "eingerichtet", "aktiv", "angehalten", "archiviert");

    /** Was zur Einrichtung fehlen kann — in der Reihenfolge, in der es genannt wird. */
    public static final List<String> FEHLT =
            List.of("kennzeichen", "name", "hauptgroesse", "ort", "formel", "eingaenge");

    public static final List<String> BINDUNG_STATUS = List.of("geplant", "gilt", "beendet");

    /** Wie aus dem Messwert die Größe wird; „integration“ ist für AP-08 gekennzeichnet. */
    public static final List<String> HERLEITUNGEN =
            List.of("zaehlerstand", "differenzen", "integration", "momentanwert");

    public static final List<String> VERGLEICH_ZWECKE =
            List.of("Plausibilität", "Ersatz bei Ausfall", "Abrechnungszähler");

    public static final List<String> STELLUNGEN =
            List.of("Hauptzähler", "Unterzähler", "Erzeuger", "Speicher", "Abzweig", "keine");

    /** Warum eine Stellung abgelehnt wird — in der Reihenfolge der Prüfung. */
    public static final List<String> STELLUNG_GRUENDE = List.of(
            "nicht_elektrisch", "bezug_nur_bei_unterzaehler", "bezug_fehlt", "selbst",
            "fremde_anlage", "zyklus");

    /**
     * Woran ein Messwert an der Größe scheitert — in der Reihenfolge der Prüfung. {@code anteil}
     * (AP-08 IP-7): ein Anteil an einem Messwert, der kein Vorzeichen-Wert ist, oder an einem
     * Zählerstand — er steht an der Stelle von {@code richtung}.
     */
    public static final List<String> PASSUNG_GRUENDE =
            List.of("wertart", "groesse", "einheit", "richtung", "anteil");

    /** Der positive Teil eines Vorzeichen-Werts, je Rohwert {@code max(0, P)} (AP-08 E15). */
    public static final String ANTEIL_POSITIV = "positiv";
    /** Der Betrag des negativen Teils, je Rohwert {@code max(0, −P)} (AP-08 E15). */
    public static final String ANTEIL_NEGATIV = "negativ";

    /** Das Vokabular {@code anteil} der Quellenbindung; kein Anteil ist {@code null} (der ganze Wert). */
    public static final List<String> ANTEILE = List.of(ANTEIL_POSITIV, ANTEIL_NEGATIV);

    /**
     * Regel 7, Ausnahme „Anteil“ (AP-08 E15, W8): welche Richtung der Anteil eines Vorzeichen-Werts
     * speist — je Katalogwort. Nur hier steht, dass {@code import_export} positiv = Bezug und
     * negativ = Abgabe ist; das Box-Vorzeichen ist dabei schon im Rohwert (AP-04 E5). Ein Katalogwort,
     * das hier fehlt ({@code charge_discharge}), hat keinen Anteil.
     */
    public static final Map<String, Map<String, String>> ANTEIL_RICHTUNGEN =
            Map.of("import_export", Map.of(ANTEIL_POSITIV, "Bezug", ANTEIL_NEGATIV, "Abgabe"));

    /**
     * Welche Flüsse ein Katalogkanal führt, dessen Richtung ZWEI davon in EINER Größe hält — das
     * Wort je Anteil. Das ist <b>nicht</b> {@link #ANTEIL_RICHTUNGEN}: dort steht, womit eine
     * QUELLENBINDUNG einen Anteil belegen darf (Regel 7), und {@code charge_discharge} darf das
     * weiterhin nicht. Hier steht nur, wie die VERDICHTUNG die beiden Anteile einer solchen Reihe
     * benennt, die sie seit {@code V20260918101000} neben der Netto-Menge speichert
     * ({@code messreihe_tag.menge_positiv}/{@code menge_negativ}).
     *
     * <p>Ein Speicher heißt darum „Laden / Entladen“ und ein Netzanschluss „Bezug / Abgabe“, ohne
     * dass die Spalte das Wort trüge — die Spalte kennt nur Vorzeichen.
     */
    public static final Map<String, Map<String, String>> RICHTUNGSPAAR = Map.of(
            "import_export", Map.of(ANTEIL_POSITIV, "Bezug", ANTEIL_NEGATIV, "Abgabe"),
            "charge_discharge", Map.of(ANTEIL_POSITIV, "Laden", ANTEIL_NEGATIV, "Entladen"));

    public static final List<String> HINWEISE = List.of("ablesestand_pruefen");

    /** Die Flüsse, aus denen ein Vorschlag wird (E6) — in der Reihenfolge der Liste. */
    public static final List<String> VORSCHLAG_FLUESSE =
            List.of("Bezug", "Abgabe", "Erzeugung", "Laden / Entladen", "Laden", "Entladen");

    /** Was eine Komponente in der Vorschlagsliste ist — sie sagt, welche Stellung ein Fluss bekommt. */
    public static final List<String> VORSCHLAG_ROLLEN =
            List.of("netzmessung", "zaehler", "geraet", "abgeleitet");

    /** Warum eine Komponente oder ein Messwert NICHT vorgeschlagen wird — in der Reihenfolge der Prüfung. */
    public static final List<String> VORSCHLAG_GRUENDE = List.of(
            "abgeleitet", "ohne_messkanal", "ohne_geraet", "attribut_kanal", "keine_messgroesse",
            "ohne_richtung", "weitere_groesse", "vorzeichen_wert", "vergleich_kandidat",
            "gleicher_fluss", "passt_nicht");

    /** Was an einem Vorschlag hängt, ohne ihn zu verhindern — in der Reihenfolge der Zeile. */
    public static final List<String> VORSCHLAG_HINWEISE =
            List.of("integration", "ladestand_herkunft", "geraet_gewechselt", "standort_spaeter");

    /** Warum die Liste leer ist. */
    public static final List<String> VORSCHLAG_LEER = List.of("alle_zugeordnet", "keine_komponente");

    /**
     * Die Kanäle, die nie ein Messwert einer Messstelle sind (P4, P5b, P5c): die Herkunft des
     * Ladestands, die Freigaben und die Grenzen. Dazu der Namensraum {@link #ATTRIBUT_PRAEFIX}.
     */
    public static final List<String> ATTRIBUT_KANAELE = List.of(
            "soc_source_code", "charge_allowed", "discharge_allowed",
            "charge_limit_a", "discharge_limit_a");

    /** Der Namensraum der BMS-Kanäle (P4) — Zustände, Grenzen und Bitfelder, nie eine Messung. */
    public static final String ATTRIBUT_PRAEFIX = "bms_";

    /** Wo ein Zeitpunkt gegen „jetzt“ steht (E2): rückwirkend markiert, angekündigt in der Zukunft. */
    public static final List<String> RUECKWIRKUNG_ARTEN = List.of("rueckwirkend", "ab_jetzt", "angekuendigt");

    private static final String STROM = "Strom";
    /** Die Art einer Messstelle, die aus anderen gerechnet wird (E9) — sie hat keine Quelle. */
    public static final String BERECHNET = "berechnet";
    private static final String HAUPTZAEHLER = "Hauptzähler";
    private static final String UNTERZAEHLER = "Unterzähler";
    private static final String KEINE = "keine";
    private static final String ZAEHLERSTAND = "Zählerstand";
    private static final String MOMENTANWERT = "Momentanwert";
    private static final String ERZEUGER = "Erzeuger";
    private static final String SPEICHER = "Speicher";
    private static final String WIRKENERGIE = "Wirkenergie";
    private static final String WIRKLEISTUNG = "Wirkleistung";
    private static final String LADESTAND = "Ladestand";
    private static final String INTERVALLMENGE = "Intervallmenge";
    private static final String BEZUG = "Bezug";
    private static final String RICHTUNGSLOS = "richtungslos";
    /** Das Katalogwort eines Vorzeichen-Werts: Bezug UND Abgabe in einem (AP-08). */
    private static final String IMPORT_EXPORT = "import_export";
    private static final String NETZMESSUNG = "netzmessung";
    private static final String ABGELEITET = "abgeleitet";
    private static final String GERAET = "geraet";
    private static final String SOC_SOURCE_CODE = "soc_source_code";
    private static final String COUNTER = "counter";
    private static final String GAUGE = "gauge";
    private static final String VERGLEICH = "vergleich";
    private static final String WECHSEL = "wechsel";

    private MessstelleRegeln() {}

    // ---------------------------------------------------------------- Vokabular

    /** Die Fehlertabelle: Code, Status der Schnittstelle und wer ihn feststellt. */
    public enum Fehler {
        KENNZEICHEN_FORMAT("kennzeichen_format", 400),
        KENNZEICHEN_BELEGT("kennzeichen_belegt", 409),
        GROESSE_UNGUELTIG("groesse_ungueltig", 400),
        MEDIUM_OHNE_QUELLE("medium_ohne_quelle", 422),
        VERGLEICH_OHNE_ZWECK("vergleich_ohne_zweck", 400),
        QUELLE_PASST_NICHT("quelle_passt_nicht", 422),
        KANAL_BEREITS_FUEHREND("kanal_bereits_fuehrend", 409),
        ZEITRAUM_UNGUELTIG("zeitraum_ungueltig", 400),
        ZEITPUNKT_VOR_VORGAENGER("zeitpunkt_vor_vorgaenger", 422),
        BINDUNG_UEBERLAPPT("bindung_ueberlappt", 409),
        HAUPTZAEHLER_VORHANDEN("hauptzaehler_vorhanden", 409),
        STELLUNG_UNGUELTIG("stellung_ungueltig", 422),
        /** Kostenstellen-Anteile — prüft erst IP-7 (Zuordnungen), nicht diese Klasse. */
        ANTEILE_SUMME("anteile_summe", 422, "IP-7"),
        /** Ort archiviert oder außerhalb des Geltungsbereichs — prüft erst IP-7. */
        ORT_UNGUELTIG("ort_ungueltig", 422, "IP-7"),
        /** Die Komponente wird zu Beginn (oder bis zum Ende) der Quelle von keinem Gerät gespeist (IP-13). */
        KEIN_GERAET_ZUM_ZEITPUNKT("kein_geraet_zum_zeitpunkt", 422),
        /** Eine Quelle wird nur EINMAL beendet — nie überschrieben (Regel 2, IP-13). */
        BINDUNG_BEREITS_BEENDET("bindung_bereits_beendet", 409);

        private final String code;
        private final int status;
        private final String geprueftVon;

        Fehler(String code, int status) {
            this(code, status, "MessstelleRegeln");
        }

        Fehler(String code, int status, String geprueftVon) {
            this.code = code;
            this.status = status;
            this.geprueftVon = geprueftVon;
        }

        /** Das Wort des Vertrags. */
        public String code() {
            return code;
        }

        /** Der Antwort-Status der Schnittstelle. */
        public int status() {
            return status;
        }

        /** {@code MessstelleRegeln} oder das Bau-Paket, das ihn erst feststellt. */
        public String geprueftVon() {
            return geprueftVon;
        }
    }

    // ----------------------------------------------------------- Größen-Katalog

    /** Aus welchem Messwert eine Größe gespeist werden darf. */
    public record KatalogQuelle(String kanalGroesse, String kanalWertart, String nurWertart) {}

    /**
     * Eine Größe des Katalogs. {@code richtungenNurBerechnet} sind Richtungen, die NUR eine
     * berechnete Messstelle tragen darf (AP-10 IP-4: {@code saldiert}) — sie stehen bewusst NICHT
     * in {@code richtungen}, damit jede gemessene Reihe und jeder Messkanal sie nie bekommt.
     */
    public record KatalogEintrag(
            String groesse,
            List<String> medien,
            String einheit,
            List<String> richtungen,
            List<String> wertarten,
            List<KatalogQuelle> quellen,
            List<String> richtungenNurBerechnet) {

        /** Eine Größe, deren Richtungen alle auch gemessen vorkommen dürfen. */
        public KatalogEintrag(String groesse, List<String> medien, String einheit, List<String> richtungen,
                List<String> wertarten, List<KatalogQuelle> quellen) {
            this(groesse, medien, einheit, richtungen, wertarten, quellen, List.of());
        }
    }

    /**
     * Die Richtung einer Bilanz-Differenz „Bezug − Abgabe“ (AP-10 E1, Formel-Typ {@code saldo}):
     * ein ADDITIVER Katalog-Eintrag der Wirkenergie, zulässig nur für {@code art = berechnet} und
     * nie an einem Messkanal bindbar ({@code MesskanalAbbildung} kennt das Wort nicht).
     */
    public static final String SALDIERT = "saldiert";

    /**
     * Der Größen-Katalog (AP-04 §4.1). „Laden / Entladen“ bei der Wirkenergie ist
     * die zusammengefasste Richtung des Speichers (E1, MS-04); aus einer Leistung
     * wird nur eine Intervallmenge, nie ein Zählerstand. {@code saldiert} gibt es nur
     * an einer berechneten Messstelle (AP-10 IP-4).
     */
    public static final List<KatalogEintrag> GROESSEN_KATALOG = List.of(
            new KatalogEintrag("Wirkenergie", List.of(STROM), "kWh",
                    List.of("Bezug", "Abgabe", "Erzeugung", "Laden", "Entladen", "Laden / Entladen"),
                    List.of(ZAEHLERSTAND, "Intervallmenge"),
                    List.of(new KatalogQuelle("Wirkenergie", COUNTER, null),
                            new KatalogQuelle("Wirkleistung", GAUGE, "Intervallmenge")),
                    List.of(SALDIERT)),
            new KatalogEintrag("Wirkleistung", List.of(STROM), "kW",
                    List.of("Bezug", "Abgabe", "Erzeugung", "Laden", "Entladen", "richtungslos"),
                    List.of(MOMENTANWERT),
                    List.of(new KatalogQuelle("Wirkleistung", GAUGE, null))),
            new KatalogEintrag("Blindenergie", List.of(STROM), "kvarh",
                    List.of("Bezug", "Abgabe"),
                    List.of(ZAEHLERSTAND, "Intervallmenge"),
                    List.of(new KatalogQuelle("Blindenergie", COUNTER, null))),
            new KatalogEintrag("Scheinleistung", List.of(STROM), "kVA",
                    List.of("richtungslos"),
                    List.of(MOMENTANWERT),
                    List.of(new KatalogQuelle("Scheinleistung", GAUGE, null))),
            new KatalogEintrag("Ladestand", List.of(STROM), "%",
                    List.of("richtungslos"),
                    List.of(MOMENTANWERT),
                    List.of(new KatalogQuelle("Ladestand", GAUGE, null))),
            new KatalogEintrag("Volumen", List.of("Gas"), "m³",
                    List.of("Bezug"),
                    List.of(ZAEHLERSTAND, "Intervallmenge"),
                    List.of()));

    /** Welche Einheiten ein Messwert je Größe tragen darf, weil sie sich umrechnen lassen. */
    public static final Map<String, List<String>> KANAL_EINHEITEN = kanalEinheiten();

    private static Map<String, List<String>> kanalEinheiten() {
        Map<String, List<String>> m = new LinkedHashMap<>();
        m.put("Wirkenergie", List.of("Wh", "kWh", "MWh"));
        m.put("Wirkleistung", List.of("W", "kW", "MW"));
        m.put("Blindenergie", List.of("varh", "kvarh"));
        m.put("Scheinleistung", List.of("VA", "kVA"));
        m.put("Ladestand", List.of("%"));
        return Collections.unmodifiableMap(m);
    }

    /** Eine Messgröße: was, in welche Richtung, in welcher Einheit, wie zu lesen. */
    public record Groesse(String groesse, String richtung, String einheit, String wertart) {}

    /** Das Urteil über eine Größe; {@code fehler == null} heißt: steht im Katalog. */
    public record GroesseUrteil(Fehler fehler, String grund) {}

    /**
     * Steht die Größe mit diesem Medium im Katalog? Sonst {@code groesse_ungueltig}
     * mit dem ERSTEN verletzten Merkmal: groesse → medium → einheit → richtung →
     * wertart.
     *
     * <p>Ohne Art geprüft: eine Richtung, die nur eine berechnete Messstelle tragen darf
     * ({@code saldiert}), ist hier {@code richtung} — genau so urteilt die Datenbank-Funktion
     * {@code messstelle_groesse_im_katalog}.
     */
    public static GroesseUrteil groessePruefen(String medium, Groesse g) {
        return groessePruefen(medium, null, g);
    }

    /**
     * Wie {@link #groessePruefen(String, Groesse)}, aber mit der Art der Messstelle: nur
     * {@code art = berechnet} darf zusätzlich eine Richtung aus
     * {@link KatalogEintrag#richtungenNurBerechnet()} tragen (AP-10 IP-4). Eine gemessene
     * Messstelle mit {@code saldiert} ist {@code groesse_ungueltig} mit Grund {@code richtung}.
     */
    public static GroesseUrteil groessePruefen(String medium, String art, Groesse g) {
        KatalogEintrag e = katalog(g.groesse());
        String grund = e == null ? "groesse"
                : !enthaelt(e.medien(), medium) ? "medium"
                : !e.einheit().equals(g.einheit()) ? "einheit"
                : !richtungErlaubt(e, art, g.richtung()) ? "richtung"
                : !enthaelt(e.wertarten(), g.wertart()) ? "wertart"
                : null;
        return new GroesseUrteil(grund == null ? null : Fehler.GROESSE_UNGUELTIG, grund);
    }

    private static boolean richtungErlaubt(KatalogEintrag e, String art, String richtung) {
        return enthaelt(e.richtungen(), richtung)
                || (BERECHNET.equals(art) && enthaelt(e.richtungenNurBerechnet(), richtung));
    }

    private static KatalogEintrag katalog(String groesse) {
        for (KatalogEintrag e : GROESSEN_KATALOG) {
            if (e.groesse().equals(groesse)) {
                return e;
            }
        }
        return null;
    }

    // -------------------------------------------------------------- Kennzeichen

    /** Trägt das Kennzeichen nur erlaubte Zeichen in erlaubter Länge? Nichts wird umgewandelt. */
    public static boolean kennzeichenFormatGueltig(String kandidat) {
        return kandidat != null && KENNZEICHEN.matcher(kandidat).matches();
    }

    /** Das automatische Kennzeichen zur laufenden Nummer: {@code 22 → MS-0022}. */
    public static String automatisch(int nummer) {
        return KENNZEICHEN_PRAEFIX
                + String.format(Locale.ROOT, "%0" + KENNZEICHEN_STELLEN + "d", nummer);
    }

    /** Der Vorschlag und der Zähler, der gilt, sobald er gespeichert wird. */
    public record Vorschlag(String kennzeichen, int zaehler) {}

    /**
     * Der nächste automatische Vorschlag: die kleinste Nummer ÜBER dem Zähler,
     * deren Kennzeichen niemand trägt oder trug. Eine übersprungene Nummer wird nie
     * mehr vergeben.
     */
    public static Vorschlag kennzeichenVorschlag(int zaehler, Collection<String> belegt) {
        Set<String> b = new HashSet<>(belegt);
        int n = zaehler + 1;
        while (b.contains(automatisch(n))) {
            n++;
        }
        return new Vorschlag(automatisch(n), n);
    }

    /**
     * Ein belegtes Kennzeichen: wer es trägt ({@code frueher = false}) oder trug
     * ({@code frueher = true}); {@code messstelle} ist dessen heutiges Kennzeichen.
     */
    public record Vergeben(
            String kennzeichen, String messstelle, String name, boolean archiviert, boolean frueher) {}

    /** Das Urteil über ein Kennzeichen; {@code fehler == null} heißt: erlaubt. */
    public record KennzeichenUrteil(Fehler fehler, Vergeben bestehend) {}

    /**
     * Darf {@code kandidat} das Kennzeichen der Messstelle {@code fuerMessstelle}
     * (heutiges Kennzeichen; {@code null} bei einer neuen) werden? Erst die Form,
     * dann die Belegung — wobei die Messstelle nie mit sich selbst kollidiert und
     * zu ihrem eigenen früheren Kennzeichen zurück darf.
     */
    public static KennzeichenUrteil kennzeichenPruefen(
            String kandidat, String fuerMessstelle, List<Vergeben> vergeben) {
        if (!kennzeichenFormatGueltig(kandidat)) {
            return new KennzeichenUrteil(Fehler.KENNZEICHEN_FORMAT, null);
        }
        for (Vergeben v : vergeben) {
            if (v.kennzeichen().equals(kandidat) && !v.messstelle().equals(fuerMessstelle)) {
                return new KennzeichenUrteil(Fehler.KENNZEICHEN_BELEGT, v);
            }
        }
        return new KennzeichenUrteil(null, null);
    }

    // ------------------------------------------------------------- Lebenszyklus

    /** Eine Quelle mit ihrem Zeitraum {@code [gueltigAb, gueltigBis)}; {@code null} = bis auf Weiteres. */
    public record QuelleZeitraum(
            String komponente,
            String kanal,
            String geraet,
            String einbau,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis) {}

    public record LebenszyklusEingang(
            String art,
            String medium,
            String kennzeichen,
            String name,
            Groesse hauptgroesse,
            boolean ortVorhanden,
            boolean formelVorhanden,
            boolean eingaengeEingerichtet,
            boolean angehalten,
            boolean archiviert,
            List<QuelleZeitraum> fuehrendeQuelle,
            OffsetDateTime jetzt) {}

    public record LebenszyklusErgebnis(
            String lebenszyklus, boolean eingerichtet, List<String> fehlt, boolean quelleVorhanden) {}

    /**
     * Wo die Messstelle in ihrem Leben steht (AP-04 §4.5). Gemessen: eingerichtet
     * mit Kennzeichen + Name + Hauptgröße + Ort — eine Quelle ist KEINE
     * Voraussetzung (E8). Berechnet: mit Formel und eingerichteten Eingängen, ohne
     * Ort-Pflicht; bis AP-10 gibt es keine Formel, also bleibt sie Entwurf (E9).
     * Eingerichtet wird von selbst aktiv. Vorrang: archiviert → Entwurf →
     * angehalten → aktiv.
     *
     * <p>{@code quelleVorhanden} ist genau der Eingang {@code quelleVorhanden} von
     * {@link ZustandAbleitung#liefertDaten}: ohne führende Quelle heißt die
     * Beobachtung „Keine Datenquelle“ — nie 0.
     */
    public static LebenszyklusErgebnis lebenszyklus(LebenszyklusEingang e) {
        boolean berechnet = BERECHNET.equals(e.art());
        List<String> fehlt = new ArrayList<>();
        if (leer(e.kennzeichen())) {
            fehlt.add("kennzeichen");
        }
        if (leer(e.name())) {
            fehlt.add("name");
        }
        if (e.hauptgroesse() == null) {
            fehlt.add("hauptgroesse");
        }
        if (!berechnet && !e.ortVorhanden()) {
            fehlt.add("ort");
        }
        if (berechnet && !e.formelVorhanden()) {
            fehlt.add("formel");
        }
        if (berechnet && e.formelVorhanden() && !e.eingaengeEingerichtet()) {
            fehlt.add("eingaenge");
        }
        boolean eingerichtet = fehlt.isEmpty();
        String zyklus = e.archiviert() ? "archiviert"
                : !eingerichtet ? "entwurf"
                : e.angehalten() ? "angehalten"
                : "aktiv";
        OffsetDateTime jetzt = minute(e.jetzt());
        boolean quelle = !berechnet
                && e.fuehrendeQuelle().stream().anyMatch(q -> gilt(q.gueltigAb(), q.gueltigBis(), jetzt));
        return new LebenszyklusErgebnis(zyklus, eingerichtet, List.copyOf(fehlt), quelle);
    }

    // ------------------------------------------------------------ Quellenbindung

    /** Ein abgelesener Zählerstand; {@code einheit} darf fehlen (dann gibt es einen Hinweis). */
    public record Stand(double wert, String einheit) {}

    /** Eine bestehende Quelle der Messstelle, mit der Größe, zu der sie gehört. */
    public record Bindung(
            String rolle,
            String groesse,
            String richtung,
            String komponente,
            String kanal,
            String geraet,
            String einbau,
            String kanalWertart,
            String zweck,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis) {

        Bindung mitEnde(OffsetDateTime bis) {
            return new Bindung(rolle, groesse, richtung, komponente, kanal, geraet, einbau,
                    kanalWertart, zweck, gueltigAb, bis);
        }
    }

    /**
     * Die Quelle, die gebunden werden soll, samt dem, was der Messwert-Katalog über sie weiß.
     *
     * @param geraet das Gerät, dessen Einbau die Komponente zu {@code gueltigAb} speist;
     *     {@code null} mit {@code einbau == null}: keine Speisung zu diesem Zeitpunkt
     * @param kanalRichtung {@code null}, wenn der Katalog keine EINE Vertrags-Richtung kennt
     *     (der Vorzeichen-Wert {@code import_export} — er bindet nur mit {@code anteil})
     * @param geraetBis bis wann dieser Einbau die Komponente speist; {@code null} = bis auf Weiteres
     * @param kanalDirection das Katalogwort {@code direction} des Messwerts ({@code import_export} …)
     * @param anteil {@code positiv} | {@code negativ} | {@code null} = der ganze Wert (AP-08 IP-7)
     */
    public record NeueBindung(
            String rolle,
            String zweck,
            String komponente,
            String kanal,
            String geraet,
            String einbau,
            String kanalGroesse,
            String kanalRichtung,
            String kanalEinheit,
            String kanalWertart,
            OffsetDateTime gueltigAb,
            OffsetDateTime gueltigBis,
            Stand endstandVorgaenger,
            Stand anfangsstand,
            OffsetDateTime geraetBis,
            String kanalDirection,
            String anteil) {

        /** Eine Bindung ohne Anteil — die Form von vor AP-08 IP-7. */
        public NeueBindung(String rolle, String zweck, String komponente, String kanal, String geraet,
                String einbau, String kanalGroesse, String kanalRichtung, String kanalEinheit,
                String kanalWertart, OffsetDateTime gueltigAb, OffsetDateTime gueltigBis,
                Stand endstandVorgaenger, Stand anfangsstand, OffsetDateTime geraetBis) {
            this(rolle, zweck, komponente, kanal, geraet, einbau, kanalGroesse, kanalRichtung, kanalEinheit,
                    kanalWertart, gueltigAb, gueltigBis, endstandVorgaenger, anfangsstand, geraetBis, null, null);
        }
    }

    /**
     * Derselbe Messwert speist in diesem Zeitraum eine ANDERE Messstelle führend — mit seinem
     * {@code anteil} ({@code null} = der ganze Wert).
     */
    public record FremdeFuehrung(String messstelle, OffsetDateTime gueltigAb, OffsetDateTime gueltigBis,
            String anteil) {

        public FremdeFuehrung(String messstelle, OffsetDateTime gueltigAb, OffsetDateTime gueltigBis) {
            this(messstelle, gueltigAb, gueltigBis, null);
        }
    }

    /**
     * @param vorgang {@code binden} fügt hinzu; {@code wechsel} löst die laufende Quelle ab
     * @param messstelleBeginn Beginn des ersten Orts; {@code null} bei einem Entwurf ohne Ort
     * @param ziel die Haupt- oder Nebengröße, an die gebunden wird
     * @param bestehende ALLE Quellen der Messstelle, jede mit ihrer Größe
     */
    public record BindungEingang(
            String vorgang,
            OffsetDateTime jetzt,
            String medium,
            OffsetDateTime messstelleBeginn,
            Groesse ziel,
            List<Bindung> bestehende,
            NeueBindung neu,
            List<FremdeFuehrung> kanalFuehrendAnderswo) {}

    /** Die laufende Quelle, die die neue genau zu ihrem Beginn beendet. */
    public record Beendet(Bindung bindung, Stand endstand) {}

    /** Ein Abschnitt des Zeitstrahls; {@code quelle == null} ist eine sichtbare Lücke. */
    public record Abschnitt(OffsetDateTime von, OffsetDateTime bis, QuelleZeitraum quelle) {}

    /**
     * @param ohneGeraetAb bei {@code kein_geraet_zum_zeitpunkt}: der erste Zeitpunkt der Quelle,
     *     zu dem kein Gerät die Komponente speist — ihr Beginn oder das Ende der Speisung
     */
    public record BindungUrteil(
            Fehler fehler,
            String grund,
            Bindung bestehend,
            String messstelle,
            Beendet beendet,
            String status,
            boolean rueckwirkend,
            boolean angekuendigt,
            String herleitung,
            List<String> hinweise,
            List<Abschnitt> zeitstrahl,
            OffsetDateTime ohneGeraetAb) {}

    /** Die Einheiten eines Energie-Zählerstands und wie viele davon eine kWh sind (AP-08 IP-7). */
    private static final Map<String, BigDecimal> JE_KWH = Map.of(
            "Wh", BigDecimal.valueOf(1000), "kWh", BigDecimal.ONE, "MWh", new BigDecimal("0.001"));

    /**
     * AP-08 IP-7 (Z6, E4): der größte plausible Zuwachs eines Energie-Zählerstands je Kadenz aus der
     * Anschlussleistung der Messstelle — kW × Kadenz in der Einheit des Zählerstands, auf drei Stellen
     * AUFgerundet (eine Grenze schneidet nie einen echten Zuwachs ab). Die Messstellen-Seite der
     * Überlauf-Deklaration; ein Überlauf braucht zusätzlich den Wertebereich des Messwerts.
     *
     * @return {@code null} ohne Anschlussleistung oder ohne elektrische Energie-Einheit — nie geraten
     */
    public static BigDecimal hoechstzuwachsJeKadenz(BigDecimal anschlussleistungKw, String einheit, int kadenzS) {
        BigDecimal jeKwh = einheit == null ? null : JE_KWH.get(einheit);
        if (anschlussleistungKw == null || jeKwh == null || anschlussleistungKw.signum() <= 0 || kadenzS < 1) {
            return null;
        }
        return anschlussleistungKw.multiply(BigDecimal.valueOf(kadenzS)).multiply(jeKwh)
                .divide(BigDecimal.valueOf(3600), 3, RoundingMode.CEILING).stripTrailingZeros();
    }

    /** Das Urteil der Passung Messwert → Größe (Regel 7). */
    public record Passung(Fehler fehler, String grund, String herleitung) {}

    /**
     * Passt der Messwert zur Größe (Regel 7)? Medium Strom; dann die Wertart
     * (state/bitfield/text nie; Momentanwert nie aus Zählerstand; Zählerstand nie aus
     * Leistung), die Größe laut Katalog, eine umrechenbare Einheit, dieselbe
     * Richtung. Bei Erfolg sagt {@code herleitung}, wie aus dem Messwert die Größe
     * wird. Ohne Anteil — die Form von vor AP-08 IP-7.
     */
    public static Passung passung(
            String medium, Groesse ziel, String kanalGroesse, String kanalRichtung,
            String kanalEinheit, String kanalWertart) {
        return passung(medium, ziel, kanalGroesse, kanalRichtung, kanalEinheit, kanalWertart, null, null);
    }

    /**
     * Regel 7 mit der Ausnahme „Anteil“ (AP-08 E15, W8). Alles bis zur Einheit wie ohne Anteil; an
     * der Stelle der Richtung gilt dann: ein Anteil nur an einem Momentanwert-Messwert, dessen
     * Katalogwort in {@link #ANTEIL_RICHTUNGEN} steht (sonst Grund {@code anteil}), und die Richtung
     * des Anteils ist die Richtung der Größe (sonst Grund {@code richtung}). Ohne Anteil bleibt ein
     * Vorzeichen-Wert, was er war: keine Richtung, Grund {@code richtung}.
     *
     * @param kanalDirection das Katalogwort {@code direction}; nur mit Anteil gelesen
     * @param anteil {@code positiv} | {@code negativ} | {@code null}
     */
    public static Passung passung(
            String medium, Groesse ziel, String kanalGroesse, String kanalRichtung,
            String kanalEinheit, String kanalWertart, String kanalDirection, String anteil) {
        if (!STROM.equals(medium)) {
            return new Passung(Fehler.MEDIUM_OHNE_QUELLE, null, null);
        }
        if (!COUNTER.equals(kanalWertart) && !GAUGE.equals(kanalWertart)) {
            return passtNicht("wertart");
        }
        if (MOMENTANWERT.equals(ziel.wertart()) && COUNTER.equals(kanalWertart)) {
            return passtNicht("wertart");
        }
        if (ZAEHLERSTAND.equals(ziel.wertart()) && GAUGE.equals(kanalWertart)) {
            return passtNicht("wertart");
        }
        KatalogEintrag e = katalog(ziel.groesse());
        List<KatalogQuelle> mitGroesse = e == null ? List.of()
                : e.quellen().stream().filter(q -> q.kanalGroesse().equals(kanalGroesse)).toList();
        if (mitGroesse.isEmpty()) {
            return passtNicht("groesse");
        }
        boolean wertartPasst = mitGroesse.stream().anyMatch(q -> q.kanalWertart().equals(kanalWertart)
                && (q.nurWertart() == null || q.nurWertart().equals(ziel.wertart())));
        if (!wertartPasst) {
            return passtNicht("wertart");
        }
        if (!enthaelt(KANAL_EINHEITEN.getOrDefault(kanalGroesse, List.of()), kanalEinheit)) {
            return passtNicht("einheit");
        }
        if (anteil != null) {
            Map<String, String> richtungen = kanalDirection == null ? null : ANTEIL_RICHTUNGEN.get(kanalDirection);
            String richtungDesAnteils = richtungen == null || !GAUGE.equals(kanalWertart) ? null
                    : richtungen.get(anteil);
            if (richtungDesAnteils == null) {
                return passtNicht("anteil");
            }
            if (!ziel.richtung().equals(richtungDesAnteils)) {
                return passtNicht("richtung");
            }
        } else if (!ziel.richtung().equals(kanalRichtung)) {
            return passtNicht("richtung");
        }
        String herleitung = COUNTER.equals(kanalWertart)
                ? (ZAEHLERSTAND.equals(ziel.wertart()) ? "zaehlerstand" : "differenzen")
                : (MOMENTANWERT.equals(ziel.wertart()) ? "momentanwert" : "integration");
        return new Passung(null, null, herleitung);
    }

    private static Passung passtNicht(String grund) {
        return new Passung(Fehler.QUELLE_PASST_NICHT, grund, null);
    }

    /**
     * Darf die neue Quelle gebunden werden — und wie sieht der Zeitstrahl danach
     * aus? Die Prüfreihenfolge ist Teil des Vertrags (der erste Treffer gewinnt):
     * Medium → Zweck → Passung → Zeitraum → Gerät zum Zeitpunkt → Messwert führt
     * schon anderswo (je Anteil, AP-08 IP-7) → Zeitpunkt vor Vorgänger/Beginn → Überlappung.
     */
    public static BindungUrteil bindungPruefen(BindungEingang e) {
        NeueBindung n = e.neu();
        boolean vergleich = VERGLEICH.equals(n.rolle());
        if (!STROM.equals(e.medium())) {
            return abgelehnt(Fehler.MEDIUM_OHNE_QUELLE, null, null, null);
        }
        if (vergleich && !enthaelt(VERGLEICH_ZWECKE, n.zweck())) {
            return abgelehnt(Fehler.VERGLEICH_OHNE_ZWECK, null, null, null);
        }
        Passung p = passung(e.medium(), e.ziel(), n.kanalGroesse(), n.kanalRichtung(),
                n.kanalEinheit(), n.kanalWertart(), n.kanalDirection(), n.anteil());
        if (p.fehler() != null) {
            return abgelehnt(p.fehler(), p.grund(), null, null);
        }
        OffsetDateTime ab = n.gueltigAb();
        OffsetDateTime bis = n.gueltigBis();
        if (bis != null && !bis.isAfter(ab)) {
            return abgelehnt(Fehler.ZEITRAUM_UNGUELTIG, null, null, null);
        }
        // Ein Messkanal gehört genau einem Gerät (Regel 6, W2): ohne Speisung zu Beginn gibt es
        // ihn nicht, und über das Ende der Speisung hinaus ist er ein anderer (Zählerwechsel).
        OffsetDateTime ohneGeraet = n.einbau() == null ? ab
                : n.geraetBis() != null && (bis == null || bis.isAfter(n.geraetBis())) ? n.geraetBis()
                : null;
        if (ohneGeraet != null) {
            return new BindungUrteil(Fehler.KEIN_GERAET_ZUM_ZEITPUNKT, null, null, null, null, null,
                    false, false, null, List.of(), null, ohneGeraet);
        }
        if (!vergleich) {
            for (FremdeFuehrung f : e.kanalFuehrendAnderswo()) {
                // AP-08 E15: der positive und der negative Anteil sind zwei Messwerte — sie führen je
                // eine Messstelle; der ganze Wert schließt jeden Anteil aus.
                boolean andererAnteil = n.anteil() != null && f.anteil() != null && !n.anteil().equals(f.anteil());
                if (!andererAnteil && ueberschneiden(ab, bis, f.gueltigAb(), f.gueltigBis())) {
                    return abgelehnt(Fehler.KANAL_BEREITS_FUEHREND, null, null, f.messstelle());
                }
            }
        }

        // Dieselbe Größe und Rolle — beim Vergleich zusätzlich derselbe Messwert:
        // Vergleichsquellen gibt es 0..n nebeneinander, nur nicht zweimal dieselbe.
        List<Bindung> gleicheRolle = e.bestehende().stream()
                .filter(b -> b.rolle().equals(n.rolle())
                        && b.groesse().equals(e.ziel().groesse())
                        && b.richtung().equals(e.ziel().richtung())
                        && (!vergleich || gleicheQuelle(b, n)))
                .toList();
        Bindung laufend = vergleich ? null : gleicheRolle.stream()
                .filter(b -> b.gueltigBis() == null)
                .max(Comparator.comparing(Bindung::gueltigAb))
                .orElse(null);
        if (WECHSEL.equals(e.vorgang()) && laufend != null && !ab.isAfter(laufend.gueltigAb())) {
            return abgelehnt(Fehler.ZEITPUNKT_VOR_VORGAENGER, null, laufend, null);
        }
        if (e.messstelleBeginn() != null && ab.isBefore(e.messstelleBeginn())) {
            return abgelehnt(Fehler.ZEITPUNKT_VOR_VORGAENGER, null, null, null);
        }

        // Die EINZIGE Änderung an Bestehendem (Regel 2): eine neue offene führende
        // Quelle beendet die laufende genau zu ihrem Beginn.
        Bindung zuBeenden = laufend != null && bis == null && laufend.gueltigAb().isBefore(ab)
                ? laufend : null;
        List<Bindung> danach = new ArrayList<>();
        for (Bindung b : gleicheRolle) {
            danach.add(b == zuBeenden ? b.mitEnde(ab) : b);
        }
        Bindung konflikt = danach.stream()
                .filter(b -> ueberschneiden(ab, bis, b.gueltigAb(), b.gueltigBis()))
                .min(Comparator.comparing(Bindung::gueltigAb))
                .orElse(null);
        if (konflikt != null) {
            return abgelehnt(Fehler.BINDUNG_UEBERLAPPT, null, konflikt, null);
        }

        OffsetDateTime jetzt = minute(e.jetzt());
        String status = ab.isAfter(jetzt) ? "geplant"
                : bis == null || bis.isAfter(jetzt) ? "gilt"
                : "beendet";
        Beendet beendet = zuBeenden == null ? null
                : new Beendet(zuBeenden.mitEnde(ab), n.endstandVorgaenger());
        List<Abschnitt> zeitstrahl = null;
        if (!vergleich) {
            List<QuelleZeitraum> fuehrend = new ArrayList<>();
            danach.forEach(b -> fuehrend.add(new QuelleZeitraum(b.komponente(), b.kanal(), b.geraet(),
                    b.einbau(), b.gueltigAb(), b.gueltigBis())));
            fuehrend.add(new QuelleZeitraum(n.komponente(), n.kanal(), n.geraet(), n.einbau(), ab, bis));
            zeitstrahl = zeitstrahl(e.messstelleBeginn(), fuehrend);
        }
        return new BindungUrteil(null, null, null, null, beendet, status,
                ab.isBefore(jetzt), ab.isAfter(jetzt), p.herleitung(),
                ablesestandHinweise(zuBeenden, n), zeitstrahl, null);
    }

    /**
     * Eine bestehende Quelle beenden: {@code gueltigBis} setzen, optional mit dem Endstand.
     *
     * @param bindung die Quelle, wie sie gespeichert ist
     * @param gueltigBis das neue Ende auf die Minute — auch in der Zukunft (angekündigt)
     */
    public record BeendenEingang(OffsetDateTime jetzt, Bindung bindung, OffsetDateTime gueltigBis, Stand endstand) {}

    public record BeendenUrteil(Fehler fehler, String status, boolean rueckwirkend, boolean angekuendigt,
            List<String> hinweise) {}

    /**
     * Darf die Quelle zu {@code gueltigBis} beendet werden (Regel 2)? Eine Quelle wird genau
     * EINMAL beendet — eine beendete nie verschoben (409 {@code bindung_bereits_beendet}); das
     * Ende liegt nach dem Beginn (400 {@code zeitraum_ungueltig}). Beenden hinterlässt eine
     * Lücke, bis eine neue Quelle beginnt — nie aufgefüllt. Ein Endstand ohne Einheit ist ein
     * Hinweis, kein Verbot.
     */
    public static BeendenUrteil beendenPruefen(BeendenEingang e) {
        Bindung b = e.bindung();
        if (b.gueltigBis() != null) {
            return new BeendenUrteil(Fehler.BINDUNG_BEREITS_BEENDET, null, false, false, List.of());
        }
        OffsetDateTime bis = e.gueltigBis();
        if (!bis.isAfter(b.gueltigAb())) {
            return new BeendenUrteil(Fehler.ZEITRAUM_UNGUELTIG, null, false, false, List.of());
        }
        OffsetDateTime jetzt = minute(e.jetzt());
        String status = b.gueltigAb().isAfter(jetzt) ? "geplant" : bis.isAfter(jetzt) ? "gilt" : "beendet";
        List<String> hinweise = e.endstand() != null && e.endstand().einheit() == null
                ? List.of("ablesestand_pruefen") : List.of();
        return new BeendenUrteil(null, status, bis.isBefore(jetzt), bis.isAfter(jetzt), hinweise);
    }

    // ------------------------------------------------------------ Zählerwechsel

    /**
     * Der Einbau, der beim Zählerwechsel geht (IP-17) — so, wie er gespeichert ist
     * ({@code geraet}, eine Zeile = EIN Einbau).
     *
     * @param geraet das Gerät an der Stelle (GR-4) — es bleibt über den Wechsel
     * @param einbau das konkrete Kästchen (Z-5a)
     * @param ausgebautAm {@code null} = steckt noch
     */
    public record EinbauStand(String geraet, String einbau, OffsetDateTime eingebautAm,
            OffsetDateTime ausgebautAm) {}

    /** @param zeitpunkt wann getauscht wird, auf die Minute (E2) — Vergangenheit und Zukunft erlaubt */
    public record WechselEingang(OffsetDateTime jetzt, EinbauStand alt, OffsetDateTime zeitpunkt) {}

    /**
     * @param ohneGeraetAb bei {@code kein_geraet_zum_zeitpunkt}: ab wann der Vorgänger nicht mehr
     *     steckt ({@code ausgebaut_am})
     */
    public record WechselUrteil(Fehler fehler, OffsetDateTime ohneGeraetAb, boolean rueckwirkend,
            boolean angekuendigt) {}

    /**
     * Darf zu diesem Zeitpunkt gewechselt werden (Regel 5)? Der Wechsel liegt IM laufenden Einbau
     * des Vorgängers:
     * <ul>
     *   <li>NACH seinem Einbau — genau auf ihm zählt als davor, denn ein Einbau von null Minuten
     *       ist keiner (422 {@code zeitpunkt_vor_vorgaenger}, A15 und seine Kante);</li>
     *   <li>VOR seinem Ausbau — ein ausgebauter Einbau steckt nicht mehr und wird kein zweites Mal
     *       getauscht; sein Zeitraum ist geschlossen und wird nie nachträglich geteilt (422
     *       {@code kein_geraet_zum_zeitpunkt} mit {@code ausgebaut_am}).</li>
     * </ul>
     * Rückwirkend ist erlaubt und immer sichtbar (E2); in der Zukunft heißt der Wechsel
     * „angekündigt“. Was danach mit den Quellen geschieht, urteilt {@link #beendenPruefen} (die
     * laufende endet) und {@link #bindungPruefen} mit dem Vorgang {@code wechsel} (die neue
     * beginnt) — hier steht NUR das Gerät.
     */
    public static WechselUrteil wechselPruefen(WechselEingang e) {
        EinbauStand alt = e.alt();
        OffsetDateTime t = e.zeitpunkt();
        if (!t.isAfter(alt.eingebautAm())) {
            return new WechselUrteil(Fehler.ZEITPUNKT_VOR_VORGAENGER, null, false, false);
        }
        if (alt.ausgebautAm() != null) {
            return new WechselUrteil(Fehler.KEIN_GERAET_ZUM_ZEITPUNKT, alt.ausgebautAm(), false, false);
        }
        OffsetDateTime jetzt = minute(e.jetzt());
        return new WechselUrteil(null, null, t.isBefore(jetzt), t.isAfter(jetzt));
    }

    /** AP-04 E10: Auswahl und Ablesestände dürfen ausschließlich bekannte, eindeutige Ziele nennen. */
    public static String kartenWechselPruefen(List<String> karten, List<String> uebernommen,
            List<String> fuehrendeBindungen, List<String> ablesestaende) {
        if (uebernommen == null || uebernommen.stream().anyMatch(x -> x == null || !karten.contains(x))
                || new java.util.HashSet<>(uebernommen).size() != uebernommen.size()) {
            return "karten_uebernommen";
        }
        if (ablesestaende.stream().anyMatch(x -> x == null || !fuehrendeBindungen.contains(x))
                || new java.util.HashSet<>(ablesestaende).size() != ablesestaende.size()) {
            return "ablesestaende";
        }
        return null;
    }

    /** Wie weit ein Zeitpunkt von „jetzt“ entfernt ist, auf die Minute (E2). */
    public record Rueckwirkung(String art, long minuten, String abzeichen) {}

    /**
     * Rückwirkend ist erlaubt, aber immer sichtbar (E2, Regel 5): {@code rueckwirkend} vor der
     * Minute von „jetzt“, {@code ab_jetzt} genau in ihr, {@code angekuendigt} danach. Das
     * Abzeichen trägt nur die Rückwirkung, mit ihrer Dauer: „rückwirkend (25 min)“,
     * „rückwirkend (2 h 5 min)“, ab einem Tag in ganzen Tagen „rückwirkend (933 Tage)“.
     */
    public static Rueckwirkung rueckwirkung(OffsetDateTime jetzt, OffsetDateTime zeitpunkt) {
        OffsetDateTime minuteJetzt = minute(jetzt);
        long minuten = Math.abs(ChronoUnit.MINUTES.between(zeitpunkt, minuteJetzt));
        String art = zeitpunkt.isBefore(minuteJetzt) ? "rueckwirkend"
                : zeitpunkt.isAfter(minuteJetzt) ? "angekuendigt" : "ab_jetzt";
        return new Rueckwirkung(art, minuten,
                "rueckwirkend".equals(art) ? "rückwirkend (" + dauer(minuten) + ")" : null);
    }

    private static String dauer(long minuten) {
        if (minuten < 60) {
            return minuten + " min";
        }
        if (minuten < 24 * 60) {
            long rest = minuten % 60;
            return minuten / 60 + " h" + (rest == 0 ? "" : " " + rest + " min");
        }
        long tage = minuten / (24 * 60);
        return tage + (tage == 1 ? " Tag" : " Tage");
    }

    /**
     * „Ablesestand prüfen“ (§5.12): ein Stand ohne Einheit, oder ein Anfangsstand
     * über dem Endstand DESSELBEN Geräts. Bei verschiedenen Geräten nie — sie
     * haben verschiedene Zählwerke.
     */
    private static List<String> ablesestandHinweise(Bindung vorgaenger, NeueBindung n) {
        Stand alt = n.endstandVorgaenger();
        Stand neu = n.anfangsstand();
        boolean ohneEinheit = (alt != null && alt.einheit() == null)
                || (neu != null && neu.einheit() == null);
        boolean ueberEndstand = vorgaenger != null && alt != null && neu != null
                && vorgaenger.einbau().equals(n.einbau()) && neu.wert() > alt.wert();
        return ohneEinheit || ueberEndstand ? List.of("ablesestand_pruefen") : List.of();
    }

    /**
     * Die führenden Quellen EINER Größe ab Beginn der Messstelle, lückenlos: jede
     * Lücke ist ein eigener Abschnitt ohne Quelle — auch vor der ersten und nach der
     * letzten beendeten Quelle („keine Quelle seit …“). Ohne jede Quelle ist der
     * Zeitstrahl EIN offener Abschnitt ohne Quelle (E8: „Keine Datenquelle“).
     */
    public static List<Abschnitt> zeitstrahl(OffsetDateTime beginn, List<QuelleZeitraum> fuehrend) {
        List<QuelleZeitraum> sortiert = fuehrend.stream()
                .sorted(Comparator.comparing(QuelleZeitraum::gueltigAb))
                .toList();
        List<Abschnitt> out = new ArrayList<>();
        OffsetDateTime cursor = beginn;
        for (QuelleZeitraum b : sortiert) {
            if (cursor != null && cursor.isBefore(b.gueltigAb())) {
                out.add(new Abschnitt(cursor, b.gueltigAb(), null));
            }
            out.add(new Abschnitt(b.gueltigAb(), b.gueltigBis(), b));
            cursor = b.gueltigBis();
            if (cursor == null) {
                return out;
            }
        }
        if (cursor != null) {
            out.add(new Abschnitt(cursor, null, null));
        }
        return out;
    }

    private static BindungUrteil abgelehnt(Fehler f, String grund, Bindung bestehend, String messstelle) {
        return new BindungUrteil(f, grund, bestehend, messstelle, null, null, false, false, null,
                List.of(), null, null);
    }

    private static boolean gleicheQuelle(Bindung b, NeueBindung n) {
        return b.komponente().equals(n.komponente()) && b.kanal().equals(n.kanal())
                && b.geraet().equals(n.geraet()) && b.einbau().equals(n.einbau());
    }

    // --------------------------------------------------------- Elektrische Stellung

    /** Eine Messstelle mit ihrer Stellung am Stichtag (in der Reihenfolge des Registers). */
    public record StellungEintrag(
            String kennzeichen,
            String name,
            String anlage,
            String stellung,
            String unterzaehlerVon,
            String richtung,
            String komponente) {}

    /** Die Messstelle, deren Stellung geändert werden soll; {@code komponente} der führenden Quelle. */
    public record StellungKandidat(
            String kennzeichen, String art, String medium, String richtung, String komponente) {}

    public record Stellung(String anlage, String stellung, String unterzaehlerVon) {}

    public record StellungUrteil(Fehler fehler, String grund, StellungEintrag bestehend, List<String> kette) {}

    /**
     * Darf die Messstelle diese Stellung einnehmen (Regel 8, E12)? Reihenfolge:
     * nicht elektrisch → Bezug nur bei Unterzähler → Bezug fehlt → sich selbst →
     * fremde Anlage → Zyklus; dann der Hauptzähler: je Anlage und Richtung höchstens
     * einer, alle am selben Zähler.
     */
    public static StellungUrteil stellungPruefen(
            StellungKandidat m, Stellung s, List<StellungEintrag> messstellen) {
        if (s == null) {
            return new StellungUrteil(null, null, null, List.of());
        }
        if ((BERECHNET.equals(m.art()) || !STROM.equals(m.medium())) && !KEINE.equals(s.stellung())) {
            return ungueltig("nicht_elektrisch", null, List.of());
        }
        if (!UNTERZAEHLER.equals(s.stellung()) && s.unterzaehlerVon() != null) {
            return ungueltig("bezug_nur_bei_unterzaehler", null, List.of());
        }
        Map<String, StellungEintrag> andere = new LinkedHashMap<>();
        for (StellungEintrag e : messstellen) {
            if (!e.kennzeichen().equals(m.kennzeichen())) {
                andere.put(e.kennzeichen(), e);
            }
        }
        if (UNTERZAEHLER.equals(s.stellung())) {
            String ziel = s.unterzaehlerVon();
            if (ziel == null) {
                return ungueltig("bezug_fehlt", null, List.of());
            }
            if (ziel.equals(m.kennzeichen())) {
                return ungueltig("selbst", null, List.of());
            }
            StellungEintrag z = andere.get(ziel);
            if (z == null || !z.anlage().equals(s.anlage())) {
                return ungueltig("fremde_anlage", z, List.of());
            }
            List<String> kette = new ArrayList<>(List.of(m.kennzeichen()));
            Set<String> gesehen = new HashSet<>();
            for (String cur = ziel; cur != null && gesehen.add(cur); ) {
                kette.add(cur);
                if (cur.equals(m.kennzeichen())) {
                    return ungueltig("zyklus", null, List.copyOf(kette));
                }
                StellungEintrag e = andere.get(cur);
                cur = e != null && UNTERZAEHLER.equals(e.stellung()) ? e.unterzaehlerVon() : null;
            }
        }
        if (HAUPTZAEHLER.equals(s.stellung())) {
            for (StellungEintrag e : andere.values()) {
                if (!HAUPTZAEHLER.equals(e.stellung()) || !e.anlage().equals(s.anlage())) {
                    continue;
                }
                boolean derselbeZaehler = m.komponente() != null && m.komponente().equals(e.komponente());
                if (e.richtung().equals(m.richtung()) || !derselbeZaehler) {
                    return new StellungUrteil(Fehler.HAUPTZAEHLER_VORHANDEN, null, e, List.of());
                }
            }
        }
        return new StellungUrteil(null, null, null, List.of());
    }

    private static StellungUrteil ungueltig(String grund, StellungEintrag bestehend, List<String> kette) {
        return new StellungUrteil(Fehler.STELLUNG_UNGUELTIG, grund, bestehend, kette);
    }

    // ------------------------------------------------------- Vorschlagsliste (E6)

    /**
     * Ein Messkanal einer Komponente, so wie das Read-Model ihn zeigt (IP-9): die Vertragswörter
     * ({@code groesse}, {@code richtung}, {@code einheit}, {@code wertart}) und das Katalogwort
     * {@code direction}, an dem ein Vorzeichen-Wert ({@code import_export}) erkennbar ist.
     *
     * @param speist das Kennzeichen der Messstelle, die dieser Messwert schon speist, sonst
     *               {@code null} — ein gespeister Messwert wird nie noch einmal vorgeschlagen
     */
    public record VorschlagKanal(String kanal, String anzeigename, String groesse, String richtung,
            String einheit, String wertart, String direction, String speist) {}

    /**
     * Eine Komponente mit ihren Messkanälen.
     *
     * @param rolle          {@link #VORSCHLAG_ROLLEN}: {@code netzmessung} (die maßgebliche
     *                       Netzmessung ihrer Anlage), {@code zaehler}, {@code abgeleitet}
     *                       (Haus — eine Ableitung, keine Messung) oder {@code geraet}
     * @param verlaufsbeginn der Beginn ihres Verlaufs (erste Speisung), {@code null} = unbekannt
     * @param speisungAb     der Beginn der LAUFENDEN Speisung — ein Vorschlag beginnt nie davor
     *                       (ein Gerätewechsel wird nie verkettet); {@code null} = kein Gerät
     */
    public record VorschlagKomponente(String id, String anlage, String name, String rolle,
            OffsetDateTime verlaufsbeginn, OffsetDateTime speisungAb, List<VorschlagKanal> messkanaele) {}

    /** Ein BESTEHENDER Hauptzähler der Anlage mit der Komponente seiner führenden Quelle. */
    public record VorschlagHauptzaehler(String messstelle, String richtung, String komponente,
            LocalDate seit) {}

    /** Eine Anlage des Standorts; ohne Netzanschluss gibt es keinen Hauptzähler (§5.15). */
    public record VorschlagAnlage(String id, String name, boolean netzanschluss,
            List<VorschlagHauptzaehler> hauptzaehler) {}

    /** Der Standort: der Ort jeder vorgeschlagenen Messstelle, und sein erster Tag. */
    public record VorschlagStandort(String kennzeichen, String name, LocalDate beginn, ZoneId zeitzone) {}

    public record VorschlagEingang(VorschlagStandort standort, List<VorschlagAnlage> anlagen,
            List<VorschlagKomponente> komponenten, int zaehler, List<String> belegt) {}

    /** Der Messwert hinter einer Größe des Vorschlags, mit der Herleitung aus Regel 7. */
    public record VorschlagQuelle(String kanal, String anzeigename, String kanalWertart,
            String herleitung) {}

    public record VorschlagNebengroesse(Groesse groesse, VorschlagQuelle quelle) {}

    /**
     * „Unterzähler von“: entweder eine BESTEHENDE Messstelle ({@code bestehend}) oder ein
     * Vorschlag DIESER Liste — dann sagen {@code komponente} und {@code kanal}, welcher.
     */
    public record VorschlagBezug(String messstelle, boolean bestehend, String komponente, String kanal) {}

    public record VorschlagHinweis(String code, String text) {}

    /**
     * Eine Zeile der Vorschlagsliste: was aus diesem Messwert eine Messstelle machen würde.
     * {@code ab} ist der Beginn der Bindung (Verlaufsbeginn, nie vor dem Standort und nie vor der
     * laufenden Speisung); {@code stellungAb} der Tag, ab dem die Stellung gilt (nie vor dem Tag,
     * an dem ihr Hauptzähler einer ist).
     */
    public record VorschlagZeile(String kennzeichen, String name, String anlage, String komponente,
            Groesse hauptgroesse, VorschlagQuelle quelle, List<VorschlagNebengroesse> nebengroessen,
            String stellung, VorschlagBezug unterzaehlerVon, String ort, OffsetDateTime ab,
            LocalDate stellungAb, List<VorschlagHinweis> hinweise) {}

    /**
     * Was NICHT vorgeschlagen wird, mit Grund und Satz. {@code kanal} {@code null} heißt: die
     * ganze Komponente; {@code zu} nennt die Messstelle, auf die der Grund zeigt.
     */
    public record Ausgelassen(String anlage, String komponente, String kanal, String grund,
            String zu, String text) {}

    /**
     * Die Liste. {@code leer} ({@link #VORSCHLAG_LEER}) und {@code text} sind gesetzt, WENN es
     * keinen Vorschlag gibt — nie daneben; {@code zaehler} ist der Stand, den der
     * Kennzeichen-Zähler nach einer vollständigen Übernahme hätte.
     */
    public record Vorschlagsliste(List<VorschlagZeile> vorschlaege, List<Ausgelassen> ausgelassen,
            String leer, String text, int zaehler) {}

    /** Ein Vorschlag, bevor Reihenfolge, Kennzeichen und Name feststehen. */
    private static final class Roh {
        private final VorschlagAnlage anlage;
        private final VorschlagKomponente komponente;
        private final int anlageIndex;
        private final int komponenteIndex;
        private final int flussIndex;
        private final Groesse hauptgroesse;
        private final VorschlagQuelle quelle;
        private final List<VorschlagNebengroesse> nebengroessen = new ArrayList<>();
        private final String stellung;
        private final VorschlagHauptzaehler bezugBestehend;
        private final Roh bezugVorschlag;
        private final OffsetDateTime ab;
        private final List<String> hinweise = new ArrayList<>();
        private String kennzeichen;

        private Roh(VorschlagAnlage anlage, VorschlagKomponente komponente, int anlageIndex,
                int komponenteIndex, int flussIndex, Groesse hauptgroesse, VorschlagQuelle quelle,
                String stellung, VorschlagHauptzaehler bezugBestehend, Roh bezugVorschlag,
                OffsetDateTime ab) {
            this.anlage = anlage;
            this.komponente = komponente;
            this.anlageIndex = anlageIndex;
            this.komponenteIndex = komponenteIndex;
            this.flussIndex = flussIndex;
            this.hauptgroesse = hauptgroesse;
            this.quelle = quelle;
            this.stellung = stellung;
            this.bezugBestehend = bezugBestehend;
            this.bezugVorschlag = bezugVorschlag;
            this.ab = ab;
        }
    }

    /** Eine ausgelassene Zeile, deren „zu“ erst feststeht, wenn die Kennzeichen vergeben sind. */
    private record RohAusgelassen(String anlage, String komponente, String kanal, String anzeige,
            String grund, String zuBestehend, Roh zuVorschlag, String passungGrund, String einheit,
            int anlageIndex, int komponenteIndex, int kanalIndex) {}

    /**
     * Die Vorschlagsliste eines Standorts (E6, §5.10, §5.15): aus den Komponenten seiner Anlagen
     * und deren Messkanälen wird je Komponente und Fluss HÖCHSTENS EIN Vorschlag — nie aus einem
     * Attribut-Kanal, nie aus einer Ableitung (Haus), nie ein zweiter für denselben Messwert.
     *
     * <p><b>Die Größe kommt aus dem Messwert:</b> ein Zählerstand trägt die Wirkenergie als
     * Zählerstand, eine Leistung als Intervallmenge (Herleitung {@code integration},
     * gekennzeichnet). Ein Ladestand steht als Nebengröße neben dem Speicher-Fluss derselben
     * Komponente, sonst für sich.
     *
     * <p><b>Die Stellung kommt aus der Topologie:</b> die maßgebliche Netzmessung wird Hauptzähler
     * (nur mit Netzanschluss und nur, solange kein anderer Zähler schon einer ist), Erzeugung wird
     * Erzeuger, Speicher wird Speicher, jeder andere Bezug wird „Unterzähler von“ dem
     * Bezug-Hauptzähler seiner Anlage — vorgeschlagen oder schon bestehend. Findet sich keiner,
     * bleibt die Stellung offen, nie geraten.
     *
     * <p><b>Der Beginn ist der Verlauf:</b> die Bindung beginnt am Beginn der laufenden Speisung
     * (ein vorhandener Gerätewechsel wird NIE verkettet, Hinweis {@code geraet_gewechselt}) und nie
     * vor dem ersten Tag des Standorts ({@code standort_spaeter}).
     *
     * <p>Die Reihenfolge ist die der Liste UND die der Übernahme: je Anlage erst die Hauptzähler,
     * dann Erzeuger, Speicher, Unterzähler, zuletzt das Stellungslose — so trägt ein Unterzähler
     * ein Kennzeichen, das es beim Schreiben schon gibt. Die Kennzeichen sind die automatischen
     * (E7) in genau dieser Reihenfolge.
     */
    public static Vorschlagsliste vorschlagsliste(VorschlagEingang e) {
        ZoneId zone = e.standort().zeitzone() == null ? ZoneId.of("Europe/Berlin") : e.standort().zeitzone();
        OffsetDateTime standortBeginn = e.standort().beginn() == null ? null
                : mitternacht(e.standort().beginn(), zone);
        List<Roh> rohe = new ArrayList<>();
        List<RohAusgelassen> ausgelassen = new ArrayList<>();
        boolean etwasGespeist = false;
        boolean etwasVorhanden = false;

        List<VorschlagAnlage> anlagen = e.anlagen() == null ? List.of() : e.anlagen();
        for (int ai = 0; ai < anlagen.size(); ai++) {
            VorschlagAnlage a = anlagen.get(ai);
            List<VorschlagKomponente> ihre = new ArrayList<>();
            List<Integer> index = new ArrayList<>();
            List<VorschlagKomponente> alle = e.komponenten() == null ? List.of() : e.komponenten();
            for (int ki = 0; ki < alle.size(); ki++) {
                if (alle.get(ki).anlage().equals(a.id())) {
                    ihre.add(alle.get(ki));
                    index.add(ki);
                }
            }
            // Die Netzmessung zuerst: erst nach ihr steht fest, ob die Anlage einen
            // Hauptzähler-Vorschlag hat, an dem die Unterzähler hängen.
            List<Integer> reihenfolge = new ArrayList<>();
            for (int i = 0; i < ihre.size(); i++) {
                if (NETZMESSUNG.equals(ihre.get(i).rolle())) {
                    reihenfolge.add(i);
                }
            }
            for (int i = 0; i < ihre.size(); i++) {
                if (!NETZMESSUNG.equals(ihre.get(i).rolle())) {
                    reihenfolge.add(i);
                }
            }
            for (int i : reihenfolge) {
                VorschlagKomponente k = ihre.get(i);
                etwasVorhanden = true;
                if (k.messkanaele() != null
                        && k.messkanaele().stream().anyMatch(c -> c.speist() != null)) {
                    etwasGespeist = true;
                }
                komponente(e, a, ai, k, index.get(i), zone, standortBeginn, rohe, ausgelassen);
            }
        }

        rohe.sort(Comparator.<Roh>comparingInt(r -> r.anlageIndex)
                .thenComparingInt(r -> stellungRang(r.stellung))
                .thenComparingInt(r -> r.komponenteIndex)
                .thenComparingInt(r -> r.flussIndex));
        int zaehler = e.zaehler();
        Set<String> belegt = new HashSet<>(e.belegt() == null ? List.of() : e.belegt());
        for (Roh r : rohe) {
            Vorschlag v = kennzeichenVorschlag(zaehler, belegt);
            r.kennzeichen = v.kennzeichen();
            belegt.add(v.kennzeichen());
            zaehler = v.zaehler();
        }

        List<VorschlagZeile> zeilen = new ArrayList<>();
        for (Roh r : rohe) {
            long eigene = rohe.stream().filter(x -> x.komponente == r.komponente).count()
                    + gespeisteFluesse(r.komponente);
            boolean mehrere = eigene > 1;
            String name = mehrere ? r.komponente.name() + " · " + nameZusatz(r.hauptgroesse)
                    : r.komponente.name();
            VorschlagBezug bezug = r.bezugVorschlag != null
                    ? new VorschlagBezug(r.bezugVorschlag.kennzeichen, false,
                            r.bezugVorschlag.komponente.id(), r.bezugVorschlag.quelle.kanal())
                    : r.bezugBestehend != null
                            ? new VorschlagBezug(r.bezugBestehend.messstelle(), true, null, null)
                            : null;
            LocalDate stellungAb = tag(r.ab, zone);
            if (r.bezugVorschlag != null) {
                stellungAb = spaeter(stellungAb, tag(r.bezugVorschlag.ab, zone));
            } else if (r.bezugBestehend != null && r.bezugBestehend.seit() != null) {
                stellungAb = spaeter(stellungAb, r.bezugBestehend.seit());
            }
            List<VorschlagHinweis> hinweise = new ArrayList<>();
            for (String code : VORSCHLAG_HINWEISE) {
                if (r.hinweise.contains(code)) {
                    hinweise.add(new VorschlagHinweis(code, hinweisText(code)));
                }
            }
            zeilen.add(new VorschlagZeile(r.kennzeichen, name, r.anlage.id(), r.komponente.id(),
                    r.hauptgroesse, r.quelle, List.copyOf(r.nebengroessen), r.stellung, bezug,
                    e.standort().kennzeichen(), r.ab, stellungAb, List.copyOf(hinweise)));
        }

        List<Ausgelassen> ohne = new ArrayList<>();
        ausgelassen.sort(Comparator.comparingInt(RohAusgelassen::anlageIndex)
                .thenComparingInt(RohAusgelassen::komponenteIndex)
                .thenComparingInt(RohAusgelassen::kanalIndex));
        for (RohAusgelassen x : ausgelassen) {
            String zu = x.zuVorschlag() != null ? x.zuVorschlag().kennzeichen : x.zuBestehend();
            ohne.add(new Ausgelassen(x.anlage(), x.komponente(), x.kanal(), x.grund(), zu,
                    ausgelassenText(x, zu)));
        }
        String leer = !zeilen.isEmpty() ? null
                : etwasGespeist && etwasVorhanden ? "alle_zugeordnet" : "keine_komponente";
        String text = leer == null ? null
                : "alle_zugeordnet".equals(leer)
                        ? "Alle Komponenten von " + e.standort().name() + " sind Messstellen zugeordnet."
                        : "In " + e.standort().name()
                                + " gibt es keine Komponente, aus der eine Messstelle werden kann.";
        return new Vorschlagsliste(List.copyOf(zeilen), List.copyOf(ohne), leer, text, zaehler);
    }

    /** Eine Komponente: ihre Messkanäle werden zu Vorschlägen — oder benannt ausgelassen. */
    private static void komponente(VorschlagEingang e, VorschlagAnlage a, int anlageIndex,
            VorschlagKomponente k, int komponenteIndex, ZoneId zone, OffsetDateTime standortBeginn,
            List<Roh> rohe, List<RohAusgelassen> ausgelassen) {
        List<VorschlagKanal> kanaele = k.messkanaele() == null ? List.of() : k.messkanaele();
        if (ABGELEITET.equals(k.rolle())) {
            ausgelassen.add(new RohAusgelassen(a.id(), k.id(), null, k.name(), ABGELEITET, null, null,
                    null, null, anlageIndex, komponenteIndex, -1));
            return;
        }
        if (kanaele.isEmpty()) {
            ausgelassen.add(new RohAusgelassen(a.id(), k.id(), null, k.name(), "ohne_messkanal",
                    null, null, null, null, anlageIndex, komponenteIndex, -1));
            return;
        }
        if (kanaele.stream().allMatch(c -> c.speist() != null)) {
            return;
        }
        if (k.speisungAb() == null) {
            ausgelassen.add(new RohAusgelassen(a.id(), k.id(), null, k.name(), "ohne_geraet",
                    null, null, null, null, anlageIndex, komponenteIndex, -1));
            return;
        }
        OffsetDateTime ab = minute(k.speisungAb());
        boolean standortSpaeter = false;
        if (standortBeginn != null && standortBeginn.isAfter(ab)) {
            ab = standortBeginn;
            standortSpaeter = true;
        }
        boolean gewechselt = k.verlaufsbeginn() != null && k.speisungAb().isAfter(k.verlaufsbeginn());

        // 1. Jeden Messwert einordnen; ein gespeister sagt nur, welcher Fluss schon vergeben ist.
        Map<String, List<VorschlagKanal>> fluesse = new LinkedHashMap<>();
        Map<String, String> vergeben = new LinkedHashMap<>();
        List<VorschlagKanal> ladestand = new ArrayList<>();
        String ladestandVergeben = null;
        Map<String, String> einfach = new LinkedHashMap<>();
        Set<String> vorzeichen = new LinkedHashSet<>();
        for (VorschlagKanal c : kanaele) {
            String fluss = fluss(c);
            boolean wirkgroesse = WIRKENERGIE.equals(c.groesse()) || WIRKLEISTUNG.equals(c.groesse());
            if (c.speist() != null) {
                if (fluss != null) {
                    vergeben.putIfAbsent(fluss, c.speist());
                } else if (LADESTAND.equals(c.groesse()) && ladestandVergeben == null) {
                    ladestandVergeben = c.speist();
                }
            } else if (attributKanal(c)) {
                einfach.put(c.kanal(), "attribut_kanal");
            } else if (c.groesse() == null || !enthaelt(List.of(COUNTER, GAUGE), c.wertart())) {
                einfach.put(c.kanal(), "keine_messgroesse");
            } else if (fluss != null) {
                fluesse.computeIfAbsent(fluss, x -> new ArrayList<>()).add(c);
            } else if (LADESTAND.equals(c.groesse())) {
                ladestand.add(c);
            } else if (wirkgroesse && IMPORT_EXPORT.equals(c.direction())) {
                vorzeichen.add(c.kanal());
            } else if (wirkgroesse) {
                einfach.put(c.kanal(), "ohne_richtung");
            } else {
                einfach.put(c.kanal(), "weitere_groesse");
            }
        }

        // 2. Je Fluss EIN Messwert: Zählerstand vor Leistung, und Regel 7 entscheidet.
        Set<String> verwendet = new LinkedHashSet<>();
        Map<String, String> passtNicht = new LinkedHashMap<>();
        Map<String, Roh> gleicherFluss = new LinkedHashMap<>();
        Map<String, String> gleicherFlussBestehend = new LinkedHashMap<>();
        Map<String, String> vergleichBestehend = new LinkedHashMap<>();
        for (String fluss : VORSCHLAG_FLUESSE) {
            List<VorschlagKanal> kandidaten = fluesse.getOrDefault(fluss, List.of());
            if (kandidaten.isEmpty()) {
                continue;
            }
            if (vergeben.containsKey(fluss)) {
                kandidaten.forEach(c -> gleicherFlussBestehend.put(c.kanal(), vergeben.get(fluss)));
                continue;
            }
            // Ist diese Richtung an der Anlage schon ein Hauptzähler, misst dieser Messwert den
            // Netzanschluss ein zweites Mal: ein Kandidat für eine Vergleichsquelle (E3).
            VorschlagHauptzaehler schon = NETZMESSUNG.equals(k.rolle()) ? hauptzaehler(a, fluss) : null;
            if (schon != null) {
                kandidaten.forEach(c -> vergleichBestehend.put(c.kanal(), schon.messstelle()));
                continue;
            }
            Roh treffer = null;
            for (VorschlagKanal c : nachWertart(kandidaten)) {
                Groesse ziel = new Groesse(WIRKENERGIE, fluss, einheit(WIRKENERGIE),
                        COUNTER.equals(c.wertart()) ? ZAEHLERSTAND : INTERVALLMENGE);
                Passung p = passung(STROM, ziel, c.groesse(), c.richtung(), c.einheit(), c.wertart());
                if (p.fehler() != null) {
                    passtNicht.put(c.kanal(), p.grund());
                } else if (treffer == null) {
                    treffer = neuerRoh(a, k, anlageIndex, komponenteIndex, fluss, ziel,
                            quelle(c, p), ab, rohe);
                    verwendet.add(c.kanal());
                    hinweise(treffer, p.herleitung(), standortSpaeter, gewechselt);
                } else {
                    gleicherFluss.put(c.kanal(), treffer);
                }
            }
        }

        // 3. Der Ladestand: Nebengröße des Speichers derselben Komponente, sonst eine eigene Zeile.
        Roh speicher = rohe.stream().filter(r -> r.komponente == k && SPEICHER.equals(r.stellung))
                .findFirst().orElse(null);
        String speicherVergeben = vergeben.entrySet().stream().filter(x -> speicherFluss(x.getKey()))
                .map(Map.Entry::getValue).findFirst().orElse(ladestandVergeben);
        Roh ladestandZeile = null;
        for (VorschlagKanal c : ladestand) {
            Groesse ziel = new Groesse(LADESTAND, RICHTUNGSLOS, einheit(LADESTAND), MOMENTANWERT);
            Passung p = passung(STROM, ziel, c.groesse(), c.richtung(), c.einheit(), c.wertart());
            if (p.fehler() != null) {
                passtNicht.put(c.kanal(), p.grund());
            } else if (speicher != null && speicher.nebengroessen.isEmpty()) {
                speicher.nebengroessen.add(new VorschlagNebengroesse(ziel, quelle(c, p)));
                verwendet.add(c.kanal());
                if (hatKanal(kanaele, SOC_SOURCE_CODE)) {
                    speicher.hinweise.add("ladestand_herkunft");
                }
            } else if (speicher != null) {
                gleicherFluss.put(c.kanal(), speicher);
            } else if (speicherVergeben != null) {
                gleicherFlussBestehend.put(c.kanal(), speicherVergeben);
            } else if (ladestandZeile == null) {
                ladestandZeile = neuerRoh(a, k, anlageIndex, komponenteIndex, LADESTAND, ziel,
                        quelle(c, p), ab, rohe);
                verwendet.add(c.kanal());
                hinweise(ladestandZeile, p.herleitung(), standortSpaeter, gewechselt);
                if (hatKanal(kanaele, SOC_SOURCE_CODE)) {
                    ladestandZeile.hinweise.add("ladestand_herkunft");
                }
            } else {
                gleicherFluss.put(c.kanal(), ladestandZeile);
            }
        }

        // 4. Jeden ausgelassenen Messwert in der Reihenfolge der Komponente benennen.
        Roh vorschlagBezug = bezugVorschlag(rohe, a, BEZUG);
        VorschlagHauptzaehler bestehend = hauptzaehler(a, BEZUG);
        for (int ci = 0; ci < kanaele.size(); ci++) {
            VorschlagKanal c = kanaele.get(ci);
            if (c.speist() != null || verwendet.contains(c.kanal())) {
                continue;
            }
            String anzeige = anzeige(c);
            if (einfach.containsKey(c.kanal())) {
                ausgelassen.add(new RohAusgelassen(a.id(), k.id(), c.kanal(), anzeige,
                        einfach.get(c.kanal()), null, null, null, null, anlageIndex, komponenteIndex, ci));
            } else if (vorzeichen.contains(c.kanal())) {
                boolean kandidat = GERAET.equals(k.rolle()) && (vorschlagBezug != null || bestehend != null);
                ausgelassen.add(new RohAusgelassen(a.id(), k.id(), c.kanal(), anzeige,
                        kandidat ? "vergleich_kandidat" : "vorzeichen_wert",
                        kandidat && vorschlagBezug == null ? bestehend.messstelle() : null,
                        kandidat ? vorschlagBezug : null, null, null, anlageIndex, komponenteIndex, ci));
            } else if (vergleichBestehend.containsKey(c.kanal())) {
                ausgelassen.add(new RohAusgelassen(a.id(), k.id(), c.kanal(), anzeige,
                        "vergleich_kandidat", vergleichBestehend.get(c.kanal()), null, null, null,
                        anlageIndex, komponenteIndex, ci));
            } else if (gleicherFluss.containsKey(c.kanal())) {
                ausgelassen.add(new RohAusgelassen(a.id(), k.id(), c.kanal(), anzeige,
                        "gleicher_fluss", null, gleicherFluss.get(c.kanal()), null, null,
                        anlageIndex, komponenteIndex, ci));
            } else if (gleicherFlussBestehend.containsKey(c.kanal())) {
                ausgelassen.add(new RohAusgelassen(a.id(), k.id(), c.kanal(), anzeige,
                        "gleicher_fluss", gleicherFlussBestehend.get(c.kanal()), null, null, null,
                        anlageIndex, komponenteIndex, ci));
            } else if (passtNicht.containsKey(c.kanal())) {
                ausgelassen.add(new RohAusgelassen(a.id(), k.id(), c.kanal(), anzeige,
                        "passt_nicht", null, null, passtNicht.get(c.kanal()), c.einheit(),
                        anlageIndex, komponenteIndex, ci));
            }
        }
    }

    /** Zählerstände zuerst: aus einem Zählerstand wird eine Wirkenergie ohne Rechenweg. */
    private static List<VorschlagKanal> nachWertart(List<VorschlagKanal> kandidaten) {
        List<VorschlagKanal> reihe = new ArrayList<>(
                kandidaten.stream().filter(c -> COUNTER.equals(c.wertart())).toList());
        reihe.addAll(kandidaten.stream().filter(c -> !COUNTER.equals(c.wertart())).toList());
        return reihe;
    }

    private static VorschlagQuelle quelle(VorschlagKanal c, Passung p) {
        return new VorschlagQuelle(c.kanal(), c.anzeigename(), c.wertart(), p.herleitung());
    }

    private static void hinweise(Roh r, String herleitung, boolean standortSpaeter, boolean gewechselt) {
        if ("integration".equals(herleitung)) {
            r.hinweise.add("integration");
        }
        if (gewechselt) {
            r.hinweise.add("geraet_gewechselt");
        }
        if (standortSpaeter) {
            r.hinweise.add("standort_spaeter");
        }
    }

    /** Legt den Vorschlag an — mit Stellung und „Unterzähler von“ aus Topologie und Fluss. */
    private static Roh neuerRoh(VorschlagAnlage a, VorschlagKomponente k, int anlageIndex,
            int komponenteIndex, String fluss, Groesse ziel, VorschlagQuelle quelle,
            OffsetDateTime ab, List<Roh> rohe) {
        String stellung = null;
        VorschlagHauptzaehler bestehend = null;
        Roh bezug = null;
        if (LADESTAND.equals(fluss) || speicherFluss(fluss)) {
            stellung = SPEICHER;
        } else if ("Erzeugung".equals(fluss)) {
            stellung = ERZEUGER;
        } else if (NETZMESSUNG.equals(k.rolle()) && a.netzanschluss()) {
            boolean fremderZaehler = (a.hauptzaehler() == null ? List.<VorschlagHauptzaehler>of()
                    : a.hauptzaehler()).stream()
                    .anyMatch(h -> h.komponente() == null || !h.komponente().equals(k.id()));
            stellung = fremderZaehler ? null : HAUPTZAEHLER;
        } else if (BEZUG.equals(fluss)) {
            Roh v = bezugVorschlag(rohe, a, BEZUG);
            VorschlagHauptzaehler b = hauptzaehler(a, BEZUG);
            if (v != null) {
                stellung = UNTERZAEHLER;
                bezug = v;
            } else if (b != null) {
                stellung = UNTERZAEHLER;
                bestehend = b;
            }
        }
        Roh r = new Roh(a, k, anlageIndex, komponenteIndex,
                LADESTAND.equals(fluss) ? VORSCHLAG_FLUESSE.size() : VORSCHLAG_FLUESSE.indexOf(fluss),
                ziel, quelle, stellung, bestehend, bezug, ab);
        rohe.add(r);
        return r;
    }

    private static boolean speicherFluss(String fluss) {
        return "Laden / Entladen".equals(fluss) || "Laden".equals(fluss) || "Entladen".equals(fluss);
    }

    /** Der Bezug-Hauptzähler-Vorschlag DERSELBEN Anlage, wenn es ihn schon gibt. */
    private static Roh bezugVorschlag(List<Roh> rohe, VorschlagAnlage a, String richtung) {
        return rohe.stream().filter(r -> r.anlage == a && HAUPTZAEHLER.equals(r.stellung)
                && richtung.equals(r.hauptgroesse.richtung())).findFirst().orElse(null);
    }

    private static VorschlagHauptzaehler hauptzaehler(VorschlagAnlage a, String richtung) {
        return (a.hauptzaehler() == null ? List.<VorschlagHauptzaehler>of() : a.hauptzaehler()).stream()
                .filter(h -> richtung.equals(h.richtung())).findFirst().orElse(null);
    }

    /** Der Fluss eines Messwerts: seine Vertrags-Richtung, wenn sie eine Wirkgröße trägt. */
    private static String fluss(VorschlagKanal c) {
        if (!WIRKENERGIE.equals(c.groesse()) && !WIRKLEISTUNG.equals(c.groesse())) {
            return null;
        }
        return enthaelt(VORSCHLAG_FLUESSE, c.richtung()) ? c.richtung() : null;
    }

    /**
     * Wie viele Flüsse der Komponente schon eine Messstelle speisen — zusammen mit ihren
     * Vorschlägen sagen sie, ob der Name den Fluss nennen muss („Netzzähler Halle 1 · Bezug“).
     */
    private static long gespeisteFluesse(VorschlagKomponente k) {
        Set<String> gesehen = new HashSet<>();
        for (VorschlagKanal c : k.messkanaele() == null ? List.<VorschlagKanal>of() : k.messkanaele()) {
            if (c.speist() == null || attributKanal(c)) {
                continue;
            }
            String f = fluss(c);
            if (f != null) {
                gesehen.add(f);
            } else if (LADESTAND.equals(c.groesse())) {
                gesehen.add(LADESTAND);
            }
        }
        return gesehen.size();
    }

    /** Ein Attribut-Kanal: eine Herkunft, eine Freigabe, eine Grenze oder ein Zustand (P4, P5b, P5c). */
    private static boolean attributKanal(VorschlagKanal c) {
        String kanal = c.kanal() == null ? "" : c.kanal();
        if (ATTRIBUT_KANAELE.contains(kanal) || kanal.startsWith(ATTRIBUT_PRAEFIX)) {
            return true;
        }
        return c.wertart() != null && !COUNTER.equals(c.wertart()) && !GAUGE.equals(c.wertart());
    }

    private static boolean hatKanal(List<VorschlagKanal> kanaele, String kanal) {
        return kanaele.stream().anyMatch(c -> kanal.equals(c.kanal()));
    }

    private static int stellungRang(String stellung) {
        if (HAUPTZAEHLER.equals(stellung)) {
            return 0;
        }
        if (ERZEUGER.equals(stellung)) {
            return 1;
        }
        if (SPEICHER.equals(stellung)) {
            return 2;
        }
        return UNTERZAEHLER.equals(stellung) ? 3 : 4;
    }

    /** Was hinter den Namen der Komponente tritt, wenn sie mehr als einen Fluss liest. */
    private static String nameZusatz(Groesse g) {
        return LADESTAND.equals(g.groesse()) ? LADESTAND : g.richtung();
    }

    private static String einheit(String groesse) {
        KatalogEintrag e = katalog(groesse);
        return e == null ? null : e.einheit();
    }

    private static String anzeige(VorschlagKanal c) {
        return leer(c.anzeigename()) ? c.kanal() : c.anzeigename();
    }

    private static String hinweisText(String code) {
        return switch (code) {
            case "integration" -> "Die Wirkenergie wird aus der Leistung integriert — gekennzeichnet.";
            case "ladestand_herkunft" -> "Die Herkunft des Ladestands reist mit (soc_source_code).";
            case "geraet_gewechselt" -> "Das Gerät wurde gewechselt — die Messstelle beginnt beim "
                    + "heutigen Gerät; die Zeit davor verketten Sie von Hand.";
            case "standort_spaeter" -> "Der Verlauf beginnt vor dem Standort — die Messstelle "
                    + "beginnt mit ihm.";
            default -> null;
        };
    }

    private static String ausgelassenText(RohAusgelassen x, String zu) {
        String was = "„" + x.anzeige() + "“";
        return switch (x.grund()) {
            case "abgeleitet" -> was + " ist keine Messung, sondern eine Ableitung der Box — eine "
                    + "berechnete Messstelle kommt später.";
            case "ohne_messkanal" -> was + " liest keinen Messwert — ohne Messwert gibt es keine "
                    + "Messstelle.";
            case "ohne_geraet" -> was + " wird gerade von keinem Gerät gespeist — ohne Gerät gibt es "
                    + "keine Quelle.";
            case "attribut_kanal" -> was + " ist ein Attribut (Zustand, Grenze, Freigabe oder "
                    + "Herkunft), kein Messwert — daraus wird nie eine Messstelle.";
            case "keine_messgroesse" -> was + " misst keine Größe, die eine Messstelle trägt.";
            case "ohne_richtung" -> was + " nennt keine Richtung — ob Bezug, Abgabe oder Erzeugung, "
                    + "sagt der Messwert nicht.";
            case "weitere_groesse" -> was + " misst eine weitere Größe — sie kommt als Nebengröße "
                    + "von Hand dazu.";
            case "vorzeichen_wert" -> was + " trägt Bezug und Abgabe in einem Vorzeichen — er wird keine "
                    + "eigene Messstelle; sein positiver und sein negativer Anteil kommen als Nebengröße von Hand "
                    + "an Bezug und Abgabe.";
            case "vergleich_kandidat" -> was + " misst den Netzanschluss ein zweites Mal — ein "
                    + "Kandidat für eine Vergleichsquelle an " + zu + ", nie eine eigene Messstelle.";
            case "gleicher_fluss" -> was + " misst denselben Fluss wie " + zu + " — als Nebengröße "
                    + "oder Vergleichsquelle von Hand.";
            case "passt_nicht" -> "einheit".equals(x.passungGrund())
                    ? was + " hat eine Einheit, die sich nicht umrechnen lässt („" + x.einheit() + "“)."
                    : was + " passt nicht zu dieser Größe (" + x.passungGrund() + ").";
            default -> null;
        };
    }

    private static LocalDate tag(OffsetDateTime t, ZoneId zone) {
        return t.atZoneSameInstant(zone).toLocalDate();
    }

    private static LocalDate spaeter(LocalDate a, LocalDate b) {
        return b.isAfter(a) ? b : a;
    }

    private static OffsetDateTime mitternacht(LocalDate tag, ZoneId zone) {
        return tag.atStartOfDay(zone).toOffsetDateTime();
    }

    // ------------------------------------------------------------------ Hilfen

    /** Die Auflösung eines Zeitpunkts ist die Minute (E2). */
    private static OffsetDateTime minute(OffsetDateTime t) {
        return t.truncatedTo(ChronoUnit.MINUTES);
    }

    private static boolean gilt(OffsetDateTime ab, OffsetDateTime bis, OffsetDateTime t) {
        return !t.isBefore(ab) && (bis == null || t.isBefore(bis));
    }

    /** Überschneiden sich {@code [ab1, bis1)} und {@code [ab2, bis2)}? {@code null} = offen. */
    private static boolean ueberschneiden(
            OffsetDateTime ab1, OffsetDateTime bis1, OffsetDateTime ab2, OffsetDateTime bis2) {
        return (bis2 == null || ab1.isBefore(bis2)) && (bis1 == null || ab2.isBefore(bis1));
    }

    /** {@code List.of(…).contains(null)} wirft — ein fehlendes Wort steht schlicht nicht im Vokabular. */
    private static boolean enthaelt(List<String> vokabular, String wort) {
        return wort != null && vokabular.contains(wort);
    }

    private static boolean leer(String s) {
        return s == null || s.isBlank();
    }
}
