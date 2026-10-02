package com.voltpilot.api.mispel;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.mispel.MispelAbgrenzungRepository.Zeile;
import com.voltpilot.api.uems.BerichtCsv;
import com.voltpilot.api.uems.BerichtRegeln;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.format.TextStyle;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * MiSpeL MP-16: Nachweis und Export der Abgrenzungsoption — die monatliche Mengenbestimmung und der Jahresnachweis für
 * die Mitteilung bis 31.05. (§ 21 Abs. 7 EnFG), je für Lieferant, Direktvermarkter oder Netzbetreiber, als CSV (hier) und
 * PDF ({@link MispelNachweisPdf}). Rein, ohne Spring und ohne Datenbank.
 *
 * <p><b>Nur aus den gespeicherten Läufen</b> ({@code mispel_abgrenzung_monat}, MP-8/MP-21): jede Zahl kommt aus dem
 * Nachweis-Text eines Laufs, dessen SHA-256 vorher gegen die gespeicherte Prüfsumme geprüft ist ({@link #lesen}) — so
 * sind die Werte die des Rechenwerks. Selbst gebildet wird nur ∑J, die Summe der Monatswerte der (Rumpf-)Monate eines
 * Kalenderjahres ((22), (33) usw., Anlage 1 S. 37, S. 39), über die Beiträge, die jeder Lauf selbst ausweist.
 *
 * <p><b>Stand (E4 = C, Bauplan § 8.5):</b> ein Monat oder Jahr ist nur {@code endgueltig} — und nur dann eine
 * Mengenbestimmung im Sinn der Festlegung —, wenn jeder seiner Läufe endgültig ist (Werte des Messstellenbetreibers, mess-
 * und eichrechtskonform, Tenor S. 28) und zwischen den Läufen keine Lücke liegt; das Jahr außerdem bis zum 31.12.
 * Vorläufige Zeiträume gehen sichtbar als vorläufig hinaus, nie als Mengenbestimmung beschriftet.
 *
 * <p><b>Partnerneutral (E8 = D):</b> der Empfänger ist eine Rolle der Festlegung, nie ein Unternehmen; alle drei bekommen
 * denselben Formelsatz, dasselbe Messkonzept und dieselben Zwischenwerte — der Empfänger wählt nur, welche Ergebnisse
 * vorn stehen. Die Formate der Marktkommunikation regelt die Festlegung nicht (Tenor S. 25, S. 28, S. 92).
 */
public final class MispelNachweis {

    public static final String FASSUNG = "MP-16/1";
    public static final String ENDGUELTIG = MispelAbgrenzungService.ENDGUELTIG;
    public static final String VORLAEUFIG = MispelAbgrenzungService.VORLAEUFIG;
    public static final ZoneId ZONE = MispelAbgrenzungRechenwerk.BERLIN;

    /** Anlage 1 regelt keine Rundung: gerechnet wird exakt, gerundet nur die Anzeigezahl (Vertrag, Regel vergleich). */
    public static final RoundingMode RUNDUNG = RoundingMode.HALF_UP;
    public static final int NACHKOMMA_KWH = 3;
    public static final int NACHKOMMA_FAKTOR = 6;
    /** Faktoren und Anteile ohne Einheit (Vertrag, „Eingänge, Einheiten, Vorzeichen“). */
    public static final Set<String> FAKTOREN = Set.of("(14)A1", "(18)", "(30)", "(30a)", "(30b)", "(ZFa)", "(ZFb)");

    static final String KATALOG_DATEI = "/mispel/mispel-abgrenzung-vectors.json";
    static final DateTimeFormatter TAG = DateTimeFormatter.ofPattern("dd.MM.yyyy");
    private static final Pattern NUMMER = Pattern.compile("^\\((\\d+)[ab]?\\)");
    private static final ObjectMapper MAPPER = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS);

    private MispelNachweis() {}

    // ------------------------------------------------------------------ Empfänger

    /**
     * Ein Empfänger der Festlegung: welche Formeln (nach ihrer Nummer) er als Ergebnis braucht, im Monat und im Jahr.
     * Lieferant = Netznutzer, Adressat der Umlageprivilegien (§ 21 EnFG); Direktvermarkter = Förderseite; Netzbetreiber
     * prüft und zahlt die Marktprämie aus (Tenorziffer 7) und bekommt beide Seiten.
     */
    public record Empfaenger(String schluessel, String bezeichnung, String grundlage, Set<Integer> monat,
            Set<Integer> jahr) {}

    public static final Map<String, Empfaenger> EMPFAENGER = geordnet(
            new Empfaenger("lieferant", "Lieferant (Netznutzer)", "Umlageseite: Bestimmung der umlagereduzierenden "
                    + "Strommengen und des umlagebelasteten Netzbezugs, Anlage 1 Abschn. 4.3 (S. 39–41), § 21 Abs. 1–4 "
                    + "EnFG; Mitteilung bis 31.05. des Folgejahres (§ 21 Abs. 7 EnFG)",
                    Set.of(3, 16, 19, 20, 21), Set.of(22)),
            new Empfaenger("direktvermarkter", "Direktvermarkter", "Förderseite: Bestimmung der förderfähigen "
                    + "Netzeinspeisung, Anlage 1 Abschn. 4.4 (S. 41–42), Marktprämie nach § 19 Abs. 1 Nr. 1 und Abs. 3b "
                    + "EEG", Set.of(4, 26, 31, 32), Set.of(33)),
            new Empfaenger("netzbetreiber", "Netzbetreiber", "Umlage- und Förderseite zur Prüfung und Auszahlung der "
                    + "Marktprämie, Anlage 1 Abschn. 4.3 und 4.4 (S. 39–42)",
                    Set.of(3, 4, 16, 19, 20, 21, 26, 31, 32), Set.of(22, 33)));

    public static Empfaenger empfaenger(String schluessel) {
        Empfaenger e = schluessel == null ? null : EMPFAENGER.get(schluessel);
        if (e == null) {
            throw new MispelNachweisAbgelehnt("empfaenger_unbekannt", 400, "Empfänger ist einer von "
                    + String.join(", ", EMPFAENGER.keySet()) + " — eine Rolle der Festlegung, kein Unternehmen.");
        }
        return e;
    }

    // ------------------------------------------------------------------ Katalog der Formeln (Vertragsdatei)

    /** Eine Formel wörtlich aus Anlage 1: Nummer, Begriff, Rechenweg, Fundstelle. */
    public record Formel(String nr, String begriff, String rechenweg, String fundstelle) {}

    /** Ein Formelsatz: Fallkonstellation und Fundstelle. */
    public record Formelsatz(String name, String bezeichnung, String fundstelle) {}

    public static final Map<String, Formel> KATALOG;
    public static final Map<String, Formelsatz> FORMELSAETZE;
    public static final String FESTLEGUNG;

    static {
        try (InputStream in = MispelNachweis.class.getResourceAsStream(KATALOG_DATEI)) {
            if (in == null) {
                throw new IllegalStateException("Der Formelkatalog " + KATALOG_DATEI + " fehlt im Jar (pom.xml)");
            }
            JsonNode doc = MAPPER.readTree(in);
            Map<String, Formel> k = new LinkedHashMap<>();
            doc.path("formeln").forEach(f -> k.put(f.path("nr").asText(), new Formel(f.path("nr").asText(),
                    f.path("begriff").asText(), f.path("rechenweg").asText(), f.path("fundstelle").asText())));
            Map<String, Formelsatz> s = new LinkedHashMap<>();
            doc.path("formelsaetze").fields().forEachRemaining(e -> s.put(e.getKey(), new Formelsatz(e.getKey(),
                    e.getValue().path("bezeichnung").asText(), e.getValue().path("fundstelle").asText())));
            KATALOG = Collections.unmodifiableMap(k);
            FORMELSAETZE = Collections.unmodifiableMap(s);
            JsonNode q = doc.path("quelle");
            FESTLEGUNG = "BNetzA, " + q.path("festlegung").asText() + ", Az. " + q.path("aktenzeichen").asText()
                    + ", Beschluss " + q.path("beschluss").asText() + ", " + q.path("anlage").asText();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ------------------------------------------------------------------ Läufe lesen und auswählen

    /** Ein gelesener Lauf: die gespeicherte Zeile und ihr Nachweis-Datensatz, geprüft gegen die Prüfsumme. */
    public record Lauf(Zeile zeile, JsonNode nachweis) {

        public String schluessel() {
            return nachweis.path("schluessel").asText();
        }

        public LocalDate ersterTag() {
            return zeile.zeitraumVon().atZone(ZONE).toLocalDate();
        }

        /** Der letzte Tag des Zeitraums, eingeschlossen — der Zeitraum selbst ist halboffen {@code [von, bis)}. */
        public LocalDate letzterTag() {
            return zeile.zeitraumBis().atZone(ZONE).toLocalDate().minusDays(1);
        }

        public boolean endgueltig() {
            return ENDGUELTIG.equals(zeile.stand());
        }
    }

    /**
     * Liest einen Lauf: SHA-256 über die gespeicherten Bytes des Nachweis-Texts muss die gespeicherte Prüfsumme sein —
     * sonst geht nichts hinaus ({@code pruefsumme_abweichend}).
     */
    public static Lauf lesen(Zeile z) {
        if (!MispelAbgrenzungService.sha256(z.nachweis()).equals(z.pruefsumme())) {
            throw new MispelNachweisAbgelehnt("pruefsumme_abweichend", 409, "Der Nachweis-Datensatz " + z.monat()
                    + " (Fassung " + z.fassung() + ") passt nicht zu seiner Prüfsumme " + z.pruefsumme()
                    + " — er geht nicht hinaus.");
        }
        try {
            return new Lauf(z, MAPPER.readTree(z.nachweis()));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * Die geltenden Läufe: je Zeitraumbeginn die jüngste Fassung; überschneiden sich Zeiträume (die Teilung in
     * Rumpfmonate hat sich geändert), gilt der zuletzt gerechnete — bei gleicher Rechenzeit der früher beginnende.
     */
    public static List<Zeile> geltende(List<Zeile> alle) {
        Map<Instant, Zeile> je = new HashMap<>();
        for (Zeile z : alle) {
            je.merge(z.zeitraumVon(), z, (a, b) -> a.fassung() >= b.fassung() ? a : b);
        }
        List<Zeile> kandidaten = new ArrayList<>(je.values());
        kandidaten.sort(Comparator.comparing(Zeile::gerechnetAm).reversed().thenComparing(Zeile::zeitraumVon));
        List<Zeile> raus = new ArrayList<>();
        for (Zeile k : kandidaten) {
            if (raus.stream().noneMatch(r -> r.zeitraumVon().isBefore(k.zeitraumBis())
                    && k.zeitraumVon().isBefore(r.zeitraumBis()))) {
                raus.add(k);
            }
        }
        raus.sort(Comparator.comparing(Zeile::zeitraumVon));
        return List.copyOf(raus);
    }

    // ------------------------------------------------------------------ Monat und Jahr

    /** Ein Stück des Zeitraums: von einem Lauf bestimmt oder ohne Lauf; Tage eingeschlossen. */
    public record Abschnitt(LocalDate ersterTag, LocalDate letzterTag, String lauf) {}

    /** Der Nachweis eines Kalendermonats: seine (Rumpf-)Monate, Stand mit Gründen und Abdeckung. */
    public record Monat(UUID anlage, YearMonth monat, List<Lauf> laeufe, String stand, List<String> gruende,
            List<Abschnitt> abdeckung) {

        public boolean giltAlsNachweis() {
            return ENDGUELTIG.equals(stand);
        }
    }

    /** Der Jahresnachweis: die (Rumpf-)Monate des Jahres, ∑J je Formel, Stand mit Gründen und Abdeckung. */
    public record Jahr(UUID anlage, int jahr, List<Lauf> laeufe, Map<String, Bruch> jahreswerte, String stand,
            List<String> gruende, List<Abschnitt> abdeckung) {

        public boolean giltAlsNachweis() {
            return ENDGUELTIG.equals(stand);
        }
    }

    /**
     * Der Monat aus den gespeicherten Läufen. Vor dem ersten und nach dem letzten Lauf darf der Monat offen sein — ein
     * Rumpfmonat steht „vor und/oder nach“ der Änderung (Anlage 1 S. 102); eine Lücke ZWISCHEN zwei Läufen macht ihn
     * vorläufig.
     */
    public static Monat monat(UUID anlage, YearMonth monat, List<Zeile> alle) {
        List<Lauf> laeufe = geltende(alle).stream().map(MispelNachweis::lesen).toList();
        if (laeufe.isEmpty()) {
            throw new MispelNachweisAbgelehnt("kein_lauf", 404, "Für " + monat + " ist an dieser Anlage kein Lauf "
                    + "der Abgrenzungsoption gespeichert.");
        }
        List<Abschnitt> abdeckung = abdeckung(monat.atDay(1), monat.atEndOfMonth(), laeufe);
        List<String> gruende = new ArrayList<>();
        laeufe.stream().filter(l -> !l.endgueltig()).forEach(l -> gruende.add("lauf_vorlaeufig:" + l.schluessel()));
        for (int i = 1; i < abdeckung.size() - 1; i++) {
            if (abdeckung.get(i).lauf() == null) {
                gruende.add("zeitraum_luecke:" + abdeckung.get(i).ersterTag() + "/" + abdeckung.get(i).letzterTag());
            }
        }
        return new Monat(anlage, monat, laeufe, gruende.isEmpty() ? ENDGUELTIG : VORLAEUFIG, List.copyOf(gruende),
                abdeckung);
    }

    /**
     * Das Jahr aus den gespeicherten Läufen aller seiner Kalendermonate. ∑J je Formel ist die Summe der Beiträge, die
     * jeder Lauf für sein Jahr ausweist ({@code jahreswerte_dieses_laufs}) — also der Monatswerte (A1 S. 37, S. 39).
     * Endgültig nur, wenn jeder Lauf endgültig ist, zwischen den Läufen nichts fehlt und der letzte bis zum 31.12. reicht;
     * vor dem ersten Lauf im Jahr gibt es keine Bestimmung nach Anlage 1 (steht als Abschnitt ohne Lauf im Nachweis).
     */
    public static Jahr jahr(UUID anlage, int jahr, List<Zeile> alle) {
        Map<YearMonth, List<Zeile>> jeMonat = new LinkedHashMap<>();
        for (Zeile z : alle) {
            jeMonat.computeIfAbsent(YearMonth.from(z.monat()), k -> new ArrayList<>()).add(z);
        }
        List<Lauf> laeufe = new ArrayList<>();
        jeMonat.values().forEach(z -> geltende(z).forEach(g -> laeufe.add(lesen(g))));
        laeufe.sort(Comparator.comparing(l -> l.zeile().zeitraumVon()));
        if (laeufe.isEmpty()) {
            throw new MispelNachweisAbgelehnt("kein_lauf", 404, "Für " + jahr + " ist an dieser Anlage kein Lauf der "
                    + "Abgrenzungsoption gespeichert.");
        }
        Map<String, Bruch> summen = new LinkedHashMap<>();
        for (Lauf l : laeufe) {
            l.nachweis().path("jahreswerte_dieses_laufs").path(String.valueOf(jahr)).fields()
                    .forEachRemaining(e -> summen.merge(e.getKey(), bruch(e.getValue()), Bruch::plus));
        }
        List<Abschnitt> abdeckung = abdeckung(LocalDate.of(jahr, 1, 1), LocalDate.of(jahr, 12, 31), laeufe);
        List<String> gruende = new ArrayList<>();
        laeufe.stream().filter(l -> !l.endgueltig()).forEach(l -> gruende.add("lauf_vorlaeufig:" + l.schluessel()));
        for (int i = 1; i < abdeckung.size(); i++) {
            Abschnitt a = abdeckung.get(i);
            if (a.lauf() == null) {
                gruende.add((i == abdeckung.size() - 1 ? "nicht_bis_jahresende:" : "zeitraum_luecke:")
                        + a.ersterTag() + "/" + a.letzterTag());
            }
        }
        return new Jahr(anlage, jahr, List.copyOf(laeufe), Collections.unmodifiableMap(summen),
                gruende.isEmpty() ? ENDGUELTIG : VORLAEUFIG, List.copyOf(gruende), abdeckung);
    }

    private static List<Abschnitt> abdeckung(LocalDate erster, LocalDate letzter, List<Lauf> laeufe) {
        List<Abschnitt> raus = new ArrayList<>();
        LocalDate offen = erster;
        for (Lauf l : laeufe) {
            if (l.ersterTag().isAfter(offen)) {
                raus.add(new Abschnitt(offen, l.ersterTag().minusDays(1), null));
            }
            raus.add(new Abschnitt(l.ersterTag(), l.letzterTag(), l.schluessel()));
            if (!l.letzterTag().isBefore(offen)) {
                offen = l.letzterTag().plusDays(1);
            }
        }
        if (!offen.isAfter(letzter)) {
            raus.add(new Abschnitt(offen, letzter, null));
        }
        return List.copyOf(raus);
    }

    // ------------------------------------------------------------------ Werte

    /** Ein Wert mit seiner Formel; {@code wert == null} = nicht bestimmbar (Regel nenner_null). */
    public record Wert(String schluessel, String nr, Bruch wert) {

        public Formel formel() {
            return KATALOG.getOrDefault(nr, new Formel(nr, "", "", ""));
        }
    }

    /** Alle Monatswerte eines Laufs in Katalog-Reihenfolge des Rechenwerks, wie gespeichert. */
    public static List<Wert> monatswerte(Lauf l) {
        List<Wert> raus = new ArrayList<>();
        l.nachweis().path("monatswerte").fields().forEachRemaining(m -> m.getValue().fields()
                .forEachRemaining(w -> raus.add(new Wert(m.getKey(), w.getKey(), bruch(w.getValue())))));
        return raus;
    }

    /** Die Ergebnisse des Monats für den Empfänger: seine Formeln je (Rumpf-)Monat. */
    public static List<Wert> ergebnis(Monat m, Empfaenger e) {
        List<Wert> raus = new ArrayList<>();
        m.laeufe().forEach(l -> monatswerte(l).stream().filter(w -> e.monat().contains(nummer(w.nr()))).forEach(raus::add));
        return raus;
    }

    /** Die Ergebnisse des Jahres für den Empfänger: seine ∑J-Formeln. */
    public static List<Wert> ergebnis(Jahr j, Empfaenger e) {
        List<Wert> raus = new ArrayList<>();
        j.jahreswerte().forEach((nr, w) -> {
            if (e.jahr().contains(nummer(nr))) {
                raus.add(new Wert(String.valueOf(j.jahr()), nr, w));
            }
        });
        return raus;
    }

    /** Die Monatswerte des Jahres für den Empfänger, je (Rumpf-)Monat — die Summanden von ∑J. */
    public static List<Wert> monatswerte(Jahr j, Empfaenger e) {
        List<Wert> raus = new ArrayList<>();
        j.laeufe().forEach(l -> monatswerte(l).stream().filter(w -> e.monat().contains(nummer(w.nr()))).forEach(raus::add));
        return raus;
    }

    /** Die Nummer einer Formel ohne Zusatz: (19)A1,A4 → 19, (32a) → 32; {@code -1} für (ZFa)/(ZFb). */
    static int nummer(String nr) {
        Matcher m = NUMMER.matcher(nr);
        return m.find() ? Integer.parseInt(m.group(1)) : -1;
    }

    /** Der gespeicherte Text als exakte Zahl: Dezimalzahl oder Bruch {@code z/n}; {@code null} bleibt {@code null}. */
    static Bruch bruch(JsonNode n) {
        if (n == null || n.isNull() || n.isMissingNode()) {
            return null;
        }
        String t = n.asText();
        int s = t.indexOf('/');
        return s < 0 ? Bruch.von(new BigDecimal(t))
                : new Bruch(new BigInteger(t.substring(0, s)), new BigInteger(t.substring(s + 1)));
    }

    /** Die Anzeigezahl: kaufmännisch gerundet, kWh auf 3 (1 Wh), Faktoren und Anteile auf 6 Nachkommastellen. */
    public static BigDecimal gerundet(String nr, Bruch b) {
        if (b == null) {
            return null;
        }
        return new BigDecimal(b.zaehler()).divide(new BigDecimal(b.nenner()),
                FAKTOREN.contains(nr) ? NACHKOMMA_FAKTOR : NACHKOMMA_KWH, RUNDUNG);
    }

    public static String einheit(String nr) {
        return FAKTOREN.contains(nr) ? "" : "kWh";
    }

    // ------------------------------------------------------------------ Texte, die CSV und PDF teilen

    public static String titel(Monat m) {
        String monat = monatsname(m.monat());
        return m.giltAlsNachweis()
                ? "Mengenbestimmung nach Anlage 1 (Abgrenzungsoption) – Kalendermonat " + monat
                : "Vorläufige Rechnung nach Anlage 1 (Abgrenzungsoption) – keine Mengenbestimmung – " + monat;
    }

    public static String titel(Jahr j) {
        return j.giltAlsNachweis()
                ? "Jahresnachweis nach Anlage 1 (Abgrenzungsoption) – Kalenderjahr " + j.jahr()
                : "Vorläufiger Jahresnachweis nach Anlage 1 (Abgrenzungsoption) – keine Mengenbestimmung – "
                        + "Kalenderjahr " + j.jahr();
    }

    /** Die Mitteilungsfrist des Lieferanten für das Kalenderjahr (§ 21 Abs. 7 EnFG). */
    public static String frist(int jahr) {
        return "Mitteilung bis " + TAG.format(LocalDate.of(jahr + 1, 5, 31)) + " (§ 21 Abs. 7 EnFG)";
    }

    public static final List<String> HINWEISE = List.of(
            "Nur ein endgültiger Stand ist eine Mengenbestimmung im Sinne der Festlegung: auf mess- und eichrechtskonformen "
                    + "Viertelstundenwerten des Messstellenbetreibers (Tenor S. 28; § 21 Abs. 4 S. 2 EnFG; Anlage 1 S. 23). "
                    + "Ein vorläufiger Stand ist eine Vorschau, kein Nachweis.",
            "Jeder Kalendermonat wird für sich bestimmt (Anlage 1 S. 14, Abschn. 2.1.4); ein Rumpfmonat tritt an seine Stelle "
                    + "(Anlage 1 S. 102, Abschn. 11). Das Kalenderjahr ist die Summe der Monatswerte (∑J).",
            "Gerechnet wird exakt (Brüche, ungerundet); gerundet ist nur die Anzeigezahl, kaufmännisch auf "
                    + NACHKOMMA_KWH + " Nachkommastellen (1 Wh), Faktoren und Anteile auf " + NACHKOMMA_FAKTOR
                    + ". Anlage 1 regelt keine Rundung. „nicht bestimmbar“: Quotient mit Nenner null.",
            "Das Datenformat der Marktkommunikation regelt die Festlegung nicht (Tenor S. 25, S. 28, S. 92); CSV und PDF "
                    + "tragen dieselben Werte.");

    static String monatsname(YearMonth m) {
        return m.getMonth().getDisplayName(TextStyle.FULL, Locale.GERMAN) + " " + m.getYear();
    }

    static String wertequelle(List<Lauf> laeufe) {
        return laeufe.stream().allMatch(l -> MispelAbgrenzungService.MSB.equals(l.zeile().wertequelle()))
                ? MispelAbgrenzungService.MSB : MispelAbgrenzungService.GERAET;
    }

    static String festlegung(List<Lauf> laeufe) {
        return laeufe.get(0).nachweis().path("festlegung").asText(FESTLEGUNG);
    }

    static String zeit(Instant t) {
        return OffsetDateTime.ofInstant(t.truncatedTo(ChronoUnit.SECONDS), ZONE).toString();
    }

    static String gruende(JsonNode n) {
        List<String> raus = new ArrayList<>();
        n.forEach(g -> raus.add(g.asText()));
        return String.join(", ", raus);
    }

    // ------------------------------------------------------------------ CSV (Form wie der Berichts-CSV, DA3)

    /** Der CSV des Monats: UTF-8 mit BOM, CRLF, Kopf {@code # schlüssel=wert}, Abschnitte {@code # abschnitt=…}. */
    public static byte[] csv(Monat m, Empfaenger e) {
        List<String> z = new ArrayList<>(kopf(titel(m), e, m.anlage(), m.monat().toString(), m.laeufe(), m.stand(),
                m.gruende(), m.giltAlsNachweis()));
        if ("lieferant".equals(e.schluessel())) {
            z.add(kopfzeile("frist", frist(m.monat().getYear())));
        }
        laeufe(z, m.laeufe());
        abdeckung(z, m.abdeckung());
        ergebnis(z, "ergebnis", ergebnis(m, e));
        messkonzept(z, m.laeufe());
        angaben(z, m.laeufe());
        abschnitt(z, "formelsatz", "schluessel", "nr", "begriff", "rechenweg", "wert", "wert_exakt", "einheit",
                "fundstelle");
        for (Lauf l : m.laeufe()) {
            for (Wert w : monatswerte(l)) {
                Formel f = w.formel();
                z.add(zeile(w.schluessel(), w.nr(), f.begriff(), f.rechenweg(), zahl(gerundet(w.nr(), w.wert())),
                        exakt(w.wert()), einheit(w.nr()), f.fundstelle()));
            }
        }
        luecken(z, m.laeufe());
        viertelstunden(z, m.laeufe());
        return datei(z);
    }

    /** Der CSV des Jahresnachweises: ∑J für den Empfänger, seine Monatswerte als Summanden, Läufe und Abdeckung. */
    public static byte[] csv(Jahr j, Empfaenger e) {
        List<String> z = new ArrayList<>(kopf(titel(j), e, j.anlage(), String.valueOf(j.jahr()), j.laeufe(), j.stand(),
                j.gruende(), j.giltAlsNachweis()));
        if ("lieferant".equals(e.schluessel())) {
            z.add(kopfzeile("frist", frist(j.jahr())));
        }
        laeufe(z, j.laeufe());
        abdeckung(z, j.abdeckung());
        ergebnis(z, "ergebnis", ergebnis(j, e));
        ergebnis(z, "monatswerte", monatswerte(j, e));
        return datei(z);
    }

    private static List<String> kopf(String titel, Empfaenger e, UUID anlage, String zeitraum, List<Lauf> laeufe,
            String stand, List<String> gruende, boolean nachweis) {
        List<String> z = new ArrayList<>();
        z.add(kopfzeile("nachweis", titel));
        z.add(kopfzeile("festlegung", festlegung(laeufe)));
        z.add(kopfzeile("vertrag", String.join(", ", new LinkedHashSet<>(laeufe.stream()
                .map(l -> l.nachweis().path("vertrag").asText() + " " + l.zeile().vertragVersion()).toList()))));
        z.add(kopfzeile("format", FASSUNG));
        z.add(kopfzeile("empfaenger", e.schluessel() + " · " + e.bezeichnung()));
        z.add(kopfzeile("grundlage", e.grundlage()));
        z.add(kopfzeile("anlage", anlage.toString()));
        z.add(kopfzeile("zeitraum", zeitraum));
        z.add(kopfzeile("formelsatz", String.join(", ", new LinkedHashSet<>(laeufe.stream()
                .map(l -> l.zeile().formelsatz()).toList()))));
        z.add(kopfzeile("stand", stand));
        z.add(kopfzeile("gilt_als_nachweis", nachweis ? "ja" : "nein"));
        z.add(kopfzeile("stand_gruende", String.join(", ", gruende)));
        z.add(kopfzeile("wertequelle", wertequelle(laeufe)));
        z.add(kopfzeile("zeitzone", ZONE.getId()));
        z.add(kopfzeile("einheit", "kWh; Faktoren und Anteile " + String.join(", ", FAKTOREN.stream().sorted().toList())
                + " ohne Einheit"));
        z.add(kopfzeile("dezimal", BerichtRegeln.CSV_DEZIMAL));
        z.add(kopfzeile("trenner", BerichtRegeln.CSV_TRENNER));
        z.add(kopfzeile("zahlen", "wert kaufmännisch gerundet (kWh auf " + NACHKOMMA_KWH + ", Faktoren auf "
                + NACHKOMMA_FAKTOR + " Nachkommastellen); wert_exakt ungerundet als Dezimalzahl oder Bruch z/n; leer = "
                + "nicht bestimmbar"));
        z.add(kopfzeile("nachweis_pruefsummen", String.join(", ", laeufe.stream().map(l -> l.zeile().pruefsumme())
                .toList())));
        HINWEISE.forEach(h -> z.add(kopfzeile("hinweis", h)));
        return z;
    }

    private static void laeufe(List<String> z, List<Lauf> laeufe) {
        abschnitt(z, "laeufe", "schluessel", "erster_tag", "letzter_tag", "formelsatz", "fassung", "stand",
                "stand_gruende", "wertequelle", "viertelstunden_erwartet", "viertelstunden_gerechnet",
                "rechenwerk_version", "vertrag_version", "gerechnet_am", "pruefsumme");
        for (Lauf l : laeufe) {
            Zeile r = l.zeile();
            z.add(zeile(l.schluessel(), l.ersterTag().toString(), l.letzterTag().toString(), r.formelsatz(),
                    String.valueOf(r.fassung()), r.stand(), gruende(l.nachweis().path("stand_gruende")), r.wertequelle(),
                    String.valueOf(r.viertelstundenErwartet()), String.valueOf(r.viertelstundenGerechnet()),
                    r.rechenwerkVersion(), r.vertragVersion(), zeit(r.gerechnetAm()), r.pruefsumme()));
        }
    }

    private static void abdeckung(List<String> z, List<Abschnitt> abdeckung) {
        abschnitt(z, "abdeckung", "erster_tag", "letzter_tag", "lauf");
        abdeckung.forEach(a -> z.add(zeile(a.ersterTag().toString(), a.letzterTag().toString(),
                a.lauf() == null ? "ohne Lauf" : a.lauf())));
    }

    private static void ergebnis(List<String> z, String name, List<Wert> werte) {
        abschnitt(z, name, "schluessel", "nr", "begriff", "wert", "wert_exakt", "einheit", "fundstelle");
        for (Wert w : werte) {
            Formel f = w.formel();
            z.add(zeile(w.schluessel(), w.nr(), f.begriff(), zahl(gerundet(w.nr(), w.wert())), exakt(w.wert()),
                    einheit(w.nr()), f.fundstelle()));
        }
    }

    private static void messkonzept(List<String> z, List<Lauf> laeufe) {
        abschnitt(z, "messkonzept", "schluessel", "eingang", "messstelle", "rolle", "zaehlpunkt", "messstellenbetreiber",
                "eichstatus", "eichfrist_bis", "wertequelle", "urteil");
        for (Lauf l : laeufe) {
            for (JsonNode m : l.nachweis().path("zaehler")) {
                z.add(zeile(l.schluessel(), text(m, "eingang"), text(m, "messstelle"), text(m, "rolle"),
                        text(m, "zaehlpunkt"), text(m, "messstellenbetreiber"), text(m, "eichstatus"),
                        text(m, "eichfrist_bis"), text(m, "wertequelle"), text(m, "urteil")));
            }
        }
    }

    /** Werte zur Bestimmung: AW-Regel je Eingang, Painst/Pbinst, ungeförderte Anlage (A5). */
    private static void angaben(List<String> z, List<Lauf> laeufe) {
        abschnitt(z, "angaben", "schluessel", "angabe", "wert");
        for (Lauf l : laeufe) {
            l.nachweis().path("aw_regeln").fields().forEachRemaining(a -> z.add(zeile(l.schluessel(),
                    "aw_regel " + a.getKey(), a.getValue().asText())));
            l.nachweis().path("stammdaten").fields().forEachRemaining(a -> z.add(zeile(l.schluessel(), a.getKey(),
                    a.getValue().asText().replace(".", BerichtRegeln.CSV_DEZIMAL) + " kW")));
            l.nachweis().path("ungefoerdert").forEach(u -> z.add(zeile(l.schluessel(), "ungefoerdert", u.asText())));
        }
    }

    private static void luecken(List<String> z, List<Lauf> laeufe) {
        abschnitt(z, "luecken", "schluessel", "eingaenge", "anzahl", "erste");
        for (Lauf l : laeufe) {
            l.nachweis().path("viertelstunden").path("luecken_je_eingang").fields().forEachRemaining(a -> {
                List<String> erste = new ArrayList<>();
                a.getValue().path("erste").forEach(t -> erste.add(t.asText()));
                z.add(zeile(l.schluessel(), a.getKey(), a.getValue().path("anzahl").asText(), String.join(", ", erste)));
            });
        }
    }

    /** Eingänge und Zwischenwerte je Viertelstunde, exakt wie gespeichert; „AW¼ &gt; 0“ als ja/nein. */
    private static void viertelstunden(List<String> z, List<Lauf> laeufe) {
        Set<String> spalten = new LinkedHashSet<>();
        laeufe.forEach(l -> l.nachweis().path("eingaenge_und_viertelstundenwerte").forEach(q -> q.fieldNames()
                .forEachRemaining(spalten::add)));
        spalten.remove("beginn");
        List<String> kopf = new ArrayList<>(List.of("schluessel", "beginn"));
        kopf.addAll(spalten);
        abschnitt(z, "viertelstunden", kopf.toArray(String[]::new));
        for (Lauf l : laeufe) {
            for (JsonNode q : l.nachweis().path("eingaenge_und_viertelstundenwerte")) {
                List<String> zellen = new ArrayList<>(List.of(l.schluessel(), q.path("beginn").asText()));
                for (String s : spalten) {
                    JsonNode v = q.path(s);
                    zellen.add(v.isBoolean() ? (v.asBoolean() ? "ja" : "nein")
                            : v.isMissingNode() || v.isNull() ? null : v.asText().replace(".", BerichtRegeln.CSV_DEZIMAL));
                }
                z.add(zeile(zellen.toArray(String[]::new)));
            }
        }
    }

    private static byte[] datei(List<String> zeilen) {
        StringBuilder s = new StringBuilder(BerichtCsv.BOM);
        zeilen.forEach(z -> s.append(z).append(BerichtCsv.ZEILENENDE));
        return s.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String kopfzeile(String schluessel, String wert) {
        return "# " + schluessel + "=" + wert.replace("\r", " ").replace("\n", " ");
    }

    private static void abschnitt(List<String> z, String name, String... spalten) {
        z.add("# " + BerichtCsv.ABSCHNITT + "=" + name);
        z.add(String.join(BerichtRegeln.CSV_TRENNER, spalten));
    }

    private static String zeile(String... zellen) {
        return String.join(BerichtRegeln.CSV_TRENNER, Arrays.stream(zellen).map(BerichtRegeln::csvZelle).toList());
    }

    static String zahl(BigDecimal d) {
        return d == null ? null : d.toPlainString().replace(".", BerichtRegeln.CSV_DEZIMAL);
    }

    static String exakt(Bruch b) {
        return b == null ? null : b.text().replace(".", BerichtRegeln.CSV_DEZIMAL);
    }

    private static String text(JsonNode n, String feld) {
        JsonNode v = n.path(feld);
        return v.isMissingNode() || v.isNull() ? null : v.asText();
    }

    private static Map<String, Empfaenger> geordnet(Empfaenger... werte) {
        Map<String, Empfaenger> raus = new LinkedHashMap<>();
        for (Empfaenger w : werte) {
            raus.put(w.schluessel(), w);
        }
        return Collections.unmodifiableMap(raus);
    }
}
