package com.voltpilot.api.uems;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.uems.EreignisVokabular.Urheber;
import com.voltpilot.api.web.dto.BewertungRanglisteDto.*;
import com.voltpilot.api.web.dto.EnergieeinsatzEinstufungDto.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** F1-F5: Zahlen schlagen vor; ausschließlich eine Person legt eine begründete Einstufungs-Fassung an. */
@Service
public class EnergieeinsatzEinstufungService {
    private static final Set<String> EINSTUFUNGEN = Set.of("wesentlich", "nicht_wesentlich");
    private static final Set<String> GRUENDE = Set.of("K1", "K2", "K3", "K4");

    private final EnergieeinsatzEinstufungRepository repo;
    private final EnergieeinsatzService einsaetze;
    private final UnternehmenRepository unternehmen;
    private final ObjectMapper json;
    private final MessreiheEreignisRepository ereignisse;

    public EnergieeinsatzEinstufungService(EnergieeinsatzEinstufungRepository repo,
            EnergieeinsatzService einsaetze, UnternehmenRepository unternehmen, ObjectMapper json,
            MessreiheEreignisRepository ereignisse) {
        this.repo = repo;
        this.einsaetze = einsaetze;
        this.unternehmen = unternehmen;
        this.json = json;
        this.ereignisse = ereignisse;
    }

    @Transactional(readOnly = true)
    public Historie historie(UUID einsatz) {
        einsaetze.einer(einsatz);
        return new Historie(repo.fassungen(einsatz));
    }

    @Transactional
    public Fassung speichern(UUID einsatz, Speichern anfrage, ProtokollAkteur wer) {
        var e = einsaetze.sichtbareZeile(einsatz);
        if (anfrage == null) throw anfrage();
        String einstufung = text(anfrage.einstufung());
        if (!EINSTUFUNGEN.contains(einstufung))
            throw ungueltig("einstufung_ungueltig", "Bitte wählen Sie wesentlich oder nicht wesentlich.");
        String begruendung = text(anfrage.begruendung());
        if (begruendung == null)
            throw ungueltig("begruendung_fehlt", "Bitte begründen Sie die Einstufung.");
        List<String> grund = anfrage.grund();
        if (grund == null || grund.stream().anyMatch(x -> x == null)
                || !GRUENDE.containsAll(grund) || new HashSet<>(grund).size() != grund.size())
            throw ungueltig("grund_ungueltig", "Bitte verwenden Sie K1 bis K4 ohne Wiederholung.");
        grund = List.copyOf(grund);
        JsonNode herkunft = herkunft(anfrage.herkunft(), e.traeger());
        LocalDate heute = heute();
        LocalDate tag = anfrage.gueltigAb() == null ? heute : anfrage.gueltigAb();
        if (tag.isAfter(heute) || tag.isBefore(e.gueltigAb()))
            throw ungueltig("gueltig_ab_ungueltig", "Bitte wählen Sie einen Tag zwischen Beginn und heute.");

        repo.sperren(einsatz);
        if (repo.beantragt(einsatz).isPresent())
            throw new EnergieeinsatzAbgelehnt(409, "freigabe_offen",
                    "Bitte bestätigen Sie zuerst die vorgeschlagene Einstufung.");
        var vorher = repo.fassungen(einsatz).stream()
                .filter(f -> f.freigabeStatus().equals("freigegeben") && f.gueltigBis() == null).findFirst();
        if (vorher.isPresent() && !tag.isAfter(vorher.get().gueltigAb()))
            throw ungueltig("gueltig_ab_ungueltig", "Eine neue Fassung muss nach der wirksamen Fassung beginnen.");
        int nummer = repo.naechsteNummer(einsatz);
        boolean vieraugen = repo.vieraugen(e.unternehmenId());
        if (!vieraugen && vorher.isPresent()) repo.vorherigeBeenden(einsatz, tag.minusDays(1));
        repo.anlegen(einsatz, nummer, einstufung, begruendung, grund, herkunft, tag, tag.isBefore(heute), wer, vieraugen);
        repo.protokoll(einsatz, nummer, "einstufung_gesetzt", null, wer);
        if (!vieraugen) ereignis(einsatz, e.kennzeichen(), nummer, einstufung, grund);
        return repo.fassungen(einsatz).stream().filter(f -> f.fassung() == nummer).findFirst().orElseThrow();
    }

