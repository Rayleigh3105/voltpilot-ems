/**
 * Die Routen der Benachrichtigungs-Einstellungen (`/api/v1/zustellwege/*`, `/api/v1/ruhezeit*`) für Bühnen mit
 * gestelltem `fetch`: die Bühne der Einstellungsseite (`einstellungen.tsx`) und die Hilfe-Bühne (`help-fixtures.ts`).
 * Dort stürzte `#/einstellungen` ab, weil nichts diese Routen beantwortete. EINE Quelle, damit beide Bühnen dieselbe
 * Antwort der API sprechen. `fall` wie bei der Einstellungs-Bühne: `voll | leer | unbestaetigt | ohne-telegram`;
 * `ruhezeitAktiv` lässt die Probe eine laufende Ruhezeit melden.
 *
 * Die Antwort ist `null`, wenn die Route nicht zu den Einstellungen gehört - der Aufrufer reicht sie dann weiter.
 */
export function zustellwegeFixture({ fall = 'voll', ruhezeitAktiv = false }: { fall?: string; ruhezeitAktiv?: boolean } = {}) {
  const EMAIL_VOLL = {
    ziel: 'ines.kaltenbach@ahrenberg.example',
    bestaetigt: true,
    aktiv: true,
    abSchwere: 'warnung' as const,
    zusammenfassungAktiv: true,
    zusammenfassungUhrzeit: '07:00:00',
  };

  let email: typeof EMAIL_VOLL | null =
    fall === 'leer' ? null : fall === 'unbestaetigt' ? { ...EMAIL_VOLL, bestaetigt: false } : EMAIL_VOLL;
  let pushAbos =
    fall === 'voll'
      ? [
          {
            id: 'p1',
            geraet: 'iPhone von Ines',
            aktiv: true,
            abSchwere: 'warnung' as const,
            erstelltAm: '2026-10-01T10:00:00Z',
            endpoint: 'https://push.example/p1',
          },
        ]
      : [];
  let webhookZiele =
    fall === 'voll'
      ? [{ id: 'w1', url: 'https://hooks.example/teams', name: 'Energieteam', aktiv: true, abSchwere: 'warnung' as const, erstelltAm: '2026-10-01T10:00:00Z' }]
      : [];
  let telegramZiele =
    fall === 'voll' ? [{ id: 't1', bestaetigt: true, aktiv: true, abSchwere: 'warnung' as const, erstelltAm: '2026-10-01T10:00:00Z' }] : [];
  let ruhezeitRegeln = fall === 'voll' ? { werktags: { von: '22:00', bis: '07:00' }, wochenende: 'ganz' as const } : {};
  let dringendDurch = true;


  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response | null> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    const methode = (init?.method ?? 'GET').toUpperCase();
    const pfad = url.pathname;
    const json = (body: unknown, status = 200) => Promise.resolve(Response.json(body, { status }));
    // 204/202 dürfen keinen Rumpf tragen (sonst wirft der `Response`-Konstruktor) - die echte api
    // sendet dort ebenfalls leer.
    const leer = (status: number) => Promise.resolve(new Response(null, { status }));

    if (pfad === '/api/v1/zustellwege/email') {
      if (methode === 'POST') {
        const { ziel } = JSON.parse(String(init?.body)) as { ziel: string };
        email = { ...EMAIL_VOLL, ziel, bestaetigt: false };
        return leer(202);
      }
      if (methode === 'DELETE') {
        email = null;
        return leer(204);
      }
      return email ? json(email) : leer(204);
    }
    if (pfad === '/api/v1/zustellwege/email/einstellungen' && methode === 'PUT') {
      const body = JSON.parse(String(init?.body));
      if (email) email = { ...email, ...body };
      return leer(204);
    }
    // Scheibe 2 (Entscheid 10A/B12) - spezifische Pfade zuerst, sonst läse der generische
    // Präfix-Endpunkt unten "aktiv"/"probe" fälschlich als Kennung.
    if (pfad === '/api/v1/zustellwege/email/aktiv' && methode === 'PUT') {
      const { aktiv } = JSON.parse(String(init?.body)) as { aktiv: boolean };
      if (email) email = { ...email, aktiv };
      return leer(204);
    }
    if (pfad === '/api/v1/zustellwege/email/probe' && methode === 'POST') {
      return json({ erfolgreich: true, fehler: null });
    }
    if (pfad === '/api/v1/zustellwege/push' && methode === 'GET') return json(pushAbos);
    if (pfad.endsWith('/name') && pfad.startsWith('/api/v1/zustellwege/push/') && methode === 'PUT') {
      const id = pfad.split('/').slice(-2, -1)[0];
      const { geraet } = JSON.parse(String(init?.body)) as { geraet: string };
      pushAbos = pushAbos.map((a) => (a.id === id ? { ...a, geraet } : a));
      return leer(204);
    }
    if (pfad.endsWith('/probe') && pfad.startsWith('/api/v1/zustellwege/push/') && methode === 'POST') {
      return json({ erfolgreich: true, fehler: null });
    }
    if (pfad.startsWith('/api/v1/zustellwege/push/') && methode === 'PUT') {
      const id = pfad.split('/').pop();
      const body = JSON.parse(String(init?.body));
      pushAbos = pushAbos.map((a) => (a.id === id ? { ...a, ...body } : a));
      return leer(204);
    }
    if (pfad.startsWith('/api/v1/zustellwege/push/') && methode === 'DELETE') {
      const id = pfad.split('/').pop();
      pushAbos = pushAbos.filter((a) => a.id !== id);
      return leer(204);
    }
    if (pfad === '/api/v1/zustellwege/webhook' && methode === 'GET') return json(webhookZiele);
    if (pfad === '/api/v1/zustellwege/webhook' && methode === 'POST') {
      const body = JSON.parse(String(init?.body)) as { url: string; name: string };
      const neu = { id: `w${webhookZiele.length + 2}`, url: body.url, name: body.name, aktiv: true, abSchwere: 'warnung' as const, erstelltAm: new Date().toISOString() };
      webhookZiele = [...webhookZiele, neu];
      return json({ id: neu.id, geheimnis: 'ein-geheimnis' }, 201);
    }
    if (pfad === '/api/v1/zustellwege/webhook/probe' && methode === 'POST') {
      const { url } = JSON.parse(String(init?.body)) as { url: string };
      const unsicher = !url.startsWith('https://');
      return json({ erfolgreich: !unsicher, fehler: unsicher ? 'Nur https-Adressen sind sicher.' : null });
    }
    if (pfad.endsWith('/adresse') && pfad.startsWith('/api/v1/zustellwege/webhook/') && methode === 'PUT') {
      const id = pfad.split('/').slice(-2, -1)[0];
      const body = JSON.parse(String(init?.body)) as { url: string; name: string };
      webhookZiele = webhookZiele.map((z) => (z.id === id ? { ...z, url: body.url, name: body.name } : z));
      return leer(204);
    }
    if (pfad.endsWith('/probe') && pfad.startsWith('/api/v1/zustellwege/webhook/') && methode === 'POST') {
      return json({ erfolgreich: true, fehler: null });
    }
    if (pfad.startsWith('/api/v1/zustellwege/webhook/') && methode === 'PUT') {
      const id = pfad.split('/').pop();
      const body = JSON.parse(String(init?.body));
      webhookZiele = webhookZiele.map((z) => (z.id === id ? { ...z, ...body } : z));
      return leer(204);
    }
    if (pfad.startsWith('/api/v1/zustellwege/webhook/') && methode === 'DELETE') {
      const id = pfad.split('/').pop();
      webhookZiele = webhookZiele.filter((z) => z.id !== id);
      return leer(204);
    }
    if (pfad === '/api/v1/zustellwege/telegram' && methode === 'GET') {
      return json({ verfuegbar: fall !== 'ohne-telegram', ziele: telegramZiele });
    }
    if (pfad === '/api/v1/zustellwege/telegram/verbinden' && methode === 'POST') {
      return json({ link: 'https://t.me/VoltPilotBot?start=ein-token' });
    }
    if (pfad.endsWith('/probe') && pfad.startsWith('/api/v1/zustellwege/telegram/') && methode === 'POST') {
      return json({ erfolgreich: true, fehler: null });
    }
    if (pfad.startsWith('/api/v1/zustellwege/telegram/') && methode === 'PUT') {
      const id = pfad.split('/').pop();
      const body = JSON.parse(String(init?.body));
      telegramZiele = telegramZiele.map((z) => (z.id === id ? { ...z, ...body } : z));
      return leer(204);
    }
    if (pfad.startsWith('/api/v1/zustellwege/telegram/') && methode === 'DELETE') {
      const id = pfad.split('/').pop();
      telegramZiele = telegramZiele.filter((z) => z.id !== id);
      return leer(204);
    }
    if (pfad === '/api/v1/ruhezeit' && methode === 'GET') {
      return json({ regeln: JSON.stringify(ruhezeitRegeln), zeitzone: 'Europe/Berlin', dringendDurch });
    }
    if (pfad === '/api/v1/ruhezeit' && methode === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { regeln: string; zeitzone: string; dringendDurch: boolean };
      ruhezeitRegeln = JSON.parse(body.regeln);
      dringendDurch = body.dringendDurch;
      return leer(204);
    }
    if (pfad === '/api/v1/ruhezeit/probe' && methode === 'POST') {
      return json({ aktivBis: ruhezeitAktiv ? '2026-10-20T06:00:00Z' : null });
    }
    return null;
  };
}
