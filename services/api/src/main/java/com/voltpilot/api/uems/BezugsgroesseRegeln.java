package com.voltpilot.api.uems;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Das VERWALTEN einer Bezugsgröße als reines Modul (UEMS AP-09 §4.2 M1–M6, IP-5): anlegen,
 * ändern, archivieren, löschen — und der geschlossene Satz der Ablehnungen mit Status und
 * Kundensatz.
 *
 * <p>Der Vertrag steht in {@code docs/contracts/v2/bezugsdaten-vectors.json} (Block
 * {@code verwalten}, Regel {@code verwalten}); {@code BezugsdatenVectorsTest} fährt jede Prüfung
 * und hält {@link Ablehnung} Wort für Wort, Status für Status und Satz für Satz an
 * {@code verwalten.ablehnungen}. Den Satz spricht im Portal {@code frontend/portal/src/bezugsgroesse.ts}
 * (gegen dieselbe Datei geprüft). Wer eine Regel ändert, ändert die Vektor-Datei UND beide.
 *
 * <p><b>Was hier NICHT steht:</b> ob ein Geltungsbereich-Objekt existiert, welche Kennzeichen belegt
 * sind und wie viele Werte eine Bezugsgröße trägt — das liest der Schreibweg
 * ({@code BezugsgroesseService}) und gibt es als Eingang herein. Das Vokabular (Wertart,
 * Geltungsbereich-Art, Periodenart, Einheiten je Größe) kommt ebenfalls herein: im Test aus der
 * Vektor-Datei, im Betrieb aus {@code bezugsdaten_vokabular()}, der EINEN Stelle der Datenbank.
 *
 * <p><b>Rein:</b> ohne Spring, ohne Datenbank, ohne Netz und ohne Uhr.
 */
public final class BezugsgroesseRegeln {

    private BezugsgroesseRegeln() {}

    /** Der geschlossene Satz der Ablehnungen (Vertrag {@code verwalten.ablehnungen}). Eine Ablehnung schreibt nichts. */
    public enum Ablehnung {
        ANFRAGE_UNGUELTIG("anfrage_ungueltig", 400,
                "Die Anfrage ist unvollständig oder nennt ein Feld, das es hier nicht gibt."),
        WORT_UNBEKANNT("wort_unbekannt", 400,
                "Dieses Wort ist hier nicht vorgesehen — erlaubt sind die Wörter der Liste."),
        /** Dasselbe Wort und derselbe Satz wie der Befund aus {@link BezugsEinheit} (U2). */
        EINHEIT_UNBEKANNT(BezugsEinheit.EINHEIT_UNBEKANNT, 400, BezugsEinheit.satz(BezugsEinheit.EINHEIT_UNBEKANNT)),
        KENNZEICHEN_FORMAT("kennzeichen_format", 400,
                "Ein Kennzeichen hat 2 bis 16 Zeichen: Großbuchstaben, Ziffern, Punkt, Bindestrich oder Schrägstrich."),
        ZEITRAUM_UNGUELTIG("zeitraum_ungueltig", 400, "Der Zeitraum endet vor seinem Beginn."),
        PERIODE_PASST_NICHT_ZUR_WERTART("periode_passt_nicht_zur_wertart", 422,
                "Nur ein Periodenwert hat eine Periode (Tag, Woche, Monat oder Jahr); ein Stand und ein Stammdatum haben keine."),
        FLAECHE_AUS_STRUKTUR("flaeche_aus_struktur", 422, "Flächen pflegen Sie am Gebäude."),
        GELTUNG_NICHT_WAEHLBAR("geltung_nicht_waehlbar", 422,
                "Prozesse und Kostenstellen sind als Geltungsbereich noch nicht wählbar."),
        GELTUNG_UNBEKANNT("geltung_unbekannt", 422, "Den gewählten Geltungsbereich gibt es nicht."),
        BEDEUTUNG_FEST("bedeutung_fest", 422,
                "Nach dem ersten Wert bleiben Wertart, Einheit, Periode und Geltungsbereich fest. "
                        + "Legen Sie dafür eine neue Bezugsgröße an."),
        KENNZEICHEN_BELEGT("kennzeichen_belegt", 409, "Dieses Kennzeichen trägt oder trug schon eine andere Bezugsgröße."),
        ARCHIVIERT("archiviert", 409, "Diese Bezugsgröße ist archiviert und wird nicht mehr geändert."),
        HAT_WERTE("hat_werte", 409, "Eine Bezugsgröße mit Werten wird nicht gelöscht. Archivieren Sie sie stattdessen."),
        NICHT_GEFUNDEN("nicht_gefunden", 404, "Diese Bezugsgröße gibt es nicht.");

