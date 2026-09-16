import { useEffect, useState } from 'react';
import { Button } from '../../designsystem/components/core/Button';
import type { Unterstuetzung } from '../api';
import { LIST_POLL_MS } from '../pollCadence';
import { useRollen } from '../rollen';
import { bannerTexte, unterstuetzungApi } from '../unterstuetzung';
import { UnterstuetzungBeenden } from './UnterstuetzungDialog';
import './Unterstuetzung.css';
export function UnterstuetzungBanner() {
  const { selbst, standort, darf } = useRollen();
  const [jetzt, setJetzt] = useState(Date.now()); const [liste, setListe] = useState<Unterstuetzung[]>([]); const [entzug, setEntzug] = useState<Unterstuetzung>();
  const verwalten = darf('unterstuetzung.verwalten', null);
  useEffect(() => { const t = window.setInterval(() => setJetzt(Date.now()), LIST_POLL_MS); return () => window.clearInterval(t); }, []);
  useEffect(() => { let aktiv = true; if (verwalten && selbst?.unterstuetzungen.gewaehrte.length) void unterstuetzungApi.liste().then(l => { if (aktiv) setListe(l); }).catch(() => {}); return () => { aktiv = false; }; }, [verwalten, selbst]);
  const texte = bannerTexte(selbst, standort, jetzt);
  return <>{texte.map((text, n) => {
    const zugriff = liste.find(u => u.banner === text);
    return <aside className="vp-unterstuetzung-banner" role="status" data-notfall={text.includes('Notfall-Zugriff') || undefined} key={`${n}:${text}`}><p>{text}</p>
      {verwalten && zugriff && <Button variant="ghost" onClick={e => { e.currentTarget.focus(); setEntzug(zugriff); }}>Beenden</Button>}</aside>;
  })}{entzug && verwalten && <UnterstuetzungBeenden zugriff={entzug} onClose={() => setEntzug(undefined)} onSaved={() => setListe(l => l.filter(u => u.id !== entzug.id))} />}</>;
}
