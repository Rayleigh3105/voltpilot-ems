package com.voltpilot.api.uems;

import com.voltpilot.api.uems.BezugsdatenRegeln.Intervall;
import com.voltpilot.api.uems.BezugsdatenRegeln.Stammdatenstand;
import com.voltpilot.api.uems.BezugsgroesseRegeln.Ablehnung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.FlaechenTeil;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.StandortLesemodell.Zeilen;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die Bezugsflächen als Bezugsgrößen (UEMS AP-09 IP-6, E17): GELESEN aus der Ortsstruktur
 * ({@code flaeche_gueltigkeit}, AP-02), nie kopiert und nie hier geschrieben.
 *
 * <p><b>Eine Wahrheit.</b> Wer die Hallenfläche einmal an Halle 2 einträgt, sieht sie hier sofort —
 * es gibt keine zweite Zeile, die auseinanderlaufen könnte. Darum trägt eine Bezugsfläche in der Liste
 * keine ID und kein Kennzeichen einer Bezugsgröße, und {@code schreibbar} ist {@code false}: geändert
 * wird sie am Gebäude ({@code PUT /api/v1/orte/{id}/flaeche}).
 *
 * <p><b>Als NENNER einer Kennzahl</b> (AP-11 §5.1) bekommt sie eine Bezugsgröße als ZEIGER — Wertart
 * {@code stammdatum}, Einheit m², Geltungsbereich der Ort, ohne eine einzige eigene Wert-Zeile. Auch
 * dann kommt jede Zahl von hier ({@link #stammdatum}); die Zeile sagt nur, WELCHE Fläche gemeint ist.
 *
 * <p><b>Keine zweite Regel-Logik.</b> Welche Fläche an welchem Tag gilt (eigene oder aus den Gebäuden
 * summiert, ob der Ort an dem Tag besteht), sagt {@link OrtsbaumAbleitung#flaecheZeitraum} am Baum
 * des Standort-Lesemodells; den Wert am Stichtag und die Übergänge in der Periode (S3) sagt
 * {@link BezugsdatenRegeln#stammdatum}; das Abzeichen „rückwirkend (n Tage)“ sagt
 * {@link OrtsbaumAbleitung#rueckwirkung}. Hier steht nur, wie die drei zusammengesteckt werden.
 *
 * <p>⚠ Eine Periode ohne gültige Fläche am Stichtag hat {@code betrag} {@code null} — nie 0.
 */
@Service
public class BezugsflaecheLesemodell {

    /** Wie die Fläche im Kennzeichen-Satz heißt (S3: „Fläche geändert am …“). */
    static final String BEZEICHNUNG = "Fläche";

    /** Der Name einer Bezugsfläche als Bezugsgröße — BZ-4 „Bezugsfläche“ des Referenzunternehmens. */
    static final String NAME = "Bezugsfläche";

    static final String EINHEIT = "m²";

    static final String HERKUNFT = "stammdatum_ap02";

    /** Nur, um „heute“ überhaupt zu fragen — die wirkliche Zone kommt danach vom Standort des Objekts (Regel 11). */
    private static final ZoneId VORGABE_ZONE = ZoneId.of("Europe/Berlin");

    private final StandortLesemodellService lesemodell;
    private final BezugsgroesseRepository bezugsgroessen;

    public BezugsflaecheLesemodell(StandortLesemodellService lesemodell, BezugsgroesseRepository bezugsgroessen) {
        this.lesemodell = lesemodell;
        this.bezugsgroessen = bezugsgroessen;
    }

    /** Die Bezugsflächen ohne Werte — für die Liste der Bezugsgrößen. */
    public List<BezugsgroesseDto.Bezugsflaeche> alle() {
        return objekte(lesemodell.zeilen()).stream().map(Objekt::darstellung).toList();
    }

    /** Ein Objekt der Ortsstruktur mit einer Bezugsfläche — das Ziel eines Kennzahl-Nenners. */
    public record Ziel(UUID id, String art, String kurzzeichen, String name) {}

    /**
     * Das Objekt, das dieses Kurzzeichen trägt UND eine Bezugsfläche hat — leer, wenn es keines gibt („nicht erhoben“
     * ist keine Bezugsfläche). Kurzzeichen sind im Kundenbereich je Art eindeutig; der Standort geht vor (AP-02 §4.1).
     */
    public Optional<Ziel> ziel(String kurzzeichen) {
        return objekte(lesemodell.zeilen()).stream()
                .filter(o -> kurzzeichen != null && kurzzeichen.equals(o.kurzzeichen()))
                .findFirst()
                .map(o -> new Ziel(o.id(), o.art(), o.kurzzeichen(), o.name()));
    }

    /**
     * Jede Bezugsfläche mit ihrem Wert je Periode am Stichtag. {@code von}/{@code bis} sind Tage; gefragt sind
     * alle Perioden der Art, die den Zeitraum berühren.
     */
    public BezugsgroesseDto.Bezugsflaechen werte(String periodeArt, LocalDate von, LocalDate bis) {
        List<String> perioden = perioden(periodeArt, von, bis, bezugsgroessen.vokabular().periodeArten());
        LocalDate erster = BezugsPeriode.spanneVon(perioden.get(0), periodeArt)[0];
        LocalDate letzter = BezugsPeriode.spanneVon(perioden.get(perioden.size() - 1), periodeArt)[1];
        Zeilen z = lesemodell.zeilen();
        Ortsbaum baum = StandortLesemodell.baum(z);
        List<BezugsgroesseDto.BezugsflaecheWerte> aus = new ArrayList<>();
        for (Objekt o : objekte(z)) {
            List<FlaechenTeil> teile = OrtsbaumAbleitung.flaecheZeitraum(baum, o.id().toString(), erster, letzter);
            List<Intervall> intervalle = intervalle(teile);
            Stammdatenstand stand = BezugsdatenRegeln.stammdatum(intervalle, perioden, periodeArt, BEZEICHNUNG, EINHEIT);
            aus.add(new BezugsgroesseDto.BezugsflaecheWerte(o.darstellung(),
                    stichtagwerte(z, baum, o.id(), teile, stand, perioden, periodeArt)));
        }
        return new BezugsgroesseDto.Bezugsflaechen(periodeArt, von, bis, aus);
    }

    /** Die Flächen-Teile mit einer Fläche als Intervalle der Bezugsdaten-Regel — ein Teil ohne Fläche ist keine Zeile. */
    private static List<Intervall> intervalle(List<FlaechenTeil> teile) {
        return teile.stream()
                .filter(t -> t.flaecheM2() != null)
                .map(t -> new Intervall(BigDecimal.valueOf(t.flaecheM2()), t.von(), t.bis(), null))
                .toList();
    }

    /** Der Wert je Periode am Stichtag mit Quelle, Eintragstag und Abzeichen — die EINE Stelle (werte und stammdatum). */
    private List<BezugsgroesseDto.Stichtagwert> stichtagwerte(Zeilen z, Ortsbaum baum, UUID objekt,
            List<FlaechenTeil> teile, Stammdatenstand stand, List<String> perioden, String periodeArt) {
        List<BezugsgroesseDto.Stichtagwert> werte = new ArrayList<>();
        for (String p : perioden) {
            LocalDate stichtag = stand.stichtage().get(p);
            FlaechenTeil teil = teile.stream()
                    .filter(t -> !stichtag.isBefore(t.von()) && !stichtag.isAfter(t.bis()))
                    .findFirst()
                    .orElse(null);
            FlaecheRepository.Flaeche eigene = teil != null && teil.flaecheQuelle() == OrtsbaumAbleitung.FlaecheQuelle.EIGEN
                    ? eigeneAm(z, objekt, stichtag)
                    : null;
            String abzeichen = null;
            LocalDate eingetragen = null;
            if (eigene != null && eigene.createdAt() != null) {
                ZoneId zone = zone(baum, objekt, stichtag);
                OrtsbaumAbleitung.RueckwirkungErgebnis r = OrtsbaumAbleitung.rueckwirkung(
                        new OrtsbaumAbleitung.RueckwirkungEingang(eigene.createdAt().atZone(zone).toOffsetDateTime(),
                                eigene.gueltigAb(), eigene.gueltigBis(), zone, null));
                abzeichen = r.abzeichen();
                eingetragen = r.eintragstag();
            }
            BigDecimal betrag = stand.jePeriode().get(p);
            werte.add(new BezugsgroesseDto.Stichtagwert(p, BezugsPeriode.spanneVon(p, periodeArt)[0], stichtag,
                    betrag == null ? null : betrag.toPlainString(),
                    betrag == null || teil.flaecheQuelle() == null ? null : teil.flaecheQuelle().name().toLowerCase(Locale.ROOT),
                    eigene == null ? null : eigene.gueltigAb(), eingetragen, abzeichen, stand.kennzeichen().get(p)));
        }
        return werte;
    }

    // ------------------------------------------------------------ die Fläche EINES Objekts als Stammdatum (Nenner)

    /**
     * Die Bezugsfläche EINES Objekts (Standort, Gebäude, Bereich) in der Form eines Stammdatums — der Leseweg, über den
     * eine Kennzahl eine Fläche als NENNER liest (AP-11 §5.1 „Netzbezug je m²“).
     *
     * <p>Gelesen wird ausschließlich die Ortsstruktur: {@link OrtsbaumAbleitung#flaecheZeitraum} sagt, welche Fläche an
     * welchem Tag gilt (eigen oder aus den Gebäuden summiert), {@link BezugsdatenRegeln#stammdatum} den Wert am Stichtag
     * (letzter Tag der Periode, E17) und die Übergänge IN der Periode (S3). Es entsteht keine Zeile — die Fläche bleibt
     * dort, wo sie gepflegt wird ({@code PUT /api/v1/orte/{id}/flaeche}).
     *
     * @param bezugsgroesse die Bezugsgröße, die als Zeiger auf diese Fläche gebunden ist ({@code null}: noch keine)
     * @param periodeArt {@code null} (und {@code von}/{@code bis} leer) = nur die Intervalle, ohne Werte je Periode
     */
    public BezugsgroesseDto.Stammdatum stammdatum(UUID objekt, UUID bezugsgroesse, String kennzeichen,
            String periodeArt, LocalDate von, LocalDate bis) {
        boolean mitPerioden = periodeArt != null || von != null || bis != null;
        List<String> perioden = mitPerioden
                ? perioden(periodeArt, von, bis, bezugsgroessen.vokabular().periodeArten())
                : List.of();
        Zeilen z = lesemodell.zeilen();
        Ortsbaum baum = StandortLesemodell.baum(z);
        ZoneId zone = zone(baum, objekt, LocalDate.now(VORGABE_ZONE));
        LocalDate heute = LocalDate.now(zone);
        LocalDate[] fenster = fenster(z, perioden, periodeArt, heute);
        List<FlaechenTeil> teile = OrtsbaumAbleitung.flaecheZeitraum(baum, objekt.toString(), fenster[0], fenster[1]);
        boolean offen = OrtsbaumAbleitung.flaecheAm(baum, objekt.toString(), fenster[1].plusYears(20)).flaecheM2() != null;
        List<BezugsgroesseDto.StammdatumIntervall> intervalle = new ArrayList<>();
        List<FlaechenTeil> mitFlaeche = teile.stream().filter(t -> t.flaecheM2() != null).toList();
        for (int i = 0; i < mitFlaeche.size(); i++) {
            FlaechenTeil t = mitFlaeche.get(i);
            // Nur der letzte Teil kann offen sein — und nur, wenn das Fenster ihn abschneidet, nicht die Gültigkeit.
            boolean letzter = i == mitFlaeche.size() - 1 && t.bis().equals(fenster[1]) && offen;
            FlaecheRepository.Flaeche eigene = t.flaecheQuelle() == OrtsbaumAbleitung.FlaecheQuelle.EIGEN
                    ? eigeneAm(z, objekt, t.von()) : null;
            String abzeichen = null;
            LocalDate eingetragen = null;
            if (eigene != null && eigene.createdAt() != null) {
                OrtsbaumAbleitung.RueckwirkungErgebnis r = OrtsbaumAbleitung.rueckwirkung(
                        new OrtsbaumAbleitung.RueckwirkungEingang(eigene.createdAt().atZone(zone).toOffsetDateTime(),
                                eigene.gueltigAb(), eigene.gueltigBis(), zone, null));
                abzeichen = r.abzeichen();
                eingetragen = r.eintragstag();
            }
            intervalle.add(new BezugsgroesseDto.StammdatumIntervall(String.valueOf(t.flaecheM2()), t.von(),
                    letzter ? null : t.bis(), null,
                    eingetragen == null ? null : eingetragen.atStartOfDay(zone).toOffsetDateTime(), abzeichen));

        }
        Stammdatenstand stand = perioden.isEmpty() ? null
                : BezugsdatenRegeln.stammdatum(intervalle(teile), perioden, periodeArt, BEZEICHNUNG, EINHEIT);
        List<BezugsgroesseDto.Stichtagwert> werte = stand == null ? List.of()
                : stichtagwerte(z, baum, objekt, teile, stand, perioden, periodeArt);
        return new BezugsgroesseDto.Stammdatum(bezugsgroesse, kennzeichen, NAME, EINHEIT,
                zone.getId(), false, List.copyOf(intervalle),
                perioden.isEmpty() ? null : periodeArt, von, bis, werte);
    }

    /**
     * Das Fenster, über das die Ortsstruktur gelesen wird: die gefragten Perioden — sonst vom ersten Tag, an dem im
     * Kundenbereich je eine Fläche galt, bis heute. {@link OrtsbaumAbleitung#flaecheZeitraum} geht Tag für Tag; ein
     * offenes Fenster wäre kein Lesemodell, sondern eine Endlosschleife.
     */
    private static LocalDate[] fenster(Zeilen z, List<String> perioden, String periodeArt, LocalDate heute) {
        if (!perioden.isEmpty()) {
            return new LocalDate[] {BezugsPeriode.spanneVon(perioden.get(0), periodeArt)[0],
                    BezugsPeriode.spanneVon(perioden.get(perioden.size() - 1), periodeArt)[1]};
        }
        LocalDate erster = heute;
        LocalDate letzter = heute;
        for (FlaecheRepository.Flaeche f : z.flaechen()) {
            if (f.aufgehoben()) {
                continue;
            }
            erster = f.gueltigAb().isBefore(erster) ? f.gueltigAb() : erster;
            letzter = f.gueltigBis() != null && f.gueltigBis().isAfter(letzter) ? f.gueltigBis() : letzter;
        }
        return new LocalDate[] {erster, letzter};
    }

    /**
     * Die Perioden der Art {@code periodeArt}, die den Zeitraum {@code [von, bis]} berühren — in ihrer
     * Reihenfolge. Die Grenzen der Perioden kommen aus {@link BezugsPeriode}; hier wird nur weitergezählt.
     */
    static List<String> perioden(String periodeArt, LocalDate von, LocalDate bis, List<String> periodeArten) {
        if (periodeArt == null) {
            throw BezugsgroesseAbgelehnt.anfrage("periode_art");
        }
        if (!periodeArten.contains(periodeArt)) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("feld", "periode_art");
            fakten.put("erlaubt", List.copyOf(periodeArten));
            throw new BezugsgroesseAbgelehnt(Ablehnung.WORT_UNBEKANNT, fakten);
        }
        if (von == null) {
            throw BezugsgroesseAbgelehnt.anfrage("von");
        }
        if (bis == null) {
            throw BezugsgroesseAbgelehnt.anfrage("bis");
        }
        if (bis.isBefore(von)) {
            throw BezugsgroesseAbgelehnt.von(Ablehnung.ZEITRAUM_UNGUELTIG);
        }
        List<String> aus = new ArrayList<>();
        LocalDate tag = von;
        while (!tag.isAfter(bis)) {
            String schluessel = BezugsPeriode.schluesselVon(tag, periodeArt);
            aus.add(schluessel);
            tag = BezugsPeriode.spanneVon(schluessel, periodeArt)[1].plusDays(1);
        }
        return List.copyOf(aus);
    }

    // ----------------------------------------------------------------------------- Gerüst

    private record Objekt(UUID id, String art, String kurzzeichen, String name) {

        BezugsgroesseDto.Bezugsflaeche darstellung() {
            return new BezugsgroesseDto.Bezugsflaeche(NAME, BezugsgroesseRegeln.STAMMDATUM, EINHEIT, HERKUNFT, art, id,
                    kurzzeichen, name, false, Ablehnung.FLAECHE_AUS_STRUKTUR.satz());
        }
    }

    /**
     * Die Objekte, die eine Bezugsfläche haben KÖNNEN: jedes mit einer eigenen (nicht aufgehobenen) Fläche,
     * und jeder Standort, an dem je ein Gebäude mit Fläche hing (die Summe der Gebäude, AP-02 §4.1/A4). Ein
     * Objekt ohne jede Fläche ist keine Bezugsfläche — „nicht erhoben“ ist keine Zeile.
     */
    private static List<Objekt> objekte(Zeilen z) {
        Set<UUID> mitFlaeche = new HashSet<>();
        for (FlaecheRepository.Flaeche f : z.flaechen()) {
            if (!f.aufgehoben()) {
                mitFlaeche.add(f.standortId() != null ? f.standortId() : f.ortId());
            }
        }
        Set<UUID> standorteMitGebaeudeflaeche = new HashSet<>();
        for (OrtZuordnungRepository.Zuordnung iv : z.ortZuordnungen()) {
            if (!iv.aufgehoben() && iv.elternStandortId() != null && mitFlaeche.contains(iv.ortId())) {
                standorteMitGebaeudeflaeche.add(iv.elternStandortId());
            }
        }
        List<Objekt> aus = new ArrayList<>();
        for (StandortRepository.Standort s : z.standorte()) {
            if (mitFlaeche.contains(s.id()) || standorteMitGebaeudeflaeche.contains(s.id())) {
                aus.add(new Objekt(s.id(), "standort", s.kurzzeichen(), s.name()));
            }
        }
        for (OrtRepository.Ort o : z.orte()) {
            if (mitFlaeche.contains(o.id())) {
                aus.add(new Objekt(o.id(), o.art(), o.kurzzeichen(), o.name()));
            }
        }
        List<String> rang = List.of("standort", "gebaeude", "bereich");
        aus.sort(Comparator.comparingInt((Objekt o) -> rang.indexOf(o.art()))
                .thenComparing(o -> o.kurzzeichen() == null ? "" : o.kurzzeichen())
                .thenComparing(Objekt::id));
        return aus;
    }

    /** Die eigene, nicht aufgehobene Fläche des Objekts, die am Tag gilt. */
    private static FlaecheRepository.Flaeche eigeneAm(Zeilen z, UUID objekt, LocalDate tag) {
        return z.flaechen().stream()
                .filter(f -> !f.aufgehoben() && (objekt.equals(f.standortId()) || objekt.equals(f.ortId())))
                .filter(f -> !tag.isBefore(f.gueltigAb()) && (f.gueltigBis() == null || !tag.isAfter(f.gueltigBis())))
                .findFirst()
                .orElse(null);
    }

    /** Die Zeitzone des Standorts, an dem das Objekt am Tag hängt (Regel 11) — sonst die des Unternehmens. */
    private static ZoneId zone(Ortsbaum baum, UUID objekt, LocalDate tag) {
        String standort = OrtsbaumAbleitung.teile(baum, objekt.toString(), tag, tag).get(0).standort();
        return OrtsbaumAbleitung.zeitzoneVon(baum, standort);
    }
}
