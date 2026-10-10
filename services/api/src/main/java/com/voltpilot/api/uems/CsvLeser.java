package com.voltpilot.api.uems;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/**
 * Der CSV-LESER der Bezugsdaten als reines Modul (UEMS AP-09 §4.6 C1, IP-11).
 *
 * <p><b>Die Datei kommt von draußen.</b> Ein Kunde lädt hoch, was er irgendwo bekommen hat: falsch
 * kodiert, leer, 0 Byte, zu groß, mit gemischten Trennzeichen, mit kaputten Anführungszeichen —
 * oder mit einer Zelle, die eine Tabellenkalkulation als Formel ausführen würde. Jeder dieser Fälle
 * endet in einem {@link Ergebnis} mit einem benannten Befund aus dem Vertrag (C8) und einem
 * Zusatz, der sagt, woran es lag. Das Modul wirft für keine Datei.
 *
 * <p>Der Vertrag steht in {@code docs/contracts/v2/bezugsdaten-vectors.json}: Block {@code csv}
 * (Grenzen, Kodierungen, Trennzeichen, Reihenfolge, Neutralisierung, Zusätze, Erkennungs-Fälle)
 * und die Regel {@code csv} an den Fällen B1, B12 und B13. Einen TS-Zwilling gibt es nicht — das
 * Portal liest keine Datei, es zeigt die Erkennung ({@code zwillinge_grund.csv}).
 *
 * <p><b>Die Reihenfolge ist ergebnisrelevant</b> — die erste Stufe, die nicht passt, spricht:
 * Größe → leer → Kodierung → Trennzeichen → Anführungszeichen → Leerzeilen → Kopfzeile →
 * Datenzeilen. Was vor der Ablehnung feststand, steht im Ergebnis; alles danach ist {@code null}.
 *
 * <p><b>Gelesen wird, nicht gedeutet:</b> jedes Feld bleibt der Text, der in der Datei steht —
 * keine Zahl, kein Datum, kein Trimmen. Was ein Feld bedeutet, sagt erst die Zuordnung (C3,
 * IP-12). {@link #anzeige(String)} neutralisiert führende Formelzeichen NUR für die Anzeige; der
 * gelesene Wert bleibt, was in der Datei stand.
 *
 * <p><b>Rein:</b> ohne Spring, ohne Datenbank, ohne Netz und ohne Uhr. Der Fingerabdruck (C2),
 * die Vorschau und die Tabellen sind IP-12.
 */
public final class CsvLeser {

    private CsvLeser() {}

    // ------------------------------------------------------------------ Befunde (C8)

    /** C1: mehr als {@link #BYTES_HOECHSTENS} Bytes oder mehr als {@link #DATENZEILEN_HOECHSTENS} Datenzeilen. */
    public static final String DATEI_ZU_GROSS = "datei_zu_gross";

    /** C1: keine Textdatei in UTF-8 oder Windows-1252 — oder nicht nach RFC 4180 zerlegbar. */
    public static final String KODIERUNG_UNLESBAR = "kodierung_unlesbar";

    /** C4/§7 B12: 0 Byte, nur Leerzeilen oder nur die Kopfzeile. */
    public static final String KEINE_DATENZEILEN = "keine_datenzeilen";

    /**
     * Die Kundensätze der Befunde dieses Moduls — hier, nicht in der Fläche. {@code CsvLeserTest}
     * prüft sie Wort für Wort gegen {@code befund_saetze} der Vektor-Datei.
     */
    public static final Map<String, String> SAETZE = Map.of(
            DATEI_ZU_GROSS, "Die Datei ist zu groß.",
            KODIERUNG_UNLESBAR, "Die Datei lässt sich nicht lesen.",
            KEINE_DATENZEILEN, "Die Datei enthält keine Datenzeilen.");

    // ------------------------------------------------------------------ Zusätze

    public static final String ZU_VIELE_BYTES = "zu_viele_bytes";
    public static final String ZU_VIELE_DATENZEILEN = "zu_viele_datenzeilen";
    public static final String LEER_0_BYTE = "leer_0_byte";
    public static final String KODIERUNG_NICHT_ERLAUBT = "kodierung_nicht_erlaubt";
    public static final String KODIERUNG_NICHT_WIE_VORGABE = "kodierung_nicht_wie_vorgabe";
    public static final String ANFUEHRUNGSZEICHEN_OFFEN = "anfuehrungszeichen_offen";
    public static final String NUR_LEERZEILEN = "nur_leerzeilen";
    public static final String NUR_KOPFZEILE = "nur_kopfzeile";

