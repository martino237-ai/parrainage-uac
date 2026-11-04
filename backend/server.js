require('dotenv').config();
const path = require('path'), fs = require('fs'), http = require('http'), crypto = require('crypto');
const express = require('express'), cors = require('cors'), helmet = require('helmet');
const rateLimit = require('express-rate-limit'), jwt = require('jsonwebtoken'), bcrypt = require('bcryptjs');
const multer = require('multer'), { z } = require('zod'), { Server } = require('socket.io');
const pool = require('./db');
const { ensureSchema } = require('./migrate');

const PORT = process.env.PORT || 4000;
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16) { console.error('JWT_SECRET manquant ou trop court (16 caractères min.)'); process.exit(1); }
const FRONT = [...new Set([...(process.env.FRONT_URL || 'http://localhost:5173').split(',').map(s => s.trim()).filter(Boolean), ...(process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)])];
const PHASES = ['inscriptions', 'closes', 'pointage', 'ceremonie', 'termine'];
const NIVEAUX = ['L1', 'L2', 'L3', 'M1', 'M2'];
const rank = n => NIVEAUX.indexOf(n);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const isAllowedOrigin = origin => {
  if (!origin) return true;
  if (FRONT.includes(origin)) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  if (/^https?:\/\/([a-z0-9-]+\.)*(netlify\.app|vercel\.app)(:\d+)?$/i.test(origin)) return true;
  return false;
};
const corsOptions = {
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};
const io = new Server(server, { cors: { origin: (origin, callback) => callback(null, isAllowedOrigin(origin)) } });
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, contentSecurityPolicy: false }));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '50kb' }));

const limitLogin = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de tentatives, réessayez dans 15 minutes' } });
const limitInsc = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Trop de demandes, réessayez plus tard' } });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try { req.admin = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', SECRET); next(); }
  catch { res.status(401).json({ error: 'Non autorisé' }); }
}

// ---------- Accès aux données ----------
const getCampagne = async (c = pool) => (await c.query('SELECT * FROM campagne WHERE id = 1'))[0][0];
const log = (c, action, pid, fid) => c.query('INSERT INTO tirages_log (action, parrain_id, filleul_id) VALUES (?, ?, ?)', [action, pid || null, fid || null]);
const audit = (c, actorId, action, entityType, entityId, reason = null, details = {}) =>
  c.query('INSERT INTO audit_log (actor_id, action, entity_type, entity_id, reason, details) VALUES (?, ?, ?, ?, ?, ?)',
    [actorId || null, action, entityType, entityId || null, reason, JSON.stringify(details)]);

// Toutes les opérations de tirage passent par une transaction qui verrouille la campagne : jamais deux tirages simultanés.
async function tx(fn) {
  const c = await pool.getConnection();
  try {
    await c.beginTransaction();
    await c.query('SELECT id FROM campagne WHERE id = 1 FOR UPDATE');
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) { await c.rollback(); throw e; }
  finally { c.release(); }
}

async function getCouples(c, statut) {
  const [rows] = await c.query(`SELECT k.id, k.statut, k.validated_at,
      pa.id pid, pa.nom pnom, pa.filiere pfil, pa.niveau pniv,
      fi.id fid, fi.nom fnom, fi.filiere ffil, fi.niveau fniv
    FROM couples k JOIN participants pa ON pa.id = k.parrain_id JOIN participants fi ON fi.id = k.filleul_id
    WHERE k.statut = ? ORDER BY k.id DESC`, [statut]);
  return rows.map(r => ({
    id: r.id, statut: r.statut, validated_at: r.validated_at,
    parrain: { id: r.pid, nom: r.pnom, filiere: r.pfil, niveau: r.pniv, role: 'parrain' },
    filleul: { id: r.fid, nom: r.fnom, filiere: r.ffil, niveau: r.fniv, role: 'filleul' }
  }));
}

