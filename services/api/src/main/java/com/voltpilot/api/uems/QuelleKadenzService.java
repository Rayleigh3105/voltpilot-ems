package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MesskanalService;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.MessstelleAenderungRepository.NeuerEintrag;
import com.voltpilot.api.uems.MessstelleQuelleRepository.Quelle;
import com.voltpilot.api.uems.MessstelleRepository.Messstelle;
import com.voltpilot.api.uems.QuelleKadenzRepository.NeueFassung;
import com.voltpilot.api.uems.QuelleKadenzRepository.Zeile;
import com.voltpilot.api.web.dto.KadenzDto;
import com.voltpilot.api.web.dto.MesskanalDto;
import com.voltpilot.api.web.dto.MessstelleQuelleDto;
import java.time.Clock;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

/**
 * Die erwartete Kadenz einer Quellenbindung (UEMS AP-07 IP-10, Entscheid E9): lesen und eintragen.
 * Jede Regel urteilt {@link KadenzRegeln}; hier wird gelesen, gesperrt und geschrieben.
 *
 * <p><b>Die Kadenz ist ab hier eine Tatsache mit Geschichte.</b> Was am 3. März erwartet wurde,
 * darf etwas anderes sein als heute. Wer einen alten Zeitraum auswertet, fragt mit DESSEN Zeitpunkt
 * ({@link #jeBindung}, {@link #fassungenJeKanal}) — nie mit „jetzt".
 *
 * <p><b>⚠ Am Draht ändert sich nichts.</b> Diese Klasse stellt nichts zu und ändert keine
 * Mess-Selektion: sie schreibt {@code quelle_kadenz} und den Protokolleintrag
 * {@code kadenz_geaendert} an der Messstelle. Die Nachricht an die Box bleibt
 * {@code …/v2/measurement-config} in derselben Form — nur die QUELLE der Zahl {@code cadence_s}
 * wechselt ({@code MeasurementConfigPublisher}).
 */
@Service
public class QuelleKadenzService implements ErwarteteKadenz {

    private static final ZoneId ZEITZONE = MessstelleService.ZEITZONE;
    private static final DateTimeFormatter ANZEIGE = DateTimeFormatter.ofPattern("dd.MM.yyyy HH:mm");

    /** Die Art des Eintrags im Protokoll der Messstelle (CHECK in V20260912160000). */
    static final String PROTOKOLL_ART = "kadenz_geaendert";

    /** Die Herkunft einer von Hand eingetragenen Fassung. */
    static final String HERKUNFT_EINTRAG = "eintrag";

    private final MessstelleRepository messstellen;
    private final MessstelleQuelleRepository quellen;
    private final QuelleKadenzRepository fassungen;
    private final MessstelleAenderungRepository protokoll;
    private final MesskanalService messkanaele;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();

    public QuelleKadenzService(MessstelleRepository messstellen, MessstelleQuelleRepository quellen,
            QuelleKadenzRepository fassungen, MessstelleAenderungRepository protokoll,
            MesskanalService messkanaele, ObjectMapper json) {
        this.messstellen = messstellen;
        this.quellen = quellen;
        this.fassungen = fassungen;
        this.protokoll = protokoll;
        this.messkanaele = messkanaele;
        this.json = json;
    }

    /** Für Tests: die Uhr, an der „jetzt", „rückwirkend" und der Stichtag hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    // ------------------------------------------------------------ Nachschlagen

    /**
     * Die zum {@code zeitpunkt} geltende Fassung DIESER Bindungen (Beobachtung, Register). Eine
     * Bindung ohne Fassung fehlt — der Aufrufer nimmt dann die Vorgabe, nie eine geratene Zahl.
     */
    @Transactional(readOnly = true)
    public Map<UUID, Integer> jeBindung(Collection<UUID> quelleIds, Instant zeitpunkt) {
        return fassungen.jeBindung(quelleIds, zeitpunkt);
    }

    @Override
    @Transactional(readOnly = true)
    public Map<Messkanal, Integer> fassungenJeKanal(Collection<Messkanal> kanaele, Instant zeitpunkt) {
        return fassungen.jeKanal(kanaele, zeitpunkt);
    }

    // ------------------------------------------------------------------ Lesen

