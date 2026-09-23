package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.GregorianCalendar;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.apache.fontbox.ttf.CmapLookup;
import org.apache.fontbox.ttf.TTFParser;
import org.apache.fontbox.ttf.TrueTypeFont;
import org.apache.pdfbox.cos.COSArray;
import org.apache.pdfbox.cos.COSName;
import org.apache.pdfbox.cos.COSString;
import org.apache.pdfbox.io.RandomAccessReadBuffer;
import org.apache.pdfbox.pdmodel.PDDocument;
import org.apache.pdfbox.pdmodel.PDDocumentInformation;
import org.apache.pdfbox.pdmodel.PDPage;
import org.apache.pdfbox.pdmodel.PDPageContentStream;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.PDType0Font;
import org.apache.pdfbox.util.Matrix;

/**
 * Das PDF eines Berichtsstands (UEMS AP-12 IP-11, E11 DA2) — rein, ohne Spring und ohne Datenbank, gebaut mit Apache PDFBox
 * (Apache-2.0). Es liest NUR den Abzug und die Freigabe des Stands (A1), wie {@link BerichtCsv}: nichts wird nachgeschlagen.
 *
 * <p><b>Deterministisch</b> — zwei Erzeugungen desselben Stands sind byte-gleich, für jede Person und zu jeder Zeit: das
 * Datum im Dokument ist die Freigabe ({@code CreationDate} = {@code ModDate}), die Dokument-Kennung {@code /ID} steht fest aus
 * der Prüfsumme (sonst setzt PDFBox sie aus der Uhr), die Schrift ist Liberation Sans Regular aus dem pdfbox-Jar (SIL OFL
 * 1.1), als Teilmenge eingebettet (das Kürzel der Teilmenge hängt an den Glyphen, nicht am Zufall). Anders als der CSV trägt
 * das PDF weder Abrufzeit noch Abrufer noch Teilansicht — die stehen nur im Abruf-Protokoll ({@code bericht_abruf}).
 *
 * <p><b>Aufbau</b> (DA2) in der Folge der Vorlagen der Fassung 1: Kopf (Vorlage, Geltung, Zeitraum, Vergleichszeiträume,
 * Datenstand, Freigabe, Darstellung, Regelwerk, Prüfsumme) · Zusammenfassung · Tabellen (am Standort „Verbrauch je
 * Messstelle“, am Unternehmen „Standorte“ mit den Messstellen und „Prozesse und Kostenstellen“) · Kennzahlen · Qualität ·
 * Quellenverzeichnis; auf jeder Seite der Fuß „Bericht · Datenstand · Berichtsstand Nr. n · freigegeben … von …“ mit
 * Prüfsumme und Seitenzahl. Ein ersetzter Stand trägt auf jeder Seite das Wasserzeichen „ersetzt durch Nr. n (Datum)“
 * schräg hinter dem Inhalt und denselben Satz oben rechts als lesbare Zeile. Tagesverlauf und Monatswerte trägt der Abzug noch nicht — sie erscheinen nicht.
 *
 * <p><b>Zahlen</b> nach der eingefrorenen Darstellung (DA1, {@link BerichtRegeln#anzeige}): Mengen mit den Stellen der Ebene
 * des Zeitraums, Kennzahlen mit zwei Stellen; eine Einheit ohne Ebenen-Regel (Stück an einer Bezugsgröße) ungerundet in
 * derselben Schreibweise. Kein Wert ist „—“, nie 0. Ein Zeichen, das die Schrift nicht kennt, wird „?“ — das PDF scheitert
 * nie an einem Namen.
 */
public final class BerichtPdf {

    /** Liberation Sans Regular (SIL Open Font License 1.1) — die Ersatzschrift, die PDFBox selbst mitbringt. */
    static final String SCHRIFT = "/org/apache/pdfbox/resources/ttf/LiberationSans-Regular.ttf";
    static final String ERSATZZEICHEN = "?";
    static final String ERZEUGER = "VoltPilot EMS";

    public static final String KOPF = "kopf";
    public static final String ZUSAMMENFASSUNG = "zusammenfassung";
    public static final String QUALITAET = "qualitaet";
    public static final String QUELLENVERZEICHNIS = "quellenverzeichnis";

    /** Die Abschnitte je Geltung mit ihren Titeln, in der Folge der Vorlagen (Fassung 1) — nur, was der Abzug trägt. */
    public static final Map<String, String> ABSCHNITTE_STANDORT = geordnet(KOPF, "Kopf", ZUSAMMENFASSUNG, "Zusammenfassung",
            BerichtCsv.MESSSTELLEN, "Verbrauch je Messstelle", BerichtCsv.KENNZAHLEN, "Kennzahlen", QUALITAET, "Qualität",
            QUELLENVERZEICHNIS, "Quellenverzeichnis");
    public static final Map<String, String> ABSCHNITTE_UNTERNEHMEN = geordnet(KOPF, "Kopf", ZUSAMMENFASSUNG,
            "Zusammenfassung", BerichtCsv.STANDORTE, "Standorte", BerichtCsv.KOSTENSTELLEN, "Prozesse und Kostenstellen",
            BerichtCsv.KENNZAHLEN, "Kennzahlen des Unternehmens", QUALITAET, "Qualität", QUELLENVERZEICHNIS,
            "Quellenverzeichnis");
    public static final Map<String, String> ABSCHNITTE_BEWERTUNG = geordnet(BerichtCsv.UMFANG, "Umfang",
            BerichtCsv.RANGLISTE, "Rangliste", BerichtCsv.EINSTUFUNGEN, "Einstufungen",
            BerichtCsv.MESSABDECKUNG, "Messabdeckung", BerichtCsv.MESSPLANUNG, "Messplanung",
            BerichtCsv.MESSMITTEL, "Messmittel", QUALITAET, "Qualität", QUELLENVERZEICHNIS, "Quellenverzeichnis");
    /** AP-17 IP-22: die acht Abschnitte des Leistungsvergleichs (Kopf inbegriffen), wie {@code bericht-vorlagen.json}. */
    public static final Map<String, String> ABSCHNITTE_LEISTUNGSVERGLEICH = geordnet(KOPF, "Kopf", BerichtCsv.KENNZAHL,
            "Kennzahl", BerichtCsv.BEZUGSBASIS, "Bezugsbasis", BerichtCsv.VERGLEICH_JE_PERIODE, "Vergleich je Periode",
            BerichtCsv.URTEIL, "Urteil", BerichtCsv.GRENZEN, "Grenzen und Vorbehalte", BerichtCsv.STATISCHE_FAKTOREN,
            "Statische Faktoren", QUELLENVERZEICHNIS, "Quellenverzeichnis");
    /** Die Namen der Vorlagen (Fassung 1, {@code bericht-vorlagen.json}) — der Titel des PDF. */
    public static final Map<String, String> VORLAGEN = geordnet("monatsbericht_standort", "Monatsbericht Standort",
            "jahresbericht_standort", "Jahresbericht Standort", "monatsbericht_unternehmen", "Monatsbericht Unternehmen",
            "jahresbericht_unternehmen", "Jahresbericht Unternehmen", BerichtRegeln.ENERGETISCHE_BEWERTUNG,
            "Energetische Bewertung", BerichtRegeln.LEISTUNGSVERGLEICH, "Leistungsvergleich");

    private static final Map<String, String> SUMMEN = geordnet("netzbezug_kwh", "Netzbezug", "einspeisung_kwh",
            "Einspeisung", "pv_erzeugung_kwh", "PV-Erzeugung", "speicher_laden_kwh", "Speicher laden",
            "speicher_entladen_kwh", "Speicher entladen");
    private static final Set<String> ANZAHLEN = Set.of("werte", "davon_endgueltig", "davon_vollstaendig");
    private static final Map<String, String> VERGLEICHE = geordnet(BerichtRegeln.VORMONAT, "Vormonat",
            BerichtRegeln.VORJAHRESMONAT, "Vorjahresmonat", BerichtRegeln.VORJAHR, "Vorjahr");
    private static final String TRENNER = " · ";
    /** Die Methoden der Bezugsbasis in Kundenwörtern (SP1, {@code bezugsbasis.md}). */
    private static final Map<String, String> METHODEN = geordnet("verhaeltnis", "Verhältnis", "regression_eine_variable",
            "Modell mit einer Einflussgröße", "regression_zwei_variablen", "Modell mit zwei Einflussgrößen", "gradtage",
            "Gradtage (G20/15)");
    private static final Map<String, String> DATENLAGEN = geordnet("vollstaendig", "vollständig", "vorlaeufig",
            KennzahlRegeln.VORLAEUFIG);
    private static final Map<String, String> BEZUEGE = geordnet(BerichtRegeln.UNMITTELBAR, "unmittelbar",
            BerichtRegeln.MITTELBAR, "mittelbar", BerichtRegeln.VERGLEICH, "Vergleich");
    private static final String ENDUNG_KWH = "_kwh";

    // A4 hochkant, Maße in Punkt
    private static final PDRectangle FORMAT = PDRectangle.A4;
    private static final float RAND = 48f;
    private static final float BREITE = FORMAT.getWidth() - 2 * RAND;
    private static final float OBEN = FORMAT.getHeight() - RAND;
    private static final float UNTEN = RAND + 44f;
    private static final float TITEL = 16f;
    private static final float UEBERSCHRIFT = 11f;
    private static final float NORMAL = 8.5f;
    private static final float KLEIN = 7f;
    private static final float ZEILE = 1.35f;
    private static final float POLSTER = 2.5f;
    private static final float ETIKETT = 118f;
    private static final float SCHWARZ = 0f;
    private static final float GRAU = 0.38f;
    private static final float LINIE = 0.72f;
    private static final float WASSERZEICHEN = 0.86f;