    /**
     * Der Zusatz sagt, WORAN ein Befund lag — der Befund selbst bleibt das geschlossene Wort aus
     * C8. Vorbild ist §7 B12 („Die Datei ist leer (0 Byte).“). Geprüft gegen {@code csv.zusaetze}.
     */
    public static final Map<String, String> ZUSAETZE = Map.of(
            ZU_VIELE_BYTES, "Erlaubt sind höchstens 5 MB.",
            ZU_VIELE_DATENZEILEN, "Erlaubt sind höchstens 100 000 Datenzeilen.",
            LEER_0_BYTE, "Die Datei ist leer (0 Byte).",
            KODIERUNG_NICHT_ERLAUBT,
                    "Erlaubt sind Textdateien in UTF-8 oder Windows-1252 — keine Excel-Mappe und kein „Unicode-Text“.",
            KODIERUNG_NICHT_WIE_VORGABE, "Die Datei ist nicht in der Kodierung gespeichert, die die Vorlage festhält.",
            ANFUEHRUNGSZEICHEN_OFFEN, "Ein Feld in Anführungszeichen ist nicht richtig abgeschlossen.",
            NUR_LEERZEILEN, "Die Datei enthält keine Zeile mit Inhalt.",
            NUR_KOPFZEILE, "Die Datei enthält nur die Kopfzeile.");

    // ------------------------------------------------------------------ Grenzen und Vokabulare (C1)

    /**
     * 5 MB = 5 × 1 024 × 1 024 Bytes: keine Datei, die ein Betriebssystem mit „5 MB“ oder weniger
     * anzeigt, wird abgelehnt — und es ist dieselbe Zahl, die Spring unter {@code 5MB} versteht.
     */
    public static final int BYTES_HOECHSTENS = 5 * 1024 * 1024;

    /** Datenzeilen, ohne die Kopfzeile und ohne Leerzeilen. */
    public static final int DATENZEILEN_HOECHSTENS = 100_000;

    /** So viele Zeilen mit Inhalt stimmen über das Trennzeichen ab. */
    public static final int ERKENNUNG_ZEILEN = 20;

    public static final String UTF_8 = "utf-8";
    public static final String WINDOWS_1252 = "windows-1252";

    /** In der Reihenfolge, in der sie versucht werden. */
    public static final List<String> KODIERUNGEN = List.of(UTF_8, WINDOWS_1252);

    /** In der Reihenfolge, die einen Gleichstand entscheidet. */
    public static final List<String> TRENNZEICHEN = List.of(";", ",", "\t");

    /**
     * Die führenden Zeichen, die {@link #anzeige(String)} neutralisiert: der Spiegel des Exports
     * ({@code MeasurementHistoryService.csv}) — C1 nennt {@code = + - @}, der Export schützt
     * zusätzlich vor Tab und Wagenrücklauf.
     */
    public static final String NEUTRALISIEREN = "=+-@\t\r";

    public static final String NEUTRALISIEREN_PRAEFIX = "'";

    /** Die Stufen, in der Reihenfolge, in der sie prüfen. */
    public static final List<String> REIHENFOLGE = List.of(
            "groesse", "leer", "kodierung", "trennzeichen", "anfuehrungszeichen", "leerzeilen", "kopfzeile",
            "datenzeilen");

    private static final byte[] BOM = {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};

    /** Ein Feld, das nach Zahl oder Datum aussieht: nur Ziffern und Zahl-/Datumszeichen, mindestens eine Ziffer. */
    private static final Pattern ZAHLARTIG = Pattern.compile("[0-9+\\-.,:/' ]*[0-9][0-9+\\-.,:/' ]*");

    // ------------------------------------------------------------------ Ein- und Ausgang

    /**
     * Was eine Vorlage festhält (C1 „in der Vorlage festgehalten“, C9); {@code null} heißt
     * „erkennen“. Die Werte kommen aus dem Vokabular — ein fremdes Wort ist ein Programmierfehler
     * des Aufrufers, keine Eigenschaft der Datei, und wird deshalb beim Anlegen abgewiesen.
     */
    public record Vorgabe(String kodierung, String trennzeichen, Boolean kopfzeile) {

        public static final Vorgabe ERKENNEN = new Vorgabe(null, null, null);

        public Vorgabe {
            if (kodierung != null && !KODIERUNGEN.contains(kodierung)) {
                throw new IllegalArgumentException("Kodierung außerhalb des Vokabulars: " + kodierung);
            }
            if (trennzeichen != null && !TRENNZEICHEN.contains(trennzeichen)) {
                throw new IllegalArgumentException("Trennzeichen außerhalb des Vokabulars: " + trennzeichen);
            }
        }
    }

