const express = require('express');
const path = require('path');
require('dotenv').config();

const { placesNearby, stopSchedules, disruptions } = require('./navitia');

const app = express();
const PORT = process.env.PORT || 3000;

// Sert le site statique existant (index.html, style.css, app.js) tel quel
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- petit cache mémoire pour éviter de spammer l'API à chaque réglage ----------
const cache = new Map(); // clé -> { data, expiresAt }
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}
function setCached(key, data) {
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function navitiaDateTimeToHHMM(dt) {
  return `${dt.slice(9, 11)}:${dt.slice(11, 13)}`;
}

// Décale un "HH:MM" de N minutes (positif ou négatif). Ne gère pas le
// changement de jour (acceptable ici : une course ne démarre pas à minuit).
function shiftTime(hhmm, deltaMinutes) {
  const [h, m] = hhmm.split(':').map(Number);
  let total = h * 60 + m + deltaMinutes;
  total = Math.max(0, Math.min(23 * 60 + 59, total));
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * GET /api/pn-schedule?lat=..&lon=..&date=YYYY-MM-DD&time=HH:MM
 * Renvoie les trains prévus autour de la gare la plus proche d'un PN,
 * dans un format compatible avec la fonction closestTrain() du front.
 */
app.get('/api/pn-schedule', async (req, res) => {
  const { lat, lon, date, time } = req.query;
  if (!lat || !lon || !date || !time) {
    return res.status(400).json({ error: 'Paramètres requis : lat, lon, date, time' });
  }

  const cacheKey = `${parseFloat(lat).toFixed(4)},${parseFloat(lon).toFixed(4)},${date}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const stations = await placesNearby(parseFloat(lat), parseFloat(lon), 5000);
    if (stations.length === 0) {
      const result = { stationName: null, distance: null, trains: [], note: 'Aucune gare trouvée dans un rayon de 5 km.' };
      setCached(cacheKey, result);
      return res.json(result);
    }

    const nearest = stations[0];
    // On centre la fenêtre de recherche 2h avant l'heure demandée, sur 4h,
    // pour couvrir à la fois les trains juste avant et juste après le passage estimé.
    const windowStart = shiftTime(time, -120);
    const passages = await stopSchedules(nearest.id, date, windowStart, 4 * 3600);

    // Marge d'incertitude affichée à l'utilisateur : plus la gare est loin du PN,
    // plus l'heure réelle de passage au PN peut s'écarter de l'heure en gare.
    // Approximation grossière : ~1 minute d'écart possible par km de distance.
    const marginMin = Math.max(2, Math.round(nearest.distance / 1000));

    const trains = passages.map((p) => ({
      t: navitiaDateTimeToHHMM(p.dateTime),
      type: p.commercialMode || p.lineName,
      margin_min: marginMin,
      realtime: p.realtime,
    }));

    const result = { stationName: nearest.name, distance: nearest.distance, trains };
    setCached(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('[pn-schedule]', err.message);
    res.status(502).json({ error: err.message, trains: [] });
  }
});

/**
 * GET /api/disruptions
 * Vue globale des perturbations en cours (pour un bandeau d'alerte sur le site).
 */
app.get('/api/disruptions', async (req, res) => {
  const cacheKey = 'disruptions-global';
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const raw = await disruptions();
    const simplified = raw
      .filter((d) => d.status === 'active' || d.status === undefined)
      .map((d) => ({
        id: d.id,
        title: d.disruption_id || d.cause || 'Perturbation',
        message: d.messages?.[0]?.text || d.cause || '',
        severity: d.severity?.effect || 'UNKNOWN',
      }));
    setCached(cacheKey, simplified);
    res.json(simplified);
  } catch (err) {
    console.error('[disruptions]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