    @Transactional
    public Fassung bestaetigen(UUID einsatz, ProtokollAkteur wer) {
        var e = einsaetze.sichtbareZeile(einsatz);
        repo.sperren(einsatz);
        Fassung offen = repo.beantragt(einsatz).orElseThrow(() ->
                new EnergieeinsatzAbgelehnt(409, "keine_freigabe_offen", "Es wartet keine Einstufung auf Bestätigung."));
        if (wer.sub().equals(offen.akteur().sub()))
            throw new EnergieeinsatzAbgelehnt(403, "zweite_person_noetig", "Freigabe durch eine zweite Person.");
        LocalDate tag = heute();
        repo.fassungen(einsatz).stream()
                .filter(f -> f.freigabeStatus().equals("freigegeben") && f.gueltigBis() == null)
                .findFirst().ifPresent(f -> {
                    if (!tag.isAfter(f.gueltigAb()))
                        throw ungueltig("gueltig_ab_ungueltig", "Die Bestätigung muss nach der wirksamen Fassung liegen.");
                    repo.vorherigeBeenden(einsatz, tag.minusDays(1));
                });
        repo.bestaetigen(einsatz, offen.fassung(), tag, wer);
        repo.protokoll(einsatz, offen.fassung(), "einstufung_bestaetigt", null, wer);
        ereignis(einsatz, e.kennzeichen(), offen.fassung(), offen.einstufung(), offen.grund());
        return repo.fassungen(einsatz).stream().filter(f -> f.fassung() == offen.fassung()).findFirst().orElseThrow();
    }

    private JsonNode herkunft(HerkunftEntwurf h, String traeger) {
        boolean falsch = h == null || text(h.zeitraum()) == null || h.kriterienFassung() < 1
                || h.eingaenge() == null || h.eingaenge().stream().anyMatch(this::eingangFehlt)
                || h.urteil() == null || text(h.urteil().K1()) == null || text(h.urteil().K2()) == null
                || text(h.urteil().K3()) == null || text(h.urteil().K5()) == null
                || text(h.urteil().K6()) == null || text(h.vorschlag()) == null;
        if (!falsch && "Strom".equals(traeger)) falsch = nennerFehlt(h.nenner());
        if (!falsch && !"Strom".equals(traeger)) falsch = h.nenner() != null;
        if (falsch) throw ungueltig("herkunft_unvollstaendig",
                "Bitte übernehmen Sie den vollständigen Herkunftssatz aus der Rangliste.");
        return json.valueToTree(h);
    }

    private void ereignis(UUID einsatz, String kennzeichen, int fassung, String einstufung, List<String> gruende) {
        UUID tenant = TenantContext.get();
        UUID id = UUID.nameUUIDFromBytes(("einstufung_gesetzt:" + tenant + ":" + einsatz + ":" + fassung)
                .getBytes(StandardCharsets.UTF_8));
        var e = json.createObjectNode();
        e.put("ereignis_id", id.toString());
        e.put("art", "einstufung_gesetzt");
        e.put("zeitpunkt", Instant.now().truncatedTo(ChronoUnit.SECONDS).toString());
        e.put("energieeinsatz", kennzeichen);
        e.put("fassung", fassung);
        var g = e.putArray("gruende");
        gruende.forEach(g::add);
        e.put("einstufung", einstufung);
        var ausgang = ereignisse.anhaengen(tenant, null, Urheber.KUNDE, e, null, null);
        if (ausgang.ausgang() == MessreiheEreignisRepository.Ausgang.VERWORFEN) {
            throw new IllegalStateException("einstufung_gesetzt verworfen: " + ausgang.grund() + " " + ausgang.hinweis());
        }
    }

    private boolean eingangFehlt(HerkunftEingang e) {
        return e == null || text(e.objekt()) == null || text(e.von()) == null || text(e.bis()) == null
                || text(e.wert()) == null || e.version() == null || e.version() < 1 || text(e.zustand()) == null;
    }

    private boolean nennerFehlt(HerkunftNenner n) {
        return n == null || text(n.wert()) == null || text(n.anlagen()) == null || n.bilanzwerte() == null
                || n.bilanzwerte().isEmpty() || n.bilanzwerte().stream().anyMatch(b -> b == null
                    || text(b.anlage()) == null || b.von() == null || b.bis() == null || text(b.wert()) == null
                    || b.version() < 1 || text(b.zustand()) == null || b.eingaenge() == null
                    || b.eingaenge().stream().anyMatch(x -> x == null || text(x.objekt()) == null
                        || text(x.wert()) == null || x.version() < 1 || text(x.zustand()) == null));
    }

    private LocalDate heute() {
        return LocalDate.now(ZoneId.of(unternehmen.desKundenbereichs()
                .orElseThrow(EnergieeinsatzAbgelehnt::fehlt).zeitzone()));
    }

    private static EnergieeinsatzAbgelehnt anfrage() {
        return new EnergieeinsatzAbgelehnt(400, "anfrage_ungueltig", "Bitte prüfen Sie die Angaben Ihrer Anfrage.");
    }
    private static EnergieeinsatzAbgelehnt ungueltig(String code, String satz) {
        return new EnergieeinsatzAbgelehnt(422, code, satz);
    }
    private static String text(String s) { return s == null || s.isBlank() ? null : s.strip(); }
}