    /**
     * Eine Zeile mit Inhalt. {@code nr} ist die Zeile der Datei, in der sie beginnt (1-basiert,
     * Leerzeilen mitgezählt) — die Nummer, die ein Mensch im Editor findet. {@code text} ist der
     * Zeilentext ohne Zeilenende, {@code felder} sind die Felder nach RFC 4180, unverändert.
     */
    public record Zeile(int nr, String text, List<String> felder) {

        /** Die Felder so, wie sie angezeigt werden: jedes durch {@link #anzeige(String)}. */
        public List<String> anzeige() {
            return felder.stream().map(CsvLeser::anzeige).toList();
        }
    }

    /**
     * Das Ergebnis des Lesens. {@code befund} {@code null} heißt: gelesen. Sonst nennt
     * {@code zusatz} die Ursache und {@code zeile} die Stelle, wenn es eine gibt. Die Erkennungen
     * ({@code kodierung} … {@code datenzeilen}) stehen, soweit sie VOR dem Befund feststanden.
     */
    public record Ergebnis(
            String befund,
            String zusatz,
            Integer zeile,
            String kodierung,
            Boolean bom,
            String trennzeichen,
            Boolean kopfzeile,
            List<String> kopf,
            Integer spalten,
            Integer datenzeilen,
            List<Zeile> zeilen) {

        public boolean gelesen() {
            return befund == null;
        }
    }

    // ------------------------------------------------------------------ Lesen

    /** Liest eine Datei und erkennt alles selbst. */
    public static Ergebnis lies(byte[] datei) {
        return lies(datei, Vorgabe.ERKENNEN);
    }

    /** Liest eine Datei; was die Vorgabe festhält, wird nicht erkannt. {@code null} gilt als 0 Byte. */
    public static Ergebnis lies(byte[] datei, Vorgabe vorgabe) {
        byte[] bytes = datei == null ? new byte[0] : datei;
        Vorgabe v = vorgabe == null ? Vorgabe.ERKENNEN : vorgabe;

        // groesse
        if (bytes.length > BYTES_HOECHSTENS) {
            return abgelehnt(DATEI_ZU_GROSS, ZU_VIELE_BYTES, null, null, null, null);
        }
        // leer
        if (bytes.length == 0) {
            return abgelehnt(KEINE_DATENZEILEN, LEER_0_BYTE, null, null, null, null);
        }
        // kodierung
        boolean bom = beginntMitBom(bytes);
        String kodierung;
        String text;
        if (bom) {
            kodierung = UTF_8;
            text = dekodiere(bytes, BOM.length, StandardCharsets.UTF_8);
        } else if (v.kodierung() != null) {
            kodierung = v.kodierung();
            text = dekodiere(bytes, 0, zeichensatz(kodierung));
        } else {
            kodierung = UTF_8;
            text = dekodiere(bytes, 0, StandardCharsets.UTF_8);
            if (text == null) {
                kodierung = WINDOWS_1252;
                text = dekodiere(bytes, 0, zeichensatz(WINDOWS_1252));
            }
        }
        if (text == null) {
            String zusatz = !bom && v.kodierung() != null ? KODIERUNG_NICHT_WIE_VORGABE : KODIERUNG_NICHT_ERLAUBT;
            return abgelehnt(KODIERUNG_UNLESBAR, zusatz, null, null, null, null);
        }
        if (hatSteuerzeichen(text)) {
            return abgelehnt(KODIERUNG_UNLESBAR, KODIERUNG_NICHT_ERLAUBT, null, null, null, null);
        }
        // trennzeichen
        String trennzeichen = v.trennzeichen() != null ? v.trennzeichen() : erkenneTrennzeichen(text);
        // anfuehrungszeichen
        Zerlegung z = zerlege(text, trennzeichen.charAt(0), DATENZEILEN_HOECHSTENS + 2);
        if (z.fehlerZeile() != null) {
            return abgelehnt(KODIERUNG_UNLESBAR, ANFUEHRUNGSZEICHEN_OFFEN, z.fehlerZeile(), kodierung, bom, trennzeichen);
        }
        // leerzeilen
        if (z.zeilen().isEmpty()) {
            return abgelehnt(KEINE_DATENZEILEN, NUR_LEERZEILEN, null, kodierung, bom, trennzeichen);
        }
        // kopfzeile
        boolean kopfzeile = v.kopfzeile() != null ? v.kopfzeile() : erkenneKopfzeile(z.zeilen());
        List<String> kopf = kopfzeile ? z.zeilen().get(0).felder() : null;
        int spalten = z.zeilen().get(0).felder().size();
        List<Zeile> daten = kopfzeile ? z.zeilen().subList(1, z.zeilen().size()) : z.zeilen();
        // datenzeilen
        if (daten.size() > DATENZEILEN_HOECHSTENS) {
            return new Ergebnis(DATEI_ZU_GROSS, ZU_VIELE_DATENZEILEN, null, kodierung, bom, trennzeichen, kopfzeile,
                    kopf, spalten, null, List.of());
        }
        if (daten.isEmpty()) {
            return new Ergebnis(KEINE_DATENZEILEN, NUR_KOPFZEILE, null, kodierung, bom, trennzeichen, kopfzeile, kopf,
                    spalten, 0, List.of());
        }
        return new Ergebnis(null, null, null, kodierung, bom, trennzeichen, kopfzeile, kopf, spalten, daten.size(),
                Collections.unmodifiableList(new ArrayList<>(daten)));
    }

