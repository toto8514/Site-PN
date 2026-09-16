/*
 * Client pour l'API SNCF (moteur Navitia).
 * Doc : https://doc.navitia.io
 * Auth : HTTP Basic, le token sert de "username", mot de passe vide.
 */
require('dotenv').config();

const BASE_URL = 'https://api.sncf.com/v1';
const COVERAGE = 'sncf'; // périmètre national SNCF

function authHeader() {
  const token = process.env.SNCF_API_TOKEN;
  if (!token) throw new Error('SNCF_API_TOKEN manquant dans .env');
  const encoded = Buffer.from(`${token}:`).toString('base64');
  return `Basic ${encoded}`;
}

async function navitiaFetch(path) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { headers: { Authorization: authHeader() } });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Navitia répond parfois "404" avec un corps JSON exploitable (ex: date hors bornes)
    // plutôt qu'un vrai "pas trouvé" — on remonte ce message précis s'il existe.
    const apiMessage = data?.error?.message;
    if (apiMessage) {
      const err = new Error(apiMessage);
      err.navitiaErrorId = data.error.id;
      throw err;
    }
    throw new Error(`Navitia ${res.status} sur ${path}`);
  }
  return data;
}

/**
 * Cherche les gares (stop_area) les plus proches d'un point.
 * Renvoie un tableau [{ id, name, lat, lon, distance }], trié par distance croissante.
 */
async function placesNearby(lat, lon, distanceMeters = 3000) {
  const path = `/coverage/${COVERAGE}/coord/${lon};${lat}/places_nearby`
    + `?type[]=stop_area&distance=${distanceMeters}&count=5`;
  const data = await navitiaFetch(path);
  const items = data.places_nearby || [];
  return items
    .filter((p) => p.embedded_type === 'stop_area' && p.stop_area)
    .map((p) => ({
      id: p.stop_area.id,
      name: p.stop_area.name,
      lat: parseFloat(p.stop_area.coord.lat),
      lon: parseFloat(p.stop_area.coord.lon),
      distance: parseInt(p.distance, 10), // mètres, fourni par l'API
    }));
}

/**
 * Récupère les passages (temps réel si dispo) à une gare donnée, autour d'une date/heure.
 * dateISO : "YYYY-MM-DD", timeHHMM : "HH:MM"
 * Renvoie un tableau brut de "stop_date_time" tel que fourni par Navitia.
 */
async function stopSchedules(stopAreaId, dateISO, timeHHMM, durationSeconds = 4 * 3600) {
  const fromDatetime = `${dateISO.replace(/-/g, '')}T${timeHHMM.replace(':', '')}00`;
  const path = `/coverage/${COVERAGE}/stop_areas/${encodeURIComponent(stopAreaId)}/stop_schedules`
    + `?from_datetime=${fromDatetime}&duration=${durationSeconds}&data_freshness=realtime&count=50`;
  const data = await navitiaFetch(path);
  const notes = data.stop_schedules || [];

  const passages = [];
  notes.forEach((line) => {
    (line.date_times || []).forEach((dt) => {
      if (dt.data_freshness === 'base_schedule' && dt.date_time == null) return;
      passages.push({
        dateTime: dt.date_time, // format "YYYYMMDDTHHMMSS"
        realtime: dt.data_freshness === 'realtime',
        lineName: line.route?.line?.name || line.route?.name || '?',
        commercialMode: line.route?.line?.commercial_mode?.name || '',
        direction: line.route?.direction?.name || '',
      });
    });
  });
  return passages;
}

/** Récupère les perturbations en cours pour tout le réseau SNCF (vue globale, mise en cache par l'appelant). */
async function disruptions() {
  const path = `/coverage/${COVERAGE}/disruptions?count=100`;
  const data = await navitiaFetch(path);
  return data.disruptions || [];
}

module.exports = { placesNearby, stopSchedules, disruptions };