        private final String code;
        private final int status;
        private final String satz;

        Ablehnung(String code, int status, String satz) {
            this.code = code;
            this.status = status;
            this.satz = satz;
        }

        public String code() {
            return code;
        }

        public int status() {
            return status;
        }

        /** Der Kundensatz — die EINE Formulierung; die Fläche schreibt keinen zweiten. */
        public String satz() {
            return satz;
        }
    }

    /** M2: das Präfix der automatischen Kennzeichen ({@code verwalten.kennzeichen.praefix}). */
    public static final String KENNZEICHEN_PRAEFIX = "BZ-";

    /** M2: die Stellen der automatischen Nummer, mit führenden Nullen. */
    public static final int KENNZEICHEN_STELLEN = 4;

    /** M2 „analog AP-04“: 2–16 Zeichen aus A-Z, 0-9, „.“, „/“, „-“ — dasselbe Muster wie der CHECK der Tabelle. */
    public static final String KENNZEICHEN_MUSTER = "^[A-Z0-9./-]{2,16}$";

    /** M1: was nach dem ersten Wert fest bleibt ({@code verwalten.fest_nach_erstem_wert}). */
    public static final List<String> FEST_NACH_ERSTEM_WERT =
            List.of("wertart", "einheit", "periode_art", "geltung_art", "geltung_id");

    /** M1: was immer änderbar bleibt. */
    public static final List<String> IMMER_AENDERBAR = List.of("kennzeichen", "name");

    /** Die Lesarten von {@code GET …/{id}/werte?fassungen=}; die erste ist die Vorgabe. */
    public static final List<String> LESARTEN = List.of("wirksam", "alle");

    /**
     * E1 „wählbar, sobald gebaut“: die Geltungsbereich-Arten, für die es ein Objekt (und in der
     * Tabelle eine Verweis-Spalte) gibt. Seit AP-10 IP-7 ({@code V20260913160000}) sind es alle sieben
     * des Vokabulars — Prozess und Kostenstelle haben ihre Tabellen. Die Regel bleibt ein Eingang: eine
     * künftige Art ohne Objekt fehlt hier und antwortet {@code geltung_nicht_waehlbar}.
     */
    public static final List<String> GELTUNG_WAEHLBAR =
            List.of("unternehmen", "standort", "gebaeude", "bereich", "prozess", "kostenstelle", "messstelle");

    /** Wertart mit Periode (M1, CHECK {@code bezugsgroesse_periode_je_wertart_chk}). */
    static final String PERIODENWERT = "periodenwert";

    /** Die Größe der Bezugsfläche im Einheiten-Vokabular (M4). */
    static final String GROESSE_FLAECHE = "flaeche";

    private static final Pattern MUSTER = Pattern.compile(KENNZEICHEN_MUSTER);
    private static final Pattern AUTOMATISCH = Pattern.compile("^" + Pattern.quote(KENNZEICHEN_PRAEFIX) + "([0-9]+)$");

    /** Die Felder einer Bezugsgröße, wie die Schnittstelle sie liest. {@code kennzeichen} {@code null} = der Server vergibt. */
    public record Entwurf(
            String kennzeichen,
            String name,
            String wertart,
            String einheit,
            String periodeArt,
            String geltungArt,
            String geltungId) {}

    /** Das Vokabular des Vertrags, wie es hereingereicht wird. */
    public record Vokabular(
            List<String> wertarten,
            List<String> geltungArten,
            List<String> periodeArten,
            Map<String, List<String>> einheiten) {}

    /** Das Urteil: erlaubt ({@code ablehnung} {@code null}) oder die ERSTE nicht bestandene Prüfung mit ihren Fakten. */
    public record Urteil(Ablehnung ablehnung, Map<String, Object> fakten) {

        static final Urteil ERLAUBT = new Urteil(null, Map.of());

        public boolean erlaubt() {
            return ablehnung == null;
        }
    }

    // -------------------------------------------------------------------------- anlegen