    /** Was zum Stichtag erwartet wird, woher die Zahl kommt, was ohne Fassung gälte — und die Historie. */
    @Transactional(readOnly = true)
    public KadenzDto.Kadenz kadenz(UUID messstelleId, UUID quelleId, Instant stichtag) {
        Messstelle m = finde(messstelleId);
        Quelle q = findeQuelle(m.id(), quelleId);
        Instant jetzt = uhr.instant();
        Instant t = stichtag == null ? jetzt : stichtag;
        List<Zeile> alle = fassungen.derBindung(q.id());
        KadenzRegeln.Fassung gueltig = KadenzRegeln.fassungAm(
                alle.stream().map(Zeile::fuerRegeln).toList(), t);
        Integer fassungS = gueltig == null ? null : gueltig.erwartetS();
        KadenzRegeln.Wirksam wirksam = vorgabe(q, fassungS);
        KadenzRegeln.Wirksam ohneFassung = vorgabe(q, null);
        Zeile gueltigeZeile = gueltig == null ? null : alle.stream()
                .filter(z -> z.id().toString().equals(gueltig.id())).findFirst().orElse(null);
        return new KadenzDto.Kadenz(m.id(), q.id(), q.entityId(), q.kanal(), zeit(t),
                wirksam.erwartetS(), wirksam.herkunft().code(), ohneFassung.erwartetS(),
                ohneFassung.herkunft().code(), darstellung(gueltigeZeile, jetzt),
                alle.stream().map(z -> darstellung(z, jetzt)).toList());
    }

    // -------------------------------------------------------------- Eintragen

    /**
     * Trägt eine neue Fassung ein. Sie gilt AB ihrem Zeitpunkt: die dort geltende endet genau dort,
     * alles davor bleibt unangetastet. Ein Protokolleintrag {@code kadenz_geaendert} an der
     * Messstelle, in derselben Transaktion.
     */
    @Transactional
    public KadenzDto.Vorgang eintragen(UUID messstelleId, UUID quelleId, KadenzDto.Eintragen b,
            ProtokollAkteur wer) {
        Messstelle m = finde(messstelleId);
        Quelle q = findeQuelle(m.id(), quelleId);
        Instant jetzt = uhr.instant();
        Instant minute = jetzt.truncatedTo(ChronoUnit.MINUTES);
        Instant ab = b == null || b.gueltigAb() == null ? minute : b.gueltigAb().toInstant();
        if (!fassungen.sperreMessstelle(m.id())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden.");
        }
        List<Zeile> alle = fassungen.derBindung(q.id());
        KadenzRegeln.Urteil u = KadenzRegeln.neueFassung(new KadenzRegeln.Eingang(q.gueltigAb(),
                q.gueltigBis(), alle.stream().map(Zeile::fuerRegeln).toList(),
                b == null ? null : b.erwartetS(), ab, jetzt));
        if (!u.ok()) {
            throw abgelehnt(u.fehler(), q, b == null ? null : b.erwartetS(), ab);
        }
        Zeile vorgaenger = u.vorgaenger() == null ? null : alle.stream()
                .filter(z -> z.id().toString().equals(u.vorgaenger().id())).findFirst().orElseThrow();
        if (u.beendet() != null) {
            fassungen.beenden(UUID.fromString(u.beendet().id()), u.beendet().gueltigBis());
        }
        UUID id = fassungen.anlegen(new NeueFassung(TenantContext.get(), q.id(), b.erwartetS(),
                HERKUNFT_EINTRAG, u.gueltigAb(), u.gueltigBis(), Boolean.TRUE.equals(u.rueckwirkend()),
                grund(b), wer, jetzt));
        protokoll(m.id(), q, vorgaenger, b.erwartetS(), u, wer, jetzt, grund(b));
        Zeile neu = fassungen.derBindung(q.id()).stream().filter(z -> z.id().equals(id)).findFirst()
                .orElseThrow();
        Zeile beendet = u.beendet() == null ? null : fassungen.derBindung(q.id()).stream()
                .filter(z -> z.id().toString().equals(u.beendet().id())).findFirst().orElse(null);
        return new KadenzDto.Vorgang(darstellung(neu, jetzt), darstellung(beendet, jetzt),
                rueckwirkung(jetzt, u.gueltigAb()));
    }

    // ------------------------------------------------------------------ Gerüst

    /**
     * Die Vorgabe-Kette dieses Messkanals: Fassung → Mess-Selektion → Katalog → 300 s. Die drei
     * hinteren Glieder sind die Ableitung von vor diesem Paket, Zeichen für Zeichen
     * ({@link MesskanalService#kadenz}).
     */
    private KadenzRegeln.Wirksam vorgabe(Quelle q, Integer fassungS) {
        MesskanalDto.Messkanal k = messkanaele.kanal(q.entityId(), q.kanal()).orElse(null);
        return messkanaele.kadenz(q.kanal(), k == null ? null : k.kadenzS(), fassungS);
    }

