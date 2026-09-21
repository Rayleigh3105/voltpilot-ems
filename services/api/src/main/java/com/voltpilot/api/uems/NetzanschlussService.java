package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.NetzanschlussAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.NetzanschlussRepository.Anschluss;
import com.voltpilot.api.uems.NetzanschlussRepository.Bindung;
import com.voltpilot.api.uems.NetzanschlussRepository.Felder;
import com.voltpilot.api.web.dto.NetzanschlussDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Der Netzanschluss als eigenes Objekt am Standort und seine Bindung an eine Anlage (UEMS AP-10 IP-6,
 * Konzept §4.2, §5.1; Entscheid E8 = A). Die Regeln kommen AUSSCHLIESSLICH aus
 * {@link NetzanschlussRegeln} (Kennzeichen wie AP-00 E10, Marktlokation, Felder, Bindung) — hier wird
 * nichts neu formuliert, nur gelesen, angerufen und geschrieben. Die Datenbank
 * ({@code V20260913235000}) hält dieselben Grenzen noch einmal: zwei Exklusionen (je Anlage UND je
 * Anschluss), die Kennzeichen-Belegung, „nie länger als ihr Anschluss“.
 *
 * <p>⚠ <b>Eine Anlage hängt an jedem Tag an genau EINEM Anschluss.</b> Eine zweite Bindung derselben
 * Anlage am selben Tag ist 409 {@code bindung_ueberlappt}; ein Wechsel beendet die laufende Bindung am
 * VORTAG — nichts wird überschrieben.
 *
 * <p>Jeder Schreibvorgang läuft unter der Sperre des Unternehmens (wie Ortsstruktur und Kostenstelle) und
 * schreibt GENAU EINEN Eintrag in {@code netzanschluss_aenderung}; eine Ablehnung schreibt nichts.
 *
 * <p><b>Nicht hier (W9):</b> die Preis- und Grenzspalten der Anlage bleiben unberührt.
 */
@Service
public class NetzanschlussService {

    static final String ANGELEGT = "angelegt";
    static final String BEARBEITET = "bearbeitet";
    static final String GEBUNDEN = "gebunden";
    static final String ANLAGE_ENTFERNT = "anlage_entfernt";

    private final NetzanschlussRepository repo;
    private final StandortRepository standorte;
    private final UnternehmenRepository unternehmen;
    private final ObjectMapper json;
    private final TransactionTemplate transaktion;
    private volatile Clock uhr = Clock.systemUTC();
    /** AP-15 IP-3 Folgepaket: der Grenzblatt-Anstoß nach einer Bindung; ohne (Einzeltests) reist nichts. */
    private volatile ObjectProvider<ChargingConfigService> ladepark;

    private static final Logger log = LoggerFactory.getLogger(NetzanschlussService.class);

    public NetzanschlussService(NetzanschlussRepository repo, StandortRepository standorte,
            UnternehmenRepository unternehmen, ObjectMapper json, PlatformTransactionManager transactionManager) {
        this.repo = repo;
        this.standorte = standorte;
        this.unternehmen = unternehmen;
        this.json = json;
        this.transaktion = new TransactionTemplate(transactionManager);
    }

    /** Nur für Tests: die Uhr, an der „heute“ und „rückwirkend“ hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Setter statt Konstruktor: bestehende Aufrufer und Tests bauen den Dienst unverändert. */
    @Autowired(required = false)
    void ladeparkLesen(ObjectProvider<ChargingConfigService> ladepark) {
        this.ladepark = ladepark;
    }

    // ------------------------------------------------------------------------ lesen

    /** Die Anschlüsse eines Standorts — mit {@code stichtag} nur die an dem Tag bestehenden. */
    public NetzanschlussDto.Netzanschluesse liste(UUID standortId, LocalDate stichtag) {
        StandortRepository.Standort s = standort(standortId);
        String vorschlag = NetzanschlussRegeln.kennzeichen(null, belegt(null), repo.zaehler()).vorschlag().kennzeichen();
        List<NetzanschlussDto.Netzanschluss> liste = repo.amStandort(standortId).stream()
                .filter(a -> stichtag == null || besteht(a, stichtag))
                .map(a -> darstellung(a, s, stichtag))
                .toList();
        return new NetzanschlussDto.Netzanschluesse(verweis(s), stichtag, vorschlag, liste);
    }

