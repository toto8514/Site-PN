# Passages à niveau — version avec horaires SNCF temps réel

Ce dossier remplace `data/schedule.json` par un appel en direct à l'API SNCF
(temps réel), via un petit backend Node.js qui garde la clé API cachée côté
serveur (elle ne doit jamais apparaître dans le code JS envoyé au navigateur).

## Ce qui a changé par rapport à ton site actuel

- **Gardé à l'identique** : `public/index.html`, `public/style.css`, toute la
  logique carte / calcul des croisements / import GPX dans `public/app.js`.
- **Modifié dans `app.js`** : uniquement la partie horaires. Au lieu de charger
  `data/schedule.json`, chaque PN interroge maintenant `/api/pn-schedule`
  (nouvelle route backend) pour récupérer les prochains trains réels à la gare
  la plus proche.
- **Nouveau** : `server/index.js` et `server/navitia.js` — le backend qui
  parle à l'API SNCF.

## ⚠️ Important : copie ton dossier `data/`

Ce paquet ne contient **pas** `data/route.json`, `data/pn.json`,
`data/rail.json`, ni `data/line-types.json` (je n'avais que `index.html`,
`style.css` et `app.js`). Il faut copier ton dossier `data/` existant dans
`public/data/` ici, sinon le tracé d'origine et les tables de secours ne se
chargeront pas.

En revanche, tu peux **supprimer `data/schedule.json`** : il n'est plus utilisé.

## Installation locale (Windows)

1. Récupérer un token API SNCF (voir la procédure qu'on a vue ensemble sur
   https://numerique.sncf.com/startup/api/)

2. Copier `.env.example` en `.env` :
   ```
   copy .env.example .env
   ```
   et coller ton token dans `SNCF_API_TOKEN=`.

3. Installer les dépendances :
   ```
   npm install
   ```

4. Copier ton dossier `data/` existant dans `public/data/`

5. Lancer le serveur :
   ```
   npm start
   ```

6. Ouvrir http://localhost:3000 — le site doit se comporter comme avant, mais
   avec les horaires réels au lieu du fichier statique.

## Limite à connaître

Le backend renvoie les horaires de la **gare la plus proche** de chaque PN, pas
une interpolation exacte au mètre près comme le faisait ton ancien
`schedule.json` (calculé à partir du GTFS officiel). La marge d'incertitude
affichée sur le site (`± X min`) reflète la distance entre le PN et cette gare
— plus le PN est loin d'une gare, plus la marge est grande. C'est la
contrepartie de fonctionner pour n'importe quel tracé en France, et pas
seulement pour la zone Jard–Les Herbiers.

## Prochaine étape possible

Si les résultats de l'API SNCF (noms de gares, format des données) ne
correspondent pas exactement à ce qui est attendu dans `server/navitia.js`,
lance le serveur, regarde les erreurs dans le terminal, et partage-les :
je n'ai pas pu tester avec un vrai token, donc de petits ajustements sont
probables une fois en conditions réelles.
