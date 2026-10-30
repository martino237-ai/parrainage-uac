const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:4001';

if (process.env.DB_NAME !== 'parrainage_uac_test') {
  throw new Error('Tests refusés : DB_NAME doit être parrainage_uac_test.');
}

async function request(endpoint, options) {
  return fetch(`${BASE_URL}${endpoint}`, options);
}

async function expectStatus(response, expected, message) {
  if (response.status !== expected) {
    const body = await response.text();
    assert.fail(`${message}; reçu HTTP ${response.status}: ${body}`);
  }
}

async function main() {
  const anonymous = await request('/api/admin/audit');
  await expectStatus(anonymous, 401, 'Le journal doit être protégé');

  const login = await request('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD })
  });
  await expectStatus(login, 200, 'Le compte administrateur de test doit pouvoir se connecter');
  const { token } = await login.json();
  assert.ok(token, 'La connexion doit renvoyer un jeton');
  const headers = { Authorization: `Bearer ${token}` };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  const photoBytes = fs.readFileSync(path.join(__dirname, 'logo.jpg'));
  async function register({ matricule, role = 'filleul', niveau = 'L1', validPhoto = true, oversizedPhoto = false }) {
    const form = new FormData();
    form.set('role', role);
    form.set('nom', `Participant ${matricule}`);
    form.set('matricule', matricule);
    form.set('filiere', 'Informatique');
    form.set('niveau', niveau);
    form.set('telephone', '+237 60000000');
    const bytes = oversizedPhoto
      ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(300 * 1024)])
      : validPhoto ? photoBytes : Buffer.from('not-an-image');
    form.set('photo', new Blob([bytes],
      { type: validPhoto ? 'image/jpeg' : 'text/plain' }), validPhoto ? 'portrait.jpg' : 'portrait.txt');
    return request('/api/inscription', { method: 'POST', body: form });
  }

  const registration = await register({ matricule: 'TEST-0001' });
  await expectStatus(registration, 201, 'Une inscription avec photo valide doit réussir');

  const invalidPhoto = await register({ matricule: 'TEST-IMAGE', validPhoto: false });
  await expectStatus(invalidPhoto, 400, 'Un fichier qui n’est pas une vraie image doit être refusé');
  const oversizedPhoto = await register({ matricule: 'TEST-LARGE', oversizedPhoto: true });
  await expectStatus(oversizedPhoto, 400, 'Une photo dépassant 300 Ko doit être refusée par le serveur');

  for (const participant of [
    { matricule: 'TEST-0002', role: 'filleul', niveau: 'L1' },
    { matricule: 'TEST-0003', role: 'parrain', niveau: 'L2' },
    { matricule: 'TEST-0004', role: 'parrain', niveau: 'L2' },
    { matricule: 'TEST-0005', role: 'parrain', niveau: 'L2' },
    { matricule: 'TEST-0006', role: 'filleul', niveau: 'L1' }
  ]) {
    await expectStatus(await register(participant), 201, `L’inscription ${participant.matricule} doit réussir`);
  }
  await expectStatus(await register({ matricule: 'TEST-0001', role: 'parrain', niveau: 'L2' }), 409,
    'Un matricule ne doit pas être inscrit deux fois, même avec un autre rôle');

  const participantsResponse = await request('/api/admin/participants', { headers });
  await expectStatus(participantsResponse, 200, 'La liste des participants doit être réservée au comité');
  const participants = await participantsResponse.json();
  const participantByMatricule = new Map(participants.map(row => [row.matricule, row]));
  for (const matricule of ['TEST-0001', 'TEST-0002', 'TEST-0003', 'TEST-0004', 'TEST-0005', 'TEST-0006']) {
    assert.ok(participantByMatricule.has(matricule), `Le dossier ${matricule} doit être présent`);
  }

  const missingReason = await request(`/api/admin/participants/${participantByMatricule.get('TEST-0001').id}/dossier`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ dossier: 'rejete' })
  });
  await expectStatus(missingReason, 400, 'Un rejet sans motif doit être refusé');

  const rejection = await request(`/api/admin/participants/${participantByMatricule.get('TEST-0001').id}/dossier`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify({ dossier: 'rejete', motif: 'Dossier de test incomplet' })
  });
  await expectStatus(rejection, 200, 'Un rejet motivé doit réussir');

  const transition = async phase => {
    const response = await request('/api/admin/campagne', {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ phase })
    });
    await expectStatus(response, 200, `La transition vers ${phase} doit réussir`);
  };
  const updateDossier = async (id, dossier) => {
    const response = await request(`/api/admin/participants/${id}/dossier`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ dossier })
    });
    await expectStatus(response, 200, `Le dossier doit pouvoir passer à ${dossier}`);
  };

  await transition('closes');
  const backwardsTransition = await request('/api/admin/campagne', {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({ phase: 'inscriptions' })
  });
  await expectStatus(backwardsTransition, 409, 'Une phase clôturée ne doit pas pouvoir être rouverte');
  for (const matricule of ['TEST-0002', 'TEST-0003', 'TEST-0004', 'TEST-0005', 'TEST-0006']) {
    await updateDossier(participantByMatricule.get(matricule).id, 'valide');
  }

  const lateRegistration = await register({ matricule: 'TEST-LATE' });
  await expectStatus(lateRegistration, 403, 'Les nouvelles inscriptions doivent être bloquées après clôture');
  await transition('pointage');

  for (const matricule of ['TEST-0002', 'TEST-0003', 'TEST-0004', 'TEST-0005', 'TEST-0006']) {
    const id = participantByMatricule.get(matricule).id;
    const response = await request(`/api/admin/participants/${id}/present`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ present: true })
    });
    await expectStatus(response, 200, `${matricule} doit pouvoir être pointé présent`);
  }

  await transition('ceremonie');
  await expectStatus(await request('/api/admin/tirage', { method: 'POST', headers }), 200,
    'Le serveur doit proposer un couple avec les candidats admissibles');
  const initialState = await (await request('/api/projection')).json();
  assert.ok(initialState.propose, 'La proposition doit être publiée');
  const retainedFilleul = initialState.propose.filleul.id;
  const replacedParrain = initialState.propose.parrain.id;

  const absence = await request('/api/admin/tirage/absent', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ qui: 'parrain', motif: 'Absence vérifiée pendant le test' })
  });
  await expectStatus(absence, 200, 'Le remplacement du seul parrain absent doit réussir');
  const replacementState = await absence.json();
  assert.ok(replacementState.propose, 'Le remplacement doit rester en attente de validation');
  assert.equal(replacementState.propose.filleul.id, retainedFilleul, 'Le filleul présent doit être conservé');
  assert.notEqual(replacementState.propose.parrain.id, replacedParrain, 'Seul le parrain absent doit être remplacé');

  const validation = await request('/api/admin/tirage/valider', { method: 'POST', headers });
  await expectStatus(validation, 200, 'Un couple encore admissible doit pouvoir être validé');
  const validatedState = await validation.json();
  assert.equal(validatedState.total, 1, 'Le couple validé doit être compté');

  await expectStatus(await request('/api/admin/tirage', { method: 'POST', headers }), 200,
    'Un deuxième couple doit pouvoir être proposé avec les personnes encore disponibles');
  const secondProposal = await (await request('/api/projection')).json();
  assert.ok(secondProposal.propose);
  const suspendedFilleul = secondProposal.propose.filleul.id;
  const secondAbsence = await request('/api/admin/tirage/absent', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ qui: 'parrain', motif: 'Aucun autre parrain disponible dans le test' })
  });
  await expectStatus(secondAbsence, 200, 'La proposition doit être conservée si aucun remplaçant n’existe');
  const suspendedState = await secondAbsence.json();
  assert.equal(suspendedState.propose, null, 'Une proposition sans remplaçant ne doit pas rester validable');
  assert.equal(suspendedState.suspendu.filleul.id, suspendedFilleul, 'Le filleul présent doit rester dans la proposition suspendue');
  await expectStatus(await request(`/api/photo/${suspendedFilleul}`), 404,
    'Les photos d’une proposition suspendue ne doivent pas être publiques');

  const resume = await request('/api/admin/tirage/reprendre', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ motif: 'Nouvelle tentative contrôlée' })
  });
  await expectStatus(resume, 200, 'Une reprise sans remplaçant doit conserver un état cohérent');
  const resumeState = await resume.json();
  assert.equal(resumeState.suspendu.filleul.id, suspendedFilleul, 'Une reprise infructueuse doit conserver la personne présente');
  assert.match(resumeState.info, /Aucun remplaçant/);

  const auditResponse = await request('/api/admin/audit', { headers });
  await expectStatus(auditResponse, 200, 'Le journal doit être accessible au comité');
  const entries = await auditResponse.json();
  assert.ok(entries.some(row => row.action === 'participant.inscription'), 'L’inscription doit être journalisée');
  assert.ok(entries.some(row => row.action === 'participant.dossier.rejete' && row.reason === 'Dossier de test incomplet'),
    'Le rejet et son motif doivent être journalisés');
  assert.ok(entries.some(row => row.action === 'couple.remplacement' && row.reason === 'Absence vérifiée pendant le test'),
    'Le remplacement et son motif doivent être journalisés');
  assert.ok(entries.some(row => row.action === 'couple.validation'), 'La validation doit être journalisée');
  assert.ok(entries.some(row => row.action === 'couple.remplacement.indisponible'),
    'Une absence sans remplaçant doit être journalisée');

  console.log('Tests d’intégration réussis : accès admin, inscription, contrôle photo, doublon, rejet motivé, phases, pointage, tirage admissible, remplacement individuel, suspension, reprise, validation et audit.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
