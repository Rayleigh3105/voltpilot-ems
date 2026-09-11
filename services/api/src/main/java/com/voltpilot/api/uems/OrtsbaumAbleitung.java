package com.voltpilot.api.uems;

import java.time.Duration;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Collections;
import java.util.EnumMap;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * Die REINE Ableitung des ORTSBAUMS des Unternehmens-Energiemanagements (UEMS
 * AP-02 §4.3–§4.5, Entscheide E1, E2, E3, E9, E11, E12): zeitgültige
 * Zuordnungen von Gebäuden, Bereichen, Anlagen und Messstellen, „Stand am“,
 * Überlappung, Rückwirkung, der abgeleitete Standort einer Messstelle,
 * Archivieren/Wiederherstellen/Löschen, Fläche und die tagesgenaue Teilung
 * eines Zeitraums.
 *
 * <p>Ohne Spring, ohne Repository, ohne Uhr: Stichtag und „heute“ sind immer
 * Parameter (das {@link ZustandAbleitung}-Muster). Der Zwilling im Portal ist
 * {@code frontend/portal/src/uemsOrtsbaum.ts}; beide fahren dieselben Vektoren
 * ({@code docs/contracts/v2/ortsbaum-vectors.json}). <b>Wer die Regel ändert,
 * ändert beide Seiten und die Vektor-Datei.</b> Die Migrationen IP-2a/IP-2b
 * spiegeln dieselben Regeln als Datenbank-Constraints.
 *
 * <h2>Wer anruft</h2>
 *
 * Das Standort-Lesemodell (IP-3, {@link StandortLesemodell}) für „Stand am“ und
 * die Schreibrouten des Standorts (IP-4, {@link StandortService}) für die
 * Namensregel, das Archivieren mit seinen Sperrgründen und das Wiederherstellen.
 * Die Tabellen IP-2a/IP-2b halten dieselben Regeln als Constraints.
 *
 * <h2>Die Mechanik in einem Satz (§4.3)</h2>
 *
 * „gültig ab“ ist ein TAG, wirksam 00:00 Uhr in der Zeitzone des Standorts
 * (E9); je Objekt und Zuordnungsart genau ein Intervall je Tag; ein neues
 * „gültig ab“ beendet das laufende Intervall am VORTAG (das neue erbt dessen
 * Ende); Rückwirkung ist erlaubt und immer sichtbar (E2); Zukunft ist
 * „geplant“; vor dem Beginn des ersten Intervalls wird abgelehnt; eine
 * Korrektur ersetzt ein Intervall ab seinem Beginn und lässt das alte als
 * „aufgehoben“ lesbar.
 *
 * <p><b>⚠ {@code bis} ist der LETZTE gültige Tag, einschließlich</b> („Werk
 * Ahrenberg bis 28.02.2027“). §4.5 Regel 2 schreibt „[gültig ab, gültig bis)“ —
 * halboffen sind nur die Zeitpunkte: [ab 00:00, bis+1 00:00). Für die Datenbank
 * heißt das {@code daterange(ab, bis, '[]')}.
 */
public final class OrtsbaumAbleitung {

    public static final ZoneId VORGABE_ZEITZONE = ZoneId.of("Europe/Berlin");

    /** Das Kennzeichen des Unternehmens: ein Ort für eine Messstelle, aber kein Standort. */
    public static final String UNTERNEHMEN = "U";

    private static final DateTimeFormatter DATUM = DateTimeFormatter.ofPattern("dd.MM.uuuu");
    private static final DateTimeFormatter ZEITPUNKT =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ssxxx");

    private OrtsbaumAbleitung() {}

    // ---------------------------------------------------------------- Vokabular
    // Jeder Code ist der Name in Kleinbuchstaben — genau das Wort der Vektor-Datei.

    public enum OrtArt {
        STANDORT, GEBAEUDE, BEREICH;