    /**
     * Die Anzeige eines Felds (C1, Spiegel des Exports): beginnt es mit {@code = + - @}, Tab oder
     * Wagenrücklauf, steht ein {@code '} davor — so wird aus {@code =1+1} oder {@code +49 …} in
     * einer Tabellenkalkulation nichts anderes als das, was dort steht. Der gelesene Wert bleibt
     * unverändert; neutralisiert wird NUR, was angezeigt wird.
     */
    public static String anzeige(String feld) {
        if (feld == null || feld.isEmpty() || NEUTRALISIEREN.indexOf(feld.charAt(0)) < 0) {
            return feld;
        }
        return NEUTRALISIEREN_PRAEFIX + feld;
    }

    /** Der Kundensatz eines Befunds dieses Moduls — die Fläche erfindet keinen zweiten. */
    public static String satz(String befund) {
        return Objects.requireNonNull(SAETZE.get(befund), "kein Kundensatz für " + befund);
    }

    /** Der Satz eines Zusatzes. */
    public static String zusatz(String zusatz) {
        return Objects.requireNonNull(ZUSAETZE.get(zusatz), "kein Satz für den Zusatz " + zusatz);
    }

    // ------------------------------------------------------------------ Stufen

    private static Ergebnis abgelehnt(
            String befund, String zusatz, Integer zeile, String kodierung, Boolean bom, String trennzeichen) {
        return new Ergebnis(befund, zusatz, zeile, kodierung, bom, trennzeichen, null, null, null, null, List.of());
    }

    private static boolean beginntMitBom(byte[] b) {
        return b.length >= BOM.length && b[0] == BOM[0] && b[1] == BOM[1] && b[2] == BOM[2];
    }

    private static Charset zeichensatz(String kodierung) {
        return UTF_8.equals(kodierung) ? StandardCharsets.UTF_8 : Charset.forName("windows-1252");
    }

    /** Streng: ein ungültiges oder in der Kodierung nicht belegtes Byte ergibt {@code null}, nie ein Ersatzzeichen. */
    private static String dekodiere(byte[] b, int ab, Charset zeichensatz) {
        try {
            return zeichensatz.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(b, ab, b.length - ab))
                    .toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }

    /**
     * Steuerzeichen außer Tab, Zeilenvorschub und Wagenrücklauf kommen in keiner Textdatei vor —
     * wohl aber in einer Excel-Mappe (ZIP) und in „Unicode-Text“ (UTF-16, jedes zweite Byte 0),
     * die beide sonst als gültiges UTF-8 oder Windows-1252 durchgingen.
     */
    private static boolean hatSteuerzeichen(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if ((c < 0x20 && c != '\t' && c != '\n' && c != '\r') || (c >= 0x7F && c <= 0x9F)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Mehrheit der ersten {@link #ERKENNUNG_ZEILEN} Zeilen mit Inhalt: jede Zeile stimmt für das
     * Trennzeichen, das sie in die meisten Felder (mindestens zwei) zerlegt — Anführungszeichen
     * nach RFC 4180 beachtet. Gleichstand in einer Zeile und in der Summe entscheidet die
     * Reihenfolge {@link #TRENNZEICHEN}; stimmt keine Zeile ab (eine Spalte), gilt das erste.
     */
    private static String erkenneTrennzeichen(String text) {
        List<List<Zeile>> je = new ArrayList<>();
        for (String t : TRENNZEICHEN) {
            je.add(zerlege(text, t.charAt(0), ERKENNUNG_ZEILEN).zeilen());
        }
        int[] stimmen = new int[TRENNZEICHEN.size()];
        for (int k = 0; k < ERKENNUNG_ZEILEN; k++) {
            int beste = -1;
            int felder = 1;
            for (int t = 0; t < TRENNZEICHEN.size(); t++) {
                if (je.get(t).size() > k && je.get(t).get(k).felder().size() > felder) {
                    felder = je.get(t).get(k).felder().size();
                    beste = t;
                }
            }
            if (beste >= 0) {
                stimmen[beste]++;
            }
        }
        int sieger = 0;
        for (int t = 1; t < stimmen.length; t++) {
            if (stimmen[t] > stimmen[sieger]) {
                sieger = t;
            }
        }
        return TRENNZEICHEN.get(sieger);
    }

    /**
     * Die erste Zeile mit Inhalt ist die Kopfzeile, wenn keines ihrer Felder nach Zahl oder Datum
     * aussieht UND die zweite fehlt oder mindestens ein solches Feld hat. Eine Datei nur aus Text
     * hat keine erkannte Kopfzeile; die Vorlage kann es anders festhalten.
     */
    private static boolean erkenneKopfzeile(List<Zeile> zeilen) {
        if (zeilen.get(0).felder().stream().anyMatch(CsvLeser::zahlartig)) {
            return false;
        }
        return zeilen.size() == 1 || zeilen.get(1).felder().stream().anyMatch(CsvLeser::zahlartig);
    }

    private static boolean zahlartig(String feld) {
        return ZAHLARTIG.matcher(feld.strip()).matches();
    }

    private record Zerlegung(List<Zeile> zeilen, Integer fehlerZeile) {}

    /**
     * RFC 4180: ein Feld, das mit {@code "} beginnt, endet am nächsten einzelnen {@code "}; darin
     * sind Trennzeichen und Zeilenenden Text und {@code ""} ist ein {@code "}. Nach dem schließenden
     * {@code "} muss ein Trennzeichen, ein Zeilenende oder das Dateiende stehen, sonst ist die
     * Zeile nicht zerlegbar. Ein {@code "} mitten in einem Feld ohne Anführungszeichen ist ein
     * Zeichen ({@code 12" Rohr}). Zeilenenden: {@code \n}, {@code \r\n} — und {@code \r} allein,
     * damit eine Datei im alten Mac-Format nicht zu einer einzigen Zeile wird. Eine Zeile ohne ein
     * nicht-leeres Feld ist eine Leerzeile und wird übersprungen. Liest höchstens {@code hoechstens}
     * Zeilen mit Inhalt.
     */
    private static Zerlegung zerlege(String s, char trenner, int hoechstens) {
        List<Zeile> zeilen = new ArrayList<>();
        int n = s.length();
        int i = 0;
        int zeile = 1;
        StringBuilder feld = new StringBuilder();
        while (i < n && zeilen.size() < hoechstens) {
            int start = i;
            int beginn = zeile;
            int ende;
            List<String> felder = new ArrayList<>();
            while (true) {
                if (i < n && s.charAt(i) == '"') {
                    i++;
                    boolean zu = false;
                    while (i < n) {
                        char c = s.charAt(i);
                        if (c == '"') {
                            if (i + 1 < n && s.charAt(i + 1) == '"') {
                                feld.append('"');
                                i += 2;
                                continue;
                            }
                            i++;
                            zu = true;
                            break;
                        }
                        if (c == '\n' || (c == '\r' && (i + 1 >= n || s.charAt(i + 1) != '\n'))) {
                            zeile++;
                        }
                        feld.append(c);
                        i++;
                    }
                    if (!zu || (i < n && s.charAt(i) != trenner && s.charAt(i) != '\n' && s.charAt(i) != '\r')) {
                        return new Zerlegung(zeilen, beginn);
                    }
                } else {
                    while (i < n) {
                        char c = s.charAt(i);
                        if (c == trenner || c == '\n' || c == '\r') {
                            break;
                        }
                        feld.append(c);
                        i++;
                    }
                }
                felder.add(feld.isEmpty() ? "" : feld.toString());
                feld.setLength(0);
                if (i >= n) {
                    ende = n;
                    break;
                }
                char c = s.charAt(i);
                if (c == trenner) {
                    i++;
                    continue;
                }
                ende = i;
                i += c == '\r' && i + 1 < n && s.charAt(i + 1) == '\n' ? 2 : 1;
                zeile++;
                break;
            }
            if (felder.stream().anyMatch(f -> !f.isBlank())) {
                zeilen.add(new Zeile(beginn, s.substring(start, ende), Collections.unmodifiableList(felder)));
            }
        }
        return new Zerlegung(zeilen, null);
    }
}