    private void protokoll(UUID messstelle, Quelle q, Zeile vorgaenger, int erwartetS,
            KadenzRegeln.Urteil u, ProtokollAkteur wer, Instant jetzt, String grund) {
        Map<String, Object> alt = new LinkedHashMap<>();
        alt.put("quelle_id", q.id().toString());
        alt.put("erwartet_s", vorgaenger == null ? null : vorgaenger.erwartetS());
        Map<String, Object> neu = new LinkedHashMap<>();
        neu.put("quelle_id", q.id().toString());
        neu.put("kanal", q.kanal());
        neu.put("erwartet_s", erwartetS);
        neu.put("gueltig_ab", iso(u.gueltigAb()));
        protokoll.eintragen(new NeuerEintrag(TenantContext.get(), messstelle, PROTOKOLL_ART, alsJson(alt),
                alsJson(neu), u.gueltigAb(), Boolean.TRUE.equals(u.rueckwirkend()), grund, wer.sub(),
                wer.name(), wer.rolle(), wer.art()), jetzt);
    }

    private static String grund(KadenzDto.Eintragen b) {
        String g = b == null ? null : b.grund();
        return g == null || g.isBlank() ? null : g;
    }

    private KadenzAbgelehnt abgelehnt(KadenzRegeln.Fehler f, Quelle q, Integer erwartetS, Instant ab) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        fakten.put("quelle_id", q.id().toString());
        fakten.put("erwartet_s", erwartetS);
        fakten.put("gueltig_ab", iso(ab));
        String satz = switch (f) {
            case KADENZ_UNGUELTIG -> "Die erwartete Häufigkeit ist eine ganze Zahl von "
                    + KadenzRegeln.KLEINSTE_S + " bis " + KadenzRegeln.GROESSTE_S + " Sekunden.";
            case ZEITPUNKT_UNGUELTIG -> "„gültig ab“ ist ein Zeitpunkt auf die volle Minute.";
            case VOR_BEGINN -> "Die Quelle beginnt erst am " + anzeige(q.gueltigAb())
                    + " — eine Erwartung davor gibt es nicht.";
            case NACH_ENDE -> "Die Quelle endet am " + anzeige(q.gueltigBis())
                    + " — danach erwartet sie nichts mehr.";
            case BEGINN_BELEGT -> "Zu diesem Zeitpunkt beginnt schon eine Fassung. "
                    + "Eine Fassung wird nie überschrieben.";
            case UNVERAENDERT -> "Dort gelten schon " + erwartetS + " s — es gäbe nichts zu ändern.";
        };
        return KadenzAbgelehnt.regel(f, satz, fakten);
    }

    private Messstelle finde(UUID id) {
        return messstellen.finde(id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Messstelle nicht gefunden."));
    }

    private Quelle findeQuelle(UUID messstelleId, UUID id) {
        return quellen.eine(messstelleId, id).orElseThrow(() ->
                new ResponseStatusException(HttpStatus.NOT_FOUND, "Quelle nicht gefunden."));
    }

    private static KadenzDto.Fassung darstellung(Zeile z, Instant jetzt) {
        if (z == null) {
            return null;
        }
        Instant minute = jetzt.truncatedTo(ChronoUnit.MINUTES);
        String status = z.gueltigAb().isAfter(minute) ? "geplant"
                : z.gueltigBis() == null || z.gueltigBis().isAfter(minute) ? "gilt" : "beendet";
        return new KadenzDto.Fassung(z.id(), z.erwartetS(), z.herkunft(), zeit(z.gueltigAb()),
                zeit(z.gueltigBis()), status, z.rueckwirkend(), z.begruendung(), zeit(z.eingetragenAm()),
                z.actorName());
    }

    private static MessstelleQuelleDto.Rueckwirkung rueckwirkung(Instant jetzt, Instant zeitpunkt) {
        MessstelleRegeln.Rueckwirkung r = MessstelleRegeln.rueckwirkung(zeit(jetzt), zeit(zeitpunkt));
        return new MessstelleQuelleDto.Rueckwirkung(r.art(), r.minuten(), r.abzeichen());
    }

    private String alsJson(Map<String, Object> werte) {
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Protokolleintrag nicht darstellbar", e);
        }
    }

    private static OffsetDateTime zeit(Instant t) {
        return t == null ? null : OffsetDateTime.ofInstant(t, ZEITZONE);
    }

    private static String iso(Instant t) {
        return t == null ? null : DateTimeFormatter.ISO_OFFSET_DATE_TIME.format(zeit(t));
    }

    private static String anzeige(Instant t) {
        return t == null ? "—" : ANZEIGE.format(zeit(t));
    }
}