        public String code() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    public enum ObjektArt {
        GEBAEUDE, BEREICH, ANLAGE, MESSSTELLE;

        public String code() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    public enum ElternArt {
        UNTERNEHMEN, STANDORT, GEBAEUDE, BEREICH;

        public String code() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    /** Woran was hängen darf (Regel 1, AP-00 E4: Bereiche werden nicht verschachtelt). */
    public static final Map<ObjektArt, List<ElternArt>> ERLAUBTE_ELTERN;

    static {
        Map<ObjektArt, List<ElternArt>> m = new EnumMap<>(ObjektArt.class);
        m.put(ObjektArt.GEBAEUDE, List.of(ElternArt.STANDORT));
        m.put(ObjektArt.BEREICH, List.of(ElternArt.GEBAEUDE, ElternArt.STANDORT));
        m.put(ObjektArt.ANLAGE, List.of(ElternArt.STANDORT));
        m.put(
                ObjektArt.MESSSTELLE,
                List.of(ElternArt.UNTERNEHMEN, ElternArt.STANDORT, ElternArt.GEBAEUDE, ElternArt.BEREICH));
        ERLAUBTE_ELTERN = Collections.unmodifiableMap(m);
    }

    /** AP-00 E8. Nur {@code AKTIV} sperrt das Archivieren (E12). */
    public enum ObjektZustand {
        ENTWURF, EINGERICHTET, AKTIV, ANGEHALTEN, ARCHIVIERT
    }

    /** §4.2: gültig (heute im Intervall) · geplant · beendet · aufgehoben. */
    public enum ZuordnungZustand {
        GUELTIG, GEPLANT, BEENDET, AUFGEHOBEN
    }

    /** Ob ein Ort an einem Tag im Baum ist — und wenn nicht, warum (in der Reihenfolge seines Lebens). */
    public enum Bestand {
        VORHANDEN, GAB_ES_NOCH_NICHT, ARCHIVIERT
    }

    public enum FlaecheQuelle {
        EIGEN, AUS_GEBAEUDEN_SUMMIERT
    }

    public enum ListenGrund {
        BIS_VOR_AB, UEBERLAPPUNG
    }

    /** Die Reihenfolge IST die Regel: sie entscheidet, welcher Grund gilt, wenn mehrere zutreffen. */
    public enum EintragGrund {
        ZIEL_ART_UNZULAESSIG,
        VOR_DEM_ERSTEN_INTERVALL,
        OBJEKT_ARCHIVIERT,
        GLEICHER_TAG,
        KEIN_BEGINN_AN_DEM_TAG,
        ZIEL_IST_BISHERIGER_ELTERN,
        ZIEL_GAB_ES_NOCH_NICHT,
        ZIEL_ARCHIVIERT
    }

    /**
     * {@code VERSCHIEBEN} legt ein neues „gültig ab“ an; {@code KORREKTUR} ersetzt
     * ein Intervall ab seinem Beginn.
     */
    public enum Vorgang {
        VERSCHIEBEN, KORREKTUR
    }

    public enum Rueckwirkung {
        RUECKWIRKEND, AB_HEUTE, GEPLANT
    }

    public enum VerortungGrund {
        VERORTET, AM_UNTERNEHMEN, NICHT_VERORTET, ORT_NICHT_IM_BAUM
    }

    /** Warum ein Teil eines Zeitraums keinen Standort hat. */
    public enum TeilGrund {
        GAB_ES_NOCH_NICHT, ARCHIVIERT, AM_UNTERNEHMEN, NICHT_VERORTET, ORT_NICHT_IM_BAUM
    }

    /** Die Reihenfolge der Sperren in der Grundliste und im Satz. */
    public enum ArchivGrundArt {
        GAB_ES_NOCH_NICHT, ARCHIVIERT, ANLAGE_AKTIV, MESSSTELLE_AKTIV, GEPLANTE_ZUORDNUNG
    }

    public enum WiederherstellGrund {
        NICHT_ARCHIVIERT, ELTERN_ARCHIVIERT, NAME_BELEGT
    }

    public enum LoeschGrund {
        HAT_MESSSTELLEN, HAT_ANLAGEN, HAT_FLAECHE, HAT_KINDER
    }

    // ------------------------------------------------------------------ Modell

    /** Eine Zuordnung: [ab, bis] in Tagen, {@code bis} einschließlich, {@code null} = offen. */
    public record Intervall(LocalDate ab, LocalDate bis, String eltern, boolean aufgehoben) {

        public Intervall(LocalDate ab, LocalDate bis, String eltern) {
            this(ab, bis, eltern, false);
        }

        boolean deckt(LocalDate tag) {
            return !ab.isAfter(tag) && (bis == null || !tag.isAfter(bis));
        }
    }

    public record FlaechenIntervall(LocalDate ab, LocalDate bis, int m2) {

        boolean deckt(LocalDate tag) {
            return !ab.isAfter(tag) && (bis == null || !tag.isAfter(bis));
        }
    }

    /**
     * Ein Knoten des Ortsbaums. Beim Standort sind die Intervalle sein Bestehen
     * (ohne Eltern); die Zeitzone steht nur am Standort — Gebäude und Bereiche
     * erben (Regel 11).
     */
    public record Ort(
            String kennzeichen,
            OrtArt art,
            String name,
            String zeitzone,
            List<Intervall> intervalle,
            List<FlaechenIntervall> flaechen) {

        public Ort {
            intervalle = intervalle == null ? List.of() : List.copyOf(intervalle);
            flaechen = flaechen == null ? List.of() : List.copyOf(flaechen);
        }
    }

    public record Anlage(
            String kennzeichen,
            String name,
            String netzanschluss,
            ObjektZustand zustand,
            List<Intervall> zuordnungen) {

        public Anlage {
            zuordnungen = zuordnungen == null ? List.of() : List.copyOf(zuordnungen);
        }
    }

    /** Eine Messstelle; ihre Anlage (AP-10) liest nur die Folgen-Karte. */
    public record Messstelle(
            String kennzeichen,
            String name,
            String anlage,
            ObjektZustand zustand,
            List<Intervall> zuordnungen) {

        public Messstelle {
            zuordnungen = zuordnungen == null ? List.of() : List.copyOf(zuordnungen);
        }
    }

    /** Der ganze Baum eines Unternehmens; {@code zeitzone} ist dessen Vorgabe. */
    public record Ortsbaum(
            ZoneId zeitzone, List<Ort> orte, List<Anlage> anlagen, List<Messstelle> messstellen) {

        public Ortsbaum {
            zeitzone = zeitzone == null ? VORGABE_ZEITZONE : zeitzone;
            orte = List.copyOf(orte);
            anlagen = List.copyOf(anlagen);
            messstellen = List.copyOf(messstellen);
        }

        Optional<Ort> ort(String kz) {
            return orte.stream().filter(o -> o.kennzeichen().equals(kz)).findFirst();
        }
    }

    // -------------------------------------------------------------- Intervalle

    private static List<Intervall> wirksam(List<Intervall> liste) {
        return liste.stream()
                .filter(i -> !i.aufgehoben())
                .sorted(Comparator.comparing(Intervall::ab))
                .toList();
    }

    private static Intervall intervallAm(List<Intervall> liste, LocalDate tag) {
        return wirksam(liste).stream().filter(i -> i.deckt(tag)).findFirst().orElse(null);
    }

    private static String elternAm(List<Intervall> liste, LocalDate tag) {
        Intervall i = intervallAm(liste, tag);
        return i == null ? null : i.eltern();
    }

    private static Bestand bestand(List<Intervall> liste, LocalDate tag) {
        List<Intervall> w = wirksam(liste);
        if (w.stream().anyMatch(i -> i.deckt(tag))) {
            return Bestand.VORHANDEN;
        }
        if (w.isEmpty() || tag.isBefore(w.get(0).ab())) {
            return Bestand.GAB_ES_NOCH_NICHT;
        }
        return Bestand.ARCHIVIERT;
    }

    /** Der erste Tag in [von, bis] (bis null = offen), den die Liste nicht deckt; null = lückenlos. */
    private static LocalDate ersterFehlenderTag(List<Intervall> liste, LocalDate von, LocalDate bis) {
        LocalDate tag = von;
        for (Intervall i : wirksam(liste)) {
            if (i.bis() != null && i.bis().isBefore(tag)) {
                continue;
            }
            if (i.ab().isAfter(tag)) {
                return tag;
            }
            if (i.bis() == null) {
                return null;
            }
            tag = i.bis().plusDays(1);
            if (bis != null && tag.isAfter(bis)) {
                return null;
            }
        }
        return tag;
    }

    public static ZuordnungZustand zuordnungZustand(Intervall i, LocalDate heute) {
        if (i.aufgehoben()) {
            return ZuordnungZustand.AUFGEHOBEN;
        }
        if (i.ab().isAfter(heute)) {
            return ZuordnungZustand.GEPLANT;
        }
        if (i.bis() != null && i.bis().isBefore(heute)) {
            return ZuordnungZustand.BEENDET;
        }
        return ZuordnungZustand.GUELTIG;
    }

    /** „01.03.2027“ */
    public static String datumText(LocalDate tag) {
        return DATUM.format(tag);
    }

    // -------------------------------------------------------------------- Baum

    private static boolean vorhanden(Ortsbaum baum, String kz, LocalDate tag) {
        if (UNTERNEHMEN.equals(kz)) {
            return true;
        }
        return baum.ort(kz).map(o -> intervallAm(o.intervalle(), tag) != null).orElse(false);
    }

    private static String elternName(Ortsbaum baum, String kz) {
        if (UNTERNEHMEN.equals(kz)) {
            return "Unternehmen";
        }
        return baum.ort(kz).map(Ort::name).orElse(kz);
    }

    private record Pfad(List<String> knoten, String standort) {}

    /** Von einem Ort hinauf bis zum Standort; bricht ab, wo ein Knoten an dem Tag nicht im Baum ist. */
    private static Pfad pfadAm(Ortsbaum baum, String kz, LocalDate tag) {
        List<String> pfad = new ArrayList<>();
        String k = kz;
        // Bereich → Gebäude → Standort: mehr als drei Schritte sind ein kaputter Baum.
        for (int schritt = 0; schritt < 3 && k != null; schritt++) {
            Ort o = baum.ort(k).orElse(null);
            Intervall iv = o == null ? null : intervallAm(o.intervalle(), tag);
            if (o == null || iv == null) {
                return new Pfad(pfad, null);
            }
            pfad.add(k);
            if (o.art() == OrtArt.STANDORT) {
                return new Pfad(pfad, k);
            }
            k = iv.eltern();
        }
        return new Pfad(pfad, null);
    }

    private static ZoneId zeitzoneVon(Ortsbaum baum, String standort) {
        return Optional.ofNullable(standort)
                .flatMap(baum::ort)
                .map(Ort::zeitzone)
                .map(ZoneId::of)
                .orElse(baum.zeitzone());
    }

    // ------------------------------------------------------------------ Fläche

    /** Nur am Standort gesetzt: die Summe seiner Gebäude — null, sobald einem die Fläche fehlt. */
    public record FlaecheAmTag(
            boolean vorhanden,
            Integer flaecheM2,
            FlaecheQuelle flaecheQuelle,
            Integer summeGebaeudeM2,
            List<String> gebaeudeOhneFlaeche) {}

    private static Integer eigeneFlaeche(Ort o, LocalDate tag) {
        return o.flaechen().stream()
                .filter(f -> f.deckt(tag))
                .findFirst()
                .map(FlaechenIntervall::m2)
                .orElse(null);
    }

    private static FlaecheAmTag flaecheVon(Ortsbaum baum, Ort o, LocalDate tag) {
        boolean da = intervallAm(o.intervalle(), tag) != null;
        Integer eigen = da ? eigeneFlaeche(o, tag) : null;
        if (o.art() != OrtArt.STANDORT) {
            return new FlaecheAmTag(da, eigen, eigen == null ? null : FlaecheQuelle.EIGEN, null, null);
        }
        List<Ort> gebaeude = da
                ? baum.orte().stream()
                        .filter(g -> g.art() == OrtArt.GEBAEUDE
                                && o.kennzeichen().equals(elternAm(g.intervalle(), tag)))
                        .toList()
                : List.of();
        List<String> ohne = gebaeude.stream()
                .filter(g -> eigeneFlaeche(g, tag) == null)
                .map(Ort::kennzeichen)
                .toList();
        Integer summe = !gebaeude.isEmpty() && ohne.isEmpty()
                ? gebaeude.stream().mapToInt(g -> eigeneFlaeche(g, tag)).sum()
                : null;
        Integer m2 = eigen != null ? eigen : summe;
        FlaecheQuelle quelle = eigen != null
                ? FlaecheQuelle.EIGEN
                : summe != null ? FlaecheQuelle.AUS_GEBAEUDEN_SUMMIERT : null;
        return new FlaecheAmTag(da, m2, quelle, summe, ohne);
    }

    /** E3/Regel 12: die Fläche eines Ortes an einem Tag — nie saldiert, nie erfunden. */
    public static FlaecheAmTag flaecheAm(Ortsbaum baum, String objekt, LocalDate tag) {
        Ort o = baum.ort(objekt).orElseThrow(() -> new IllegalArgumentException("unbekannter Ort: " + objekt));
        return flaecheVon(baum, o, tag);
    }

    public record FlaechenTeil(
            LocalDate von, LocalDate bis, boolean vorhanden, Integer flaecheM2, FlaecheQuelle flaecheQuelle) {}

    /** Ein Zeitraum in Teile mit je EINER Fläche — nie ein Mittelwert. */
    public static List<FlaechenTeil> flaecheZeitraum(
            Ortsbaum baum, String objekt, LocalDate von, LocalDate bis) {
        List<FlaechenTeil> out = new ArrayList<>();
        for (LocalDate tag = von; !tag.isAfter(bis); tag = tag.plusDays(1)) {
            FlaecheAmTag f = flaecheAm(baum, objekt, tag);
            FlaechenTeil letzter = out.isEmpty() ? null : out.get(out.size() - 1);
            if (letzter != null
                    && letzter.vorhanden() == f.vorhanden()
                    && Objects.equals(letzter.flaecheM2(), f.flaecheM2())
                    && letzter.flaecheQuelle() == f.flaecheQuelle()) {
                out.set(out.size() - 1, new FlaechenTeil(
                        letzter.von(), tag, letzter.vorhanden(), letzter.flaecheM2(), letzter.flaecheQuelle()));
            } else {
                out.add(new FlaechenTeil(tag, tag, f.vorhanden(), f.flaecheM2(), f.flaecheQuelle()));
            }
        }
        return out;
    }

    // ----------------------------------------------------------- Fläche ändern

    /** §5.10: der Satz zu einer Fläche, die keine ganze Zahl größer als 0 ist. */
    public static final String FLAECHE_SATZ =
            "Bitte geben Sie die Bezugsfläche als ganze Zahl in m² an, z. B. 3\u00a0100.";

    /** Die Reihenfolge IST die Regel: sie entscheidet, welcher Grund gilt, wenn mehrere zutreffen. */
    public enum FlaecheGrund {
        FLAECHE_UNGUELTIG, GAB_ES_NOCH_NICHT, ARCHIVIERT, GLEICHE_FLAECHE
    }

    public record FlaecheAntrag(String objekt, LocalDate ab, int m2, LocalDate heute) {}

    public record FlaechenIntervallMitZustand(LocalDate ab, LocalDate bis, int m2, ZuordnungZustand zustand) {}

    /**
     * {@code korrektur}: am Tag {@code ab} begann schon eine Fläche — sie wird
     * ersetzt (aufgehoben, bleibt lesbar). {@code vorherM2}: die Fläche, die an dem
     * Tag bisher galt ({@code null}: keine). {@code flaechen}: alle wirksamen
     * Flächen des Objekts nach dem Eintrag, nach Beginn sortiert.
     */
    public record FlaecheErgebnis(
            boolean erlaubt,
            FlaecheGrund grund,
            String text,
            Boolean korrektur,
            Integer vorherM2,
            List<FlaechenIntervallMitZustand> flaechen) {

        static FlaecheErgebnis nein(FlaecheGrund grund, String text) {
            return new FlaecheErgebnis(false, grund, text, null, null, null);
        }
    }

    /** „3 400 m²“ — Tausender und Einheit mit geschütztem Leerzeichen, wie die Sätze des Konzepts. */
    public static String m2Text(int m2) {
        String z = Integer.toString(m2);
        StringBuilder s = new StringBuilder();
        for (int i = 0; i < z.length(); i++) {
            if (i > 0 && (z.length() - i) % 3 == 0) {
                s.append('\u00a0');
            }
            s.append(z.charAt(i));
        }
        return s + "\u00a0m²";
    }

    /**
     * E3: eine Bezugsfläche ab einem Tag — dieselbe Mechanik wie eine Zuordnung
     * (§4.3): die laufende Fläche endet am VORTAG, die neue erbt deren Ende (auch
     * das vor einer geplanten); in einer Lücke endet sie am Vortag der nächsten.
     * Beginnt am Tag schon eine, ist es eine Korrektur (§4.2 „gültig ab = Beginn
     * des laufenden Intervalls“): sie wird ersetzt, nie umgeschrieben. Vor dem
     * ersten Tag des Objekts und an einem Tag, an dem es archiviert war, gibt es
     * keine Fläche. GENAU EIN Grund in der Reihenfolge von {@link FlaecheGrund}.
     */
    public static FlaecheErgebnis flaecheEintrag(Ortsbaum baum, FlaecheAntrag antrag) {
        if (antrag.m2() <= 0) {
            return FlaecheErgebnis.nein(FlaecheGrund.FLAECHE_UNGUELTIG, FLAECHE_SATZ);
        }
        Ort o = baum.ort(antrag.objekt())
                .orElseThrow(() -> new IllegalArgumentException("unbekannter Ort: " + antrag.objekt()));
        LocalDate ab = antrag.ab();
        Bestand b = bestand(o.intervalle(), ab);
        if (b == Bestand.GAB_ES_NOCH_NICHT) {
            List<Intervall> w = wirksam(o.intervalle());
            if (w.isEmpty()) {
                return FlaecheErgebnis.nein(FlaecheGrund.GAB_ES_NOCH_NICHT,
                        o.name() + " gibt es im Portal noch nicht.");
            }
            String erster = datumText(w.get(0).ab());
            return FlaecheErgebnis.nein(FlaecheGrund.GAB_ES_NOCH_NICHT,
                    o.name() + " gibt es im Portal erst seit " + erster + ". Wählen Sie ein Datum ab dem "
                            + erster + ".");
        }
        if (b == Bestand.ARCHIVIERT) {
            return FlaecheErgebnis.nein(FlaecheGrund.ARCHIVIERT,
                    "Am " + datumText(ab) + " war " + o.name() + " archiviert.");
        }
        List<FlaechenIntervall> liste = o.flaechen().stream()
                .sorted(Comparator.comparing(FlaechenIntervall::ab))
                .toList();
        FlaechenIntervall laufend = liste.stream().filter(f -> f.deckt(ab)).findFirst().orElse(null);
        if (laufend != null && laufend.m2() == antrag.m2()) {
            return FlaecheErgebnis.nein(FlaecheGrund.GLEICHE_FLAECHE,
                    o.name() + " hat am " + datumText(ab) + " bereits " + m2Text(antrag.m2()) + ".");
        }
        boolean korrektur = laufend != null && laufend.ab().equals(ab);
        LocalDate bis = laufend != null
                ? laufend.bis()
                : liste.stream()
                        .map(FlaechenIntervall::ab)
                        .filter(t -> t.isAfter(ab))
                        .findFirst()
                        .map(t -> t.minusDays(1))
                        .orElse(null);
        List<FlaechenIntervall> danach = new ArrayList<>();
        for (FlaechenIntervall f : liste) {
            if (f != laufend) {
                danach.add(f);
            } else if (!korrektur) {
                danach.add(new FlaechenIntervall(f.ab(), ab.minusDays(1), f.m2()));
            }
        }
        danach.add(new FlaechenIntervall(ab, bis, antrag.m2()));
        List<FlaechenIntervallMitZustand> sortiert = danach.stream()
                .sorted(Comparator.comparing(FlaechenIntervall::ab))
                .map(f -> new FlaechenIntervallMitZustand(f.ab(), f.bis(), f.m2(),
                        zuordnungZustand(new Intervall(f.ab(), f.bis(), null), antrag.heute())))
                .toList();
        return new FlaecheErgebnis(true, null, null, korrektur, laufend == null ? null : laufend.m2(), sortiert);
    }

    // ---------------------------------------------------------------- Stand am

    /** Eine Zeile des Baums; Summe und fehlende Gebäudeflächen nur am Standort. */
    public record OrtAmStichtag(
            String kennzeichen,
            String eltern,
            String standort,
            Integer flaecheM2,
            FlaecheQuelle flaecheQuelle,
            Integer summeGebaeudeM2,
            List<String> gebaeudeOhneFlaeche) {}

    public record NichtGezeigt(String kennzeichen, Bestand grund, String text) {}

    public record AnlageAmStichtag(String kennzeichen, String standort) {}

    public record StandAm(
            List<OrtAmStichtag> orte, List<NichtGezeigt> nichtGezeigt, List<AnlageAmStichtag> anlagen) {}

    private static String bestandSatz(Bestand grund, String name, LocalDate tag) {
        return grund == Bestand.GAB_ES_NOCH_NICHT
                ? "Am " + datumText(tag) + " gab es " + name + " im Portal noch nicht."
                : "Am " + datumText(tag) + " war " + name + " archiviert.";
    }

    /**
     * §4.4: der Ortsbaum, die Flächen und die Anlagen-Zuordnung so, wie sie an
     * diesem Tag galten. Objekte, die es an dem Tag nicht gab, fehlen (mit
     * Grund); archivierte, die es gab, erscheinen normal.
     */
    public static StandAm standAm(Ortsbaum baum, LocalDate stichtag) {
        List<OrtAmStichtag> orte = new ArrayList<>();
        List<NichtGezeigt> nichtGezeigt = new ArrayList<>();
        for (Ort o : baum.orte()) {
            Bestand b = bestand(o.intervalle(), stichtag);
            if (b != Bestand.VORHANDEN) {
                nichtGezeigt.add(new NichtGezeigt(o.kennzeichen(), b, bestandSatz(b, o.name(), stichtag)));
                continue;
            }
            FlaecheAmTag f = flaecheVon(baum, o, stichtag);
            orte.add(new OrtAmStichtag(
                    o.kennzeichen(),
                    elternAm(o.intervalle(), stichtag),
                    pfadAm(baum, o.kennzeichen(), stichtag).standort(),
                    f.flaecheM2(),
                    f.flaecheQuelle(),
                    f.summeGebaeudeM2(),
                    f.gebaeudeOhneFlaeche()));
        }
        List<AnlageAmStichtag> anlagen = baum.anlagen().stream()
                .map(a -> {
                    String st = elternAm(a.zuordnungen(), stichtag);
                    return new AnlageAmStichtag(
                            a.kennzeichen(), st != null && vorhanden(baum, st, stichtag) ? st : null);
                })
                .toList();
        return new StandAm(orte, nichtGezeigt, anlagen);
    }

    // ------------------------------------------------------------- Überlappung

    public record ListenErgebnis(boolean gueltig, ListenGrund grund, LocalDate tag) {}

    /** Das Überlappungsverbot (Regel 2) — was IP-2b als Exklusions-Constraint spiegelt. */
    public static ListenErgebnis pruefeIntervalle(List<Intervall> intervalle) {
        for (Intervall i : intervalle) {
            if (i.bis() != null && i.bis().isBefore(i.ab())) {
                return new ListenErgebnis(false, ListenGrund.BIS_VOR_AB, i.ab());
            }
        }
        List<Intervall> w = wirksam(intervalle);
        for (int k = 1; k < w.size(); k++) {
            Intervall vorher = w.get(k - 1);
            if (vorher.bis() == null || !vorher.bis().isBefore(w.get(k).ab())) {
                return new ListenErgebnis(false, ListenGrund.UEBERLAPPUNG, w.get(k).ab());
            }
        }
        return new ListenErgebnis(true, null, null);
    }

    public record EintragAntrag(String objekt, Vorgang vorgang, LocalDate ab, String eltern, LocalDate heute) {}

    public record IntervallMitZustand(
            LocalDate ab, LocalDate bis, String eltern, boolean aufgehoben, ZuordnungZustand zustand) {}

    /** {@code intervalle}: alle Intervalle des Objekts nach dem Eintrag, nach Beginn sortiert. */
    public record EintragErgebnis(
            boolean erlaubt, EintragGrund grund, String text, List<IntervallMitZustand> intervalle) {

        static EintragErgebnis nein(EintragGrund grund, String text) {
            return new EintragErgebnis(false, grund, text, null);
        }
    }

    /** Messstellen liest der Kunde mit Kennzeichen („MS-18 …“), alles andere mit seinem Namen. */
    private record Objekt(String kennzeichen, ObjektArt art, String anzeige, List<Intervall> intervalle) {}

    private static Objekt objekt(Ortsbaum baum, String kz) {
        Ort o = baum.ort(kz).orElse(null);
        if (o != null && o.art() != OrtArt.STANDORT) {
            return new Objekt(kz, ObjektArt.valueOf(o.art().name()), o.name(), o.intervalle());
        }
        for (Anlage a : baum.anlagen()) {
            if (a.kennzeichen().equals(kz)) {
                return new Objekt(kz, ObjektArt.ANLAGE, a.name(), a.zuordnungen());
            }
        }
        for (Messstelle m : baum.messstellen()) {
            if (m.kennzeichen().equals(kz)) {
                return new Objekt(kz, ObjektArt.MESSSTELLE, kz + " " + m.name(), m.zuordnungen());
            }
        }
        throw new IllegalArgumentException("kein verschiebbares Objekt: " + kz);
    }

    private static String zielArtSatz(ObjektArt art) {
        return switch (art) {
            case GEBAEUDE -> "Ein Gebäude kann nur an einem Standort hängen.";
            case BEREICH -> "Ein Bereich kann nur an einem Gebäude oder direkt an einem Standort hängen.";
            case ANLAGE -> "Eine Anlage kann nur einem Standort zugeordnet werden.";
            case MESSSTELLE -> "Eine Messstelle kann nur an einem Ort oder am Unternehmen hängen.";
        };
    }

    /**
     * Ein neues „gültig ab“ (verschieben, zuordnen) oder eine Korrektur gegen
     * die vorhandenen Intervalle — GENAU EIN Grund in der festen Reihenfolge von
     * {@link EintragGrund}, sonst die Intervalle danach.
     */
    public static EintragErgebnis eintrag(Ortsbaum baum, EintragAntrag antrag) {
        Objekt obj = objekt(baum, antrag.objekt());
        Ort zielOrt = baum.ort(antrag.eltern()).orElse(null);
        if (!UNTERNEHMEN.equals(antrag.eltern()) && zielOrt == null) {
            throw new IllegalArgumentException("unbekanntes Ziel: " + antrag.eltern());
        }
        ElternArt zielArt = zielOrt == null ? ElternArt.UNTERNEHMEN : ElternArt.valueOf(zielOrt.art().name());
        String zielName = elternName(baum, antrag.eltern());
        if (!ERLAUBTE_ELTERN.get(obj.art()).contains(zielArt)) {
            return EintragErgebnis.nein(EintragGrund.ZIEL_ART_UNZULAESSIG, zielArtSatz(obj.art()));
        }
        String bisherSatz = obj.art() == ObjektArt.ANLAGE
                ? obj.anzeige() + " ist bereits " + zielName + " zugeordnet."
                : obj.anzeige() + " hängt bereits an " + zielName + ".";
        Function<Intervall, EintragErgebnis> zielPruefen = neu -> {
            if (zielOrt == null) {
                return null;
            }
            LocalDate fehlt = ersterFehlenderTag(zielOrt.intervalle(), neu.ab(), neu.bis());
            if (fehlt == null) {
                return null;
            }
            List<Intervall> w = wirksam(zielOrt.intervalle());
            if (!w.isEmpty() && fehlt.isBefore(w.get(0).ab())) {
                String erster = datumText(w.get(0).ab());
                return EintragErgebnis.nein(
                        EintragGrund.ZIEL_GAB_ES_NOCH_NICHT,
                        zielName + " gibt es im Portal erst seit " + erster + ". Wählen Sie ein Datum ab dem "
                                + erster + ".");
            }
            return EintragErgebnis.nein(
                    EintragGrund.ZIEL_ARCHIVIERT,
                    "Am " + datumText(fehlt) + " war " + zielName + " archiviert.");
        };

        List<Intervall> liste = wirksam(obj.intervalle());
        List<Intervall> danach = new ArrayList<>();
        if (antrag.vorgang() == Vorgang.KORREKTUR) {
            Intervall ersetzt = liste.stream()
                    .filter(i -> i.ab().equals(antrag.ab()))
                    .findFirst()
                    .orElse(null);
            if (ersetzt == null) {
                return EintragErgebnis.nein(
                        EintragGrund.KEIN_BEGINN_AN_DEM_TAG,
                        "Am " + datumText(antrag.ab()) + " beginnt keine Zuordnung von " + obj.anzeige()
                                + ". Eine Korrektur ersetzt eine Zuordnung ab ihrem Beginn.");
            }
            if (Objects.equals(ersetzt.eltern(), antrag.eltern())) {
                return EintragErgebnis.nein(EintragGrund.ZIEL_IST_BISHERIGER_ELTERN, bisherSatz);
            }
            Intervall neu = new Intervall(ersetzt.ab(), ersetzt.bis(), antrag.eltern());
            EintragErgebnis ziel = zielPruefen.apply(neu);
            if (ziel != null) {
                return ziel;
            }
            for (Intervall i : obj.intervalle()) {
                danach.add(i == ersetzt ? new Intervall(i.ab(), i.bis(), i.eltern(), true) : i);
            }
            danach.add(neu);
        } else if (liste.isEmpty()) {
            // Die erste Zuordnung (eine noch nicht zugeordnete Anlage) hat nichts zu beenden.
            Intervall neu = new Intervall(antrag.ab(), null, antrag.eltern());
            EintragErgebnis ziel = zielPruefen.apply(neu);
            if (ziel != null) {
                return ziel;
            }
            danach.addAll(obj.intervalle());
            danach.add(neu);
        } else {
            LocalDate erster = liste.get(0).ab();
            if (antrag.ab().isBefore(erster)) {
                return EintragErgebnis.nein(
                        EintragGrund.VOR_DEM_ERSTEN_INTERVALL,
                        obj.anzeige() + " gibt es im Portal erst seit " + datumText(erster)
                                + ". Wählen Sie ein Datum ab dem " + datumText(erster)
                                + " — oder ersetzen Sie die Zuordnung ab Beginn (Korrektur).");
            }
            Intervall laufend = liste.stream().filter(i -> i.deckt(antrag.ab())).findFirst().orElse(null);
            if (laufend == null) {
                return EintragErgebnis.nein(
                        EintragGrund.OBJEKT_ARCHIVIERT,
                        "Am " + datumText(antrag.ab()) + " war " + obj.anzeige() + " archiviert.");
            }
            if (laufend.ab().equals(antrag.ab())) {
                return EintragErgebnis.nein(
                        EintragGrund.GLEICHER_TAG,
                        "Für den " + datumText(antrag.ab()) + " gibt es schon eine Zuordnung ("
                                + elternName(baum, laufend.eltern())
                                + "). Ändern Sie diese, statt eine zweite anzulegen.");
            }
            if (Objects.equals(laufend.eltern(), antrag.eltern())) {
                return EintragErgebnis.nein(EintragGrund.ZIEL_IST_BISHERIGER_ELTERN, bisherSatz);
            }
            Intervall neu = new Intervall(antrag.ab(), laufend.bis(), antrag.eltern());
            EintragErgebnis ziel = zielPruefen.apply(neu);
            if (ziel != null) {
                return ziel;
            }
            for (Intervall i : obj.intervalle()) {
                danach.add(i == laufend
                        ? new Intervall(i.ab(), antrag.ab().minusDays(1), i.eltern(), i.aufgehoben())
                        : i);
            }
            danach.add(neu);
        }
        List<IntervallMitZustand> sortiert = danach.stream()
                .sorted(Comparator.comparing(Intervall::ab).thenComparing(i -> !i.aufgehoben()))
                .map(i -> new IntervallMitZustand(
                        i.ab(), i.bis(), i.eltern(), i.aufgehoben(), zuordnungZustand(i, antrag.heute())))
                .toList();
        return new EintragErgebnis(true, null, null, sortiert);
    }

    // ------------------------------------------------------------- Rückwirkung

    public record Zeitraum(LocalDate von, LocalDate bis) {}

    /**
     * @param eingetragenUm wann der Eintrag gespeichert wurde
     * @param giltBis das Ende des Intervalls, das der Eintrag anlegt; null = offen
     * @param zeitzone die Zeitzone des Standorts — sie bestimmt den Eintragstag
     * @param zeitraum optional ein Berichtszeitraum, gegen den geprüft wird
     */
    public record RueckwirkungEingang(
            OffsetDateTime eingetragenUm,
            LocalDate giltAb,
            LocalDate giltBis,
            ZoneId zeitzone,
            Zeitraum zeitraum) {}

    /**
     * {@code tage}: wie weit „gilt ab“ vor (rückwirkend) bzw. nach (geplant) dem
     * Eintragstag liegt. {@code rueckwirkendBetroffen}: die Tage, die NACHTRÄGLICH
     * anders gelten — der Fakt für die Revision (AP-12).
     */
    public record RueckwirkungErgebnis(
            Rueckwirkung art,
            LocalDate eintragstag,
            long tage,
            String abzeichen,
            Zeitraum rueckwirkendBetroffen,
            Boolean reichtInZeitraum,
            Boolean rueckwirkendImZeitraum) {}

    /** E2: Rückwirkung ist erlaubt — aber immer sichtbar. */
    public static RueckwirkungErgebnis rueckwirkung(RueckwirkungEingang e) {
        LocalDate eintragstag = e.eingetragenUm().atZoneSameInstant(e.zeitzone()).toLocalDate();
        Rueckwirkung art = e.giltAb().isBefore(eintragstag)
                ? Rueckwirkung.RUECKWIRKEND
                : e.giltAb().equals(eintragstag) ? Rueckwirkung.AB_HEUTE : Rueckwirkung.GEPLANT;
        long tage = Math.abs(ChronoUnit.DAYS.between(e.giltAb(), eintragstag));
        Zeitraum betroffen = null;
        if (art == Rueckwirkung.RUECKWIRKEND) {
            LocalDate vortag = eintragstag.minusDays(1);
            betroffen = new Zeitraum(
                    e.giltAb(), e.giltBis() == null || vortag.isBefore(e.giltBis()) ? vortag : e.giltBis());
        }
        Zeitraum z = e.zeitraum();
        Boolean reicht = z == null
                ? null
                : !e.giltAb().isAfter(z.bis()) && (e.giltBis() == null || !e.giltBis().isBefore(z.von()));
        Boolean rueckIm = z == null
                ? null
                : betroffen != null && !betroffen.von().isAfter(z.bis()) && !betroffen.bis().isBefore(z.von());
        String abzeichen = art == Rueckwirkung.RUECKWIRKEND
                ? "rückwirkend (" + tage + (tage == 1 ? " Tag)" : " Tage)")
                : null;
        return new RueckwirkungErgebnis(art, eintragstag, tage, abzeichen, betroffen, reicht, rueckIm);
    }

    // ------------------------------------------------ Standort einer Messstelle

    /** {@code pfad}: vom Ort hinauf bis zum Standort. */
    public record Verortung(String ort, List<String> pfad, String standort, VerortungGrund grund) {}

    private static Verortung verortungVon(Ortsbaum baum, Messstelle m, LocalDate tag) {
        Intervall iv = intervallAm(m.zuordnungen(), tag);
        if (iv == null || iv.eltern() == null) {
            return new Verortung(null, List.of(), null, VerortungGrund.NICHT_VERORTET);
        }
        if (UNTERNEHMEN.equals(iv.eltern())) {
            return new Verortung(UNTERNEHMEN, List.of(), null, VerortungGrund.AM_UNTERNEHMEN);
        }
        Pfad p = pfadAm(baum, iv.eltern(), tag);
        return new Verortung(
                iv.eltern(),
                p.knoten(),
                p.standort(),
                p.standort() == null ? VerortungGrund.ORT_NICHT_IM_BAUM : VerortungGrund.VERORTET);
    }

    /** Regel 7: der Standort einer Messstelle ist die Wurzel ihres Ortsknotens AN DIESEM TAG. */
    public static Verortung verortung(Ortsbaum baum, String messstelle, LocalDate tag) {
        Messstelle m = baum.messstellen().stream()
                .filter(x -> x.kennzeichen().equals(messstelle))
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("unbekannte Messstelle: " + messstelle));
        return verortungVon(baum, m, tag);
    }

    // ------------------------------------------------------------ Folgen-Karte

    public record Folgen(
            List<String> ziehenMit,
            List<String> messstellenWechselnStandort,
            List<String> bleibenAnlagen,
            List<String> bleibenNetzanschluesse,
            List<String> bleibenMessstellen) {}

    public record FolgenErgebnis(boolean erlaubt, EintragGrund grund, String text, Folgen folgen) {}

    private static Ortsbaum mitIntervallen(Ortsbaum baum, String kz, List<Intervall> intervalle) {
        return new Ortsbaum(
                baum.zeitzone(),
                baum.orte().stream()
                        .map(o -> o.kennzeichen().equals(kz)
                                ? new Ort(
                                        o.kennzeichen(), o.art(), o.name(), o.zeitzone(), intervalle, o.flaechen())
                                : o)
                        .toList(),
                baum.anlagen().stream()
                        .map(a -> a.kennzeichen().equals(kz)
                                ? new Anlage(
                                        a.kennzeichen(), a.name(), a.netzanschluss(), a.zustand(), intervalle)
                                : a)
                        .toList(),
                baum.messstellen().stream()
                        .map(m -> m.kennzeichen().equals(kz)
                                ? new Messstelle(m.kennzeichen(), m.name(), m.anlage(), m.zustand(), intervalle)
                                : m)
                        .toList());
    }

    /**
     * E11/A13: was die Folgen-Karte vor dem Speichern nennt. Bereiche ziehen
     * mit; eine Messstelle steht dort, wenn ihr Standort am Umzugstag MIT dem
     * Umzug ein anderer ist als OHNE ihn; es bleiben die Anlagen dieser
     * Messstellen, die nicht schon am Ziel-Standort sind, ihre Netzanschlüsse
     * und ihre übrigen Messstellen.
     */
    public static FolgenErgebnis verschiebenFolgen(Ortsbaum baum, EintragAntrag antrag) {
        EintragErgebnis e = eintrag(baum, antrag);
        if (!e.erlaubt()) {
            return new FolgenErgebnis(false, e.grund(), e.text(), null);
        }
        LocalDate tag = antrag.ab();
        Ortsbaum nachher = mitIntervallen(
                baum,
                antrag.objekt(),
                e.intervalle().stream()
                        .map(i -> new Intervall(i.ab(), i.bis(), i.eltern(), i.aufgehoben()))
                        .toList());
        List<String> ziehenMit = baum.orte().stream()
                .filter(o -> !o.kennzeichen().equals(antrag.objekt())
                        && antrag.objekt().equals(elternAm(o.intervalle(), tag)))
                .map(Ort::kennzeichen)
                .toList();
        Map<String, Messstelle> nachherMs = new HashMap<>();
        nachher.messstellen().forEach(m -> nachherMs.put(m.kennzeichen(), m));
        Function<Messstelle, String> standortNachher =
                m -> verortungVon(nachher, nachherMs.get(m.kennzeichen()), tag).standort();
        List<Messstelle> wechseln = baum.messstellen().stream()
                .filter(m -> !Objects.equals(verortungVon(baum, m, tag).standort(), standortNachher.apply(m)))
                .toList();
        String zielStandort = nachher.ort(antrag.objekt()).isPresent()
                ? pfadAm(nachher, antrag.objekt(), tag).standort()
                : antrag.eltern();
        Set<String> betroffen = new LinkedHashSet<>();
        wechseln.stream().map(Messstelle::anlage).filter(Objects::nonNull).forEach(betroffen::add);
        List<Anlage> bleibenAnlagen = nachher.anlagen().stream()
                .filter(a -> betroffen.contains(a.kennzeichen())
                        && !Objects.equals(elternAm(a.zuordnungen(), tag), zielStandort))
                .toList();
        List<String> netz = bleibenAnlagen.stream()
                .map(Anlage::netzanschluss)
                .filter(Objects::nonNull)
                .distinct()
                .toList();
        List<String> bleibenMessstellen = baum.messstellen().stream()
                .filter(m -> m.anlage() != null
                        && betroffen.contains(m.anlage())
                        && !wechseln.contains(m)
                        && !Objects.equals(standortNachher.apply(m), zielStandort))
                .map(Messstelle::kennzeichen)
                .toList();
        return new FolgenErgebnis(true, null, null, new Folgen(
                ziehenMit,
                wechseln.stream().map(Messstelle::kennzeichen).toList(),
                bleibenAnlagen.stream().map(Anlage::kennzeichen).toList(),
                netz,
                bleibenMessstellen));
    }

    // --------------------------------------------------- Archivieren · Löschen

    /** {@code ab}/{@code eltern} nur bei {@code GEPLANTE_ZUORDNUNG}: ab wann und wohin. */
    public record ArchivGrund(
            ArchivGrundArt art, String kennzeichen, String name, LocalDate ab, String eltern) {

        ArchivGrund(ArchivGrundArt art, String kennzeichen, String name) {
            this(art, kennzeichen, name, null, null);
        }
    }

    public record Archiviert(String kennzeichen, LocalDate letzterTag) {}

    /** {@code gruende}: ALLE Sperren — die Rückfrage trägt ihre Folgenliste. */
    public record ArchivErgebnis(
            boolean erlaubt, List<ArchivGrund> gruende, String text, List<Archiviert> archiviert) {}

    /** „a“ · „a und b“ · „a, b und c“ — eine deutsche Aufzählung. */
    private static String aufzaehlung(List<String> worte) {
        if (worte.size() == 1) {
            return worte.get(0);
        }
        return String.join(", ", worte.subList(0, worte.size() - 1)) + " und " + worte.get(worte.size() - 1);
    }

    private static String archivSatz(Ortsbaum baum, String name, List<ArchivGrund> gruende) {
        List<ArchivGrund> anlagen =
                gruende.stream().filter(g -> g.art() == ArchivGrundArt.ANLAGE_AKTIV).toList();
        List<ArchivGrund> messstellen =
                gruende.stream().filter(g -> g.art() == ArchivGrundArt.MESSSTELLE_AKTIV).toList();
        List<ArchivGrund> geplant =
                gruende.stream().filter(g -> g.art() == ArchivGrundArt.GEPLANTE_ZUORDNUNG).toList();
        List<String> teile = new ArrayList<>();
        List<String> wege = new ArrayList<>();
        if (anlagen.size() == 1) {
            teile.add("die Anlage " + anlagen.get(0).name() + " ist aktiv");
            wege.add("Ordnen Sie die Anlage einem anderen Standort zu oder archivieren Sie sie zuerst.");
        } else if (anlagen.size() > 1) {
            teile.add("die Anlagen " + aufzaehlung(anlagen.stream().map(ArchivGrund::name).toList())
                    + " sind aktiv");
            wege.add("Ordnen Sie die Anlagen einem anderen Standort zu oder archivieren Sie sie zuerst.");
        }
        if (!messstellen.isEmpty()) {
            String liste =
                    aufzaehlung(messstellen.stream().map(g -> g.kennzeichen() + " " + g.name()).toList());
            boolean eine = messstellen.size() == 1;
            teile.add(eine
                    ? "1 Messstelle ist hier aktiv (" + liste + ")"
                    : messstellen.size() + " Messstellen sind hier aktiv (" + liste + ")");
            wege.add("Ziehen Sie " + (eine ? "die Messstelle" : "die Messstellen")
                    + " zuerst um oder legen Sie sie still (Messstellen).");
        }
        for (ArchivGrund g : geplant) {
            teile.add("für " + g.name() + " ist ab " + datumText(g.ab()) + " eine Zuordnung zu "
                    + elternName(baum, g.eltern()) + " geplant");
        }
        if (!geplant.isEmpty()) {
            wege.add(geplant.size() == 1
                    ? "Heben Sie die geplante Zuordnung zuerst auf."
                    : "Heben Sie die geplanten Zuordnungen zuerst auf.");
        }
        return name + " kann nicht archiviert werden: " + aufzaehlung(teile) + ". " + String.join(" ", wege);
    }

    /**
     * E12: nur ohne aktive Anlage (am Standort), ohne aktive Messstelle im
     * Teilbaum und ohne geplante Zuordnung hinein oder heraus; leere Kinder
     * werden mitarchiviert, jedes Intervall endet am Vortag. Keine Kaskade auf
     * Messstellen oder Anlagen.
     */
    public static ArchivErgebnis archivieren(Ortsbaum baum, String objekt, LocalDate tag) {
        Ort o = baum.ort(objekt).orElseThrow(() -> new IllegalArgumentException("unbekannter Ort: " + objekt));
        Bestand b = bestand(o.intervalle(), tag);
        if (b != Bestand.VORHANDEN) {
            ArchivGrundArt art = ArchivGrundArt.valueOf(b.name());
            return new ArchivErgebnis(
                    false,
                    List.of(new ArchivGrund(art, objekt, o.name())),
                    bestandSatz(b, o.name(), tag),
                    null);
        }
        List<String> teilbaum = baum.orte().stream()
                .map(Ort::kennzeichen)
                .filter(kz -> pfadAm(baum, kz, tag).knoten().contains(objekt))
                .toList();
        List<ArchivGrund> gruende = new ArrayList<>();
        if (o.art() == OrtArt.STANDORT) {
            for (Anlage a : baum.anlagen()) {
                if (a.zustand() == ObjektZustand.AKTIV && objekt.equals(elternAm(a.zuordnungen(), tag))) {
                    gruende.add(new ArchivGrund(ArchivGrundArt.ANLAGE_AKTIV, a.kennzeichen(), a.name()));
                }
            }
        }
        for (Messstelle m : baum.messstellen()) {
            String ort = elternAm(m.zuordnungen(), tag);
            if (m.zustand() == ObjektZustand.AKTIV && ort != null && teilbaum.contains(ort)) {
                gruende.add(new ArchivGrund(ArchivGrundArt.MESSSTELLE_AKTIV, m.kennzeichen(), m.name()));
            }
        }
        for (Ort x : baum.orte()) {
            boolean eigen = teilbaum.contains(x.kennzeichen());
            geplant(gruende, x.kennzeichen(), x.name(), x.intervalle(), eigen, teilbaum, tag);
        }
        for (Anlage a : baum.anlagen()) {
            if (a.zustand() == ObjektZustand.AKTIV) {
                geplant(gruende, a.kennzeichen(), a.name(), a.zuordnungen(), false, teilbaum, tag);
            }
        }
        for (Messstelle m : baum.messstellen()) {
            if (m.zustand() == ObjektZustand.AKTIV) {
                String anzeige = m.kennzeichen() + " " + m.name();
                geplant(gruende, m.kennzeichen(), anzeige, m.zuordnungen(), false, teilbaum, tag);
            }
        }
        if (!gruende.isEmpty()) {
            return new ArchivErgebnis(false, gruende, archivSatz(baum, o.name(), gruende), null);
        }
        LocalDate letzterTag = tag.minusDays(1);
        return new ArchivErgebnis(
                true, List.of(), null, teilbaum.stream().map(kz -> new Archiviert(kz, letzterTag)).toList());
    }

    private static void geplant(
            List<ArchivGrund> gruende,
            String kz,
            String name,
            List<Intervall> liste,
            boolean eigen,
            List<String> teilbaum,
            LocalDate tag) {
        for (Intervall i : wirksam(liste)) {
            if (i.ab().isAfter(tag) && (eigen || (i.eltern() != null && teilbaum.contains(i.eltern())))) {
                gruende.add(new ArchivGrund(ArchivGrundArt.GEPLANTE_ZUORDNUNG, kz, name, i.ab(), i.eltern()));
            }
        }
    }

    public record NeuesIntervall(LocalDate ab, LocalDate bis, String eltern) {}

    /** {@code luecke}: die Zeit dazwischen — sichtbar, nie aufgefüllt. */
    public record WiederherstellErgebnis(
            boolean erlaubt,
            WiederherstellGrund grund,
            String text,
            NeuesIntervall intervall,
            String name,
            Zeitraum luecke) {

        static WiederherstellErgebnis nein(WiederherstellGrund grund, String text) {
            return new WiederherstellErgebnis(false, grund, text, null, null, null);
        }
    }

    private static String namensSchluessel(String name) {
        return name.strip().toLowerCase(Locale.ROOT);
    }

    /**
     * Regel 13 / §4.1: der Geschwister-Ort, der den Namen am Tag trägt — dieselbe
     * Art, derselbe Elternknoten ({@code null}: am Unternehmen, also die
     * Standorte), am Tag im Baum, ohne Groß-/Kleinschreibung und Randleerzeichen.
     * {@code ausser} ist der Ort selbst (Umbenennen, Wiederherstellen), sonst
     * {@code null}. Leer = der Name ist frei. Dieselbe Prüfung beim Anlegen,
     * Umbenennen und Wiederherstellen.
     */
    public static Optional<Ort> nameBelegt(
            Ortsbaum baum, OrtArt art, String eltern, String name, LocalDate tag, String ausser) {
        String schluessel = namensSchluessel(name);
        return baum.orte().stream()
                .filter(x -> !x.kennzeichen().equals(ausser)
                        && x.art() == art
                        && intervallAm(x.intervalle(), tag) != null
                        && Objects.equals(elternAm(x.intervalle(), tag), eltern)
                        && namensSchluessel(x.name()).equals(schluessel))
                .findFirst();
    }

    /** Der Satz aus §5.10 zu einem belegten Namen, mit dem Weg zum vorhandenen Ort. */
    public static String nameBelegtSatz(Ort belegt) {
        return "Diesen Namen gibt es hier schon: " + belegt.name() + " (" + belegt.kennzeichen()
                + "). Wählen Sie einen anderen Namen — oder öffnen Sie " + belegt.name() + ".";
    }

    /**
     * Ein NEUES Intervall ab dem Tag am alten Elternknoten; die Lücke bleibt; der
     * Name muss unter den Geschwistern derselben Art frei sein (ohne Groß-/
     * Kleinschreibung und Randleerzeichen). Mitarchivierte Kinder kommen nicht
     * still mit zurück.
     */
    public static WiederherstellErgebnis wiederherstellen(
            Ortsbaum baum, String objekt, LocalDate tag, String neuerName) {
        Ort o = baum.ort(objekt).orElseThrow(() -> new IllegalArgumentException("unbekannter Ort: " + objekt));
        List<Intervall> liste = wirksam(o.intervalle());
        if (liste.isEmpty() || liste.stream().anyMatch(i -> i.bis() == null || !i.bis().isBefore(tag))) {
            return WiederherstellErgebnis.nein(
                    WiederherstellGrund.NICHT_ARCHIVIERT, o.name() + " ist nicht archiviert.");
        }
        Intervall letzte = liste.get(liste.size() - 1);
        String eltern = letzte.eltern();
        if (eltern != null && !vorhanden(baum, eltern, tag)) {
            return WiederherstellErgebnis.nein(
                    WiederherstellGrund.ELTERN_ARCHIVIERT,
                    o.name() + " kann erst wiederhergestellt werden, wenn " + elternName(baum, eltern)
                            + " wiederhergestellt ist.");
        }
        String name = (neuerName == null ? o.name() : neuerName).strip();
        Optional<Ort> belegt = nameBelegt(baum, o.art(), eltern, name, tag, objekt);
        if (belegt.isPresent()) {
            return WiederherstellErgebnis.nein(WiederherstellGrund.NAME_BELEGT, nameBelegtSatz(belegt.get()));
        }
        LocalDate von = letzte.bis().plusDays(1);
        LocalDate bis = tag.minusDays(1);
        return new WiederherstellErgebnis(
                true, null, null, new NeuesIntervall(tag, null, eltern), name,
                von.isAfter(bis) ? null : new Zeitraum(von, bis));
    }

    public record LoeschErgebnis(boolean erlaubt, List<LoeschGrund> gruende) {}

    /** E1: Löschen nur ohne JE eine Messstelle, Anlage (am Standort), Fläche oder ein Kind. */
    public static LoeschErgebnis loeschen(Ortsbaum baum, String objekt) {
        Ort o = baum.ort(objekt).orElseThrow(() -> new IllegalArgumentException("unbekannter Ort: " + objekt));
        Predicate<List<Intervall>> hing =
                liste -> liste.stream().anyMatch(i -> objekt.equals(i.eltern()));
        List<LoeschGrund> gruende = new ArrayList<>();
        if (baum.messstellen().stream().anyMatch(m -> hing.test(m.zuordnungen()))) {
            gruende.add(LoeschGrund.HAT_MESSSTELLEN);
        }
        if (o.art() == OrtArt.STANDORT && baum.anlagen().stream().anyMatch(a -> hing.test(a.zuordnungen()))) {
            gruende.add(LoeschGrund.HAT_ANLAGEN);
        }
        if (!o.flaechen().isEmpty()) {
            gruende.add(LoeschGrund.HAT_FLAECHE);
        }
        if (baum.orte().stream().anyMatch(x -> hing.test(x.intervalle()))) {
            gruende.add(LoeschGrund.HAT_KINDER);
        }
        return new LoeschErgebnis(gruende.isEmpty(), gruende);
    }

    // -------------------------------------------------------- Zeitraum-Teilung

    /**
     * {@code beginn}: 00:00 Uhr am ersten Tag in der Zeitzone des Standorts
     * (ohne Standort: des Unternehmens); {@code ende}: 00:00 Uhr am Tag nach dem
     * letzten — ausschließlich. {@code grund} sagt, warum ein Teil keinen
     * Standort hat.
     */
    public record Teil(
            LocalDate von,
            LocalDate bis,
            String standort,
            TeilGrund grund,
            String beginn,
            String ende,
            long stunden) {}

    private record StandortAmTag(String standort, TeilGrund grund) {}

    private static StandortAmTag standortAm(Ortsbaum baum, String objekt, LocalDate tag) {
        Optional<Ort> o = baum.ort(objekt);
        if (o.isPresent()) {
            Bestand b = bestand(o.get().intervalle(), tag);
            if (b != Bestand.VORHANDEN) {
                return new StandortAmTag(null, TeilGrund.valueOf(b.name()));
            }
            String st = pfadAm(baum, objekt, tag).standort();
            return st == null
                    ? new StandortAmTag(null, TeilGrund.ORT_NICHT_IM_BAUM)
                    : new StandortAmTag(st, null);
        }
        Verortung v = verortung(baum, objekt, tag);
        return v.grund() == VerortungGrund.VERORTET
                ? new StandortAmTag(v.standort(), null)
                : new StandortAmTag(null, TeilGrund.valueOf(v.grund().name()));
    }

    /**
     * Regel 5: ein Zeitraum wird TAGESGENAU an jedem Wechsel des Standorts
     * geteilt (Februar → alter, März → neuer Standort). Ein Ortswechsel
     * innerhalb des Standorts teilt nicht; eine Lücke ist ein eigener Teil ohne
     * Standort.
     */
    public static List<Teil> teile(Ortsbaum baum, String objekt, LocalDate von, LocalDate bis) {
        List<LocalDate[]> laeufe = new ArrayList<>();
        List<StandortAmTag> werte = new ArrayList<>();
        for (LocalDate tag = von; !tag.isAfter(bis); tag = tag.plusDays(1)) {
            StandortAmTag s = standortAm(baum, objekt, tag);
            if (!werte.isEmpty() && werte.get(werte.size() - 1).equals(s)) {
                laeufe.get(laeufe.size() - 1)[1] = tag;
            } else {
                laeufe.add(new LocalDate[] {tag, tag});
                werte.add(s);
            }
        }
        List<Teil> out = new ArrayList<>();
        for (int k = 0; k < laeufe.size(); k++) {
            StandortAmTag s = werte.get(k);
            ZoneId zone = zeitzoneVon(baum, s.standort());
            ZonedDateTime beginn = laeufe.get(k)[0].atStartOfDay(zone);
            ZonedDateTime ende = laeufe.get(k)[1].plusDays(1).atStartOfDay(zone);
            out.add(new Teil(
                    laeufe.get(k)[0],
                    laeufe.get(k)[1],
                    s.standort(),
                    s.grund(),
                    ZEITPUNKT.format(beginn),
                    ZEITPUNKT.format(ende),
                    Duration.between(beginn, ende).toHours()));
        }
        return out;
    }
}
