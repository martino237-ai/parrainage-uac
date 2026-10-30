import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { api, API, photo } from '../api.js';

function Person({ p, label }) {
  const [ko, setKo] = useState(false);
  return (
    <figure className="pcard">
      {ko ? <div className="ph">{p.nom[0]}</div> : <img src={photo(p.id)} alt={p.nom} onError={() => setKo(true)} />}
      <figcaption>
        <span className="role">{label}</span>
        <strong>{p.nom}</strong>
        <span>{p.filiere}, {p.niveau}</span>
      </figcaption>
    </figure>
  );
}

function getProjectionPair(c) {
  if (!c) return null;
  const left = Array.isArray(c.left) ? c.left : (c.parrain ? [c.parrain] : []);
  const right = Array.isArray(c.right) ? c.right : (c.filleul ? [c.filleul] : []);
  if (!left.length && !right.length) return null;

  const leftLabel = left.some(p => p.role === 'filleul') ? 'Filleul' : left.some(p => p.role === 'parrain') ? 'Parrain' : (right[0]?.role === 'filleul' ? 'Filleul' : 'Parrain');
  const rightLabel = right.some(p => p.role === 'parrain') ? 'Parrain' : right.some(p => p.role === 'filleul') ? 'Filleul' : (left[0]?.role === 'parrain' ? 'Parrain' : 'Filleul');

  return {
    left: left.length ? left : [{ ...right[0], role: rightLabel }],
    right: right.length ? right : [{ ...left[0], role: leftLabel }],
    leftLabel: left.length ? leftLabel : rightLabel,
    rightLabel: right.length ? rightLabel : leftLabel
  };
}

export default function Projection() {
  const [e, setE] = useState(null);
  useEffect(() => {
    const load = () => api('/api/projection').then(setE).catch(() => {});
    load();
    const t = setInterval(load, 15000);
    const s = io(API || undefined);
    s.on('etat', setE);
    return () => { clearInterval(t); s.close(); };
  }, []);

  const c = e && !e.suspendu && (e.propose || e.dernier);
  const pair = c ? getProjectionPair(c) : null;
  const valide = !!e && !e.propose && !!e.dernier;

  return (
    <main className="stage">
      <h1>Parrainage {e ? e.annee : ''}</h1>
      {pair ? (
        <>
          <div className="duo">
            <div className="projection-stack">
              {pair.left.map((p, idx) => <Person key={'left-' + (p.id || idx)} p={p} label={pair.leftLabel} />)}
            </div>
            <svg className="thread" viewBox="0 0 120 20" preserveAspectRatio="none" aria-hidden="true"><path d="M0 10 C30 0, 90 20, 120 10" /></svg>
            <div className="projection-stack">
              {pair.right.map((p, idx) => <Person key={'right-' + (p.id || idx)} p={p} label={pair.rightLabel} />)}
            </div>
          </div>
          <p className={'state' + (valide ? ' ok' : '')}>{valide ? 'Couple validé' : 'Nouveau couple'}</p>
        </>
      ) : (
        <p className="wait">{e?.suspendu ? 'Le prochain couple arrive bientôt' : e && e.phase === 'ceremonie' ? 'Le prochain couple arrive' : 'La cérémonie va commencer'}</p>
      )}
      <footer>{e ? e.total : 0} couples formés</footer>
    </main>
  );
}