async function etat(c = pool) {
  const camp = await getCampagne(c);
  const propose = (await getCouples(c, 'propose'))[0] || null;
  const suspendu = (await getCouples(c, 'suspendu'))[0] || null;
  const valides = await getCouples(c, 'valide');
  return { phase: camp.phase, annee: camp.annee, propose, suspendu, dernier: valides[0] || null, total: valides.length };
}
const diffuser = async () => io.emit('etat', await etat());
io.on('connection', async s => { try { s.emit('etat', await etat()); } catch { /* ignoré */ } });

// ---------- Règles de tirage ----------
async function eligibles(c, camp, ignoreCoupleId = null) {
  const [pars] = await c.query(`SELECT p.id, p.nom, p.filiere, p.niveau,
      (SELECT COUNT(*) FROM couples k WHERE k.parrain_id = p.id AND k.statut = 'valide') nb
    FROM participants p WHERE p.role = 'parrain' AND p.dossier = 'valide' AND p.present = TRUE
      AND (SELECT COUNT(*) FROM couples k WHERE k.parrain_id = p.id AND k.statut = 'valide') < ?`, [camp.capacite_parrain]);
  const [fils] = await c.query(`SELECT p.id, p.nom, p.filiere, p.niveau FROM participants p
    WHERE p.role = 'filleul' AND p.dossier = 'valide' AND p.present = TRUE
      AND NOT EXISTS (SELECT 1 FROM couples k WHERE k.filleul_id = p.id
        AND k.statut IN ('propose', 'valide') AND (? IS NULL OR k.id <> ?))`, [ignoreCoupleId, ignoreCoupleId]);
  return { pars, fils };
}
const norm = s => s.trim().toLowerCase();
const compat = (p, f, camp) =>
  (!camp.niveau_superieur || rank(p.niveau) > rank(f.niveau)) &&
  (!camp.meme_filiere || norm(p.filiere) === norm(f.filiere));
const pick = a => a[crypto.randomInt(a.length)];
// Équité : tant que des parrains n'ont aucun filleul (ou moins que les autres), ils passent en premier.
const moinsServis = a => { const m = Math.min(...a.map(p => p.nb)); return a.filter(p => p.nb === m); };

function tirer(pars, fils, camp) {
  const pp = pars.filter(p => fils.some(f => compat(p, f, camp)));
  if (!pp.length) return null;
  const p = pick(moinsServis(pp));
  return { p, f: pick(fils.filter(f => compat(p, f, camp))) };
}
const enAttente = async c => (await c.query("SELECT * FROM couples WHERE statut = 'propose'"))[0][0];
const propositionSuspendue = async c => (await c.query("SELECT * FROM couples WHERE statut = 'suspendu' ORDER BY id DESC LIMIT 1"))[0][0];
const exigerCeremonie = camp => { if (camp.phase !== 'ceremonie') throw new HttpError(409, "La cérémonie n'est pas ouverte"); };

async function verifierEligibiliteCouple(c, camp, couple) {
  const [rows] = await c.query(`SELECT id, role, dossier, present, filiere, niveau FROM participants
    WHERE id IN (?, ?) FOR UPDATE`, [couple.parrain_id, couple.filleul_id]);
  const parrain = rows.find(row => row.id === couple.parrain_id);
  const filleul = rows.find(row => row.id === couple.filleul_id);
  if (!parrain || !filleul || parrain.role !== 'parrain' || filleul.role !== 'filleul')
    throw new HttpError(409, 'Les participants de la proposition sont introuvables ou ont un rôle invalide');
  if (parrain.dossier !== 'valide' || filleul.dossier !== 'valide')
    throw new HttpError(409, 'Les deux dossiers doivent être validés avant de confirmer ce couple');
  if (!parrain.present || !filleul.present)
    throw new HttpError(409, 'Les deux participants doivent être pointés présents avant de confirmer ce couple');
  if (!compat(parrain, filleul, camp))
    throw new HttpError(409, 'La proposition ne respecte plus les règles de niveau ou de filière');
  const [[{ n }]] = await c.query("SELECT COUNT(*) n FROM couples WHERE parrain_id = ? AND statut = 'valide'", [parrain.id]);
  if (n >= camp.capacite_parrain)
    throw new HttpError(409, 'La capacité de ce parrain est déjà atteinte');
}

