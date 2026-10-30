import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { api, API, photo } from '../api.js';

const PH = ['inscriptions', 'closes', 'pointage', 'ceremonie', 'termine'];
const PHL = { inscriptions: 'Inscriptions ouvertes', closes: 'Inscriptions closes', pointage: 'Pointage', ceremonie: 'Cérémonie', termine: 'Terminé' };
const DOS = { en_attente: 'En attente', valide: 'Validé', rejete: 'Rejeté' };

export default function Admin() {
  const [logged, setLogged] = useState(!!sessionStorage.getItem('tok'));
  const sortir = () => { sessionStorage.removeItem('tok'); setLogged(false); };
  return logged ? <Panel sortir={sortir} /> : <Login ok={() => setLogged(true)} />;
}

function Login({ ok }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  async function go(e) {
    e.preventDefault();
    try {
      const d = await api('/api/admin/login', { method: 'POST', body: { username: u, password: p } });
      sessionStorage.setItem('tok', d.token); ok();
    } catch (x) { setErr(x.message); }
  }
  return (
    <main className="page narrow admin-auth">
      <form className="card admin-login-card" onSubmit={go}>
        <div className="admin-brand">
          <img src="/uac-logo.jpg" alt="Logo de l’Université Adventiste Cosendai" />
          <div>
            <span className="eyebrow">Comité UAC</span>
            <strong>Parrainage</strong>
          </div>
        </div>
        <h1>Espace comité</h1>
        <p className="hint admin-subtitle">Accédez au pilotage des inscriptions, du pointage et de la cérémonie.</p>
        <label>Identifiant<input value={u} onChange={e => setU(e.target.value)} autoComplete="username" required /></label>
        <label>Mot de passe<input type="password" value={p} onChange={e => setP(e.target.value)} autoComplete="current-password" required /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="pri big">Se connecter</button>
      </form>
    </main>
  );
}

function Panel({ sortir }) {
  const [tab, setTab] = useState('dash');
  const [camp, setCamp] = useState(null);
  const [stats, setStats] = useState(null);
  const [msg, setMsg] = useState('');

  const reload = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api('/api/campagne'), api('/api/admin/stats')]);
      setCamp(c); setStats(s);
    } catch (e) { setMsg(e.message); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const run = async fn => {
    try { setMsg(''); await fn(); await reload(); } catch (e) { setMsg(e.message); }
  };

  if (!camp || !stats) return <main className="page"><p>{msg || 'Chargement…'}</p></main>;
  const Tab = { dash: Dash, parts: Parts, tirage: Tirage, couples: Couples, journal: Journal }[tab];
  return (
    <main className="page wide">
      <header className="bar">
        <strong>Parrainage UAC {camp.annee}</strong>
        <span className="pill">{PHL[camp.phase]}</span>
        <button className="ghost" onClick={sortir}>Se déconnecter</button>
      </header>
      <nav className="tabs">
        {[['dash', 'Tableau de bord'], ['parts', 'Inscrits'], ['tirage', 'Tirage'], ['couples', 'Couples'], ['journal', 'Journal d’audit']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => { setMsg(''); setTab(k); }}>{l}</button>
        ))}
      </nav>
      {msg && <div className="err" role="alert">{msg}</div>}
      <Tab camp={camp} stats={stats} run={run} />
    </main>
  );
}

