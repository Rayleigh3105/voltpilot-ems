package com.voltpilot.api.uems;

import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRegeln.Groesse;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Bestand;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Fakt;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Messwert;
import com.voltpilot.api.uems.MessstelleRegisterRepository.QuelleZeile;
import com.voltpilot.api.uems.MessstelleRegisterRepository.Werte;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.OrtZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import com.voltpilot.api.uems.OrtsbaumAbleitung.ObjektZustand;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Verortung;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.Predicate;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Das Messstellen-Register (UEMS AP-04 IP-4, §5.16): {@code GET /api/v1/messstellen} mit Zeilen zum
 * Stichtag — Ort mit abgeleitetem Standort, elektrische Stellung, Quelle der Hauptgröße (Gerät ·
 * Messwert · seit, „davor …“), Lebenszyklus — und den Filtern Standort · Ort (mit Teilbaum) ·
 * Anlage · Zustand · ohne Quelle.
 *
 * <p><b>Lesezüge.</b> Alles über die Messstellen kommt aus EINER Abfrage
 * ({@link MessstelleRegisterRepository}); der Ortsbaum zum Stichtag aus dem Lesezug des
 * Standort-Lesemodells ({@link StandortService#baum}) — eine feste Zahl, gleich wie viele
 * Messstellen es gibt. Dazu EIN weiterer Zug für die Werte
 * ({@link MessstelleRegisterRepository#werte}) — er bekommt alle Messwerte auf einmal als Feld
 * und rührt keine Messstellen-Tabelle an. Alles in einer Lese-Transaktion.
 *
 * <p><b>Keine zweite Ableitung.</b> Der Standort einer Messstelle ist {@link OrtsbaumAbleitung#verortung}
 * (dieselbe wie {@code …/{id}/standort?am=}), ob eine Bindung zum Zeitpunkt läuft
 * {@link MessstelleQuelleService#gilt} (dieselbe wie {@code …/{id}/quellen?stichtag=}), der
 * Lebenszyklus der der Messstellen-Antwort ({@link MessstelleService#darstellung}), der Name des
 * Messwerts der des Messkanal-Read-Models ({@link MesskanalService#anzeigename}).
 *
 * <p><b>Die Beobachtung (IP-15)</b> steht je Größe: {@code beobachtung} und {@code letzter_wert}
 * gelten der Hauptgröße, {@code nebengroessen} nennt dasselbe je Nebengröße — jede über ihre
 * EIGENE führende Bindung zum Zeitpunkt. Welcher der vier Zustände gilt, entscheidet allein
 * {@link ZustandAbleitung#liefertDaten} ({@link MessstelleBeobachtung} sammelt nur die Eingänge);
 * {@code aggregat} zählt „x von y Messstellen liefern Daten“ über
 * {@link ZustandAbleitung#aggregatLiefertDaten}. ⚠ Die Toleranz ist 3 × Kadenz (Boden 300 s,
 * Deckel 1 Tag); 2 × Kadenz ist die LÜCKE — eine andere Aussage, die hier nicht vorkommt (AP-07
 * IP-9).
 *
 * <p><b>Was noch nicht da ist, ist {@code null}:</b> die Beobachtung einer berechneten Messstelle (sie
 * hat keine Quelle; ihre Vollständigkeit steht seit AP-10 IP-9 in {@code berechnung}), Prozesse und
 * Kostenstellen (ihre Objekte fehlen),
 * {@code teilansicht} ist {@code false} bis AP-03.
 */
@Service
public class MessstelleRegisterService {

    /** Die Wörter von {@code quelle.stand}. */
    public static final String GEBUNDEN = "gebunden";
    public static final String BERECHNET = "berechnet";
    public static final String ABLESUNG = "ablesung";
    public static final String KEINE_DATENQUELLE = "keine_datenquelle";

    private static final String FUEHREND = "fuehrend";
    private static final String VERGLEICH = "vergleich";

    /**
     * Die Filter; {@code null} = keiner. {@code standort} und {@code ort} sind ein Kurzzeichen oder
     * eine ID (Standort, Gebäude, Bereich); {@code ort} schließt den Teilbaum ein, {@code U} ist das
     * Unternehmen (die Messstellen direkt an ihm). {@code zustand} ist ein Wort des Lebenszyklus.
     * {@code ohneQuelle} findet die gemessenen ohne führende Quelle zum Zeitpunkt — die berechneten
     * haben keine und sind deshalb nicht „ohne Quelle“.
     */
    public record Filter(String standort, String ort, UUID anlage, String zustand, boolean ohneQuelle,
            boolean geplantFuerEinsatz) {

        public static final Filter KEINER = new Filter(null, null, null, null, false, false);
    }

    private final MessstelleRegisterRepository register;
    private final MessstelleService messstellen;
    private final StandortService standorte;
    private final MesskanalService kanaele;
    private final QuelleKadenzRepository kadenzen;
    private final BilanzRestRepository reste;
    private final MessstelleFormelTermRepository formelTerme;
    private final MessbedarfRepository messbedarfe;
    private final MessstelleWerteService werte;
    private volatile Clock uhr = Clock.systemUTC();

    public MessstelleRegisterService(MessstelleRegisterRepository register, MessstelleService messstellen,
            StandortService standorte, MesskanalService kanaele, QuelleKadenzRepository kadenzen,
            BilanzRestRepository reste, MessstelleFormelTermRepository formelTerme,
            MessbedarfRepository messbedarfe, MessstelleWerteService werte) {
        this.register = register;
        this.messstellen = messstellen;
        this.standorte = standorte;
        this.kanaele = kanaele;
        this.kadenzen = kadenzen;
        this.reste = reste;
        this.formelTerme = formelTerme;
        this.messbedarfe = messbedarfe;
        this.werte = werte;
    }

    /** Nur für Tests: die Uhr, an der „ohne Stichtag = jetzt“ hängt. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /**
     * Das Register zum Zeitpunkt {@code am} ({@code null} = jetzt): Ort und Stellung gelten an
     * dessen Tag (Europe/Berlin — alle zulässigen Zeitzonen haben dieselben Regeln), die Quelle
     * genau zu ihm.
     */
    @Transactional(readOnly = true)
    public MessstelleDto.Liste liste(Instant am, Filter filter) {
        return liste(am, filter, id -> true, komponente -> true, null);
    }

    /**
     * Die Liste der Route: nur Messstellen, die {@code sichtbar} zulässt — sie fehlen in beiden Listen und im Aggregat,
     * ohne Hinweis und ohne Anzahl. Als Eingang einer sichtbaren berechneten Messstelle nennt {@code berechnung} sie
     * nicht, ebenso wenig den Messkanal einer Komponente, die {@code komponenteSichtbar} nicht zulässt
     * ({@link RegisterBerechnung#ableiten}, AP-03 R-A3/R-A6). Interne Leser (Standort-Übersicht, Ausfall) nehmen
     * {@link #liste(Instant, Filter)}.
     *
     * <p><b>Der letzte vollständige Monat (Messen PR5):</b> mit {@code letzterMonat} ≠ {@code null} trägt jede Zeile der
     * Antwort ({@code letzter_monat}) den Monat vor dem Monat des Zeitpunkts in der Zone ihres Standorts und seinen Wert
     * aus dem Lese-Modell „Werte je Messstelle“ ({@link MessstelleWerteService#monatswert}) - dieselbe Regel wie
     * {@code …/werte?raster=monat}, keine zweite; {@code letzterMonat} ist dessen Zaun über die Eingänge einer berechneten
     * Messstelle. ⚠ Das kostet einen Lesezug JE gezeigter Messstelle (der Rest des Registers bleibt eine feste Zahl) -
     * darum nur auf Verlangen der Route ({@code letzterMonat=true}), nie für die Leser im Haus.
     */
    public MessstelleDto.Liste liste(Instant am, Filter filter, Predicate<UUID> sichtbar,
            Predicate<UUID> komponenteSichtbar, MessstelleWerteService.EingaengeImZugriff letzterMonat) {
        Instant zeitpunkt = am != null ? am : uhr.instant();
        LocalDate tag = LocalDate.ofInstant(zeitpunkt, MessstelleService.ZEITZONE);
        List<Bestand> bestand = register.alle();
        if (bestand.isEmpty()) {
            return new MessstelleDto.Liste(List.of(), List.of(), tag, MessstelleService.zeit(zeitpunkt), false,
                    aggregat(List.of()));
        }
        List<MessstelleDto.Messstelle> voll = bestand.stream()
                .map(b -> messstellen.darstellung(b.messstelle(), b.nebengroessen(), b.orte(), b.stellungen(),
                        quellen(b)))
                .toList();
        List<OrtsbaumAbleitung.Messstelle> imBaum = new ArrayList<>();
        for (int i = 0; i < bestand.size(); i++) {
            imBaum.add(imBaum(bestand.get(i), voll.get(i), tag));
        }
        StandortService.Baum baum = standorte.baum(imBaum);
        Map<UUID, String> anlagen = baum.zeilen().anlagen().stream()
                .collect(Collectors.toMap(StandortLesemodell.Anlage::id, StandortLesemodell.Anlage::name));
        // AP-10 IP-9: die Eingänge der berechneten Messstellen am Tag — Messkanal-Terme reisen im selben Werte-Zug.
        RegisterBerechnung.Plan plan = RegisterBerechnung.planen(bestand, tag, reste, formelTerme);
        Set<Messwert> gefragt = messwerte(bestand, zeitpunkt);
        gefragt.addAll(plan.kanaele());
        Map<Messwert, Werte> werte = register.werte(gefragt, zeitpunkt);
        // ⚠ ZUM ZEITPUNKT, nie „jetzt": die Kadenz ist seit AP-07 IP-10 eine Tatsache mit
        // Geschichte, und ein alter Stichtag sieht die alte Erwartung.
        Map<UUID, Integer> fassungen = kadenzen.jeBindung(bindungen(bestand, zeitpunkt), zeitpunkt);
        Auswahl auswahl = Auswahl.aus(filter, baum);
        Map<UUID, List<MessbedarfRepository.Planung>> planungen = messbedarfe.planungenJeMessstelle();
        Map<UUID, MessstelleRegisterRepository.Ablesung> ablesungen = register.ablesungen(zeitpunkt);
        List<MessstelleDto.Messstelle> messstellenListe = new ArrayList<>();
        List<MessstelleDto.RegisterZeile> zeilen = new ArrayList<>();
        Map<UUID, MessstelleDto.RegisterZeile> alle = new LinkedHashMap<>();
        for (int i = 0; i < bestand.size(); i++) {
            MessstelleDto.RegisterZeile z = zeile(bestand.get(i), voll.get(i), baum, anlagen, tag,
                    zeitpunkt, werte, fassungen, ablesungen.get(bestand.get(i).messstelle().id()));
            alle.put(bestand.get(i).messstelle().id(), mitPlanungen(z,
                    planungen.getOrDefault(z.id(), List.of())));
        }
        Map<UUID, MessstelleDto.RegisterBerechnung> berechnungen = RegisterBerechnung.ableiten(plan, alle, werte,
                m -> kanaele.kadenz(m.kanal(), werte.get(m) == null ? null : werte.get(m).kadenzS(), null).erwartetS(),
                zeitpunkt, id -> OrtsbaumAbleitung.zeitzoneVon(baum.baum(), alle.get(id).ort().standort()), sichtbar,
                komponenteSichtbar);
        for (int i = 0; i < bestand.size(); i++) {
            MessstelleDto.RegisterZeile z = mitBerechnung(alle.get(bestand.get(i).messstelle().id()),
                    berechnungen.get(bestand.get(i).messstelle().id()));
            if (auswahl.passt(z) && sichtbar.test(z.id())) {
                messstellenListe.add(voll.get(i));
                zeilen.add(letzterMonat == null ? z : mitMonat(z, bestand.get(i).messstelle(),
                        OrtsbaumAbleitung.zeitzoneVon(baum.baum(), z.ort().standort()), zeitpunkt, letzterMonat));
            }
        }
        return new MessstelleDto.Liste(List.copyOf(messstellenListe), List.copyOf(zeilen), tag,
                MessstelleService.zeit(zeitpunkt), false, aggregat(zeilen));
    }

    // ------------------------------------------------------------ Ablesungen

    /**
     * Eine Messstelle, deren Werte zum Zeitpunkt aus Ablesungen kommen ({@code quelle.stand = ablesung}), wie die
     * Wiedervorlage sie braucht (Konzept Wiedervorlage w1, Entscheid 7). {@code ort} ist, wo man sie abliest
     * ({@link #ableseort}); {@code null}, wo sie an dem Tag an keinem Ort im Baum hängt. {@code seit}: seit wann die
     * Ablesungs-Quelle führt; {@code zuletzt}: die letzte Ablesung bis zum Zeitpunkt ({@code null} = noch keine).
     * {@code faelligAb}: ab wann die nächste Ablesung fehlt, derselbe Zeitpunkt wie in der Beobachtung des Registers
     * ({@link MessstelleBeobachtung#ausAblesungen}): „Ablesung überfällig seit …“ ab der letzten Ablesung + zwei
     * Kalendermonate ({@link AblesungRegeln#ueberfaelligAb}), „Noch keine Ablesung“ ab dem Beginn der Quelle.
     */
    public record Ablesestelle(UUID id, String kennzeichen, String name, Ableseort ort, ZoneId zone, Instant seit,
            Instant zuletzt, Instant faelligAb) {}

    /**
     * Wo abgelesen wird: Kurzzeichen ({@code U} für das Unternehmen), Kennung (das Unternehmen hat keine) und Name.
     */
    public record Ableseort(String kennzeichen, UUID id, String name) {}

    /**
     * Die Messstellen, deren Werte zum Zeitpunkt {@code am} ({@code null} = jetzt) aus Ablesungen kommen, soweit
     * {@code sichtbar} sie zulässt: dieselbe Bedingung wie {@code quelle.stand = ablesung} im Register ({@link #zeile}:
     * gemessen, eine führende Ablesungs-Quelle, keine gebundene führende Quelle der Hauptgröße). Nur
     * aktive: eine archivierte, angehaltene oder noch nicht eingerichtete Messstelle erwartet keine Ablesung. Ein
     * Kundenbereich ohne Ablesungs-Quelle kostet einen Lesezug; sonst kommen die Messstellen und der Ortsbaum dazu, die
     * Werte nicht.
     */
    @Transactional(readOnly = true)
    public List<Ablesestelle> ablesestellen(Instant am, Predicate<UUID> sichtbar) {
        Instant zeitpunkt = am != null ? am : uhr.instant();
        Map<UUID, MessstelleRegisterRepository.Ablesung> ablesungen = register.ablesungen(zeitpunkt);
        if (ablesungen.isEmpty()) {
            return List.of();
        }
        LocalDate tag = LocalDate.ofInstant(zeitpunkt, MessstelleService.ZEITZONE);
        OffsetDateTime jetzt = OffsetDateTime.ofInstant(zeitpunkt, MessstelleService.ZEITZONE);
        List<Bestand> abgelesen = new ArrayList<>();
        List<OrtsbaumAbleitung.Messstelle> imBaum = new ArrayList<>();
        for (Bestand b : register.alle()) {
            MessstelleRepository.Messstelle m = b.messstelle();
            if (!ablesungen.containsKey(m.id()) || MessstelleRegeln.BERECHNET.equals(m.art())
                    || fuehrend(b, m.hauptgroesse(), zeitpunkt) != null || !sichtbar.test(m.id())
                    || !"aktiv".equals(MessstelleService.lebenszyklus(m, MessstelleService.ortVorhanden(b.orte()),
                            jetzt).lebenszyklus())) {
                continue;
            }
            abgelesen.add(b);
            imBaum.add(new OrtsbaumAbleitung.Messstelle(m.kennzeichen(), MessstelleOrtsbaumMessstellen.anzeigename(m),
                    null, ObjektZustand.AKTIV, MessstelleOrtsbaumMessstellen.intervalle(b.orte())));
        }
        if (abgelesen.isEmpty()) {
            return List.of();
        }
        StandortService.Baum baum = standorte.baum(imBaum);
        List<Ablesestelle> aus = new ArrayList<>();
        for (Bestand b : abgelesen) {
            MessstelleRepository.Messstelle m = b.messstelle();
            Verortung v = OrtsbaumAbleitung.verortung(baum.baum(), m.kennzeichen(), tag);
            ZoneId zone = OrtsbaumAbleitung.zeitzoneVon(baum.baum(), v.standort());
            MessstelleRegisterRepository.Ablesung a = ablesungen.get(m.id());
            Instant faelligAb = a.zuletzt() == null ? a.seit() : AblesungRegeln.ueberfaelligAb(a.zuletzt(), zone);
            aus.add(new Ablesestelle(m.id(), m.kennzeichen(), m.name(), ableseort(v, baum), zone, a.seit(),
                    a.zuletzt(), faelligAb));
        }
        return List.copyOf(aus);
    }

    /**
     * Wo man eine Messstelle abliest: das erste Gebäude auf dem Pfad von ihrem Ort hinauf (auch für einen Bereich darin),
     * ohne Gebäude ihr Standort, am Unternehmen das Unternehmen.
     */
    private static Ableseort ableseort(Verortung v, StandortService.Baum baum) {
        if (OrtsbaumAbleitung.UNTERNEHMEN.equals(v.ort())) {
            return new Ableseort(OrtsbaumAbleitung.UNTERNEHMEN, null,
                    baum.zeilen().unternehmen() == null ? null : baum.zeilen().unternehmen().name());
        }
        if (v.standort() == null) {
            return null;
        }
        String kurzzeichen = v.pfad().stream()
                .filter(k -> baum.baum().ort(k).map(o -> o.art() == OrtsbaumAbleitung.OrtArt.GEBAEUDE).orElse(false))
                .findFirst().orElse(v.standort());
        UUID id = baum.standorte().containsKey(kurzzeichen) ? baum.standorte().get(kurzzeichen)
                : baum.ort(kurzzeichen) == null ? null : baum.ort(kurzzeichen).id();
        return new Ableseort(kurzzeichen, id,
                baum.baum().ort(kurzzeichen).map(OrtsbaumAbleitung.Ort::name).orElse(null));
    }

    /**
     * Alle Messwerte, deren Werte die Beobachtung braucht: die führenden Bindungen JEDER Größe, die
     * zum Zeitpunkt laufen — einmal je (Komponente, Kanal, Beginn), nie je Messstelle.
     */
    private static Set<Messwert> messwerte(List<Bestand> bestand, Instant zeitpunkt) {
        Set<Messwert> out = new LinkedHashSet<>();
        for (Bestand b : bestand) {
            for (QuelleZeile z : b.quellen()) {
                if (FUEHREND.equals(z.quelle().rolle()) && MessstelleQuelleService.gilt(z.quelle(), zeitpunkt)) {
                    out.add(messwert(z));
                }
            }
        }
        return out;
    }

    // ---------------------------------------------------------------- Zeile

    private MessstelleDto.RegisterZeile zeile(Bestand b, MessstelleDto.Messstelle voll, StandortService.Baum baum,
            Map<UUID, String> anlagen, LocalDate tag, Instant zeitpunkt, Map<Messwert, Werte> werte,
            Map<UUID, Integer> fassungen, MessstelleRegisterRepository.Ablesung ablesung) {
        MessstelleRepository.Messstelle m = b.messstelle();
        Groesse h = m.hauptgroesse();
        MessstelleDto.RegisterOrt ort = ort(b, baum, tag);
        ZoneId zone = OrtsbaumAbleitung.zeitzoneVon(baum.baum(), ort.standort());
        boolean gemessen = !MessstelleRegeln.BERECHNET.equals(m.art());
        QuelleZeile gebunden = gemessen ? fuehrend(b, h, zeitpunkt) : null;
        // Eine Ablesungs-Quelle führt nur, wo keine gebundene führt (AP-09 IP-8: Ablesung und Kanal schließen sich aus).
        boolean abgelesen = gemessen && gebunden == null && ablesung != null;
        MessstelleBeobachtung.Ergebnis haupt = !gemessen ? null
                : abgelesen ? MessstelleBeobachtung.ausAblesungen(ablesung, h.einheit(), zeitpunkt, zone)
                : beobachtung(gebunden, werte, fassungen, zeitpunkt, zone);
        List<MessstelleDto.RegisterNebengroesse> neben = new ArrayList<>();
        for (MessstelleRepository.Nebengroesse n : b.nebengroessen()) {
            Groesse g = n.groesse();
            MessstelleBeobachtung.Ergebnis e = gemessen
                    ? beobachtung(fuehrend(b, g, zeitpunkt), werte, fassungen, zeitpunkt, zone) : null;
            neben.add(new MessstelleDto.RegisterNebengroesse(n.id(),
                    new MessstelleDto.Groesse(g.groesse(), g.richtung(), g.einheit(), g.wertart()),
                    e == null ? null : e.beobachtung(), e == null ? null : e.letzterWert()));
        }
        return new MessstelleDto.RegisterZeile(m.id(), m.kennzeichen(), m.name(), m.art(), m.medium(),
                new MessstelleDto.Groesse(h.groesse(), h.richtung(), h.einheit(), h.wertart()),
                ort, stellung(b, anlagen, tag), quelle(b, zeitpunkt, abgelesen ? ablesung : null, zone),
                voll.lebenszyklus(), voll.fehlt(), voll.angehaltenAb(), voll.archiviertAm(),
                haupt == null ? null : haupt.beobachtung(), haupt == null ? null : haupt.letzterWert(),
                List.copyOf(neben), fakten(b.fakten(), zeitpunkt), null, List.of(), null);
    }

    private static MessstelleDto.RegisterZeile mitPlanungen(MessstelleDto.RegisterZeile z,
            List<MessbedarfRepository.Planung> planungen) {
        return new MessstelleDto.RegisterZeile(z.id(), z.kennzeichen(), z.name(), z.art(), z.medium(),
                z.hauptgroesse(), z.ort(), z.elektrischeStellung(), z.quelle(), z.lebenszyklus(), z.fehlt(),
                z.angehaltenAb(), z.archiviertAm(), z.beobachtung(), z.letzterWert(), z.nebengroessen(), z.fakten(),
                z.berechnung(), planungen.stream().map(p -> new MessstelleDto.GeplanterEinsatz(
                        p.einsatzId(), p.einsatzKennzeichen(), p.einsatzName())).toList(), z.letzterMonat());
    }

    private static MessstelleDto.RegisterZeile mitBerechnung(MessstelleDto.RegisterZeile z,
            MessstelleDto.RegisterBerechnung b) {
        return b == null ? z : new MessstelleDto.RegisterZeile(z.id(), z.kennzeichen(), z.name(), z.art(), z.medium(),
                z.hauptgroesse(), z.ort(), z.elektrischeStellung(), z.quelle(), z.lebenszyklus(), z.fehlt(),
                z.angehaltenAb(), z.archiviertAm(), z.beobachtung(), z.letzterWert(), z.nebengroessen(), z.fakten(), b,
                z.geplantFuerEinsaetze(), z.letzterMonat());
    }

    /**
     * Die Zeile mit ihrem letzten vollständigen Monat: dem Kalendermonat vor dem Monat von {@code zeitpunkt} in
     * {@code zone} (der Zone ihres Standorts), mit dem Wert, den {@code …/werte?raster=monat} für ihn zeigt.
     */
    private MessstelleDto.RegisterZeile mitMonat(MessstelleDto.RegisterZeile z, MessstelleRepository.Messstelle m,
            ZoneId zone, Instant zeitpunkt, MessstelleWerteService.EingaengeImZugriff eingaenge) {
        YearMonth monat = YearMonth.from(zeitpunkt.atZone(zone)).minusMonths(1);
        MessstelleWerteService.Monatswert w = werte.monatswert(m, monat, eingaenge);
        return new MessstelleDto.RegisterZeile(z.id(), z.kennzeichen(), z.name(), z.art(), z.medium(),
                z.hauptgroesse(), z.ort(), z.elektrischeStellung(), z.quelle(), z.lebenszyklus(), z.fehlt(),
                z.angehaltenAb(), z.archiviertAm(), z.beobachtung(), z.letzterWert(), z.nebengroessen(), z.fakten(),
                z.berechnung(), z.geplantFuerEinsaetze(),
                new MessstelleDto.RegisterMonat(monat.toString(), w.zeitzone(), w.wert(), w.ausserhalbZugriff()));
    }

    private static List<MessstelleDto.RegisterFakt> fakten(List<Fakt> fakten, Instant zeitpunkt) {
        return fakten.stream().filter(f -> !f.giltAb().isAfter(zeitpunkt))
                .collect(Collectors.toMap(Fakt::art, Function.identity(),
                        (a, b) -> a.giltAb().isAfter(b.giltAb()) ? a : b, LinkedHashMap::new))
                .values().stream()
                .map(f -> new MessstelleDto.RegisterFakt(f.art(), MessstelleService.zeit(f.giltAb())))
                .toList();
    }

    /**
     * Die Beobachtung EINER Größe: Kadenz und Einheit ihres Kanals wie im Messkanal-Read-Model, der
     * letzte gute Wert aus dem einen Werte-Zug, das Urteil aus {@link ZustandAbleitung}. Ohne
     * führende Bindung braucht es weder Kanal noch Kadenz — der Zustand ist „keine Datenquelle“,
     * und der schlägt jeden alten Wert.
     */
    private MessstelleBeobachtung.Ergebnis beobachtung(QuelleZeile fuehrend, Map<Messwert, Werte> werte,
            Map<UUID, Integer> fassungen, Instant zeitpunkt, ZoneId zone) {
        if (fuehrend == null) {
            return MessstelleBeobachtung.ableiten(null, null, MesskanalService.VORGABE_KADENZ_S, null, zeitpunkt,
                    zone);
        }
        Quelle q = fuehrend.quelle();
        Werte w = werte.get(messwert(fuehrend));
        return MessstelleBeobachtung.ableiten(fuehrend, w,
                kanaele.kadenz(q.kanal(), w == null ? null : w.kadenzS(), fassungen.get(q.id())).erwartetS(),
                kanaele.einheit(q.kanal(), fuehrend.kanalDefinition()), zeitpunkt, zone);
    }

    /**
     * Die führenden Bindungen, die zum Zeitpunkt laufen — nach ihren Kadenz-Fassungen wird EINMAL
     * gefragt (AP-07 IP-10), nicht je Zeile.
     */
    private static Set<UUID> bindungen(List<Bestand> bestand, Instant zeitpunkt) {
        Set<UUID> out = new LinkedHashSet<>();
        for (Bestand b : bestand) {
            for (QuelleZeile z : b.quellen()) {
                if (FUEHREND.equals(z.quelle().rolle()) && MessstelleQuelleService.gilt(z.quelle(), zeitpunkt)) {
                    out.add(z.quelle().id());
                }
            }
        }
        return out;
    }

    /**
     * Der Schlüssel, unter dem die Werte einer Bindung liegen: Komponente, Kanal UND ihr Beginn —
     * ein Zählerwechsel behält Komponente und Kanal, nur der Beginn trennt Z-5a von Z-5b.
     */
    private static Messwert messwert(QuelleZeile z) {
        return new Messwert(z.quelle().entityId(), z.quelle().kanal(), z.quelle().gueltigAb());
    }

    /** Die führende Bindung EINER Größe zum Zeitpunkt; {@code null}, wenn dann keine läuft. */
    private static QuelleZeile fuehrend(Bestand b, Groesse g, Instant zeitpunkt) {
        return b.quellen().stream()
                .filter(z -> FUEHREND.equals(z.quelle().rolle())
                        && z.quelle().groesse().equals(g.groesse())
                        && z.quelle().richtung().equals(g.richtung())
                        && MessstelleQuelleService.gilt(z.quelle(), zeitpunkt))
                .findFirst().orElse(null);
    }

    // ---------------------------------------------------------------- Aggregat

    /**
     * „x von y Messstellen liefern Daten“ (§5.16) über {@link ZustandAbleitung#aggregatLiefertDaten}
     * — für das Unternehmen und je Standort, über GENAU die Zeilen dieser Antwort. Gezählt werden
     * JEDE Zeile. Seit AP-10 IP-9 zählen BERECHNETE Messstellen mit: vollständig heißt „liefert“,
     * unvollständig „liefert nicht“ — und eine berechnete ohne Formel am Tag steht wie eine gemessene
     * ohne Quelle im Nenner, nie im Zähler. Eine Zeile ohne Standort an dem Tag zählt nur beim
     * Unternehmen — nie unter einem geratenen Standort.
     */
    private static MessstelleDto.RegisterAggregat aggregat(List<MessstelleDto.RegisterZeile> zeilen) {
        List<ZustandAbleitung.LiefertDaten> alle = new ArrayList<>();
        Map<String, List<ZustandAbleitung.LiefertDaten>> jeStandort = new LinkedHashMap<>();
        Map<String, MessstelleDto.RegisterOrt> orte = new LinkedHashMap<>();
        for (MessstelleDto.RegisterZeile z : zeilen) {
            ZustandAbleitung.LiefertDaten zustand = aggregatZustand(z);
            if (zustand == null) {
                continue;
            }
            alle.add(zustand);
            String standort = z.ort().standort();
            if (standort != null) {
                jeStandort.computeIfAbsent(standort, k -> new ArrayList<>()).add(zustand);
                orte.putIfAbsent(standort, z.ort());
            }
        }
        List<MessstelleDto.RegisterStandortAbdeckung> standorte = jeStandort.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(e -> {
                    ZustandAbleitung.AggregatErgebnis a = ZustandAbleitung.aggregatLiefertDaten(e.getValue(),
                            ZustandAbleitung.Einheit.MESSSTELLE);
                    MessstelleDto.RegisterOrt o = orte.get(e.getKey());
                    return new MessstelleDto.RegisterStandortAbdeckung(o.standortId(), e.getKey(),
                            o.standortName(), a.erfuellt(), a.gesamt(), a.text());
                })
                .toList();
        ZustandAbleitung.AggregatErgebnis u = ZustandAbleitung.aggregatLiefertDaten(alle,
                ZustandAbleitung.Einheit.MESSSTELLE);
        return new MessstelleDto.RegisterAggregat(
                new MessstelleDto.RegisterAbdeckung(u.erfuellt(), u.gesamt(), u.text()), standorte);
    }

    /**
     * Wie EINE Zeile im Aggregat zählt — {@code null} = gar nicht: gemessene über ihre Beobachtung, berechnete über
     * {@code berechnung} (vollständig = liefert, unvollständig = liefert nicht, ohne Formel am Tag = keine Datenquelle;
     * {@code ausserhalb_zugriff} — ein Eingang außerhalb des Zugriffs, alle sichtbaren liefern — steht wie
     * „liefert nicht“ im Nenner, nie im Zähler: ein Urteil, das der Leser nicht fällen darf, ist kein „liefert“).
     * ⚠ AP-13 IP-7 (E13 = A): die Datenlage von „Messen &amp; Auswerten“ ({@link FunktionService}) zählt über GENAU
     * diese Stelle — Register, Baustein „Messstellen“ der Übersicht und Karte „Funktionen“ sagen dieselbe Zahl.
     */
    public static ZustandAbleitung.LiefertDaten aggregatZustand(MessstelleDto.RegisterZeile z) {
        if (z.beobachtung() != null) {
            return ZustandAbleitung.LiefertDaten.vonCode(z.beobachtung().zustand());
        }
        if (!MessstelleRegeln.BERECHNET.equals(z.art())) {
            return null;
        }
        return z.berechnung() == null ? ZustandAbleitung.LiefertDaten.KEINE_DATENQUELLE
                : RegisterBerechnung.VOLLSTAENDIG.equals(z.berechnung().zustand())
                        ? ZustandAbleitung.LiefertDaten.LIEFERT : ZustandAbleitung.LiefertDaten.LIEFERT_NICHT_SEIT;
    }

    /** Die Verortung am Tag (Regel 7 des Ortsbaums) mit den Namen aus demselben Baum. */
    private static MessstelleDto.RegisterOrt ort(Bestand b, StandortService.Baum baum, LocalDate tag) {
        Ortsbaum o = baum.baum();
        Verortung v = OrtsbaumAbleitung.verortung(o, b.messstelle().kennzeichen(), tag);
        String grund = v.grund().name().toLowerCase(Locale.ROOT);
        OrtZeile amTag = amTag(b.orte(), tag);
        if (v.ort() == null || amTag == null) {
            return new MessstelleDto.RegisterOrt(null, null, null, null, null, null, List.of(), null, null, null,
                    grund);
        }
        String name = OrtsbaumAbleitung.UNTERNEHMEN.equals(v.ort())
                ? (baum.zeilen().unternehmen() == null ? null : baum.zeilen().unternehmen().name())
                : o.ort(v.ort()).map(OrtsbaumAbleitung.Ort::name).orElse(null);
        String standortName = v.standort() == null ? null
                : o.ort(v.standort()).map(OrtsbaumAbleitung.Ort::name).orElse(null);
        return new MessstelleDto.RegisterOrt(amTag.zielId(), v.ort(), amTag.zielArt(), name, amTag.gueltigAb(),
                amTag.gueltigBis(), v.pfad(), v.standort(), v.standort() == null ? null : baum.standorte()
                        .get(v.standort()), standortName, grund);
    }

    private static MessstelleDto.RegisterStellung stellung(Bestand b, Map<UUID, String> anlagen, LocalDate tag) {
        StellungZeile s = amTag(b.stellungen(), tag);
        return s == null ? null : new MessstelleDto.RegisterStellung(s.siteId(), anlagen.get(s.siteId()),
                s.stellung(), s.unterzaehlerVonKennzeichen(), s.gueltigAb(), s.gueltigBis());
    }

    /**
     * Die Quelle der Hauptgröße zum Zeitpunkt: die führende, die dann läuft; davor die führende, die
     * zuletzt VOR ihr (bzw. vor dem Zeitpunkt) endete; die Zahl der laufenden Vergleichsquellen.
     */
    private MessstelleDto.RegisterQuelle quelle(Bestand b, Instant zeitpunkt,
            MessstelleRegisterRepository.Ablesung ablesung, ZoneId zone) {
        Groesse h = b.messstelle().hauptgroesse();
        List<QuelleZeile> derHaupt = b.quellen().stream()
                .filter(z -> z.quelle().groesse().equals(h.groesse()) && z.quelle().richtung().equals(h.richtung()))
                .toList();
        List<QuelleZeile> fuehrende = derHaupt.stream().filter(z -> FUEHREND.equals(z.quelle().rolle()))
                .sorted(Comparator.comparing(z -> z.quelle().gueltigAb())).toList();
        QuelleZeile gilt = fuehrende.stream().filter(z -> MessstelleQuelleService.gilt(z.quelle(), zeitpunkt))
                .findFirst().orElse(null);
        Instant grenze = gilt != null ? gilt.quelle().gueltigAb() : zeitpunkt;
        QuelleZeile davor = fuehrende.stream()
                .filter(z -> z.quelle().gueltigBis() != null && !z.quelle().gueltigBis().isAfter(grenze))
                .reduce((erste, zweite) -> zweite).orElse(null);
        int vergleich = (int) derHaupt.stream().filter(z -> VERGLEICH.equals(z.quelle().rolle())
                && MessstelleQuelleService.gilt(z.quelle(), zeitpunkt)).count();
        String stand = MessstelleRegeln.BERECHNET.equals(b.messstelle().art()) ? BERECHNET
                : gilt != null ? GEBUNDEN : ablesung != null ? ABLESUNG : KEINE_DATENQUELLE;
        return new MessstelleDto.RegisterQuelle(stand, bindung(gilt), bindung(davor), vergleich,
                ablesung == null ? null : new MessstelleDto.RegisterAblesung(MessstelleService.zeit(ablesung.seit()),
                        MessstelleService.zeit(ablesung.zuletzt()), MessstelleService.zeit(ablesung.zuletzt() == null
                                ? ablesung.seit() : AblesungRegeln.ueberfaelligAb(ablesung.zuletzt(), zone))));
    }

    private MessstelleDto.RegisterBindung bindung(QuelleZeile z) {
        if (z == null) {
            return null;
        }
        Quelle q = z.quelle();
        return new MessstelleDto.RegisterBindung(q.id(), q.entityId(), q.komponenteName(), q.kanal(),
                kanaele.anzeigename(q.kanal(), z.kanalDefinition()),
                new MessstelleDto.RegisterGeraet(q.geraetId(), q.geraet(), q.einbau(), z.geraetBezeichnung()),
                MessstelleService.zeit(q.gueltigAb()), MessstelleService.zeit(q.gueltigBis()));
    }

    // ---------------------------------------------------------------- Gerüst

    /** Das wirksame Intervall, das den Tag deckt — dieselbe Tages-Mechanik wie {@code …/standort?am=}. */
    private static <T extends MessstelleZuordnungRepository.Tagesintervall> T amTag(List<T> zeilen, LocalDate tag) {
        return MessstelleService.wirksam(zeilen).stream().filter(z -> z.deckt(tag)).findFirst().orElse(null);
    }

    /** Die Messstelle, wie der Ortsbaum sie kennt ({@link MessstelleOrtsbaumMessstellen}): Kurzzeichen und Ort-Intervalle. */
    private static OrtsbaumAbleitung.Messstelle imBaum(Bestand b, MessstelleDto.Messstelle voll, LocalDate tag) {
        StellungZeile s = amTag(b.stellungen(), tag);
        return new OrtsbaumAbleitung.Messstelle(b.messstelle().kennzeichen(),
                MessstelleOrtsbaumMessstellen.anzeigename(b.messstelle()), s == null ? null : s.siteId().toString(),
                ObjektZustand.valueOf(voll.lebenszyklus().toUpperCase(Locale.ROOT)),
                MessstelleOrtsbaumMessstellen.intervalle(b.orte()));
    }

    private static List<Quelle> quellen(Bestand b) {
        return b.quellen().stream().map(QuelleZeile::quelle).toList();
    }

    /**
     * Die Filter, aufgelöst gegen den Baum: eine ID wird zum Kurzzeichen ihres Standorts bzw. Orts.
     * Eine ID oder ein Kurzzeichen, das es im Kundenbereich nicht gibt (auch ein fremdes), findet
     * nichts — nie ein 403, nie ein Hinweis, dass es sie woanders gibt.
     */
    private record Auswahl(Filter filter, String standort, String ort, boolean nichts) {

        static Auswahl aus(Filter f, StandortService.Baum baum) {
            String standort = kurzzeichen(f.standort(), baum);
            String ort = kurzzeichen(f.ort(), baum);
            // Eine ID, die es hier nicht gibt, ist kein „egal“: sie findet nichts.
            return new Auswahl(f, standort, ort,
                    f.standort() != null && standort == null || f.ort() != null && ort == null);
        }

        boolean passt(MessstelleDto.RegisterZeile z) {
            if (nichts) {
                return false;
            }
            if (filter.standort() != null && !Objects.equals(standort, z.ort().standort())) {
                return false;
            }
            if (filter.ort() != null && !(Objects.equals(ort, z.ort().kennzeichen()) || z.ort().pfad().contains(ort))) {
                return false;
            }
            if (filter.anlage() != null
                    && (z.elektrischeStellung() == null || !filter.anlage().equals(z.elektrischeStellung().anlage()))) {
                return false;
            }
            if (filter.zustand() != null && !filter.zustand().equals(z.lebenszyklus())) {
                return false;
            }
            if (filter.ohneQuelle() && !KEINE_DATENQUELLE.equals(z.quelle().stand())) {
                return false;
            }
            return !filter.geplantFuerEinsatz() || !z.geplantFuerEinsaetze().isEmpty();
        }

        private static String kurzzeichen(String wert, StandortService.Baum baum) {
            if (wert == null) {
                return null;
            }
            UUID id = uuid(wert);
            if (id == null) {
                return wert;
            }
            Function<Map.Entry<String, UUID>, Boolean> gleich = e -> id.equals(e.getValue());
            return baum.standorte().entrySet().stream().filter(gleich::apply).map(Map.Entry::getKey).findFirst()
                    .or(() -> baum.orte().values().stream().filter(o -> id.equals(o.id()))
                            .map(OrtRepository.Ort::kurzzeichen).findFirst())
                    .orElse(null);
        }

        private static UUID uuid(String wert) {
            try {
                return UUID.fromString(wert);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }
    }
}
