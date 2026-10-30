# Parrainage UAC

Application web : inscription des parrains et filleuls, pointage, tirage de couples avec photos sur grand écran, remplacement de l'absent.

## Lancer en local (Windows, Mac, Linux)
Prérequis : Node.js 18+ et MySQL 8+.

1. **Base de données**
   ```
   mysql -u root -p -e "CREATE DATABASE parrainage_uac CHARACTER SET utf8mb4"
   mysql -u root -p parrainage_uac < database/schema.sql
   ```
2. **Backend**
   ```
   cd backend
   cp .env.example .env      (puis modifier JWT_SECRET, DB_PASSWORD, ADMIN_USER, ADMIN_PASSWORD)
   npm install
   npm run migrate
   npm run seed-admin
   npm start
   ```
3. **Frontend (développement)**
   ```
   cd frontend
   npm install
   npm run dev               -> http://localhost:5173
   ```

## Mode cérémonie (un seul processus, sans internet)
```
cd frontend && npm install && npm run build
cd ../backend && npm start   -> http://localhost:4000
```
- Inscription : `/`   - Comité : `/admin`   - Projecteur : `/projection` (plein écran, touche F11)

## Hébergement gratuit
- **Base** : Aiven for MySQL (plan gratuit). Importer `database/schema.sql`. Variables : `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`.
- **Backend** : Render (Web Service, racine `backend`, build `npm install`, start `npm start`). Variables : celles de `.env.example`, avec `FRONT_URL` = adresse du site Vercel. Le plan gratuit s'endort après 15 min : ouvrez `/api/health` 2 minutes avant la cérémonie, ou ajoutez un ping UptimeRobot.
- **Frontend** : Vercel (racine `frontend`). Variable : `VITE_API_URL` = adresse du backend Render.
- Créer l'admin une fois : `npm run seed-admin` depuis votre PC avec le `.env` pointant vers Aiven.

## Déroulement
1. Phase **Inscriptions** : les étudiants s'inscrivent (photo obligatoire, matricule unique).
2. Phase **Inscriptions closes** : le comité valide ou rejette les dossiers.
3. Phase **Pointage** : le comité coche les présents.
4. Phase **Cérémonie** : ouvrir `/projection` sur le projecteur, piloter depuis `/admin` > Tirage.
5. Phase **Terminé** : exporter la liste (CSV ou Imprimer / PDF).

## Contraintes appliquées (serveur + base de données)
- Une inscription par matricule ; photo JPEG/PNG compressée à 300 Ko maximum côté navigateur et limitée côté serveur.
- Les inscriptions ne marchent que dans la phase « inscriptions » ; les phases avancent d'une étape à la fois.
- Seuls les dossiers validés ET présents sont tirés.
- Un filleul n'a qu'un parrain (contrainte unique SQL) ; un parrain a au plus N filleuls (réglable 1 à 5).
- Les parrains qui ont le moins de filleuls sont tirés en premier.
- Règles optionnelles : parrain d'un niveau supérieur, même filière.
- Un seul couple en attente à la fois ; tirages et validations en transaction verrouillée (aucun doublon possible).
- Absent : seul l'absent est remplacé, il est marqué non présent, l'autre reste à l'écran.
- Les photos ne sont publiques que pour les couples affichés ; le reste exige la connexion du comité.
- Connexion limitée à 10 essais par 15 minutes ; mots de passe chiffrés (bcrypt).
- Journal de toutes les actions du tirage.
- Rejets, suppressions, changements de phase, pointages et opérations de couple inscrits dans le journal d’audit protégé. Un motif est demandé pour les rejets, suppressions, remplacements et annulations.
- Les propositions sans remplaçant sont suspendues sans perdre le participant présent ; le comité peut réessayer le remplacement depuis l’onglet Tirage.

## Vérifications d’intégration

Le script `backend/test-workflows.js` exerce l’API contre une base de test dédiée. Il refuse toute exécution si `DB_NAME` n’est pas exactement `parrainage_uac_test`. Créez cette base vide, appliquez `database/schema.sql`, créez un administrateur de test avec `npm run seed-admin`, puis lancez le backend sur le port 4001 avec `DB_NAME=parrainage_uac_test`. Dans un autre terminal configuré avec les mêmes variables et `TEST_BASE_URL=http://127.0.0.1:4001`, lancez `npm run test:integration`. Les tests couvrent l’authentification, les inscriptions, les doublons, les motifs, les phases, le pointage, le tirage, le remplacement individuel et la suspension en absence de remplaçant.