    private static final byte[] SCHRIFT_DATEI = schriftDatei();

    private BerichtPdf() {
    }

    /** Die Datei: das PDF des Stands aus seinem Abzug. */
    public static byte[] datei(JsonNode abzug, BerichtCsv.Stand stand) {
        JsonNode kopf = abzug.path(KOPF);
        ZoneId zone = zone(kopf);
        String ebene = kopf.path("zeitraum").path("art").asText();
        String wasserzeichen = stand.ersetztDurchNr() == null ? null
                : BerichtRegeln.ersetztDurch(stand.ersetztDurchNr(), stand.ersetztAm(), zone);
        boolean bewertung = BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(kopf.path("vorlage").asText());
        boolean leistungsvergleich = BerichtRegeln.LEISTUNGSVERGLEICH.equals(kopf.path("vorlage").asText());
        boolean unternehmen = BerichtRegeln.UNTERNEHMEN.equals(kopf.path("geltung").path("art").asText());
        Map<String, String> abschnitte = bewertung ? ABSCHNITTE_BEWERTUNG
                : leistungsvergleich ? ABSCHNITTE_LEISTUNGSVERGLEICH
                : unternehmen ? ABSCHNITTE_UNTERNEHMEN : ABSCHNITTE_STANDORT;
        try (TrueTypeFont ttf = new TTFParser().parse(new RandomAccessReadBuffer(SCHRIFT_DATEI));
                PDDocument doc = new PDDocument()) {
            Setzer s = new Setzer(doc, PDType0Font.load(doc, ttf, true), ttf.getUnicodeCmapLookup(), wasserzeichen);
            s.seite();
            kopf(s, kopf, stand, zone, wasserzeichen);
            for (Map.Entry<String, String> a : abschnitte.entrySet()) {
                if (KOPF.equals(a.getKey())) {
                    continue;
                }
                s.ueberschrift(a.getValue());
                switch (a.getKey()) {
                    case ZUSAMMENFASSUNG -> zusammenfassung(s, abzug.path(ZUSAMMENFASSUNG), ebene);
                    case BerichtCsv.MESSSTELLEN -> messstellen(s, abzug.path("werte"), zone, ebene);
                    case BerichtCsv.STANDORTE -> standorte(s, abzug, zone, ebene);
                    case BerichtCsv.KOSTENSTELLEN -> kostenstellen(s, abzug.path(BerichtCsv.KOSTENSTELLEN), ebene);
                    case BerichtCsv.KENNZAHLEN -> kennzahlen(s, abzug.path(BerichtCsv.KENNZAHLEN), zone, ebene);
                    case BerichtCsv.UMFANG -> umfang(s, abzug.path(BerichtCsv.UMFANG));
                    case BerichtCsv.RANGLISTE -> rangliste(s, abzug.path(BerichtCsv.RANGLISTE));
                    case BerichtCsv.EINSTUFUNGEN -> einstufungen(s, abzug.path(BerichtCsv.EINSTUFUNGEN));
                    case BerichtCsv.MESSABDECKUNG -> messabdeckung(s, abzug.path(BerichtCsv.MESSABDECKUNG));
                    case BerichtCsv.MESSPLANUNG -> messplanung(s, abzug);
                    case BerichtCsv.MESSMITTEL -> messmittel(s, abzug.path(BerichtCsv.MESSMITTEL));
                    case QUALITAET -> qualitaet(s, abzug.path(QUALITAET), zone);
                    case BerichtCsv.KENNZAHL -> kennzahl(s, abzug.path(BerichtCsv.KENNZAHL));
                    case BerichtCsv.BEZUGSBASIS -> bezugsbasis(s, abzug, zone);
                    case BerichtCsv.VERGLEICH_JE_PERIODE -> vergleichJePeriode(s, abzug.path(BerichtCsv.VERGLEICH_JE_PERIODE));
                    case BerichtCsv.URTEIL -> urteil(s, abzug);
                    case BerichtCsv.GRENZEN -> grenzen(s, abzug);
                    case BerichtCsv.STATISCHE_FAKTOREN -> statischeFaktoren(s, abzug.path(BerichtCsv.STATISCHE_FAKTOREN));
                    case QUELLENVERZEICHNIS -> {
                        if (leistungsvergleich) {
                            quellenMitBezug(s, abzug.path(QUELLENVERZEICHNIS));
                        } else {
                            quellenverzeichnis(s, abzug);
                        }
                    }
                    default -> throw new IllegalStateException("Abschnitt " + a.getKey());
                }
            }
            s.fuesse(List.of(kopf.path("bericht").asText() + TRENNER + BerichtRegeln.kopf(zeit(kopf.path("datenstand")),
                    zone, stand.nr(), stand.freigegebenAm(), stand.freigegebenVon()), "Prüfsumme " + stand.pruefsumme()));
            eigenschaften(doc, kopf, stand, zone);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            doc.save(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new UncheckedIOException("PDF des Berichtsstands " + stand.nr(), e);
        }
    }

    // ================================================================================ Abschnitte

    private static void kopf(Setzer s, JsonNode kopf, BerichtCsv.Stand stand, ZoneId zone, String wasserzeichen)
            throws IOException {
        String vorlage = kopf.path("vorlage").asText();
        JsonNode geltung = kopf.path("geltung");
        s.titel(VORLAGEN.getOrDefault(vorlage, vorlage));
        s.absatz(geltung(geltung), UEBERSCHRIFT, SCHWARZ);
        boolean leistungsvergleich = BerichtRegeln.LEISTUNGSVERGLEICH.equals(vorlage);
        if (BerichtRegeln.ENERGETISCHE_BEWERTUNG.equals(vorlage) || leistungsvergleich) {
            s.abstand(4);
            s.absatz(BerichtRegeln.BEWERTUNG_GRENZ_SATZ, NORMAL, GRAU);
        }
        s.abstand(6);
        List<String[]> paare = new ArrayList<>();
        paare.add(paar("Bericht", kopf.path("bericht").asText()));
        paare.add(paar("Berichtsstand", BerichtRegeln.berichtsstand(stand.nr())));
        paare.add(paar("Vorlage", VORLAGEN.getOrDefault(vorlage, vorlage) + ", Fassung " + kopf.path("vorlage_fassung").asInt()));
        paare.add(paar(BerichtRegeln.UNTERNEHMEN.equals(geltung.path("art").asText()) ? "Unternehmen" : "Standort",
                benannt(geltung.path("kennzeichen"), geltung.path("name_zum_datenstand"))));
        String unternehmen = verbunden(", ", text(kopf.path("unternehmen")), text(kopf.path("sitz")));
        if (!unternehmen.isEmpty() && !BerichtRegeln.UNTERNEHMEN.equals(geltung.path("art").asText())) {
            paare.add(paar("Unternehmen", unternehmen));
        } else if (kopf.hasNonNull("sitz")) {
            paare.add(paar("Sitz", kopf.path("sitz").asText()));
        }
        paare.add(paar("Zeitraum", zeitraum(kopf.path("zeitraum"), zone)));
        paare.add(paar("Zeitzone", zone.getId()));
        if (leistungsvergleich) {
            JsonNode referenz = kopf.path("referenzperiode");
            paare.add(paar("Referenzperiode", verbunden(" ", text(referenz.path("bezeichnung")),
                    referenz.hasNonNull("schluessel") ? "(" + referenz.path("schluessel").asText() + ")" : null)));
            paare.add(paar("Bezugsbasis", basisMitFassung(kopf.path("bezugsbasis").path("kennzeichen"),
                    kopf.path("bezugsbasis").path("fassung"))));
            if (!kopf.path("kennzeichen").isEmpty()) {
                paare.add(paar("Kennzeichen", String.join(TRENNER, liste(kopf.path("kennzeichen")))));
            }
        }
        kopf.path("vergleichszeitraeume").forEach(v -> paare.add(paar(
                VERGLEICHE.getOrDefault(v.path("art").asText(), v.path("art").asText()),
                verbunden(": ", text(v.path("schluessel")), text(v.path("ergebnis"))))));
        paare.add(paar("Datenstand", zeitMitZone(zeit(kopf.path("datenstand")), zone)));
        paare.add(paar("Freigegeben", KorrekturVorschlagRegeln.zeitpunkt(stand.freigegebenAm(), zone) + " von "
                + stand.freigegebenVon()));
        if (wasserzeichen != null) {
            paare.add(paar("Ersetzt", wasserzeichen));
        }
        JsonNode d = kopf.path("darstellung");
        paare.add(paar("Darstellung", verbunden(TRENNER, text(d.path("zahlenformat")),
                d.hasNonNull("dezimal") ? "Dezimalzeichen „" + d.path("dezimal").asText() + "“" : null, text(d.path("rundung")),
                text(d.path("sommerzeit")))));
        JsonNode rw = kopf.path("regelwerk");
        List<String> vertraege = new ArrayList<>();
        rw.path("vertraege").fields().forEachRemaining(e -> vertraege.add(e.getKey() + " " + e.getValue().asText()));
        paare.add(paar("Regelwerk", verbunden(TRENNER, rw.hasNonNull("software") ? "Software " + rw.path("software").asText()
                : null, vertraege.isEmpty() ? null : "Verträge " + String.join(", ", vertraege))));
        paare.add(paar("Prüfsumme", stand.pruefsumme()));
        s.paare(paare);
    }

    private static void zusammenfassung(Setzer s, JsonNode z, String ebene) throws IOException {
        List<String[]> paare = new ArrayList<>();
        SUMMEN.forEach((schluessel, wort) -> {
            if (z.path(schluessel).isNumber()) {
                paare.add(paar(wort, menge(z.path(schluessel), ErgebnisZustand.KWH, ebene)));
            }
        });
        z.fields().forEachRemaining(e -> {
            if (!SUMMEN.containsKey(e.getKey()) && !ANZAHLEN.contains(e.getKey()) && e.getValue().isNumber()) {
                boolean kwh = e.getKey().endsWith(ENDUNG_KWH);
                String wort = e.getKey().substring(0, e.getKey().length() - (kwh ? ENDUNG_KWH.length() : 0)).replace('_', ' ');
                paare.add(paar(Character.toUpperCase(wort.charAt(0)) + wort.substring(1),
                        kwh ? menge(e.getValue(), ErgebnisZustand.KWH, ebene) : ungerundet(zahl(e.getValue()), null)));
            }
        });
        if (z.has("werte")) {
            paare.add(paar("Werte", z.path("werte").asInt() + ", davon endgültig " + z.path("davon_endgueltig").asInt()
                    + ", davon vollständig " + z.path("davon_vollstaendig").asInt()));
        }
        if (paare.isEmpty()) {
            s.absatz("Keine Summe in diesem Bericht.", NORMAL, GRAU);
        } else {
            s.paare(paare);
        }
    }

    private static void messstellen(Setzer s, JsonNode werte, ZoneId zone, String ebene) throws IOException {
        if (werte.isEmpty()) {
            s.absatz("Keine Messstelle in diesem Bericht.", NORMAL, GRAU);
            return;
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        werte.forEach(w -> zeilen.add(List.of(List.of(benannt(w.path("quelle"), w.path("name_zum_datenstand"))),
                List.of(Objects.requireNonNullElse(text(w.path("ort_zum_datenstand")), ErgebnisZustand.OHNE_ZAHL)),
                List.of(menge(w.path("menge"), text(w.path("einheit")), ebene)), zustand(w), nachweis(w, zone, Arrays.asList(
                        text(w.path("fassung")), version(w), w.hasNonNull("formel_fassung")
                                ? "Formel-Fassung " + w.path("formel_fassung").asText() : null)))));
        s.tabelle(List.of(new Spalte("Messstelle", 150, false), new Spalte("Ort", 38, false),
                new Spalte("Menge", 70, true), new Spalte("Zustand", 78, false), new Spalte("Nachweis", 0, false)), zeilen);
    }

    private static void standorte(Setzer s, JsonNode abzug, ZoneId zone, String ebene) throws IOException {
        JsonNode standorte = abzug.path(BerichtCsv.STANDORTE);
        if (standorte.isEmpty()) {
            s.absatz("Kein Standort in diesem Bericht.", NORMAL, GRAU);
        } else {
            List<List<List<String>>> zeilen = new ArrayList<>();
            standorte.forEach(st -> {
                List<String> summen = new ArrayList<>();
                st.path("summen").fields().forEachRemaining(e -> summen.add(SUMMEN.getOrDefault(e.getKey(), e.getKey()) + " "
                        + menge(e.getValue(), ErgebnisZustand.KWH, ebene)));
                if (summen.isEmpty()) {
                    summen.add("Netzbezug " + ErgebnisZustand.OHNE_ZAHL);
                }
                List<String> messstellen = new ArrayList<>();
                st.path("messstellen").forEach(m -> messstellen.add(m.asText()));
                zeilen.add(List.of(List.of(benannt(st.path("kennzeichen"), st.path("name_zum_datenstand"))), summen,
                        List.of(String.join(", ", messstellen))));
            });
            s.tabelle(List.of(new Spalte("Standort", 150, false), new Spalte("Summen", 150, false),
                    new Spalte("Messstellen", 0, false)), zeilen);
        }
        s.zwischentitel("Messstellen");
        messstellen(s, abzug.path("werte"), zone, ebene);
    }

    private static void kostenstellen(Setzer s, JsonNode kostenstellen, String ebene) throws IOException {
        if (kostenstellen.isEmpty()) {
            s.absatz("Keine Kostenstelle in diesem Zeitraum.", NORMAL, GRAU);
            return;
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        kostenstellen.forEach(k -> {
            JsonNode summe = k.path("summe");
            List<String> summeZelle = new ArrayList<>();
            summeZelle.add(summe.path("menge").isNumber() ? menge(summe.path("menge"), text(summe.path("einheit")), ebene)
                    : ErgebnisZustand.OHNE_ZAHL);
            summeZelle.add(Objects.requireNonNullElse(summe.hasNonNull("zustand") ? summe.path("zustand").asText()
                    : text(summe.path("grund")), ""));
            List<String> verteilung = new ArrayList<>();
            for (String[] b : new String[][] {{"gemessen", "gemessen"}, {"verteilt", "verteilt"}, {"berechnet", "berechnet"},
                    {"nicht_verteilt", "nicht verteilt"}}) {
                JsonNode block = k.path(b[0]);
                verteilung.add(b[1] + " " + block(block, ebene));
                block.path("posten").forEach(p -> {
                    List<String> saetze = new ArrayList<>();
                    p.path("saetze").forEach(x -> saetze.add(ungerundet(zahl(x.path("anteil_prozent")), ErgebnisZustand.PROZENT)
                            + " " + tag(x.path("von")) + "–" + tag(x.path("bis"))));
                    verteilung.add("– " + benannt(p.path("quelle"), p.path("name_zum_datenstand")) + ": "
                            + (p.path("menge").isNumber() ? menge(p.path("menge"), text(p.path("einheit")), ebene)
                                    : ErgebnisZustand.OHNE_ZAHL)
                            + (saetze.isEmpty() ? "" : TRENNER + String.join(", ", saetze)));
                });
            }
            String bis = text(k.path("gueltig_bis"));
            zeilen.add(List.of(List.of(benannt(k.path("quelle"), k.path("name_zum_datenstand"))),
                    bis == null ? List.of("ab " + tag(k.path("gueltig_ab")))
                            : List.of("ab " + tag(k.path("gueltig_ab")), "bis " + tag(k.path("gueltig_bis"))),
                    summeZelle, verteilung));
        });
        s.tabelle(List.of(new Spalte("Kostenstelle", 130, false), new Spalte("Gültig", 78, false),
                new Spalte("Summe", 82, true), new Spalte("Verteilung", 0, false)), zeilen);
    }

    private static void kennzahlen(Setzer s, JsonNode kennzahlen, ZoneId zone, String ebene) throws IOException {
        if (kennzahlen.isEmpty()) {
            s.absatz("Keine Kennzahl in diesem Bericht.", NORMAL, GRAU);
            return;
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        kennzahlen.forEach(k -> {
            List<String> eingaenge = new ArrayList<>();
            k.path("eingaenge").forEach(e -> eingaenge.add(verbunden(" ", text(e.path("kennzeichen")),
                    ErgebnisZustand.KWH.equals(text(e.path("einheit"))) ? menge(e.path("wert"), ErgebnisZustand.KWH, ebene)
                            : ungerundet(zahl(e.path("wert")), text(e.path("einheit"))),
                    e.hasNonNull("version") ? "(Version " + e.path("version").asInt() + ")"
                            : e.hasNonNull("fassung") ? "(Fassung " + e.path("fassung").asInt() + ")" : null,
                    e.hasNonNull("stichtag") ? "zum " + tag(e.path("stichtag")) : null)));
            List<String> nachweis = nachweis(k, zone, Arrays.asList(text(k.path("fassung")), version(k),
                    k.hasNonNull("definition_fassung") ? "Definition Fassung " + k.path("definition_fassung").asInt() : null));
            if (!eingaenge.isEmpty()) {
                nachweis.add("Eingänge " + String.join(TRENNER, eingaenge));
            }
            zeilen.add(List.of(List.of(benannt(k.path("quelle"), k.path("name_zum_datenstand"))),
                    List.of(kennzahl(k.path("wert"), text(k.path("einheit")))), zustand(k), nachweis));
        });
        s.tabelle(List.of(new Spalte("Kennzahl", 150, false), new Spalte("Wert", 86, true),
                new Spalte("Zustand", 78, false), new Spalte("Nachweis", 0, false)), zeilen);
    }

    private static void umfang(Setzer s, JsonNode u) throws IOException {
        s.paare(List.of(paar("Fassung", textOderStrich(u.path("fassung"))),
                paar("Datengrundlage", tag(u.path("von")) + "–" + tag(u.path("bis"))),
                paar("Teilansicht", u.path("teilansicht").asBoolean(false) ? "ja" : "nein")));
    }

    private static void rangliste(Setzer s, JsonNode r) throws IOException {
        JsonNode n = r.path("nenner");
        s.paare(List.of(paar("Stromeinsatz", wert(n.path("wert"), text(n.path("einheit")))),
                paar("Anlagen", textOderStrich(n.path("anlagen"))),
                paar("Zugeordnet", wert(r.path("zugeordnet"), n.path("einheit").asText(null))),
                paar("Rest", wert(r.path("rest"), n.path("einheit").asText(null))),
                paar("Abdeckung", prozent(r.path("abdeckung_prozent"))),
                paar("Kriterien-Fassung", textOderStrich(r.path("kriterien").path("fassung")))));
        List<List<List<String>>> zeilen = new ArrayList<>();
        for (String gruppe : List.of("einsaetze", "weitere_traeger")) {
            r.path(gruppe).forEach(e -> zeilen.add(List.of(
                    List.of(benannt(e.path("kennzeichen"), e.path("name"))),
                    List.of(textOderStrich(e.path("traeger"))),
                    List.of(wert(e.path("menge"), text(e.path("einheit")))),
                    List.of(prozent(e.path("anteil_prozent")), e.path("rang").isIntegralNumber()
                            ? "Rang " + e.path("rang").asInt() : ErgebnisZustand.OHNE_ZAHL),
                    List.of(textOderStrich(e.path("vorschlag"))))));
        }
        if (zeilen.isEmpty()) {
            s.absatz("Noch keine Energieeinsätze.", NORMAL, GRAU);
        } else {
            s.tabelle(List.of(new Spalte("Energieeinsatz", 130, false), new Spalte("Träger", 58, false),
                    new Spalte("Menge", 70, true), new Spalte("Anteil", 68, false),
                    new Spalte("Vorschlag", 0, false)), zeilen);
        }
    }

    private static void einstufungen(Setzer s, JsonNode einstufungen) throws IOException {
        if (einstufungen.isEmpty()) {
            s.absatz("Noch keine Einstufung.", NORMAL, GRAU);
            return;
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        einstufungen.forEach(e -> zeilen.add(List.of(
                List.of(benannt(e.path("einsatz"), e.path("name_zum_datenstand"))),
                List.of(textOderStrich(e.path("einstufung"))),
                List.of(e.path("fassung").isIntegralNumber() ? "Fassung " + e.path("fassung").asInt()
                        : ErgebnisZustand.OHNE_ZAHL),
                List.of(e.path("gueltig_ab").isTextual() ? "seit " + tag(e.path("gueltig_ab")) : ErgebnisZustand.OHNE_ZAHL,
                        textOderStrich(e.path("person"))),
                List.of(textOderStrich(e.path("begruendung"))))));
        s.tabelle(List.of(new Spalte("Energieeinsatz", 125, false), new Spalte("Einstufung", 72, false),
                new Spalte("Fassung", 62, false), new Spalte("Seit / Person", 100, false),
                new Spalte("Begründung", 0, false)), zeilen);
    }

    private static void messabdeckung(Setzer s, JsonNode a) throws IOException {
        JsonNode summe = a.path("summe");
        s.paare(List.of(paar("Abdeckung", prozent(summe.path("abdeckung_prozent"))),
                paar("Gemessen zugeordnet", wert(summe.path("gemessen_zugeordnet"),
                        text(summe.path("nenner").path("einheit")))),
                paar("Ersatz", textOderStrich(summe.path("ersatz"))),
                paar("Ungemessen", wert(summe.path("ungemessen"), text(summe.path("nenner").path("einheit"))))));
        List<List<List<String>>> zeilen = new ArrayList<>();
        a.path("je_einsatz").forEach(e -> zeilen.add(List.of(
                List.of(benannt(e.path("kennzeichen"), e.path("name"))),
                liste(e.path("gemessen"), "kennzeichen"), liste(e.path("geplant"), "kennzeichen"),
                liste(e.path("ersatz"), "kennzeichen"), liste(e.path("ungemessen"), "anlage"))));
        if (!zeilen.isEmpty()) {
            s.tabelle(List.of(new Spalte("Energieeinsatz", 125, false), new Spalte("Gemessen", 86, false),
                    new Spalte("Geplant", 86, false), new Spalte("Ersatz", 86, false),
                    new Spalte("Ungemessen", 0, false)), zeilen);
        }
    }

    private static void messplanung(Setzer s, JsonNode abzug) throws IOException {
        JsonNode planung = abzug.path(BerichtCsv.MESSPLANUNG);
        if (planung.isEmpty()) {
            s.absatz("Kein Messbedarf eingetragen.", NORMAL, GRAU);
            return;
        }
        Map<String, String> einsaetze = new LinkedHashMap<>();
        for (String gruppe : List.of("einsaetze", "weitere_traeger")) {
            abzug.path(BerichtCsv.RANGLISTE).path(gruppe).forEach(e ->
                    einsaetze.put(text(e.path("id")), text(e.path("kennzeichen"))));
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        planung.forEach(m -> zeilen.add(List.of(
                List.of(textOderStrich(m.path("kennzeichen")), Objects.requireNonNullElse(
                        einsaetze.get(text(m.path("einsatz_id"))), ErgebnisZustand.OHNE_ZAHL)),
                List.of(textOderStrich(m.path("wortlaut")), verbunden(TRENNER, text(m.path("ort")), text(m.path("groesse")))),
                List.of(textOderStrich(m.path("zustand")), m.path("frist").isTextual()
                        ? "Frist " + tag(m.path("frist")) : ErgebnisZustand.OHNE_ZAHL),
                List.of(verbunden(TRENNER, text(m.path("messstelle")), text(m.path("begruendung")))))));
        s.tabelle(List.of(new Spalte("Messbedarf", 78, false), new Spalte("Aufgabe", 180, false),
                new Spalte("Zustand", 92, false), new Spalte("Einlösung / Grund", 0, false)), zeilen);
    }

    private static void messmittel(Setzer s, JsonNode messmittel) throws IOException {
        if (messmittel.isEmpty()) {
            s.absatz("Keine Messmittel-Angabe.", NORMAL, GRAU);
            return;
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        messmittel.forEach(m -> {
            JsonNode beleg = m.path("beleg");
            zeilen.add(List.of(List.of(benannt(m.path("geraet"), m.path("einbau"))),
                    List.of(textOderStrich(m.path("genauigkeitsklasse"))),
                    List.of(textOderStrich(m.path("pruefungsart")), m.path("pruefung_am").isTextual()
                            ? "am " + tag(m.path("pruefung_am")) : ErgebnisZustand.OHNE_ZAHL,
                            m.path("pruefung_gueltig_bis").isTextual()
                                    ? "gültig bis " + tag(m.path("pruefung_gueltig_bis")) : ErgebnisZustand.OHNE_ZAHL),
                    List.of(verbunden(TRENNER, text(beleg.path("bezeichnung")), text(beleg.path("ablage")),
                            text(beleg.path("sha256"))))));
        });
        s.tabelle(List.of(new Spalte("Gerät / Einbau", 120, false), new Spalte("Klasse", 58, false),
                new Spalte("Prüfung", 125, false), new Spalte("Beleg", 0, false)), zeilen);
    }

    private static void qualitaet(Setzer s, JsonNode q, ZoneId zone) throws IOException {
        List<String[]> paare = new ArrayList<>();
        paare.add(paar("Abdeckung", q.path("abdeckung_min_prozent").isNumber()
                ? "mindestens " + ErgebnisZustand.zahl(zahl(q.path("abdeckung_min_prozent")), ErgebnisZustand.PROZENT, null)
                : ErgebnisZustand.OHNE_ZAHL));
        paare.add(paar("Lücken", anzahl(q.path("luecken"))));
        paare.add(paar("Ersatzwerte", anzahl(q.path("ersatzwerte"))));
        paare.add(paar("Korrekturen im Zeitraum", anzahl(q.path("korrekturen_im_zeitraum"))));
        paare.add(paar("Vorläufige Werte", anzahl(q.path("vorlaeufig"))));
        s.paare(paare);
        if (!q.path("korrekturen").isEmpty()) {
            s.zwischentitel("Korrekturen");
            List<List<List<String>>> zeilen = new ArrayList<>();
            q.path("korrekturen").forEach(k -> zeilen.add(List.of(List.of(Objects.requireNonNullElse(text(k.path("kennung")), "")),
                    List.of(Objects.requireNonNullElse(text(k.path("reihe")), "")),
                    List.of(verbunden(" von ", k.path("freigegeben").isTextual()
                            ? KorrekturVorschlagRegeln.zeitpunkt(zeit(k.path("freigegeben")), zone) : null, text(k.path("wer")))),
                    List.of(Objects.requireNonNullElse(text(k.path("warum")), "")))));
            s.tabelle(List.of(new Spalte("Korrektur", 70, false), new Spalte("Messstelle", 50, false),
                    new Spalte("Freigegeben", 170, false), new Spalte("Warum", 0, false)), zeilen);
        }
    }

    /** Das Quellenverzeichnis des Kopfs; Name und Version oder Fassung, soweit der Abzug sie trägt — sonst „—“. */
    private static void quellenverzeichnis(Setzer s, JsonNode abzug) throws IOException {
        JsonNode verzeichnis = abzug.path(KOPF).path(QUELLENVERZEICHNIS);
        if (verzeichnis.isEmpty()) {
            s.absatz("Keine Quelle in diesem Bericht.", NORMAL, GRAU);
            return;
        }
        Map<String, String> namen = new LinkedHashMap<>();
        Map<String, Set<String>> fassungen = new LinkedHashMap<>();
        abzug.path("werte").forEach(w -> {
            namen.putIfAbsent(w.path("quelle").asText(), text(w.path("name_zum_datenstand")));
            merke(fassungen, w.path("quelle").asText(), version(w));
        });
        abzug.path(BerichtCsv.KENNZAHLEN).forEach(k -> {
            namen.putIfAbsent(k.path("quelle").asText(), text(k.path("name_zum_datenstand")));
            merke(fassungen, k.path("quelle").asText(), verbunden(TRENNER, version(k), k.hasNonNull("definition_fassung")
                    ? "Definition Fassung " + k.path("definition_fassung").asInt() : null));
            k.path("eingaenge").forEach(e -> merke(fassungen, e.path("kennzeichen").asText(), e.hasNonNull("version")
                    ? "Version " + e.path("version").asInt() : e.hasNonNull("fassung") ? "Fassung " + e.path("fassung").asInt() : null));
        });
        abzug.path(BerichtCsv.KOSTENSTELLEN).forEach(k -> namen.putIfAbsent(k.path("quelle").asText(),
                text(k.path("name_zum_datenstand"))));
        abzug.path(BerichtCsv.STANDORTE).forEach(st -> namen.putIfAbsent(st.path("kennzeichen").asText(),
                text(st.path("name_zum_datenstand"))));
        JsonNode umfang = abzug.path(BerichtCsv.UMFANG);
        if (!umfang.isMissingNode()) {
            namen.putIfAbsent("Umfang", "Betrachtungsumfang");
            merke(fassungen, "Umfang", umfang.path("fassung").isIntegralNumber()
                    ? "Fassung " + umfang.path("fassung").asInt() : null);
        }
        for (String gruppe : List.of("einsaetze", "weitere_traeger")) {
            abzug.path(BerichtCsv.RANGLISTE).path(gruppe).forEach(e ->
                    namen.putIfAbsent(e.path("kennzeichen").asText(), text(e.path("name"))));
        }
        abzug.path(BerichtCsv.EINSTUFUNGEN).forEach(e -> {
            String kz = e.path("einsatz").asText();
            namen.putIfAbsent(kz, text(e.path("name_zum_datenstand")));
            merke(fassungen, kz, e.path("fassung").isIntegralNumber()
                    ? "Einstufung Fassung " + e.path("fassung").asInt() : null);
        });
        abzug.path(BerichtCsv.MESSPLANUNG).forEach(m -> namen.putIfAbsent(m.path("kennzeichen").asText(),
                text(m.path("wortlaut"))));
        abzug.path(BerichtCsv.MESSMITTEL).forEach(m -> namen.putIfAbsent(m.path("einbau").asText(),
                text(m.path("geraet"))));
        List<List<List<String>>> zeilen = new ArrayList<>();
        verzeichnis.forEach(q -> {
            String kz = q.asText();
            Set<String> f = fassungen.getOrDefault(kz, Set.of());
            zeilen.add(List.of(List.of(kz), List.of(Objects.requireNonNullElse(namen.get(kz), ErgebnisZustand.OHNE_ZAHL)),
                    List.of(f.isEmpty() ? ErgebnisZustand.OHNE_ZAHL : String.join(", ", f))));
        });
        s.tabelle(List.of(new Spalte("Kennzeichen", 70, false), new Spalte("Name zum Datenstand", 250, false),
                new Spalte("Version oder Fassung", 0, false)), zeilen);
    }

    // ================================================================================ Leistungsvergleich (AP-17 IP-22)

    private static void kennzahl(Setzer s, JsonNode k) throws IOException {
        s.paare(List.of(paar("Kennzahl", benannt(k.path("kennzeichen"), k.path("name_zum_datenstand"))),
                paar("Einheit", textOderStrich(k.path("einheit")))));
    }

    /** Die Fassung als Kopie (M4): Methode, Referenzperiode, Basiswert bzw. Koeffizienten, Güte, Toleranz, Freigabe. */
    private static void bezugsbasis(Setzer s, JsonNode abzug, ZoneId zone) throws IOException {
        JsonNode b = abzug.path(BerichtCsv.BEZUGSBASIS);
        String einheit = text(abzug.path(BerichtCsv.KENNZAHL).path("einheit"));
        JsonNode referenz = abzug.path(KOPF).path("referenzperiode");
        List<String[]> paare = new ArrayList<>();
        paare.add(paar("Bezugsbasis", basisMitFassung(b.path("kennzeichen"), b.path("fassung"))));
        paare.add(paar("Methode", METHODEN.getOrDefault(b.path("methode").asText(), text(b.path("methode")))));
        paare.add(paar("Referenzperiode", verbunden(" ", text(referenz.path("bezeichnung")),
                b.hasNonNull("referenzperiode") ? "(" + b.path("referenzperiode").asText() + ")" : null)));
        paare.add(paar("Datenlage", DATENLAGEN.getOrDefault(b.path("datenlage").asText(), text(b.path("datenlage")))));
        paare.add(paar("Gilt", verbunden(" ", "seit " + tag(b.path("gilt_ab")),
                b.hasNonNull("gilt_bis") ? "bis " + tag(b.path("gilt_bis")) : null)));
        if (b.hasNonNull("basiswert")) {
            paare.add(paar("Basiswert", wert(b.path("basiswert"), einheit)));
        }
        if (b.path("koeffizienten").isObject()) {
            List<String> k = new ArrayList<>();
            b.path("koeffizienten").fields().forEachRemaining(e -> k.add(e.getKey() + " = " + wert(e.getValue(), null)));
            paare.add(paar("Koeffizienten", String.join(TRENNER, k)));
        }
        if (b.hasNonNull("r2")) {
            paare.add(paar("Bestimmtheitsmaß", wert(b.path("r2"), null)));
        }
        paare.add(paar("Streuung", band(b.path("streuung_prozent"))));
        paare.add(paar("Toleranz", band(b.path("toleranz_prozent"))));
        paare.add(paar("Freigegeben", verbunden(", ", verbunden(" ", text(b.path("freigegeben_von")),
                b.hasNonNull("freigegeben_rolle") ? "(" + b.path("freigegeben_rolle").asText() + ")" : null),
                b.hasNonNull("freigegeben_am") ? KorrekturVorschlagRegeln.zeitpunkt(zeit(b.path("freigegeben_am")), zone)
                        : null)));
        if (b.hasNonNull("beendet_zum")) {
            paare.add(paar("Beendet", verbunden(" ", "zum " + tag(b.path("beendet_zum")),
                    b.hasNonNull("beendet_grund") ? "(" + b.path("beendet_grund").asText() + ")" : null)));
        }
        paare.add(paar("Prüfsumme der Fassung", textOderStrich(b.path("pruefsumme"))));
        s.paare(paare);
    }

    /**
     * Je Monat der bereinigte Vergleich mit Urteil als Wort und Band (U2–U4); darunter der Satz des Monats und — getrennt,
     * ohne Wort — die rohe Veränderung zum Vormonat (U1, VG3, SP2).
     */
    private static void vergleichJePeriode(Setzer s, JsonNode monate) throws IOException {
        if (monate.isEmpty()) {
            s.absatz("Kein Monat im Zeitraum.", NORMAL, GRAU);
            return;
        }
        String einheit = null;
        List<List<List<String>>> zeilen = new ArrayList<>();
        for (JsonNode m : monate) {
            JsonNode b = m.path("bereinigt");
            JsonNode g = b.path("gemessen");
            einheit = einheit == null ? text(g.path("einheit")) : einheit;
            List<String> gemessen = new ArrayList<>(List.of(wert(g.path("wert"), text(g.path("einheit")))));
            if (g.path("version").isIntegralNumber()) {
                gemessen.add("Version " + g.path("version").asInt());
            }
            if (g.hasNonNull("zustand")) {
                gemessen.add(g.path("zustand").asText());
            }
            List<String> bedingung = new ArrayList<>();
            b.path("bedingung").forEach(v -> bedingung.add(verbunden(TRENNER,
                    verbunden(" ", Objects.requireNonNullElse(text(v.path("kennzeichen")), text(v.path("name"))),
                            wert(v.path("wert"), text(v.path("einheit")))),
                    v.path("fassung").isIntegralNumber() ? "Fassung " + v.path("fassung").asInt()
                            : v.path("version").isIntegralNumber() ? "Version " + v.path("version").asInt() : null,
                    KennzahlRegeln.VORLAEUFIG.equals(text(v.path("zustand"))) ? KennzahlRegeln.VORLAEUFIG : null)));
            zeilen.add(List.of(List.of(textOderStrich(m.path("beschriftung"))), gemessen,
                    bedingung.isEmpty() ? List.of(ErgebnisZustand.OHNE_ZAHL) : bedingung,
                    List.of(wert(b.path("erwartet"), text(g.path("einheit")))), List.of(abweichung(b.path("delta_prozent"))),
                    urteilZelle(b), b.path("kennzeichen").isEmpty() ? List.of(ErgebnisZustand.OHNE_ZAHL)
                            : liste(b.path("kennzeichen"))));
        }
        s.tabelle(List.of(new Spalte("Periode", 62, false), new Spalte("Gemessen", 66, true),
                new Spalte("Bedingung", 92, false), new Spalte("Erwartet", 58, true), new Spalte("Abweichung", 50, true),
                new Spalte("Urteil", 62, false), new Spalte("Kennzeichen", 0, false)), zeilen);
        s.abstand(4);
        for (JsonNode m : monate) {
            if (m.hasNonNull("satz")) {
                s.absatz(m.path("satz").asText(), NORMAL, SCHWARZ);
            }
        }

        s.zwischentitel("Ohne Bereinigung — Veränderung zum Vormonat, ohne Urteil");
        List<List<List<String>>> roh = new ArrayList<>();
        for (JsonNode m : monate) {
            JsonNode r = m.path("roh");
            roh.add(List.of(List.of(textOderStrich(m.path("beschriftung"))), List.of(wert(r.path("gemessen"), einheit)),
                    List.of(wert(r.path("vorher"), einheit)), List.of(abweichung(r.path("delta_prozent"))),
                    List.of(abweichung(r.path("variable_delta_prozent")))));
        }
        s.tabelle(List.of(new Spalte("Periode", 62, false), new Spalte("Gemessen", 80, true),
                new Spalte("Vormonat", 80, true), new Spalte("Veränderung", 70, true),
                new Spalte("Einflussgröße", 0, false)), roh);
    }

    /** Der Zeitraum (U5): Σ gemessen ÷ Σ erwartet gegen die Fassung am letzten Tag — nie ein Mittel. */
    private static void urteil(Setzer s, JsonNode abzug) throws IOException {
        JsonNode u = abzug.path(BerichtCsv.URTEIL);
        String einheit = null;
        for (JsonNode m : abzug.path(BerichtCsv.VERGLEICH_JE_PERIODE)) {
            einheit = einheit == null ? text(m.path("bereinigt").path("gemessen").path("einheit")) : einheit;
        }
        s.paare(List.of(paar("Monate", textOderStrich(u.path("monate"))),
                paar("Gemessen", wert(u.path("gemessen"), einheit)),
                paar("Erwartet", wert(u.path("erwartet"), einheit)),
                paar("Abweichung", abweichung(u.path("delta_prozent"))),
                paar("Urteil", String.join(TRENNER, urteilZelle(u))),
                paar("Bezugsbasis", basisMitFassung(abzug.path(BerichtCsv.BEZUGSBASIS).path("kennzeichen"),
                        u.path("fassung"))),
                paar("Kennzeichen", u.path("kennzeichen").isEmpty() ? ErgebnisZustand.OHNE_ZAHL
                        : String.join(TRENNER, liste(u.path("kennzeichen"))))));
        if (u.hasNonNull("satz")) {
            s.abstand(4);
            s.absatz(u.path("satz").asText(), NORMAL, SCHWARZ);
        }
    }

    private static void grenzen(Setzer s, JsonNode abzug) throws IOException {
        JsonNode g = abzug.path(BerichtCsv.GRENZEN);
        List<String[]> paare = new ArrayList<>();
        paare.add(paar("Datenlage", DATENLAGEN.getOrDefault(g.path("datenlage").asText(), text(g.path("datenlage")))));
        paare.add(paar("Toleranz", band(g.path("toleranz_prozent"))));
        paare.add(paar("Streuung", band(g.path("streuung_prozent"))));
        paare.add(paar("Kennzeichen", g.path("kennzeichen").isEmpty() ? ErgebnisZustand.OHNE_ZAHL
                : String.join(TRENNER, liste(g.path("kennzeichen")))));
        Map<String, JsonNode> monate = new LinkedHashMap<>();
        abzug.path(BerichtCsv.VERGLEICH_JE_PERIODE).forEach(m -> monate.put(m.path("periode").asText(), m));
        g.path("nicht_anwendbar").forEach(n -> {
            JsonNode m = monate.get(n.path("periode").asText());
            paare.add(paar(m == null ? n.path("periode").asText() : textOderStrich(m.path("beschriftung")),
                    m != null && m.hasNonNull("satz") ? m.path("satz").asText() : "nicht bewertbar"));
        });
        s.paare(paare);
        s.abstand(4);
        s.absatz(GRENZEN_SATZ, NORMAL, GRAU);
    }

    /** Was jeder Leistungsvergleich über sich selbst sagt (U1, U6): Urteil nur bereinigt, keine Ursache. */
    static final String GRENZEN_SATZ = "Ein Urteil gibt es nur bereinigt um die Bedingung der Bezugsbasis; die "
            + "Veränderung ohne Bereinigung trägt keins. Eine Ursache für eine Abweichung nennt der Vergleich nicht.";

    private static void statischeFaktoren(Setzer s, JsonNode faktoren) throws IOException {
        if (faktoren.isEmpty()) {
            s.absatz("Keine statischen Faktoren an dieser Fassung.", NORMAL, GRAU);
            return;
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        faktoren.forEach(f -> zeilen.add(List.of(
                List.of(verbunden(" ", text(f.path("kennzeichen")), text(f.path("wortlaut")))),
                f.hasNonNull("wert") ? List.of(wert(f.path("wert"), text(f.path("einheit"))),
                        f.hasNonNull("wert_gueltig_ab") ? "gültig ab " + tag(f.path("wert_gueltig_ab"))
                                : ErgebnisZustand.OHNE_ZAHL) : List.of(ErgebnisZustand.OHNE_ZAHL),
                List.of(tag(f.path("kopie_am"))))));
        s.tabelle(List.of(new Spalte("Statischer Faktor", 250, false), new Spalte("Wert zur Fassung", 130, false),
                new Spalte("Kopie vom", 0, false)), zeilen);
    }

    /** Das Quellenverzeichnis mit Bezug, Tagen und Version bzw. Fassung (S2). */
    private static void quellenMitBezug(Setzer s, JsonNode verzeichnis) throws IOException {
        if (verzeichnis.isEmpty()) {
            s.absatz("Keine Quelle in diesem Bericht.", NORMAL, GRAU);
            return;
        }
        List<List<List<String>>> zeilen = new ArrayList<>();
        verzeichnis.forEach(q -> zeilen.add(List.of(List.of(textOderStrich(q.path("kennzeichen"))),
                List.of(textOderStrich(q.path("name_zum_datenstand"))),
                List.of(BEZUEGE.getOrDefault(q.path("bezug").asText(), textOderStrich(q.path("bezug")))),
                List.of(tag(q.path("erster_tag")) + "–" + tag(q.path("letzter_tag"))),
                List.of(q.path("version").isIntegralNumber() ? "Version " + q.path("version").asInt()
                        : q.path("fassung").isIntegralNumber() ? "Fassung " + q.path("fassung").asInt()
                        : ErgebnisZustand.OHNE_ZAHL))));
        s.tabelle(List.of(new Spalte("Kennzeichen", 64, false), new Spalte("Name zum Datenstand", 170, false),
                new Spalte("Bezug", 66, false), new Spalte("Zeitraum", 110, false),
                new Spalte("Version oder Fassung", 0, false)), zeilen);
    }

    /** Das Urteil als Wort mit Band (U3) — ohne Urteil „nicht bewertbar“; ein Wort nie an einer rohen Zahl. */
    private static List<String> urteilZelle(JsonNode b) {
        String wort = BezugsbasisVergleichSatz.URTEIL_WORT.get(b.path("urteil").asText());
        if (wort == null || "nicht_anwendbar".equals(b.path("urteil").asText())) {
            return List.of("nicht bewertbar");
        }
        return b.hasNonNull("band_prozent") ? List.of(wort, band(b.path("band_prozent"))) : List.of(wort);
    }

    private static String basisMitFassung(JsonNode kennzeichen, JsonNode fassung) {
        return verbunden(", ", text(kennzeichen), fassung.isIntegralNumber() ? "Fassung " + fassung.asInt() : null);
    }

    /** „± 2 %“ — ohne Wert der Strich. */
    private static String band(JsonNode n) {
        String p = prozent(n);
        return ErgebnisZustand.OHNE_ZAHL.equals(p) ? p : "± " + p;
    }

    /** Eine Veränderung mit Vorzeichen („+12,9 %“, „−8,8 %“) — ein Zeichen, kein Wort (SP2). */
    private static String abweichung(JsonNode n) {
        String roh = text(n);
        if (roh == null || roh.isBlank()) {
            return ErgebnisZustand.OHNE_ZAHL;
        }
        try {
            BigDecimal d = new BigDecimal(roh);
            return (d.signum() > 0 ? "+" : d.signum() < 0 ? "−" : "") + ungerundet(d.abs(), ErgebnisZustand.PROZENT);
        } catch (NumberFormatException e) {
            return roh;
        }
    }

    private static List<String> liste(JsonNode texte) {
        List<String> raus = new ArrayList<>();
        texte.forEach(t -> raus.add(t.asText()));
        return raus;
    }

    // ================================================================================ Zellen und Texte

    private static List<String> zustand(JsonNode w) {
        List<String> raus = new ArrayList<>();
        raus.add(Objects.requireNonNullElse(text(w.path("zustand")), ErgebnisZustand.OHNE_ZAHL));
        if (w.path("abdeckung_prozent").isNumber()) {
            raus.add("Abdeckung " + ErgebnisZustand.zahl(zahl(w.path("abdeckung_prozent")), ErgebnisZustand.PROZENT, null));
        }
        return raus;
    }

    /** Der Nachweis je Zahl: Fassung · Version …, endgültig ab, gerechnet, Kennzeichen. */
    private static List<String> nachweis(JsonNode w, ZoneId zone, List<String> erste) {
        List<String> raus = new ArrayList<>();
        String kopfzeile = verbunden(TRENNER, erste.toArray(String[]::new));
        if (!kopfzeile.isEmpty()) {
            raus.add(kopfzeile);
        }
        if (w.path("endgueltig_ab").isTextual()) {
            raus.add("endgültig ab " + OrtsbaumAbleitung.datumText(TagRegeln.tag(zeit(w.path("endgueltig_ab")), zone)));
        }
        if (w.path("berechnet_am").isTextual()) {
            raus.add("gerechnet " + KorrekturVorschlagRegeln.zeitpunkt(zeit(w.path("berechnet_am")), zone));
        }
        List<String> kennzeichen = new ArrayList<>();
        w.path("kennzeichen").forEach(k -> kennzeichen.add(k.asText()));
        if (!kennzeichen.isEmpty()) {
            raus.add(String.join(BerichtRegeln.KENNZEICHEN_TRENNER, kennzeichen));
        }
        return raus;
    }

    private static String version(JsonNode w) {
        return w.path("version").isIntegralNumber() ? "Version " + w.path("version").asInt() : null;
    }

    private static void merke(Map<String, Set<String>> fassungen, String kennzeichen, String fassung) {
        if (fassung != null && !fassung.isEmpty()) {
            fassungen.computeIfAbsent(kennzeichen, k -> new LinkedHashSet<>()).add(fassung);
        }
    }

    /** Eine Menge nach DA1; eine Einheit ohne Ebenen-Regel ungerundet in derselben Schreibweise. Keine Zahl ist „—“. */
    static String menge(JsonNode n, String einheit, String ebene) {
        BigDecimal wert = zahl(n);
        if (wert == null || einheit == null) {
            return wert == null ? ErgebnisZustand.OHNE_ZAHL : ungerundet(wert, null);
        }
        try {
            return BerichtRegeln.anzeige(BerichtRegeln.ANZEIGE_MENGE, wert, einheit, ebene);
        } catch (IllegalArgumentException | java.util.NoSuchElementException e) {
            return ungerundet(wert, einheit);
        }
    }

    private static String kennzahl(JsonNode n, String einheit) {
        BigDecimal wert = zahl(n);
        return wert == null || einheit == null ? ungerundet(wert, einheit)
                : BerichtRegeln.anzeige(BerichtRegeln.ANZEIGE_KENNZAHL, wert, einheit, null);
    }

    private static String ungerundet(BigDecimal wert, String einheit) {
        if (wert == null) {
            return ErgebnisZustand.OHNE_ZAHL;
        }
        String raus = ErgebnisZustand.zahlMitStellen(wert, Math.max(0, wert.stripTrailingZeros().scale()),
                einheit == null ? "" : einheit);
        return einheit == null ? raus.strip() : raus;
    }

    private static String block(JsonNode b, String ebene) {
        if (b.path("menge").isNumber()) {
            return menge(b.path("menge"), text(b.path("einheit")), ebene);
        }
        return Objects.requireNonNullElse(text(b.path("grund")), ErgebnisZustand.OHNE_ZAHL);
    }

    private static String anzahl(JsonNode n) {
        return n.isIntegralNumber() ? String.valueOf(n.asLong()) : ErgebnisZustand.OHNE_ZAHL;
    }

    private static String geltung(JsonNode g) {
        return BerichtRegeln.UNTERNEHMEN.equals(g.path("art").asText())
                ? "Unternehmen " + g.path("name_zum_datenstand").asText()
                : "Standort " + verbunden(" ", text(g.path("kennzeichen")), text(g.path("name_zum_datenstand")));
    }

    private static String zeitraum(JsonNode z, ZoneId zone) {
        BerichtRegeln.Zeitraum t = BerichtRegeln.zeitraum(z.path("art").asText(), z.path("schluessel").asText(), zone);
        return OrtsbaumAbleitung.datumText(t.ersterTag()) + "–" + OrtsbaumAbleitung.datumText(t.letzterTag()) + " ("
                + z.path("schluessel").asText() + ")";
    }

    /** „10.11.2026 08:55 (MEZ)“ — an der doppelten Stunde trägt die Uhr den Zusatz schon (D5). */
    private static String zeitMitZone(Instant t, ZoneId zone) {
        String zeitpunkt = KorrekturVorschlagRegeln.zeitpunkt(t, zone);
        return ErgebnisZustand.uhr(t, zone).contains(" ") ? zeitpunkt
                : zeitpunkt + " (" + ErgebnisZustand.zoneKurz(t, zone) + ")";
    }

    private static String benannt(JsonNode kennzeichen, JsonNode name) {
        return verbunden(" ", text(kennzeichen), text(name));
    }

    private static String textOderStrich(JsonNode n) {
        return Objects.requireNonNullElse(text(n), ErgebnisZustand.OHNE_ZAHL);
    }

    private static String wert(JsonNode n, String einheit) {
        String roh = text(n);
        if (roh == null || roh.isBlank()) return ErgebnisZustand.OHNE_ZAHL;
        try {
            return ungerundet(new BigDecimal(roh), einheit);
        } catch (NumberFormatException e) {
            return verbunden(" ", roh, einheit);
        }
    }

    private static String prozent(JsonNode n) {
        return wert(n, ErgebnisZustand.PROZENT);
    }

    private static List<String> liste(JsonNode werte, String feld) {
        List<String> raus = new ArrayList<>();
        werte.forEach(w -> raus.add(textOderStrich(w.path(feld))));
        return raus.isEmpty() ? List.of(ErgebnisZustand.OHNE_ZAHL) : raus;
    }

    private static String tag(JsonNode n) {
        return n.isTextual() ? OrtsbaumAbleitung.datumText(LocalDate.parse(n.asText())) : ErgebnisZustand.OHNE_ZAHL;
    }

    private static String[] paar(String etikett, String wert) {
        return new String[] {etikett, wert == null ? ErgebnisZustand.OHNE_ZAHL : wert};
    }

    private static String verbunden(String trenner, String... teile) {
        return String.join(trenner, Arrays.stream(teile).filter(t -> t != null && !t.isEmpty()).toList());
    }

    private static ZoneId zone(JsonNode kopf) {
        return ZoneId.of(kopf.path("darstellung").path("zeitzone").asText(kopf.path("zeitraum").path("zone").asText()));
    }

    private static String text(JsonNode n) {
        return n.isMissingNode() || n.isNull() ? null : n.asText();
    }

    private static BigDecimal zahl(JsonNode n) {
        return n.isNumber() ? n.decimalValue() : null;
    }

    private static Instant zeit(JsonNode n) {
        return OffsetDateTime.parse(n.asText()).toInstant();
    }

    // ================================================================================ Dokument

    /**
     * Titel, Datum und Kennung des Dokuments — alles aus dem Stand: {@code CreationDate} = {@code ModDate} = Freigabe; die
     * {@code /ID} (zwei Werte, je 16 Bytes SHA-256) aus der Prüfsumme und — für die zweite — aus Nr. und Wasserzeichen. Ohne
     * sie schriebe PDFBox eine aus der Uhr.
     */
    private static void eigenschaften(PDDocument doc, JsonNode kopf, BerichtCsv.Stand stand, ZoneId zone) {
        PDDocumentInformation info = new PDDocumentInformation();
        String vorlage = kopf.path("vorlage").asText();
        info.setTitle(VORLAGEN.getOrDefault(vorlage, vorlage) + " " + kopf.path("bericht").asText() + TRENNER
                + BerichtRegeln.berichtsstand(stand.nr()));
        info.setSubject(geltung(kopf.path("geltung")) + TRENNER + zeitraum(kopf.path("zeitraum"), zone));
        info.setCreator(ERZEUGER);
        info.setProducer(ERZEUGER);
        Calendar am = GregorianCalendar.from(stand.freigegebenAm().atZone(zone));
        info.setCreationDate(am);
        info.setModificationDate(am);
        doc.setDocumentInformation(info);
        COSArray id = new COSArray();
        id.add(new COSString(Arrays.copyOf(sha256(stand.pruefsumme()), 16)));
        id.add(new COSString(Arrays.copyOf(sha256(stand.pruefsumme() + "|" + stand.nr() + "|"
                + Objects.toString(stand.ersetztDurchNr(), "")), 16)));
        doc.getDocument().getTrailer().setItem(COSName.ID, id);
    }

    private static byte[] sha256(String text) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 fehlt in dieser JVM", e);
        }
    }

    private static byte[] schriftDatei() {
        try (InputStream in = PDDocument.class.getResourceAsStream(SCHRIFT)) {
            if (in == null) {
                throw new IllegalStateException("Die Schrift " + SCHRIFT + " fehlt im pdfbox-Jar");
            }
            return in.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private static <V> Map<String, V> geordnet(Object... paare) {
        Map<String, V> raus = new LinkedHashMap<>();
        for (int i = 0; i < paare.length; i += 2) {
            raus.put((String) paare[i], (V) paare[i + 1]);
        }
        return Collections.unmodifiableMap(raus);
    }

    /** Eine Tabellenspalte; Breite 0 = der Rest der Zeile. */
    private record Spalte(String titel, float breite, boolean rechts) {}

    /** Setzt Text von oben nach unten auf A4-Seiten, bricht Zeilen und Seiten um und schreibt am Ende die Füße. */
    private static final class Setzer {

        private final PDDocument doc;
        private final PDType0Font schrift;
        private final CmapLookup zeichen;
        private final String wasserzeichen;
        private final List<PDPage> seiten = new ArrayList<>();
        private PDPageContentStream cs;
        private float y;

        Setzer(PDDocument doc, PDType0Font schrift, CmapLookup zeichen, String wasserzeichen) {
            this.doc = doc;
            this.schrift = schrift;
            this.zeichen = zeichen;
            this.wasserzeichen = wasserzeichen == null ? null : sicher(wasserzeichen, zeichen);
        }

        void seite() throws IOException {
            if (cs != null) {
                cs.close();
            }
            PDPage p = new PDPage(FORMAT);
            doc.addPage(p);
            seiten.add(p);
            cs = new PDPageContentStream(doc, p);
            y = OBEN;
            if (wasserzeichen != null) {
                wasserzeichen();
                y -= KLEIN * ZEILE;
                text(RAND + BREITE - breite(wasserzeichen, KLEIN), grundlinie(KLEIN), KLEIN, GRAU, wasserzeichen);
                abstand(4);
            }
        }

        /** Reicht der Platz nicht, beginnt eine neue Seite ({@code true}). */
        boolean platz(float hoehe) throws IOException {
            if (y - hoehe < UNTEN) {
                seite();
                return true;
            }
            return false;
        }

        void abstand(float punkte) {
            y -= punkte;
        }

        void titel(String t) throws IOException {
            absatz(t, TITEL, SCHWARZ);
            abstand(2);
        }

        void ueberschrift(String t) throws IOException {
            platz(UEBERSCHRIFT * ZEILE + 14 + 3 * NORMAL * ZEILE);
            abstand(14);
            absatz(t, UEBERSCHRIFT, SCHWARZ);
            abstand(2);
            linie(y, SCHWARZ, 0.6f);
            abstand(4);
        }

        void zwischentitel(String t) throws IOException {
            platz(NORMAL * ZEILE + 8 + 3 * NORMAL * ZEILE);
            abstand(8);
            absatz(t, NORMAL, GRAU);
        }

        void absatz(String t, float groesse, float grau) throws IOException {
            for (String z : umbrechen(sicher(t, zeichen), groesse, BREITE)) {
                platz(groesse * ZEILE);
                y -= groesse * ZEILE;
                text(RAND, grundlinie(groesse), groesse, grau, z);
            }
        }

        /** Etikett links, Wert rechts daneben, umbrochen. */
        void paare(List<String[]> paare) throws IOException {
            float zeile = NORMAL * ZEILE;
            for (String[] p : paare) {
                List<String> werte = umbrechen(sicher(p[1], zeichen), NORMAL, BREITE - ETIKETT);
                List<String> etikett = umbrechen(sicher(p[0], zeichen), NORMAL, ETIKETT - 6);
                int n = Math.max(werte.size(), etikett.size());
                platz(n * zeile);
                for (int i = 0; i < n; i++) {
                    y -= zeile;
                    if (i < etikett.size()) {
                        text(RAND, grundlinie(NORMAL), NORMAL, GRAU, etikett.get(i));
                    }
                    if (i < werte.size()) {
                        text(RAND + ETIKETT, grundlinie(NORMAL), NORMAL, SCHWARZ, werte.get(i));
                    }
                }
            }
        }

        /** Eine Tabelle: Kopfzeile (auf jeder neuen Seite wiederholt), je Zeile Zellen aus Teilen, jeder Teil umbrochen. */
        void tabelle(List<Spalte> spalten, List<List<List<String>>> zeilen) throws IOException {
            float rest = BREITE;
            for (Spalte sp : spalten) {
                rest -= sp.breite();
            }
            float[] breiten = new float[spalten.size()];
            for (int i = 0; i < breiten.length; i++) {
                breiten[i] = spalten.get(i).breite() == 0 ? rest : spalten.get(i).breite();
            }
            float zeile = NORMAL * ZEILE;
            platz(KLEIN * ZEILE + 2 * POLSTER + 2 * zeile + 2 * POLSTER);
            kopfzeile(spalten, breiten);
            for (List<List<String>> z : zeilen) {
                List<List<String>> zellen = new ArrayList<>();
                int n = 1;
                for (int i = 0; i < breiten.length; i++) {
                    List<String> l = new ArrayList<>();
                    for (String teil : z.get(i)) {
                        l.addAll(umbrechen(sicher(teil, zeichen), NORMAL, breiten[i] - 2 * POLSTER));
                    }
                    zellen.add(l);
                    n = Math.max(n, l.size());
                }
                float hoehe = n * zeile + 2 * POLSTER;
                if (platz(hoehe)) {
                    kopfzeile(spalten, breiten);
                }
                float x = RAND;
                for (int i = 0; i < breiten.length; i++) {
                    float oben = y - POLSTER;
                    for (String t : zellen.get(i)) {
                        oben -= zeile;
                        float tx = spalten.get(i).rechts() ? x + breiten[i] - POLSTER - breite(t, NORMAL) : x + POLSTER;
                        text(tx, oben + NORMAL * (ZEILE - 1) / 2 + NORMAL * 0.22f, NORMAL, SCHWARZ, t);
                    }
                    x += breiten[i];
                }
                y -= hoehe;
                linie(y, LINIE, 0.4f);
            }
        }

        private void kopfzeile(List<Spalte> spalten, float[] breiten) throws IOException {
            float hoehe = KLEIN * ZEILE + 2 * POLSTER;
            float x = RAND;
            for (int i = 0; i < breiten.length; i++) {
                String t = sicher(spalten.get(i).titel(), zeichen);
                float tx = spalten.get(i).rechts() ? x + breiten[i] - POLSTER - breite(t, KLEIN) : x + POLSTER;
                text(tx, y - POLSTER - KLEIN * ZEILE + KLEIN * 0.3f, KLEIN, GRAU, t);
                x += breiten[i];
            }
            y -= hoehe;
            linie(y, GRAU, 0.6f);
        }

        /** Nach dem Inhalt: auf jeder Seite Linie, Fußzeilen und „Seite i von n“. */
        void fuesse(List<String> zeilen) throws IOException {
            cs.close();
            int n = seiten.size();
            for (int i = 0; i < n; i++) {
                try (PDPageContentStream fuss = new PDPageContentStream(doc, seiten.get(i),
                        PDPageContentStream.AppendMode.APPEND, true, true)) {
                    cs = fuss;
                    String seite = "Seite " + (i + 1) + " von " + n;
                    float links = BREITE - breite(seite, KLEIN) - 12;
                    List<String> umbrochen = new ArrayList<>();
                    for (String z : zeilen) {
                        umbrochen.addAll(umbrechen(sicher(z, zeichen), KLEIN, links));
                    }
                    float yy = UNTEN - 12;
                    linie(yy, LINIE, 0.4f);
                    for (int j = 0; j < umbrochen.size(); j++) {
                        yy -= KLEIN * ZEILE;
                        text(RAND, yy, KLEIN, GRAU, umbrochen.get(j));
                        if (j == umbrochen.size() - 1) {
                            text(RAND + BREITE - breite(seite, KLEIN), yy, KLEIN, GRAU, seite);
                        }
                    }
                }
            }
            cs = null;
        }

        /**
         * Hinter dem Inhalt, schräg über die Seite: „ersetzt durch Nr. n (Datum)“. Gedrehter Text kommt bei einer Text-Extraktion
         * nicht als Zeile heraus — darum steht derselbe Satz zusätzlich oben rechts auf jeder Seite.
         */
        private void wasserzeichen() throws IOException {
            float groesse = 44f;
            float w = breite(wasserzeichen, groesse);
            float hoechstens = FORMAT.getWidth() * 0.95f;
            if (w > hoechstens) {
                groesse = groesse * hoechstens / w;
                w = hoechstens;
            }
            double winkel = Math.toRadians(40);
            float x = (float) (FORMAT.getWidth() / 2 - w / 2 * Math.cos(winkel) + groesse / 3 * Math.sin(winkel));
            float yy = (float) (FORMAT.getHeight() / 2 - w / 2 * Math.sin(winkel) - groesse / 3 * Math.cos(winkel));
            cs.beginText();
            cs.setFont(schrift, groesse);
            cs.setNonStrokingColor(WASSERZEICHEN);
            cs.setTextMatrix(Matrix.getRotateInstance(winkel, x, yy));
            cs.showText(wasserzeichen);
            cs.endText();
        }

        private float grundlinie(float groesse) {
            return y + groesse * (ZEILE - 1) / 2 + groesse * 0.22f;
        }

        private void text(float x, float grundlinie, float groesse, float grau, String t) throws IOException {
            if (t.isEmpty()) {
                return;
            }
            cs.beginText();
            cs.setFont(schrift, groesse);
            cs.setNonStrokingColor(grau);
            cs.newLineAtOffset(x, grundlinie);
            cs.showText(t);
            cs.endText();
        }

        private void linie(float yy, float grau, float dicke) throws IOException {
            cs.setStrokingColor(grau);
            cs.setLineWidth(dicke);
            cs.moveTo(RAND, yy);
            cs.lineTo(RAND + BREITE, yy);
            cs.stroke();
        }

        private float breite(String t, float groesse) throws IOException {
            return schrift.getStringWidth(t) / 1000f * groesse;
        }

        /** Wortweise umbrechen; ein Wort, das allein zu breit ist, zeichenweise. */
        private List<String> umbrechen(String t, float groesse, float hoechstens) throws IOException {
            List<String> raus = new ArrayList<>();
            StringBuilder zeile = new StringBuilder();
            for (String wort : t.split(" ")) {
                String versuch = zeile.isEmpty() ? wort : zeile + " " + wort;
                if (breite(versuch, groesse) <= hoechstens) {
                    zeile.setLength(0);
                    zeile.append(versuch);
                    continue;
                }
                if (!zeile.isEmpty()) {
                    raus.add(zeile.toString());
                    zeile.setLength(0);
                }
                String rest = wort;
                while (breite(rest, groesse) > hoechstens && rest.length() > 1) {
                    int k = rest.length() - 1;
                    while (k > 1 && breite(rest.substring(0, k), groesse) > hoechstens) {
                        k--;
                    }
                    raus.add(rest.substring(0, k));
                    rest = rest.substring(k);
                }
                zeile.append(rest);
            }
            if (!zeile.isEmpty() || raus.isEmpty()) {
                raus.add(zeile.toString());
            }
            return raus;
        }

        /** Steuerzeichen werden Leerzeichen, ein Zeichen ohne Glyphe „?“ — das PDF scheitert nie an einem Namen. */
        private static String sicher(String t, CmapLookup zeichen) {
            StringBuilder raus = new StringBuilder();
            t.codePoints().forEach(cp -> {
                if (Character.isISOControl(cp) || cp == ' ' || cp == ' ') {
                    raus.append(' ');
                } else if (cp == ' ' || zeichen.getGlyphId(cp) != 0) {
                    raus.appendCodePoint(cp);
                } else {
                    raus.append(ERSATZZEICHEN);
                }
            });
            return raus.toString();
        }
    }
}