    /**
     * Anlegen, in der Prüfreihenfolge {@code verwalten.pruefreihenfolge.anlegen}: Name →
     * Kennzeichen-Form → Wertart → Geltungsbereich-Art → Geltungsbereich-Objekt angegeben →
     * Einheit → Periodenart → Periode passt zur Wertart (M1) → Fläche (M4) → Geltungsbereich
     * wählbar (E1) → Kennzeichen belegt (M2).
     *
     * @param waehlbar die Geltungsbereich-Arten, deren Objekte gebaut sind
     * @param belegt jedes Kennzeichen, das eine Bezugsgröße des Kundenbereichs trägt oder je trug
     */
    public static Urteil anlegen(Entwurf e, Vokabular v, Collection<String> waehlbar, Collection<String> belegt) {
        Urteil form = form(e, v, false);
        if (!form.erlaubt()) {
            return form;
        }
        if (!waehlbar.contains(e.geltungArt())) {
            return abgelehnt(Ablehnung.GELTUNG_NICHT_WAEHLBAR, "feld", "geltung_art");
        }
        if (e.kennzeichen() != null && belegt.contains(e.kennzeichen())) {
            return abgelehnt(Ablehnung.KENNZEICHEN_BELEGT, "feld", "kennzeichen");
        }
        return Urteil.ERLAUBT;
    }

    // --------------------------------------------------------------------------- ändern

    /**
     * Ändern (die ganze Bezugsgröße wird geschickt), in der Prüfreihenfolge
     * {@code verwalten.pruefreihenfolge.aendern}: archiviert (M6) → dieselben Form-Prüfungen wie beim
     * Anlegen → nach dem ersten Wert bleibt die Bedeutung fest (M1) → ein NEU gewählter
     * Geltungsbereich muss wählbar sein (E1) → ein NEUES Kennzeichen darf keine andere tragen oder
     * getragen haben (M2). Das Kennzeichen ist beim Ändern Pflicht; die eigene Bezugsgröße darf zu
     * ihrem früheren zurück — {@code belegtVonAnderen} nennt darum nur die der anderen.
     */
    public static Urteil aendern(Entwurf bestand, Entwurf neu, boolean archiviert, long werte, Vokabular v,
            Collection<String> waehlbar, Collection<String> belegtVonAnderen) {
        if (archiviert) {
            return abgelehnt(Ablehnung.ARCHIVIERT);
        }
        Urteil form = form(neu, v, true);
        if (!form.erlaubt()) {
            return form;
        }
        List<String> geaendert = bedeutungGeaendert(bestand, neu);
        if (werte > 0 && !geaendert.isEmpty()) {
            return abgelehnt(Ablehnung.BEDEUTUNG_FEST, "felder", geaendert);
        }
        boolean geltungNeu = !Objects.equals(bestand.geltungArt(), neu.geltungArt())
                || !Objects.equals(bestand.geltungId(), neu.geltungId());
        if (geltungNeu && !waehlbar.contains(neu.geltungArt())) {
            return abgelehnt(Ablehnung.GELTUNG_NICHT_WAEHLBAR, "feld", "geltung_art");
        }
        if (!Objects.equals(bestand.kennzeichen(), neu.kennzeichen()) && belegtVonAnderen.contains(neu.kennzeichen())) {
            return abgelehnt(Ablehnung.KENNZEICHEN_BELEGT, "feld", "kennzeichen");
        }
        return Urteil.ERLAUBT;
    }

    /** M1: die Felder der Bedeutung, die sich zwischen Bestand und Entwurf unterscheiden — in der Reihenfolge des Vertrags. */
    public static List<String> bedeutungGeaendert(Entwurf bestand, Entwurf neu) {
        List<String> felder = new ArrayList<>();
        if (!Objects.equals(bestand.wertart(), neu.wertart())) {
            felder.add("wertart");
        }
        if (!Objects.equals(bestand.einheit(), neu.einheit())) {
            felder.add("einheit");
        }
        if (!Objects.equals(bestand.periodeArt(), neu.periodeArt())) {
            felder.add("periode_art");
        }
        if (!Objects.equals(bestand.geltungArt(), neu.geltungArt())) {
            felder.add("geltung_art");
        }
        if (!Objects.equals(bestand.geltungId(), neu.geltungId())) {
            felder.add("geltung_id");
        }
        return List.copyOf(felder);
    }

    // ---------------------------------------------------------------- archivieren, löschen

    /** M6: archivieren ist einmal; die Werte bleiben lesbar. */
    public static Urteil archivieren(boolean archiviert) {
        return archiviert ? abgelehnt(Ablehnung.ARCHIVIERT) : Urteil.ERLAUBT;
    }

