package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.chargers.ChargingConfigService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.NetzanschlussAbgelehnt.Ablehnung;
import com.voltpilot.api.web.dto.NetzanschlussDto;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Das Grenzblatt am Netzanschluss lesen und fortschreiben (UEMS AP-15 IP-3, Kasten W1): Einspeise- und Bezugsgrenze,
 * zeitgültig ab einem Tag. Keine Preise (W1). Was an einer Anlage WIRKT, entscheidet {@link GrenzeAufloesung} — der
 * engere Wert aus Anlage und Netzanschluss; dieser Dienst schreibt nur das Blatt.
 *
 * <p>Reihenfolge beim Setzen: Standort und Anschluss da (404) → Form (400 {@code anfrage_ungueltig} mit {@code feld})
 * → Anschluss besteht am ersten Tag (422 {@code netzanschluss_besteht_nicht}) → Plausibilität gegen vereinbarte
 * Leistung und Anschlussleistung (422, {@link GrenzeAufloesung#plausibel}). Eine zweite Fassung am selben Tag hebt die
 * erste auf (nie überschrieben); dieselben Werte noch einmal schreiben nichts. Jeder Schreibvorgang ist GENAU EIN
 * Eintrag {@code grenze} im Protokoll des Netzanschlusses; eine Ablehnung schreibt nichts.
 */
@Service
public class NetzanschlussGrenzeService {

    static final String GRENZE = "grenze";

    private static final Logger log = LoggerFactory.getLogger(NetzanschlussGrenzeService.class);
    /** NUMERIC(12, 3): höchstens neun Stellen vor und drei nach dem Komma. */
    private static final int STELLEN_VOR = 9;
    private static final int STELLEN_NACH = 3;

    private final NetzanschlussGrenzeRepository repo;
    private final NetzanschlussRepository anschluesse;
    private final StandortRepository standorte;
    private final ObjectMapper json;
    private final TransactionTemplate transaktion;
    private final ObjectProvider<ChargingConfigService> ladepark;
    private volatile Clock uhr = Clock.systemUTC();

    public NetzanschlussGrenzeService(NetzanschlussGrenzeRepository repo, NetzanschlussRepository anschluesse,
            StandortRepository standorte, ObjectMapper json, PlatformTransactionManager transactionManager,
            ObjectProvider<ChargingConfigService> ladepark) {
        this.repo = repo;
        this.anschluesse = anschluesse;
        this.standorte = standorte;
        this.json = json;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.ladepark = ladepark;
    }

    /** Nur für Tests: die Uhr, an der „heute“ und „rückwirkend“ hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------------------ lesen

    public NetzanschlussDto.Grenzblatt grenzblatt(UUID standortId, UUID id, LocalDate stichtag) {
        StandortRepository.Standort s = standort(standortId);
        NetzanschlussRepository.Anschluss na = anschluss(s, id);
        LocalDate tag = stichtag != null ? stichtag : uhr.instant().atZone(ZoneId.of(s.zeitzone())).toLocalDate();
        List<NetzanschlussGrenzeRepository.Zeile> zeilen = repo.fassungen(na.id());
        GrenzeAufloesung.Fassung gilt = GrenzeAufloesung.fassungAm(
                zeilen.stream().map(NetzanschlussGrenzeRepository.Zeile::fassung).toList(), tag);
        NetzanschlussDto.GrenzFassung gueltig = gilt == null ? null : zeilen.stream()
                .filter(z -> z.gueltigAb().equals(gilt.gueltigAb())).findFirst().map(NetzanschlussGrenzeService::form)
                .orElseThrow();
        return new NetzanschlussDto.Grenzblatt(na.id(), na.kennzeichen(), tag, gueltig,
                zeilen.stream().map(NetzanschlussGrenzeService::form).toList());
    }

    // --------------------------------------------------------------------- schreiben

    /** Ab {@code gueltig_ab} gilt diese Fassung; gibt den ersten Tag zurück. */
    public LocalDate setzen(UUID standortId, UUID id, NetzanschlussDto.GrenzeSetzen g, ProtokollAkteur wer) {
        StandortRepository.Standort s = standort(standortId);
        NetzanschlussRepository.Anschluss na = anschluss(s, id);
        if (g == null) {
            throw NetzanschlussAbgelehnt.anfrage("");
        }
        LocalDate ab = tag("gueltig_ab", g.gueltigAb());
        BigDecimal einspeisung = leistung("einspeisegrenze_kw", g.einspeisegrenzeKw());
        BigDecimal bezug = leistung("bezugsgrenze_kw", g.bezugsgrenzeKw());
        String grund = g.grund() == null || g.grund().isBlank() ? null : g.grund().strip();
        if ((na.gueltigAb() != null && ab.isBefore(na.gueltigAb()))
                || (na.gueltigBis() != null && ab.isAfter(na.gueltigBis()))) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("kennzeichen", na.kennzeichen());
            fakten.put("besteht_ab", na.gueltigAb() == null ? null : na.gueltigAb().toString());
            fakten.put("besteht_bis", na.gueltigBis() == null ? null : na.gueltigBis().toString());
            fakten.put("gueltig_ab", ab.toString());
            throw new NetzanschlussAbgelehnt(Ablehnung.NETZANSCHLUSS_BESTEHT_NICHT, fakten);
        }
        String fehler = GrenzeAufloesung.plausibel(einspeisung, bezug, na.vereinbartKw(), na.anschlussKva());
        if (fehler != null) {
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("kennzeichen", na.kennzeichen());
            fakten.put("einspeisegrenze_kw", einspeisung);
            fakten.put("bezugsgrenze_kw", bezug);
            fakten.put("vereinbart_kw", na.vereinbartKw());
            fakten.put("anschluss_kva", na.anschlussKva());
            throw new NetzanschlussAbgelehnt(Ablehnung.zuCode(fehler), fakten);
        }
        UUID tenant = TenantContext.get();
        ZoneId zone = ZoneId.of(s.zeitzone());
        LocalDate heute = uhr.instant().atZone(zone).toLocalDate();
        Boolean geschrieben = transaktion.execute(tx -> {
            repo.sperren(na.id());
            NetzanschlussGrenzeRepository.Zeile alt = repo.fassungen(na.id()).stream()
                    .filter(z -> z.gueltigAb().equals(ab)).findFirst().orElse(null);
            if (alt != null && gleich(alt.einspeisegrenzeKw(), einspeisung) && gleich(alt.bezugsgrenzeKw(), bezug)) {
                return false;
            }
            if (alt != null) {
                repo.aufheben(alt.id(), uhr.instant());
            }
            repo.eintragen(tenant, na.id(), ab, einspeisung, bezug, wer.sub());
            anschluesse.protokoll(tenant, na.id(), GRENZE, alt == null ? null : alsJson(fassungForm(alt.gueltigAb(),
                    alt.einspeisegrenzeKw(), alt.bezugsgrenzeKw())), alsJson(fassungForm(ab, einspeisung, bezug)),
                    ab.atStartOfDay(zone).toInstant(), ab.isBefore(heute), grund, wer);
            return true;
        });
        if (Boolean.TRUE.equals(geschrieben) && !ab.isAfter(heute)) {
            zustellen(na.id(), heute);
        }
        return ab;
    }

    /**
     * Gilt die neue Fassung heute schon (auch: sie hebt eine wirksame auf), reist das Ladepark-Dokument der heute
     * gebundenen Anlage neu — nur, wenn sich ihr wirksamer Bezug dadurch ändert und sie schon einen Rahmen hat
     * ({@link ChargingConfigService#netzgrenzeNachziehen}). Eine Fassung ab einem späteren Tag stellt der
     * {@link LadeparkGrenzeLaeufer} am Tageswechsel zu. Ein Fehler der Zustellung nimmt den Eintrag nicht zurück.
     */
    private void zustellen(UUID netzanschluss, LocalDate heute) {
        ChargingConfigService dienst = ladepark.getIfAvailable();
        if (dienst == null) {
            return;
        }
        for (NetzanschlussRepository.Bindung b : anschluesse.bindungenDesAnschlusses(netzanschluss)) {
            if (b.laeuftAm(heute)) {
                try {
                    dienst.netzgrenzeNachziehen(TenantContext.get(), b.siteId());
                } catch (RuntimeException e) {
                    log.warn("Ladepark-Dokument nach neuer Grenze nicht zugestellt (Anlage {}): {}", b.siteId(),
                            e.getMessage());
                }
            }
        }
    }

    // ------------------------------------------------------------------------ Gerüst

    private StandortRepository.Standort standort(UUID id) {
        return standorte.finde(id).orElseThrow(() -> NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    /** Ein Anschluss eines ANDEREN Standorts ist dieselbe Antwort wie einer, den es nicht gibt. */
    private NetzanschlussRepository.Anschluss anschluss(StandortRepository.Standort s, UUID id) {
        return anschluesse.finde(id).filter(a -> a.standortId().equals(s.id()))
                .orElseThrow(() -> NetzanschlussAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
    }

    private static LocalDate tag(String feld, String text) {
        if (text == null || text.isBlank()) {
            throw NetzanschlussAbgelehnt.anfrage(feld);
        }
        try {
            return LocalDate.parse(text.strip());
        } catch (DateTimeParseException e) {
            throw NetzanschlussAbgelehnt.anfrage(feld);
        }
    }

    /** Eine Grenze ist leer oder eine Leistung > 0 kW in der Form der Spalte — unbekannt ist nie 0 kW. */
    private static BigDecimal leistung(String feld, BigDecimal wert) {
        if (wert == null) {
            return null;
        }
        BigDecimal kurz = wert.stripTrailingZeros();
        if (kurz.scale() < 0) {
            kurz = kurz.setScale(0);
        }
        if (kurz.signum() <= 0 || kurz.scale() > STELLEN_NACH || kurz.precision() - kurz.scale() > STELLEN_VOR) {
            throw NetzanschlussAbgelehnt.anfrage(feld);
        }
        return kurz;
    }

    private static boolean gleich(BigDecimal a, BigDecimal b) {
        return a == null ? b == null : b != null && a.compareTo(b) == 0;
    }

    private static NetzanschlussDto.GrenzFassung form(NetzanschlussGrenzeRepository.Zeile z) {
        return new NetzanschlussDto.GrenzFassung(z.gueltigAb(), z.einspeisegrenzeKw(), z.bezugsgrenzeKw(),
                z.eingetragen());
    }

    private static Map<String, Object> fassungForm(LocalDate ab, BigDecimal einspeisung, BigDecimal bezug) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("gueltig_ab", ab.toString());
        m.put("einspeisegrenze_kw", einspeisung);
        m.put("bezugsgrenze_kw", bezug);
        return m;
    }

    private String alsJson(Map<String, Object> m) {
        try {
            return json.writeValueAsString(Objects.requireNonNull(m));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
