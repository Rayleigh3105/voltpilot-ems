package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleAbgelehnt.Schnittstelle;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleRegeln.Fehler;
import com.voltpilot.api.uems.MessstelleRegeln.Stellung;
import com.voltpilot.api.uems.MessstelleRegeln.StellungEintrag;
import com.voltpilot.api.uems.MessstelleRegeln.StellungKandidat;
import com.voltpilot.api.uems.MessstelleRegeln.StellungUrteil;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.OrtZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.StellungZeile;
import com.voltpilot.api.uems.MessstelleZuordnungRepository.Tagesintervall;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragAntrag;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragErgebnis;
import com.voltpilot.api.uems.OrtsbaumAbleitung.EintragGrund;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Ortsbaum;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Rueckwirkung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.RueckwirkungEingang;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Verortung;
import com.voltpilot.api.uems.OrtsbaumAbleitung.Vorgang;
import com.voltpilot.api.web.dto.MessstelleDto;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Predicate;
import java.util.function.Supplier;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die zeitgültigen Zuordnungen der Messstelle (UEMS AP-04 IP-7, Teil Ort und elektrische
 * Stellung): {@code PUT …/{id}/ort}, {@code PUT …/{id}/stellung} und der Stand an einem Tag
 * ({@code GET …/{id}/standort?am=}). Je Schreibvorgang EINE Transaktion und GENAU EIN Eintrag
 * im Änderungsprotokoll mit Urheber ({@link ProtokollAkteur}); eine Ablehnung schreibt nichts.
 *
 * <h2>Die Tage (AP-02 E9 — die Mechanik des Ortsbaums, die AP-04 übernimmt)</h2>
 *
 * „gültig ab“ ist ein Tag; ein neues „gültig ab“ beendet das laufende Intervall am VORTAG und
 * das neue erbt dessen Ende (bis zu einer schon geplanten Zuordnung); {@code korrektur} ersetzt
 * das Intervall, das an dem Tag beginnt, und lässt das alte aufgehoben lesbar. Die Vergangenheit
 * ist erlaubt und steht als „rückwirkend“ im Protokoll ({@link OrtsbaumAbleitung#rueckwirkung}),
 * die Zukunft ist „geplant“. Die Tage zählen in der Zeitzone des Unternehmens (die zulässigen
 * Zeitzonen der Standorte haben dieselben Regeln, {@link MessstelleService#ZEITZONE}).
 *
 * <h2>Keine zweite Regel-Logik</h2>
 *
 * <ul>
 *   <li><b>Ort</b>: {@link OrtsbaumAbleitung#eintrag} urteilt gegen DENSELBEN Baum, den die
 *       Standort- und Ort-Routen zeigen ({@code StandortService.baum}), mit den Messstellen aus
 *       {@link MessstelleOrtsbaumMessstellen} — Tages-Mechanik UND „das Ziel besteht an jedem
 *       Tag“ (Satz des Vertrags). Dazu die eine Regel, die der Baum nicht kennt: das Unternehmen
 *       ({@code U}) ist nur der Ort einer BERECHNETEN Messstelle (Vertrag, {@code ortArt}).</li>
 *   <li><b>Stellung</b>: {@link MessstelleRegeln#stellungPruefen} (Regel 8, E12) — an JEDEM Tag
 *       des neuen Intervalls, an dem sich im Baum der Anlagen etwas ändert (die Liste ist der
 *       Stand am Tag, Vertrag §6), für die Messstelle selbst UND für jede, die an dem Tag
 *       Unterzähler von ihr ist (zieht sie in eine andere Anlage, zeigte deren „Unterzähler von“
 *       sonst in eine fremde). Die Tages-Mechanik ist dieselbe wie beim Ort, mit denselben
 *       Gründen ({@link EintragGrund}).</li>
 * </ul>
 *
 * <p><b>Der Hauptzähler und seine Quelle (IP-13).</b> „Alle Hauptzähler einer Anlage lesen
 * denselben Zähler“ vergleicht die Komponente der führenden Quelle der Hauptgröße an dem Tag
 * ({@link #komponente}, aus {@code messstelle_quelle}). So sind MS-01 (Bezug) und MS-02 (Abgabe)
 * am Netzzähler K-3 zusammen Hauptzähler; hat eine der beiden an dem Tag keine Quelle, ist ihr
 * Zähler unbekannt, und die Regel urteilt, wie ihr Zwilling es vorschreibt: ein zweiter
 * Hauptzähler derselben Anlage ist 409 {@code hauptzaehler_vorhanden}, auch in anderer Richtung.
 *
 * <p>Alle Zuordnungs-Schreibvorgänge eines Kundenbereichs laufen nacheinander — dieselbe
 * Zeilensperre auf seinem Unternehmen wie {@link OrtService}: die Regeln über mehrere Messstellen
 * (ein Hauptzähler je Anlage, kein Zyklus) stehen in keinem Index. Der Mandant ist die RLS: eine
 * fremde Messstelle ist nicht da (404, nie 403); ein fremder Ort, eine fremde Anlage, eine
 * fremde Bezug-Messstelle gibt es für ihn nicht.
 */
@Service
public class MessstelleZuordnungService {

    private static final String BERECHNET = "berechnet";
    private static final String UNTERZAEHLER = "Unterzähler";
    private static final String KEINE = "keine";

    private final MessstelleRepository messstellen;
    private final MessstelleZuordnungRepository zuordnungen;
    private final MessstelleAenderungRepository aenderungen;
    private final MessstelleQuelleRepository quellen;
    private final MessstelleOrtsbaumMessstellen ortsbaumMessstellen;
    private final StandortService standorte;
    private final UnternehmenRepository unternehmen;
    private final JdbcTemplate jdbc;
    private final ObjectMapper json;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();

    public MessstelleZuordnungService(MessstelleRepository messstellen, MessstelleZuordnungRepository zuordnungen,
            MessstelleAenderungRepository aenderungen, MessstelleQuelleRepository quellen,
            MessstelleOrtsbaumMessstellen ortsbaumMessstellen, StandortService standorte,
            UnternehmenRepository unternehmen, JdbcTemplate jdbc, ObjectMapper json,
            PlatformTransactionManager transactionManager) {
        this.messstellen = messstellen;
        this.zuordnungen = zuordnungen;
        this.aenderungen = aenderungen;
        this.quellen = quellen;
        this.ortsbaumMessstellen = ortsbaumMessstellen;
        this.standorte = standorte;
        this.unternehmen = unternehmen;
        this.jdbc = jdbc;
        this.json = json;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests: die Uhr, an der „heute“ hängt (rückwirkend oder geplant). */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // -------------------------------------------------------------------- Ort

    /**
     * Setzt den Ort der Messstelle ab einem Tag. Geprüft wird erst die Form (400), dann das Ziel
     * (unbekannt, Unternehmen nur berechnet — 422 {@code ort_ungueltig}), dann Tages-Mechanik und
     * Bestehen des Ziels mit {@link OrtsbaumAbleitung#eintrag}.
     */
    public void ortZuordnen(UUID id, MessstelleDto.OrtAendern a, ProtokollAkteur wer) {
        Messstelle m = finde(id);
        if (a == null) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        String ziel = a.kennzeichen() == null ? null : a.kennzeichen().trim();
        if (ziel == null || ziel.isEmpty()) {
            throw MessstelleAbgelehnt.anfrage("kennzeichen",
                    "Der Ort fehlt: das Kurzzeichen eines Standorts, Gebäudes oder Bereichs — oder „U“ für das Unternehmen.");
        }
        LocalDate ab = tag(a.gueltigAb());
        boolean korrektur = Boolean.TRUE.equals(a.korrektur());
        nichtArchiviert(m);
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        schreibe(() -> transaktion.execute(tx -> {
            sperre();
            StandortService.Baum b = standorte.baum(ortsbaumMessstellen.messstellen());
            Ortsbaum baum = b.baum();
            ZoneId zone = baum.zeitzone();
            Ziel z = ziel(b, ziel, m);
            EintragErgebnis e = OrtsbaumAbleitung.eintrag(baum, new EintragAntrag(m.kennzeichen(),
                    korrektur ? Vorgang.KORREKTUR : Vorgang.VERSCHIEBEN, ab, ziel, heute(jetzt, zone)));
            if (!e.erlaubt()) {
                throw eintragAbgelehnt(e.grund(), e.text(), ab);
            }
            List<OrtZeile> vorher = MessstelleService.wirksam(zuordnungen.orte(id));
            Schritt<OrtZeile> s = schritt(vorher, ab, korrektur, x -> x.kennzeichen().equals(ziel));
            if (s.grund() != null) {
                // Der Baum hat eben zugestimmt — dieselbe Mechanik darf hier nicht widersprechen.
                throw new IllegalStateException("Tages-Mechanik weicht vom Ortsbaum ab: " + s.grund());
            }
            if (s.aufheben() != null) {
                zuordnungen.ortAufheben(s.aufheben().id(), jetzt);
            }
            if (s.beenden() != null) {
                zuordnungen.ortBeenden(s.beenden().id(), ab.minusDays(1));
            }
            zuordnungen.ortEintragen(tenant, id, z.art(), z.id(), s.neuAb(), s.neuBis(), wer.sub());
            Map<String, Object> neu = ortForm(z.art(), ziel, s.neuAb(), s.neuBis());
            protokoll(tenant, id, korrektur ? "ort_korrigiert" : "ort_zugeordnet",
                    s.alt() == null ? null : ortForm(s.alt().zielArt(), s.alt().kennzeichen(),
                            s.alt().gueltigAb(), s.alt().gueltigBis()),
                    neu, ab, zone, jetzt, a.grund(), wer);
            return id;
        }));
    }

    /** Das Ziel eines Orts in der Sprache der Tabelle: Art des Vertrags und die ID der Zeile. */
    private record Ziel(String art, UUID id) {}

    private Ziel ziel(StandortService.Baum b, String kennzeichen, Messstelle m) {
        if (OrtsbaumAbleitung.UNTERNEHMEN.equals(kennzeichen)) {
            if (!BERECHNET.equals(m.art())) {
                throw ortUngueltig("unternehmen_nur_berechnet", "Nur eine berechnete Messstelle hängt am Unternehmen. "
                        + m.kennzeichen() + " misst an einem Ort — wählen Sie einen Standort, ein Gebäude oder einen Bereich.");
            }
            UnternehmenRepository.Unternehmen u = b.zeilen().unternehmen();
            if (u == null) {
                throw ortUngueltig("unbekannt", "Für diesen Kundenbereich ist noch kein Unternehmen angelegt.");
            }
            return new Ziel(MessstelleZuordnungRepository.UNTERNEHMEN, u.id());
        }
        UUID standort = b.standorte().get(kennzeichen);
        if (standort != null) {
            return new Ziel(MessstelleZuordnungRepository.STANDORT, standort);
        }
        OrtRepository.Ort o = b.ort(kennzeichen);
        if (o != null) {
            return new Ziel(o.art(), o.id());
        }
        throw ortUngueltig("unbekannt", "Einen Ort „" + kennzeichen + "“ gibt es in diesem Kundenbereich nicht.");
    }

    // --------------------------------------------------------------- Stellung

    /**
     * Setzt die elektrische Stellung der Messstelle ab einem Tag. Geprüft wird erst die Form
     * (400: Anlage, Stellung aus dem Vokabular, Tag), dann die Tages-Mechanik, dann Regel 8 an
     * jedem Tag des neuen Intervalls, an dem sich etwas ändert.
     */
    public void stellungZuordnen(UUID id, MessstelleDto.StellungAendern a, ProtokollAkteur wer) {
        Messstelle m = finde(id);
        if (a == null) {
            throw MessstelleAbgelehnt.anfrage("", "Die Anfrage braucht ein JSON-Objekt.");
        }
        if (a.anlage() == null) {
            throw MessstelleAbgelehnt.anfrage("anlage", "Die Anlage fehlt.");
        }
        String stellung = a.stellung();
        if (stellung == null || !MessstelleRegeln.STELLUNGEN.contains(stellung)) {
            throw MessstelleAbgelehnt.anfrage("stellung", (stellung == null ? "Die Stellung fehlt."
                    : "„" + stellung + "“ ist keine Stellung.") + " Erlaubt sind: "
                    + String.join(", ", MessstelleRegeln.STELLUNGEN) + ".");
        }
        String bezug = a.unterzaehlerVon() == null || a.unterzaehlerVon().isBlank() ? null : a.unterzaehlerVon().trim();
        LocalDate ab = tag(a.gueltigAb());
        boolean korrektur = Boolean.TRUE.equals(a.korrektur());
        nichtArchiviert(m);
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        schreibe(() -> transaktion.execute(tx -> {
            sperre();
            Map<UUID, String> anlagen = anlagen();
            if (!anlagen.containsKey(a.anlage())) {
                throw MessstelleAbgelehnt.anfrage("anlage", "Diese Anlage gibt es in diesem Kundenbereich nicht.");
            }
            Stand stand = stand(anlagen);
            Messstelle bezugMs = bezug == null ? null : stand.jeKennzeichen().get(bezug);
            Wert neu = new Wert(a.anlage(), stellung, bezugMs == null ? null : bezugMs.id(), bezug);
            ZoneId zone = zone();
            List<StellungZeile> alle = zuordnungen.stellungenAlle();
            List<StellungZeile> eigene = MessstelleService.wirksam(
                    alle.stream().filter(z -> z.messstelleId().equals(id)).toList());
            Schritt<StellungZeile> s = schritt(eigene, ab, korrektur, neu::gleich);
            if (s.grund() != null) {
                throw eintragAbgelehnt(s.grund(), mechanikSatz(s, m, ab, stand), ab);
            }
            regelnPruefen(m, neu, s, alle, stand);
            if (s.aufheben() != null) {
                zuordnungen.stellungAufheben(s.aufheben().id(), jetzt);
            }
            if (s.beenden() != null) {
                zuordnungen.stellungBeenden(s.beenden().id(), ab.minusDays(1));
            }
            zuordnungen.stellungEintragen(tenant, id, neu.anlage(), neu.stellung(), neu.bezug(), s.neuAb(),
                    s.neuBis(), wer.sub());
            protokoll(tenant, id, korrektur ? "stellung_korrigiert" : "stellung_zugeordnet",
                    s.alt() == null ? null : stellungForm(s.alt().siteId(), s.alt().stellung(),
                            s.alt().unterzaehlerVonKennzeichen(), s.alt().gueltigAb(), s.alt().gueltigBis()),
                    stellungForm(neu.anlage(), neu.stellung(), neu.bezugKennzeichen(), s.neuAb(), s.neuBis()),
                    ab, zone, jetzt, a.grund(), wer);
            return id;
        }));
    }

    /** Eine Stellung, wie sie gespeichert würde; {@code bezugKennzeichen} so, wie die Anfrage ihn nennt. */
    private record Wert(UUID anlage, String stellung, UUID bezug, String bezugKennzeichen) {

        boolean gleich(StellungZeile z) {
            return z.siteId().equals(anlage) && z.stellung().equals(stellung)
                    && Objects.equals(z.unterzaehlerVon(), bezug);
        }
    }

    /**
     * Die Messstellen des Kundenbereichs, einmal gelesen — für die Liste je Tag und die Sätze;
     * {@code fuehrend}: je Messstelle die führenden Quellen ihrer HAUPTGRÖSSE (IP-13).
     */
    private record Stand(List<Messstelle> alle, Map<UUID, Messstelle> jeId, Map<String, Messstelle> jeKennzeichen,
            Map<UUID, String> anlagen, Map<UUID, List<MessstelleQuelleRepository.Quelle>> fuehrend) {}

    private Stand stand(Map<UUID, String> anlagen) {
        List<Messstelle> alle = messstellen.alle();
        Map<UUID, Messstelle> jeId = new HashMap<>();
        Map<String, Messstelle> jeKz = new HashMap<>();
        alle.forEach(x -> {
            jeId.put(x.id(), x);
            jeKz.put(x.kennzeichen(), x);
        });
        Map<UUID, List<MessstelleQuelleRepository.Quelle>> fuehrend = new HashMap<>();
        for (MessstelleQuelleRepository.Quelle q : quellen.alle()) {
            Messstelle x = jeId.get(q.messstelleId());
            if (x != null && "fuehrend".equals(q.rolle()) && x.hauptgroesse().groesse().equals(q.groesse())
                    && x.hauptgroesse().richtung().equals(q.richtung())) {
                fuehrend.computeIfAbsent(x.id(), k -> new ArrayList<>()).add(q);
            }
        }
        return new Stand(alle, jeId, jeKz, anlagen, fuehrend);
    }

    /** Ein Stellungs-Intervall im Stand NACH dem Schritt. */
    private record Iv(UUID messstelle, UUID anlage, String stellung, UUID bezug, LocalDate ab, LocalDate bis) {

        boolean deckt(LocalDate tag) {
            return !ab.isAfter(tag) && (bis == null || !tag.isAfter(bis));
        }
    }

    /**
     * Regel 8 an jedem Tag des neuen Intervalls, an dem sich im Stand etwas ändert: der Beginn
     * und jeder Tag, an dem eine andere Messstelle eine Stellung beginnt oder die ihre endet. Der
     * Stand dazwischen ist derselbe — ein Urteil je Abschnitt sieht jeden Tag.
     */
    private void regelnPruefen(Messstelle m, Wert neu, Schritt<StellungZeile> s, List<StellungZeile> alle, Stand stand) {
        List<Iv> nachher = new ArrayList<>();
        for (StellungZeile z : alle) {
            if (z.aufgehoben() || (s.aufheben() != null && z.id().equals(s.aufheben().id()))) {
                continue;
            }
            LocalDate bis = s.beenden() != null && z.id().equals(s.beenden().id())
                    ? s.neuAb().minusDays(1) : z.gueltigBis();
            nachher.add(new Iv(z.messstelleId(), z.siteId(), z.stellung(), z.unterzaehlerVon(), z.gueltigAb(), bis));
        }
        Iv eigen = new Iv(m.id(), neu.anlage(), neu.stellung(), neu.bezug(), s.neuAb(), s.neuBis());
        nachher.add(eigen);
        TreeSet<LocalDate> tage = new TreeSet<>(List.of(eigen.ab()));
        for (Iv iv : nachher) {
            if (iv.messstelle().equals(m.id())) {
                continue;
            }
            for (LocalDate d : iv.bis() == null ? List.of(iv.ab()) : List.of(iv.ab(), iv.bis().plusDays(1))) {
                if (d.isAfter(eigen.ab()) && eigen.deckt(d)) {
                    tage.add(d);
                }
            }
        }
        for (LocalDate tag : tage) {
            List<StellungEintrag> liste = new ArrayList<>();
            for (Messstelle x : stand.alle()) {
                nachher.stream().filter(iv -> iv.messstelle().equals(x.id()) && iv.deckt(tag)).findFirst()
                        .ifPresent(iv -> liste.add(eintrag(x, iv, stand, tag)));
            }
            StellungUrteil u = MessstelleRegeln.stellungPruefen(kandidat(m, tag, stand),
                    new Stellung(neu.anlage().toString(), neu.stellung(), neu.bezugKennzeichen()), liste);
            if (u.fehler() != null) {
                throw stellungAbgelehnt(u, m, neu, tag, stand);
            }
            for (StellungEintrag e : liste) {
                if (!UNTERZAEHLER.equals(e.stellung()) || !m.kennzeichen().equals(e.unterzaehlerVon())) {
                    continue;
                }
                Messstelle d = stand.jeKennzeichen().get(e.kennzeichen());
                StellungUrteil ud = MessstelleRegeln.stellungPruefen(kandidat(d, tag, stand),
                        new Stellung(e.anlage(), e.stellung(), e.unterzaehlerVon()), liste);
                if (ud.fehler() != null) {
                    throw betroffenAbgelehnt(ud, m, e, tag, stand);
                }
            }
        }
    }

    private static StellungEintrag eintrag(Messstelle x, Iv iv, Stand stand, LocalDate tag) {
        Messstelle bezug = iv.bezug() == null ? null : stand.jeId().get(iv.bezug());
        return new StellungEintrag(x.kennzeichen(), x.name(), iv.anlage().toString(), iv.stellung(),
                bezug == null ? null : bezug.kennzeichen(), x.hauptgroesse().richtung(), komponente(x, tag, stand));
    }

    private static StellungKandidat kandidat(Messstelle m, LocalDate tag, Stand stand) {
        return new StellungKandidat(m.kennzeichen(), m.art(), m.medium(), m.hauptgroesse().richtung(),
                komponente(m, tag, stand));
    }

    /**
     * Der Zähler, den die Messstelle an dem Tag liest: die Komponente der führenden Quelle ihrer
     * Hauptgröße (IP-13, {@code messstelle_quelle}) — die zu Beginn des Tages gilt, sonst die erste,
     * die an ihm beginnt (Zuordnungen gelten tagesgenau, Quellen auf die Minute). Ohne Quelle an
     * dem Tag unbekannt ({@code null}), und Regel 8 behandelt zwei Hauptzähler dann nie als
     * „derselbe Zähler“ (siehe Klassenkommentar).
     */
    private static String komponente(Messstelle m, LocalDate tag, Stand stand) {
        Instant beginn = tag.atStartOfDay(MessstelleService.ZEITZONE).toInstant();
        Instant ende = tag.plusDays(1).atStartOfDay(MessstelleService.ZEITZONE).toInstant();
        return stand.fuehrend().getOrDefault(m.id(), List.of()).stream()
                .filter(q -> q.gueltigAb().isBefore(ende) && (q.gueltigBis() == null || q.gueltigBis().isAfter(beginn)))
                .min(Comparator.comparing(MessstelleQuelleRepository.Quelle::gueltigAb))
                .map(q -> q.entityId().toString())
                .orElse(null);
    }

    // --------------------------------------------------------------- Stand am

    /**
     * Der Stand der Zuordnungen an einem Tag ({@code null} = heute): die Verortung des
     * Ortsbaum-Vertrags ({@link OrtsbaumAbleitung#verortung} — Ort, Pfad bis zum Standort, Grund)
     * und die Stellung, die an dem Tag gilt.
     */
    public MessstelleDto.StandortAm standortAm(UUID id, LocalDate am) {
        Messstelle m = finde(id);
        StandortService.Baum b = standorte.baum(ortsbaumMessstellen.messstellen());
        Ortsbaum baum = b.baum();
        LocalDate tag = am != null ? am : heute(uhr.instant(), baum.zeitzone());
        Verortung v = OrtsbaumAbleitung.verortung(baum, m.kennzeichen(), tag);
        String ortArt = v.ort() == null ? null
                : OrtsbaumAbleitung.UNTERNEHMEN.equals(v.ort()) ? MessstelleZuordnungRepository.UNTERNEHMEN
                : baum.ort(v.ort()).map(o -> o.art().code()).orElse(null);
        StellungZeile s = MessstelleService.wirksam(zuordnungen.stellungen(id)).stream()
                .filter(z -> z.deckt(tag)).findFirst().orElse(null);
        return new MessstelleDto.StandortAm(tag, v.ort(), ortArt, v.pfad(), v.standort(),
                v.standort() == null ? null : b.standorte().get(v.standort()),
                v.grund().name().toLowerCase(Locale.ROOT), s == null ? null : MessstelleService.stellungZuordnung(s));
    }

    // -------------------------------------------------------- Tages-Mechanik

    /**
     * Was ein Eintrag an den wirksamen Intervallen einer Zuordnung tut — oder warum er nicht
     * geht: dieselbe Mechanik und dieselben Gründe in derselben Reihenfolge wie
     * {@link OrtsbaumAbleitung#eintrag} (ohne das Ziel, das dort mitgeprüft wird).
     * {@code konflikt} ist das Intervall, an dem ein Grund hängt.
     */
    private record Schritt<T extends Tagesintervall>(EintragGrund grund, T konflikt, T beenden, T aufheben,
            T alt, LocalDate neuAb, LocalDate neuBis) {

        static <T extends Tagesintervall> Schritt<T> nein(EintragGrund grund, T konflikt) {
            return new Schritt<>(grund, konflikt, null, null, null, null, null);
        }
    }

    private static <T extends Tagesintervall> Schritt<T> schritt(List<T> wirksam, LocalDate ab, boolean korrektur,
            Predicate<T> gleicherWert) {
        if (korrektur) {
            T ersetzt = wirksam.stream().filter(z -> z.gueltigAb().equals(ab)).findFirst().orElse(null);
            if (ersetzt == null) {
                return Schritt.nein(EintragGrund.KEIN_BEGINN_AN_DEM_TAG, null);
            }
            if (gleicherWert.test(ersetzt)) {
                return Schritt.nein(EintragGrund.ZIEL_IST_BISHERIGER_ELTERN, ersetzt);
            }
            return new Schritt<>(null, null, null, ersetzt, ersetzt, ersetzt.gueltigAb(), ersetzt.gueltigBis());
        }
        if (wirksam.isEmpty()) {
            return new Schritt<>(null, null, null, null, null, ab, null);
        }
        T erster = wirksam.get(0);
        if (ab.isBefore(erster.gueltigAb())) {
            return Schritt.nein(EintragGrund.VOR_DEM_ERSTEN_INTERVALL, erster);
        }
        T laufend = wirksam.stream().filter(z -> z.deckt(ab)).findFirst().orElse(null);
        if (laufend == null) {
            return Schritt.nein(EintragGrund.OBJEKT_ARCHIVIERT, null);
        }
        if (laufend.gueltigAb().equals(ab)) {
            return Schritt.nein(EintragGrund.GLEICHER_TAG, laufend);
        }
        if (gleicherWert.test(laufend)) {
            return Schritt.nein(EintragGrund.ZIEL_IST_BISHERIGER_ELTERN, laufend);
        }
        return new Schritt<>(null, null, laufend, null, laufend, ab, laufend.gueltigBis());
    }

    /** Die Sätze der Tages-Mechanik für die Stellung — die des Ortsbaums, mit Stellung statt Ort. */
    private static String mechanikSatz(Schritt<StellungZeile> s, Messstelle m, LocalDate ab, Stand stand) {
        String anzeige = m.kennzeichen() + " " + MessstelleOrtsbaumMessstellen.anzeigename(m);
        String tag = OrtsbaumAbleitung.datumText(ab);
        return switch (s.grund()) {
            case VOR_DEM_ERSTEN_INTERVALL -> {
                String erster = OrtsbaumAbleitung.datumText(s.konflikt().gueltigAb());
                yield anzeige + " steht erst seit " + erster + " im elektrischen Baum. Wählen Sie ein Datum ab dem "
                        + erster + " — oder ersetzen Sie die Stellung ab Beginn (Korrektur).";
            }
            case OBJEKT_ARCHIVIERT -> "Am " + tag + " war " + anzeige + " archiviert.";
            case GLEICHER_TAG -> "Für den " + tag + " gibt es schon eine Stellung (" + stellungText(s.konflikt(), stand)
                    + "). Ändern Sie diese, statt eine zweite anzulegen.";
            case KEIN_BEGINN_AN_DEM_TAG -> "Am " + tag + " beginnt keine Stellung von " + anzeige
                    + ". Eine Korrektur ersetzt eine Stellung ab ihrem Beginn.";
            case ZIEL_IST_BISHERIGER_ELTERN -> anzeige + " ist bereits " + stellungText(s.konflikt(), stand) + ".";
            default -> throw new IllegalStateException("kein Grund der Tages-Mechanik: " + s.grund());
        };
    }

    /** „Unterzähler von MS-01 in Werk Ahrenberg – Halle 1“ · „Hauptzähler in …“ · „ohne elektrische Stellung in …“. */
    private static String stellungText(StellungZeile z, Stand stand) {
        String anlage = stand.anlagen().getOrDefault(z.siteId(), z.siteId().toString());
        if (UNTERZAEHLER.equals(z.stellung())) {
            return "Unterzähler von " + z.unterzaehlerVonKennzeichen() + " in " + anlage;
        }
        return (KEINE.equals(z.stellung()) ? "ohne elektrische Stellung" : z.stellung()) + " in " + anlage;
    }

    // ----------------------------------------------------------- Ablehnungen

    /**
     * Ein Grund des Ortsbaum-Vertrags als Antwort, Status nach AP-02 §5.10 und Messstellen-Vertrag
     * §7: das Ziel gab es an einem Tag nicht oder es war archiviert (422 {@code ort_ungueltig});
     * an dem Tag beginnt schon eine Zuordnung (409 {@code zuordnung_ueberlappt}); schon genau so
     * zugeordnet (400 {@code zuordnung_unveraendert}); sonst passt das „gültig ab“ nicht (422
     * {@code zuordnung_ungueltig}).
     */
    private static MessstelleAbgelehnt eintragAbgelehnt(EintragGrund grund, String satz, LocalDate ab) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("grund", grund.name().toLowerCase(Locale.ROOT));
        fakten.put("gueltig_ab", ab.toString());
        return switch (grund) {
            case ZIEL_ART_UNZULAESSIG, ZIEL_GAB_ES_NOCH_NICHT, ZIEL_ARCHIVIERT ->
                    MessstelleAbgelehnt.regel(Fehler.ORT_UNGUELTIG, satz, fakten);
            case GLEICHER_TAG -> MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUORDNUNG_UEBERLAPPT, satz, fakten);
            case ZIEL_IST_BISHERIGER_ELTERN ->
                    MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUORDNUNG_UNVERAENDERT, satz, fakten);
            default -> MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUORDNUNG_UNGUELTIG, satz, fakten);
        };
    }

    private static MessstelleAbgelehnt ortUngueltig(String grund, String satz) {
        return MessstelleAbgelehnt.regel(Fehler.ORT_UNGUELTIG, satz, Map.of("grund", grund));
    }

    /** Das Urteil von Regel 8 als Antwort: Code und Status des Vertrags, der Satz aus §5.12. */
    private static MessstelleAbgelehnt stellungAbgelehnt(StellungUrteil u, Messstelle m, Wert neu, LocalDate tag,
            Stand stand) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("tag", tag.toString());
        StellungEintrag e = u.bestehend();
        if (u.fehler() == Fehler.HAUPTZAEHLER_VORHANDEN) {
            fakten.put("bestehend", bestehend(e));
            String satz = anlageName(e.anlage(), stand) + " hat bereits einen Hauptzähler: " + nennung(e) + ". Wählen Sie "
                    + "„Unterzähler von " + e.kennzeichen() + "“ oder ändern Sie " + e.kennzeichen() + ".";
            if (!e.richtung().equals(m.hauptgroesse().richtung())
                    && (e.komponente() == null || komponente(m, tag, stand) == null)) {
                satz += " Ein zweiter Hauptzähler in anderer Richtung (" + m.hauptgroesse().richtung() + " neben "
                        + e.richtung() + ") ist nur erlaubt, wenn beide denselben Zähler lesen — das zeigt erst "
                        + "ihre führende Quelle.";
            }
            return MessstelleAbgelehnt.regel(Fehler.HAUPTZAEHLER_VORHANDEN, satz, fakten);
        }
        fakten.put("grund", u.grund());
        if (e != null) {
            fakten.put("bestehend", bestehend(e));
        }
        if (!u.kette().isEmpty()) {
            fakten.put("kette", u.kette());
        }
        String satz = switch (u.grund()) {
            case "nicht_elektrisch" -> m.kennzeichen() + (BERECHNET.equals(m.art()) ? " ist berechnet"
                    : " misst " + m.medium()) + " und steht nicht im elektrischen Baum. Wählen Sie die Stellung „keine“.";
            case "bezug_nur_bei_unterzaehler" -> "„Unterzähler von“ gibt es nur bei der Stellung „Unterzähler“.";
            case "bezug_fehlt" -> "Ein Unterzähler braucht die Messstelle, von der er Unterzähler ist.";
            case "selbst" -> "Eine Messstelle kann nicht ihr eigener Unterzähler sein.";
            case "fremde_anlage" -> (e != null
                    ? e.kennzeichen() + " gehört zu " + anlageName(e.anlage(), stand) + "."
                    : stand.jeKennzeichen().containsKey(neu.bezugKennzeichen())
                            ? neu.bezugKennzeichen() + " steht am " + OrtsbaumAbleitung.datumText(tag)
                                    + " in keiner Anlage."
                            : "Eine Messstelle „" + neu.bezugKennzeichen() + "“ gibt es in diesem Kundenbereich nicht.")
                    + " Ein Unterzähler kann nur auf eine Messstelle derselben Anlage zeigen.";
            case "zyklus" -> "„Unterzähler von“ ergäbe einen Kreis: " + String.join(" → ", u.kette())
                    + ". Eine Kette von Unterzählern endet an einer Messstelle, die selbst keiner ist.";
            default -> throw new IllegalStateException("unbekannter Stellungs-Grund: " + u.grund());
        };
        return MessstelleAbgelehnt.regel(Fehler.STELLUNG_UNGUELTIG, satz, fakten);
    }

    /** Eine Messstelle, die Unterzähler der geänderten ist, verlöre ihre Regel — die Änderung wird abgelehnt. */
    private static MessstelleAbgelehnt betroffenAbgelehnt(StellungUrteil ud, Messstelle m, StellungEintrag d,
            LocalDate tag, Stand stand) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("tag", tag.toString());
        fakten.put("grund", ud.fehler() == Fehler.STELLUNG_UNGUELTIG ? ud.grund() : ud.fehler().code());
        fakten.put("betroffen", bestehend(d));
        String satz = nennung(d) + " ist Unterzähler von " + m.kennzeichen() + " in " + anlageName(d.anlage(), stand)
                + ". Ändern Sie zuerst die Stellung von " + d.kennzeichen()
                + " — ein Unterzähler kann nur auf eine Messstelle derselben Anlage zeigen.";
        return MessstelleAbgelehnt.regel(ud.fehler(), satz, fakten);
    }

    /** Die bestehende Messstelle im Urteil: Kennzeichen, Name, Anlage (ihre ID). */
    private static Map<String, Object> bestehend(StellungEintrag e) {
        Map<String, Object> b = new LinkedHashMap<>();
        b.put("kennzeichen", e.kennzeichen());
        b.put("name", e.name());
        b.put("anlage", e.anlage());
        return b;
    }

    private static String nennung(StellungEintrag e) {
        return e.name() == null ? e.kennzeichen() : e.kennzeichen() + " " + e.name();
    }

    private static String anlageName(String anlage, Stand stand) {
        return stand.anlagen().getOrDefault(UUID.fromString(anlage), anlage);
    }

    // ----------------------------------------------------------------- Gerüst

    private Messstelle finde(UUID id) {
        return messstellen.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
    }

    private static LocalDate tag(LocalDate gueltigAb) {
        if (gueltigAb == null) {
            throw MessstelleAbgelehnt.anfrage("gueltig_ab", "„gültig ab“ fehlt: der Tag (JJJJ-MM-TT), ab dem die Zuordnung gilt.");
        }
        return gueltigAb;
    }

    /** Eine archivierte Messstelle bleibt, wie sie ist — auch ihre Zuordnungen (sie endeten mit dem Archiv). */
    private static void nichtArchiviert(Messstelle m) {
        if (m.archiviertAm() != null) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("angehalten_ab", MessstelleService.zeit(m.angehaltenAb()));
            fakten.put("archiviert_am", MessstelleService.zeit(m.archiviertAm()));
            throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUSTAND_PASST_NICHT, m.kennzeichen()
                    + " ist archiviert — eine archivierte Messstelle bleibt, wie sie ist.", fakten);
        }
    }

    /** Dieselbe Zeilensperre wie {@link OrtService}: alle Schreibvorgänge der Ortsstruktur nacheinander. */
    private void sperre() {
        jdbc.query("SELECT id FROM unternehmen FOR UPDATE", rs -> null);
    }

    /** Die Anlagen des Kundenbereichs (unter RLS) mit ihrem Namen. */
    private Map<UUID, String> anlagen() {
        Map<UUID, String> out = new LinkedHashMap<>();
        jdbc.query("SELECT id, name FROM site ORDER BY name, id",
                rs -> {
                    out.put(rs.getObject("id", UUID.class), rs.getString("name"));
                });
        return out;
    }

    private ZoneId zone() {
        return unternehmen.desKundenbereichs().map(u -> ZoneId.of(u.zeitzone())).orElse(MessstelleService.ZEITZONE);
    }

    private static LocalDate heute(Instant jetzt, ZoneId zone) {
        return jetzt.atZone(zone).toLocalDate();
    }

    /**
     * Schreibt und fängt das eine Rennen, das die Sperre nicht ausschließt (ein Schreiber ohne
     * sie): die Datenbank lehnt die Überlappung ab (23P01) — nie ein 500.
     */
    private <T> T schreibe(Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataIntegrityViolationException e) {
            if ("23P01".equals(sqlState(e))) {
                throw MessstelleAbgelehnt.schnittstelle(Schnittstelle.ZUORDNUNG_UEBERLAPPT,
                        "Für diesen Zeitraum wurde soeben eine andere Zuordnung eingetragen. Laden Sie die Messstelle neu.",
                        Map.of());
            }
            throw e;
        }
    }

    /** Das Intervall eines Orts in der Form des Vertrags ({@code $defs/ortZuordnung}). */
    private static Map<String, Object> ortForm(String art, String kennzeichen, LocalDate ab, LocalDate bis) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ort_art", art);
        m.put("kennzeichen", kennzeichen);
        m.put("gueltig_ab", ab.toString());
        m.put("gueltig_bis", bis == null ? null : bis.toString());
        return m;
    }

    /** Das Intervall einer Stellung in der Form des Vertrags ({@code $defs/stellungZuordnung}). */
    private static Map<String, Object> stellungForm(UUID anlage, String stellung, String bezug, LocalDate ab,
            LocalDate bis) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("anlage", anlage.toString());
        m.put("stellung", stellung);
        m.put("unterzaehler_von", bezug);
        m.put("gueltig_ab", ab.toString());
        m.put("gueltig_bis", bis == null ? null : bis.toString());
        return m;
    }

    /**
     * GENAU EIN Eintrag je Schreibvorgang: {@code gilt_ab} ist Mitternacht des Tages,
     * {@code rueckwirkend} rechnet {@link OrtsbaumAbleitung#rueckwirkung} (Tag vor dem Eintragstag).
     */
    private void protokoll(UUID tenant, UUID messstelle, String art, Map<String, Object> alt, Map<String, Object> neu,
            LocalDate giltAb, ZoneId zone, Instant jetzt, String grund, ProtokollAkteur wer) {
        boolean rueckwirkend = OrtsbaumAbleitung.rueckwirkung(new RueckwirkungEingang(
                OffsetDateTime.ofInstant(jetzt, zone), giltAb, null, zone, null)).art() == Rueckwirkung.RUECKWIRKEND;
        aenderungen.eintragen(new NeuerEintrag(tenant, messstelle, art, alsJson(alt), alsJson(neu),
                giltAb.atStartOfDay(zone).toInstant(), rueckwirkend,
                grund == null || grund.isBlank() ? null : grund, wer.sub(), wer.name(), wer.rolle(), wer.art()));
    }

    private String alsJson(Map<String, Object> werte) {
        if (werte == null) {
            return null;
        }
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }

    private static String sqlState(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException s && s.getSQLState() != null) {
                return s.getSQLState();
            }
        }
        return null;
    }
}