    /**
     * M6: gelöscht wird nur eine Bezugsgröße ohne einen einzigen Wert — auch eine Rücknahme ist ein
     * Wert (eine Fassung, Invariante 1), und eine archivierte ohne Werte darf gehen.
     */
    public static Urteil loeschen(long werte) {
        return werte > 0 ? abgelehnt(Ablehnung.HAT_WERTE, "werte", werte) : Urteil.ERLAUBT;
    }

    // -------------------------------------------------------------------------- Kennzeichen

    /**
     * M2: das nächste automatische Kennzeichen — {@code BZ-} und die Nummer nach der HÖCHSTEN, die je
     * ein Kennzeichen der Form {@code BZ-<Ziffern>} getragen hat (heute, früher oder an einer
     * gelöschten Bezugsgröße), vierstellig mit führenden Nullen. {@code BZ-5} zählt wie
     * {@code BZ-0005}; so kann die Vergabe nie ein je belegtes Kennzeichen treffen.
     */
    public static String kennzeichenVorschlag(Collection<String> jeBelegt) {
        long hoechste = 0;
        for (String k : jeBelegt) {
            Matcher m = AUTOMATISCH.matcher(k);
            if (m.matches() && m.group(1).length() <= 18) {
                hoechste = Math.max(hoechste, Long.parseLong(m.group(1)));
            }
        }
        return KENNZEICHEN_PRAEFIX + String.format("%0" + KENNZEICHEN_STELLEN + "d", hoechste + 1);
    }

    /** M2: hat das Kennzeichen die Form des Vertrags? Nichts wird umgewandelt. */
    public static boolean kennzeichenFormOk(String kennzeichen) {
        return kennzeichen != null && MUSTER.matcher(kennzeichen).matches();
    }

    // ---------------------------------------------------------------------------- Gerüst

    /** Die Prüfungen, die Anlegen und Ändern teilen — bis vor „wählbar“ und „belegt“. */
    private static Urteil form(Entwurf e, Vokabular v, boolean kennzeichenPflicht) {
        if (e.name() == null || e.name().isBlank()) {
            return abgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, "feld", "name");
        }
        if (kennzeichenPflicht && e.kennzeichen() == null) {
            return abgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, "feld", "kennzeichen");
        }
        if (e.kennzeichen() != null && !kennzeichenFormOk(e.kennzeichen())) {
            return abgelehnt(Ablehnung.KENNZEICHEN_FORMAT, "feld", "kennzeichen");
        }
        if (e.wertart() == null) {
            return abgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, "feld", "wertart");
        }
        if (!v.wertarten().contains(e.wertart())) {
            return wortUnbekannt("wertart", v.wertarten());
        }
        if (e.geltungArt() == null) {
            return abgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, "feld", "geltung_art");
        }
        if (!v.geltungArten().contains(e.geltungArt())) {
            return wortUnbekannt("geltung_art", v.geltungArten());
        }
        if (e.geltungId() == null || e.geltungId().isBlank()) {
            return abgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, "feld", "geltung_id");
        }
        if (e.einheit() == null) {
            return abgelehnt(Ablehnung.ANFRAGE_UNGUELTIG, "feld", "einheit");
        }
        String groesse = BezugsEinheit.groesseVon(e.einheit(), v.einheiten());
        if (groesse == null) {
            return abgelehnt(Ablehnung.EINHEIT_UNBEKANNT, "feld", "einheit");
        }
        if (e.periodeArt() != null && !v.periodeArten().contains(e.periodeArt())) {
            return wortUnbekannt("periode_art", v.periodeArten());
        }
        if (PERIODENWERT.equals(e.wertart()) != (e.periodeArt() != null)) {
            return abgelehnt(Ablehnung.PERIODE_PASST_NICHT_ZUR_WERTART, "feld", "periode_art");
        }
        if (GROESSE_FLAECHE.equals(groesse)) {
            return abgelehnt(Ablehnung.FLAECHE_AUS_STRUKTUR, "feld", "einheit");
        }
        return Urteil.ERLAUBT;
    }

    private static Urteil wortUnbekannt(String feld, List<String> erlaubt) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("feld", feld);
        fakten.put("erlaubt", List.copyOf(erlaubt));
        return new Urteil(Ablehnung.WORT_UNBEKANNT, fakten);
    }

    private static Urteil abgelehnt(Ablehnung a) {
        return new Urteil(a, Map.of());
    }

    private static Urteil abgelehnt(Ablehnung a, String fakt, Object wert) {
        return new Urteil(a, Map.of(fakt, wert));
    }
}