    public NetzanschlussDto.Netzanschluss netzanschluss(UUID standortId, UUID id) {
        StandortRepository.Standort s = standort(standortId);
        return darstellung(anschluss(s, id), s, null);
    }

    // --------------------------------------------------------------------- schreiben

    /**
     * Legt einen Netzanschluss am Standort an. Reihenfolge: Standort da (404) → Form (400) → Felder des
     * Vertrags (400 {@code anfrage_ungueltig} mit {@code feld}, die Marktlokation 422 {@code malo_form}) →
     * Zeitraum (422) → Kennzeichen (422 {@code kennzeichen_format} / 409 {@code kennzeichen_belegt};
     * ohne Kennzeichen vergibt die Regel das nächste freie {@code NA-0001} unter der Sperre des Zählers).
     */
    public UUID anlegen(UUID standortId, NetzanschlussDto.Anschluss a, ProtokollAkteur wer) {
        StandortRepository.Standort s = standort(standortId);
        Felder f = felder(a, s, false);
        UUID tenant = TenantContext.get();
        return schreibe(() -> transaktion.execute(tx -> {
            sperre();
            int zaehler = repo.zaehlerSperren(tenant);
            NetzanschlussRegeln.KennzeichenUrteil k = NetzanschlussRegeln.kennzeichen(f.kennzeichen(), belegt(null), zaehler);
            if (!k.gueltig()) {
                throw kennzeichen(k.fehler(), f.kennzeichen());
            }
            Felder mitKennzeichen = k.vorschlag() == null ? f : new Felder(k.vorschlag().kennzeichen(), f.name(),
                    f.malo(), f.netzbetreiber(), f.anschlussKva(), f.vereinbartKw(), f.messung(), f.gueltigAb(),
                    f.gueltigBis());
            UUID id = repo.anlegen(tenant, standortId, mitKennzeichen, wer.sub());
            if (k.vorschlag() != null) {
                repo.zaehlerSetzen(tenant, k.vorschlag().zaehler());
            }
            repo.protokoll(tenant, id, ANGELEGT, null, alsJson(form(mitKennzeichen)), uhr.instant(), false,
                    null, wer);
            return id;
        }));
    }

