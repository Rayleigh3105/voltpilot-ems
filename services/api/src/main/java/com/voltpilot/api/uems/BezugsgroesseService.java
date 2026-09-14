package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BezugsdatenRegeln.Fassungsverlauf;
import com.voltpilot.api.uems.BezugsdatenRegeln.Vorgang;
import com.voltpilot.api.uems.BezugsgroesseRegeln.Ablehnung;
import com.voltpilot.api.uems.BezugsgroesseRegeln.Entwurf;
import com.voltpilot.api.uems.BezugsgroesseRegeln.Urteil;
import com.voltpilot.api.uems.BezugsgroesseRepository.WertZeile;
import com.voltpilot.api.uems.BezugsgroesseRepository.Zeile;
import com.voltpilot.api.web.dto.BezugsgroesseDto;
import java.math.BigDecimal;
import java.sql.SQLException;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Bezugsgrößen-Schnittstelle (UEMS AP-09 IP-5): anlegen, ändern, archivieren, löschen — je
 * Schreibvorgang EINE Transaktion und GENAU EIN Protokolleintrag mit Urheber
 * ({@link ProtokollAkteur}); keiner bei einer Ablehnung oder einem unveränderten {@code PUT}. Dazu
 * das Lesemodell der Werte mit ihren Fassungen und der Herkunft je Fassung.
 *
 * <p><b>Keine zweite Regel-Logik.</b> M1–M6 und der Satz der Ablehnungen urteilt
 * {@link BezugsgroesseRegeln}; das Vokabular kommt aus {@code bezugsdaten_vokabular()}; den Stand
 * einer Fassungskette („wirksam bis Fassung 2“) und den wirksamen Betrag rechnet
 * {@link BezugsdatenRegeln#fassungen}. Hier steht nur, was die reinen Regeln nicht wissen können:
 * ob das Geltungsbereich-Objekt da ist, welche Kennzeichen je belegt waren, wie viele Werte es gibt.
 *
 * <p><b>Jede Ablehnung schreibt nichts:</b> geurteilt wird, BEVOR die erste Zeile geschrieben ist,
 * und die Datenbank-Wände (Kennzeichen-Belegung, M1-Fremdschlüssel, der Lösch-Trigger) werden im
 * Rennen auf dieselbe Ablehnung abgebildet — die Transaktion ist dann zurückgerollt.
 *
 * <p>Der Mandant ist die RLS: eine fremde Bezugsgröße ist nicht da (404 {@code nicht_gefunden}, nie 403).
 */
@Service
public class BezugsgroesseService {

    private static final TypeReference<List<String>> TEXTE = new TypeReference<>() {};

    private final BezugsgroesseRepository repo;
    private final BezugsflaecheLesemodell bezugsflaechen;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;

    public BezugsgroesseService(BezugsgroesseRepository repo, BezugsflaecheLesemodell bezugsflaechen,
            PlatformTransactionManager transactionManager, ObjectMapper json) {
        this.repo = repo;
        this.bezugsflaechen = bezugsflaechen;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    // ------------------------------------------------------------------------------ lesen

    /** Die Bezugsgrößen — und daneben die Bezugsflächen, die in der Ortsstruktur stehen (IP-6, gelesen). */
    public BezugsgroesseDto.Liste alle() {
        return new BezugsgroesseDto.Liste(repo.alle().stream().map(BezugsgroesseService::darstellung).toList(),
                bezugsflaechen.alle());
    }

    public BezugsgroesseDto.Bezugsgroesse eine(UUID id) {
        return darstellung(finde(id));
    }

    /**
     * Die Werte im Zeitraum (Tage, letzter einschließlich), je Schlüssel mit ihren Fassungen.
     * {@code lesart} {@code wirksam}: je Schlüssel nur die Fassung, die den wirksamen Betrag trägt,
     * mit ihrer Herkunft; {@code alle}: die ganze Kette.
     */
    public BezugsgroesseDto.Werte werte(UUID id, LocalDate von, LocalDate bis, String lesart) {
        if (von != null && bis != null && bis.isBefore(von)) {
            throw BezugsgroesseAbgelehnt.von(Ablehnung.ZEITRAUM_UNGUELTIG);
        }
        Zeile b = finde(id);
        Map<String, List<WertZeile>> jeSchluessel = new LinkedHashMap<>();
        for (WertZeile w : repo.werte(id, von, bis)) {
            jeSchluessel.computeIfAbsent(w.periodeVon() + "|" + w.zeitpunkt(), k -> new ArrayList<>()).add(w);
        }
        List<BezugsgroesseDto.Wert> werte = new ArrayList<>();
        for (List<WertZeile> kette : jeSchluessel.values()) {
            werte.add(wert(kette, "alle".equals(lesart)));
        }
        return new BezugsgroesseDto.Werte(b.id(), b.kennzeichen(), b.wertart(), b.einheit(), b.periodeArt(), von, bis,
                lesart, werte);
    }

    /**
     * Ein Schlüssel mit seiner Kette. Den Stand jeder Fassung und den wirksamen Betrag rechnet die
     * Regel {@code fassung} aus den gespeicherten Vorgängen — AUFGERUFEN, nicht nachgebaut.
     *
     * <p>⚠ Die Regel beschreibt Ketten, in denen jede Fassung ihre Vorfassung ersetzt und keine
     * Vier-Augen-Entscheidung steht. Trägt die Kette einen Vorschlag, eine Ablehnung oder einen
     * Freigeber, ist ihr Stand OFFEN ({@code stand_offen}, {@code stand} und
     * {@code wirksamer_betrag} {@code null}): wie eine freigegebene Berichtigung zählt, löst AP-09
     * IP-7 auf — dieses Lesemodell nimmt es nicht vorweg und zeigt die gespeicherten Fassungen.
     */
    private BezugsgroesseDto.Wert wert(List<WertZeile> kette, boolean alle) {
        WertZeile erste = kette.get(0);
        ZoneId zone = ZoneId.of(erste.zeitzone());
        Fassungsverlauf verlauf = ableitbar(kette) ? BezugsdatenRegeln.fassungen(false, kette.stream()
                .map(w -> new Vorgang(w.vorgang(), w.betrag(), w.begruendung(), w.actorName(), null, w.createdAt(),
                        w.herkunftArt(), w.importKennung()))
                .toList()) : null;
        if (verlauf != null && verlauf.fassungen().size() != kette.size()) {
            verlauf = null;
        }
        Integer wirksam = null;
        List<BezugsgroesseDto.Fassung> fassungen = new ArrayList<>();
        for (int i = 0; i < kette.size(); i++) {
            String stand = verlauf == null ? null : verlauf.fassungen().get(i).status();
            if (stand != null && !stand.startsWith("wirksam bis") && !BezugsdatenRegeln.VORSCHLAG.equals(stand)) {
                wirksam = kette.get(i).fassung();
            }
            fassungen.add(fassung(kette.get(i), stand, zone));
        }
        List<BezugsgroesseDto.Fassung> gezeigt = fassungen;
        if (!alle && verlauf != null && wirksam != null) {
            gezeigt = List.of(fassungen.get(wirksam - kette.get(0).fassung()));
        }
        return new BezugsgroesseDto.Wert(erste.periodeVon(), erste.periodeBis(),
                erste.zeitpunkt() == null ? null : erste.zeitpunkt().atZone(zone).toOffsetDateTime(),
                erste.zeitzone(), verlauf == null ? null : text(verlauf.wirksamerBetrag()),
                verlauf == null ? null : wirksam, verlauf == null, gezeigt);
    }

    /** Die Kette, die die Regel {@code fassung} beschreibt: lückenlos, jede ersetzt ihre Vorfassung, ohne Vier-Augen. */
    private static boolean ableitbar(List<WertZeile> kette) {
        for (int i = 0; i < kette.size(); i++) {
            WertZeile w = kette.get(i);
            boolean vierAugen = BezugsdatenRegeln.VORSCHLAG.equals(w.status())
                    || "abgelehnt".equals(w.status()) || w.freigeberName() != null;
            boolean folgt = w.fassung() == i + 1
                    && (i == 0 ? w.ersetztFassung() == null : Objects.equals(w.ersetztFassung(), i));
            if (vierAugen || !folgt) {
                return false;
            }
        }
        return true;
    }

    private BezugsgroesseDto.Fassung fassung(WertZeile w, String stand, ZoneId zone) {
        return new BezugsgroesseDto.Fassung(w.fassung(), w.vorgang(), w.status(), stand, text(w.betrag()),
                w.ersetztFassung(), w.begruendung(), kennzeichen(w.kennzeichenJson()),
                new BezugsgroesseDto.Herkunft(w.herkunftArt(), "eingabe".equals(w.herkunftArt()), w.importKennung(),
                        w.importZeile(), w.geliefertText(), w.geliefertEinheit()),
                new BezugsgroesseDto.Person(w.actorName(), w.actorRolle(), w.actorArt()),
                w.freigeberName() == null ? null
                        : new BezugsgroesseDto.Person(w.freigeberName(), w.freigeberRolle(), w.freigeberArt()),
                w.createdAt().atZone(zone).toOffsetDateTime());
    }

    // ------------------------------------------------------------ Stammdatum (E15, IP-6)

    /**
     * Die Intervalle eines Stammdatums, das AP-09 selbst hält — und, wenn {@code periodeArt} genannt ist, der
     * Wert je Periode am Stichtag mit den Übergängen (S3), gerechnet von {@link BezugsdatenRegeln#stammdatum}.
     * Eine Bezugsgröße, die kein Stammdatum ist, hat keine Gültigkeiten (422 {@code kein_stammdatum}).
     */
    public BezugsgroesseDto.Stammdatum stammdatum(UUID id, String periodeArt, LocalDate von, LocalDate bis) {
        Zeile b = finde(id);
        if (!BezugsgroesseRegeln.STAMMDATUM.equals(b.wertart())) {
            throw new BezugsgroesseAbgelehnt(Ablehnung.KEIN_STAMMDATUM, Map.of("wertart", b.wertart()));
        }
        boolean mitPerioden = periodeArt != null || von != null || bis != null;
        List<String> perioden = mitPerioden
                ? BezugsflaecheLesemodell.perioden(periodeArt, von, bis, repo.vokabular().periodeArten())
                : List.of();
        return stammdatumDarstellung(b, perioden, mitPerioden ? periodeArt : null, von, bis);
    }

    /**
     * E15/S4: ein Wert ab einem Tag — die Mechanik der Bezugsfläche: das laufende Intervall endet am Vortag, ein
     * Wert am Beginntag eines Intervalls hebt es auf (Korrektur), derselbe Wert schreibt nichts. Erst beenden
     * bzw. aufheben, dann eintragen (die Exklusion sieht jeden Zwischenstand); GENAU EIN Protokolleintrag
     * {@code stammdatum_eingetragen} mit „gilt ab“ und „rückwirkend“. Die Bezugsfläche kommt hier nie an: eine
     * Bezugsgröße in m² gibt es nicht (M4), und die Tabelle lehnt sie zusätzlich ab.
     */
    public BezugsgroesseDto.Stammdatum stammdatumEintragen(UUID id, String wertText, LocalDate gueltigAb,
            ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        schreibe(() -> transaktion.execute(s -> {
            repo.kundenbereichSperren(tenant);
            Zeile b = repo.sperre(id).orElseThrow(() -> BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
            pruefe(BezugsgroesseRegeln.stammdatum(entwurf(b), b.archiviertAm() != null, wertText, repo.vokabular()));
            BigDecimal wert = BezugsgroesseRegeln.stammdatumWert(wertText);
            List<BezugsgroesseRepository.StammdatumZeile> wirksame = repo.stammdaten(id).stream()
                    .filter(z -> !z.aufgehoben())
                    .toList();
            BezugsdatenRegeln.StammdatumEintrag e = BezugsdatenRegeln.stammdatumEintrag(wirksame.stream()
                    .map(z -> new BezugsdatenRegeln.Intervall(z.wert(), z.gueltigAb(), z.gueltigBis(), null))
                    .toList(), gueltigAb, wert);
            if (e.unveraendert()) {
                return id;
            }
            Map<String, Object> alt = null;
            BezugsdatenRegeln.Intervall ersetzt = e.beendet() != null ? e.beendet() : e.aufgehoben();
            if (ersetzt != null) {
                BezugsgroesseRepository.StammdatumZeile zeile = wirksame.stream()
                        .filter(z -> z.gueltigAb().equals(ersetzt.gueltigAb()))
                        .findFirst()
                        .orElseThrow();
                alt = intervallFelder(zeile.wert(), zeile.gueltigAb(), zeile.gueltigBis());
                if (e.beendet() != null) {
                    repo.stammdatumBeenden(zeile.id(), e.beendet().gueltigBis());
                } else {
                    repo.stammdatumAufheben(zeile.id());
                }
            }
            repo.stammdatumEintragen(tenant, id, b.wertart(), b.einheit(), wert, e.neu().gueltigAb(),
                    e.neu().gueltigBis(), wer.sub());
            ZoneId zone = ZoneId.of(repo.zeitzone(id));
            Map<String, Object> neu = intervallFelder(wert, e.neu().gueltigAb(), e.neu().gueltigBis());
            neu.put("korrektur", e.korrektur());
            boolean rueckwirkend = gueltigAb.isBefore(LocalDate.now(zone));
            repo.protokoll(tenant, id, "stammdatum_eingetragen", alsJson(alt), alsJson(neu),
                    gueltigAb.atStartOfDay(zone).toInstant(), rueckwirkend, wer);
            return id;
        }));
        return stammdatum(id, null, null, null);
    }

    private BezugsgroesseDto.Stammdatum stammdatumDarstellung(Zeile b, List<String> perioden, String periodeArt,
            LocalDate von, LocalDate bis) {
        ZoneId zone = ZoneId.of(repo.zeitzone(b.id()));
        List<BezugsgroesseRepository.StammdatumZeile> zeilen = repo.stammdaten(b.id());
        List<BezugsgroesseDto.StammdatumIntervall> intervalle = zeilen.stream()
                .map(z -> new BezugsgroesseDto.StammdatumIntervall(text(z.wert()), z.gueltigAb(), z.gueltigBis(),
                        zeit(z.aufgehobenAm(), zone), zeit(z.createdAt(), zone), abzeichen(z, zone)))
                .toList();
        List<BezugsgroesseRepository.StammdatumZeile> wirksame = zeilen.stream().filter(z -> !z.aufgehoben()).toList();
        List<BezugsgroesseDto.Stichtagwert> werte = new ArrayList<>();
        if (!perioden.isEmpty()) {
            BezugsdatenRegeln.Stammdatenstand stand = BezugsdatenRegeln.stammdatum(wirksame.stream()
                    .map(z -> new BezugsdatenRegeln.Intervall(z.wert(), z.gueltigAb(), z.gueltigBis(),
                            z.createdAt().atZone(zone).toLocalDate()))
                    .toList(), perioden, periodeArt, b.name(), b.einheit());
            for (String p : perioden) {
                LocalDate stichtag = stand.stichtage().get(p);
                BezugsgroesseRepository.StammdatumZeile gilt = wirksame.stream()
                        .filter(z -> !stichtag.isBefore(z.gueltigAb())
                                && (z.gueltigBis() == null || !stichtag.isAfter(z.gueltigBis())))
                        .findFirst()
                        .orElse(null);
                werte.add(new BezugsgroesseDto.Stichtagwert(p, BezugsPeriode.spanneVon(p, periodeArt)[0], stichtag,
                        text(stand.jePeriode().get(p)), null, gilt == null ? null : gilt.gueltigAb(),
                        gilt == null ? null : gilt.createdAt().atZone(zone).toLocalDate(),
                        gilt == null ? null : abzeichen(gilt, zone), stand.kennzeichen().get(p)));
            }
        }
        return new BezugsgroesseDto.Stammdatum(b.id(), b.kennzeichen(), b.name(), b.einheit(), zone.getId(),
                b.archiviertAm() == null, intervalle, periodeArt, von, bis, werte);
    }

    /** „rückwirkend (n Tage)“ — die Regel der Ortsstruktur (AP-02 E2), aufgerufen. */
    private static String abzeichen(BezugsgroesseRepository.StammdatumZeile z, ZoneId zone) {
        return OrtsbaumAbleitung.rueckwirkung(new OrtsbaumAbleitung.RueckwirkungEingang(
                z.createdAt().atZone(zone).toOffsetDateTime(), z.gueltigAb(), z.gueltigBis(), zone, null)).abzeichen();
    }

    private static Map<String, Object> intervallFelder(BigDecimal wert, LocalDate ab, LocalDate bis) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("wert", text(wert));
        m.put("gueltig_ab", ab.toString());
        m.put("gueltig_bis", bis == null ? null : bis.toString());
        return m;
    }

    private static OffsetDateTime zeit(Instant t, ZoneId zone) {
        return t == null ? null : t.atZone(zone).toOffsetDateTime();
    }

    // ---------------------------------------------------------------------------- anlegen

    /**
     * Legt an. Ohne Kennzeichen vergibt der Server das nächste nach der höchsten je belegten Nummer
     * (M2) — unter der Sperre des Kundenbereichs, in DERSELBEN Transaktion wie der Protokolleintrag.
     */
    public BezugsgroesseDto.Bezugsgroesse anlegen(Entwurf e, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        UUID id = schreibe(() -> transaktion.execute(s -> {
            repo.kundenbereichSperren(tenant);
            List<String> jeBelegt = repo.jeBelegt();
            pruefe(BezugsgroesseRegeln.anlegen(e, repo.vokabular(), BezugsgroesseRegeln.GELTUNG_WAEHLBAR, jeBelegt));
            UUID geltung = geltungDa(e);
            Entwurf mitKennzeichen = e.kennzeichen() != null ? e : new Entwurf(
                    BezugsgroesseRegeln.kennzeichenVorschlag(jeBelegt), e.name(), e.wertart(), e.einheit(),
                    e.periodeArt(), e.geltungArt(), e.geltungId());
            UUID neu = repo.anlegen(tenant, mitKennzeichen, geltung);
            repo.protokoll(tenant, neu, "angelegt", null, alsJson(felder(mitKennzeichen)), wer);
            return neu;
        }));
        return eine(id);
    }

    // ----------------------------------------------------------------------------- ändern

    /** Ändert die ganze Bezugsgröße; ein unverändertes {@code PUT} schreibt nichts, auch kein Protokoll. */
    public BezugsgroesseDto.Bezugsgroesse aendern(UUID id, Entwurf neu, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        schreibe(() -> transaktion.execute(s -> {
            repo.kundenbereichSperren(tenant);
            Zeile b = repo.sperre(id).orElseThrow(() -> BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
            Entwurf bestand = entwurf(b);
            pruefe(BezugsgroesseRegeln.aendern(bestand, neu, b.archiviertAm() != null, repo.werteZahl(id),
                    repo.vokabular(), BezugsgroesseRegeln.GELTUNG_WAEHLBAR, repo.belegtVonAnderen(id)));
            UUID geltung = geltungDa(neu);
            Map<String, Object> alt = felder(bestand);
            Map<String, Object> jetzt = felder(neu);
            Map<String, Object> altGeaendert = new LinkedHashMap<>();
            Map<String, Object> neuGeaendert = new LinkedHashMap<>();
            for (String feld : jetzt.keySet()) {
                if (!Objects.equals(alt.get(feld), jetzt.get(feld))) {
                    altGeaendert.put(feld, alt.get(feld));
                    neuGeaendert.put(feld, jetzt.get(feld));
                }
            }
            if (!neuGeaendert.isEmpty()) {
                repo.aendern(id, neu, geltung);
                repo.protokoll(tenant, id, "bearbeitet", alsJson(altGeaendert), alsJson(neuGeaendert), wer);
            }
            return id;
        }));
        return eine(id);
    }

    // ------------------------------------------------------------------ archivieren, löschen

    /** M6: archiviert — die Werte bleiben lesbar, das Kennzeichen belegt. */
    public BezugsgroesseDto.Bezugsgroesse archivieren(UUID id, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        transaktion.executeWithoutResult(s -> {
            Zeile b = repo.sperre(id).orElseThrow(() -> BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
            pruefe(BezugsgroesseRegeln.archivieren(b.archiviertAm() != null));
            repo.archivieren(id);
            repo.protokoll(tenant, id, "archiviert", null, null, wer);
        });
        return eine(id);
    }

    /**
     * M6: gelöscht wird nur eine Bezugsgröße ohne einen einzigen Wert. Ihr Kennzeichen bleibt als
     * Grabstein belegt; das Protokoll behält den Eintrag „geloescht“ mit dem letzten Stand.
     */
    public void loeschen(UUID id, ProtokollAkteur wer) {
        UUID tenant = TenantContext.get();
        schreibe(() -> transaktion.execute(s -> {
            Zeile b = repo.sperre(id).orElseThrow(() -> BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
            pruefe(BezugsgroesseRegeln.loeschen(repo.werteZahl(id)));
            repo.loeschen(id);
            repo.protokoll(tenant, id, "geloescht", alsJson(felder(entwurf(b))), null, wer);
            return id;
        }));
    }

    // ----------------------------------------------------------------------------- Gerüst

    private Zeile finde(UUID id) {
        return repo.finde(id).orElseThrow(() -> BezugsgroesseAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    private static void pruefe(Urteil u) {
        if (!u.erlaubt()) {
            throw BezugsgroesseAbgelehnt.aus(u);
        }
    }

    /** Das Objekt des Geltungsbereichs: eine ID, und es ist im Kundenbereich da — sonst 400 bzw. 422. */
    private UUID geltungDa(Entwurf e) {
        UUID id;
        try {
            id = UUID.fromString(e.geltungId().strip());
        } catch (IllegalArgumentException ex) {
            throw BezugsgroesseAbgelehnt.anfrage("geltung_id");
        }
        if (!repo.geltungDa(e.geltungArt(), id)) {
            throw new BezugsgroesseAbgelehnt(Ablehnung.GELTUNG_UNBEKANNT, Map.of("feld", "geltung_id"));
        }
        return id;
    }

    /**
     * Schreibt und bildet die Datenbank-Wände im Rennen auf die Ablehnung der Regel ab: Kennzeichen
     * belegt (Unique/Primärschlüssel), die Bedeutung nach dem ersten Wert (M1), Werte beim Löschen (M6).
     */
    private static <T> T schreibe(Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataIntegrityViolationException e) {
            String meldung = meldung(e);
            if (meldung.contains("\"bezugsgroesse_kennzeichen_")) {
                throw new BezugsgroesseAbgelehnt(Ablehnung.KENNZEICHEN_BELEGT, Map.of("feld", "kennzeichen"));
            }
            if (meldung.contains("\"bezugsgroesse_wert_bedeutung_fk\"") || meldung.contains("\"bezugsgroesse_wert_periode_fk\"")
                    || meldung.contains("\"bezugsgroesse_stammdatum_bedeutung_fk\"")
                    || meldung.contains("hat Werte und ist nicht mehr änderbar")) {
                throw BezugsgroesseAbgelehnt.von(Ablehnung.BEDEUTUNG_FEST);
            }
            if (meldung.contains("trägt Werte und wird nicht gelöscht")) {
                throw BezugsgroesseAbgelehnt.von(Ablehnung.HAT_WERTE);
            }
            throw e;
        }
    }

    /**
     * Die Meldungen der Datenbank in der Kette: ein Unique- oder Fremdschlüssel nennt seinen Namen in
     * Anführungszeichen, die Trigger der Migrationen V20260913104500/V20260913120000 ihren Satz.
     */
    private static String meldung(Throwable e) {
        StringBuilder s = new StringBuilder();
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (t instanceof SQLException && t.getMessage() != null) {
                s.append(t.getMessage()).append('\n');
            }
        }
        return s.toString();
    }

    private static Entwurf entwurf(Zeile b) {
        return new Entwurf(b.kennzeichen(), b.name(), b.wertart(), b.einheit(), b.periodeArt(), b.geltungArt(),
                b.geltungId().toString());
    }

    /** Die Felder im Protokoll, snake_case wie die Schnittstelle. */
    private static Map<String, Object> felder(Entwurf e) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", e.kennzeichen());
        m.put("name", e.name());
        m.put("wertart", e.wertart());
        m.put("einheit", e.einheit());
        m.put("periode_art", e.periodeArt());
        m.put("geltung_art", e.geltungArt());
        m.put("geltung_id", e.geltungId() == null ? null : e.geltungId().strip());
        return m;
    }

    private static BezugsgroesseDto.Bezugsgroesse darstellung(Zeile b) {
        return new BezugsgroesseDto.Bezugsgroesse(b.id(), b.kennzeichen(), b.name(), b.wertart(), b.einheit(),
                b.periodeArt(), b.geltungArt(), b.geltungId(), b.geltungName(), b.hatWerte(),
                zeit(b.archiviertAm()), zeit(b.angelegtAm()));
    }

    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : t.atZone(BezugsdatenRegeln.ANZEIGE_ZEITZONE).toOffsetDateTime();
    }

    /** Ein Betrag als Dezimaltext ohne überflüssige Nullen — nie Gleitkomma. */
    private static String text(BigDecimal b) {
        return b == null ? null : b.stripTrailingZeros().toPlainString();
    }

    private List<String> kennzeichen(String jsonArray) {
        try {
            return jsonArray == null ? List.of() : json.readValue(jsonArray, TEXTE);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Kennzeichen eines Werts nicht lesbar", e);
        }
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
}
