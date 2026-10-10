package com.voltpilot.api.uems;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Die VORSCHAU eines Imports als reines Modul (UEMS AP-09 §4.6 C2–C5 und C8, IP-12).
 *
 * <p><b>Sie zeigt alles und schreibt nichts.</b> Aus den Bytes einer Datei und einer Zuordnung
 * (C3) wird je Datenzeile ein Urteil mit Befunden, und je Datei ein Fingerabdruck und die Zähler.
 * Das Modul hat keine Datenbank; was schon gespeichert ist, bekommt es als Anfrage hereingereicht
 * ({@link Bestaende}, {@link Importe}) und fragt nur. Zweimal dieselbe Vorschau mit demselben
 * Bestand ergibt dasselbe {@link Ergebnis} — Zeichen für Zeichen.
 *
 * <p><b>Aufgerufen, nicht nachgebaut:</b> die Bytes liest {@link CsvLeser} (C1), die Zahl
 * {@link BezugsdatenRegeln#zahl}, die Einheit {@link BezugsEinheit}, Periode und Zeitpunkt
 * {@link BezugsPeriode}, die Plausibilität {@link BezugsdatenRegeln#plausibilitaet}, das Urteil
 * {@link BezugsdatenRegeln#urteil} und die Zähler {@link BezugsdatenRegeln#importErgebnis}.
 * Hier stehen nur die Reihenfolge, die Zuordnung der Spalten, die Dubletten INNERHALB der Datei
 * und die beiden Fingerabdrücke.
 *
 * <p><b>Die Prüfreihenfolge ist ergebnisrelevant</b> ({@code regeln.pruefreihenfolge}): Zahl →
 * Einheit → Periode bzw. Zeit (dann die Plausibilität) → Bezug → Schlüssel. Die erste Stufe mit
 * einem Befund, der die Zeile verhindert, spricht; ein Hinweis ({@code einheit_umgerechnet},
 * {@code wert_unplausibel}) läuft weiter. Ohne auflösbaren Bezug gibt es keine Zieleinheit und
 * keine Periodenart: dann spricht nach der Zahl der Bezug.
 *
 * <p><b>Zwei Fingerabdrücke (C2/E8):</b> die DATEI ist SHA-256 ihrer Bytes, wie sie hochgeladen
 * wurden. Die ZEILE ist SHA-256 ihres fachlichen Schlüssels plus des normalisierten Betrags —
 * {@code <bezugsgroesse_id>|<periode oder Zeitpunkt in UTC>|<Betrag in der Einheit der
 * Bezugsgröße>} — und NIE ihr Text: dieselben Werte in anderer Spaltenreihenfolge, mit anderem
 * Trennzeichen oder in t statt kg sind dieselbe Zeile.
 *
 * <p><b>Die Vorschau-Kennung ist kurzlebig</b> ({@link #GUELTIG}) und kein Auftrag: sie reserviert
 * nichts und berechtigt zu nichts. Sie bindet Kundenbereich, Ergebnis und Ausstellungszeit;
 * {@link #kennungPruefen} sagt, ob sie noch zu genau diesem Ergebnis gehört. Die Datei selbst wird
 * nie aufbewahrt (E14) — eine Übernahme bringt sie noch einmal mit und rechnet neu.
 */
public final class ImportVorschau {

    private ImportVorschau() {}

    /** So lange gehört eine Vorschau-Kennung zu ihrem Ergebnis; danach wird neu gerechnet. */
    public static final Duration GUELTIG = Duration.ofMinutes(30);

    /** Die Form der Kennung: {@code VS1.<ausgestellt, Sekunden seit 1970>.<32 hex>}. */
    public static final String KENNUNG_FASSUNG = "VS1";

    private static final Pattern KENNUNG = Pattern.compile("VS1\\.([0-9]{1,12})\\.([0-9a-f]{32})");

    /** Die Antworten von {@link #kennungPruefen}. */
    public static final String KENNUNG_GUELTIG = "gueltig";
    public static final String KENNUNG_ABGELAUFEN = "abgelaufen";
    public static final String KENNUNG_VERALTET = "veraltet";
    public static final String KENNUNG_UNLESBAR = "unlesbar";

    /** Die Rollen einer Spalte (C3). */
    public static final List<String> ROLLEN = List.of("periode", "bis", "wert", "einheit", "bezug", "bemerkung");

    public static final List<String> ZAHLFORMATE = List.of("de", "en", "auto");

    /** Die Deutungen der Periodenspalte (Z3) — Zeile für Zeile {@code vokabulare.deutung} des Vertrags. */
    public static final List<String> DEUTUNGEN = List.of("periode", "periodenbeginn", "periodenende", "von_bis", "zeitpunkt");

    /** Die Import-Status, nach denen eine Datei „bekannt“ ist: nur ein Import, der etwas geschrieben hat. */
    public static final List<String> SCHREIBENDE_IMPORTE = List.of(
            BezugsdatenRegeln.UEBERNOMMEN, BezugsdatenRegeln.TEILWEISE_UEBERNOMMEN, BezugsdatenRegeln.ZURUECKGENOMMEN);

    /** Der Status der Vorschau selbst — sie ist nie ein gespeicherter Import. */
    public static final String VORSCHAU = "vorschau";

    public static final String BEZUG_UNBEKANNT = "bezug_unbekannt";
    public static final String ZEILE_BEKANNT = "zeile_bekannt";

    /**
     * Die Kundensätze der Befunde, die kein anderes Modul spricht. {@code ImportVorschauTest} prüft
     * sie zusammen mit denen von {@link CsvLeser}, {@link BezugsPeriode} und {@link BezugsEinheit}
     * Wort für Wort gegen {@code befund_saetze} der Vektor-Datei.
     */
    public static final Map<String, String> SAETZE = Map.of(
            BezugsdatenRegeln.DATEI_BEKANNT, "Diese Datei wurde schon übernommen.",
            ZEILE_BEKANNT, "Für diesen Zeitraum gibt es schon einen Wert.",
            BezugsdatenRegeln.KONFLIKT_ANDERER_WERT, "Für diesen Zeitraum gibt es schon einen anderen Wert.",
            BezugsdatenRegeln.ZAHL_UNLESBAR, "Diese Zahl ist nicht lesbar.",
            BEZUG_UNBEKANNT, "Zu diesem Text gibt es keine Bezugsgröße. Ordnen Sie ihn in der Vorlage zu.",
            BezugsdatenRegeln.WERT_NEGATIV, "Ein Wert unter null wird nicht übernommen.",
            BezugsdatenRegeln.WERT_UNPLAUSIBEL, "Dieser Wert ist auffällig — bitte prüfen.");

    private static final Pattern OFFSET = Pattern.compile("^(.*?)\\s*(Z|[+-][0-9]{2}:[0-9]{2})$");

    // ------------------------------------------------------------------ Ein- und Ausgang

    /** Die Spalten der Rollen, 1-basiert wie ein Mensch zählt; {@code null} = keine Spalte. */
    public record Spalten(Integer periode, Integer bis, Integer wert, Integer einheit, Integer bezug, Integer bemerkung) {}

    /**
     * C3 — die Zuordnung. {@code csv} hält fest, was der Leser nicht erkennen soll. {@code einheit}
     * gilt ohne Einheitsspalte (U3: ohne beides gilt die Einheit der Bezugsgröße),
     * {@code bezugsgroesse} (ein Kennzeichen) ohne Bezug-Spalte für die ganze Datei.
     * {@code bezugTabelle} ordnet einen Text der Bezug-Spalte einem Kennzeichen zu, {@code synonyme}
     * ein Einheitenwort einem Wort des Vokabulars (U2).
     */
    public record Zuordnung(
            CsvLeser.Vorgabe csv,
            Spalten spalten,
            String deutung,
            String zahlformat,
            String einheit,
            String bezugsgroesse,
            Map<String, String> bezugTabelle,
            Map<String, String> synonyme) {}

    /** Eine Bezugsgröße, die Werte aufnehmen kann, mit der Zeitzone ihres Standorts (Z1). */
    public record Ziel(
            UUID id, String kennzeichen, String wertart, String einheit, String periodeArt, ZoneId zone, int einheitenGebunden) {}

    /** Ein gespeicherter Import derselben Datei: Kennung, heutiger Status, Zeitpunkt der Übernahme. */
    public record FruehererImport(String kennung, String status, Instant am) {}

    /** Das Vokabular der Einheiten je Größe und die erlaubten Umrechnungen (U1). */
    public record Grundlagen(Map<String, List<String>> einheiten, List<BezugsEinheit.Umrechnung> umrechnungen) {}

    /** Der wirksame Stand eines Schlüssels — oder {@code null}, wenn er unbelegt ist. */
    @FunctionalInterface
    public interface Bestaende {
        /** @param schluessel der Periodenschlüssel ({@code 2026-10}) oder der Zeitpunkt in UTC */
        BezugsdatenRegeln.Bestand am(Ziel ziel, String schluessel);
    }

    /** Die gespeicherten Importe einer Datei nach ihrem Fingerabdruck. */
    @FunctionalInterface
    public interface Importe {
        List<FruehererImport> mitFingerabdruck(String sha256);
    }

    /** Die Datei, wie der Leser sie gesehen hat, mit ihrem Fingerabdruck. */
    public record Datei(
            String sha256,
            int bytes,
            String befund,
            String zusatz,
            Integer zeile,
            String kodierung,
            Boolean bom,
            String trennzeichen,
            Boolean kopfzeile,
            List<String> kopf,
            Integer spalten,
            Integer datenzeilen) {}

    /**
     * Eine beurteilte Datenzeile. {@code felder} sind zur ANZEIGE neutralisiert. {@code schluessel},
     * {@code betrag} und {@code fingerabdruck} stehen, sobald die Zeile die Stufe Schlüssel erreicht
     * hat; {@code bestand} ist der wirksame Stand dieses Schlüssels.
     */
    public record Zeile(
            int nr,
            List<String> felder,
            String bezugsgroesse,
            UUID bezugsgroesseId,
            String schluessel,
            String periode,
            Instant von,
            Instant bis,
            Instant zeitpunkt,
            BigDecimal betrag,
            String einheit,
            String geliefertWert,
            String geliefertEinheit,
            String urteil,
            List<String> befunde,
            String fingerabdruck,
            BezugsdatenRegeln.Bestand bestand) {}

    /** Die ganze Vorschau. {@code ergebnisFingerabdruck} ist, was die Kennung bindet. */
    public record Ergebnis(
            Datei datei,
            FruehererImport fruehererImport,
            List<Zeile> zeilen,
            BezugsdatenRegeln.Importergebnis importergebnis,
            String ergebnisFingerabdruck) {}

    // ------------------------------------------------------------------ Die Vorschau

    /**
     * C4 — die Vorschau einer Datei. Wirft für keine Datei; eine Zuordnung außerhalb der Wörter
     * ({@link #ROLLEN}, {@link #ZAHLFORMATE}, Deutung) ist ein Programmierfehler der aufrufenden
     * Stelle, die sie vorher prüft.
     *
     * @param ziele die Bezugsgrößen nach Kennzeichen, die Werte aufnehmen können
     */
    public static Ergebnis vorschau(
            byte[] datei,
            Zuordnung zuordnung,
            Map<String, Ziel> ziele,
            Bestaende bestaende,
            Importe importe,
            Grundlagen grundlagen,
            Instant jetzt) {
        byte[] bytes = datei == null ? new byte[0] : datei;
        String sha = sha256(bytes);
        CsvLeser.Ergebnis gelesen = CsvLeser.lies(bytes, zuordnung.csv());
        Datei d = new Datei(sha, bytes.length, gelesen.befund(), gelesen.zusatz(), gelesen.zeile(), gelesen.kodierung(),
                gelesen.bom(), gelesen.trennzeichen(), gelesen.kopfzeile(), gelesen.kopf(), gelesen.spalten(),
                gelesen.datenzeilen());
        FruehererImport frueher = frueher(importe.mitFingerabdruck(sha));
        boolean bekannt = frueher != null;
        String fruehererStatus = frueher == null ? null : frueher.status();

        if (!gelesen.gelesen()) {
            BezugsdatenRegeln.Importergebnis leer = CsvLeser.KEINE_DATENZEILEN.equals(gelesen.befund())
                    ? BezugsdatenRegeln.importErgebnis(0, bekannt, fruehererStatus, List.of())
                    : new BezugsdatenRegeln.Importergebnis(null, new BezugsdatenRegeln.Zaehler(0, 0, 0, 0, 0, 0, 0, 0),
                            false, false, null, 0, List.of(gelesen.befund()));
            return new Ergebnis(d, frueher, List.of(), leer, ergebnisFingerabdruck(d, frueher, List.of(), leer));
        }

        List<Vorlaeufig> vorlaeufig = new ArrayList<>();
        for (CsvLeser.Zeile z : gelesen.zeilen()) {
            vorlaeufig.add(stufen(z, zuordnung, ziele, grundlagen, jetzt));
        }

        // Stufe Schlüssel: Dubletten INNERHALB der Datei (§4.7) vor dem Bestand. Nur Zeilen, die
        // bis hierher gekommen sind, zählen — die Zeile mit „lbs“ vergleicht sich mit niemandem (B13).
        Map<String, List<Vorlaeufig>> jeSchluessel = new LinkedHashMap<>();
        for (Vorlaeufig v : vorlaeufig) {
            if (v.schluesselErreicht()) {
                jeSchluessel.computeIfAbsent(v.ziel.id() + "|" + v.schluesselRoh, k -> new ArrayList<>()).add(v);
            }
        }

        List<Zeile> zeilen = new ArrayList<>();
        List<BezugsdatenRegeln.Zeilenurteil> urteile = new ArrayList<>();
        for (Vorlaeufig v : vorlaeufig) {
            BezugsdatenRegeln.Bestand gespeichert = null;
            BezugsdatenRegeln.Bestand bestand = null;
            List<String> befundeVorher = new ArrayList<>(v.befunde);
            String fingerabdruck = null;
            if (v.schluesselErreicht()) {
                List<Vorlaeufig> gruppe = jeSchluessel.get(v.ziel.id() + "|" + v.schluesselRoh);
                gespeichert = bestaende.am(v.ziel, v.schluesselRoh);
                bestand = gespeichert;
                boolean widerspruechlich = gruppe.stream().anyMatch(o -> o.betrag.compareTo(v.betrag) != 0);
                if (widerspruechlich) {
                    befundeVorher.add(BezugsdatenRegeln.KONFLIKT_ANDERER_WERT);
                } else if (gruppe.get(0) != v) {
                    // Gleicher Betrag: nur die erste zählt, jede weitere ist ihre Wiederholung.
                    bestand = new BezugsdatenRegeln.Bestand(gruppe.get(0).betrag, 0, null);
                }
                fingerabdruck = zeilenFingerabdruck(v.ziel.id(), v.schluesselRoh, v.betrag);
            }
            BezugsdatenRegeln.Urteil u = BezugsdatenRegeln.urteil(
                    v.schluesselText(), v.betrag, bestand, bekannt, fruehererStatus, null, befundeVorher);
            urteile.add(new BezugsdatenRegeln.Zeilenurteil(u.urteil(), u.befunde()));
            zeilen.add(new Zeile(v.nr, v.felder, v.ziel == null ? null : v.ziel.kennzeichen(),
                    v.ziel == null ? null : v.ziel.id(), v.schluesselText(), v.periode, v.von, v.bis, v.zeitpunkt,
                    v.betrag, v.ziel == null ? null : v.ziel.einheit(), v.geliefertWert, v.geliefertEinheit, u.urteil(),
                    u.befunde(), fingerabdruck, gespeichert));
        }
        BezugsdatenRegeln.Importergebnis ergebnis =
                BezugsdatenRegeln.importErgebnis(zeilen.size(), bekannt, fruehererStatus, urteile);
        return new Ergebnis(d, frueher, List.copyOf(zeilen), ergebnis, ergebnisFingerabdruck(d, frueher, zeilen, ergebnis));
    }

    /** Die Zeile auf ihrem Weg durch die Stufen bis vor den Schlüssel. */
    private static final class Vorlaeufig {
        int nr;
        List<String> felder;
        Ziel ziel;
        String geliefertWert;
        String geliefertEinheit;
        BigDecimal betrag;
        String periode;
        Instant von;
        Instant bis;
        Instant zeitpunkt;
        /** Periodenschlüssel oder Zeitpunkt in UTC — der Schlüssel ohne die Bezugsgröße. */
        String schluesselRoh;
        final List<String> befunde = new ArrayList<>();
        boolean abgebrochen;

        boolean schluesselErreicht() {
            return !abgebrochen && ziel != null && schluesselRoh != null && betrag != null;
        }

        String schluesselText() {
            if (ziel == null || schluesselRoh == null) {
                return null;
            }
            return ziel.kennzeichen() + " · " + (periode != null ? periode : BezugsPeriode.iso(zeitpunkt, ziel.zone()));
        }

        void befund(String b) {
            befunde.add(b);
            if (!BezugsdatenRegeln.HINWEIS_BEFUNDE.contains(b)) {
                abgebrochen = true;
            }
        }
    }

    private static Vorlaeufig stufen(
            CsvLeser.Zeile z, Zuordnung zu, Map<String, Ziel> ziele, Grundlagen g, Instant jetzt) {
        Vorlaeufig v = new Vorlaeufig();
        v.nr = z.nr();
        v.felder = z.anzeige();
        v.ziel = ziel(z, zu, ziele);
        v.geliefertWert = feld(z, zu.spalten().wert());
        String einheitText = zu.spalten().einheit() != null ? feld(z, zu.spalten().einheit()) : zu.einheit();
        v.geliefertEinheit = einheitText == null || einheitText.isBlank() ? null : einheitText.trim();

        // Zahl
        boolean ganzzahlig = v.ziel != null && BezugsEinheit.istGanzzahlig(v.ziel.einheit());
        BezugsdatenRegeln.Zahl zahl = BezugsdatenRegeln.zahl(v.geliefertWert, zu.zahlformat(), ganzzahlig);
        if (zahl.befund() != null) {
            v.befund(zahl.befund());
            return v;
        }
        if (v.ziel == null) {
            v.befund(BEZUG_UNBEKANNT);
            return v;
        }
        // Einheit
        BezugsEinheit.Einheitswert ew = BezugsEinheit.einheit(zahl.betrag(), v.geliefertEinheit, v.ziel.einheit(),
                g.einheiten(), g.umrechnungen(), zu.synonyme() == null ? Map.of() : zu.synonyme());
        ew.befunde().forEach(v::befund);
        if (v.abgebrochen) {
            return v;
        }
        v.betrag = ew.betrag();
        // Periode bzw. Zeit
        Integer stunden = null;
        if ("stand".equals(v.ziel.wertart())) {
            String text = feld(z, zu.spalten().periode());
            String offset = null;
            if (text != null) {
                Matcher m = OFFSET.matcher(text.trim());
                if (m.matches()) {
                    text = m.group(1);
                    offset = m.group(2);
                }
            }
            BezugsPeriode.Zeitdeutung zd = BezugsPeriode.zeitpunkt(text, v.ziel.zone(), offset);
            if (zd.befund() != null) {
                v.befund(zd.befund());
                return v;
            }
            if (jetzt != null && zd.zeitpunkt().isAfter(jetzt)) {
                v.befund(BezugsdatenRegeln.PERIODE_NICHT_ZU_ENDE);
                return v;
            }
            v.zeitpunkt = zd.zeitpunkt().truncatedTo(ChronoUnit.MINUTES).equals(zd.zeitpunkt()) ? zd.zeitpunkt() : null;
            if (v.zeitpunkt == null) {
                v.befund(BezugsdatenRegeln.DATUM_UNLESBAR);
                return v;
            }
            v.schluesselRoh = v.zeitpunkt.toString();
        } else {
            boolean vonBis = "von_bis".equals(zu.deutung());
            String text = feld(z, zu.spalten().periode());
            BezugsPeriode.Periodendeutung pd = BezugsPeriode.periode(vonBis ? null : text, vonBis ? text : null,
                    vonBis ? feld(z, zu.spalten().bis()) : null, zu.deutung(), v.ziel.periodeArt(), v.ziel.zone(), jetzt);
            if (pd.befund() != null) {
                v.befund(pd.befund());
                return v;
            }
            v.periode = pd.schluessel();
            v.von = pd.von();
            v.bis = pd.bis();
            v.schluesselRoh = pd.schluessel();
            if ("tag".equals(v.ziel.periodeArt())) {
                LocalDate tag = LocalDate.parse(pd.schluessel());
                stunden = (int) BezugsPeriode.stundenDesTages(tag, v.ziel.zone());
            }
        }
        String plausibel = BezugsdatenRegeln.plausibilitaet(v.betrag, v.ziel.einheit(), stunden, v.ziel.einheitenGebunden());
        if (plausibel != null) {
            v.befund(plausibel);
        }
        return v;
    }

    /** Bezug-Spalte über die Tabelle (oder ein Kennzeichen wörtlich), sonst die feste Bezugsgröße. */
    private static Ziel ziel(CsvLeser.Zeile z, Zuordnung zu, Map<String, Ziel> ziele) {
        if (zu.spalten().bezug() == null) {
            return zu.bezugsgroesse() == null ? null : ziele.get(zu.bezugsgroesse());
        }
        String text = feld(z, zu.spalten().bezug());
        if (text == null) {
            return null;
        }
        String kennzeichen = zu.bezugTabelle() == null ? null : zu.bezugTabelle().get(text.trim());
        return ziele.get(kennzeichen != null ? kennzeichen : text.trim());
    }

    private static String feld(CsvLeser.Zeile z, Integer spalte) {
        if (spalte == null || spalte < 1 || spalte > z.felder().size()) {
            return null;
        }
        return z.felder().get(spalte - 1);
    }

    /** Der jüngste Import dieser Datei, der etwas geschrieben hat; Wiederholungen und Verworfene zählen nicht. */
    static FruehererImport frueher(List<FruehererImport> importe) {
        if (importe == null) {
            return null;
        }
        return importe.stream()
                .filter(i -> SCHREIBENDE_IMPORTE.contains(i.status()))
                .max(Comparator.comparing(FruehererImport::am).thenComparing(FruehererImport::kennung))
                .orElse(null);
    }

    // ------------------------------------------------------------------ Fingerabdrücke und Kennung

    /** C2 — SHA-256 der Bytes, klein geschrieben. */
    public static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 fehlt in dieser JVM", e);
        }
    }

    /**
     * C2 — der Fingerabdruck einer Zeile aus ihrem FACHLICHEN Schlüssel und dem normalisierten
     * Betrag: {@code <bezugsgroesse_id>|<schluessel>|<betrag ohne Nachkomma-Nullen>}.
     */
    public static String zeilenFingerabdruck(UUID bezugsgroesse, String schluessel, BigDecimal betrag) {
        String normal = betrag.signum() == 0 ? "0" : betrag.stripTrailingZeros().toPlainString();
        return sha256((bezugsgroesse + "|" + schluessel + "|" + normal).getBytes(StandardCharsets.UTF_8));
    }

    /** Was die Kennung bindet: die Datei, was der Kunde über jede Zeile erfährt, und die Zähler. */
    static String ergebnisFingerabdruck(
            Datei d, FruehererImport frueher, List<Zeile> zeilen, BezugsdatenRegeln.Importergebnis e) {
        StringBuilder s = new StringBuilder();
        s.append(d.sha256()).append('|').append(d.befund()).append('|').append(d.zusatz()).append('|')
                .append(d.kodierung()).append('|').append(d.trennzeichen()).append('|').append(d.kopfzeile()).append('\n');
        s.append(frueher == null ? "-" : frueher.kennung() + "|" + frueher.status()).append('\n');
        for (Zeile z : zeilen) {
            s.append(z.nr()).append('|').append(z.bezugsgroesseId()).append('|').append(z.schluessel()).append('|')
                    .append(z.betrag() == null ? "-" : z.betrag().stripTrailingZeros().toPlainString()).append('|')
                    .append(z.urteil()).append('|').append(String.join(",", z.befunde())).append('|')
                    .append(z.bestand() == null ? "-" : z.bestand().fassung() + ":" + z.bestand().betrag())
                    .append('\n');
        }
        s.append(e.status()).append('|').append(e.zaehler()).append('|').append(e.befunde());
        return sha256(s.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** Die Vorschau-Kennung zu einem Ergebnis, ausgestellt auf die Sekunde. */
    public static String kennung(UUID kundenbereich, String ergebnisFingerabdruck, Instant ausgestellt) {
        long sekunde = ausgestellt.getEpochSecond();
        String bindung = sha256((kundenbereich + "|" + ergebnisFingerabdruck + "|" + sekunde)
                .getBytes(StandardCharsets.UTF_8)).substring(0, 32);
        return KENNUNG_FASSUNG + "." + sekunde + "." + bindung;
    }

    /** Ausgestellt-Zeitpunkt einer lesbaren Kennung, sonst {@code null}. */
    public static Instant ausgestellt(String kennung) {
        Matcher m = kennung == null ? null : KENNUNG.matcher(kennung);
        return m != null && m.matches() ? Instant.ofEpochSecond(Long.parseLong(m.group(1))) : null;
    }

    /**
     * Gehört diese Kennung zu diesem Ergebnis? {@code unlesbar} (keine Kennung dieser Form),
     * {@code abgelaufen} (älter als {@link #GUELTIG} — die Vorschau wird neu gerechnet),
     * {@code veraltet} (ein anderer Kundenbereich, eine andere Datei oder ein Bestand, der sich
     * seitdem geändert hat) oder {@code gueltig}. Abgelaufen wird VOR veraltet gesagt: nach Ablauf
     * zählt nicht mehr, was damals zu sehen war.
     */
    public static String kennungPruefen(String kennung, UUID kundenbereich, String ergebnisFingerabdruck, Instant jetzt) {
        Instant ausgestellt = ausgestellt(kennung);
        if (ausgestellt == null) {
            return KENNUNG_UNLESBAR;
        }
        if (!jetzt.isBefore(ausgestellt.plus(GUELTIG)) || jetzt.isBefore(ausgestellt.minus(Duration.ofMinutes(1)))) {
            return KENNUNG_ABGELAUFEN;
        }
        return kennung(kundenbereich, ergebnisFingerabdruck, ausgestellt).equals(kennung)
                ? KENNUNG_GUELTIG
                : KENNUNG_VERALTET;
    }

    /** Der Kundensatz eines Befunds — aus dem Modul, das ihn spricht; die Fläche erfindet keinen. */
    public static String satz(String befund) {
        for (Map<String, String> saetze :
                List.of(SAETZE, CsvLeser.SAETZE, BezugsPeriode.SAETZE, BezugsEinheit.SAETZE)) {
            if (saetze.containsKey(befund)) {
                return saetze.get(befund);
            }
        }
        throw new NullPointerException("kein Kundensatz für " + befund);
    }

    /** Befunde einer Zuordnung prüfen, bevor gerechnet wird: {@code null} = in Ordnung, sonst das Feld. */
    public static String zuordnungFehler(Zuordnung z) {
        if (z.spalten() == null || z.spalten().wert() == null) {
            return "spalten.wert";
        }
        if (z.spalten().periode() == null) {
            return "spalten.periode";
        }
        for (Integer s : new Integer[] {z.spalten().periode(), z.spalten().bis(), z.spalten().wert(),
                z.spalten().einheit(), z.spalten().bezug(), z.spalten().bemerkung()}) {
            if (s != null && s < 1) {
                return "spalten";
            }
        }
        if (z.deutung() == null || !DEUTUNGEN.contains(z.deutung())) {
            return "deutung";
        }
        if ("von_bis".equals(z.deutung()) != (z.spalten().bis() != null)) {
            return "spalten.bis";
        }
        if (z.zahlformat() == null || !ZAHLFORMATE.contains(z.zahlformat())) {
            return "zahlformat";
        }
        if ((z.spalten().bezug() == null) == (z.bezugsgroesse() == null)) {
            return "bezugsgroesse";
        }
        if (z.spalten().einheit() != null && z.einheit() != null) {
            return "einheit";
        }
        return null;
    }


    /** Hilfe für Aufrufer mit Listen: Ziele nach Kennzeichen. */
    public static Map<String, Ziel> nachKennzeichen(List<Ziel> ziele) {
        Map<String, Ziel> aus = new LinkedHashMap<>();
        ziele.forEach(z -> aus.put(z.kennzeichen(), z));
        return aus;
    }

}
