package com.voltpilot.api.uems;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.web.dto.EnergieeinsatzDto;
import com.voltpilot.api.web.dto.EnergieeinsatzDto.*;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.zugriff.RechtZiel;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.ZoneId;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/** UEMS AP-16 IP-4: Zuständigkeit verleiht kein Recht; Sichtbarkeit folgt den Prozess-Messstellen. */
@Service
public class EnergieeinsatzService {
    private final EnergieeinsatzRepository repo;
    private final KostenstelleProzessRepository prozesse;
    private final UnternehmenRepository unternehmen;
    private final MessstelleService messstellen;
    private final MessstelleWerteService werte;
    private final RechtPruefung rechte;
    private final ObjectMapper json;
    private final TransactionTemplate tx;

    public EnergieeinsatzService(EnergieeinsatzRepository repo, KostenstelleProzessRepository prozesse,
            UnternehmenRepository unternehmen, MessstelleService messstellen, MessstelleWerteService werte,
            RechtPruefung rechte, ObjectMapper json, PlatformTransactionManager tm) {
        this.repo = repo;
        this.prozesse = prozesse;
        this.unternehmen = unternehmen;
        this.messstellen = messstellen;
        this.werte = werte;
        this.rechte = rechte;
        this.json = json;
        this.tx = new TransactionTemplate(tm);
    }

    public Liste liste(UUID prozess) {
        return new Liste(unternehmen.desKundenbereichs().map(u -> repo.jeUnternehmen(u.id()).stream()
                .filter(e -> prozess == null || prozess.equals(e.prozessId()))
                .filter(e -> sichtbar(e.prozessId()))
                .sorted(Comparator.comparing((EnergieeinsatzRepository.Zeile e) -> e.gueltigBis() != null)
                        .thenComparing(EnergieeinsatzRepository.Zeile::angelegtAm)
                        .thenComparing(EnergieeinsatzRepository.Zeile::kennzeichen))
                .map(this::darstellung).toList()).orElse(List.of()));
    }

    public Einsatz einer(UUID id) { return darstellung(finde(id)); }

    public Vorschlaege vorschlaege() {
        LocalDate heute = heute();
        return new Vorschlaege(prozesse.alle(KostenstelleProzessRepository.Art.PROZESS).stream()
                .filter(p -> !p.gueltigAb().isAfter(heute) && (p.gueltigBis() == null || !p.gueltigBis().isBefore(heute)))
                .filter(p -> sichtbar(p.id()))
                .filter(p -> repo.jeProzess(p.id()).stream().noneMatch(e -> e.gueltigBis() == null && e.traeger().equals("Strom")))
                .map(p -> new Vorschlag(new Verweis(p.id(), p.kennzeichen(), p.name()), "Strom")).toList());
    }

    public UUID anlegen(Anlegen a, ProtokollAkteur wer) {
        try {
            return tx.execute(s -> {
                name(a.name());
                if (a.prozessId() == null || prozesse.finde(KostenstelleProzessRepository.Art.PROZESS, a.prozessId()).isEmpty())
                    throw abgelehnt("prozess_unbekannt", "Bitte wählen Sie einen vorhandenen Prozess.");
                if (a.traeger() == null || !BewertungRegeln.TRAEGER.contains(a.traeger()))
                    throw abgelehnt("traeger_unbekannt", "Bitte wählen Sie einen vorhandenen Träger.");
                verantwortlich(a.verantwortlichSub());
                List<EnergieeinsatzRepository.Einfluss> einfluesse = einfluesse(a.einflussgroessen() == null ? List.of() : a.einflussgroessen());
                UUID id = repo.anlegen(new EnergieeinsatzRepository.Neu(a.prozessId(), a.traeger(), a.name().strip(),
                        text(a.wortlaut()), text(a.verbraucherWortlaut()), a.verantwortlichSub(),
                        a.gueltigAb() == null ? heute() : a.gueltigAb()), wer);
                if (!einfluesse.isEmpty()) repo.einflussgroessenErsetzen(id, einfluesse, wer);
                return id;
            });
        } catch (DataIntegrityViolationException e) {
            if (e.getMostSpecificCause().getMessage().contains("energieeinsatz_ein_laufender_uq"))
                throw new EnergieeinsatzAbgelehnt(409, "einsatz_laeuft_bereits",
                        "Für diesen Prozess und Träger gibt es bereits einen laufenden Energieeinsatz.");
            throw e;
        }
    }

    public void bearbeiten(UUID id, Bearbeiten a, ProtokollAkteur wer) {
        tx.executeWithoutResult(s -> { finde(id); name(a.name());
            laufend(repo.bearbeiten(id, a.name().strip(), text(a.wortlaut()), text(a.verbraucherWortlaut()), wer)); });
    }
    public void beenden(UUID id, Beenden a, ProtokollAkteur wer) {
        tx.executeWithoutResult(s -> {
            var e = finde(id);
            if (text(a.grund()) == null) throw abgelehnt("grund_fehlt", "Bitte geben Sie einen Grund für das Beenden an.");
            LocalDate bis = a.gueltigBis() == null ? heute() : a.gueltigBis();
            if (bis.isBefore(e.gueltigAb())) throw abgelehnt("zeitraum_ungueltig", "Bitte wählen Sie einen letzten Tag ab dem Beginn.");
            laufend(repo.beenden(id, bis, a.grund().strip(), wer));
        });
    }
    public void verantwortlicher(UUID id, VerantwortlicherSetzen a, ProtokollAkteur wer) {
        tx.executeWithoutResult(s -> { finde(id); verantwortlich(a.verantwortlichSub());
            laufend(repo.verantwortlichenSetzen(id, a.verantwortlichSub(), wer)); });
    }
    public void einflussgroessen(UUID id, EinfluesseSetzen a, ProtokollAkteur wer) {
        tx.executeWithoutResult(s -> { finde(id); laufend(repo.einflussgroessenErsetzen(id, einfluesse(a.einflussgroessen()), wer)); });
    }
    public Protokoll protokoll(UUID id) {
        finde(id);
        return new Protokoll(repo.aenderungen(id).stream().map(a -> new Aenderung(a.id(), a.art(),
                json(a.alt()), json(a.neu()), a.akteur(), a.zeit())).toList());
    }

