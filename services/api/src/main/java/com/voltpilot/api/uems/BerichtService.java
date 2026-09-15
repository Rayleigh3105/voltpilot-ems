package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.BerichtAbgelehnt.Ablehnung;
import com.voltpilot.api.uems.BerichtRepository.AnstossZeile;
import com.voltpilot.api.uems.BerichtRepository.EntwurfZeile;
import com.voltpilot.api.uems.BerichtRepository.Geltung;
import com.voltpilot.api.uems.BerichtRepository.Kopf;
import com.voltpilot.api.uems.BerichtRepository.StandZeile;
import com.voltpilot.api.uems.RechteAbleitung.Benutzer;
import com.voltpilot.api.uems.RechteAbleitung.DarfErgebnis;
import com.voltpilot.api.uems.RechteAbleitung.Kundenbereich;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import javax.sql.DataSource;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceUtils;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Die Berichts-Routen (UEMS AP-12 IP-7, E4/E5/E7/E12) — Meilenstein 2 „Bericht freigebbar“: anlegen (bildet den Entwurf),
 * lesen, Entwurf mit D4-Prüfung, Vergleich gegen einen Stand (R1), Freigabe (F1–F5), Stand mit geprüfter Prüfsumme, Anstoß
 * verwerfen (R4), archivieren (V4).
 *
 * <p><b>Reihenfolge je Route:</b> Kundenbereich und Bericht (fremd 404) → Recht über {@link BerichtRechte} (fremder
 * Standort 404, fehlendes Recht 403) → erst dann die Regeln. So verrät keine 422, dass es einen Bericht gibt.
 *
 * <p><b>Die Freigabe rechnet nichts</b> (F2): sie sperrt den Bericht ({@code FOR NO KEY UPDATE}), liest den Entwurf
 * {@code FOR SHARE} (die Kaskade nimmt ihn {@code FOR UPDATE}), prüft F1 mit {@link BerichtRegeln#freigabe}, D2 und D3,
 * kopiert den Abzug in SQL Byte für Byte nach {@code bericht_stand} (Nr. = letzte + 1), friert die Quellen ein, setzt am
 * Vorgänger „ersetzt durch“, erledigt offene Anstöße und schreibt {@code bericht_freigegeben} und das Protokoll — alles in
 * einer Transaktion. Dieselbe Freigabe (Bericht, Datenstand) noch einmal ist derselbe Stand (F5).
 *
 * <p><b>D4 beim Abruf:</b> {@link BerichtRepository#aenderungenSeit} plus die Fristen, die seit dem Datenstand abliefen
 * ({@link #fristen}); ist etwas neuer, bildet {@link BerichtAbzugBildung} den Entwurf in eigener Transaktion neu
 * ({@code gebildet_von = abruf}, ohne Ereignis — B6). Den Abzug eines Unternehmensberichts bildet erst AP-12 IP-6.
 */
@Service
public class BerichtService {

    public static final String ZEICHEN_ENTWURF = "entwurf";
    public static final String ZEICHEN_STAND = "berichtsstand";
    public static final String ZEICHEN_REVISION = "revision_noetig";
    public static final String ZEICHEN_VERWORFEN = "anstoss_verworfen";
    /** R5 — die Vermerke eines Berichts in der Liste, als Wort. */
    public static final List<String> STAND_ZEICHEN = List.of(ZEICHEN_ENTWURF, ZEICHEN_STAND, ZEICHEN_REVISION,
            ZEICHEN_VERWORFEN);

    static final String EREIGNIS_FREIGEGEBEN = "bericht_freigegeben";
    /** {@code gebildet_von} (bericht.md EW1) — nicht die Handlung der Route. */
    static final String GEBILDET_BEIM_ANLEGEN = "anlegen";
    static final String GEBILDET_BEIM_ABRUF = "abruf";
    static final String ZEITRAUM_ZU_ENDE = "zeitraum_zu_ende";
    static final String OFFEN = "offen";
    static final String VERWORFEN = "verworfen";
    static final int TEXT_MINDESTENS = 10;
    static final int TEXT_HOECHSTENS = 500;

    private static final Pattern MONAT = Pattern.compile("^[0-9]{4}-(0[1-9]|1[0-2])$");
    private static final Pattern JAHR = Pattern.compile("^[0-9]{4}$");
    /** Ein Abzug als Baum: Zahlen exakt als Dezimalzahl, wie die kanonische Form sie schrieb. */
    private static final ObjectMapper ABZUG = new ObjectMapper()
            .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
            .setNodeFactory(JsonNodeFactory.withExactBigDecimals(true));

    private final BerichtRepository repo;
    private final KennzahlAufrufer aufrufer;
    private final BerichtAbzugBildung bildung;
    private final MessreiheEreignisRepository ereignisse;
    private final JdbcTemplate jdbc;
    private final TransactionTemplate transaktion;
    private final ObjectMapper json;
    private volatile Clock uhr = Clock.systemUTC();

    public BerichtService(BerichtRepository repo, KennzahlAufrufer aufrufer, BerichtAbzugBildung bildung,
            MessreiheEreignisRepository ereignisse, JdbcTemplate jdbc, PlatformTransactionManager transactionManager,
            ObjectMapper json) {
        this.repo = repo;
        this.aufrufer = aufrufer;
        this.bildung = bildung;
        this.ereignisse = ereignisse;
        this.jdbc = jdbc;
        this.transaktion = new TransactionTemplate(transactionManager);
        this.json = json;
    }

    /** Für Tests: die Uhr, an der Datenstand, Freigabe, Fristen und Rechte hängen. */
    void uhrStellen(Clock uhr) {
        this.uhr = uhr;
    }

    /** Auf die Sekunde: so steht ein Datenstand im Ereignis ({@code ZEIT_UTC}) und in der Datenbank gleich. */
    Instant jetzt() {
        return uhr.instant().truncatedTo(ChronoUnit.SECONDS);
    }

    // ================================================================================ Ergebnisse

    /** Ein Bericht mit seinem Vermerk aus R5. */
    public record Uebersicht(Kopf kopf, Integer neuesteNr, Instant entwurfDatenstand, String standZeichen,
            String standText) {}

    public record Detail(Uebersicht bericht, List<StandZeile> staende, List<AnstossZeile> anstoesse) {}

    public record Entwurf(Kopf kopf, EntwurfZeile entwurf, boolean neuGebildet, List<String> teilansicht) {}

    public record Vergleich(Kopf kopf, int gegen, Instant entwurfDatenstand, List<BerichtRegeln.Abweichung> abweichungen) {}

    public record Stand(Kopf kopf, StandZeile stand, List<String> teilansicht) {}

    /** {@code neu} = diese Anfrage hat den Stand geschrieben (201); sonst war es dieselbe Freigabe (F5, 200). */
    public record Freigabe(Stand stand, boolean neu) {}

    public record Verworfen(Kopf kopf, AnstossZeile anstoss) {}

    /** Bericht, Urteil und Aufrufer einer Route — nach der Rechte-Prüfung. */
    private record Zugriff(Kopf kopf, DarfErgebnis darf, Benutzer benutzer, Kundenbereich kundenbereich, Instant jetzt) {}

    // ================================================================================ lesen

    /**
     * {@code GET /berichte}: die nicht archivierten Berichte, die die Person lesen darf. Darf sie nirgends einen lesen (der
     * Unterstützer), ist das 403 — kein leeres „es gibt keine“.
     */
    public List<Uebersicht> liste(ProtokollAkteur wer) {
        UUID tenant = kundenbereich();
        Instant jetzt = jetzt();
        Benutzer b = aufrufer.benutzer(wer);
        Kundenbereich k = rechteKundenbereich();
        List<Uebersicht> raus = new ArrayList<>();
        for (Kopf x : repo.berichte()) {
            if (darf(b, k, BerichtRechte.ABRUFEN, x, jetzt).darf()) {
                raus.add(uebersicht(tenant, x));
            }
        }
        if (raus.isEmpty()) {
            irgendwoLesbar(b, k, jetzt);
        }
        return raus;
    }

    public Detail detail(String kennung, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.ABRUFEN);
        Kopf kopf = z.kopf();
        return new Detail(uebersicht(kopf.tenant(), kopf), repo.staende(kopf.tenant(), kopf.id()),
                repo.anstoesse(kopf.tenant(), kopf.id()));
    }

    /** {@code GET …/entwurf}: D4 — aktuell lesen, sonst neu bilden (EW1, B6). */
    public Entwurf entwurf(String kennung, ProtokollAkteur wer) {
        return aktuellerEntwurf(zugriff(kennung, wer, BerichtRechte.ABRUFEN));
    }

    /** {@code GET …/entwurf/vergleich?gegen=<nr>}: R1 — der Stand zuerst (404 ohne Neubildung), dann der aktuelle Entwurf. */
    public Vergleich vergleich(String kennung, int gegen, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.ABRUFEN);
        StandZeile s = geprueft(z.kopf(), gegen);
        Entwurf e = aktuellerEntwurf(z);
        return new Vergleich(z.kopf(), gegen, e.entwurf().datenstand(),
                BerichtRegeln.abweichungen(baum(s.abzug()), baum(e.entwurf().abzug())));
    }

    /** {@code GET …/staende/{nr}}: die Prüfsumme wird geprüft, nicht nur mitgeliefert (A6). */
    public Stand stand(String kennung, int nr, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.ABRUFEN);
        return new Stand(z.kopf(), geprueft(z.kopf(), nr), teilansicht(z));
    }

    // ================================================================================ anlegen

    /**
     * {@code POST /berichte}: Vorlage (422) → Zeitraum (400) → Geltung (404, fremd ebenso) → Recht → gibt es schon (409) →
     * Messstellen im Zeitraum (422) → Bericht mit Kennung und Entwurf in einer Transaktion.
     */
    public Uebersicht anlegen(String vorlageSchluessel, String geltungId, String zeitraum, ProtokollAkteur wer) {
        UUID tenant = kundenbereich();
        Instant jetzt = jetzt();
        BerichtRegeln.Vorlage v = BerichtRegeln.vorlage(vorlageSchluessel);
        if (v == null) {
            throw BerichtAbgelehnt.regel(Ablehnung.VORLAGE_UNBEKANNT, BerichtRegeln.SAETZE.get(BerichtRegeln.VORLAGE_UNBEKANNT),
                    Map.of("feld", "vorlage"));
        }
        if (!(BerichtRegeln.MONAT.equals(v.zeitraumArt()) ? MONAT : JAHR).matcher(zeitraum).matches()) {
            throw BerichtAbgelehnt.anfrage("zeitraum");
        }
        boolean standort = BerichtRegeln.STANDORT.equals(v.geltungArt());
        Geltung g = geltung(standort, geltungId);
        Benutzer b = aufrufer.benutzer(wer);
        DarfErgebnis d = BerichtRechte.darf(b, rechteKundenbereich(), BerichtRechte.ANLEGEN, v.geltungArt(),
                standort ? g.id().toString() : null, jetzt);
        if (!d.darf()) {
            throw BerichtAbgelehnt.rechte(d);
        }
        ZoneId zone = repo.zeitzone(standort ? g.id() : null);
        BerichtRegeln.Zeitraum zr = BerichtRegeln.zeitraum(v.zeitraumArt(), zeitraum, zone);
        Optional<Kopf> schon = repo.berichtZu(v.schluessel(), v.geltungArt(), g.id(), zeitraum);
        if (schon.isPresent()) {
            throw gibtEsSchon(schon.get());
        }
        if (!standort) {
            throw BerichtAbgelehnt.von(Ablehnung.UNTERNEHMENSBERICHT_FOLGT);
        }
        if (BerichtAbzugBildung.messstellenDerGeltung(jdbc, tenant, g.id(), zr.ersterTag(), zr.letzterTag()).isEmpty()) {
            LocalDate seit = BerichtAbzugBildung.bestehtSeit(jdbc, tenant, g.id(), LocalDate.ofInstant(jetzt, zone));
            throw BerichtAbgelehnt.regel(Ablehnung.KEINE_QUELLEN, BerichtRegeln.keineQuellen(g.name(), v.zeitraumArt(),
                    zeitraum, seit != null && seit.isAfter(zr.letzterTag()) ? seit : null), Map.of("feld", "zeitraum"));
        }
        String rolle = rolle(d, wer);
        String kennung;
        try {
            kennung = transaktion.execute(tx -> {
                String neueKennung = repo.kennungNeu(tenant, LocalDate.ofInstant(jetzt, zone).getYear());
                UUID id = repo.anlegen(tenant, neueKennung, v, g.id(), zeitraum, zone, wer, jetzt);
                bilden(id, v.geltungArt(), jetzt, GEBILDET_BEIM_ANLEGEN);
                Map<String, Object> neu = new LinkedHashMap<>();
                neu.put("kennung", neueKennung);
                neu.put("vorlage", v.schluessel());
                neu.put("geltung_art", v.geltungArt());
                neu.put("geltung_id", g.id().toString());
                neu.put("zeitraum", zeitraum);
                repo.protokoll(tenant, id, null, BerichtRechte.ANLEGEN, null, text(neu), null, wer, rolle, jetzt);
                return neueKennung;
            });
        } catch (DuplicateKeyException e) {
            throw repo.berichtZu(v.schluessel(), v.geltungArt(), g.id(), zeitraum).map(BerichtService::gibtEsSchon)
                    .orElseGet(() -> BerichtAbgelehnt.von(Ablehnung.GLEICHZEITIG));
        }
        return uebersicht(tenant, repo.bericht(kennung).orElseThrow());
    }

    // ================================================================================ freigeben

    /** {@code POST …/freigeben} mit dem Datenstand des gesehenen Entwurfs (F1–F5). */
    public Freigabe freigeben(String kennung, Instant uebermittelt, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.FREIGEBEN);
        Kopf kopf = z.kopf();
        try {
            return transaktion.execute(tx -> freigebenInDerTransaktion(z, uebermittelt.truncatedTo(ChronoUnit.MICROS), wer));
        } catch (DuplicateKeyException e) {
            return repo.standZumDatenstand(kopf.tenant(), kopf.id(), uebermittelt)
                    .map(nr -> new Freigabe(new Stand(kopf, geprueft(kopf, nr), teilansicht(z)), false))
                    .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.GLEICHZEITIG));
        }
    }

    private Freigabe freigebenInDerTransaktion(Zugriff z, Instant uebermittelt, ProtokollAkteur wer) {
        Kopf kopf = z.kopf();
        UUID tenant = kopf.tenant();
        Instant jetzt = z.jetzt();
        repo.sperren(tenant, kopf.id());
        Optional<Integer> schon = repo.standZumDatenstand(tenant, kopf.id(), uebermittelt);
        if (schon.isPresent()) {
            return new Freigabe(new Stand(kopf, geprueft(kopf, schon.get()), teilansicht(z)), false);
        }
        EntwurfZeile e = repo.entwurf(tenant, kopf.id(), "FOR SHARE")
                .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        List<StandZeile> staende = repo.staende(tenant, kopf.id());
        StandZeile gueltig = staende.isEmpty() ? null : staende.get(staende.size() - 1);
        JsonNode abzug = baum(e.abzug());

        // D2 bei der Freigabe und D3: seit dem Datenstand darf sich an keiner Quelle etwas geändert haben.
        List<BerichtRegeln.Aenderung> dazwischen = new ArrayList<>(BerichtRegeln.d2(e.datenstand(),
                zeiten(abzug, "berechnet_am"), zeiten(abzug, "endgueltig_ab"), true));
        dazwischen.addAll(BerichtRegeln.d3(e.datenstand(), jetzt, aenderungenSeit(kopf, e.datenstand(), jetzt)));
        boolean gesehen = uebermittelt.equals(e.datenstand());
        List<BerichtRegeln.Abweichung> abweichungen = gesehen || gueltig == null ? List.of()
                : BerichtRegeln.abweichungen(baum(repo.stand(tenant, kopf.id(), gueltig.nr()).orElseThrow().abzug()), abzug);
        String anlass = gesehen ? null : repo.anlassDerNeubildung(tenant, kopf.kennung(), e.datenstand());
        BerichtRegeln.Freigabe f = BerichtRegeln.freigabe(new BerichtRegeln.FreigabeAntrag(kopf.zeitraumArt(),
                kopf.schluessel(), kopf.zone(), jetzt, freigabeWerte(abzug), uebermittelt,
                dazwischen.isEmpty() ? e.datenstand() : null, gueltig == null ? 0 : gueltig.nr(), anlass,
                abweichungen.size()));
        if (!f.erlaubt()) {
            throw abgelehnt(f, kopf.zone(), dazwischen, abweichungen);
        }

        int nr = f.nr();
        String rolle = rolle(z.darf(), wer);
        UUID anlassAnstoss = gueltig == null ? null : repo.anstoesse(tenant, kopf.id()).stream()
                .filter(a -> a.nr() == gueltig.nr() && OFFEN.equals(a.zustand())).map(AnstossZeile::id).findFirst()
                .orElse(null);
        repo.standEinfrieren(tenant, kopf.id(), nr, e.datenstand(), jetzt, wer, rolle, objekt(abzug.path("kopf").path("darstellung")),
                objekt(abzug.path("kopf").path("regelwerk")), kopf.vorlageFassung(), anlassAnstoss)
                .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.GLEICHZEITIG));
        repo.quellenEinfrieren(tenant, kopf.id(), nr);
        if (gueltig != null) {
            repo.ersetzen(tenant, kopf.id(), gueltig.nr(), nr);
        }
        repo.anstoesseErledigen(tenant, kopf.id(), nr);
        StandZeile neu = repo.stand(tenant, kopf.id(), nr).orElseThrow();
        ereignisFreigegeben(tenant, kopf.kennung(), neu);
        Map<String, Object> protokoll = new LinkedHashMap<>();
        protokoll.put("nr", nr);
        protokoll.put("datenstand", neu.datenstand().toString());
        protokoll.put("pruefsumme", neu.pruefsumme());
        protokoll.put("anlass_anstoss_id", anlassAnstoss == null ? null : anlassAnstoss.toString());
        repo.protokoll(tenant, kopf.id(), nr, BerichtRechte.FREIGEBEN, null, text(protokoll), null, wer, rolle, jetzt);
        return new Freigabe(new Stand(kopf, neu, teilansicht(z)), true);
    }

    // ================================================================================ Anstoß, archivieren

    /** {@code POST …/anstoesse/{id}/verwerfen}: Anstoß des Berichts (404) → Begründung (422) → offen (409) (R4, F5). */
    public Verworfen verwerfen(String kennung, String anstossId, String begruendung, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.VERWERFEN);
        Kopf kopf = z.kopf();
        UUID id = uuid(anstossId).orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        AnstossZeile a = repo.anstoss(kopf.tenant(), kopf.id(), id)
                .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        pruefeBegruendung(begruendung);
        if (!OFFEN.equals(a.zustand())) {
            throw BerichtAbgelehnt.von(Ablehnung.ANSTOSS_NICHT_OFFEN, Map.of("zustand", a.zustand()));
        }
        String rolle = rolle(z.darf(), wer);
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(kopf.tenant(), kopf.id());
            if (!repo.verwerfen(kopf.tenant(), id, begruendung, wer, z.jetzt())) {
                throw BerichtAbgelehnt.von(Ablehnung.ANSTOSS_NICHT_OFFEN,
                        Map.of("zustand", repo.anstoss(kopf.tenant(), kopf.id(), id).orElseThrow().zustand()));
            }
            repo.protokoll(kopf.tenant(), kopf.id(), a.nr(), BerichtRechte.VERWERFEN,
                    text(Map.of("anstoss_id", id.toString(), "zustand", OFFEN)),
                    text(Map.of("anstoss_id", id.toString(), "zustand", VERWORFEN)), begruendung, wer, rolle, z.jetzt());
        });
        return new Verworfen(kopf, repo.anstoss(kopf.tenant(), kopf.id(), id).orElseThrow());
    }

    /** {@code POST …/archivieren}: verbirgt den Bericht in der Liste, die Stände bleiben lesbar (V4); ein zweites Mal ändert nichts. */
    public Uebersicht archivieren(String kennung, ProtokollAkteur wer) {
        Zugriff z = zugriff(kennung, wer, BerichtRechte.ARCHIVIEREN);
        Kopf kopf = z.kopf();
        String rolle = rolle(z.darf(), wer);
        transaktion.executeWithoutResult(tx -> {
            repo.sperren(kopf.tenant(), kopf.id());
            if (repo.archivieren(kopf.tenant(), kopf.id(), z.jetzt())) {
                Map<String, Object> alt = new LinkedHashMap<>();
                alt.put("archiviert_am", null);
                repo.protokoll(kopf.tenant(), kopf.id(), null, BerichtRechte.ARCHIVIEREN, text(alt),
                        text(Map.of("archiviert_am", z.jetzt().toString())), null, wer, rolle, z.jetzt());
            }
        });
        return uebersicht(kopf.tenant(), repo.bericht(kennung).orElseThrow());
    }

    // ================================================================================ D4 und Fristen

    /** D4 — die Änderungen an den Quellen und die abgelaufenen Fristen seit dem Datenstand; leer = der Entwurf ist aktuell. */
    List<BerichtRegeln.Aenderung> aenderungenSeit(Kopf kopf, Instant datenstand, Instant jetzt) {
        List<BerichtRegeln.Aenderung> alle = new ArrayList<>(repo.aenderungenSeit(kopf.tenant(), kopf.id(), datenstand));
        alle.addAll(fristen(BerichtRegeln.zeitraum(kopf.zeitraumArt(), kopf.schluessel(), kopf.zone()), kopf.zone(),
                datenstand, jetzt));
        return BerichtRegeln.d4(datenstand, alle);
    }

    /**
     * Was ohne neue Zeile anders geworden ist: das Ende des Zeitraums („Zeitraum läuft“ gilt nicht mehr) und jedes „endgültig
     * ab“ eines Tags im Zeitraum, das in (Datenstand, jetzt] liegt — der Endgültigkeits-Lauf ändert {@code berechnet_am}
     * nicht. Die Frist spricht {@link TagRegeln#endgueltigAb}.
     */
    static List<BerichtRegeln.Aenderung> fristen(BerichtRegeln.Zeitraum z, ZoneId zone, Instant datenstand, Instant jetzt) {
        List<BerichtRegeln.Aenderung> raus = new ArrayList<>();
        if (dazwischen(z.bis(), datenstand, jetzt)) {
            raus.add(new BerichtRegeln.Aenderung(null, ZEITRAUM_ZU_ENDE, z.bis()));
        }
        for (LocalDate tag = z.ersterTag(); !tag.isAfter(z.letzterTag()); tag = tag.plusDays(1)) {
            Instant ab = TagRegeln.endgueltigAb(TagRegeln.beginn(tag.plusDays(1), zone));
            if (dazwischen(ab, datenstand, jetzt)) {
                raus.add(new BerichtRegeln.Aenderung(null, BerichtRegeln.ENDGUELTIG_AB, ab));
            }
        }
        return raus;
    }

    private static boolean dazwischen(Instant t, Instant nach, Instant bis) {
        return t.isAfter(nach) && !t.isAfter(bis);
    }

    private Entwurf aktuellerEntwurf(Zugriff z) {
        Kopf kopf = z.kopf();
        EntwurfZeile gelesen = repo.entwurf(kopf.tenant(), kopf.id(), "")
                .orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        AtomicBoolean neu = new AtomicBoolean(false);
        EntwurfZeile e = gelesen;
        if (!aenderungenSeit(kopf, gelesen.datenstand(), z.jetzt()).isEmpty()) {
            e = transaktion.execute(tx -> {
                EntwurfZeile gesperrt = repo.entwurf(kopf.tenant(), kopf.id(), "FOR UPDATE").orElseThrow();
                if (aenderungenSeit(kopf, gesperrt.datenstand(), z.jetzt()).isEmpty()) {
                    return gesperrt; // eine andere Anfrage oder die Kaskade hat ihn eben neu gebildet
                }
                bilden(kopf.id(), kopf.geltungArt(), z.jetzt(), GEBILDET_BEIM_ABRUF);
                neu.set(true);
                return repo.entwurf(kopf.tenant(), kopf.id(), "").orElseThrow();
            });
        }
        return new Entwurf(kopf, e, neu.get(), teilansicht(z));
    }

    /** EW3 — die Bildung auf der Verbindung DIESER Transaktion. */
    private void bilden(UUID bericht, String geltungArt, Instant jetzt, String gebildetVon) {
        if (!BerichtRegeln.STANDORT.equals(geltungArt)) {
            throw BerichtAbgelehnt.von(Ablehnung.UNTERNEHMENSBERICHT_FOLGT);
        }
        DataSource quelle = jdbc.getDataSource();
        Connection con = DataSourceUtils.getConnection(quelle);
        try {
            bildung.bilden(con, bericht, jetzt, gebildetVon);
        } finally {
            DataSourceUtils.releaseConnection(con, quelle);
        }
    }

    // ================================================================================ Hilfen

    private Zugriff zugriff(String kennung, ProtokollAkteur wer, String handlung) {
        kundenbereich();
        Instant jetzt = jetzt();
        Kopf kopf = repo.bericht(kennung).orElseThrow(() -> BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN));
        Benutzer b = aufrufer.benutzer(wer);
        Kundenbereich k = rechteKundenbereich();
        DarfErgebnis d = darf(b, k, handlung, kopf, jetzt);
        if (!d.darf()) {
            throw BerichtAbgelehnt.rechte(d);
        }
        return new Zugriff(kopf, d, b, k, jetzt);
    }

    private static DarfErgebnis darf(Benutzer b, Kundenbereich k, String handlung, Kopf kopf, Instant jetzt) {
        return BerichtRechte.darf(b, k, handlung, kopf.geltungArt(),
                kopf.standortId() == null ? null : kopf.standortId().toString(), jetzt);
    }

    /** Darf die Person irgendeinen Bericht lesen — am Unternehmen oder an einem Standort? Sonst das Nein (403 vor 404). */
    private static void irgendwoLesbar(Benutzer b, Kundenbereich k, Instant jetzt) {
        DarfErgebnis nein = BerichtRechte.darf(b, k, BerichtRechte.ABRUFEN, BerichtRegeln.UNTERNEHMEN, null, jetzt);
        if (nein.darf()) {
            return;
        }
        for (RechteAbleitung.Standort s : k.standorte()) {
            DarfErgebnis d = BerichtRechte.darf(b, k, BerichtRechte.ABRUFEN, BerichtRegeln.STANDORT, s.kennzeichen(), jetzt);
            if (d.darf()) {
                return;
            }
            if (nein.http() != 403 && d.http() == 403) {
                nein = d;
            }
        }
        throw BerichtAbgelehnt.rechte(nein);
    }

    /** Die Standorte des Kundenbereichs als Standort-IDs (Muster Kennzahl); die Kundenadministratoren kennt die API nicht. */
    private Kundenbereich rechteKundenbereich() {
        return new Kundenbereich("Kundenbereich", repo.standorte().stream()
                .map(s -> new RechteAbleitung.Standort(s.id().toString(), s.name())).toList(), List.of());
    }

    private static List<String> teilansicht(Zugriff z) {
        return BerichtRechte.teilansicht(z.benutzer(), z.kundenbereich(), z.jetzt());
    }

    /** Die Rolle, die das Recht gab — so steht sie an Stand und Protokoll. */
    private static String rolle(DarfErgebnis d, ProtokollAkteur wer) {
        return d.rolle() == null ? wer.rolle() : d.rolle().code();
    }

    private Uebersicht uebersicht(UUID tenant, Kopf x) {
        List<StandZeile> staende = repo.staende(tenant, x.id());
        Instant datenstand = repo.entwurfDatenstand(tenant, x.id()).orElse(null);
        if (staende.isEmpty()) {
            return new Uebersicht(x, null, datenstand, ZEICHEN_ENTWURF,
                    datenstand == null ? null : BerichtRegeln.entwurf(datenstand, x.zone()));
        }
        StandZeile gueltig = staende.get(staende.size() - 1);
        List<AnstossZeile> anstoesse = repo.anstoesse(tenant, x.id()).stream().filter(a -> a.nr() == gueltig.nr()).toList();
        Optional<AnstossZeile> offen = anstoesse.stream().filter(a -> OFFEN.equals(a.zustand())).findFirst();
        if (offen.isPresent()) {
            return new Uebersicht(x, gueltig.nr(), datenstand, ZEICHEN_REVISION,
                    BerichtRegeln.revisionNoetig(BerichtRegeln.anlass(offen.get().anlassKennung())));
        }
        AnstossZeile letzter = anstoesse.isEmpty() ? null : anstoesse.get(anstoesse.size() - 1);
        if (letzter != null && VERWORFEN.equals(letzter.zustand())) {
            return new Uebersicht(x, gueltig.nr(), datenstand, ZEICHEN_VERWORFEN,
                    BerichtRegeln.anstossVerworfen(letzter.verworfenBegruendung()));
        }
        return new Uebersicht(x, gueltig.nr(), datenstand, ZEICHEN_STAND, BerichtRegeln.berichtsstand(gueltig.nr()));
    }

    /** Ein Stand, dessen Prüfsumme über den gespeicherten Text stimmt — sonst 500 {@code abzug_beschaedigt}. */
    private StandZeile geprueft(Kopf kopf, int nr) {
        Optional<StandZeile> s = nr < 1 ? Optional.empty() : repo.stand(kopf.tenant(), kopf.id(), nr);
        if (s.isEmpty()) {
            List<StandZeile> alle = repo.staende(kopf.tenant(), kopf.id());
            StandZeile neueste = alle.isEmpty() ? null : alle.get(alle.size() - 1);
            Map<String, Object> fakten = new LinkedHashMap<>();
            fakten.put("nr", nr);
            fakten.put("neueste_nr", neueste == null ? null : neueste.nr());
            throw BerichtAbgelehnt.regel(Ablehnung.STAND_GIBT_ES_NICHT, BerichtRegeln.standGibtEsNicht(nr,
                    neueste == null ? null : neueste.nr(), neueste == null ? null : neueste.freigegebenAm(), kopf.zone()),
                    fakten);
        }
        if (!BerichtRegeln.pruefsumme(s.get().abzug()).equals(s.get().pruefsumme())) {
            throw BerichtAbgelehnt.regel(Ablehnung.ABZUG_BESCHAEDIGT, BerichtRegeln.abzugBeschaedigt(nr), Map.of("nr", nr));
        }
        return s.get();
    }

    private Geltung geltung(boolean standort, String geltungId) {
        Optional<UUID> id = uuid(geltungId);
        Optional<Geltung> g = id.isEmpty() ? Optional.empty()
                : (standort ? repo.standorte().stream() : repo.unternehmen().stream()).filter(x -> x.id().equals(id.get()))
                        .findFirst();
        return g.orElseThrow(() -> BerichtAbgelehnt.regel(Ablehnung.GELTUNG_UNBEKANNT,
                BerichtRegeln.SAETZE.get(BerichtRegeln.GELTUNG_UNBEKANNT), Map.of("feld", "geltung_id")));
    }

    private static BerichtAbgelehnt gibtEsSchon(Kopf x) {
        return BerichtAbgelehnt.regel(Ablehnung.BERICHT_GIBT_ES_SCHON,
                BerichtRegeln.berichtGibtEsSchon(x.kennung(), x.geltungName(), x.zeitraumArt(), x.schluessel()),
                Map.of("kennung", x.kennung()));
    }

    /** Die Ablehnung einer F1-Voraussetzung mit Code, Kundensatz und Fakten; Zeitpunkte in der Zone der Geltung. */
    private static BerichtAbgelehnt abgelehnt(BerichtRegeln.Freigabe f, ZoneId zone, List<BerichtRegeln.Aenderung> dazwischen,
            List<BerichtRegeln.Abweichung> abweichungen) {
        Map<String, Object> fakten = new LinkedHashMap<>();
        switch (f.code()) {
            case BerichtRegeln.ZEITRAUM_NICHT_ZU_ENDE -> fakten.put("moeglich_ab", mitVersatz(f.moeglichAb(), zone));
            case BerichtRegeln.WERTE_VORLAEUFIG -> {
                fakten.put("vorlaeufig", f.vorlaeufig());
                fakten.put("vorlaeufige", f.vorlaeufige());
                fakten.put("moeglich_ab", mitVersatz(f.moeglichAb(), zone));
            }
            default -> {
                fakten.put("datenstand_uebermittelt", mitVersatz(f.datenstandUebermittelt(), zone));
                fakten.put("datenstand_aktuell", mitVersatz(f.datenstandAktuell(), zone));
                fakten.put("abweichungen", abweichungen.stream().map(BerichtService::abweichung).toList());
                fakten.put("aenderungen", dazwischen.stream().map(a -> {
                    Map<String, Object> m = new LinkedHashMap<>();
                    m.put("quelle", a.quelle());
                    m.put("art", a.art());
                    m.put("zeitpunkt", mitVersatz(a.zeitpunkt(), zone));
                    return m;
                }).toList());
            }
        }
        return BerichtAbgelehnt.regel(Ablehnung.valueOf(f.code().toUpperCase(Locale.ROOT)), f.kundensatz(), fakten);
    }

    static Map<String, Object> abweichung(BerichtRegeln.Abweichung a) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("quelle", a.quelle());
        m.put("menge_art", a.mengeArt());
        m.put("vorher", a.vorher() == null ? null : a.vorher().toPlainString());
        m.put("nachher", a.nachher() == null ? null : a.nachher().toPlainString());
        m.put("version", a.version());
        m.put("anlass", a.anlass());
        return m;
    }

    /** F1 — jeder Wert und jede Kennzahl des Abzugs mit Fassung und „endgültig ab“. */
    static List<BerichtRegeln.FreigabeWert> freigabeWerte(JsonNode abzug) {
        List<BerichtRegeln.FreigabeWert> raus = new ArrayList<>();
        for (String abschnitt : List.of("werte", "kennzahlen")) {
            abzug.path(abschnitt).forEach(w -> raus.add(new BerichtRegeln.FreigabeWert(w.path("quelle").asText(),
                    w.path("name_zum_datenstand").asText(null), w.path("fassung").asText(null), zeit(w.path("endgueltig_ab")))));
        }
        return raus;
    }

    /** D2 — jeder Zeitpunkt eines Felds in Werten und Kennzahlen des Abzugs. */
    static List<Instant> zeiten(JsonNode abzug, String feld) {
        List<Instant> raus = new ArrayList<>();
        for (String abschnitt : List.of("werte", "kennzahlen")) {
            abzug.path(abschnitt).forEach(w -> {
                Instant t = zeit(w.path(feld));
                if (t != null) {
                    raus.add(t);
                }
            });
        }
        return raus;
    }

    private static Instant zeit(JsonNode n) {
        return n.isTextual() ? OffsetDateTime.parse(n.asText()).toInstant() : null;
    }

    private static String mitVersatz(Instant t, ZoneId zone) {
        return t == null ? null : t.atZone(zone).toOffsetDateTime().format(DateTimeFormatter.ISO_OFFSET_DATE_TIME);
    }

    /** Die Meldung {@code bericht_freigegeben} (Urheber kunde, Bezug der Bericht) — Kennung abgeleitet, eine je Stand. */
    private void ereignisFreigegeben(UUID tenant, String kennung, StandZeile s) {
        ObjectNode e = json.createObjectNode();
        e.put("ereignis_id", UUID.nameUUIDFromBytes((EREIGNIS_FREIGEGEBEN + ":" + tenant + ":" + kennung + ":" + s.nr())
                .getBytes(StandardCharsets.UTF_8)).toString());
        e.put("art", EREIGNIS_FREIGEGEBEN);
        e.put("zeitpunkt", s.freigegebenAm().truncatedTo(ChronoUnit.SECONDS).toString());
        e.put("bericht", kennung);
        e.put("nr", s.nr());
        e.put("datenstand", s.datenstand().truncatedTo(ChronoUnit.SECONDS).toString());
        e.put("pruefsumme", s.pruefsumme());
        MessreiheEreignisRepository.Ergebnis r = ereignisse.anhaengen(tenant, null, EreignisVokabular.Urheber.KUNDE, e, null,
                null);
        if (r.ausgang() != MessreiheEreignisRepository.Ausgang.ANGEHAENGT) {
            throw new IllegalStateException(EREIGNIS_FREIGEGEBEN + " nicht angehängt: " + r.ausgang() + " " + r.grund() + " "
                    + r.hinweis());
        }
    }

    private static void pruefeBegruendung(String text) {
        if (text == null || text.isBlank()) {
            throw BerichtAbgelehnt.von(Ablehnung.BEGRUENDUNG_FEHLT, Map.of("feld", "begruendung"));
        }
        int zeichen = text.codePointCount(0, text.length());
        if (zeichen < TEXT_MINDESTENS || zeichen > TEXT_HOECHSTENS) {
            throw BerichtAbgelehnt.von(Ablehnung.BEGRUENDUNG_FEHLT, Map.of("feld", "begruendung", "zeichen", zeichen));
        }
    }

    private static UUID kundenbereich() {
        UUID tenant = TenantContext.get();
        if (tenant == null) {
            throw BerichtAbgelehnt.von(Ablehnung.NICHT_GEFUNDEN);
        }
        return tenant;
    }

    private static Optional<UUID> uuid(String text) {
        try {
            return text == null ? Optional.empty() : Optional.of(UUID.fromString(text));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    static JsonNode baum(String abzug) {
        try {
            return ABZUG.readTree(abzug);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("Ein gespeicherter Abzug ist kein JSON", e);
        }
    }

    /** Ein Objekt des Abzugs als Text für {@code jsonb}; fehlt es, das leere Objekt. */
    private static String objekt(JsonNode n) {
        return n.isObject() ? n.toString() : "{}";
    }

    private String text(Map<String, Object> werte) {
        try {
            return json.writeValueAsString(werte);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
