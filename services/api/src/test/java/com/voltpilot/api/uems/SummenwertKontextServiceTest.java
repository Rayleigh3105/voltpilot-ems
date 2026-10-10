package com.voltpilot.api.uems;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.voltpilot.api.measurement.MeasurementCatalog;
import com.voltpilot.api.measurement.SummenwertQuellenService;
import com.voltpilot.api.zugriff.Geltungsbereich;
import com.voltpilot.api.zugriff.RechtPruefung;
import com.voltpilot.api.tenant.TenantContext;
import com.voltpilot.api.web.dto.MessstelleFormelDto;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionStatus;
import org.springframework.web.server.ResponseStatusException;

/** Herkunft gemessener Bausteine: aktueller Hauptkanal, niemals eine fremde oder abgelaufene Quelle. */
class SummenwertKontextServiceTest {
    private final UUID site = UUID.randomUUID(), box = UUID.randomUUID(), own = UUID.randomUUID(),
            other = UUID.randomUUID(), measured = UUID.randomUUID();
    private final Instant now = Instant.parse("2026-09-16T10:00:00Z");
    private final MessstelleRepository messstellen = mock(MessstelleRepository.class);
    private final MessstelleFormelTermRepository terme = mock(MessstelleFormelTermRepository.class);
    private final MessstelleFormelFassungRepository fassungen = mock(MessstelleFormelFassungRepository.class);
    private final MessstelleFormelWerteRepository werte = mock(MessstelleFormelWerteRepository.class);
    private final MessstelleQuelleRepository quellen = mock(MessstelleQuelleRepository.class);
    private final SummenwertQuellenService geraete = mock(SummenwertQuellenService.class);
    private final Geltungsbereich scope = mock(Geltungsbereich.class);
    private final RechtPruefung rechte = mock(RechtPruefung.class);
    private MessstelleFormelService service;

    @BeforeEach void setup() {
        TenantContext.set(UUID.randomUUID());
        var tx = mock(PlatformTransactionManager.class);
        when(tx.getTransaction(any())).thenReturn(mock(TransactionStatus.class));
        service = new MessstelleFormelService(messstellen, mock(MessstelleAenderungRepository.class),
                terme, fassungen,
                werte, quellen, mock(MessstelleService.class), mock(MeasurementCatalog.class),
                mock(UnternehmenRepository.class), tx, new ObjectMapper(), new AnteilLeseweg(mock(AnteilLeseweg.Verteilungen.class)),
                mock(KostenstelleProzessRepository.class), mock(BilanzRestRepository.class), mock(BilanzStellungen.class),
                mock(org.springframework.beans.factory.ObjectProvider.class), rechte, geraete, scope);
        service.uhrStellen(Clock.fixed(now, ZoneOffset.UTC));
        when(geraete.geraet(site, box, "inverter")).thenReturn(Set.of(own));
        when(werte.anlage(own)).thenReturn(Optional.of(site));
        when(werte.anlage(other)).thenReturn(Optional.of(site));
        var m = mock(MessstelleRepository.Messstelle.class);
        when(m.id()).thenReturn(measured); when(m.art()).thenReturn("gemessen");
        when(m.hauptgroesse()).thenReturn(new MessstelleRegeln.Groesse("Wirkleistung", "Erzeugung", "kW", "Momentanwert"));
        when(messstellen.finde(measured)).thenReturn(Optional.of(m));
        when(messstellen.anlegen(any())).thenReturn(m);
    }
    @AfterEach void cleanup() { TenantContext.clear(); }