    EnergieeinsatzRepository.Zeile sichtbareZeile(UUID id) {
        var e = repo.finde(id).orElseThrow(EnergieeinsatzAbgelehnt::fehlt);
        if (!sichtbar(e.prozessId())) throw EnergieeinsatzAbgelehnt.fehlt();
        return e;
    }
    private EnergieeinsatzRepository.Zeile finde(UUID id) { return sichtbareZeile(id); }
    private boolean sichtbar(UUID prozess) {
        return rechte.lesbar(RechtZiel.UNTERNEHMEN, null) || repo.messstellen(prozess, heute()).stream()
                .anyMatch(id -> rechte.lesbar(RechtZiel.MESSSTELLE, id));
    }
    private Einsatz darstellung(EnergieeinsatzRepository.Zeile e) {
        var p = prozesse.finde(KostenstelleProzessRepository.Art.PROZESS, e.prozessId()).orElseThrow();
        var v = e.verantwortlich();
        List<Messstelle> ms = repo.messstellen(p.id(), heute()).stream()
                .filter(id -> rechte.lesbar(RechtZiel.MESSSTELLE, id)).map(this::messstelle).toList();
        boolean keineWerte = ms.stream().filter(m -> m.art().equals("gemessen") && m.traeger().equals(e.traeger()))
                .noneMatch(m -> m.letzterMonat() != null && m.letzterMonat().werte().stream().anyMatch(w -> w.menge() != null));
        return new Einsatz(e.id(), e.kennzeichen(), new Verweis(p.id(), p.kennzeichen(), p.name()), e.traeger(),
                e.name(), e.wortlaut(), e.verbraucherWortlaut(), new Verantwortlicher(v.sub(), v.name(), v.konto(),
                e.verantwortlichZustand(), e.ohneKontoSeit()), repo.einflussgroessen(e.id(), false).stream()
                .map(x -> new Einfluss(x.bezugsgroesseId(), x.wortlaut(), x.art())).toList(), ms, keineWerte,
                e.gueltigAb(), e.gueltigBis(), e.beendetAm(), e.beendetGrund());
    }
    private Messstelle messstelle(UUID id) {
        rechte.pruefenLesen(RechtZiel.MESSSTELLE, id, EnergieeinsatzAbgelehnt::fehlt);
        var m = messstellen.eine(id);
        YearMonth monat = YearMonth.from(heute()).minusMonths(1);
        // Nur direkte Messwerte; berechnete Messstellen bleiben ohne Wertübersicht (B3).
        var letzterMonat = m.art().equals("gemessen")
                ? werte.werte(m.kennzeichen(), "monat", monat.atDay(1).toString(), monat.atEndOfMonth().toString(), null) : null;
        return new Messstelle(m.id(), m.kennzeichen(), m.name(), m.art(), m.medium(), m.orte(), m.lebenszyklus(), letzterMonat);
    }
    private List<EnergieeinsatzRepository.Einfluss> einfluesse(List<Einfluss> liste) {
        if (liste == null) throw einflussFehler();
        return liste.stream().map(e -> {
            if (e == null || e.art() == null || !List.of("produktion", "betriebszeit", "wetter", "sonstige").contains(e.art())
                    || (e.bezugsgroesseId() == null) == (text(e.wortlaut()) == null)
                    || (e.bezugsgroesseId() != null && !repo.bezugsgroesseVorhanden(e.bezugsgroesseId()))) throw einflussFehler();
            return new EnergieeinsatzRepository.Einfluss(e.bezugsgroesseId(), text(e.wortlaut()), e.art());
        }).toList();
    }
    private void verantwortlich(String sub) {
        if (sub != null && !repo.verantwortlicherVorhanden(sub))
            throw abgelehnt("verantwortlicher_unbekannt", "Bitte wählen Sie eine Person aus Ihrem Kundenbereich.");
    }
    private static void name(String name) {
        if (text(name) == null) throw abgelehnt("name_fehlt", "Bitte geben Sie einen Namen an.");
    }
    private static void laufend(boolean geaendert) {
        if (!geaendert) throw new EnergieeinsatzAbgelehnt(409, "einsatz_beendet", "Dieser Energieeinsatz ist bereits beendet.");
    }
    private static EnergieeinsatzAbgelehnt einflussFehler() {
        return abgelehnt("einflussgroesse_ungueltig", "Bitte wählen Sie eine Bezugsgröße oder geben Sie einen Wortlaut und eine Art an.");
    }
    private static EnergieeinsatzAbgelehnt abgelehnt(String code, String satz) { return new EnergieeinsatzAbgelehnt(422, code, satz); }
    private static String text(String s) { return s == null || s.isBlank() ? null : s.strip(); }
    private LocalDate heute() {
        return LocalDate.now(ZoneId.of(unternehmen.desKundenbereichs().map(UnternehmenRepository.Unternehmen::zeitzone).orElse("Europe/Berlin")));
    }
    private JsonNode json(String s) {
        try { return s == null ? null : json.readTree(s); }
        catch (JsonProcessingException e) { throw new IllegalStateException("Ungültiger Protokoll-Schnappschuss", e); }
    }
}
