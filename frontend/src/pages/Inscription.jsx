import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const NIVEAUX = ['L1', 'L2', 'L3', 'M1', 'M2'];
const FILIERES = [
  'Informatique',
  'Réseaux et sécurité informatique',
  'Gestion',
  'Comptabilité',
  'Finance',
  'Marketing',
  'Droit',
  'Sciences de l’éducation',
  'Théologie',
  'Communication',
  'Psychologie',
  'Administration publique',
  'Agriculture',
  'Autre'
];

async function compresser(file) {
  const img = await createImageBitmap(file);
  const s = Math.min(1, 1000 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s);
  c.height = Math.round(img.height * s);
  const context = c.getContext('2d');
  if (!context) throw new Error('Impossible de traiter cette photo');
  context.drawImage(img, 0, 0, c.width, c.height);
  for (let q = 0.85; q >= 0.3; q -= 0.1) {
    const b = await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', q));
    if (b && b.size <= 300 * 1024) return b;
  }
  throw new Error('Impossible de compresser cette photo sous 300 Ko. Choisissez une image moins détaillée.');
}

function BrandMark() {
  return <img className="enroll-brand-mark" src="/uac-logo.jpg" alt="Logo de l’Université Adventiste Cosendai" />;
}

function PersonIcon({ role }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
      {role === 'parrain' ? (
        <>
          <path d="M16 16a5.25 5.25 0 1 0 0-10.5A5.25 5.25 0 0 0 16 16Z" />
          <path d="M6.5 26.5c.8-5.2 4.1-7.8 9.5-7.8s8.7 2.6 9.5 7.8M23.5 7.5l1.2 2.5 2.8.4-2 2 .5 2.8-2.5-1.3-2.5 1.3.5-2.8-2-2 2.8-.4 1.2-2.5Z" />
        </>
      ) : (
        <>
          <path d="M16 16a5.25 5.25 0 1 0 0-10.5A5.25 5.25 0 0 0 16 16Z" />
          <path d="M6.5 26.5c.8-5.2 4.1-7.8 9.5-7.8s8.7 2.6 9.5 7.8M25.5 5.5v5m-2.5-2.5h5" />
        </>
      )}
    </svg>
  );
}

