package com.voltpilot.api.uems;

import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
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

    /** Woran ein Messwert an der Größe scheitert — in der Reihenfolge der Prüfung. */
    public static final List<String> PASSUNG_GRUENDE =
            List.of("wertart", "groesse", "einheit", "richtung");

    public static final List<String> HINWEISE = List.of("ablesestand_pruefen");

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

    /** Eine Größe des Katalogs. */
    public record KatalogEintrag(
            String groesse,
            List<String> medien,
            String einheit,
            List<String> richtungen,
            List<String> wertarten,
            List<KatalogQuelle> quellen) {}

    /**
     * Der Größen-Katalog (AP-04 §4.1). „Laden / Entladen“ bei der Wirkenergie ist
     * die zusammengefasste Richtung des Speichers (E1, MS-04); aus einer Leistung
     * wird nur eine Intervallmenge, nie ein Zählerstand.
     */
    public static final List<KatalogEintrag> GROESSEN_KATALOG = List.of(
            new KatalogEintrag("Wirkenergie", List.of(STROM), "kWh",
                    List.of("Bezug", "Abgabe", "Erzeugung", "Laden", "Entladen", "Laden / Entladen"),
                    List.of(ZAEHLERSTAND, "Intervallmenge"),
                    List.of(new KatalogQuelle("Wirkenergie", COUNTER, null),
                            new KatalogQuelle("Wirkleistung", GAUGE, "Intervallmenge"))),
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
     */
    public static GroesseUrteil groessePruefen(String medium, Groesse g) {
        KatalogEintrag e = katalog(g.groesse());
        String grund = e == null ? "groesse"
                : !enthaelt(e.medien(), medium) ? "medium"
                : !e.einheit().equals(g.einheit()) ? "einheit"
                : !enthaelt(e.richtungen(), g.richtung()) ? "richtung"
                : !enthaelt(e.wertarten(), g.wertart()) ? "wertart"
                : null;
        return new GroesseUrteil(grund == null ? null : Fehler.GROESSE_UNGUELTIG, grund);
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
     *     (der Vorzeichen-Wert {@code import_export} — die Aufteilung ist Sache von AP-08)
     * @param geraetBis bis wann dieser Einbau die Komponente speist; {@code null} = bis auf Weiteres
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
            OffsetDateTime geraetBis) {}

    /** Derselbe Messwert speist in diesem Zeitraum eine ANDERE Messstelle führend. */
    public record FremdeFuehrung(String messstelle, OffsetDateTime gueltigAb, OffsetDateTime gueltigBis) {}

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

    /** Das Urteil der Passung Messwert → Größe (Regel 7). */
    public record Passung(Fehler fehler, String grund, String herleitung) {}

    /**
     * Passt der Messwert zur Größe (Regel 7)? Medium Strom; dann die Wertart
     * (state/bitfield/text nie; Momentanwert nie aus Zählerstand; Zählerstand nie aus
     * Leistung), die Größe laut Katalog, eine umrechenbare Einheit, dieselbe
     * Richtung. Bei Erfolg sagt {@code herleitung}, wie aus dem Messwert die Größe
     * wird.
     */
    public static Passung passung(
            String medium, Groesse ziel, String kanalGroesse, String kanalRichtung,
            String kanalEinheit, String kanalWertart) {
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
        if (!ziel.richtung().equals(kanalRichtung)) {
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
     * schon anderswo → Zeitpunkt vor Vorgänger/Beginn → Überlappung.
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
                n.kanalEinheit(), n.kanalWertart());
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
                if (ueberschneiden(ab, bis, f.gueltigAb(), f.gueltigBis())) {
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