function Dash({ camp, stats, run }) {
  const i = PH.indexOf(camp.phase);
  const verrou = i >= 3;
  const set = b => run(() => api('/api/admin/campagne', { method: 'PUT', body: b }));
  const aller = j => {
    if (!window.confirm(`Passer de « ${PHL[camp.phase]} » à « ${PHL[PH[j]]} » ?`)) return;
    set({ phase: PH[j] });
  };
  return (
    <section>
      <div className="grid2">
        {['parrain', 'filleul'].map(r => (
          <div className="card" key={r}>
            <h2>{r === 'parrain' ? 'Parrains' : 'Filleuls'}</h2>
            <p>{stats[r].total} inscrits, {stats[r].valides} validés, {stats[r].attente} en attente</p>
            <p><strong>{stats[r].presents}</strong> présents</p>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Activation des étapes du parrainage</h2>
        <p className="steps">{PH.map((p, idx) => <span key={p} className={'step' + (idx === i ? ' cur' : '') + (idx < i ? ' done' : '')}>{PHL[p]}</span>)}</p>
        <p className="hint">Le comité active les étapes dans l’ordre. Cela permet d’ouvrir les inscriptions, de fermer le dépôt, de lancer le pointage, puis la cérémonie.</p>
        <div className="actions">
          {i < PH.length - 1 ? (
            <button className="pri" onClick={() => aller(i + 1)}>Activer la phase : {PHL[PH[i + 1]]}</button>
          ) : (
            <button className="pri" disabled>Parrainage terminé</button>
          )}
        </div>
      </div>
      <div className="card">
        <h2>Règles du tirage</h2>
        {verrou && <p className="hint">Règles verrouillées depuis l’ouverture de la cérémonie.</p>}
        <label>Filleuls par parrain
          <select disabled={verrou} value={camp.capacite_parrain} onChange={e => set({ capacite_parrain: +e.target.value })}>
            {[1, 2, 3, 4, 5].map(n => <option key={n}>{n}</option>)}
          </select>
        </label>
        <label className="chk"><input type="checkbox" disabled={verrou} checked={!!camp.niveau_superieur} onChange={e => set({ niveau_superieur: e.target.checked })} />Le parrain est d’un niveau supérieur au filleul</label>
        <label className="chk"><input type="checkbox" disabled={verrou} checked={!!camp.meme_filiere} onChange={e => set({ meme_filiere: e.target.checked })} />Le parrain et le filleul sont de la même filière</label>
      </div>
      <p>Couples formés : <strong>{stats.couples}</strong></p>
    </section>
  );
}

function Parts({ camp, run }) {
  const [f, setF] = useState({ role: '', dossier: '', q: '' });
  const [rows, setRows] = useState([]);
  const load = useCallback(() => api('/api/admin/participants?' + new URLSearchParams(f)).then(setRows).catch(() => {}), [f]);
  useEffect(() => { load(); }, [load]);
  const act = fn => run(async () => { await fn(); await load(); });
  const pointage = ['pointage', 'ceremonie'].includes(camp.phase);
  const dossier = (id, d) => {
    const motif = d === 'rejete' ? window.prompt('Motif obligatoire du rejet du dossier :') : undefined;
    if (d === 'rejete' && !motif?.trim()) return;
    act(() => api(`/api/admin/participants/${id}/dossier`, { method: 'PATCH', body: { dossier: d, ...(motif ? { motif } : {}) } }));
  };
  const supprimer = p => {
    if (!window.confirm(`Supprimer définitivement le dossier de ${p.nom} ?`)) return;
    const motif = window.prompt('Motif obligatoire de la suppression :');
    if (!motif?.trim()) return;
    act(() => api(`/api/admin/participants/${p.id}`, { method: 'DELETE', body: { motif } }));
  };

  return (
    <section>
      <div className="filters">
        <select value={f.role} onChange={e => setF({ ...f, role: e.target.value })} aria-label="Rôle">
          <option value="">Tous</option><option value="parrain">Parrains</option><option value="filleul">Filleuls</option>
        </select>
        <select value={f.dossier} onChange={e => setF({ ...f, dossier: e.target.value })} aria-label="Dossier">
          <option value="">Tous les dossiers</option>{Object.entries(DOS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        <input placeholder="Nom ou matricule" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
      </div>
      {!rows.length && <p className="hint">Aucun inscrit pour ce filtre.</p>}
      {rows.map(p => (
        <div className="row" key={p.id}>
          <img src={photo(p.id, true)} alt="" />
          <div className="grow">
            <strong>{p.nom}</strong> <span className="tag">{p.role}</span>
            <div className="sub">{p.matricule}, {p.filiere}, {p.niveau}, {p.telephone}</div>
            {p.motif_rejet && <div className="sub">Motif du rejet : {p.motif_rejet}</div>}
          </div>
          <span className={'tag ' + p.dossier}>{DOS[p.dossier]}</span>
          {p.dossier !== 'valide' && <button onClick={() => dossier(p.id, 'valide')}>Valider</button>}
          {p.dossier !== 'rejete' && <button onClick={() => dossier(p.id, 'rejete')}>Rejeter</button>}
          {p.dossier === 'valide' && (
            <label className="chk"><input type="checkbox" disabled={!pointage} checked={!!p.present}
              onChange={e => act(() => api(`/api/admin/participants/${p.id}/present`, { method: 'PATCH', body: { present: e.target.checked } }))} />Présent</label>
          )}
          <button className="ghost" onClick={() => supprimer(p)}>Supprimer</button>
        </div>
      ))}
    </section>
  );
}

function getPairView(c) {
  if (!c) return { left: [], right: [] };
  const left = Array.isArray(c.left) ? c.left : (c.parrain ? [c.parrain] : []);
  const right = Array.isArray(c.right) ? c.right : (c.filleul ? [c.filleul] : []);
  if (!left.length && !right.length) return { left: [], right: [] };
  const leftLabel = left.some(p => p.role === 'filleul') ? 'Filleul' : left.some(p => p.role === 'parrain') ? 'Parrain' : (right[0]?.role === 'filleul' ? 'Filleul' : 'Parrain');
  const rightLabel = right.some(p => p.role === 'parrain') ? 'Parrain' : right.some(p => p.role === 'filleul') ? 'Filleul' : (left[0]?.role === 'parrain' ? 'Parrain' : 'Filleul');
  return {
    left: left.length ? left : [{ ...right[0], role: rightLabel }],
    right: right.length ? right : [{ ...left[0], role: leftLabel }],
    leftLabel,
    rightLabel
  };
}

function Duo({ c }) {
  const pair = getPairView(c);
  return (
    <div className="mini">
      {[['left', pair.leftLabel, pair.left], ['right', pair.rightLabel, pair.right]].map(([key, label, members]) => (
        <div key={key} className="pair-column">
          {members.map((p, idx) => (
            <div className="pair-person" key={key + '-' + (p.id || idx)}>
              <img src={photo(p.id)} alt="" />
              <span className="sub">{label}</span>
              <strong>{p.nom}</strong>
              <span className="sub">{p.filiere}, {p.niveau}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function Tirage({ camp, stats, run }) {
  const [e, setE] = useState(null);
  const [info, setInfo] = useState('');
  useEffect(() => {
    api('/api/projection').then(setE).catch(() => {});
    const s = io(API || undefined);
    s.on('etat', setE);
    return () => s.close();
  }, []);
  const go = (path, body) => run(async () => { const d = await api(path, { method: 'POST', body }); setInfo(d.info || ''); setE(d); });
  const signalerAbsence = qui => {
    const motif = window.prompt('Motif du remplacement (obligatoire) :');
    if (!motif?.trim()) return;
    go('/api/admin/tirage/absent', { qui, motif });
  };
  const c = e && e.propose;
  const suspendu = e && e.suspendu;
  const ouvert = camp.phase === 'ceremonie';
  return (
    <section>
      {!ouvert && <div className="err">La cérémonie n’est pas ouverte (phase actuelle : {PHL[camp.phase]}).</div>}
      <p><a href="/projection" target="_blank" rel="noreferrer">Ouvrir l’écran de projection dans un nouvel onglet</a></p>
      <p>Filleuls présents sans parrain : <strong>{Math.max(0, stats.filleul.presents - stats.couples)}</strong>. Couples validés : <strong>{e ? e.total : 0}</strong></p>
      {c ? <Duo c={c} /> : suspendu ? <><Duo c={suspendu} /><p className="err">Proposition suspendue : un membre est conservé jusqu’à disponibilité d’un remplaçant.</p></> : <p className="hint">Aucun couple en attente. Lancez un tirage.</p>}
      <div className="actions">
        <button className="pri big" disabled={!ouvert || !!c} onClick={() => go('/api/admin/tirage')}>Tirer un couple</button>
        <button disabled={!ouvert || !suspendu || !!c} onClick={() => {
          const motif = window.prompt('Motif de la reprise du remplacement :');
          if (motif?.trim()) go('/api/admin/tirage/reprendre', { motif });
        }}>Réessayer le remplacement</button>
        <button className="ok big" disabled={!c} onClick={() => go('/api/admin/tirage/valider')}>Valider le couple</button>
        <button disabled={!c} onClick={() => signalerAbsence('parrain')}>Le parrain est absent</button>
        <button disabled={!c} onClick={() => signalerAbsence('filleul')}>Le filleul est absent</button>
      </div>
      {info && <div className="err">{info}</div>}
    </section>
  );
}

function Couples({ camp, run }) {
  const [rows, setRows] = useState([]);
  const [journal, setJournal] = useState([]);
  const load = useCallback(async () => {
    setRows((await api('/api/admin/couples')).slice().reverse());
    setJournal(await api('/api/admin/log'));
  }, []);
  useEffect(() => { load().catch(() => {}); }, [load]);
  const csv = () => run(async () => {
    const b = await api('/api/admin/export/couples.csv');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = 'couples-parrainage-uac.csv'; a.click();
  });
  const annuler = k => {
    if (!window.confirm('Annuler ce couple ? Les deux personnes retournent dans le tirage.')) return;
    const motif = window.prompt('Motif obligatoire de l’annulation :');
    if (!motif?.trim()) return;
    run(async () => { await api('/api/admin/couples/' + k.id, { method: 'DELETE', body: { motif } }); await load(); });
  };
  return (
    <section>
      <div className="actions noprint">
        <button onClick={csv}>Exporter (Excel / CSV)</button>
        <button onClick={() => window.print()}>Imprimer / PDF</button>
      </div>
      <h2 className="printonly">Liste des couples de parrainage</h2>
      {!rows.length ? <p className="hint">Aucun couple validé pour le moment.</p> : (
        <table>
          <thead><tr><th>N°</th><th>Parrain</th><th>Filleul</th><th className="noprint"></th></tr></thead>
          <tbody>{rows.map((k, i) => (
            <tr key={k.id}>
              <td>{i + 1}</td>
              <td>{k.parrain.nom}<div className="sub">{k.parrain.filiere}, {k.parrain.niveau}</div></td>
              <td>{k.filleul.nom}<div className="sub">{k.filleul.filiere}, {k.filleul.niveau}</div></td>
              <td className="noprint">{camp.phase === 'ceremonie' && <button className="ghost" onClick={() => annuler(k)}>Annuler</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <details className="noprint">
        <summary>Journal des tirages ({journal.length})</summary>
        {journal.map(j => <div className="sub" key={j.id}>{j.created_at} · {j.action} · {j.parrain || '-'} / {j.filleul || '-'}</div>)}
      </details>
    </section>
  );
}

const ACTIONS_AUDIT = {
  'participant.inscription': 'Inscription reçue',
  'participant.dossier.valide': 'Dossier validé',
  'participant.dossier.rejete': 'Dossier rejeté',
  'participant.dossier.en_attente': 'Dossier remis en attente',
  'participant.presence.present': 'Participant pointé présent',
  'participant.presence.absent': 'Participant pointé absent',
  'participant.suppression': 'Dossier supprimé',
  'campagne.phase': 'Phase modifiée',
  'campagne.regles': 'Règles modifiées',
  'couple.proposition': 'Couple proposé',
  'couple.validation': 'Couple validé',
  'couple.absence.parrain': 'Parrain déclaré absent',
  'couple.absence.filleul': 'Filleul déclaré absent',
  'couple.remplacement': 'Remplacement effectué',
  'couple.remplacement.indisponible': 'Remplacement indisponible',
  'couple.reprise': 'Remplacement repris',
  'couple.reprise.indisponible': 'Reprise sans remplaçant disponible',
  'couple.annulation': 'Couple annulé'
};

function Journal() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/admin/audit').then(setRows).catch(e => setError(e.message));
  }, []);
  return (
    <section>
      <h2>Journal des actions</h2>
      <p className="hint">Historique chronologique des actions administratives et des inscriptions. Les mots de passe et les photos n’y sont jamais enregistrés.</p>
      {error && <p className="err" role="alert">{error}</p>}
      {!error && !rows.length && <p className="hint">Aucune action enregistrée.</p>}
      {rows.map(row => (
        <article className="row" key={row.id}>
          <div className="grow">
            <strong>{ACTIONS_AUDIT[row.action] || row.action}</strong>
            <div className="sub">{row.actor} · {row.created_at}{row.entity_id ? ` · ${row.entity_type} #${row.entity_id}` : ''}</div>
            {row.reason && <div className="sub">Motif : {row.reason}</div>}
          </div>
        </article>
      ))}
    </section>
  );
}
