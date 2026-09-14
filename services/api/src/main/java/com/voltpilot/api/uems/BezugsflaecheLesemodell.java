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
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Die Bezugsflächen als Bezugsgrößen (UEMS AP-09 IP-6, E17): GELESEN aus der Ortsstruktur
 * ({@code flaeche_gueltigkeit}, AP-02), nie kopiert und nie hier geschrieben.
 *
 * <p><b>Eine Wahrheit.</b> Wer die Hallenfläche einmal an Halle 2 einträgt, sieht sie hier sofort —
 * es gibt keine zweite Zeile, die auseinanderlaufen könnte. Darum hat eine Bezugsfläche keine ID und
 * kein Kennzeichen einer Bezugsgröße, und {@code schreibbar} ist {@code false}: geändert wird sie am
 * Gebäude ({@code PUT /api/v1/orte/{id}/flaeche}).
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
            List<Intervall> intervalle = teile.stream()
                    .filter(t -> t.flaecheM2() != null)
                    .map(t -> new Intervall(BigDecimal.valueOf(t.flaecheM2()), t.von(), t.bis(), null))
                    .toList();
            Stammdatenstand stand = BezugsdatenRegeln.stammdatum(intervalle, perioden, periodeArt, BEZEICHNUNG, EINHEIT);
            List<BezugsgroesseDto.Stichtagwert> werte = new ArrayList<>();
            for (String p : perioden) {
                LocalDate stichtag = stand.stichtage().get(p);
                FlaechenTeil teil = teile.stream()
                        .filter(t -> !stichtag.isBefore(t.von()) && !stichtag.isAfter(t.bis()))
                        .findFirst()
                        .orElse(null);
                FlaecheRepository.Flaeche eigene = teil != null && teil.flaecheQuelle() == OrtsbaumAbleitung.FlaecheQuelle.EIGEN
                        ? eigeneAm(z, o.id(), stichtag)
                        : null;
                String abzeichen = null;
                LocalDate eingetragen = null;
                if (eigene != null && eigene.createdAt() != null) {
                    ZoneId zone = zone(baum, o.id(), stichtag);
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
            aus.add(new BezugsgroesseDto.BezugsflaecheWerte(o.darstellung(), werte));
        }
        return new BezugsgroesseDto.Bezugsflaechen(periodeArt, von, bis, aus);
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