    /**
     * Bearbeitet einen Netzanschluss — die ganze Menge. Ein neues Kennzeichen prüft die Regel gegen jedes
     * Kennzeichen, das ein ANDERER Anschluss trägt oder trug (das eigene frühere ist frei); ein Ende wird nur
     * vorgezogen (409 {@code bereits_beendet}); Tage, die eine Bindung abschnitten, sind 409
     * {@code bindung_besteht} mit JEDER davon. Ohne Änderung: nichts geschrieben, kein Protokoll.
     */
    public void bearbeiten(UUID standortId, UUID id, NetzanschlussDto.Anschluss a, ProtokollAkteur wer) {
        StandortRepository.Standort s = standort(standortId);
        Felder f = felder(a, s, true);
        UUID tenant = TenantContext.get();
        schreibe(() -> transaktion.execute(tx -> {
            sperre();
            Anschluss alt = anschluss(s, id);
            if (!f.kennzeichen().equals(alt.kennzeichen())) {
                NetzanschlussRegeln.KennzeichenUrteil k = NetzanschlussRegeln.kennzeichen(f.kennzeichen(), belegt(id), 0);
                if (!k.gueltig()) {
                    throw kennzeichen(k.fehler(), f.kennzeichen());
                }
            }
            if (alt.gueltigBis() != null && (f.gueltigBis() == null || f.gueltigBis().isAfter(alt.gueltigBis()))) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("kennzeichen", alt.kennzeichen());
                fakten.put("gueltig_bis", alt.gueltigBis().toString());
                throw new NetzanschlussAbgelehnt(Ablehnung.BEREITS_BEENDET, fakten);
            }
            if (!Objects.equals(f.gueltigAb(), alt.gueltigAb()) || !Objects.equals(f.gueltigBis(), alt.gueltigBis())) {
                List<Bindung> imWeg = repo.ausserhalb(tenant, id, f.gueltigAb(), f.gueltigBis());
                if (!imWeg.isEmpty()) {
                    throw bindungBesteht(alt, imWeg);
                }
            }
            Map<String, Object> vorher = form(bestand(alt));
            Map<String, Object> nachher = form(f);
            Map<String, Object> altDiff = new LinkedHashMap<>();
            Map<String, Object> neuDiff = new LinkedHashMap<>();
            nachher.forEach((feld, wert) -> {
                if (!Objects.equals(vorher.get(feld), wert)) {
                    altDiff.put(feld, vorher.get(feld));
                    neuDiff.put(feld, wert);
                }
            });
            if (neuDiff.isEmpty()) {
                return id;
            }
            repo.bearbeiten(id, f);
            repo.protokoll(tenant, id, BEARBEITET, alsJson(altDiff), alsJson(neuDiff), uhr.instant(), false, null, wer);
            return id;
        }));
    }

    /**
     * Bindet eine Anlage ab einem Tag an diesen Netzanschluss. Das Urteil spricht
     * {@link NetzanschlussRegeln#bindung} über ALLE wirksamen Bindungen der Anlage und des Anschlusses:
     * eine zweite Bindung derselben Anlage am selben Tag → 409 {@code bindung_ueberlappt}; ein Anschluss,
     * der an einem der Tage an einer anderen Anlage hängt → 409 {@code anschluss_belegt}; beginnt die neue
     * nach der laufenden, endet die laufende am VORTAG. Die neue Bindung endet mit ihrem Anschluss.
     * GENAU EIN Protokolleintrag {@code gebunden} (alt = die beendete, neu = die neue).
     */
    public void binden(UUID standortId, UUID netzanschlussId, NetzanschlussDto.Binden b, ProtokollAkteur wer) {
        StandortRepository.Standort s = standort(standortId);
        if (b == null) {
            throw NetzanschlussAbgelehnt.anfrage("");
        }
        UUID anlage = uuid("anlage_id", pflicht("anlage_id", b.anlageId()));
        LocalDate ab = tag("gueltig_ab", pflicht("gueltig_ab", b.gueltigAb()));
        String grund = b.grund() == null || b.grund().isBlank() ? null : b.grund().strip();
        UUID tenant = TenantContext.get();
        ZoneId zone = ZoneId.of(s.zeitzone());
        schreibe(() -> transaktion.execute(tx -> {
            sperre();
            Anschluss na = anschluss(s, netzanschlussId);
            String anlagenName = repo.anlagenName(anlage).orElseThrow(() ->
                    new NetzanschlussAbgelehnt(Ablehnung.ANLAGE_UNBEKANNT, Map.of("feld", "anlage_id")));
            if ((na.gueltigAb() != null && ab.isBefore(na.gueltigAb()))
                    || (na.gueltigBis() != null && ab.isAfter(na.gueltigBis()))) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("kennzeichen", na.kennzeichen());
                fakten.put("besteht_ab", na.gueltigAb() == null ? null : na.gueltigAb().toString());
                fakten.put("besteht_bis", na.gueltigBis() == null ? null : na.gueltigBis().toString());
                fakten.put("gueltig_ab", ab.toString());
                throw new NetzanschlussAbgelehnt(Ablehnung.NETZANSCHLUSS_BESTEHT_NICHT, fakten);
            }
            List<Bindung> vorher = repo.bindungenVon(anlage, netzanschlussId);
            NetzanschlussRegeln.Bindung neu = new NetzanschlussRegeln.Bindung(anlage.toString(),
                    netzanschlussId.toString(), ab, na.gueltigBis());
            LocalDate heute = uhr.instant().atZone(zone).toLocalDate();
            NetzanschlussRegeln.BindungUrteil urteil = NetzanschlussRegeln.bindung(
                    vorher.stream().map(NetzanschlussService::regel).toList(), neu, heute);
            if (urteil.fehler() != null) {
                Map<String, Object> fakten = new LinkedHashMap<>();
                fakten.put("anlage_id", anlage.toString());
                fakten.put("netzanschluss", na.kennzeichen());
                fakten.put("gueltig_ab", ab.toString());
                fakten.put("bindungen", vorher.stream().map(NetzanschlussService::bindungForm).toList());
                throw new NetzanschlussAbgelehnt(Ablehnung.zuCode(urteil.fehler()), fakten);
            }
            Map<String, Object> alt = null;
            if (urteil.beendet() != null) {
                Bindung laufend = vorher.stream()
                        .filter(x -> x.siteId().equals(anlage) && x.laeuftAm(ab))
                        .findFirst().orElseThrow();
                repo.bindungBeenden(laufend.id(), urteil.beendet().gueltigBis());
                alt = bindungForm(laufend);
                alt.put("gueltig_bis", urteil.beendet().gueltigBis().toString());
            }
            repo.bindungEintragen(tenant, anlage, netzanschlussId, ab, urteil.eintrag().gueltigBis(), wer.sub());
            Map<String, Object> eintrag = new LinkedHashMap<>();
            eintrag.put("anlage_id", anlage.toString());
            eintrag.put("anlage_name", anlagenName);
            eintrag.put("netzanschluss", na.kennzeichen());
            eintrag.put("gueltig_ab", ab.toString());
            eintrag.put("gueltig_bis", urteil.eintrag().gueltigBis() == null ? null : urteil.eintrag().gueltigBis().toString());
            repo.protokoll(tenant, netzanschlussId, GEBUNDEN, alt == null ? null : alsJson(alt), alsJson(eintrag),
                    ab.atStartOfDay(zone).toInstant(), urteil.rueckwirkend(), grund, wer);
            return netzanschlussId;
        }));
        nachCommit(() -> netzgrenzeNachziehen(tenant, anlage));
    }

    /**
     * Gebunden, umgebunden oder beendet: ändert das den HEUTE wirksamen Bezug der Anlage, reist ihr Ladepark-Dokument
     * neu ({@link ChargingConfigService#netzgrenzeNachziehen} — nur mit Rahmen, nur bei anderem Wert). Eine Bindung
     * ab einem späteren Tag stellt der Tageslauf zu. Ein Fehler der Zustellung nimmt die Bindung nicht zurück.
     */
    private void netzgrenzeNachziehen(UUID tenant, UUID anlage) {
        ObjectProvider<ChargingConfigService> p = ladepark;
        ChargingConfigService dienst = p == null ? null : p.getIfAvailable();
        if (dienst == null) {
            return;
        }
        UUID vorher = TenantContext.get();
        try {
            TenantContext.set(tenant);
            dienst.netzgrenzeNachziehen(tenant, anlage);
        } catch (RuntimeException e) {
            log.warn("Ladepark-Dokument nach neuer Bindung nicht zugestellt (Anlage {}): {}", anlage, e.getMessage());
        } finally {
            if (vorher == null) {
                TenantContext.clear();
            } else {
                TenantContext.set(vorher);
            }
        }
    }

    /** Läuft eine äußere Transaktion (Vorschlag übernehmen), reist das Dokument erst nach ihrem Commit. */
    private static void nachCommit(Runnable r) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    r.run();
                }
            });
        } else {
            r.run();
        }
    }

    /**
     * Läuft VOR dem Löschen einer Anlage, in derselben Transaktion ({@code SiteController}, Muster
     * {@link AnlageStandortService#beimLoeschen}): jede Bindung, die heute gilt, endet heute; eine, die erst
     * später begänne, wird aufgehoben — sonst hielte eine Anlage, die es nicht mehr gibt, ihren Anschluss
     * für immer belegt. Die Zeile überlebt die Anlage (kein Fremdschlüssel auf {@code site}); je Bindung
     * ein Protokolleintrag {@code anlage_entfernt}.
     */
    public int beimLoeschen(UUID siteId, Supplier<ProtokollAkteur> wer) {
        UUID tenant = TenantContext.get();
        Instant jetzt = uhr.instant();
        int n = 0;
        for (Bindung b : repo.bindungenDerAnlage(siteId)) {
            Anschluss na = repo.finde(b.netzanschlussId()).orElseThrow();
            ZoneId zone = standorte.finde(na.standortId()).map(st -> ZoneId.of(st.zeitzone()))
                    .orElse(OrtsbaumAbleitung.VORGABE_ZEITZONE);
            LocalDate heute = jetzt.atZone(zone).toLocalDate();
            if (b.gueltigBis() != null && b.gueltigBis().isBefore(heute)) {
                continue;
            }
            Map<String, Object> neu = bindungForm(b);
            if (b.gueltigAb().isAfter(heute)) {
                repo.bindungAufheben(b.id(), jetzt);
                neu.put("aufgehoben", true);
            } else {
                repo.bindungBeenden(b.id(), heute);
                neu.put("gueltig_bis", heute.toString());
            }
            repo.protokoll(tenant, na.id(), ANLAGE_ENTFERNT, alsJson(bindungForm(b)), alsJson(neu), jetzt, false, null,
                    wer.get());
            n++;
        }
        return n;
    }

    // ------------------------------------------------------------------------ Gerüst

    private StandortRepository.Standort standort(UUID id) {
        return standorte.finde(id).orElseThrow(() -> NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Der Anschluss DIESES Standorts — ein Anschluss eines anderen Standorts ist hier nicht da (404). */
    private Anschluss anschluss(StandortRepository.Standort s, UUID id) {
        return repo.finde(id).filter(a -> a.standortId().equals(s.id()))
                .orElseThrow(() -> NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Die Zeilensperre des Unternehmens. Ohne Unternehmen gibt es keinen Standort — also nichts zu finden. */
    private void sperre() {
        if (unternehmen.sperren().isEmpty()) {
            throw NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
    }

    /** Die belegten Kennzeichen — ohne die, die {@code ausser} selbst trägt oder trug. */
    private List<String> belegt(UUID ausser) {
        return repo.belegt().stream().filter(x -> !x.netzanschlussId().equals(ausser))
                .map(NetzanschlussRepository.Belegung::kennzeichen).toList();
    }

    /**
     * Form (400) → Felder des Vertrags → Marktlokation (422) → Zeitraum (422). {@code kennzeichenPflicht}: beim
     * Bearbeiten ist das Kennzeichen Teil der ganzen Menge; beim Anlegen heißt es fehlend „automatisch“.
     */
    private static Felder felder(NetzanschlussDto.Anschluss a, StandortRepository.Standort s, boolean kennzeichenPflicht) {
        if (a == null) {
            throw NetzanschlussAbgelehnt.anfrage("");
        }
        String kennzeichen = a.kennzeichen() == null || a.kennzeichen().isBlank() ? null : a.kennzeichen().strip();
        if (kennzeichenPflicht && kennzeichen == null) {
            throw NetzanschlussAbgelehnt.anfrage("kennzeichen");
        }
        LocalDate ab = a.gueltigAb() == null || a.gueltigAb().isBlank() ? null : tag("gueltig_ab", a.gueltigAb());
        LocalDate bis = a.gueltigBis() == null || a.gueltigBis().isBlank() ? null : tag("gueltig_bis", a.gueltigBis());
        String netzbetreiber = a.netzbetreiber() == null || a.netzbetreiber().isBlank() ? null : a.netzbetreiber().strip();
        String malo = a.malo() == null || a.malo().isBlank() ? null : a.malo().strip();
        NetzanschlussRegeln.FelderUrteil u = NetzanschlussRegeln.felder(new NetzanschlussRegeln.Felder(a.name(),
                s.kurzzeichen(), malo, netzbetreiber, a.anschlussKva(), a.vereinbartKw(), a.messung()));
        if (!u.gueltig()) {
            if ("malo".equals(u.feld())) {
                throw new NetzanschlussAbgelehnt(Ablehnung.zuCode(NetzanschlussRegeln.malo(malo).fehler()),
                        Map.of("feld", "malo"));
            }
            throw NetzanschlussAbgelehnt.anfrage(u.feld());
        }
        if (ab != null && bis != null && bis.isBefore(ab)) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("gueltig_ab", ab.toString());
            fakten.put("gueltig_bis", bis.toString());
            throw new NetzanschlussAbgelehnt(Ablehnung.ZEITRAUM_UNGUELTIG, fakten);
        }
        return new Felder(kennzeichen, a.name().strip(), NetzanschlussRegeln.malo(malo).malo(), netzbetreiber,
                a.anschlussKva(), a.vereinbartKw(), a.messung(), ab, bis);
    }

    private static Felder bestand(Anschluss a) {
        return new Felder(a.kennzeichen(), a.name(), a.malo(), a.netzbetreiber(), a.anschlussKva(), a.vereinbartKw(),
                a.messung(), a.gueltigAb(), a.gueltigBis());
    }

    private static boolean besteht(Anschluss a, LocalDate tag) {
        return (a.gueltigAb() == null || !tag.isBefore(a.gueltigAb()))
                && (a.gueltigBis() == null || !tag.isAfter(a.gueltigBis()));
    }

    private NetzanschlussDto.Netzanschluss darstellung(Anschluss a, StandortRepository.Standort s, LocalDate stichtag) {
        ZoneId zone = ZoneId.of(s.zeitzone());
        List<NetzanschlussDto.Bindung> anlagen = repo.bindungenDesAnschlusses(a.id()).stream()
                .filter(b -> stichtag == null || b.laeuftAm(stichtag))
                .map(b -> new NetzanschlussDto.Bindung(b.id(), new NetzanschlussDto.Anlage(b.siteId(), b.anlageName()),
                        b.gueltigAb(), b.gueltigBis()))
                .toList();
        List<String> hinweise = NetzanschlussRegeln.felder(new NetzanschlussRegeln.Felder(a.name(), s.kurzzeichen(),
                a.malo(), a.netzbetreiber(), a.anschlussKva(), a.vereinbartKw(), a.messung())).hinweise();
        return new NetzanschlussDto.Netzanschluss(a.id(), a.kennzeichen(), a.name(), verweis(s), a.malo(),
                a.netzbetreiber(), a.anschlussKva(), a.vereinbartKw(), a.messung(), a.gueltigAb(), a.gueltigBis(),
                hinweise, anlagen, a.angelegtAm().atZone(zone).toOffsetDateTime());
    }

    private static NetzanschlussDto.Standort verweis(StandortRepository.Standort s) {
        return new NetzanschlussDto.Standort(s.id(), s.kurzzeichen());
    }

    private static NetzanschlussRegeln.Bindung regel(Bindung b) {
        return new NetzanschlussRegeln.Bindung(b.siteId().toString(), b.netzanschlussId().toString(), b.gueltigAb(),
                b.gueltigBis());
    }

    private static Map<String, Object> bindungForm(Bindung b) {
        Map<String, Object> f = new LinkedHashMap<>();
        f.put("anlage_id", b.siteId().toString());
        f.put("anlage_name", b.anlageName());
        f.put("netzanschluss", b.netzanschlussKennzeichen());
        f.put("gueltig_ab", b.gueltigAb().toString());
        f.put("gueltig_bis", b.gueltigBis() == null ? null : b.gueltigBis().toString());
        return f;
    }

    private static Map<String, Object> form(Felder f) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("kennzeichen", f.kennzeichen());
        m.put("name", f.name());
        m.put("malo", f.malo());
        m.put("netzbetreiber", f.netzbetreiber());
        m.put("anschluss_kva", zahl(f.anschlussKva()));
        m.put("vereinbart_kw", zahl(f.vereinbartKw()));
        m.put("messung", f.messung());
        m.put("gueltig_ab", f.gueltigAb() == null ? null : f.gueltigAb().toString());
        m.put("gueltig_bis", f.gueltigBis() == null ? null : f.gueltigBis().toString());
        return m;
    }

    /** Numerisch verglichen, als Dezimaltext protokolliert: 630 und 630.000 sind dieselbe Leistung. */
    private static String zahl(BigDecimal wert) {
        return wert == null ? null : wert.stripTrailingZeros().toPlainString();
    }

    private String alsJson(Map<String, Object> werte) {
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }

    private static NetzanschlussAbgelehnt kennzeichen(String fehler, String kennzeichen) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("feld", "kennzeichen");
        fakten.put("kennzeichen", kennzeichen);
        return new NetzanschlussAbgelehnt(Ablehnung.zuCode(fehler), fakten);
    }

    private static NetzanschlussAbgelehnt bindungBesteht(Anschluss a, List<Bindung> imWeg) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("kennzeichen", a.kennzeichen());
        fakten.put("bindungen", imWeg.stream().map(NetzanschlussService::bindungForm).toList());
        return new NetzanschlussAbgelehnt(Ablehnung.BINDUNG_BESTEHT, fakten);
    }

    private static String pflicht(String feld, String text) {
        if (text == null || text.isBlank()) {
            throw NetzanschlussAbgelehnt.anfrage(feld);
        }
        return text;
    }

    private static LocalDate tag(String feld, String text) {
        try {
            return LocalDate.parse(text.strip());
        } catch (RuntimeException e) {
            throw NetzanschlussAbgelehnt.anfrage(feld);
        }
    }

    private static UUID uuid(String feld, String text) {
        try {
            return UUID.fromString(text.strip());
        } catch (IllegalArgumentException e) {
            throw NetzanschlussAbgelehnt.anfrage(feld);
        }
    }

    /**
     * Schreibt und übersetzt das, was die Sperre nicht ausschließt (ein Schreiber ohne sie): die Grenzen der
     * Datenbank kommen als dieselben Ablehnungen an — nie als 500.
     */
    private <T> T schreibe(Supplier<T> arbeit) {
        try {
            return arbeit.get();
        } catch (DataAccessException e) {
            String constraint = constraint(e);
            Ablehnung ablehnung = constraint == null ? null : switch (constraint) {
                case "netzanschluss_kennzeichen_eindeutig", "netzanschluss_kennzeichen_belegt" -> Ablehnung.KENNZEICHEN_BELEGT;
                case "anlage_netzanschluss_eine_je_anlage" -> Ablehnung.BINDUNG_UEBERLAPPT;
                case "anlage_netzanschluss_eine_je_anschluss" -> Ablehnung.ANSCHLUSS_BELEGT;
                case "anlage_netzanschluss_netzanschluss_besteht" -> Ablehnung.NETZANSCHLUSS_BESTEHT_NICHT;
                case "netzanschluss_bindung_besteht" -> Ablehnung.BINDUNG_BESTEHT;
                case "anlage_netzanschluss_site_fk" -> Ablehnung.ANLAGE_UNBEKANNT;
                default -> null;
            };
            if (ablehnung == null) {
                throw e;
            }
            throw NetzanschlussAbgelehnt.von(ablehnung);
        }
    }

    /** Der Constraint-Name der Postgres-Ablehnung — per Reflexion, ohne Kompilier-Abhängigkeit auf den Treiber. */
    private static String constraint(Throwable e) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            try {
                Object meldung = t.getClass().getMethod("getServerErrorMessage").invoke(t);
                if (meldung != null) {
                    return (String) meldung.getClass().getMethod("getConstraint").invoke(meldung);
                }
            } catch (ReflectiveOperationException keinPostgresFehler) {
                // weiter mit der Ursache
            }
        }
        return null;
    }
}