    private MessstelleQuelleRepository.Quelle quelle(UUID entity, Instant bis) {
        var q = mock(MessstelleQuelleRepository.Quelle.class);
        when(q.rolle()).thenReturn("fuehrend"); when(q.groesse()).thenReturn("Wirkleistung");
        when(q.richtung()).thenReturn("Erzeugung"); when(q.entityId()).thenReturn(entity);
        when(q.gueltigAb()).thenReturn(now.minusSeconds(3600)); when(q.gueltigBis()).thenReturn(bis);
        return q;
    }
    private void anlegen() {
        service.anlegen(new MessstelleFormelDto.Anlegen("Test", null,
                List.of(new MessstelleFormelDto.TermEingabe("messstelle", null, null, measured, "+", 1.0, false, null, null)),
                null, new MessstelleFormelDto.Kontext("geraet", site, box, "inverter")),
                new ProtokollAkteur("test", "Test", null, "kunde"));
    }
    @Test void fremdeFuehrendeQuelleWirdBenanntAbgelehntUndSchreibtNichts() {
        doReturn(List.of(quelle(other, null))).when(quellen).derMessstelle(measured);
        assertThatThrownBy(this::anlegen).isInstanceOf(MessstelleFormelAbgelehnt.class).satisfies(e -> {
            var a = (MessstelleFormelAbgelehnt) e;
            assertThat(a.status()).isEqualTo(422); assertThat(a.fakten()).containsEntry("grund", "anderes_geraet");
        });
        verify(messstellen, never()).anlegen(any());
    }
    @Test void saldoUeberspringtDenGeraeteKontextNicht() {
        doReturn(List.of(quelle(other, null))).when(quellen).derMessstelle(measured);
        assertThatThrownBy(() -> service.anlegen(new MessstelleFormelDto.Anlegen("Saldo", null,
                List.of(new MessstelleFormelDto.TermEingabe("messstelle", null, null, measured, "+", 1.0, false, null, null)),
                null, new MessstelleFormelDto.Kontext("geraet", site, box, "inverter"), "saldo", LocalDate.of(2026, 9, 16)),
                new ProtokollAkteur("test", "Test", null, "kunde")))
                .isInstanceOf(MessstelleFormelAbgelehnt.class).satisfies(e ->
                        assertThat(((MessstelleFormelAbgelehnt) e).fakten()).containsEntry("grund", "anderes_geraet"));
        verify(messstellen, never()).anlegen(any());
    }
    @Test void amEndzeitpunktZaehltNurDieNeueEigeneFuehrendeQuelle() {
        doReturn(List.of(quelle(other, now), quelle(own, null))).when(quellen).derMessstelle(measured);
        anlegen();
        verify(messstellen).anlegen(any());
    }
    @Test void andereAnlageImSelbenMandantenIst404() {
        doReturn(List.of(quelle(other, null))).when(quellen).derMessstelle(measured);
        when(werte.anlage(other)).thenReturn(Optional.of(UUID.randomUUID()));
        assertThatThrownBy(this::anlegen).isInstanceOf(ResponseStatusException.class)
                .satisfies(e -> assertThat(((ResponseStatusException) e).getStatusCode().value()).isEqualTo(404));
        verify(messstellen, never()).anlegen(any());
    }
    @Test void fehlendeFuehrendeQuelleIstKeineLeereErlaubteHerkunft() {
        when(quellen.derMessstelle(measured)).thenReturn(List.of());
        assertThatThrownBy(this::anlegen).isInstanceOf(MessstelleFormelAbgelehnt.class)
                .satisfies(e -> assertThat(((MessstelleFormelAbgelehnt) e).fakten()).containsEntry("grund", "quelle_nicht_aufloesbar"));
    }
    @Test void nurDieHeutigeFassungBegrenztDenGeraeteKontext() {
        var m = messstellen.finde(measured).orElseThrow();
        when(m.art()).thenReturn("berechnet");
        UUID alt = UUID.randomUUID(), aktuell = UUID.randomUUID(), zukunft = UUID.randomUUID();
        LocalDate heute = now.atZone(ZoneOffset.UTC).toLocalDate();
        when(fassungen.wirksame(measured)).thenReturn(List.of(
                new MessstelleFormelFassungRepository.FassungZeile(alt, 1, "gewichtete_summe", null, heute.minusDays(1), "anlage", false, null, now),
                new MessstelleFormelFassungRepository.FassungZeile(aktuell, 2, "gewichtete_summe", heute, heute, "eintrag", false, null, now),
                new MessstelleFormelFassungRepository.FassungZeile(zukunft, 3, "gewichtete_summe", heute.plusDays(1), null, "eintrag", false, null, now)));
        when(terme.derFassung(aktuell)).thenReturn(List.of(kanal(own)));
        anlegen();
        verify(terme).derFassung(aktuell);
        verify(terme, never()).derFassung(alt);
        verify(terme, never()).derFassung(zukunft);
        verify(terme, never()).derMessstelle(any());
        verify(scope).requireSite(site);
        verify(rechte).pruefen(eq("messstelle.formel"), eq(com.voltpilot.api.zugriff.RechtZiel.ANLAGE), eq(site), any());
    }

    @Test void verteilungsTermDerAktuellenFassungPrueftAuchSeineQuellkomponente() {
        var m = messstellen.finde(measured).orElseThrow();
        when(m.art()).thenReturn("berechnet");
        UUID fassung = UUID.randomUUID(), quelle = UUID.randomUUID();
        when(fassungen.wirksame(measured)).thenReturn(List.of(
                new MessstelleFormelFassungRepository.FassungZeile(fassung, 1, "gewichtete_summe", null, null, "anlage", false, null, now)));
        when(terme.derFassung(fassung)).thenReturn(List.of(new MessstelleFormelTermRepository.TermZeile(
                UUID.randomUUID(), 0, "verteilung", null, null, quelle, "+", 1, false, UUID.randomUUID(), null)));
        var q = mock(MessstelleRepository.Messstelle.class);
        when(q.art()).thenReturn("gemessen"); doReturn(m.hauptgroesse()).when(q).hauptgroesse();
        when(messstellen.finde(quelle)).thenReturn(Optional.of(q));
        doReturn(List.of(quelle(other, null))).when(quellen).derMessstelle(quelle);
        assertThatThrownBy(this::anlegen).isInstanceOf(MessstelleFormelAbgelehnt.class)
                .satisfies(e -> assertThat(((MessstelleFormelAbgelehnt) e).fakten()).containsEntry("grund", "anderes_geraet"));
        verify(messstellen, never()).anlegen(any());
    }

    @Test void standortZaunWirdVorGeraeteAufloesungGeprueft() {
        doThrow(new ResponseStatusException(org.springframework.http.HttpStatus.NOT_FOUND)).when(scope).requireSite(site);
        assertThatThrownBy(this::anlegen).isInstanceOf(ResponseStatusException.class);
        verifyNoInteractions(geraete);
        verify(messstellen, never()).anlegen(any());
    }

    private MessstelleFormelTermRepository.TermZeile kanal(UUID entity) {
        return new MessstelleFormelTermRepository.TermZeile(UUID.randomUUID(), 0, "messkanal", entity,
                "pv", null, "+", 1, false, null, null);
    }

}