export default function Inscription() {
  const [camp, setCamp] = useState(null);
  const [role, setRole] = useState('parrain');
  const [f, setF] = useState({ nom: '', matricule: '', filiere: 'Informatique', niveau: 'L2', telephone: '' });
  const [blob, setBlob] = useState(null);
  const [prev, setPrev] = useState('');
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/api/campagne').then(setCamp).catch(e => setMsg(e.message));
  }, []);

  useEffect(() => () => {
    if (prev) URL.revokeObjectURL(prev);
  }, [prev]);

  const set = k => e => setF(current => ({ ...current, [k]: e.target.value }));
  const ouvert = camp?.phase === 'inscriptions';
  const strict = Boolean(camp?.niveau_superieur);
  const niveaux = NIVEAUX.filter(n => !(strict && ((role === 'parrain' && n === 'L1') || (role === 'filleul' && n === 'M2'))));

  function choisirRole(nextRole) {
    setRole(nextRole);
    setF(current => ({
      ...current,
      niveau: nextRole === 'parrain' && current.niveau === 'L1' ? 'L2' : nextRole === 'filleul' && current.niveau === 'M2' ? 'L3' : current.niveau
    }));
    setMsg('');
  }

  async function choisir(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setBlob(null);
      setPrev('');
      setMsg('La photo d’origine dépasse 10 Mo. Choisissez un fichier plus léger.');
      return;
    }
    try {
      const b = await compresser(file);
      setBlob(b);
      setPrev(URL.createObjectURL(b));
      setMsg('');
    } catch (x) {
      setBlob(null);
      setPrev('');
      setMsg(x.message || 'Impossible de lire cette photo');
    }
  }

  async function envoyer(e) {
    e.preventDefault();
    if (!blob) {
      setMsg('Ajoutez une photo de face pour continuer.');
      return;
    }
    const fd = new FormData();
    fd.append('role', role);
    Object.entries(f).forEach(([k, v]) => fd.append(k, v));
    fd.append('photo', blob, 'photo.jpg');
    setBusy(true);
    setMsg('');
    try {
      await api('/api/inscription', { method: 'POST', form: fd });
      setDone(true);
    } catch (x) {
      setMsg(x.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="enroll-shell">
      <div className="enroll-wrap">
        <header className="enroll-nav">
          <a className="enroll-brand" href="/" aria-label="Accueil du parrainage UAC">
            <BrandMark />
            <span className="enroll-brand-copy">
              <strong>UAC</strong>
              <span>Université Adventiste Cosendai</span>
            </span>
          </a>
          <a className="enroll-committee" href="/admin">
            <span className="enroll-lock" aria-hidden="true">↗</span>
            Espace comité
          </a>
        </header>

        <section className="enroll-layout">
          <div className="enroll-story">
            {ouvert ? (
              <button
                type="button"
                className="enroll-eyebrow enroll-eyebrow-button"
                onClick={() => document.getElementById('enroll-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <span className={`enroll-live-dot ${ouvert ? 'is-open' : ''}`} />
                INSCRIPTIONS OUVERTES {camp?.annee || '2026–2027'}
              </button>
            ) : (
              <span className="enroll-eyebrow"><span className={`enroll-live-dot ${ouvert ? 'is-open' : ''}`} /> PARRAINAGE {camp?.annee || '2026–2027'}</span>
            )}
            <h1>Une belle histoire commence <em>à deux.</em></h1>
            <p className="enroll-lead">Créez des liens, partagez votre expérience et faites grandir l’esprit de famille sur le campus.</p>

            <div className="enroll-art" aria-hidden="true">
              <div className="enroll-art-sun" />
              <div className="enroll-art-arch">
                <svg viewBox="0 0 380 280" fill="none">
                  <path d="M60 260V145C60 72 118 16 190 16s130 56 130 129v115H60Z" fill="url(#arch)" />
                  <path d="M106 260v-99c0-47 37-84 84-84s84 37 84 84v99" stroke="#E8F0CB" strokeWidth="2" strokeDasharray="5 8" />
                  <circle cx="190" cy="147" r="52" fill="#F3A47E" />
                  <path d="M147 224c8-35 22-53 43-53s35 18 43 53" fill="#F7F1DC" />
                  <circle cx="254" cy="161" r="37" fill="#E4B84F" />
                  <path d="M221 224c7-27 18-40 33-40s26 13 33 40" fill="#415B45" />
                  <path d="M96 260c9-28 21-42 37-42 13 0 24 11 32 32M215 260c7-22 18-34 34-34 14 0 26 11 35 34" stroke="#E8F0CB" strokeWidth="3" strokeLinecap="round" />
                  <path d="m81 92 5 10 11 2-8 8 2 11-10-5-10 5 2-11-8-8 11-2 5-10Zm216 15 3 7 8 1-6 6 1 8-7-4-7 4 1-8-6-6 8-1 5-7Z" fill="#EAC469" />
                  <defs>
                    <linearGradient id="arch" x1="190" y1="16" x2="190" y2="260" gradientUnits="userSpaceOnUse">
                      <stop stopColor="#648268" />
                      <stop offset="1" stopColor="#405D47" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>
              <span className="enroll-art-note">Grandir ensemble, naturellement.</span>
            </div>

            <div className="enroll-steps" aria-label="Les étapes">
              <div><span>01</span><p><strong>Inscrivez-vous</strong><small>Votre dossier en quelques minutes</small></p></div>
              <div><span>02</span><p><strong>Rencontrez votre binôme</strong><small>Le comité prépare la cérémonie</small></p></div>
            </div>
          </div>

          <section className="enroll-panel" aria-labelledby="enroll-title">
            {done ? (
              <div className="enroll-success" role="status">
                <div className="enroll-success-icon" aria-hidden="true">✓</div>
                <span className="enroll-panel-kicker">C’EST ENVOYÉ</span>
                <h2 id="enroll-title">Bienvenue dans l’aventure !</h2>
                <p>Votre dossier a bien été transmis au comité. Vous serez informé(e) après l’examen de votre inscription.</p>
                <div className="enroll-next">
                  <span className="enroll-next-icon" aria-hidden="true">✦</span>
                  <span><strong>Prochaine étape</strong><small>Gardez votre téléphone à portée de main et venez à la cérémonie.</small></span>
                </div>
                <button className="enroll-submit" type="button" onClick={() => window.location.reload()}>Retour à l’accueil <span aria-hidden="true">↗</span></button>
              </div>
            ) : !camp ? (
              <div className="enroll-loading">
                {msg ? <><span className="enroll-panel-kicker">INDISPONIBLE</span><h2 id="enroll-title">Le parrainage ne répond pas</h2><p>{msg}</p><button className="enroll-retry" type="button" onClick={() => window.location.reload()}>Réessayer</button></> : <><span className="enroll-spinner" /><p>Préparation du formulaire…</p></>}
              </div>
            ) : !ouvert ? (
              <div className="enroll-closed">
                <span className="enroll-panel-kicker">PARRAINAGE {camp.annee}</span>
                <h2 id="enroll-title">Les inscriptions sont fermées.</h2>
                <p>La période de dépôt des dossiers est terminée. Rapprochez-vous du comité pour connaître la suite.</p>
                <a className="enroll-retry" href="/admin">Accéder à l’espace comité <span aria-hidden="true">↗</span></a>
              </div>
            ) : (
              <>
                <div className="enroll-panel-heading">
                  <span className="enroll-panel-kicker">VOTRE PARCOURS COMMENCE ICI</span>
                  <h2 id="enroll-title">Rejoignez le parrainage</h2>
                  <p>Vous êtes étudiant(e) à l’UAC ? Inscrivez-vous en quelques étapes.</p>
                </div>
                <form id="enroll-form" className="enroll-form" onSubmit={envoyer}>
                  <fieldset className="enroll-role-picker">
                    <legend>Je souhaite m’inscrire comme</legend>
                    <div className="enroll-role-options">
                      {[
                        ['parrain', 'Parrain / Marraine', 'Partager mon expérience'],
                        ['filleul', 'Filleul(e)', 'Être accompagné(e)']
                      ].map(([key, title, note]) => (
                        <button
                          className={`enroll-role-option ${role === key ? 'is-selected' : ''}`}
                          type="button"
                          key={key}
                          aria-pressed={role === key}
                          onClick={() => choisirRole(key)}
                        >
                          <span className="enroll-role-icon"><PersonIcon role={key} /></span>
                          <span className="enroll-role-copy"><strong>{title}</strong><small>{note}</small></span>
                          <span className="enroll-role-check" aria-hidden="true">{role === key ? '✓' : ''}</span>
                        </button>
                      ))}
                    </div>
                  </fieldset>

                  <div className="enroll-form-heading"><span>VOS INFORMATIONS</span><span>INSCRIPTION EN LIGNE</span></div>
                  <div className="enroll-fields">
                    <label className="enroll-field enroll-field-wide">Nom complet
                      <input required minLength={2} maxLength={80} value={f.nom} onChange={set('nom')} autoComplete="name" placeholder="Ex. Grâce Mballa" />
                    </label>
                    <label className="enroll-field">Matricule
                      <input required minLength={3} maxLength={20} value={f.matricule} onChange={set('matricule')} autoComplete="off" placeholder="Ex. 24UAC0123" />
                    </label>
                    <label className="enroll-field">Téléphone
                      <input required type="tel" inputMode="tel" pattern="\+?[0-9 ]{8,16}" value={f.telephone} onChange={set('telephone')} autoComplete="tel" placeholder="+237 6 00 00 00 00" />
                    </label>
                    <label className="enroll-field enroll-field-wide">Filière
                      <select value={f.filiere} onChange={set('filiere')}>
                        {FILIERES.map(option => <option key={option} value={option}>{option}</option>)}
                      </select>
                    </label>
                    <label className="enroll-field enroll-field-wide">Niveau d’étude
                      <select value={niveaux.includes(f.niveau) ? f.niveau : niveaux[0]} onChange={set('niveau')}>
                        {niveaux.map(n => <option key={n}>{n}</option>)}
                      </select>
                    </label>
                    <label className="enroll-field enroll-field-wide enroll-photo-field">
                      <span>Votre photo de profil <small>JPG ou PNG · 300 Ko après compression</small></span>
                      <input type="file" accept="image/jpeg,image/png" onChange={choisir} aria-label="Choisir une photo de profil" />
                      {prev ? <img className="enroll-photo-preview" src={prev} alt="Aperçu de votre photo de profil" /> : <span className="enroll-photo-hint"><span aria-hidden="true">＋</span> Ajouter une photo</span>}
                    </label>
                  </div>
                  {strict && <p className="enroll-rule"><span aria-hidden="true">✦</span>{role === 'parrain' ? 'Les parrains et marraines doivent être au moins en L2 et d’un niveau supérieur à leur filleul.' : 'Votre parrain ou marraine sera choisi(e) parmi les étudiants d’un niveau supérieur.'}</p>}
                  {msg && <p className="enroll-error" role="alert">{msg}</p>}
                  <button className="enroll-submit" type="submit" disabled={busy || !blob}>
                    {busy ? 'Envoi en cours…' : 'Envoyer mon dossier'} <span aria-hidden="true">→</span>
                  </button>
                  <p className="enroll-privacy"><span aria-hidden="true">♧</span> Vos informations restent confidentielles et sont réservées au comité du parrainage.</p>
                </form>
              </>
            )}
          </section>
        </section>

        <footer className="enroll-footer">
          <span>© {new Date().getFullYear()} Université Adventiste Cosendai</span>
          <span>Grandir ensemble · Avancer ensemble</span>
          <Link to="/projection">Voir la cérémonie <span aria-hidden="true">↗</span></Link>
        </footer>
      </div>
    </main>
  );
}