// ---------- Routes publiques ----------
app.get('/api/health', (q, r) => r.json({ ok: true }));
app.get('/api/campagne', wrap(async (q, res) => {
  const { phase, annee, capacite_parrain, meme_filiere, niveau_superieur } = await getCampagne();
  res.json({ phase, annee, capacite_parrain, meme_filiere, niveau_superieur });
}));
app.get('/api/projection', wrap(async (q, res) => res.json(await etat())));

const MAX_PHOTO_BYTES = 300 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PHOTO_BYTES, files: 1 } });
const inscSchema = z.object({
  role: z.enum(['parrain', 'filleul']),
  nom: z.string().trim().min(2).max(80),
  matricule: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9\-\/.]{2,19}$/),
  filiere: z.string().trim().min(2).max(80),
  niveau: z.enum(NIVEAUX),
  telephone: z.string().trim().regex(/^\+?[0-9 ]{8,16}$/)
});
const mimeOf = b => {
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47]))) return 'image/png';
  return null;
};

app.post('/api/inscription', limitInsc,
  (req, res, next) => upload.single('photo')(req, res, e => e
    ? next(new HttpError(400, e.code === 'LIMIT_FILE_SIZE' ? 'Photo trop lourde (300 Ko maximum après compression)' : 'Photo invalide'))
    : next()),
  wrap(async (req, res) => {
    const p = inscSchema.safeParse(req.body);
    if (!p.success) throw new HttpError(400, 'Champ invalide : ' + p.error.issues[0].path.join('.'));
    const d = p.data;
    if (!req.file) throw new HttpError(400, 'Photo obligatoire');
    const mime = mimeOf(req.file.buffer);
    if (!mime) throw new HttpError(400, 'La photo doit être au format JPEG ou PNG');
    try {
      await tx(async c => {
        const camp = await getCampagne(c);
        if (camp.phase !== 'inscriptions') throw new HttpError(403, 'Les inscriptions sont fermées');
        if (camp.niveau_superieur && d.role === 'parrain' && d.niveau === 'L1') throw new HttpError(400, 'Un parrain doit être au moins en L2');
        if (camp.niveau_superieur && d.role === 'filleul' && d.niveau === 'M2') throw new HttpError(400, 'Un filleul ne peut pas être en M2');
        const [result] = await c.query(`INSERT INTO participants (role, nom, matricule, filiere, niveau, telephone, photo, photo_mime)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [d.role, d.nom, d.matricule.toUpperCase(), d.filiere, d.niveau, d.telephone, req.file.buffer, mime]);
        await audit(c, null, 'participant.inscription', 'participant', result.insertId, null, { role: d.role });
      });
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw new HttpError(409, 'Ce matricule est déjà inscrit');
      throw e;
    }
    res.status(201).json({ ok: true });
  }));

// Photo : publique seulement pour les personnes en couple (affichage projecteur) ; admin : toutes.
app.get('/api/photo/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new HttpError(400, 'Identifiant invalide');
  let admin = false;
  try { jwt.verify(String(req.query.t || ''), SECRET); admin = true; } catch { /* public */ }
  const [r] = await pool.query(`SELECT photo, photo_mime FROM participants WHERE id = ? ${admin ? '' :
    "AND id IN (SELECT parrain_id FROM couples WHERE statut IN ('propose','valide') UNION SELECT filleul_id FROM couples WHERE statut IN ('propose','valide'))"}`, [id]);
  if (!r[0]) return res.status(404).end();
  res.set({ 'Content-Type': r[0].photo_mime, 'Cache-Control': 'private, max-age=3600' }).send(r[0].photo);
}));

// ---------- Admin ----------
app.post('/api/admin/login', limitLogin, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(400, 'Identifiants requis');
  const [r] = await pool.query('SELECT * FROM admins WHERE username = ?', [username]);
  if (!r[0] || !(await bcrypt.compare(password, r[0].password_hash))) throw new HttpError(401, 'Identifiants incorrects');
  res.json({ token: jwt.sign({ id: r[0].id }, SECRET, { expiresIn: '12h' }) });
}));

app.get('/api/admin/stats', auth, wrap(async (q, res) => {
  const [r] = await pool.query(`SELECT role, COUNT(*) total,
    SUM(CASE WHEN dossier = 'valide' THEN 1 ELSE 0 END) valides,
    SUM(CASE WHEN dossier = 'en_attente' THEN 1 ELSE 0 END) attente,
    SUM(CASE WHEN dossier = 'valide' AND present = TRUE THEN 1 ELSE 0 END) presents
    FROM participants GROUP BY role`);
  const out = { parrain: { total: 0, valides: 0, attente: 0, presents: 0 }, filleul: { total: 0, valides: 0, attente: 0, presents: 0 } };
  r.forEach(x => { out[x.role] = { total: +x.total, valides: +x.valides, attente: +x.attente, presents: +x.presents }; });
  out.couples = (await pool.query('SELECT COUNT(*) n FROM couples'))[0][0].n;
  res.json(out);
}));

app.get('/api/admin/audit', auth, wrap(async (q, res) => {
  const [rows] = await pool.query(`SELECT a.id, a.action, a.entity_type, a.entity_id, a.reason, a.details, a.created_at,
      COALESCE(ad.username, 'Système') actor
    FROM audit_log a LEFT JOIN admins ad ON ad.id = a.actor_id
    ORDER BY a.id DESC LIMIT 200`);
  res.json(rows.map(row => ({
    ...row,
    details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details || {}
  })));
}));

const campSchema = z.object({
  phase: z.enum(PHASES).optional(),
  capacite_parrain: z.number().int().min(1).max(5).optional(),
  meme_filiere: z.boolean().optional(),
  niveau_superieur: z.boolean().optional()
});
app.put('/api/admin/campagne', auth, wrap(async (req, res) => {
  const p = campSchema.safeParse(req.body);
  if (!p.success) throw new HttpError(400, 'Paramètres invalides');
  const d = p.data;
  await tx(async c => {
    const camp = await getCampagne(c);
    const regles = ['capacite_parrain', 'meme_filiere', 'niveau_superieur'];
    if (regles.some(k => d[k] !== undefined && Number(d[k]) !== Number(camp[k])) && ['ceremonie', 'termine'].includes(camp.phase))
      throw new HttpError(409, 'Les règles ne changent plus à partir de la cérémonie');
    if (d.phase && d.phase !== camp.phase) {
      const from = PHASES.indexOf(camp.phase);
      const to = PHASES.indexOf(d.phase);
      if (to > from && camp.phase === 'ceremonie' && (await enAttente(c) || await propositionSuspendue(c)))
        throw new HttpError(409, 'Terminez ou reprenez la proposition en cours avant de changer de phase');
      if (d.phase === 'ceremonie') {
        const [rows] = await c.query("SELECT role, COUNT(*) n FROM participants WHERE dossier = 'valide' AND present = TRUE GROUP BY role");
        const m = Object.fromEntries(rows.map(r => [r.role, r.n]));
        if (!m.parrain || !m.filleul) throw new HttpError(409, 'Il faut au moins un parrain et un filleul présents');
      }
    }
    const sets = [], vals = [];
    for (const k of ['phase', ...regles]) if (d[k] !== undefined) { sets.push(`${k} = ?`); vals.push(d[k]); }
    if (sets.length) {
      await c.query(`UPDATE campagne SET ${sets.join(', ')} WHERE id = 1`, vals);
      await audit(c, req.admin.id, d.phase && d.phase !== camp.phase ? 'campagne.phase' : 'campagne.regles',
        'campagne', 1, null, { avant: camp.phase, apres: d.phase || camp.phase, parametres: d });
    }
  });
  await diffuser();
  res.json(await getCampagne());
}));

app.get('/api/admin/participants', auth, wrap(async (req, res) => {
  const { role, dossier, q } = req.query, w = [], v = [];
  if (['parrain', 'filleul'].includes(role)) { w.push('p.role = ?'); v.push(role); }
  if (['en_attente', 'valide', 'rejete'].includes(dossier)) { w.push('p.dossier = ?'); v.push(dossier); }
  if (q) { w.push('(p.nom LIKE ? OR p.matricule LIKE ?)'); v.push(`%${q}%`, `%${q}%`); }
  const [r] = await pool.query(`SELECT p.id, p.role, p.nom, p.matricule, p.filiere, p.niveau, p.telephone, p.dossier, p.motif_rejet, p.present
    FROM participants p ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY p.created_at DESC LIMIT 1000`, v);
  res.json(r);
}));

const dejaCouple = async (c, id) => (await c.query('SELECT COUNT(*) n FROM couples WHERE parrain_id = ? OR filleul_id = ?', [id, id]))[0][0].n > 0;
const idParam = req => { const id = Number(req.params.id); if (!Number.isInteger(id)) throw new HttpError(400, 'Identifiant invalide'); return id; };

app.patch('/api/admin/participants/:id/dossier', auth, wrap(async (req, res) => {
  const id = idParam(req), p = z.object({
    dossier: z.enum(['en_attente', 'valide', 'rejete']),
    motif: z.string().trim().max(500).optional()
  }).superRefine((value, ctx) => {
    if (value.dossier === 'rejete' && !value.motif) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['motif'], message: 'Motif de rejet obligatoire' });
    }
  }).safeParse(req.body);
  if (!p.success) throw new HttpError(400, 'Requête invalide');
  await tx(async c => {
    if (['pointage', 'ceremonie', 'termine'].includes((await getCampagne(c)).phase)) throw new HttpError(409, 'La validation des dossiers est terminée');
    if (await dejaCouple(c, id)) throw new HttpError(409, 'Cette personne est déjà dans un couple');
    const [r] = await c.query(`UPDATE participants SET dossier = ?, motif_rejet = ?, present = CASE WHEN ? = 'valide' THEN present ELSE 0 END
      WHERE id = ?`, [p.data.dossier, p.data.dossier === 'rejete' ? p.data.motif : null, p.data.dossier, id]);
    if (!r.affectedRows) throw new HttpError(404, 'Introuvable');
    await audit(c, req.admin.id, 'participant.dossier.' + p.data.dossier, 'participant', id,
      p.data.dossier === 'rejete' ? p.data.motif : null, { dossier: p.data.dossier });
  });
  res.json({ ok: true });
}));

app.patch('/api/admin/participants/:id/present', auth, wrap(async (req, res) => {
  const id = idParam(req), p = z.object({ present: z.boolean() }).safeParse(req.body);
  if (!p.success) throw new HttpError(400, 'Requête invalide');
  await tx(async c => {
    if (!['pointage', 'ceremonie'].includes((await getCampagne(c)).phase)) throw new HttpError(409, "Le pointage n'est pas ouvert");
    const [[row]] = await c.query('SELECT dossier, present FROM participants WHERE id = ?', [id]);
    if (!row) throw new HttpError(404, 'Introuvable');
    if (row.dossier !== 'valide') throw new HttpError(409, "Dossier non validé");
    if (!p.data.present && await dejaCouple(c, id)) throw new HttpError(409, 'Déjà dans un couple : utilisez « absent » dans le tirage ou annulez le couple');
    if (Boolean(row.present) !== p.data.present) {
      await c.query('UPDATE participants SET present = ? WHERE id = ?', [+p.data.present, id]);
      await audit(c, req.admin.id, p.data.present ? 'participant.presence.present' : 'participant.presence.absent',
        'participant', id, null, { avant: Boolean(row.present), apres: p.data.present });
    }
  });
  res.json({ ok: true });
}));

app.delete('/api/admin/participants/:id', auth, wrap(async (req, res) => {
  const id = idParam(req);
  const parsed = z.object({ motif: z.string().trim().min(3).max(500) }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Un motif de suppression (3 caractères minimum) est obligatoire');
  await tx(async c => {
    if (['ceremonie', 'termine'].includes((await getCampagne(c)).phase)) throw new HttpError(409, 'Suppression impossible pendant la cérémonie');
    if (await dejaCouple(c, id)) throw new HttpError(409, 'Cette personne est déjà dans un couple');
    const [[participant]] = await c.query('SELECT role, nom, matricule FROM participants WHERE id = ?', [id]);
    if (!participant) throw new HttpError(404, 'Introuvable');
    await audit(c, req.admin.id, 'participant.suppression', 'participant', id, parsed.data.motif,
      { role: participant.role, nom: participant.nom, matricule: participant.matricule });
    await c.query('DELETE FROM participants WHERE id = ?', [id]);
  });
  res.json({ ok: true });
}));

// ---------- Tirage ----------
app.post('/api/admin/tirage', auth, wrap(async (req, res) => {
  await tx(async c => {
    const camp = await getCampagne(c); exigerCeremonie(camp);
    if (await enAttente(c)) throw new HttpError(409, 'Un couple est déjà en attente de validation');
    if (await propositionSuspendue(c)) throw new HttpError(409, 'Reprenez la proposition suspendue avant de lancer un autre tirage');
    const { pars, fils } = await eligibles(c, camp);
    if (!pars.length) throw new HttpError(409, 'Plus aucun parrain disponible');
    if (!fils.length) throw new HttpError(409, 'Plus aucun filleul disponible');
    const t = tirer(pars, fils, camp);
    if (!t) throw new HttpError(409, 'Aucun couple possible avec les règles actuelles');
    const [result] = await c.query("INSERT INTO couples (parrain_id, filleul_id, statut) VALUES (?, ?, 'propose')", [t.p.id, t.f.id]);
    await log(c, 'tirage', t.p.id, t.f.id);
    await audit(c, req.admin.id, 'couple.proposition', 'couple', result.insertId, null,
      { parrain_id: t.p.id, filleul_id: t.f.id });
  });
  await diffuser();
  res.json(await etat());
}));

app.post('/api/admin/tirage/valider', auth, wrap(async (req, res) => {
  await tx(async c => {
    exigerCeremonie(await getCampagne(c));
    const k = await enAttente(c);
    if (!k) throw new HttpError(409, 'Aucun couple à valider');
    await verifierEligibiliteCouple(c, await getCampagne(c), k);
    await c.query("UPDATE couples SET statut = 'valide', validated_at = NOW() WHERE id = ?", [k.id]);
    await log(c, 'valider', k.parrain_id, k.filleul_id);
    await audit(c, req.admin.id, 'couple.validation', 'couple', k.id, null,
      { parrain_id: k.parrain_id, filleul_id: k.filleul_id });
  });
  await diffuser();
  res.json(await etat());
}));

// Seul l'absent est remplacé : l'autre personne reste à l'écran.
app.post('/api/admin/tirage/absent', auth, wrap(async (req, res) => {
  const qui = req.body && req.body.qui;
  if (!['parrain', 'filleul'].includes(qui)) throw new HttpError(400, 'qui doit valoir parrain ou filleul');
  const parsed = z.object({ motif: z.string().trim().min(3).max(500) }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Un motif de remplacement (3 caractères minimum) est obligatoire');
  const motif = parsed.data.motif;
  let info = '';
  await tx(async c => {
    const camp = await getCampagne(c); exigerCeremonie(camp);
    const k = await enAttente(c);
    if (!k) throw new HttpError(409, 'Aucun couple en cours');
    await c.query('UPDATE participants SET present = FALSE WHERE id = ?', [qui === 'parrain' ? k.parrain_id : k.filleul_id]);
    await log(c, 'absent_' + qui, k.parrain_id, k.filleul_id);
    await audit(c, req.admin.id, 'couple.absence.' + qui, 'couple', k.id, motif,
      { parrain_id: k.parrain_id, filleul_id: k.filleul_id });
    const { pars, fils } = await eligibles(c, camp, k.id);
    let p, f;
    if (qui === 'parrain') {
      f = fils.find(x => x.id === k.filleul_id);
      const cand = f ? pars.filter(x => compat(x, f, camp)) : [];
      if (cand.length) p = pick(moinsServis(cand));
    } else {
      p = pars.find(x => x.id === k.parrain_id);
      const cand = p ? fils.filter(x => compat(p, x, camp)) : [];
      if (cand.length) f = pick(cand);
    }
    if (!p || !f) {
      info = 'La proposition est suspendue : le membre présent est conservé. Réessayez le remplacement lorsque de nouveaux candidats seront disponibles.';
      await c.query("UPDATE couples SET statut = 'suspendu' WHERE id = ?", [k.id]);
      await audit(c, req.admin.id, 'couple.remplacement.indisponible', 'couple', k.id, motif,
        { qui, parrain_conserve: qui === 'filleul' ? k.parrain_id : null, filleul_conserve: qui === 'parrain' ? k.filleul_id : null });
      return;
    }
    await c.query("UPDATE couples SET parrain_id = ?, filleul_id = ?, statut = 'propose' WHERE id = ?", [p.id, f.id, k.id]);
    await log(c, 'remplacement', p.id, f.id);
    await audit(c, req.admin.id, 'couple.remplacement', 'couple', k.id, motif,
      { qui, ancien_parrain_id: qui === 'parrain' ? k.parrain_id : null, ancien_filleul_id: qui === 'filleul' ? k.filleul_id : null, parrain_id: p.id, filleul_id: f.id });
  });
  await diffuser();
  res.json({ ...(await etat()), info });
}));

app.post('/api/admin/tirage/reprendre', auth, wrap(async (req, res) => {
  const parsed = z.object({ motif: z.string().trim().min(3).max(500) }).safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, 'Un motif de reprise (3 caractères minimum) est obligatoire');
  let info = '';
  await tx(async c => {
    const camp = await getCampagne(c); exigerCeremonie(camp);
    if (await enAttente(c)) throw new HttpError(409, 'Terminez d’abord la proposition déjà en attente');
    const k = await propositionSuspendue(c);
    if (!k) throw new HttpError(409, 'Aucune proposition suspendue à reprendre');
    const [[parrain]] = await c.query('SELECT dossier, present FROM participants WHERE id = ? FOR UPDATE', [k.parrain_id]);
    const [[filleul]] = await c.query('SELECT dossier, present FROM participants WHERE id = ? FOR UPDATE', [k.filleul_id]);
    if (!parrain || !filleul) throw new HttpError(409, 'Les participants de la proposition suspendue sont introuvables');
    if (Boolean(parrain.present) === Boolean(filleul.present))
      throw new HttpError(409, 'La reprise automatique nécessite exactement un participant absent');
    const qui = parrain.present ? 'filleul' : 'parrain';
    const { pars, fils } = await eligibles(c, camp, k.id);
    let p, f;
    if (qui === 'parrain') {
      f = fils.find(x => x.id === k.filleul_id);
      const cand = f ? pars.filter(x => compat(x, f, camp)) : [];
      if (cand.length) p = pick(moinsServis(cand));
    } else {
      p = pars.find(x => x.id === k.parrain_id);
      const cand = p ? fils.filter(x => compat(p, x, camp)) : [];
      if (cand.length) f = pick(cand);
    }
    if (!p || !f) {
      info = 'Aucun remplaçant compatible n’est disponible pour le moment.';
      await audit(c, req.admin.id, 'couple.reprise.indisponible', 'couple', k.id, parsed.data.motif, { qui });
      return;
    }
    await c.query("UPDATE couples SET parrain_id = ?, filleul_id = ?, statut = 'propose' WHERE id = ?", [p.id, f.id, k.id]);
    await log(c, 'remplacement', p.id, f.id);
    await audit(c, req.admin.id, 'couple.reprise', 'couple', k.id, parsed.data.motif,
      { qui, ancien_parrain_id: qui === 'parrain' ? k.parrain_id : null, ancien_filleul_id: qui === 'filleul' ? k.filleul_id : null, parrain_id: p.id, filleul_id: f.id });
  });
  await diffuser();
  res.json({ ...(await etat()), info });
}));

app.get('/api/admin/couples', auth, wrap(async (q, res) => res.json(await getCouples(pool, 'valide'))));

app.delete('/api/admin/couples/:id', auth, wrap(async (req, res) => {
  const id = idParam(req);
  const p = z.object({ motif: z.string().trim().min(3).max(500) }).safeParse(req.body);
  if (!p.success) throw new HttpError(400, 'Un motif d’annulation (3 caractères minimum) est obligatoire');
  await tx(async c => {
    exigerCeremonie(await getCampagne(c));
    const [[k]] = await c.query("SELECT * FROM couples WHERE id = ? AND statut = 'valide'", [id]);
    if (!k) throw new HttpError(404, 'Couple introuvable');
    await c.query('DELETE FROM couples WHERE id = ?', [id]);
    await log(c, 'annulation', k.parrain_id, k.filleul_id);
    await audit(c, req.admin.id, 'couple.annulation', 'couple', id, p.data.motif,
      { parrain_id: k.parrain_id, filleul_id: k.filleul_id });
  });
  await diffuser();
  res.json({ ok: true });
}));

app.get('/api/admin/log', auth, wrap(async (q, res) => {
  const [r] = await pool.query(`SELECT l.id, l.action, l.created_at, pa.nom parrain, fi.nom filleul FROM tirages_log l
    LEFT JOIN participants pa ON pa.id = l.parrain_id LEFT JOIN participants fi ON fi.id = l.filleul_id ORDER BY l.id DESC LIMIT 100`);
  res.json(r);
}));

app.get('/api/admin/export/couples.csv', auth, wrap(async (q, res) => {
  const cell = s => { s = String(s ?? ''); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
  const rows = (await getCouples(pool, 'valide')).reverse();
  const lines = [['N°', 'Parrain', 'Filière parrain', 'Niveau parrain', 'Filleul', 'Filière filleul', 'Niveau filleul'].map(cell).join(';')];
  rows.forEach((k, i) => lines.push([i + 1, k.parrain.nom, k.parrain.filiere, k.parrain.niveau, k.filleul.nom, k.filleul.filiere, k.filleul.niveau].map(cell).join(';')));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="couples.csv"' }).send('\uFEFF' + lines.join('\r\n'));
}));

// ---------- Front compilé (mode local, un seul processus) ----------
const dist = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api|socket\.io).*/, (q, r) => r.sendFile(path.join(dist, 'index.html')));
}

app.use((e, req, res, next) => {
  if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
  if (e.status && e.status < 500) return res.status(e.status).json({ error: 'Requête invalide' });
  console.error(e);
  res.status(500).json({ error: 'Erreur serveur' });
});

ensureSchema()
  .then(() => server.listen(PORT, () => console.log('Parrainage UAC : http://localhost:' + PORT)))
  .catch(error => {
    console.error('Échec de préparation de la base de données :', error.message);
    const isNetReach = error && (error.code === 'ENETUNREACH' || /ENETUNREACH|EAI_AGAIN|ECONNREFUSED/i.test(String(error.message)));
    if (isNetReach) {
      console.error('Diagnostique Render/Supabase : la connexion directe est probablement en IPv6.');
      console.error('Utilisez une DB_URL IPv4 compatible (pooler partagé ou activez l\'IPv4 dédiée dans Supabase).');
      console.error('Exemple : postgresql://postgres:YOUR_PASSWORD@aws-0-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&sslmode=require');
    }
    process.exitCode = 1;
  });
